"""Chiếu box 3D lên ảnh camera (việc C3, lớp 2 của Box Verifier).

Box nằm trong hệ point cloud của frame; đổi sang hệ toàn cục bằng `sensor_to_world` của frame, rồi sang hệ camera bằng
pose của camera tại thời điểm chụp ảnh (camera và LiDAR chụp lệch nhau vài chục ms, xe thu đang chạy nên phải dùng pose
riêng của camera). Hệ camera: x sang phải, y xuống dưới, z hướng tới trước (quy ước của nuScenes).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pointsnap.core.geometry import corners, invert_pose, validate_pose
from pointsnap.core.model import Cuboid

MIN_DEPTH_M = 0.5
"""Góc box gần hơn mức này (hoặc sau camera) thì không chiếu được."""


@dataclass(frozen=True, eq=False)
class CameraView:
    """Một ảnh camera chụp cùng keyframe: kênh, đường dẫn, ma trận nội `intrinsic` (3x3), pose camera → toàn cục."""

    channel: str
    path: Path
    intrinsic: np.ndarray
    camera_to_world: np.ndarray
    width: int
    height: int

    def __post_init__(self):
        intrinsic = np.asarray(self.intrinsic, dtype=np.float64)
        if (intrinsic.shape != (3, 3) or not np.isfinite(intrinsic).all()
                or intrinsic[0, 0] <= 0 or intrinsic[1, 1] <= 0
                or not np.allclose(intrinsic[2], [0, 0, 1])
                or type(self.width) is not int or type(self.height) is not int
                or min(self.width, self.height) <= 0):
            raise ValueError("Camera intrinsic and image dimensions must be finite and valid")
        object.__setattr__(self, "intrinsic", intrinsic)
        object.__setattr__(self, "camera_to_world", validate_pose(self.camera_to_world))
        object.__setattr__(self, "path", Path(self.path))


@dataclass(frozen=True)
class Projection:
    """Box chiếu lên ảnh: khung 2D bao các góc (đã cắt theo ảnh), tỉ lệ diện tích nằm trong ảnh, độ sâu tâm box."""

    box: tuple[float, float, float, float]  # x1, y1, x2, y2 (pixel)
    inside_ratio: float
    depth: float
    polygon: np.ndarray  # (8, 2) 8 góc trên ảnh


def project_points(points_world: np.ndarray, view: CameraView) -> tuple[np.ndarray, np.ndarray]:
    """Điểm (N, 3) hệ toàn cục → (pixel (N, 2), độ sâu (N,))."""
    world_to_cam = invert_pose(view.camera_to_world)
    cam = points_world @ world_to_cam[:3, :3].T + world_to_cam[:3, 3]
    depth = cam[:, 2]
    uvw = cam @ view.intrinsic.T
    with np.errstate(divide="ignore", invalid="ignore"):
        pixels = uvw[:, :2] / uvw[:, 2:3]
    return pixels, depth


def project_box(box: Cuboid, sensor_to_world: np.ndarray, view: CameraView) -> Projection | None:
    """Chiếu box lên ảnh; `None` nếu có góc nằm sau / quá sát camera hoặc box nằm ngoài ảnh."""
    pts = corners(box)
    sensor_to_world = validate_pose(sensor_to_world)
    world = pts @ np.asarray(sensor_to_world)[:3, :3].T + np.asarray(sensor_to_world)[:3, 3]
    pixels, depth = project_points(world, view)
    if np.any(depth < MIN_DEPTH_M):
        return None
    x1, y1 = pixels.min(axis=0)
    x2, y2 = pixels.max(axis=0)
    full = max((x2 - x1) * (y2 - y1), 1e-6)
    cx1, cy1, cx2, cy2 = max(x1, 0.0), max(y1, 0.0), min(x2, view.width), min(y2, view.height)
    if cx2 <= cx1 or cy2 <= cy1:
        return None
    inside = (cx2 - cx1) * (cy2 - cy1) / full
    center = (np.asarray(sensor_to_world)[:3, :3] @ np.asarray(box.center) + np.asarray(sensor_to_world)[:3, 3])
    _, center_depth = project_points(center[None], view)
    return Projection((float(cx1), float(cy1), float(cx2), float(cy2)), float(inside), float(center_depth[0]), pixels)


def iou_2d(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def covered_fraction(target: tuple[float, ...], others: list[tuple[float, ...]]) -> float:
    """Exact union area of axis-aligned rectangles clipped to target."""
    area = max(0.0, target[2]-target[0]) * max(0.0, target[3]-target[1])
    if not others or area == 0:
        return 0.0
    rectangles = []
    for o in others:
        clipped = (max(target[0],o[0]),max(target[1],o[1]),min(target[2],o[2]),min(target[3],o[3]))
        if clipped[2] > clipped[0] and clipped[3] > clipped[1]:
            rectangles.append(clipped)
    xs = sorted({x for r in rectangles for x in (r[0],r[2])})
    covered = 0.0
    for left, right in zip(xs, xs[1:]):
        intervals = sorted((r[1],r[3]) for r in rectangles if r[0] < right and r[2] > left)
        end, length = target[1], 0.0
        for bottom, top in intervals:
            length += max(0.0,top-max(bottom,end))
            end = max(end,top)
        covered += (right-left)*length
    return min(1.0, covered/area)
