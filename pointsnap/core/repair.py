"""Assisted 3D Box Repair Geometry Engine (Milestone M2, Features F4, F5, F6, F7).

Cung cấp các thuật toán hình học tính toán tham số hiệu chỉnh delta (Δz, Δyaw, Δdims, Δc_xy)
nhằm khắc phục các lỗi scanner (floating, heading.flip, heading.points, fit.outside, size.in_track...)
và kiểm chứng rằng box sau sửa vượt qua chất lượng quét của scanner.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

from pointsnap.core.box_points import BoxPointSet, box_point_sets
from pointsnap.core.config import Config, FloatingConfig, load_config
from pointsnap.core.geometry import normalize_angle, to_box_frame
from pointsnap.core.ground import ring_ground_for_box
from pointsnap.core.model import Cuboid, FrameData, FrameSource, Severity
from pointsnap.core.scanner import scan_cuboids
from pointsnap.detectors.heading import rectangle_angle
from pointsnap.detectors.size import DEFAULT_CLASS_RANGES


@dataclass(frozen=True)
class BoxRepairDelta:
    """Tham số hình học đề xuất để sửa một 3D bounding box bị lỗi scanner."""

    delta_center: tuple[float, float, float]  # (dx, dy, dz)
    delta_dims: tuple[float, float, float]    # (dl, dw, dh)
    delta_yaw: float                         # radians
    repaired_cuboid: Cuboid
    rule: str
    target_offset_m: float
    confidence: float
    reason: str

    def to_dict(self) -> dict[str, Any]:
        """Chuyển thành từ điển JSON phục vụ REST API và Web UI."""
        cuboid_data = {
            "center": [float(v) for v in self.repaired_cuboid.center],
            "dims": [float(v) for v in self.repaired_cuboid.dims],
            "yaw": float(self.repaired_cuboid.yaw),
            "label": self.repaired_cuboid.label,
            "frame": self.repaired_cuboid.frame,
            "track_id": self.repaired_cuboid.track_id,
            "source_id": self.repaired_cuboid.source_id,
        }
        return {
            "delta_center": [float(v) for v in self.delta_center],
            "delta_dims": [float(v) for v in self.delta_dims],
            "delta_yaw": float(self.delta_yaw),
            "repaired_cuboid": cuboid_data,
            "repaired_box": cuboid_data,
            "rule": self.rule,
            "target_offset_m": float(self.target_offset_m),
            "confidence": float(self.confidence),
            "reason": self.reason,
        }


class SimpleFrameSource:
    """Nguồn point cloud đơn giản từ dictionary {frame: points} phục vụ re-scan."""

    def __init__(self, points_by_frame: dict[int, np.ndarray]):
        self.points_by_frame = points_by_frame

    def frame_data(self, frame: int, with_points: bool = True) -> FrameData:
        pts = self.points_by_frame.get(frame)
        if pts is None or not with_points:
            pts = np.zeros((0, 3), dtype=np.float64)
        return FrameData(frame=frame, points=pts, sensor_to_world=np.eye(4))


def _repair_ground(
    cuboid: Cuboid,
    track: list[Cuboid] | None,
    points: np.ndarray | None,
    finding_details: dict[str, Any] | None = None,
) -> BoxRepairDelta:
    """Tính toán delta cao độ Z (Δz = -offset) để triệt tiêu lỗi lơ lửng / lún đất."""
    details = finding_details or {}

    # The finding already includes box exclusions, configured rings and sweeps. A fresh measurement of just
    # this frame is only a fallback. Track medians always use distance, never contact_distance.
    has_reference = "track_median_distance" in details
    recorded = details.get("distance") if has_reference else details.get("contact_distance")
    if recorded is None:
        recorded = details.get("distance")
    d = float(recorded) if recorded is not None else None
    num_pts = int(details.get("num_ground_points", 20)) if d is not None else 0
    est = None
    if d is None and points is not None and len(points) >= 15:
        try:
            est = ring_ground_for_box(points, cuboid)
        except Exception:
            est = None

    if est is not None and est.is_valid:
        num_pts = est.num_ground_points
        d = float(est.distance if has_reference or est.contact_distance is None else est.contact_distance)
    elif est is not None and est.num_ground_points > 0:
        num_pts = est.num_ground_points

    if d is None:
        return BoxRepairDelta(
            delta_center=(0.0, 0.0, 0.0),
            delta_dims=(0.0, 0.0, 0.0),
            delta_yaw=0.0,
            repaired_cuboid=cuboid,
            rule="floating",
            target_offset_m=0.0,
            confidence=0.0,
            reason="Không đủ điểm ground để xác định cao độ mặt đất",
        )

    # Without a recorded reference, target the local ground. Points from this frame cannot measure other frames.
    reference = float(details["track_median_distance"]) if has_reference else 0.0
    absolute = details.get("contact_distance") if details.get("terrain_reference") else d
    absolute = d if absolute is None else float(absolute)
    tolerance = float(details.get("ground_tolerance_m", FloatingConfig.ground_tolerance_m))
    if has_reference and (details.get("box_touches_ground") or
                          abs(absolute) <= tolerance < abs(reference)):
        return BoxRepairDelta((0., 0., 0.), (0., 0., 0.), 0., cuboid, "floating", 0., 0.,
                              "Box này chạm đất; kiểm tra các frame khác của track trước khi sửa cao độ")

    offset = d - reference
    delta_z = -offset

    new_center = (cuboid.center[0], cuboid.center[1], cuboid.center[2] + delta_z)
    repaired = cuboid.replace(center=new_center)
    confidence = min(1.0, max(0.80, num_pts / 30.0))
    direction = "hạ" if delta_z < 0 else "nâng"
    contact = details.get("contact_distance")
    if contact is None:
        contact = est.contact_distance if est is not None and est.contact_distance is not None else d
    target = "sát mặt đất" if abs(float(contact) - offset) < 1e-8 else "theo trung vị track"
    reason = (
        f"{direction.capitalize()} đáy box {abs(delta_z)*100:.1f} cm {target} "
        f"(offset: {offset*100:+.1f} cm, reference: {reference*100:+.1f} cm)"
    )

    return BoxRepairDelta(
        delta_center=(0.0, 0.0, float(delta_z)),
        delta_dims=(0.0, 0.0, 0.0),
        delta_yaw=0.0,
        repaired_cuboid=repaired,
        rule="floating",
        target_offset_m=float(offset),
        confidence=confidence,
        reason=reason,
    )


def _repair_heading(
    cuboid: Cuboid,
    track: list[Cuboid] | None,
    points: np.ndarray | None,
    rule: str,
    finding_details: dict[str, Any] | None = None,
) -> BoxRepairDelta:
    """Tính toán delta góc quay yaw (Δyaw) để sửa lỗi sai hướng."""
    details = finding_details or {}
    delta_yaw = 0.0
    confidence = 0.90
    reason = ""

    if details.get("maybe_reversing") or (details.get("has_world_pose") and "target_yaw_sensor" not in details):
        return BoxRepairDelta((0., 0., 0.), (0., 0., 0.), 0., cuboid, rule, 0., 0.,
                              "Cần xác nhận xe lùi hoặc bổ sung pose cảm biến trước khi sửa hướng")

    if rule in ("heading.flip", "heading.motion", "heading.static") and "target_yaw_sensor" in details:
        delta_yaw = normalize_angle(float(details["target_yaw_sensor"]) - cuboid.yaw)
        reason = f"Hiệu chỉnh {math.degrees(delta_yaw):+.1f}° theo track đã bù chuyển động cảm biến"
        confidence = 0.92
    elif rule == "heading.flip":
        peers = [b for b in (track or [cuboid]) if b.frame != cuboid.frame and b.visible and b.keyframe]
        if "track_heading_deg" in details:
            ref_yaw = math.radians(float(details["track_heading_deg"]))
            delta_yaw = normalize_angle(ref_yaw - cuboid.yaw)
        elif peers:
            sin_mean = float(np.mean([math.sin(b.yaw) for b in peers]))
            cos_mean = float(np.mean([math.cos(b.yaw) for b in peers]))
            ref_yaw = math.atan2(sin_mean, cos_mean)
            delta_yaw = normalize_angle(ref_yaw - cuboid.yaw)
        else:
            confidence = 0.0
            reason = "Không đủ keyframe để xác định hướng chuẩn"
        reason = (f"Xoay {math.degrees(delta_yaw):+.1f}° về hướng chuẩn của keyframe tham chiếu" if peers or "track_heading_deg" in details
                  else "Không đủ keyframe để xác định hướng chuẩn")
        confidence = 0.98 if peers or "track_heading_deg" in details else 0.0

    elif rule == "heading.motion":
        peers = sorted([b for b in (track or [cuboid]) if b.visible and b.keyframe], key=lambda b: b.frame)
        idx = next((i for i, b in enumerate(peers) if b.frame == cuboid.frame), -1)
        motion_yaw = None
        if idx >= 0 and len(peers) >= 2:
            a = max(0, idx - 1)
            b = min(len(peers) - 1, idx + 1)
            dx = peers[b].center[0] - peers[a].center[0]
            dy = peers[b].center[1] - peers[a].center[1]
            if math.hypot(dx, dy) >= 0.5:
                motion_yaw = math.atan2(dy, dx)
        if motion_yaw is not None:
            delta_yaw = normalize_angle(motion_yaw - cuboid.yaw)
        else:
            confidence = 0.0
        reason = (f"Hiệu chỉnh hướng {math.degrees(delta_yaw):+.1f}° theo vector vận tốc" if motion_yaw is not None
                  else "Chuyển động quá nhỏ để xác định hướng; cần kiểm tra thủ công")
        confidence = 0.92 if motion_yaw is not None else 0.0
        if details.get("maybe_reversing"):
            delta_yaw, confidence = 0.0, 0.0
            reason = "Có thể vật thể đang lùi; cần người xem xác nhận trước khi đổi hướng"

    elif rule == "heading.points":
        local_pts = None
        if points is not None and len(points) >= 10:
            try:
                items = box_point_sets(points, [cuboid], margin=0.5, clearance=0.25)
                if items and len(items[0].local) >= 10:
                    local_pts = items[0].local[:, :2]
            except Exception:
                local_pts = None

            if local_pts is None:
                l_all = to_box_frame(points, cuboid)[:, :2]
                half = np.asarray(cuboid.dims[:2]) / 2.0
                mask = np.all(np.abs(l_all) <= half + 0.5, axis=1)
                if np.sum(mask) >= 10:
                    local_pts = l_all[mask]

        if local_pts is not None and len(local_pts) >= 10:
            theta_rect = rectangle_angle(local_pts)
            ref_deg = float(details.get("track_median_deg", 0.0))
            delta_yaw = float(theta_rect + math.radians(ref_deg))
            confidence = 0.95
            reason = f"Khớp L-shape xoay {math.degrees(delta_yaw):+.1f}° theo cụm điểm LiDAR"
        elif "raw_deg" in details:
            dev = float(details["raw_deg"]) - float(details.get("track_median_deg", 0.0))
            delta_yaw = math.radians(-((dev + 45.0) % 90.0 - 45.0))
            confidence = 0.75
            reason = f"Hiệu chỉnh {math.degrees(delta_yaw):+.1f}° theo độ lệch finding"
        else:
            peers = [b for b in (track or [cuboid]) if b.frame != cuboid.frame and b.visible and b.keyframe]
            if peers:
                sin_mean = float(np.mean([math.sin(b.yaw) for b in peers]))
                cos_mean = float(np.mean([math.cos(b.yaw) for b in peers]))
                ref_yaw = math.atan2(sin_mean, cos_mean)
                delta_yaw = normalize_angle(ref_yaw - cuboid.yaw)
                confidence = 0.80
                reason = f"Đồng bộ {math.degrees(delta_yaw):+.1f}° theo trung vị track"
            else:
                delta_yaw = 0.0
                confidence = 0.0
                reason = "Không đủ điểm LiDAR để khớp hướng L-shape"

    else:
        raise ValueError(f"Unsupported repair rule: {rule}")

    repaired_yaw = normalize_angle(cuboid.yaw + delta_yaw)
    repaired = cuboid.replace(yaw=repaired_yaw)
    target_offset_m = float(math.degrees(abs(delta_yaw)))

    return BoxRepairDelta(
        delta_center=(0.0, 0.0, 0.0),
        delta_dims=(0.0, 0.0, 0.0),
        delta_yaw=float(delta_yaw),
        repaired_cuboid=repaired,
        rule=rule,
        target_offset_m=target_offset_m,
        confidence=confidence,
        reason=reason,
    )


def _repair_fit_or_size(
    cuboid: Cuboid,
    track: list[Cuboid] | None,
    points: np.ndarray | None,
    rule: str,
    finding_details: dict[str, Any] | None = None,
) -> BoxRepairDelta:
    """Tính toán delta kích thước và dời tâm (Δdims, Δc_xy) sửa lỗi fit và size."""
    details = finding_details or {}
    active_peers = [b for b in (track or [cuboid]) if b.frame != cuboid.frame and b.visible and b.keyframe]
    track_median_dims = None
    if active_peers:
        track_median_dims = tuple(float(v) for v in np.median([b.dims for b in active_peers], axis=0))

    if rule == "size.in_track":
        if track_median_dims is not None:
            target_dims = track_median_dims
            confidence = 0.98
            reason = f"Đưa kích thước về trung vị track ({target_dims[0]:.2f} x {target_dims[1]:.2f} x {target_dims[2]:.2f} m)"
        else:
            target_dims = cuboid.dims
            confidence = 0.0
            reason = "Không đủ keyframe cùng track để xác định kích thước trung vị"

        delta_dims = (
            target_dims[0] - cuboid.length,
            target_dims[1] - cuboid.width,
            target_dims[2] - cuboid.height,
        )
        dh = delta_dims[2]
        delta_center = (0.0, 0.0, dh / 2.0)
        repaired = cuboid.replace(
            center=(cuboid.center[0], cuboid.center[1], cuboid.center[2] + delta_center[2]),
            dims=target_dims,
        )
        max_diff = max(abs(d) for d in delta_dims)
        return BoxRepairDelta(
            delta_center=delta_center,
            delta_dims=delta_dims,
            delta_yaw=0.0,
            repaired_cuboid=repaired,
            rule=rule,
            target_offset_m=float(max_diff),
            confidence=confidence,
            reason=reason,
        )

    elif rule in ("fit.outside", "fit.loose"):
        local_pts = None
        if points is not None and len(points) > 0:
            try:
                items = box_point_sets(points, [cuboid], margin=1.0, clearance=0.25)
                if items and len(items[0].local) >= 5:
                    local_pts = items[0].local
            except Exception:
                local_pts = None

            if local_pts is None:
                l_all = to_box_frame(points, cuboid)
                half = np.asarray(cuboid.dims) / 2.0
                mask = (
                    np.all(np.abs(l_all[:, :2]) <= half[:2] + 1.0, axis=1)
                    & (l_all[:, 2] >= -half[2] - 0.2)
                    & (l_all[:, 2] <= half[2] + 1.0)
                )
                if np.sum(mask) >= 5:
                    local_pts = l_all[mask]

        if local_pts is not None and len(local_pts) >= 5:
            p1_x = float(np.percentile(local_pts[:, 0], 1.0))
            p99_x = float(np.percentile(local_pts[:, 0], 99.0))
            p1_y = float(np.percentile(local_pts[:, 1], 1.0))
            p99_y = float(np.percentile(local_pts[:, 1], 99.0))
            p1_z = float(np.percentile(local_pts[:, 2], 1.0))
            p99_z = float(np.percentile(local_pts[:, 2], 99.0))

            dx_local = (p1_x + p99_x) / 2.0
            dy_local = (p1_y + p99_y) / 2.0

            span_x = p99_x - p1_x
            span_y = p99_y - p1_y
            span_z = p99_z - p1_z

            if rule == "fit.loose":
                # Only tighten the observed face; the unseen side has no size evidence.
                faces = {"đầu": (0, 1), "đuôi": (0, -1), "bên trái": (1, 1), "bên phải": (1, -1),
                         "đầu và đuôi": (0, 0)}
                face = faces.get(details.get("face"))
                if face is None:
                    return BoxRepairDelta((0., 0., 0.), (0., 0., 0.), 0., cuboid, rule, 0., 0.,
                                          "Thiếu bằng chứng mặt box dư; cần kiểm tra thủ công")
                axis, side = face
                half_axis = cuboid.dims[axis] / 2
                low, high = (-half_axis, half_axis)
                bounds = [(p1_x, p99_x), (p1_y, p99_y)][axis]
                if side <= 0:
                    low = max(low, bounds[0] - 0.05)
                if side >= 0:
                    high = min(high, bounds[1] + 0.05)
                target = list(cuboid.dims)
                target[axis] = max(0.1, high - low)
                shift = (high + low) / 2
                dx_local, dy_local = (shift, 0.) if axis == 0 else (0., shift)
                c, s = math.cos(cuboid.yaw), math.sin(cuboid.yaw)
                dc = (c * dx_local - s * dy_local, s * dx_local + c * dy_local, 0.)
                dd = tuple(target[i] - cuboid.dims[i] for i in range(3))
                repaired = cuboid.replace(center=tuple(cuboid.center[i] + dc[i] for i in range(3)), dims=tuple(target))
                return BoxRepairDelta(dc, dd, 0., repaired, rule, abs(dd[axis]), 0.85,
                                      f"Thu mặt {details['face']} về cụm điểm vật thể, giữ 5 cm đệm")

            if track_median_dims is not None:
                med_l, med_w, med_h = track_median_dims
                pad = 0.04
                l_target = (span_x + pad) if span_x > med_l + 0.10 else med_l
                w_target = (span_y + pad) if span_y > med_w + 0.10 else med_w
                h_target = track_median_dims[2]
            else:
                pad = 0.10
                l_target = max(cuboid.length, span_x + pad)
                w_target = max(cuboid.width, span_y + pad)
                h_target = cuboid.height

            target_dims = (float(l_target), float(w_target), float(h_target))
            delta_dims = (
                target_dims[0] - cuboid.length,
                target_dims[1] - cuboid.width,
                target_dims[2] - cuboid.height,
            )

            c = math.cos(cuboid.yaw)
            s = math.sin(cuboid.yaw)
            dx_sensor = c * dx_local - s * dy_local
            dy_sensor = s * dx_local + c * dy_local
            dz = delta_dims[2] / 2.0

            delta_center = (float(dx_sensor), float(dy_sensor), float(dz))
            new_center = (
                cuboid.center[0] + delta_center[0],
                cuboid.center[1] + delta_center[1],
                cuboid.center[2] + delta_center[2],
            )
            repaired = cuboid.replace(center=new_center, dims=target_dims)
            confidence = 0.92
            reason = (
                f"Dời tâm ({dx_sensor:+.2f}, {dy_sensor:+.2f}) m và bao trọn điểm vật thể "
                f"({target_dims[0]:.2f} x {target_dims[1]:.2f} m)"
            )
            target_offset_m = float(math.hypot(dx_sensor, dy_sensor))
        else:
            if track_median_dims is not None:
                target_dims = track_median_dims
            else:
                target_dims = cuboid.dims

            delta_dims = (
                target_dims[0] - cuboid.length,
                target_dims[1] - cuboid.width,
                target_dims[2] - cuboid.height,
            )
            delta_center = (0.0, 0.0, delta_dims[2] / 2.0)
            repaired = cuboid.replace(
                center=(cuboid.center[0], cuboid.center[1], cuboid.center[2] + delta_center[2]),
                dims=target_dims,
            )
            confidence = 0.70
            reason = "Căn chỉnh kích thước theo trung vị track (thiếu điểm LiDAR)"
            target_offset_m = float(max(abs(d) for d in delta_dims))

        return BoxRepairDelta(
            delta_center=delta_center,
            delta_dims=delta_dims,
            delta_yaw=0.0,
            repaired_cuboid=repaired,
            rule=rule,
            target_offset_m=target_offset_m,
            confidence=confidence,
            reason=reason,
        )

    elif rule == "size.class_range":
        ranges = DEFAULT_CLASS_RANGES.get(cuboid.label, {})
        new_l, new_w, new_h = cuboid.dims
        if "length" in ranges:
            p1, p99 = ranges["length"]
            if new_l < p1:
                new_l = (p1 + p99) / 2.0
            elif new_l > p99:
                new_l = p99
        if "width" in ranges:
            p1, p99 = ranges["width"]
            if new_w < p1:
                new_w = (p1 + p99) / 2.0
            elif new_w > p99:
                new_w = p99
        if "height" in ranges:
            p1, p99 = ranges["height"]
            if new_h < p1:
                new_h = (p1 + p99) / 2.0
            elif new_h > p99:
                new_h = p99

        target_dims = (float(new_l), float(new_w), float(new_h))
        delta_dims = (
            target_dims[0] - cuboid.length,
            target_dims[1] - cuboid.width,
            target_dims[2] - cuboid.height,
        )
        dz = delta_dims[2] / 2.0
        delta_center = (0.0, 0.0, float(dz))
        repaired = cuboid.replace(
            center=(cuboid.center[0], cuboid.center[1], cuboid.center[2] + dz),
            dims=target_dims,
        )
        return BoxRepairDelta(
            delta_center=delta_center,
            delta_dims=delta_dims,
            delta_yaw=0.0,
            repaired_cuboid=repaired,
            rule=rule,
            target_offset_m=float(max(abs(d) for d in delta_dims)),
            confidence=0.85,
            reason=f"Đưa kích thước về khoảng chuẩn class {cuboid.label} ({target_dims[0]:.2f} x {target_dims[1]:.2f} x {target_dims[2]:.2f} m)",
        )

    else:
        raise ValueError(f"Unsupported repair rule: {rule}")


def _repair_critic_box(
    cuboid: Cuboid,
    finding_details: dict[str, Any] | None = None,
) -> BoxRepairDelta:
    """Áp dụng gợi ý hiệu chỉnh hình học từ mô hình Box Critic."""
    details = finding_details or {}
    fix = details.get("suggested_fix")
    dx, dy, dz = 0.0, 0.0, 0.0
    dl, dw, dh = 0.0, 0.0, 0.0
    dyaw = 0.0
    found = False

    if isinstance(fix, dict):
        dx = float(fix.get("dx", 0.0))
        dy = float(fix.get("dy", 0.0))
        dz = float(fix.get("dz", 0.0))
        dl = float(fix.get("dl", 0.0))
        dw = float(fix.get("dw", 0.0))
        dh = float(fix.get("dh", 0.0))
        dyaw = float(fix.get("dyaw", 0.0))
        found = True
    elif "message" in details or "msg" in details:
        import re

        msg = str(details.get("message") or details.get("msg", ""))
        mc = re.search(r"dời \(([+-]?\d+\.?\d*),\s*([+-]?\d+\.?\d*),\s*([+-]?\d+\.?\d*)\)", msg)
        md = re.search(r"kích thước \(([+-]?\d+\.?\d*),\s*([+-]?\d+\.?\d*),\s*([+-]?\d+\.?\d*)\)", msg)
        my = re.search(r"xoay ([+-]?\d+\.?\d*)°", msg)
        if mc:
            dx, dy, dz = float(mc.group(1)), float(mc.group(2)), float(mc.group(3))
            found = True
        if md:
            dl, dw, dh = float(md.group(1)), float(md.group(2)), float(md.group(3))
            found = True
        if my:
            dyaw = math.radians(float(my.group(1)))
            found = True

    if not found:
        return BoxRepairDelta(
            delta_center=(0.0, 0.0, 0.0),
            delta_dims=(0.0, 0.0, 0.0),
            delta_yaw=0.0,
            repaired_cuboid=cuboid,
            rule="critic.box",
            target_offset_m=0.0,
            confidence=0.0,
            reason="Không có thông số gợi ý sửa trong kết quả Box Critic",
        )

    c, s = math.cos(cuboid.yaw), math.sin(cuboid.yaw)
    sensor_dx = float(c * dx - s * dy)
    sensor_dy = float(s * dx + c * dy)
    sensor_dz = float(dz)
    delta_center = (sensor_dx, sensor_dy, sensor_dz)
    delta_dims = (float(dl), float(dw), float(dh))
    delta_yaw = float(dyaw)

    new_center = (
        cuboid.center[0] + sensor_dx,
        cuboid.center[1] + sensor_dy,
        cuboid.center[2] + sensor_dz,
    )
    new_dims = (
        max(0.1, cuboid.length + dl),
        max(0.1, cuboid.width + dw),
        max(0.1, cuboid.height + dh),
    )
    new_yaw = normalize_angle(cuboid.yaw + dyaw)
    repaired = cuboid.replace(center=new_center, dims=new_dims, yaw=new_yaw)

    target_offset_m = float(math.hypot(sensor_dx, sensor_dy))
    return BoxRepairDelta(
        delta_center=delta_center,
        delta_dims=delta_dims,
        delta_yaw=delta_yaw,
        repaired_cuboid=repaired,
        rule="critic.box",
        target_offset_m=target_offset_m,
        confidence=0.90,
        reason=f"Áp dụng gợi ý chỉnh sửa từ mô hình Box Critic (dời {sensor_dx:+.2f}, {sensor_dy:+.2f} m)",
    )


def _repair_box_fit(cuboid: Cuboid, rule: str, finding_details: dict[str, Any] | None = None) -> BoxRepairDelta:
    """Áp box đề xuất của `fit.offset` / `fit.yaw` (tâm dời, hướng xoay; kích thước giữ nguyên)."""
    details = finding_details or {}
    center, yaw = details.get("proposed_center"), details.get("proposed_yaw")
    try:
        values = [float(v) for v in (*center, yaw)] if isinstance(center, (list, tuple)) and len(center) == 3 else []
    except (TypeError, ValueError):
        values = []
    if len(values) != 4 or not all(math.isfinite(v) for v in values):
        return BoxRepairDelta((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), 0.0, cuboid, rule, 0.0, 0.0,
                              "Chưa đủ bằng chứng để đề xuất box tham chiếu")
    new_center = tuple(values[:3])
    delta_center = tuple(n - o for n, o in zip(new_center, cuboid.center))
    delta_yaw = normalize_angle(values[3] - cuboid.yaw)
    repaired = cuboid.replace(center=new_center, yaw=normalize_angle(values[3]))
    offset = float(math.hypot(delta_center[0], delta_center[1]))
    cams = ", ".join(details.get("cameras") or [])
    evidence = f"thuộc mặt nạ SAM ({cams})" if cams else "của vật"
    return BoxRepairDelta(delta_center, (0.0, 0.0, 0.0), delta_yaw, repaired, rule, offset, 0.85,
                          f"Khớp box vào {details.get('num_points', 0)} điểm LiDAR {evidence}: dời {offset:.2f} m, "
                          f"xoay {math.degrees(delta_yaw):+.1f}°")


def compute_box_repair(
    cuboid: Cuboid,
    track: list[Cuboid] | None,
    points: np.ndarray | None,
    rule: str,
    finding_details: dict[str, Any] | None = None,
) -> BoxRepairDelta:
    """Tính toán thông số hình học đề xuất (BoxRepairDelta) để triệt tiêu lỗi scanner."""
    track_boxes = [b for b in (track or [cuboid]) if b.track_id == cuboid.track_id and b.label == cuboid.label]
    if points is not None:
        points = np.asarray(points, dtype=float)
        points = points[np.isfinite(points).all(axis=1)]
    if rule == "floating" or rule.startswith("floating"):
        return _repair_ground(cuboid, track_boxes, points, finding_details)
    elif rule in ("fit.offset", "fit.yaw", "cam.face"):
        return _repair_box_fit(cuboid, rule, finding_details)
    elif rule.startswith("heading"):
        return _repair_heading(cuboid, track_boxes, points, rule, finding_details)
    elif rule.startswith("fit") or rule.startswith("size"):
        return _repair_fit_or_size(cuboid, track_boxes, points, rule, finding_details)
    elif rule == "critic.box":
        return _repair_critic_box(cuboid, finding_details)
    else:
        raise ValueError(f"Unsupported repair rule: {rule}")


def verify_repaired_box_passes_scanner(
    repaired_box: Cuboid,
    track: list[Cuboid] | None = None,
    points: np.ndarray | dict[int, np.ndarray] | FrameSource | None = None,
    rule: str = "",
    config: Config | None = None,
) -> bool:
    """Kiểm tra box sau khi sửa có vượt qua bộ quét (0 errors, 0 warnings cho rule được sửa)."""
    if config is None:
        config = load_config()

    repaired_track: list[Cuboid] = []
    replaced = False
    for b in (track or [repaired_box]):
        if b.frame == repaired_box.frame and (repaired_box.track_id is None or b.track_id == repaired_box.track_id):
            repaired_track.append(repaired_box)
            replaced = True
        else:
            repaired_track.append(b)
    if not replaced:
        repaired_track.append(repaired_box)

    frame_source: Any = None
    if hasattr(points, "frame_data"):
        frame_source = points
    elif isinstance(points, dict):
        frame_source = SimpleFrameSource(points)
    elif isinstance(points, np.ndarray):
        if len(points) > 0:
            frame_source = SimpleFrameSource({b.frame: points for b in repaired_track})
        else:
            frame_source = SimpleFrameSource({})

    findings = scan_cuboids(repaired_track, config=config, frames=frame_source)

    box_findings = [
        f for f in findings
        if f.frame == repaired_box.frame
        and (repaired_box.track_id is None or f.track_id == repaired_box.track_id or f.source_id == repaired_box.source_id)
    ]

    for f in box_findings:
        if f.severity in (Severity.ERROR, Severity.WARNING):
            if not rule:
                return False
            if rule == "floating" and f.rule.startswith("floating"):
                return False
            elif rule == f.rule or f.rule.startswith(rule):
                return False

    return True
