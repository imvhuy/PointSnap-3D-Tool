"""Hình học cho cuboid 3D.

Đơn vị mét và radian, hệ tay phải, z hướng lên (xem CONVENTIONS.md).
Box chỉ có yaw: roll và pitch được coi bằng 0.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Sequence

import numpy as np

if TYPE_CHECKING:
    from pointsnap.core.model import Cuboid


def normalize_angle(angle: float) -> float:
    """Đưa góc về khoảng [-π, π)."""
    return (angle + math.pi) % (2.0 * math.pi) - math.pi


def wrap90(degrees):
    """Scalar/array angle of a rectangular axis in [-45, 45) degrees."""
    return (degrees + 45.0) % 90.0 - 45.0


def median_axis_degrees(angles: Sequence[float]) -> float:
    """Unwrap around the observation with least total wrapped distance, then take the median."""
    values = np.asarray(angles, dtype=np.float64)
    anchor = min(values, key=lambda a: (float(np.abs(wrap90(values - a)).sum()), a))
    return float(wrap90(anchor + np.median(wrap90(values - anchor))))


def to_box_frame(points: np.ndarray, cuboid: Cuboid) -> np.ndarray:
    """Đổi điểm (N, 3) sang hệ local của box: gốc ở tâm box, trục x theo hướng đầu box."""
    pts = np.asarray(points, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] < 3:
        raise ValueError(f"points phải có shape (N, >=3), nhận {pts.shape}")
    rel = pts[:, :3] - np.asarray(cuboid.center)
    c, s = math.cos(cuboid.yaw), math.sin(cuboid.yaw)
    return np.column_stack((c * rel[:, 0] + s * rel[:, 1], -s * rel[:, 0] + c * rel[:, 1], rel[:, 2]))


def _from_box_frame(local: np.ndarray, cuboid: Cuboid) -> np.ndarray:
    c, s = math.cos(cuboid.yaw), math.sin(cuboid.yaw)
    x = c * local[:, 0] - s * local[:, 1]
    y = s * local[:, 0] + c * local[:, 1]
    return np.column_stack((x, y, local[:, 2])) + np.asarray(cuboid.center)


def corners(cuboid: Cuboid) -> np.ndarray:
    """8 góc của box, shape (8, 3).

    Thứ tự: 4 góc đáy rồi 4 góc nóc, mỗi mặt đi ngược chiều kim đồng hồ nhìn từ trên xuống,
    bắt đầu từ góc trước-trái: (+l, +w), (-l, +w), (-l, -w), (+l, -w).
    """
    hl, hw, hh = (d / 2.0 for d in cuboid.dims)
    xy = [(hl, hw), (-hl, hw), (-hl, -hw), (hl, -hw)]
    local = np.array([(x, y, -hh) for x, y in xy] + [(x, y, hh) for x, y in xy])
    return _from_box_frame(local, cuboid)


def footprint(cuboid: Cuboid, margin: float = 0.0) -> np.ndarray:
    """4 góc đáy nhìn từ trên xuống (BEV), shape (4, 2), ngược chiều kim đồng hồ.

    `margin` nới rộng footprint ra mỗi phía (mét).
    """
    hl, hw = cuboid.dims[0] / 2.0 + margin, cuboid.dims[1] / 2.0 + margin
    local = np.array([(hl, hw, 0.0), (-hl, hw, 0.0), (-hl, -hw, 0.0), (hl, -hw, 0.0)])
    return _from_box_frame(local, cuboid)[:, :2]


def points_in_cuboid(points: np.ndarray, cuboid: Cuboid, margin: float = 0.0) -> np.ndarray:
    """Mask điểm trong box, kể cả biên; dung sai số học 1e-9 m, ngoài margin do caller chọn."""
    local = to_box_frame(points, cuboid)
    half = np.asarray(cuboid.dims) / 2.0 + margin
    return np.all(np.abs(local) <= half + 1e-9, axis=1)


def footprint_ring_mask(points: np.ndarray, cuboid: Cuboid, inner: float, outer: float) -> np.ndarray:
    """Mask bool cho các điểm thuộc vành đai quanh footprint, chỉ xét x, y.

    Vành đai là vùng nằm trong footprint nới `outer` mét nhưng ngoài footprint nới `inner` mét.
    """
    if not 0.0 <= inner < outer:
        raise ValueError(f"Cần 0 <= inner < outer, nhận inner={inner}, outer={outer}")
    local = np.abs(to_box_frame(points, cuboid)[:, :2])
    half = np.asarray(cuboid.dims[:2]) / 2.0
    in_outer = np.all(local <= half + outer, axis=1)
    in_inner = np.all(local <= half + inner, axis=1)
    return in_outer & ~in_inner


def quaternion_to_matrix(quaternion: Sequence[float]) -> np.ndarray:
    """Quaternion [w, x, y, z] (thứ tự của nuScenes) → ma trận quay 3x3. Tự chuẩn hóa độ dài."""
    w, x, y, z = (float(v) for v in quaternion)
    if not all(math.isfinite(v) for v in (w, x, y, z)):
        raise ValueError("Quaternion phải gồm 4 số hữu hạn")
    scale = max(abs(v) for v in (w, x, y, z))
    if scale == 0.0:
        raise ValueError("Quaternion có độ dài 0")
    w, x, y, z = (v / scale for v in (w, x, y, z))
    norm = math.hypot(w, x, y, z)
    w, x, y, z = w / norm, x / norm, y / norm, z / norm
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def pose_matrix(translation: Sequence[float], rotation: Sequence[float]) -> np.ndarray:
    """Ma trận đồng nhất 4x4 từ vị trí (x, y, z) và quaternion [w, x, y, z]."""
    matrix = np.eye(4)
    matrix[:3, :3] = quaternion_to_matrix(rotation)
    position = np.asarray(translation, dtype=np.float64)
    if position.shape != (3,) or not np.isfinite(position).all():
        raise ValueError("Vị trí pose phải gồm 3 số hữu hạn")
    matrix[:3, 3] = position
    return matrix


def validate_pose(matrix: np.ndarray) -> np.ndarray:
    """Pose phải là phép quay tay phải + tịnh tiến hữu hạn, không chứa scale/shear."""
    m = np.asarray(matrix, dtype=np.float64)
    if m.shape != (4, 4) or not np.isfinite(m).all():
        raise ValueError("Pose phải có shape (4, 4) và các số hữu hạn")
    rotation = m[:3, :3]
    if (not np.allclose(m[3], [0, 0, 0, 1], rtol=0, atol=1e-6)
            or not np.allclose(rotation.T @ rotation, np.eye(3), rtol=0, atol=1e-6)
            or not math.isclose(float(np.linalg.det(rotation)), 1.0, abs_tol=1e-6)):
        raise ValueError("Pose phải là ma trận quay + tịnh tiến tay phải, không có scale/shear")
    return m


def invert_pose(matrix: np.ndarray) -> np.ndarray:
    """Nghịch đảo ma trận pose 4x4 (quay + dịch), không dùng nghịch đảo tổng quát."""
    matrix = validate_pose(matrix)
    rot_t = matrix[:3, :3].T
    inverse = np.eye(4)
    inverse[:3, :3] = rot_t
    inverse[:3, 3] = -rot_t @ matrix[:3, 3]
    return inverse


def transform_points(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """Áp ma trận đồng nhất 4x4 lên điểm (N, 3)."""
    pts = np.asarray(points, dtype=np.float64)[:, :3]
    m = validate_pose(matrix)
    return pts @ m[:3, :3].T + m[:3, 3]


def polygon_area(polygon: np.ndarray) -> float:
    """Diện tích đa giác 2D (công thức shoelace), không phụ thuộc chiều đi.

    Dời đa giác về gần gốc tọa độ trước khi tính để không mất độ chính xác khi tọa độ lớn
    (ví dụ hệ toàn cục, hàng nghìn mét).
    """
    if len(polygon) < 3:
        return 0.0
    rel = polygon - polygon[0]
    x, y = rel[:, 0], rel[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _cross(o: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    return float((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]))


def _clip_convex(subject: np.ndarray, clip: np.ndarray) -> np.ndarray:
    """Cắt đa giác `subject` bằng đa giác `clip`, thuật toán Sutherland–Hodgman.

    Điều kiện: `clip` phải lồi và đi ngược chiều kim đồng hồ. Trong tool chỉ dùng cho footprint
    hình chữ nhật, nên luôn thỏa.
    """
    output = [p for p in subject]
    for i in range(len(clip)):
        a, b = clip[i], clip[(i + 1) % len(clip)]
        candidates, output = output, []
        if not candidates:
            break
        prev = candidates[-1]
        side_prev = _cross(a, b, prev)
        for cur in candidates:
            side_cur = _cross(a, b, cur)
            if (side_cur >= 0.0) != (side_prev >= 0.0):
                # Hai đầu nằm hai phía của cạnh nên side_prev − side_cur luôn khác 0.
                t = side_prev / (side_prev - side_cur)
                output.append(prev + t * (cur - prev))
            if side_cur >= 0.0:
                output.append(cur)
            prev, side_prev = cur, side_cur
    return np.array(output).reshape(-1, 2)


def bev_iou(a: Cuboid, b: Cuboid) -> float:
    """IoU của hai box nhìn từ trên xuống (BEV)."""
    # Tính quanh tâm box `a` để phép cắt không mất độ chính xác khi tọa độ lớn.
    origin = np.asarray(a.center[:2])
    fa, fb = footprint(a) - origin, footprint(b) - origin
    inter = polygon_area(_clip_convex(fa, fb))
    union = polygon_area(fa) + polygon_area(fb) - inter
    return inter / union if union > 0.0 else 0.0


LIDAR_TO_EGO_ROT = np.array([
    [0.0, 1.0, 0.0],
    [-1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0],
], dtype=np.float64)
"""Ma trận quay từ hệ cảm biến nuScenes LIDAR_TOP (x phải, y trước, z lên) sang hệ xe thu (x trước, y trái, z lên, QĐ-008)."""


def rotate_points_z90(points: np.ndarray) -> np.ndarray:
    """Đổi điểm (N, ≥3) từ hệ LiDAR (y trước, x phải) sang hệ xe thu (x trước, y trái, z lên).

    x_new = y_old, y_new = -x_old, z_new = z_old. Cột từ thứ 4 trở đi (intensity...) giữ nguyên.
    """
    pts = np.asarray(points)
    if pts.ndim != 2 or pts.shape[1] < 3:
        raise ValueError(f"points phải có shape (N, ≥3), nhận {pts.shape}")
    out = pts.copy()
    out[:, 0] = pts[:, 1]
    out[:, 1] = -pts[:, 0]
    out[:, 2] = pts[:, 2]
    return out


def rotate_cuboid_to_ego(cuboid: Cuboid) -> Cuboid:
    """Đổi Cuboid từ hệ LiDAR sang hệ xe thu: quay 90° quanh trục z.

    Tâm (cx, cy, cz) -> (cy, -cx, cz).
    Yaw -> normalize_angle(yaw - pi / 2).
    Kích thước (l, w, h) giữ nguyên vì l vẫn theo hướng xe (+x mới) và w theo bề ngang (+y mới).
    """
    cx, cy, cz = cuboid.center
    new_center = (cy, -cx, cz)
    new_yaw = normalize_angle(cuboid.yaw - math.pi / 2.0)
    return cuboid.replace(center=new_center, yaw=new_yaw)


def rotate_pose_to_ego(sensor_to_world: np.ndarray) -> np.ndarray:
    """Đổi ma trận sensor_to_world (4x4) sang ego_to_world khi hệ local của sensor được quay sang hệ xe thu."""
    rot4 = np.eye(4, dtype=np.float64)
    rot4[:3, :3] = LIDAR_TO_EGO_ROT
    return validate_pose(sensor_to_world) @ rot4.T


def hermite_spline_interpolate(
    p0: np.ndarray,
    p1: np.ndarray,
    yaw0: float,
    yaw1: float,
    s: float,
) -> np.ndarray:
    """Nội suy vị trí giữa p0 và p1 tại tham số s ∈ [0, 1] dùng Cubic Hermite Spline theo góc yaw.

    Phục vụ khử False Alarm khi xe rẽ cua/ngã tư trong bài toán phát hiện đứt track.
    """
    p0 = np.asarray(p0, dtype=np.float64)
    p1 = np.asarray(p1, dtype=np.float64)
    chord = p1 - p0
    dist = float(np.linalg.norm(chord[:2]))
    if dist < 1e-4:
        return p0.copy()

    u0 = np.array([math.cos(yaw0), math.sin(yaw0)], dtype=np.float64)
    u1 = np.array([math.cos(yaw1), math.sin(yaw1)], dtype=np.float64)

    # Đảm bảo tiếp tuyến hướng về phía điểm kết thúc p1 theo chiều chuyển động
    if float(np.dot(u0, chord[:2])) < 0.0:
        u0 = -u0
    if float(np.dot(u1, chord[:2])) < 0.0:
        u1 = -u1

    m0 = u0 * dist
    m1 = u1 * dist

    s2 = s * s
    s3 = s2 * s
    h00 = 2.0 * s3 - 3.0 * s2 + 1.0
    h10 = s3 - 2.0 * s2 + s
    h01 = -2.0 * s3 + 3.0 * s2
    h11 = s3 - s2

    interp_xy = h00 * p0[:2] + h10 * m0 + h01 * p1[:2] + h11 * m1
    if len(p0) > 2:
        interp_z = (1.0 - s) * p0[2] + s * p1[2]
        return np.append(interp_xy, interp_z)
    return interp_xy


