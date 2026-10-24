"""Bộ phát hiện box xoay của vật đứng yên (việc C3, lớp 1 của Box Verifier).

Vật đỗ, cọc tiêu, rào chắn… đứng yên trong hệ toàn cục: box đúng ở mọi keyframe phải gần như trùng nhau. Đo trên nhãn
chuẩn nuScenes (5 cảnh tinh chỉnh): khi các keyframe khác của track tụ trong `max_spread_m` (10 cm, p90), box còn lại
lệch hướng p99 < 1° (trừ người đi bộ xoay người). Nên box lệch vài độ so với cụm đó là box vẽ lệch, kể cả khi quá
nhỏ để luật lật hướng (≥ 45°) bắt được.

Bỏ thử từng box: nếu các keyframe **còn lại** của track (ít nhất `min_keyframes − 1`) tụ sát nhau trong hệ toàn cục thì
coi vật đứng yên, đo hướng box đó lệch bao xa so với hướng chung của cụm: `heading.static` — hướng box lệch
> `yaw_warning_deg` / `yaw_error_deg`, so theo modulo 180° (box đối xứng; lật đầu do `heading.flip` bắt). Không xét class
trong `yaw_excluded_classes`.

Cần pose xe thu (hệ toàn cục); không có thì không xét.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Mapping, Sequence

import numpy as np

from pointsnap.core.geometry import normalize_angle
from pointsnap.core.model import Cuboid, ErrorType, Finding, Severity

if TYPE_CHECKING:
    from pointsnap.core.config import StaticConfig


def _world(boxes: Sequence[Cuboid], poses: Mapping[int, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    centers, headings = [], []
    for b in boxes:
        mat = np.asarray(poses[b.frame], dtype=np.float64)
        centers.append((mat[:3, :3] @ np.asarray(b.center) + mat[:3, 3])[:2])
        d = mat[:3, :3] @ np.array([math.cos(b.yaw), math.sin(b.yaw), 0.0])
        headings.append(math.atan2(d[1], d[0]))
    return np.array(centers), np.array(headings)


def _axial_mean(angles: np.ndarray) -> float:
    return math.atan2(float(np.mean(np.sin(2 * angles))), float(np.mean(np.cos(2 * angles)))) / 2


def _axial_diff_deg(a: float, b: float) -> float:
    return abs(math.degrees(normalize_angle(2 * (a - b)) / 2))


def detect_static_errors(
    cuboids: Sequence[Cuboid], cfg: StaticConfig, sensor_to_world: Mapping[int, np.ndarray] | None,
    rotate: bool = True,
) -> list[Finding]:
    if not sensor_to_world or not rotate:
        return []
    findings: list[Finding] = []
    groups = {}
    for b in cuboids:
        if b.track_id is not None:
            groups.setdefault((b.track_id, b.label), []).append(b)
    for boxes in groups.values():
        visible = [b for b in boxes if b.visible and b.keyframe and b.frame in sensor_to_world]
        if len(visible) < cfg.min_keyframes:
            continue
        centers, headings = _world(visible, sensor_to_world)
        for i, box in enumerate(visible):
            rest = np.delete(np.arange(len(visible)), i)
            median = np.median(centers[rest], axis=0)
            spread = float(np.percentile(np.linalg.norm(centers[rest] - median, axis=1), 90))
            if spread > cfg.max_spread_m:
                continue
            if yaw_excluded(box, cfg.yaw_excluded_classes):
                continue
            deviation = _axial_diff_deg(headings[i], _axial_mean(headings[rest]))
            if deviation > cfg.yaw_warning_deg:
                is_error = deviation > cfg.yaw_error_deg
                threshold = cfg.yaw_error_deg if is_error else cfg.yaw_warning_deg
                findings.append(Finding(
                    error_type=ErrorType.HEADING, rule="heading.static",
                    severity=Severity.ERROR if is_error else Severity.WARNING, frame=box.frame, label=box.label,
                    track_id=box.track_id, source_id=box.source_id, value=deviation, threshold=threshold,
                    message=(f"Vật đứng yên nhưng hướng box ở frame này lệch {deviation:.1f}° so với các keyframe khác "
                             f"của track (ngưỡng {threshold:.0f}°)"),
                    details={"spread_m": spread, "deviation_deg": deviation,
                             "target_yaw_sensor": normalize_angle(box.yaw + (
                                 (_axial_mean(headings[rest]) - headings[i] + math.pi / 2) % math.pi - math.pi / 2))},
                ))
    return findings


def yaw_excluded(box: Cuboid, classes: Sequence[str]) -> bool:
    """Box thuộc class (hoặc `Class/giá trị thuộc tính`, vd `Obstacle/traffic cone`) không xét hướng."""
    if box.label in classes:
        return True
    return any(f"{box.label}/{v}" in classes for v in box.attrs.values() if isinstance(v, str))
