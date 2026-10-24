"""Box vẽ ngược đầu 180° trên **cả track**, kể cả xe đứng yên (luật `cam.face`; cấu hình `face`).

`heading.motion` chỉ biết đầu xe khi xe chạy (so hướng box với hướng chuyển động); xe đỗ cả cảnh mà vẽ ngược cả track thì
không luật nào khác thấy (`heading.flip` so các keyframe với nhau, cả track cùng ngược thì không có gì đổi). Ở đây hỏi
ảnh camera:

1. Mỗi keyframe xe nhìn thấy: chiếu box lên các ảnh (`core.camera`), chọn ảnh có khung chiếu cao nhất mà box nằm gần trọn
   trong ảnh, không bị box gần hơn che nhiều. Từ vị trí camera trong hệ box biết camera đang nhìn **mặt đầu** (camera nằm
   trong `max_view_deg` quanh trục đầu box theo hướng đã gán) hay **mặt đuôi** của box; nhìn ngang thì bỏ.
2. Cắt vùng xe, hỏi bộ phân loại 2D "đầu xe hay đuôi xe" (`vision.face_clip`, CLIP zero-shot).
3. Bỏ phiếu theo track: ảnh chắc thấy đầu xe (xác suất đầu xe ≥ `front_min`) hoặc chắc thấy đuôi xe (≤ `rear_max`) là
   một phiếu; thấy mặt ngược với mặt box chờ đợi là phiếu "ngược". Có ≥ `min_votes` phiếu ngược và chiếm ≥ `vote_ratio` số phiếu chắc chắn thì báo **một** mục cho cả
   track, gắn vào keyframe có phiếu ngược chắc nhất, kèm hướng đề xuất yaw + π cho mọi keyframe của track.

Mã luật không dùng tiền tố `heading.`: web/app.py tính lại / bỏ `target_yaw_sensor` của các luật `heading.*` theo
hướng chuyển động, mà xe đứng yên không có hướng chuyển động. Đề xuất sửa đi qua `details.proposed_yaw`
(`core.repair`) và `details.target_yaw_sensor` (`core.ghost`), như `fit.yaw`.

Đo trên nuScenes mini: docs/ket-qua/ket-qua-face.md (`scripts/eval_face.py`).
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Sequence

import numpy as np

from pointsnap.core.camera import covered_fraction, project_box
from pointsnap.core.geometry import invert_pose, normalize_angle, to_box_frame, validate_pose
from pointsnap.core.model import Cuboid, ErrorType, Finding, Severity, group_by_frame
from pointsnap.vision.face_clip import Crop

if TYPE_CHECKING:
    from pointsnap.core.camera import CameraView
    from pointsnap.core.config import FaceConfig
    from pointsnap.vision.face_clip import FaceClassifier


@dataclass(frozen=True, eq=False)
class FaceObservation:
    """Một keyframe nhìn thấy trên ảnh: camera nhìn mặt đầu (`expects_front`) hay đuôi box theo hướng đã gán; `view_deg`
    là góc giữa trục đầu box và hướng từ tâm box tới camera (0°: nhìn thẳng mặt đầu, 180°: thẳng mặt đuôi)."""

    box: Cuboid
    channel: str
    path: str
    crop: tuple[float, float, float, float]
    view_deg: float
    depth: float
    occlusion: float
    p_front: float | None = None
    inside_ratio: float = 1.0

    @property
    def expects_front(self) -> bool:
        return self.view_deg < 90.0

    @property
    def height_px(self) -> float:
        return self.crop[3] - self.crop[1]

    @property
    def p_reversed(self) -> float | None:
        """Xác suất box ngược đầu theo ảnh này: ảnh thấy mặt ngược với mặt box chờ đợi."""
        if self.p_front is None:
            return None
        return 1.0 - self.p_front if self.expects_front else self.p_front

    def flipped(self) -> FaceObservation:
        """Cùng ảnh, box quay 180° (khung chiếu không đổi, mặt chờ đợi đổi): dùng khi đánh giá."""
        box = self.box.replace(yaw=normalize_angle(self.box.yaw + math.pi))
        return replace(self, box=box, view_deg=180.0 - self.view_deg)


def view_angle_deg(box: Cuboid, sensor_to_world: np.ndarray, view: CameraView) -> float:
    """Góc (độ, 0–180) giữa trục đầu box và hướng từ tâm box tới camera, trong mặt phẳng ngang."""
    world_to_sensor = invert_pose(validate_pose(sensor_to_world))
    cam = world_to_sensor[:3, :3] @ np.asarray(view.camera_to_world)[:3, 3] + world_to_sensor[:3, 3]
    local = to_box_frame(cam[None], box)[0]
    return abs(math.degrees(math.atan2(local[1], local[0])))


def frame_observations(boxes: Sequence[Cuboid], sensor_to_world: np.ndarray | None, views: Sequence[CameraView],
                       cfg: FaceConfig, *, all_views: bool = False) -> list[FaceObservation]:
    """Chọn ảnh hợp lệ cao nhất; `all_views` giữ mọi ứng viên để eval chọn lại sau khi đổi ngưỡng."""
    if sensor_to_world is None or not views:
        return []
    projections = [[project_box(b, sensor_to_world, v) for b in boxes] for v in views]
    result: list[FaceObservation] = []
    for i, box in enumerate(boxes):
        if not (box.keyframe and box.visible and box.label in cfg.classes):
            continue
        best: FaceObservation | None = None
        for v, view in enumerate(views):
            proj = projections[v][i]
            if (proj is None or proj.inside_ratio < cfg.min_inside or proj.depth > cfg.max_depth_m
                    or proj.box[3] - proj.box[1] < cfg.min_box_px):
                continue
            angle = view_angle_deg(box, sensor_to_world, view)
            if cfg.max_view_deg < angle < 180.0 - cfg.max_view_deg:
                continue  # nhìn ngang: thấy hông xe, không phân biệt đầu / đuôi theo mặt đối diện camera
            nearer = [p.box for j, p in enumerate(projections[v]) if j != i and p is not None and p.depth < proj.depth - 0.5]
            occlusion = covered_fraction(proj.box, nearer)
            if occlusion > cfg.max_occlusion:
                continue
            candidate = FaceObservation(box, view.channel, str(view.path), proj.box, angle, proj.depth, occlusion,
                                        inside_ratio=proj.inside_ratio)
            if all_views:
                result.append(candidate)
            elif best is None or candidate.height_px > best.height_px:
                best = candidate
        if best is not None:
            result.append(best)
    return result


def classify(observations: Sequence[FaceObservation], classifier: FaceClassifier) -> list[FaceObservation]:
    """Điền `p_front` (mỗi ảnh đọc một lần)."""
    by_path: dict[str, list[int]] = defaultdict(list)
    for k, o in enumerate(observations):
        by_path[o.path].append(k)
    out = list(observations)
    from pathlib import Path

    for path, ks in by_path.items():
        probs = classifier.front_probability(Path(path), [Crop(observations[k].crop, observations[k].box.label) for k in ks])
        for k, p in zip(ks, probs):
            out[k] = replace(observations[k], p_front=float(p))
    return out


def collect_face_observations(cuboids: Sequence[Cuboid], frames, classifier: FaceClassifier, cfg: FaceConfig,
                              min_brightness: float = 0.0, *, missing_camera: list[int] | None = None) -> list[FaceObservation]:
    """Quan sát + xác suất đầu xe cho mọi keyframe xe nhìn thấy của job; bỏ frame ban đêm (trung vị độ sáng ảnh)."""
    from pointsnap.vision.detector2d import image_brightness

    observations: list[FaceObservation] = []
    for frame, boxes in sorted(group_by_frame(c for c in cuboids if c.visible).items()):
        if not any(b.keyframe and b.label in cfg.classes for b in boxes):
            continue
        views = list(frames.camera_views(frame))
        data = frames.frame_data(frame, with_points=False)
        if not views or data.sensor_to_world is None:
            if missing_camera is not None:
                missing_camera.append(frame)
            continue
        if min_brightness > 0 and float(np.median([image_brightness(v.path) for v in views])) < min_brightness:
            continue
        observations.extend(frame_observations(boxes, data.sensor_to_world, views, cfg))
    return classify(observations, classifier)


def _track_key(box: Cuboid):
    return ("track", box.track_id, box.label) if box.track_id is not None else ("shape", id(box))


@dataclass(frozen=True)
class TrackVote:
    reversed: list[FaceObservation]
    agreeing: list[FaceObservation]

    @property
    def ratio(self) -> float:
        total = len(self.reversed) + len(self.agreeing)
        return len(self.reversed) / total if total else 0.0


def track_votes(observations: Sequence[FaceObservation], cfg: FaceConfig) -> dict[object, TrackVote]:
    """Phiếu chắc chắn của từng track (đã lọc theo `max_view_deg`, `min_box_px` của cấu hình)."""
    groups: dict[object, tuple[list, list]] = defaultdict(lambda: ([], []))
    for o in observations:
        if (o.p_reversed is None or o.height_px < cfg.min_box_px
                or cfg.max_view_deg < o.view_deg < 180.0 - cfg.max_view_deg):
            continue
        if o.p_front >= cfg.front_min:
            sees_front = True
        elif o.p_front <= cfg.rear_max:
            sees_front = False
        else:
            continue
        rev, agree = groups[_track_key(o.box)]
        (rev if sees_front != o.expects_front else agree).append(o)
    return {k: TrackVote(r, a) for k, (r, a) in groups.items()}


def is_reversed(vote: TrackVote, cfg: FaceConfig) -> bool:
    return len(vote.reversed) >= cfg.min_votes and vote.ratio >= cfg.vote_ratio


def face_findings(observations: Sequence[FaceObservation], cfg: FaceConfig,
                  cuboids: Sequence[Cuboid] = ()) -> list[Finding]:
    """Một mục `cam.face` cho mỗi track mà đa số phiếu ảnh nói box ngược đầu."""
    tracks: dict[object, list[Cuboid]] = defaultdict(list)
    for c in cuboids:
        if c.keyframe and c.visible:
            tracks[_track_key(c)].append(c)
    findings: list[Finding] = []
    for key, vote in track_votes(observations, cfg).items():
        if not is_reversed(vote, cfg):
            continue
        anchor = max(vote.reversed, key=lambda o: (o.p_reversed, o.height_px))
        box = anchor.box
        severity = Severity.ERROR if len(vote.reversed) >= cfg.error_votes else Severity.WARNING
        proposed_yaw = normalize_angle(box.yaw + math.pi)
        members = sorted(tracks.get(key) or [o.box for o in vote.reversed + vote.agreeing], key=lambda b: b.frame)
        total = len(vote.reversed) + len(vote.agreeing)
        faces = "đuôi" if anchor.expects_front else "đầu"
        findings.append(Finding(
            error_type=ErrorType.HEADING, rule="cam.face", severity=severity, frame=box.frame, label=box.label,
            track_id=box.track_id, source_id=box.source_id, value=vote.ratio, threshold=cfg.vote_ratio,
            message=(f"Ảnh camera: {len(vote.reversed)}/{total} keyframe nhìn rõ thấy mặt ngược với đầu box (vd "
                     f"{anchor.channel} frame {box.frame} thấy {faces} xe ở mặt box {'đầu' if anchor.expects_front else 'đuôi'}, "
                     f"xác suất {anchor.p_reversed:.0%}): nghi vẽ ngược đầu cả track, quay mọi keyframe 180°"),
            details={
                "votes_reversed": len(vote.reversed), "votes_total": total,
                "frames_reversed": [o.box.frame for o in vote.reversed],
                "frames_agreeing": [o.box.frame for o in vote.agreeing],
                "cameras": list(dict.fromkeys(o.channel for o in vote.reversed)),
                "p_reversed": anchor.p_reversed, "view_deg": anchor.view_deg,
                "proposed_center": [float(v) for v in box.center], "proposed_yaw": proposed_yaw,
                "target_yaw_sensor": proposed_yaw,
                "proposed_yaws": {str(b.frame): normalize_angle(b.yaw + math.pi) for b in members},
            },
        ))
    return findings
