"""Bộ phát hiện sai hướng box (việc C1).

Spec 4.2: hướng box trùng với hướng chuyển động chính của vật thể; vật đứng yên thì theo trục dài nhất. Ba luật:

1. `heading.flip`: hướng box (hệ toàn cục) đổi đột ngột giữa hai keyframe liền nhau của một track, nhanh hơn tốc độ
   quay hợp lý của loại vật (`yaw_rate_max_dps`) và vượt `flip_warning_deg`. Cắt track tại các chỗ đổi đột ngột thành
   các đoạn; đoạn dài nhất là chuẩn, mọi box thuộc đoạn khác bị báo (đều phải xoay lại). Xoay ngang hoặc lật đầu box
   (≥ `flip_error_deg`) là Lỗi.
2. `heading.motion`: vật đang chạy (≥ `min_speed_mps`, quãng đường giữa hai keyframe lân cận ≥ `min_motion_m`) mà hướng
   box lệch hướng chuyển động > `motion_warning_deg` (Cảnh báo), > `motion_error_deg` (Lỗi, box ngược chiều). Box đã
   bị báo `heading.flip` thì không báo thêm.
3. `heading.points`: trục box lệch trục của cụm điểm LiDAR của vật. Tìm hướng hình chữ nhật khớp cụm điểm nhất theo
   tiêu chí "closeness" của phép khớp hình chữ L (Zhang et al., 2017), so với trục box theo modulo 90°, rồi so với
   trung vị của các box khác cùng track. Chỉ xét box dài (≥ `min_aspect`), đủ điểm, gần cảm biến. Lệch >
   `warning_deg` là Cảnh báo, > `error_deg` là Lỗi.

Không có pose xe thu thì hướng trong hệ cảm biến đổi theo xe thu: `heading.flip` chỉ báo ở mức Cảnh báo, còn
`heading.motion` không xét (chuyển động thấy trong hệ cảm biến là chuyển động của vật trừ chuyển động của xe thu: xe đỗ
bên đường trông như đang chạy lùi).
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Mapping, Sequence

import numpy as np

from pointsnap.core.box_points import BoxPointSet
from pointsnap.core.geometry import normalize_angle, transform_points
from pointsnap.core.model import Cuboid, ErrorType, Finding, Severity, group_by_track
from pointsnap.core.heading_memory import HeadingMemory

if TYPE_CHECKING:
    from pointsnap.core.config import Config, HeadingConfig, HeadingGroupConfig, HeadingPointsConfig
    from pointsnap.core.context import DetectionContext


def angle_diff_deg(a: float, b: float) -> float:
    """|a − b| (radian) quy về [0°, 180°]."""
    return abs(math.degrees(normalize_angle(a - b)))


def _world(
    boxes: Sequence[Cuboid], sensor_to_world: Mapping[int, np.ndarray] | None,
) -> tuple[np.ndarray, np.ndarray, bool]:
    """Tâm (N, 2) và hướng (N,) của các box trong hệ toàn cục; nếu thiếu pose thì giữ hệ point cloud."""
    centers = np.array([b.center for b in boxes], dtype=np.float64)
    headings = np.array([b.yaw for b in boxes], dtype=np.float64)
    if not sensor_to_world or not all(b.frame in sensor_to_world for b in boxes):
        return centers[:, :2], headings, False
    world_centers, world_headings = [], []
    for b in boxes:
        mat = np.asarray(sensor_to_world[b.frame], dtype=np.float64)
        world_centers.append(transform_points(np.array([b.center]), mat)[0, :2])
        direction = mat[:3, :3] @ np.array([math.cos(b.yaw), math.sin(b.yaw), 0.0])
        world_headings.append(math.atan2(direction[1], direction[0]))
    return np.array(world_centers), np.array(world_headings), True


def _times(boxes: Sequence[Cuboid], interval_s: float, timestamps: Mapping[int, float] | None) -> np.ndarray:
    if timestamps and all(b.frame in timestamps for b in boxes):
        return np.array([float(timestamps[b.frame]) for b in boxes])
    return np.array([b.frame * interval_s for b in boxes])


def _runs(headings: np.ndarray, times: np.ndarray, grp: HeadingGroupConfig) -> list[list[int]]:
    """Cắt chuỗi hướng thành các đoạn: giữa hai keyframe liền nhau mà hướng đổi quá nhanh thì sang đoạn mới."""
    runs = [[0]]
    for i in range(1, len(headings)):
        dt = max(float(times[i] - times[i - 1]), 1e-6)
        limit = max(grp.flip_warning_deg, grp.yaw_rate_max_dps * dt)
        if angle_diff_deg(headings[i], headings[i - 1]) > limit:
            runs.append([])
        runs[-1].append(i)
    return runs


def _finding(rule: str, severity: Severity, box: Cuboid, message: str, value: float, threshold: float,
             details: dict) -> Finding:
    return Finding(error_type=ErrorType.HEADING, rule=rule, severity=severity, frame=box.frame, label=box.label,
                   track_id=box.track_id, source_id=box.source_id, message=message, value=value,
                   threshold=threshold, details=details)


def _flip_findings(
    boxes: list[Cuboid], headings: np.ndarray, times: np.ndarray, grp: HeadingGroupConfig, has_world: bool,
) -> list[Finding]:
    runs = _runs(headings, times, grp)
    if len(runs) < 2:
        return []
    reference = max(runs, key=len)
    ref_set = set(reference)
    ref_heading = math.atan2(float(np.mean(np.sin(headings[reference]))), float(np.mean(np.cos(headings[reference]))))
    findings: list[Finding] = []
    for run in runs:
        if run is reference:
            continue
        for i in run:
            nearest = min(reference, key=lambda j: abs(j - i))
            deviation = angle_diff_deg(headings[i], headings[nearest])
            if deviation <= grp.flip_warning_deg:
                continue
            is_error = deviation >= grp.flip_error_deg and has_world
            severity = Severity.ERROR if is_error else Severity.WARNING
            threshold = grp.flip_error_deg if deviation >= grp.flip_error_deg else grp.flip_warning_deg
            kind = ("ngược đầu (lật box)" if deviation >= 135 else "xoay ngang") if deviation >= grp.flip_error_deg \
                else "lệch"
            message = (f"Hướng box {kind} {deviation:.0f}° so với keyframe gần nhất của phần còn lại của track "
                       f"(frame {boxes[nearest].frame}); đổi hướng nhanh bất thường (ngưỡng {threshold:.0f}°)")
            if not has_world:
                message += " [chưa có toạ độ toàn cục]"
            findings.append(_finding("heading.flip", severity, boxes[i], message, deviation, threshold, {
                "deviation_deg": deviation, "reference_frame": boxes[nearest].frame, "run_frames":
                [boxes[k].frame for k in run], "track_heading_deg": math.degrees(ref_heading),
                "has_world_pose": has_world, "in_reference": i in ref_set,
                "target_yaw_sensor": normalize_angle(boxes[i].yaw + normalize_angle(headings[nearest] - headings[i])),
            }))
    return findings


def _motion_findings(
    boxes: list[Cuboid], centers: np.ndarray, headings: np.ndarray, times: np.ndarray, grp: HeadingGroupConfig,
    min_motion_m: float, has_world: bool, skip: set[int],
) -> list[Finding]:
    rows = []
    memory = HeadingMemory(min_motion_m=min_motion_m, min_speed_mps=grp.min_speed_mps)
    predictions = {}
    n = len(boxes)
    for i in range(n):
        memory.update(boxes[i].track_id, boxes[i].frame, times[i], centers[i], headings[i])
        predictions[i] = memory.predict(boxes[i].track_id).to_dict()
        if i in skip:
            continue
        a, b = max(0, i - 1), min(n - 1, i + 1)
        if a == b:
            continue
        motion = centers[b] - centers[a]
        distance = float(np.hypot(*motion))
        dt = float(times[b] - times[a])
        if dt <= 0 or distance < min_motion_m or distance / dt < grp.min_speed_mps:
            continue
        deviation = angle_diff_deg(headings[i], math.atan2(motion[1], motion[0]))
        rows.append((i, a, b, distance / dt, deviation))
    # Xe lùi thật (C5): box ngược chiều ở gần hết các frame đang chạy và vật chạy chậm. Không phân biệt được với box vẽ
    # ngược trên xe chạy chậm, nên hạ xuống Cảnh báo; xe chạy nhanh mà box ngược vẫn là Lỗi.
    reversed_rows = [r for r in rows if r[4] >= grp.motion_error_deg]
    maybe_reversing = (grp.reverse_max_mps > 0 and len(reversed_rows) >= 2
                       and len(reversed_rows) >= 0.8 * len(rows)
                       and max(r[3] for r in reversed_rows) <= grp.reverse_max_mps)
    findings: list[Finding] = []
    if maybe_reversing:
        # Một mục cho cả đoạn: người duyệt chỉ cần xác nhận xe có lùi không.
        first, last = reversed_rows[0], reversed_rows[-1]
        speed = max(r[3] for r in reversed_rows)
        deviation = float(np.median([r[4] for r in reversed_rows]))
        message = (f"Hướng box ngược chiều chuyển động ở {len(reversed_rows)}/{len(rows)} keyframe đang chạy (frame "
                   f"{boxes[first[0]].frame}–{boxes[last[0]].frame}) khi vật chạy chậm (≤ {speed:.1f} m/s): có thể đang "
                   f"lùi thật, nếu không thì xoay box 180° ở cả đoạn")
        findings.append(_finding("heading.motion", Severity.WARNING, boxes[first[0]], message, deviation,
                                 grp.motion_error_deg, {"deviation_deg": deviation, "speed_mps": speed,
                                                        "has_world_pose": has_world, "maybe_reversing": True,
                                                        "frames": [boxes[r[0]].frame for r in reversed_rows]}))
        rows = [r for r in rows if r[4] < grp.motion_error_deg]
    for i, a, b, speed, deviation in rows:
        if deviation <= grp.motion_warning_deg:
            continue
        is_reverse = deviation >= grp.motion_error_deg
        is_error = is_reverse and has_world
        severity = Severity.ERROR if is_error else Severity.WARNING
        threshold = grp.motion_error_deg if is_reverse else grp.motion_warning_deg
        kind = "ngược chiều" if is_reverse else "lệch"
        message = (f"Hướng box {kind} {deviation:.0f}° so với hướng chuyển động của vật "
                   f"({speed:.1f} m/s, frame {boxes[a].frame}–{boxes[b].frame}; ngưỡng {threshold:.0f}°)")
        if not has_world:
            message += " [chưa có toạ độ toàn cục]"
        findings.append(_finding("heading.motion", severity, boxes[i], message, deviation, threshold, {
            "deviation_deg": deviation, "speed_mps": speed, "has_world_pose": has_world,
            "target_yaw_sensor": normalize_angle(boxes[i].yaw + normalize_angle(
                math.atan2(*(centers[b] - centers[a])[::-1]) - headings[i])),
            "heading_prediction": predictions[i],
        }))
    return findings


def detect_heading_track(
    cuboids: Sequence[Cuboid],
    config: HeadingConfig,
    keyframe_interval_s: float = 0.5,
    sensor_to_world: Mapping[int, np.ndarray] | None = None,
    timestamps: Mapping[int, float] | None = None,
    flip: bool = True,
    motion: bool = True,
) -> list[Finding]:
    """Luật `heading.flip` và `heading.motion` trên mọi track."""
    findings: list[Finding] = []
    for boxes in group_by_track(cuboids).values():
        active = [b for b in boxes if b.visible and b.keyframe]
        if len(active) < 2:
            continue
        grp = config.group_for(active[0].label)
        if grp is None:
            continue
        centers, headings, has_world = _world(active, sensor_to_world)
        times = _times(active, keyframe_interval_s, timestamps)
        flips = _flip_findings(active, headings, times, grp, has_world) if flip else []
        findings.extend(flips)
        if motion and has_world:
            flagged = {i for i, b in enumerate(active) if any(f.frame == b.frame for f in flips)}
            findings.extend(_motion_findings(active, centers, headings, times, grp, config.min_motion_m, has_world,
                                             flagged))
    return findings


_ANGLES = np.radians(np.arange(-45.0, 45.0, 1.0))
_DIRECTIONS = np.stack([np.cos(_ANGLES), np.sin(_ANGLES)], axis=1)


def rectangle_angle(xy: np.ndarray) -> float:
    """Hướng (radian, trong [−45°, 45°)) của hình chữ nhật khớp cụm điểm 2D nhất, theo tiêu chí closeness.

    Với mỗi góc thử, chiếu điểm lên hai trục của hình chữ nhật; mỗi điểm được tính điểm theo khoảng cách tới cạnh gần
    nhất (gần cạnh thì điểm cao). Cụm điểm của xe nằm sát hai cạnh nhìn thấy được (hình chữ L), nên góc đúng cho tổng
    điểm cao nhất.
    """
    pts = np.asarray(xy, dtype=np.float64)
    c1 = _DIRECTIONS @ pts.T                       # (A, M)
    c2 = np.stack([-_DIRECTIONS[:, 1], _DIRECTIONS[:, 0]], axis=1) @ pts.T
    d1 = np.minimum(c1.max(axis=1, keepdims=True) - c1, c1 - c1.min(axis=1, keepdims=True))
    d2 = np.minimum(c2.max(axis=1, keepdims=True) - c2, c2 - c2.min(axis=1, keepdims=True))
    score = (1.0 / np.maximum(np.minimum(d1, d2), 0.05)).sum(axis=1)
    return float(_ANGLES[int(np.argmax(score))])


def heading_points_measure(item: BoxPointSet, cfg: HeadingPointsConfig) -> float | None:
    """Độ lệch có dấu (độ, trong [−45°, 45°]) giữa trục box và hướng hình chữ nhật khớp các điểm của vật quanh box.

    `None` nếu box không thuộc phạm vi luật: class khác, box không đủ dài, quá xa, hoặc quá ít điểm.
    """
    box = item.box
    if box.label not in cfg.classes or box.length < cfg.min_aspect * box.width or item.range_m > cfg.max_range_m:
        return None
    if item.num_object_points < cfg.min_points:
        return None
    return -math.degrees(rectangle_angle(item.local[:, :2]))


def _wrap90(deg: float) -> float:
    """Góc (độ) quy về [−45°, 45°)."""
    return (deg + 45.0) % 90.0 - 45.0


def heading_points_findings(measures: Sequence[tuple[Cuboid, float]], cfg: HeadingPointsConfig) -> list[Finding]:
    """Luật `heading.points`: so độ lệch trục của từng box với **trung vị độ lệch của các box khác cùng track**.

    Vật có hình dạng không vuông vức (xe công trình, xe có cần cẩu) lệch trục cụm điểm một lượng ổn định trong cả
    track, nên chỉ phần lệch khác thường so với chính track mới là lỗi. Box lẻ hoặc track có ít hơn 2 box khác đo được
    thì so độ lệch tuyệt đối.
    """
    by_track: dict[tuple[int, str], list[float]] = {}
    for box, dev in measures:
        if box.track_id is not None:
            by_track.setdefault((box.track_id, box.label), []).append(dev)
    findings: list[Finding] = []
    for box, dev in measures:
        others = list(by_track.get((box.track_id, box.label), [])) if box.track_id is not None else []
        if others:
            others.remove(dev)
        if len(others) >= 2:
            anchor = min(others)
            # Trung vị trên trục modulo 90 độ: +44 và -44 phải gần nhau, không gần 0.
            reference = anchor + float(np.median((np.asarray(others) - anchor + 45) % 90 - 45))
        else:
            reference = 0.0
        deviation = abs(_wrap90(dev - reference))
        if deviation <= cfg.warning_deg:
            continue
        severity = Severity.ERROR if deviation > cfg.error_deg else Severity.WARNING
        threshold = cfg.error_deg if deviation > cfg.error_deg else cfg.warning_deg
        relative = f" (so với trung vị {reference:+.0f}° của các frame khác của track)" if len(others) >= 2 else ""
        findings.append(_finding(
            "heading.points", severity, box,
            f"Trục box lệch {deviation:.0f}° so với trục của cụm điểm LiDAR của vật{relative} (ngưỡng {threshold:.0f}°)",
            deviation, threshold, {"deviation_deg": deviation, "raw_deg": dev, "track_median_deg": reference},
        ))
    return findings


from pointsnap.detectors.base import BaseDetector


class HeadingDetector(BaseDetector):
    """Bộ phát hiện sai hướng box (heading.flip, heading.motion)."""

    rule_id = "heading.flip"
    name = "HeadingDetector"

    def is_enabled(self, config: Config) -> bool:
        r = config.rules
        return bool(r.heading_flip or r.heading_motion)

    def detect(self, ctx: DetectionContext) -> list[Finding]:
        s2w, ts = ctx.poses
        return detect_heading_track(
            ctx.cuboids,
            ctx.config.heading,
            keyframe_interval_s=ctx.config.track.keyframe_interval_s,
            sensor_to_world=s2w,
            timestamps=ts,
            flip=ctx.config.rules.heading_flip,
            motion=ctx.config.rules.heading_motion,
        )

