"""Bộ quét kiểm tra chất lượng nhãn 3D (việc A5).

Nối các bộ phát hiện của `pointsnap.detectors` (lơ lửng / lún, kích thước, đứt track; từ C1 thêm sai hướng box và box
lệch khỏi vật) và điều phối việc quét một job (việc A6). `check_size_manual_ranges` / `check_size_in_track` là luật kích thước cũ của A5, giữ để tương thích.
"""

from __future__ import annotations

import dataclasses
from types import SimpleNamespace
from typing import Callable, Iterable, Sequence

import numpy as np

from pointsnap.adapters.cvat.reader import JobData
from pointsnap.core.box_points import box_point_sets
from pointsnap.core.config import Config
from pointsnap.core.model import (
    Cuboid,
    ErrorType,
    Finding,
    FrameSource,
    Severity,
    group_by_frame,
    group_by_track,
)
from pointsnap.detectors.attributes import detect_attribute_errors
from pointsnap.detectors.fit import fit_findings_for_frame, loose_findings, outside_findings, overlap_findings
from pointsnap.detectors.floating import detect_floating_scene
from pointsnap.detectors.static import detect_static_errors
from pointsnap.detectors.heading import detect_heading_track, heading_points_findings, heading_points_measure
from pointsnap.detectors.size import DIM_NAMES, detect_size, get_resolved_class_ranges, range_key

DetectorFn = Callable[[JobData, Config, FrameSource | None], list[Finding]]


