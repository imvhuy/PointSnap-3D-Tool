"""Bộ phát hiện lỗi lơ lửng / lún đất (việc B3).

Quy ước: CONVENTIONS.md mục 4 (mã luật `floating`, `floating.no_evidence`).
Định nghĩa: d = z_đáy_box - z_ground_cục_bộ (cm).
  d > 0: lơ lửng
  d < 0: lún đất
Chống báo động giả: Ít hơn min_ground_points điểm ground -> mức Thông tin ("thiếu bằng chứng").

Hai cách dùng:
- `detect_floating` / `detect_floating_for_box`: một frame, so |d| tuyệt đối với `warning_m` / `error_m`.
- `detect_floating_scene` (bộ quét dùng, A10): cả job. Nhãn chuẩn nuScenes tự nó đã lệch mặt đất ước lượng khá
  nhiều (bờ vỉa, dốc, LiDAR thưa: trung vị |d| ~8 cm, p90 ~25 cm) nhưng phần lệch đó ổn định trong một track, nên so
  `d` của box với **trung vị d của các peer**, chỉ gộp box đang xét khi có dưới 3 peer; mặt đất đo bằng trung vị điểm thấp trong vành đai sát
  box, đã bỏ điểm của box khác (`ring_ground_for_box`). Kiểm chứng: docs/ket-qua/kiem-chung-ground.md.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import TYPE_CHECKING, Iterable, Sequence

import numpy as np

from pointsnap.core.geometry import invert_pose, points_in_cuboid
from pointsnap.core.ground import GroundEstimate, OtherBoxPoints, estimate_ground_for_box, ring_ground_for_box
from pointsnap.core.model import ErrorType, Finding, Severity, group_by_frame

if TYPE_CHECKING:
    from pointsnap.core.config import FloatingConfig
    from pointsnap.core.context import DetectionContext
    from pointsnap.core.model import Cuboid, FrameSource


def detect_floating_for_box(
    cuboid: Cuboid,
    points: np.ndarray,
    config: FloatingConfig,
    seed: int | None = 42,
) -> Finding | None:
    """Kiểm tra lỗi lơ lửng / lún đất cho một box 3D."""
    if not cuboid.visible or cuboid.label not in config.classes:
        return None

    est: GroundEstimate = estimate_ground_for_box(
        points=points,
        cuboid=cuboid,
        ring_inner_m=config.ring_inner_m,
        ring_outer_m=config.ring_outer_m,
        min_ground_points=config.min_ground_points,
        seed=seed,
    )

    if est.status == "no_evidence":
        return Finding(
            error_type=ErrorType.FLOATING,
            rule="floating.no_evidence",
            severity=Severity.INFO,
            frame=cuboid.frame,
            label=cuboid.label,
            track_id=cuboid.track_id,
            source_id=cuboid.source_id,
            message=(
                f"Vành đai quanh box chỉ có {est.num_ground_points} điểm ground "
                f"(< {config.min_ground_points}), thiếu bằng chứng kết luận"
            ),
            value=float(est.num_ground_points),
            threshold=float(config.min_ground_points),
            details={"num_ground_points": est.num_ground_points},
        )

    if not est.is_valid or est.distance is None:
        return None

    d = est.distance
    abs_d = abs(d)

    if abs_d <= config.ground_tolerance_m:
        return None

    if abs_d > config.error_m:
        severity = Severity.ERROR
        thresh = config.error_m
    elif abs_d > config.warning_m:
        severity = Severity.WARNING
        thresh = config.warning_m
    else:
        return None

    d_cm = abs_d * 100.0
    thresh_cm = thresh * 100.0
    direction = "lơ lửng" if d > 0 else "lún đất"

    message = f"Đáy box {direction} {d_cm:.1f} cm so với mặt đất (ngưỡng {thresh_cm:.0f} cm)"

    return Finding(
        error_type=ErrorType.FLOATING,
        rule="floating",
        severity=severity,
        frame=cuboid.frame,
        label=cuboid.label,
        track_id=cuboid.track_id,
        source_id=cuboid.source_id,
        message=message,
        value=float(d),
        threshold=float(thresh),
        details={
            "distance": d,
            "ground_z": est.ground_z,
            "bottom_z": cuboid.bottom_z,
            "num_inliers": est.num_inliers,
            "num_ground_points": est.num_ground_points,
        },
    )


def detect_floating(
    cuboids: Sequence[Cuboid],
    points: np.ndarray,
    config: FloatingConfig,
    seed: int | None = 42,
) -> list[Finding]:
    """Phát hiện lỗi lơ lửng / lún đất trên danh sách box của một frame."""
    findings: list[Finding] = []
    for cuboid in cuboids:
        finding = detect_floating_for_box(cuboid, points, config, seed=seed)
        if finding is not None:
            findings.append(finding)
    return findings


SWEEP_BOX_MARGIN_M = 0.3
"""Bỏ điểm sweep nằm trong box nội suy nới 30 cm: vật đang chạy không để lại vệt thân xe quanh box."""


def _yaw_of(matrix: np.ndarray) -> float:
    return math.atan2(matrix[1, 0], matrix[0, 0])


def _boxes_at(alpha: float, previous: dict, current: dict) -> list[Cuboid]:
    """Vị trí box tại thời điểm giữa frame trước (`alpha` = 0) và frame hiện tại (`alpha` = 1), hệ frame hiện tại."""
    boxes = []
    for key in set(previous) | set(current):
        a, b = previous.get(key), current.get(key)
        if a is None or b is None:
            boxes.append(a or b)
            continue
        center = tuple(np.asarray(a.center) + (np.asarray(b.center) - np.asarray(a.center)) * alpha)
        yaw = a.yaw + math.remainder(b.yaw - a.yaw, 2 * math.pi) * alpha
        boxes.append(b.replace(center=center, yaw=yaw))
    return boxes


def static_sweep_points(
    frames, frame: int, boxes: Sequence[Cuboid], previous_boxes: Sequence[Cuboid], sweeps: int,
) -> np.ndarray:
    """Điểm các lượt quét trung gian trước `frame` (hệ của frame), đã bỏ điểm của mọi vật có box.

    Vị trí box tại thời điểm từng sweep được nội suy tuyến tính giữa box ở frame trước (đổi sang hệ frame hiện tại bằng
    pose xe thu) và box ở frame hiện tại; vật chỉ có ở một trong hai frame thì dùng box đó. Không có pose hay frame
    trước thì dùng box của frame hiện tại.
    """
    chunks = frames.ground_sweeps(frame, sweeps)
    if not chunks:
        return np.empty((0, 3))
    now = frames.frame_data(frame, with_points=False)
    current = {(b.track_id if b.track_id is not None else ("shape", i)): b for i, b in enumerate(boxes)}
    previous: dict = {}
    t_prev = None
    if previous_boxes and now.sensor_to_world is not None:
        before = frames.frame_data(frame - 1, with_points=False)
        if before.sensor_to_world is not None and before.timestamp is not None and now.timestamp is not None:
            to_now = invert_pose(now.sensor_to_world) @ before.sensor_to_world
            turn = _yaw_of(to_now)
            for b in previous_boxes:
                if b.track_id is not None:
                    center = tuple(to_now[:3, :3] @ np.asarray(b.center) + to_now[:3, 3])
                    previous[b.track_id] = b.replace(center=center, yaw=b.yaw + turn)
            t_prev = before.timestamp
    kept = []
    for timestamp, points in chunks:
        if t_prev is not None and now.timestamp is not None and now.timestamp > t_prev:
            alpha = min(1.0, max(0.0, (timestamp - t_prev) / (now.timestamp - t_prev)))
            moving = _boxes_at(alpha, previous, current)
        else:
            moving = list(boxes)
        keep = np.ones(len(points), dtype=bool)
        for box in moving:
            reach = max(box.dims[:2]) + SWEEP_BOX_MARGIN_M
            near = np.flatnonzero((np.abs(points[:, 0] - box.center[0]) <= reach)
                                  & (np.abs(points[:, 1] - box.center[1]) <= reach))
            if len(near):
                keep[near[points_in_cuboid(points[near], box, margin=SWEEP_BOX_MARGIN_M)]] = False
        kept.append(points[keep])
    return np.concatenate(kept)


def estimate_scene_ground(
    cuboids: Iterable[Cuboid], frames: FrameSource, config: FloatingConfig,
) -> list[tuple[Cuboid, GroundEstimate]]:
    """Mặt đất sát từng box tiếp đất (không `outside`); đọc point cloud mỗi frame một lần.

    `config.sweeps` > 0 và nguồn frame có `ground_sweeps` (nuScenes, bản xuất CVAT): gộp thêm các lượt quét LiDAR trung
    gian trước keyframe, đã bỏ điểm của vật theo vị trí box nội suy, để vành đai quanh box có nhiều điểm mặt đất hơn
    (mặt đất v2).
    """
    classes = set(config.classes)
    use_sweeps = config.sweeps > 0 and hasattr(frames, "ground_sweeps")
    by_frame = group_by_frame(c for c in cuboids if c.visible)
    # Sweep chỉ lặp lại các chỗ keyframe đã thấy: giữ yêu cầu bằng chứng tương đương keyframe (theo mật độ điểm).
    min_points = config.min_ground_points * (1 + config.sweeps) if use_sweeps else config.min_ground_points
    results: list[tuple[Cuboid, GroundEstimate]] = []
    for frame, boxes in by_frame.items():
        if not any(b.label in classes for b in boxes):
            continue
        points = np.asarray(frames.frame_data(frame).points, dtype=np.float64)[:, :3]
        if use_sweeps:
            extra = static_sweep_points(frames, frame, boxes, by_frame.get(frame - 1, []), config.sweeps)
            points = np.concatenate([points, extra])
        cloud = OtherBoxPoints(points, boxes)
        for index, box in enumerate(boxes):
            if box.label in classes:
                results.append((box, ring_ground_for_box(
                    cloud.without_others(index, reach=math.hypot(box.length / 2 + config.ring_outer_m,
                                                               box.width / 2 + config.ring_outer_m)), box,
                    ring_inner_m=config.ring_inner_m,
                    ring_outer_m=config.ring_outer_m, min_ground_points=min_points,
                )))
    return results


def _describe(d: float) -> str:
    if d >= 0:
        return f"Đáy box cách mặt đất {d * 100:.0f} cm (lơ lửng)"
    return f"Đáy box nằm dưới mặt đất {-d * 100:.0f} cm (lún)"


SLOPE_NOTE_DEG = 1.5
"""Mặt đường dốc dọc thân box từ mức này thì ghi thêm vào finding: box không nghiêng theo dốc trông "méo" so với xe."""


def _slope_note(box: Cuboid, est: GroundEstimate) -> str:
    if est.pitch_deg is None or abs(est.pitch_deg) < SLOPE_NOTE_DEG:
        return ""
    end = "đầu" if est.pitch_deg > 0 else "đuôi"
    half = box.length / 2 * math.tan(math.radians(abs(est.pitch_deg)))
    return (f". Mặt đường dốc {abs(est.pitch_deg):.1f}° dọc thân box ({end} box phía cao): box không nghiêng theo dốc "
            f"nên hai đầu lệch mặt đường ±{half * 100:.0f} cm, xe trông lệch so với box ở mặt cắt dọc")


def floating_findings_by_track(
    estimates: Sequence[tuple[Cuboid, GroundEstimate]], config: FloatingConfig,
) -> list[Finding]:
    """Luật lơ lửng / lún so với các frame khác của track.

    - Cảnh báo nếu `|d − trung vị d của peer| > warning_m`; Lỗi nếu `> error_m` và `|d| > error_min_abs_m`.
      Chỉ gộp box đang xét vào trung vị khi nhóm địa hình đã chọn có dưới 3 peer; phép so contact cũng chỉ gộp
      box đang xét khi toàn track có dưới 3 peer đo được.
    - Box lẻ, hoặc track có ít hơn `min_track_boxes` box khác đo được: so `|d|` với `single_warning_m` / `single_error_m`.
    - Box không đủ điểm mặt đất: không kết luận, gộp một mục Thông tin cho mỗi track.
    - Track đi qua mặt dốc (C4): ưu tiên các peer có độ lệch trung vị–tiếp xúc tương đương nếu đủ peer. Không trộn
      reference đường bằng và dốc làm che box lơ lửng; vẫn so trung vị ground, không bật báo tuyệt đối theo mọi plane.
      Bỏ báo khi so điểm tiếp xúc với reference cũng không lệch.
    """
    by_track: dict[tuple[int, str], list[int]] = defaultdict(list)
    for i, (box, est) in enumerate(estimates):
        if box.track_id is not None and est.is_valid:
            by_track[(box.track_id, box.label)].append(i)

    def contact_or_distance(j: int) -> float:
        est = estimates[j][1]
        return float(est.contact_distance if est.contact_distance is not None else est.distance)

    def terrain_bias(j: int) -> float:
        return float(estimates[j][1].distance) - contact_or_distance(j)

    findings: list[Finding] = []
    no_evidence: dict[tuple[int | None, str], list[Cuboid]] = defaultdict(list)
    for i, (box, est) in enumerate(estimates):
        if not est.is_valid:
            no_evidence[(box.track_id, box.label)].append(box)
            continue
        d = float(est.distance)
        peers = [j for j in by_track.get((box.track_id, box.label), []) if j != i]
        comparable = [j for j in peers if abs(terrain_bias(j) - terrain_bias(i)) <= config.warning_m]
        use_profile = len(comparable) >= config.min_track_boxes and len(comparable) < len(peers)
        if use_profile:
            peers = comparable
        others = [estimates[j][1].distance for j in peers]
        details = {"distance": d, "ground_z": est.ground_z, "bottom_z": box.bottom_z,
                   "num_ground_points": est.num_ground_points, "pitch_deg": est.pitch_deg,
                   "curb_step_m": est.curb_step_m, "curb_surface_near_bottom": est.is_curb_supported}
        if len(others) >= config.min_track_boxes:
            # Only a small peer set needs self-inclusion; larger sets keep their original sensitivity.
            reference = float(np.median([d, *others] if len(others) < 3 else others))
            offset = d - reference
            details["track_median_distance"] = reference
            absolute_distance = contact_or_distance(i) if use_profile else d
            details["reference_frames"] = [estimates[j][0].frame for j in ([i, *peers] if len(others) < 3 else peers)]
            details["terrain_reference"] = use_profile
            details["contact_distance"] = est.contact_distance
            # Dung sai áp lên độ lệch so với track, không lên |d| tuyệt đối: box sát đất trong track lệch đều 20 cm
            # vẫn là bước nhảy độ cao giữa các frame, phải báo để người duyệt xem.
            if abs(offset) <= config.ground_tolerance_m:
                continue
            if abs(offset) > config.error_m and abs(absolute_distance) > config.error_min_abs_m:
                severity, threshold = Severity.ERROR, config.error_m
            elif abs(offset) > config.warning_m:
                severity, threshold = Severity.WARNING, config.warning_m
            else:
                continue
            peers_all = [j for j in by_track.get((box.track_id, box.label), []) if j != i]
            if est.contact_distance is not None or any(estimates[j][1].contact_distance is not None for j in peers_all):
                on_contact = contact_or_distance(i) - float(np.median([
                    contact_or_distance(j) for j in ([i, *peers_all] if len(peers_all) < 3 else peers_all)]))
                if abs(on_contact) <= config.warning_m:
                    continue  # lệch chỉ do track đi từ đường bằng lên dốc (hoặc ngược lại)
            # Một mặt cao ở cạnh box không chứng minh đáy box chạm vật. Giữ bằng chứng lệch theo track;
            # dùng thông tin bậc vỉa hè để người duyệt đối chiếu, không bỏ lỗi đã đo được.
            direction = "cao hơn" if offset > 0 else "thấp hơn"
            grounded = abs(absolute_distance) <= config.ground_tolerance_m
            details["ground_tolerance_m"] = config.ground_tolerance_m
            details["box_touches_ground"] = grounded
            reference_note = " (kể cả box này)" if len(others) < 3 else ""
            if grounded:
                message = (f"Box này chạm đất (cách mặt đất {absolute_distance * 100:+.0f} cm); "
                           f"các frame khác của track lệch {reference * 100:+.0f} cm so với mặt đất{reference_note} "
                           f"(chênh {abs(offset) * 100:.0f} cm). Kiểm tra các frame khác{_slope_note(box, est)}")
            else:
                message = (f"{_describe(absolute_distance)}; {direction} {abs(offset) * 100:.0f} cm so với các frame khác của track "
                           f"(trung vị {reference * 100:+.0f} cm){reference_note}{_slope_note(box, est)}")
            value = offset
        elif not config.single_box:
            continue  # không đủ frame cùng track để so: không kết luận theo độ cao tuyệt đối
        else:
            # Không có track để so: so tuyệt đối, nên dùng điểm tiếp xúc trên mặt phẳng dốc nếu có (C4) — trên dốc trung vị
            # ở tâm box lệch với đáy box đúng spec tan(dốc) × nửa chiều dài box.
            if est.is_curb_supported:
                continue  # đỗ gác bánh vỉa hè / lề đường
            if est.contact_distance is not None:
                d = float(est.contact_distance)
                details["distance"] = d
                details["contact_plane"] = True
            if abs(d) <= config.ground_tolerance_m:
                continue
            if abs(d) > config.single_error_m:
                severity, threshold = Severity.ERROR, config.single_error_m
            elif abs(d) > config.single_warning_m:
                severity, threshold = Severity.WARNING, config.single_warning_m
            else:
                continue
            message = _describe(d) + _slope_note(box, est)
            value = d
        findings.append(Finding(
            error_type=ErrorType.FLOATING, rule="floating", severity=severity, frame=box.frame, label=box.label,
            track_id=box.track_id, source_id=box.source_id, message=message, value=float(value),
            threshold=float(threshold), details=details,
        ))

    for (track_id, _label), boxes in no_evidence.items():
        groups = [[b] for b in boxes] if track_id is None else [boxes]
        for group in groups:
            first, frames = group[0], sorted(b.frame for b in group)
            where = f"frame {frames[0]}" if len(frames) == 1 else f"{len(frames)} frame ({frames[0]}–{frames[-1]})"
            findings.append(Finding(
                error_type=ErrorType.FLOATING, rule="floating.no_evidence", severity=Severity.INFO,
                frame=first.frame, label=first.label, track_id=first.track_id,
                source_id=first.source_id if len(group) == 1 else None,
                message=f"Thiếu bằng chứng mặt đất quanh box ở {where}: không kiểm được lơ lửng / lún",
                value=float(len(group)), details={"frames": frames},
            ))
    return findings


def detect_floating_scene(
    cuboids: Iterable[Cuboid], frames: FrameSource, config: FloatingConfig,
) -> list[Finding]:
    """Lơ lửng / lún trên cả job: ước lượng mặt đất từng box rồi so với các frame khác của track."""
    return floating_findings_by_track(estimate_scene_ground(cuboids, frames, config), config)


from pointsnap.detectors.base import BaseDetector


class FloatingDetector(BaseDetector):
    """Bộ phát hiện lỗi lơ lửng / lún đất trên toàn bộ scene/job."""

    rule_id = "floating"
    switch_key = "floating"

    def detect(self, ctx: DetectionContext) -> list[Finding]:
        if ctx.frames is None:
            return []
        return detect_floating_scene(ctx.cuboids, ctx.frames, ctx.config.floating)
