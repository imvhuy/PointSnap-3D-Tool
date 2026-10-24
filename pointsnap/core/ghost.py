"""Ghost Target Guides Engine & Spatial Residuals (Milestone M1, Features F1-F4).

Cung cấp các cấu trúc dữ liệu và thuật toán tổng hợp Khung gióng Mục tiêu (GhostTarget)
cùng bộ đo sai số không gian thời gian thực (SpatialResiduals) phục vụ công cụ căn chỉnh
3D bounding box theo phong cách Lightroom trực tiếp trên CVAT Extension.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import math
from typing import Any, Sequence

import numpy as np

from pointsnap.core.box_points import box_point_sets
from pointsnap.core.geometry import normalize_angle, to_box_frame
from pointsnap.core.ground import ring_ground_for_box
from pointsnap.core.model import Cuboid, Vec3
from pointsnap.detectors.heading import rectangle_angle


@dataclass(frozen=True)
class ClusterBounds:
    """Biên độ không gian của cụm điểm LiDAR quanh box phục vụ tính clearance và quantile extents."""

    min_x: float
    max_x: float
    min_y: float
    max_y: float
    p1_x: float
    p99_x: float
    p1_y: float
    p99_y: float
    num_points: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "min_x": float(self.min_x),
            "max_x": float(self.max_x),
            "min_y": float(self.min_y),
            "max_y": float(self.max_y),
            "p1_x": float(self.p1_x),
            "p99_x": float(self.p99_x),
            "p1_y": float(self.p1_y),
            "p99_y": float(self.p99_y),
            "num_points": int(self.num_points),
        }


@dataclass(frozen=True)
class GhostTarget:
    """Thông số hình học của Khung gióng Mục tiêu chuẩn xác tuyệt đối."""

    center: tuple[float, float, float]
    dims: tuple[float, float, float]
    yaw: float
    roll: float = 0.0
    pitch: float = 0.0
    ground_z: float | None = None
    target_bottom_z: float = 0.0
    confidence: float = 0.95
    reason: str = ""
    cluster_bounds: ClusterBounds | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "center": [float(v) for v in self.center],
            "dims": [float(v) for v in self.dims],
            "yaw": float(self.yaw),
            "roll": float(self.roll),
            "pitch": float(self.pitch),
            "ground_z": float(self.ground_z) if self.ground_z is not None else None,
            "target_bottom_z": float(self.target_bottom_z),
            "confidence": float(self.confidence),
            "reason": self.reason,
            "cluster_bounds": self.cluster_bounds.to_dict() if self.cluster_bounds is not None else None,
        }

    def to_cuboid(
        self,
        label: str = "car",
        frame: int = 0,
        track_id: int | None = None,
        source_id: int | None = None,
        attrs: dict[str, Any] | None = None,
    ) -> Cuboid:
        """Chuyển GhostTarget thành Cuboid chuẩn để phục vụ re-scan hoặc áp dụng sửa."""
        cleaned_attrs = dict(attrs or {})
        # Roll và Pitch luôn được cân bằng triệt tiêu về 0.0
        cleaned_attrs["cvat_rx"] = 0.0
        cleaned_attrs["cvat_ry"] = 0.0
        return Cuboid(
            center=self.center,
            dims=self.dims,
            yaw=self.yaw,
            label=label,
            frame=frame,
            track_id=track_id,
            source_id=source_id,
            attrs=cleaned_attrs,
        )


@dataclass(frozen=True)
class SpatialResiduals:
    """Các sai số không gian thời gian thực giữa box hiện tại và khung mục tiêu."""

    delta_z_cm: float
    delta_yaw_deg: float
    delta_dist_3d_cm: float
    delta_dist_xy_cm: float
    delta_dims_cm: tuple[float, float, float]
    clearance_front_cm: float
    clearance_back_cm: float
    clearance_left_cm: float
    clearance_right_cm: float
    roll_deg: float
    pitch_deg: float
    is_snapped: bool
    is_green_locked: bool
    status_text: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "delta_z_cm": float(self.delta_z_cm),
            "delta_yaw_deg": float(self.delta_yaw_deg),
            "delta_dist_3d_cm": float(self.delta_dist_3d_cm),
            "delta_dist_xy_cm": float(self.delta_dist_xy_cm),
            "delta_dims_cm": [float(v) for v in self.delta_dims_cm],
            "clearance_front_cm": float(self.clearance_front_cm),
            "clearance_back_cm": float(self.clearance_back_cm),
            "clearance_left_cm": float(self.clearance_left_cm),
            "clearance_right_cm": float(self.clearance_right_cm),
            "roll_deg": float(self.roll_deg),
            "pitch_deg": float(self.pitch_deg),
            "is_snapped": bool(self.is_snapped),
            "is_green_locked": bool(self.is_green_locked),
            "status_text": self.status_text,
        }


def _box_fit_target(cuboid: Cuboid, details: dict[str, Any], rule: str = "") -> GhostTarget:
    """Khung tham chiếu của `fit.offset` / `fit.yaw` / `cam.face`: đúng box đề xuất của luật (giữ kích thước), không
    tính lại từ cụm điểm. Không có đề xuất thì giữ nguyên box, mức bằng chứng 0."""
    center, yaw = details.get("proposed_center"), details.get("proposed_yaw")
    try:
        values = [float(v) for v in (*center, yaw)] if isinstance(center, (list, tuple)) and len(center) == 3 else []
    except (TypeError, ValueError):
        values = []
    if len(values) != 4 or not all(math.isfinite(v) for v in values):
        reason = "Chưa đủ bằng chứng để vẽ khung tham chiếu; kiểm tra thủ công"
        return GhostTarget(center=tuple(float(v) for v in cuboid.center), dims=tuple(float(v) for v in cuboid.dims),
                           yaw=float(cuboid.yaw), target_bottom_z=float(cuboid.bottom_z), confidence=0.0, reason=reason)
    target = (values[0], values[1], values[2])
    observed = details.get("observed_axes") or [True, True]
    missing = [name for name, seen in zip(("dọc", "ngang"), observed) if not seen]
    source = "mặt nạ SAM + LiDAR" if details.get("source") == "sam" else "LiDAR"
    reason = (f"Khung tham chiếu: khớp mặt box nhìn thấy vào {details.get('num_points', 0)} điểm của vật ({source}), giữ "
              f"kích thước")
    if missing:
        reason += f"; chưa đủ bằng chứng theo chiều {' / '.join(missing)}"
    if rule == "cam.face":
        reason = "Khung tham chiếu: đảo hướng đầu/đuôi theo phiếu ảnh camera; giữ tâm và kích thước"
    return GhostTarget(center=target, dims=tuple(float(v) for v in cuboid.dims), yaw=normalize_angle(values[3]),
                       target_bottom_z=float(values[2] - cuboid.height / 2.0), confidence=0.85, reason=reason)


def generate_ghost_target(
    cuboid: Cuboid,
    track: list[Cuboid] | None = None,
    points: np.ndarray | None = None,
    rule: str = "",
    details: dict[str, Any] | None = None,
) -> GhostTarget:
    """Sinh khung gióng mục tiêu (Ghost Target Box) chuẩn xác tuyệt đối.

    Cân bằng triệt tiêu roll/pitch về 0.0, hạ/nâng đáy sát mặt đất z_ground,
    căn chỉnh yaw theo cụm LiDAR/vector chuyển động/track median,
    và co/nới kích thước box theo phân vị [p1, p99] của cụm điểm.
    """
    rule = (rule or "").strip()
    finding_details = dict(details or {})
    if rule in ("fit.offset", "fit.yaw", "cam.face"):
        return _box_fit_target(cuboid, finding_details, rule)

    # Lọc các box cùng track và label
    track_boxes = [b for b in (track or [cuboid]) if b.track_id == cuboid.track_id and b.label == cuboid.label]
    peers = [b for b in track_boxes if b.frame != cuboid.frame and b.visible and b.keyframe]

    # Tiền xử lý point cloud
    cleaned_points = None
    if points is not None:
        pts = np.asarray(points, dtype=np.float64)
        if pts.ndim == 2 and pts.shape[1] >= 3:
            mask = np.isfinite(pts[:, :3]).all(axis=1)
            if np.any(mask):
                cleaned_points = pts[mask][:, :3]

    # --- 1. Ground Plane Leveling ---
    est = None
    if cleaned_points is not None and len(cleaned_points) >= 15:
        try:
            est = ring_ground_for_box(cleaned_points, cuboid)
        except Exception:
            est = None

    d = None
    num_ground_pts = 0
    z_ground = None

    if est is not None and est.is_valid:
        num_ground_pts = est.num_ground_points
        d = float(est.contact_distance if est.contact_distance is not None else est.distance)
        z_ground = float(est.ground_z if est.ground_z is not None else (cuboid.bottom_z - d))
    elif "distance" in finding_details:
        d = float(finding_details["distance"])
        num_ground_pts = int(finding_details.get("num_ground_points", 20))
        z_ground = float(cuboid.bottom_z - d)
    elif est is not None and est.num_ground_points > 0:
        num_ground_pts = est.num_ground_points
        z_ground = float(est.ground_z) if est.ground_z is not None else cuboid.bottom_z
        d = cuboid.bottom_z - z_ground

    # Tham chiếu cao độ đáy so với mặt đất trong track
    if "track_median_distance" in finding_details:
        reference = float(finding_details["track_median_distance"])
    else:
        peer_distances: list[float] = []
        if cleaned_points is not None and peers:
            for p in peers:
                try:
                    p_est = ring_ground_for_box(cleaned_points, p)
                    if p_est.is_valid:
                        p_dist = p_est.contact_distance if p_est.contact_distance is not None else p_est.distance
                        peer_distances.append(float(p_dist))
                except Exception:
                    pass
        if len(peer_distances) >= 2:
            reference = float(np.median(peer_distances))
        else:
            reference = 0.0

    if d is not None:
        offset = d - reference
        target_bottom_z = cuboid.bottom_z - offset
    elif z_ground is not None:
        target_bottom_z = z_ground + reference
    else:
        target_bottom_z = cuboid.bottom_z
        z_ground = cuboid.bottom_z

    # --- 2. Yaw Alignment ---
    target_yaw = cuboid.yaw
    if "target_yaw_sensor" in finding_details:
        target_yaw = normalize_angle(float(finding_details["target_yaw_sensor"]))
    elif rule == "heading.flip":
        if "track_heading_deg" in finding_details:
            target_yaw = math.radians(float(finding_details["track_heading_deg"]))
        elif peers:
            sin_mean = float(np.mean([math.sin(b.yaw) for b in peers]))
            cos_mean = float(np.mean([math.cos(b.yaw) for b in peers]))
            target_yaw = math.atan2(sin_mean, cos_mean)
        else:
            target_yaw = normalize_angle(cuboid.yaw + math.pi)
    elif rule == "heading.motion":
        all_keyframes = sorted([b for b in track_boxes if b.visible and b.keyframe], key=lambda b: b.frame)
        idx = next((i for i, b in enumerate(all_keyframes) if b.frame == cuboid.frame), -1)
        motion_yaw = None
        if idx >= 0 and len(all_keyframes) >= 2:
            a = max(0, idx - 1)
            b = min(len(all_keyframes) - 1, idx + 1)
            dx = all_keyframes[b].center[0] - all_keyframes[a].center[0]
            dy = all_keyframes[b].center[1] - all_keyframes[a].center[1]
            if math.hypot(dx, dy) >= 0.5:
                motion_yaw = math.atan2(dy, dx)
        if motion_yaw is not None:
            target_yaw = motion_yaw
    elif rule == "heading.points":
        local_pts = None
        if cleaned_points is not None and len(cleaned_points) >= 10:
            try:
                items = box_point_sets(cleaned_points, [cuboid], margin=0.5, clearance=0.25)
                if items and len(items[0].local) >= 10:
                    local_pts = items[0].local[:, :2]
            except Exception:
                local_pts = None

            if local_pts is None:
                l_all = to_box_frame(cleaned_points, cuboid)[:, :2]
                half = np.asarray(cuboid.dims[:2]) / 2.0
                mask = np.all(np.abs(l_all) <= half + 0.5, axis=1)
                if np.sum(mask) >= 10:
                    local_pts = l_all[mask]

        if local_pts is not None and len(local_pts) >= 10:
            theta_rect = rectangle_angle(local_pts)
            ref_deg = float(finding_details.get("track_median_deg", 0.0))
            target_yaw = normalize_angle(cuboid.yaw + theta_rect + math.radians(ref_deg))
        elif "raw_deg" in finding_details:
            dev = float(finding_details["raw_deg"]) - float(finding_details.get("track_median_deg", 0.0))
            delta_yaw = math.radians(-((dev + 45.0) % 90.0 - 45.0))
            target_yaw = normalize_angle(cuboid.yaw + delta_yaw)
        elif peers:
            sin_mean = float(np.mean([math.sin(b.yaw) for b in peers]))
            cos_mean = float(np.mean([math.cos(b.yaw) for b in peers]))
            target_yaw = math.atan2(sin_mean, cos_mean)

    # --- 3. Centering, Dimensions & ClusterBounds ---
    track_median_dims = None
    if peers:
        track_median_dims = tuple(float(v) for v in np.median([b.dims for b in peers], axis=0))

    if rule == "size.in_track" and track_median_dims is not None:
        target_h = track_median_dims[2]
    else:
        target_h = cuboid.height

    target_center_z = target_bottom_z + target_h / 2.0

    probe_box = cuboid.replace(yaw=target_yaw, center=(cuboid.center[0], cuboid.center[1], target_center_z))

    cluster_bounds = None
    cluster_pts = None
    if cleaned_points is not None and len(cleaned_points) > 0:
        try:
            items = box_point_sets(cleaned_points, [probe_box], margin=1.0, clearance=0.25)
            if items and len(items[0].local) >= 5:
                cluster_pts = items[0].local
        except Exception:
            cluster_pts = None

        if cluster_pts is None:
            l_all = to_box_frame(cleaned_points, probe_box)
            half = np.asarray(probe_box.dims) / 2.0
            mask = (
                np.all(np.abs(l_all[:, :2]) <= half[:2] + 1.0, axis=1)
                & (l_all[:, 2] >= -half[2] - 0.2)
                & (l_all[:, 2] <= half[2] + 1.0)
            )
            if np.sum(mask) >= 5:
                cluster_pts = l_all[mask]

    dx_local = 0.0
    dy_local = 0.0
    target_l = cuboid.length
    target_w = cuboid.width
    confidence = 0.95

    if cluster_pts is not None and len(cluster_pts) >= 5:
        p1_x = float(np.percentile(cluster_pts[:, 0], 1.0))
        p99_x = float(np.percentile(cluster_pts[:, 0], 99.0))
        p1_y = float(np.percentile(cluster_pts[:, 1], 1.0))
        p99_y = float(np.percentile(cluster_pts[:, 1], 99.0))
        min_x = float(np.min(cluster_pts[:, 0]))
        max_x = float(np.max(cluster_pts[:, 0]))
        min_y = float(np.min(cluster_pts[:, 1]))
        max_y = float(np.max(cluster_pts[:, 1]))
        num_pts = int(len(cluster_pts))

        cluster_bounds = ClusterBounds(
            min_x=min_x,
            max_x=max_x,
            min_y=min_y,
            max_y=max_y,
            p1_x=p1_x,
            p99_x=p99_x,
            p1_y=p1_y,
            p99_y=p99_y,
            num_points=num_pts,
        )

        span_x = p99_x - p1_x
        span_y = p99_y - p1_y

        if rule == "fit.outside":
            dx_local = (p1_x + p99_x) / 2.0
            dy_local = (p1_y + p99_y) / 2.0
            if track_median_dims is not None:
                med_l, med_w, _ = track_median_dims
                pad = 0.04
                target_l = (span_x + pad) if span_x > med_l + 0.10 else med_l
                target_w = (span_y + pad) if span_y > med_w + 0.10 else med_w
            else:
                pad = 0.10
                target_l = max(cuboid.length, span_x + pad)
                target_w = max(cuboid.width, span_y + pad)
            confidence = 0.92

        elif rule == "fit.loose":
            faces = {"đầu": (0, 1), "đuôi": (0, -1), "bên trái": (1, 1), "bên phải": (1, -1), "đầu và đuôi": (0, 0)}
            face_key = finding_details.get("face")
            if face_key and face_key in faces:
                axis, side = faces[face_key]
                half_axis = cuboid.dims[axis] / 2.0
                low, high = (-half_axis, half_axis)
                b_range = [(p1_x, p99_x), (p1_y, p99_y)][axis]
                if side <= 0:
                    low = max(low, b_range[0] - 0.05)
                if side >= 0:
                    high = min(high, b_range[1] + 0.05)
                shift = (high + low) / 2.0
                if axis == 0:
                    target_l = max(0.1, high - low)
                    dx_local = shift
                else:
                    target_w = max(0.1, high - low)
                    dy_local = shift
            confidence = 0.88

        elif rule == "size.in_track" and track_median_dims is not None:
            target_l, target_w = track_median_dims[0], track_median_dims[1]
            confidence = 0.98

        confidence = max(0.80, min(0.98, max(num_pts, num_ground_pts) / 30.0))

    else:
        # Trường hợp point cloud thưa hoặc mất dấu (< 5 điểm)
        if track_median_dims is not None:
            if rule in ("fit.outside", "fit.loose", "size.in_track"):
                target_l, target_w, target_h = track_median_dims
                target_center_z = target_bottom_z + target_h / 2.0
            confidence = 0.70
        else:
            confidence = 0.70 if cleaned_points is None else 0.80

    # Chiếu tâm dời từ hệ local sang hệ cảm biến theo target_yaw
    c = math.cos(target_yaw)
    s = math.sin(target_yaw)
    dx_sensor = c * dx_local - s * dy_local
    dy_sensor = s * dx_local + c * dy_local

    target_center_x = cuboid.center[0] + dx_sensor
    target_center_y = cuboid.center[1] + dy_sensor

    # --- 4. Composing Reason Summary ---
    reasons: list[str] = []
    if abs(target_bottom_z - cuboid.bottom_z) > 0.005:
        dz_cm = (target_bottom_z - cuboid.bottom_z) * 100.0
        reasons.append(f"cân bằng sàn z={target_bottom_z:.2f}m (Δz: {dz_cm:+.1f}cm)")
    if abs(normalize_angle(target_yaw - cuboid.yaw)) > 0.005:
        dyaw_deg = math.degrees(normalize_angle(target_yaw - cuboid.yaw))
        reasons.append(f"xoay yaw {math.degrees(target_yaw):.1f}° (Δyaw: {dyaw_deg:+.1f}°)")
    if math.hypot(dx_sensor, dy_sensor) > 0.005:
        reasons.append(f"dời tâm ({dx_sensor:+.2f}, {dy_sensor:+.2f})m")
    if (
        abs(target_l - cuboid.length) > 0.005
        or abs(target_w - cuboid.width) > 0.005
        or abs(target_h - cuboid.height) > 0.005
    ):
        reasons.append(f"kích thước {target_l:.2f}x{target_w:.2f}x{target_h:.2f}m")
    reasons.append("triệt tiêu roll/pitch về 0°")

    reason_str = "Khung mục tiêu: " + ", ".join(reasons)

    return GhostTarget(
        center=(float(target_center_x), float(target_center_y), float(target_center_z)),
        dims=(float(target_l), float(target_w), float(target_h)),
        yaw=float(target_yaw),
        roll=0.0,
        pitch=0.0,
        ground_z=float(z_ground) if z_ground is not None else None,
        target_bottom_z=float(target_bottom_z),
        confidence=float(confidence),
        reason=reason_str,
        cluster_bounds=cluster_bounds,
    )


def compute_spatial_residuals(
    current_cuboid: Cuboid,
    ghost_target: GhostTarget,
    points: np.ndarray | None = None,
) -> SpatialResiduals:
    """Đo đạc và phát tín hiệu chênh lệch không gian (Spatial Residuals) thời gian thực.

    Tính toán:
    - delta_z_cm: chênh lệch cao độ đáy ((c_z - c_h/2) - (t_z - t_h/2)) * 100
    - delta_yaw_deg: chênh lệch góc xoay chuẩn hóa quanh trục z
    - delta_dist_3d_cm, delta_dist_xy_cm: khoảng cách Euclidean
    - roll_deg, pitch_deg: góc nghiêng hiện tại của box
    - clearance_front/back/left/right: độ hở 4 mặt thân box so với cụm điểm
    - is_snapped: khoảng cách <= 8 cm hoặc góc <= 4 độ
    - is_green_locked: khoảng cách <= 2 cm và góc <= 2 độ và roll <= 0.5 độ và pitch <= 0.5 độ
    """
    c_z = current_cuboid.center[2]
    c_h = current_cuboid.height
    t_z = ghost_target.center[2]
    t_h = ghost_target.dims[2]

    # Độ lệch cao độ đáy box (cm)
    delta_z_cm = float(((c_z - c_h / 2.0) - (t_z - t_h / 2.0)) * 100.0)

    # Độ lệch góc xoay (deg)
    delta_yaw_deg = float(math.degrees(normalize_angle(current_cuboid.yaw - ghost_target.yaw)))

    # Khoảng cách tâm 3D và 2D (cm)
    delta_dist_3d_cm = float(math.dist(current_cuboid.center, ghost_target.center) * 100.0)
    delta_dist_xy_cm = float(
        math.hypot(
            current_cuboid.center[0] - ghost_target.center[0],
            current_cuboid.center[1] - ghost_target.center[1],
        )
        * 100.0
    )

    # Độ lệch kích thước (cm)
    delta_dims_cm = (
        float((current_cuboid.length - ghost_target.dims[0]) * 100.0),
        float((current_cuboid.width - ghost_target.dims[1]) * 100.0),
        float((current_cuboid.height - ghost_target.dims[2]) * 100.0),
    )

    # Góc nghiêng roll / pitch
    current_roll = float(
        getattr(current_cuboid, "roll", 0.0)
        or (current_cuboid.attrs.get("cvat_rx", 0.0) if hasattr(current_cuboid, "attrs") and current_cuboid.attrs else 0.0)
    )
    current_pitch = float(
        getattr(current_cuboid, "pitch", 0.0)
        or (current_cuboid.attrs.get("cvat_ry", 0.0) if hasattr(current_cuboid, "attrs") and current_cuboid.attrs else 0.0)
    )
    roll_deg = float(math.degrees(abs(current_roll)))
    pitch_deg = float(math.degrees(abs(current_pitch)))

    # Khoảng hở 4 mặt thân box (front, back, left, right)
    clearance_front_cm = 0.0
    clearance_back_cm = 0.0
    clearance_left_cm = 0.0
    clearance_right_cm = 0.0

    if points is not None:
        pts = np.asarray(points, dtype=np.float64)
        if pts.ndim == 2 and pts.shape[1] >= 3:
            mask = np.isfinite(pts[:, :3]).all(axis=1)
            valid_pts = pts[mask][:, :3]
            if len(valid_pts) > 0:
                l_pts = to_box_frame(valid_pts, current_cuboid)
                half_l = current_cuboid.length / 2.0
                half_w = current_cuboid.width / 2.0
                half_h = current_cuboid.height / 2.0

                inside_mask = (
                    (np.abs(l_pts[:, 0]) <= half_l + 0.3)
                    & (np.abs(l_pts[:, 1]) <= half_w + 0.3)
                    & (np.abs(l_pts[:, 2]) <= half_h + 0.3)
                )
                box_pts = l_pts[inside_mask]
                if len(box_pts) > 0:
                    clearance_front_cm = float((half_l - float(np.max(box_pts[:, 0]))) * 100.0)
                    clearance_back_cm = float((half_l + float(np.min(box_pts[:, 0]))) * 100.0)
                    clearance_left_cm = float((half_w - float(np.max(box_pts[:, 1]))) * 100.0)
                    clearance_right_cm = float((half_w + float(np.min(box_pts[:, 1]))) * 100.0)

    # Điều kiện bắt dính và khóa xanh
    is_snapped = bool(delta_dist_3d_cm <= 8.0 or abs(delta_yaw_deg) <= 4.0)
    is_green_locked = bool(
        delta_dist_3d_cm <= 2.0
        and abs(delta_yaw_deg) <= 2.0
        and roll_deg <= 0.5
        and pitch_deg <= 0.5
    )
    status_text = "GREEN_LOCK" if is_green_locked else ("SNAPPED" if is_snapped else "OFF_TARGET")

    return SpatialResiduals(
        delta_z_cm=delta_z_cm,
        delta_yaw_deg=delta_yaw_deg,
        delta_dist_3d_cm=delta_dist_3d_cm,
        delta_dist_xy_cm=delta_dist_xy_cm,
        delta_dims_cm=delta_dims_cm,
        clearance_front_cm=clearance_front_cm,
        clearance_back_cm=clearance_back_cm,
        clearance_left_cm=clearance_left_cm,
        clearance_right_cm=clearance_right_cm,
        roll_deg=roll_deg,
        pitch_deg=pitch_deg,
        is_snapped=is_snapped,
        is_green_locked=is_green_locked,
        status_text=status_text,
    )