def check_size_manual_ranges(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Kiểm tra kích thước các box thuộc class có khoảng giá trị thủ công (bus, trailer...)."""
    findings: list[Finding] = []
    ranges = config.size.manual_ranges

    for c in job.cuboids:
        if c.outside:
            continue
        cls_ranges = ranges.get(c.label)
        if not cls_ranges:
            continue

        dims_map = {"length": c.length, "width": c.width, "height": c.height}
        for dim_name, (min_v, max_v) in cls_ranges.items():
            val = dims_map[dim_name]
            dim_vi = {"length": "Chiều dài", "width": "Chiều rộng", "height": "Chiều cao"}[dim_name]
            if val < min_v:
                dev = min_v - val
                sev = Severity.ERROR if dev > 0.3 else Severity.WARNING
                findings.append(Finding(
                    error_type=ErrorType.SIZE,
                    rule="size.class_range",
                    severity=sev,
                    frame=c.frame,
                    label=c.label,
                    track_id=c.track_id,
                    source_id=c.source_id,
                    value=val,
                    threshold=min_v,
                    message=f"{dim_vi} ({val:.2f} m) nhỏ hơn ngưỡng tối thiểu ({min_v:.2f} m)",
                ))
            elif val > max_v:
                dev = val - max_v
                sev = Severity.ERROR if dev > 0.3 else Severity.WARNING
                findings.append(Finding(
                    error_type=ErrorType.SIZE,
                    rule="size.class_range",
                    severity=sev,
                    frame=c.frame,
                    label=c.label,
                    track_id=c.track_id,
                    source_id=c.source_id,
                    value=val,
                    threshold=max_v,
                    message=f"{dim_vi} ({val:.2f} m) vượt quá ngưỡng tối đa ({max_v:.2f} m)",
                ))

    return findings


def check_size_in_track(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Kiểm tra kích thước dao động bất thường trong cùng một track (kiểu 2)."""
    findings: list[Finding] = []
    cfg = config.size.in_track
    tracks = group_by_track(job.cuboids)

    for tid, boxes in tracks.items():
        active = [b for b in boxes if not b.outside]
        if len(active) < cfg.min_keyframes:
            continue
        first_box = active[0]
        if first_box.label in cfg.excluded_classes:
            continue

        lengths = np.array([b.length for b in active])
        widths = np.array([b.width for b in active])
        heights = np.array([b.height for b in active])

        med_l, med_w, med_h = float(np.median(lengths)), float(np.median(widths)), float(np.median(heights))

        for b in active:
            for dim_name, val, med in (("length", b.length, med_l), ("width", b.width, med_w), ("height", b.height, med_h)):
                diff = abs(val - med)
                rel = diff / max(med, 1e-4)
                dim_vi = {"length": "Chiều dài", "width": "Chiều rộng", "height": "Chiều cao"}[dim_name]

                is_err = diff > cfg.error_abs_m or rel > cfg.error_rel
                is_warn = diff > cfg.warning_abs_m or rel > cfg.warning_rel

                if is_err:
                    msg = f"{dim_vi} ({val:.2f} m) lệch lớn so với trung vị track ({med:.2f} m, lệch {diff*100:.0f} cm)"
                    if rel > cfg.suspect_id_rel:
                        msg += " — nghi nhầm ID"
                    findings.append(Finding(
                        error_type=ErrorType.SIZE,
                        rule="size.in_track",
                        severity=Severity.ERROR,
                        frame=b.frame,
                        label=b.label,
                        track_id=b.track_id,
                        source_id=b.source_id,
                        value=diff,
                        threshold=cfg.error_abs_m,
                        message=msg,
                    ))
                elif is_warn:
                    findings.append(Finding(
                        error_type=ErrorType.SIZE,
                        rule="size.in_track",
                        severity=Severity.WARNING,
                        frame=b.frame,
                        label=b.label,
                        track_id=b.track_id,
                        source_id=b.source_id,
                        value=diff,
                        threshold=cfg.warning_abs_m,
                        message=f"{dim_vi} ({val:.2f} m) lệch so với trung vị track ({med:.2f} m, lệch {diff*100:.0f} cm)",
                    ))

    return findings


def check_floating(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Lơ lửng / lún (B3, `detectors.floating`), so với các frame khác của track. Cần point cloud."""
    if frames is None:
        return []
    return detect_floating_scene(job.cuboids, frames, config.floating)


def check_size(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Sai kích thước theo class và trong track (B4, `detectors.size`)."""
    findings = detect_size(job.cuboids, config.size)
    if frames is not None:
        from pointsnap.detectors.size import relax_filled_oversize

        findings = relax_filled_oversize(findings, job.cuboids, frames, config.size.cargo_classes,
                                        class_key=lambda box: _typed_label(box, config))
    return findings


def _poses(job: JobData, frames: FrameSource | None):
    if frames is None:
        return None, None
    data = {f: frames.frame_data(f, with_points=False) for f in sorted({c.frame for c in job.cuboids})}
    sensor_to_world = {f: d.sensor_to_world for f, d in data.items() if d.sensor_to_world is not None} or None
    timestamps = {f: d.timestamp for f, d in data.items() if d.timestamp is not None} or None
    return sensor_to_world, timestamps


def check_heading(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Sai hướng box theo track (C1, `detectors.heading`): lật hướng giữa hai keyframe, lệch hướng chuyển động."""
    sensor_to_world, timestamps = _poses(job, frames)
    return detect_heading_track(job.cuboids, config.heading, config.track.keyframe_interval_s, sensor_to_world,
                                timestamps, flip=config.rules.heading_flip, motion=config.rules.heading_motion)


def _typed_label(box: Cuboid, config: Config) -> str:
    """`Class/giá trị thuộc tính phân loại` (size.key_attributes, vd `Vehicle/truck`), hoặc `Class` nếu không có."""
    attr = config.size.key_attributes.get(box.label)
    value = box.attrs.get(attr) if attr else None
    return f"{box.label}/{value}" if value not in (None, "") else box.label


def check_box_points(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Luật dựa trên điểm LiDAR của từng vật (C1): trục box so với cụm điểm, box rỗng / nhỏ / lệch / dư; box chồng nhau.

    Box chồng nhau không cần point cloud nên vẫn chạy khi không có `frames`.
    """
    r = config.rules
    findings: list[Finding] = []
    measures = []
    outside = []
    loose = []
    for frame, boxes in group_by_frame(c for c in job.cuboids if c.visible).items():
        if r.fit_overlap:
            findings.extend(overlap_findings(boxes, config.fit, typed=lambda b: _typed_label(b, config)))
        if frames is None or not (r.heading_points or r.fit_empty or r.fit_outside or r.fit_loose):
            continue
        points = frames.frame_data(frame).points
        items = box_point_sets(points, boxes, margin=config.fit.outside_margin_m,
                               clearance=config.fit.ground_clearance_m, margin_rel=config.fit.outside_margin_rel)
        frame_findings, frame_outside, frame_loose = fit_findings_for_frame(
            items, config.fit, points[:, :3], empty=r.fit_empty, outside=r.fit_outside, loose=r.fit_loose)
        findings.extend(frame_findings)
        outside.extend(frame_outside)
        loose.extend(frame_loose)
        if r.heading_points:
            measures.extend((item.box, dev) for item in items
                            if (dev := heading_points_measure(item, config.heading.points)) is not None)
    findings.extend(heading_points_findings(measures, config.heading.points))
    if r.fit_outside:
        findings.extend(outside_findings(outside, config.fit))
    if r.fit_loose:
        findings.extend(loose_findings(loose, config.fit))
    return findings


def check_static(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Box xoay của vật đứng yên trong hệ toàn cục (C3, `detectors.static`). Cần pose xe thu."""
    sensor_to_world, _ = _poses(job, frames)
    return detect_static_errors(job.cuboids, config.static, sensor_to_world, rotate=config.rules.heading_static)


_DETECTORS: dict = {}


def _detector(model: str = "maskrcnn"):
    if model not in _DETECTORS:
        from pointsnap.vision.detector2d import Detector2D

        _DETECTORS[model] = Detector2D(model=model)
    return _DETECTORS[model]


def check_camera(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Đối chiếu box 3D với ảnh camera (C3, `detectors.camera`). Cần ảnh camera và PyTorch; không có thì bỏ qua."""
    if frames is None or not hasattr(frames, "camera_views") or not config.camera.active():
        return []
    from pointsnap.detectors.camera import camera_findings, collect_observations

    r = config.rules
    effective = config.camera.effective_model()
    try:
        detector = _detector(effective)
        observations, missing = collect_observations(job.cuboids, frames, detector, config.camera)
        findings = camera_findings(observations,config.camera,mismatch=r.cam_mismatch,wrong_class=r.cam_class)
        if r.cam_sparse:
            from pointsnap.detectors.camera import sparse_unconfirmed
            findings += sparse_unconfirmed(job.cuboids,frames,detector,config.camera)
        findings += missing if r.cam_missing else []
        reason = getattr(detector,"fallback_reason",None)
        if config.camera.model == "hybrid" and effective != "hybrid":
            reason = "hybrid chỉ chạy COCO vì thiếu dependency DINO/SAM"
        if reason:
            findings.append(_camera_no_evidence(job,reason))
        return findings
    except (OSError, ImportError, RuntimeError) as exc:
        return [_camera_no_evidence(job,f"Model/ảnh camera chưa dùng được: {exc}")]


_SEGMENTERS: dict = {}


def box_fit_segmenter(config: Config, frames: FrameSource | None):
    """(SAM 2.1 cho `box_fit`, lý do lùi về LiDAR). Segmenter `None` nghĩa là đo bằng LiDAR: guideline chọn `lidar`, hoặc
    chọn `sam` mà thiếu ảnh camera / GPU / `transformers` (khi đó có lý do)."""
    if config.box_fit.source != "sam":
        return None, None
    from pointsnap.vision import prompted_sam

    if frames is None or not hasattr(frames, "camera_views") or not config.camera.active(backend="sam") or not prompted_sam.available():
        return None, "box_fit.source: sam cần ảnh camera, camera.enabled phù hợp, PyTorch và transformers; đo bằng LiDAR thay thế"
    return _SEGMENTERS.setdefault("sam2", prompted_sam.Sam2PromptSegmenter()), None


def check_box_fit(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Box lệch / xoay lệch vật đo bằng mét / độ (`detectors.box_fit`). Cần point cloud; `box_fit.source: sam` cần thêm
    ảnh camera, PyTorch và `transformers`, thiếu thì đo bằng LiDAR và ghi một mục Thông tin."""
    if frames is None:
        return []
    from pointsnap.detectors.box_fit import box_fit_findings, collect_fit_measures

    cfg = config.box_fit
    segmenter, reason = box_fit_segmenter(config, frames)
    notes = [_camera_no_evidence(job, reason)] if reason else []
    missing_camera: list[int] = []
    try:
        measures = collect_fit_measures(job.cuboids, frames, segmenter, cfg, config.camera.min_brightness,
                                        missing_camera=missing_camera)
    except (OSError, ImportError, RuntimeError) as exc:
        if segmenter is None:
            raise
        notes.append(_camera_no_evidence(job, f"SAM / ảnh camera cho fit.offset chưa dùng được, đo bằng LiDAR: {exc}"))
        measures = collect_fit_measures(job.cuboids, frames, None, cfg)
    if missing_camera:
        notes.append(_camera_no_evidence(job, f"fit.offset/fit.yaw thiếu ảnh hoặc pose ở frame {missing_camera}; "
                                              "đo bằng LiDAR thay thế tại các frame này"))
    from pointsnap.detectors.box_fit import size_off_track, track_dims, track_gate

    dims = track_dims(job.cuboids)
    in_track = config.size.in_track
    check = lambda box: size_off_track(box, dims, in_track.warning_abs_m, in_track.warning_rel)  # noqa: E731
    # Kiểm tra theo track cần pose từng frame (so trong hệ toàn cục); frame không có pose thì không kiểm tra.
    tracked = {b.frame for b in job.cuboids if b.track_id is not None and b.visible and b.keyframe}
    poses = {f: _frame_pose(frames, f) for f in sorted(tracked)}
    gate = track_gate(job.cuboids, measures, poses, cfg, size_check=check)
    return box_fit_findings(measures, cfg, offset=config.rules.fit_offset, yaw=config.rules.fit_yaw,
                            size_check=check, gate=gate) + notes


def _frame_pose(frames: FrameSource, frame: int):
    """Ma trận LiDAR → toàn cục của frame, không đọc point cloud nếu nguồn hỗ trợ; `None` nếu không có / đọc lỗi."""
    try:
        try:
            data = frames.frame_data(frame, with_points=False)
        except TypeError:  # nguồn frame không nhận with_points
            data = frames.frame_data(frame)
    except (OSError, KeyError, ValueError, IndexError):
        return None
    return getattr(data, "sensor_to_world", None)


_FACE_CLASSIFIERS: dict = {}


def check_face(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Box ngược đầu cả track theo ảnh camera (`detectors.face`, luật `cam.face`). Cần ảnh camera + pose, PyTorch và
    `transformers`; thiếu thì ghi một mục Thông tin."""
    from pointsnap.detectors.face import collect_face_observations, face_findings
    from pointsnap.vision import face_clip

    if not any(b.visible and b.keyframe and b.label in config.face.classes for b in job.cuboids):
        return []
    if frames is None or not hasattr(frames, "camera_views") or not config.camera.active(backend="face") or not face_clip.available():
        return [_camera_no_evidence(job, "cam.face cần ảnh camera, camera.enabled phù hợp, PyTorch và transformers")]
    classifier = _FACE_CLASSIFIERS.setdefault("clip", face_clip.ClipFaceClassifier())
    missing_camera: list[int] = []
    try:
        observations = collect_face_observations(job.cuboids, frames, classifier, config.face,
                                                 config.camera.min_brightness, missing_camera=missing_camera)
    except (OSError, ImportError, RuntimeError) as exc:
        return [_camera_no_evidence(job, f"Model đầu / đuôi xe (cam.face) chưa dùng được: {exc}")]
    notes = ([_camera_no_evidence(job, f"cam.face thiếu ảnh hoặc pose ở frame {missing_camera}; "
                                      "chưa kiểm được đầu/đuôi tại các frame này")] if missing_camera else [])
    return face_findings(observations, config.face, job.cuboids) + notes


def _camera_no_evidence(job, message: str) -> Finding:
    return Finding(error_type=ErrorType.FIT,rule="camera.no_evidence",severity=Severity.INFO,
                   frame=min((b.frame for b in job.cuboids),default=0),label="Camera",
                   message="Kiểm tra camera một phần: "+message)


def check_missing(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Sót đối tượng bằng LiDAR (C7, `detectors.missing`). Cần point cloud và pose xe thu."""
    if frames is None:
        return []
    from pointsnap.detectors.missing import detect_missing_objects

    use_camera = hasattr(frames,"camera_views") and config.camera.active()
    try:
        detector = _detector(config.camera.effective_model()) if use_camera else None
        findings = detect_missing_objects(job.cuboids,frames,config.missing,detector,config.camera)[0]
        reason = getattr(detector,"fallback_reason",None) if detector is not None else None
        if reason:
            findings.append(_camera_no_evidence(job,reason))
        return findings
    except (OSError,ImportError,RuntimeError) as exc:
        if not use_camera:
            raise
        # ponytail: recompute LiDAR on camera failure; split detector stages if this recovery becomes costly.
        findings = detect_missing_objects(job.cuboids,frames,config.missing,None,config.camera)[0]
        return findings+[_camera_no_evidence(job,f"Camera chưa xác nhận vật đứng yên: {exc}")]


def check_critic(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Box Critic (C3, lớp 3): chỉ chạy khi guideline khai `critic.model` và có PyTorch."""
    if frames is None or not config.critic.model:
        return []
    from pointsnap.critic import available

    if not available():
        return []
    from pointsnap.critic import critic_findings

    return critic_findings(job.cuboids, frames, config.critic)


def check_attributes(job: JobData, config: Config, frames: FrameSource | None = None) -> list[Finding]:
    """Thiếu / sai thuộc tính theo spec của dự án (C2, `detectors.attributes`)."""
    from pointsnap.detectors.attributes import detect_attribute_height, detect_rider_state, detect_spec_geometry

    sensor_to_world, timestamps = _poses(job, frames)
    return (detect_attribute_errors(job.cuboids, config.spec) + detect_attribute_height(job.cuboids, config.spec)
            + detect_spec_geometry(job.cuboids, config.spec)
            + detect_rider_state(job.cuboids, config.spec, sensor_to_world, config.track.keyframe_interval_s, timestamps))


_RULE_SWITCH = {
    "attr.missing": "attr_missing", "attr.invalid": "attr_invalid", "attr.height": "attr_height",
    "spec.inside": "spec_inside", "spec.rider_double": "spec_rider_double", "lidar.missing": "lidar_missing",
    "attr.rider_state": "attr_rider_state", "cam.sparse": "cam_sparse",
    "heading.static": "heading_static",
    "cam.mismatch": "cam_mismatch", "cam.class": "cam_class", "cam.missing": "cam_missing",
    "fit.offset": "fit_offset", "fit.yaw": "fit_yaw", "cam.face": "cam_face",
    "critic.box": "critic_box",
    "heading.flip": "heading_flip", "heading.motion": "heading_motion", "heading.points": "heading_points",
    "fit.empty": "fit_empty", "fit.outside": "fit_outside", "fit.loose": "fit_loose", "fit.overlap": "fit_overlap",
}


def is_rule_enabled(rule: str, config: Config) -> bool:
    """Kiểm tra một rule có được bật trong config.rules không."""
    if rule in ("floating", "floating.no_evidence"):
        return bool(config.rules.floating)
    if rule in ("size.class_range", "size.manual_range"):
        return bool(config.rules.size_class_range)
    if rule in ("size.in_track", "size.in_track_manual"):
        return bool(config.rules.size_in_track)
    switch = _RULE_SWITCH.get(rule)
    return True if switch is None else bool(getattr(config.rules, switch))


DEFAULT_DETECTORS: Sequence[DetectorFn] = (
    check_floating,
    check_size,
    check_heading,
    check_box_points,
    check_attributes,
    check_static,
    check_camera,
    check_box_fit,
    check_face,
    check_critic,
    check_missing,
)


def scan_cuboids(
    job: JobData | Iterable[Cuboid],
    config: Config,
    frames: FrameSource | None = None,
    detectors: Sequence[DetectorFn] | None = None,
) -> list[Finding]:
    """Chạy toàn bộ các bộ phát hiện trên các box của job (hoặc danh sách box) và trả về danh sách finding.

    `frames` cung cấp point cloud và pose theo frame (`ManifestFrames` khi quét job CVAT, `NuScenesFrames` khi quét
    thẳng nuScenes).
    """
    if not hasattr(job, "cuboids"):
        job = SimpleNamespace(cuboids=list(job))

    if detectors is not None:
        active_detectors = list(detectors)
    else:
        active_detectors = []
        r = config.rules
        if r.floating:
            active_detectors.append(check_floating)
        if r.size_class_range or r.size_in_track:
            active_detectors.append(check_size)
        if r.heading_flip or r.heading_motion:
            active_detectors.append(check_heading)
        if r.heading_points or r.fit_empty or r.fit_outside or r.fit_loose or r.fit_overlap:
            active_detectors.append(check_box_points)
        if (r.attr_missing or r.attr_invalid or r.attr_height or r.spec_inside or r.spec_rider_double
                or r.attr_rider_state):
            active_detectors.append(check_attributes)
        if r.heading_static:
            active_detectors.append(check_static)
        if r.cam_mismatch or r.cam_class or r.cam_missing or r.cam_sparse:
            active_detectors.append(check_camera)
        if r.fit_offset or r.fit_yaw:
            active_detectors.append(check_box_fit)
        if r.cam_face:
            active_detectors.append(check_face)
        if r.critic_box:
            active_detectors.append(check_critic)
        if r.lidar_missing:
            active_detectors.append(check_missing)

    from pointsnap.core.context import DetectionContext
    from pointsnap.detectors.base import BaseDetector

    ctx = DetectionContext.from_job(job, config, frames)
    findings: list[Finding] = []
    for detector in active_detectors:
        if isinstance(detector, BaseDetector):
            findings.extend(detector(ctx))
        else:
            findings.extend(detector(job, config, frames))

    filtered = [f for f in findings if is_rule_enabled(f.rule, config)]
    filtered = apply_evidence_gate(filtered, job.cuboids, config, frames)
    return sorted(filtered, key=lambda f: f.sort_key())


def apply_evidence_gate(
    findings: list[Finding], cuboids: Iterable[Cuboid], config: Config, frames: FrameSource | None,
) -> list[Finding]:
    """Hạ Cảnh báo / Lỗi của các luật trong `config.evidence.rules` xuống Thông tin khi box (ở frame của finding) có ít hơn
    `evidence.min_points` điểm của vật. Mục size cấp track chỉ chuyển sang keyframe đủ điểm trong cùng nhóm range_key;
    khi cả nhóm không đủ điểm thì hạ Thông tin. Mục theo từng box giữ nguyên frame."""
    gate = config.evidence
    if gate.min_points <= 0 or frames is None:
        return findings
    targets = [i for i, f in enumerate(findings)
               if f.rule in gate.rules and f.severity in (Severity.WARNING, Severity.ERROR)]
    if not targets:
        return findings
    cuboids = [c for c in cuboids if c.visible]
    by_frame = group_by_frame(cuboids)
    frame_counts: dict[int, dict[tuple[tuple[str, int], str], int]] = {}
    ranges = get_resolved_class_ranges(config.size)
    class_key = lambda box: range_key(box, config.size, ranges)  # noqa: E731

    def owner(item) -> tuple[str, int] | None:
        if item.track_id is not None:
            return ("track", item.track_id)
        if item.source_id is not None:
            return ("shape", item.source_id)
        # A finding without either ID cannot be linked to a particular standalone shape.
        return None

    def count(frame: int, key: tuple[str, int] | None, label: str) -> int | None:
        if key is None:
            return None
        if frame not in frame_counts:
            boxes = by_frame.get(frame, [])
            items = box_point_sets(frames.frame_data(frame).points, boxes, margin=config.fit.outside_margin_m,
                                   clearance=config.fit.ground_clearance_m,
                                   margin_rel=config.fit.outside_margin_rel) if boxes else []
            frame_counts[frame] = {(identity, item.box.label): item.num_object_points for item in items
                                   if (identity := owner(item.box)) is not None}
        return frame_counts[frame].get((key, label))

    result = list(findings)
    for i in targets:
        f = findings[i]
        n = count(f.frame, owner(f), f.label)
        if n is None or n >= gate.min_points:
            continue
        if f.rule == "size.class_range" and f.track_id is not None and "keyframes" in (f.details or {}):
            moved, n = _reanchor_track_finding(f, cuboids, gate.min_points, count, n, class_key)
            if moved is not None:
                result[i] = moved
                continue
        result[i] = dataclasses.replace(
            f, severity=Severity.INFO,
            message=f"Ít điểm LiDAR ({n} điểm, cần ≥ {gate.min_points}): chưa đủ bằng chứng để kết luận. {f.message}",
            details={**(f.details or {}), "evidence_points": n, "evidence_severity": f.severity.value},
        )
    return result


def _reanchor_track_finding(
    f: Finding, cuboids: Sequence[Cuboid], min_points: int,
    count: Callable[[int, tuple[str, int] | None, str], int | None], anchor_points: int,
    class_key: Callable[[Cuboid], str],
) -> tuple[Finding | None, int]:
    """Choose a supported keyframe within the detector's class/subtype group, worst dimension then nearest first."""
    details = f.details or {}
    anchors = [c for c in cuboids if c.keyframe and c.track_id == f.track_id and c.label == f.label
               and c.frame == f.frame]
    key = details.get("range_key") or (class_key(anchors[0]) if len(anchors) == 1 else None)
    boxes = [c for c in cuboids if c.visible and c.keyframe and c.track_id == f.track_id and c.label == f.label
             and c.frame != f.frame and key is not None and class_key(c) == key]
    axis = DIM_NAMES.index(details["dimension"]) if details.get("dimension") in DIM_NAMES else None
    sign = -1.0 if details.get("bound_type") == "lớn" else 1.0

    def order(c: Cuboid) -> tuple[float, float]:
        return (sign * c.dims[axis] if axis is not None else 0.0, float(np.hypot(c.center[0], c.center[1])))

    best = anchor_points
    for box in sorted(boxes, key=order):
        n = count(box.frame, ("track", box.track_id), box.label)
        if n is None:
            continue
        best = max(best, n)
        if n >= min_points:
            return dataclasses.replace(f, frame=box.frame, source_id=box.source_id,
                                       details={**details, "evidence_points": n, "evidence_moved_from": f.frame}), n
    return None, best


def scan_coverage_gaps(job: JobData, config: Config, frames: FrameSource | None) -> list[str]:
    """Thiếu dữ liệu cho các luật đang bật; không coi nguồn frame có mặt là đã đủ pose.

    Kiểm tra bảo thủ ở cấp job; không chứng nhận độ chính xác của detector hay mọi box.
    Lỗi đọc frame được chuyển cho caller để lần quét thất bại, không trả ĐẠT.
    """
    cloud_rules = ("floating", "heading_points", "fit_empty", "fit_outside", "fit_loose", "critic_box", "fit_offset",
                   "fit_yaw")
    pose_rules = ("heading_flip", "heading_motion", "attr_rider_state", "heading_static")
    gaps: list[str] = []
    enabled_cloud = [name for name in cloud_rules if getattr(config.rules, name)
                     and (name != "critic_box" or config.critic.model)]
    explicit_camera = (((config.rules.fit_offset or config.rules.fit_yaw) and config.box_fit.source == "sam")
                       or config.rules.cam_face)
    camera_rules = (any(getattr(config.rules,name) for name in ("cam_mismatch","cam_class","cam_missing","cam_sparse"))
                    or explicit_camera)
    if camera_rules and (config.camera.enabled == "true" or explicit_camera):
        backends = []
        if any(getattr(config.rules, name) for name in ("cam_mismatch", "cam_class", "cam_missing", "cam_sparse")):
            backends.append("detector2d")
        if config.rules.cam_face:
            backends.append("face")
        if (config.rules.fit_offset or config.rules.fit_yaw) and config.box_fit.source == "sam":
            backends.append("sam")
        if any(not config.camera.active(backend=backend) for backend in backends):
            gaps.append("Kiểm tra một phần: thiếu runtime model camera đã bật")
        if frames is None or not hasattr(frames,"camera_views"):
            gaps.append("Kiểm tra một phần: thiếu ảnh/calibration camera đã bật")
        else:
            visible_frames = sorted({c.frame for c in job.cuboids if c.visible and c.keyframe})
            missing_views = [f for f in visible_frames if not frames.camera_views(f)]
            missing_pose = [f for f in visible_frames if frames.frame_data(f,with_points=False).sensor_to_world is None]
            if missing_views or missing_pose:
                gaps.append(f"Kiểm tra một phần: thiếu ảnh/pose camera ở {len(set(missing_views+missing_pose))} frame")
    if config.rules.critic_box and config.critic.model and any(c.visible and c.keyframe for c in job.cuboids):
        from pointsnap.critic import available
        if not available():
            gaps.append("Kiểm tra một phần: thiếu PyTorch cho luật critic_box")
    if frames is None and enabled_cloud and any(c.visible for c in job.cuboids):
        gaps.append("Kiểm tra một phần: thiếu point cloud cho luật " + ", ".join(enabled_cloud))
    elif frames is not None and enabled_cloud:
        visible_frames = sorted({c.frame for c in job.cuboids if c.visible})
        empty = [frame for frame in visible_frames if len(frames.frame_data(frame, with_points=True).points) == 0]
        if empty:
            gaps.append(f"Kiểm tra một phần: point cloud rỗng ở {len(empty)} frame cho luật " + ", ".join(enabled_cloud))

    enabled_pose = [name for name in pose_rules if getattr(config.rules, name)
                    and (name != "attr_rider_state" or (config.spec.rider_state and any(
                        c.visible and c.label == config.spec.rider_state["class"] for c in job.cuboids)))]
    tracked_frames = sorted({c.frame for c in job.cuboids if c.visible and c.track_id is not None})
    if enabled_pose and tracked_frames:
        missing = [frame for frame in tracked_frames
                   if frames is None or frames.frame_data(frame, with_points=False).sensor_to_world is None]
        if missing:
            gaps.append(f"Kiểm tra một phần: thiếu pose ở {len(missing)} frame cho luật " + ", ".join(enabled_pose))
    return gaps

def actionable(findings: Iterable[Finding]) -> list[Finding]:
    """Finding mức Lỗi / Cảnh báo: những mục được gắn cờ lên CVAT và tính ở `gate`."""
    return [f for f in findings if f.severity is not Severity.INFO]
