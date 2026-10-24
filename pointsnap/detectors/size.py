"""Bộ phát hiện sai kích thước (việc B4).

Hai kiểu phát hiện:
1. Kiểu 1 (`size.class_range`): So sánh (l, w, h) với khoảng [p1, p99] của class (`warning_margin` /
   `error_margin` trong config). Track được xét bằng **trung vị kích thước** của nó và báo tối đa một mục cho cả
   track (A10): kích thước theo class là thuộc tính của đối tượng, keyframe lẻ lệch do kiểu 2 bắt.
2. Kiểu 2 (`size.in_track`): Kích thước một keyframe lệch so với trung vị của track.
   - Bỏ qua class người đi bộ (pedestrian).
   - Cảnh báo nếu lệch > max(10 cm, 5%).
   - Lỗi nếu lệch > max(30 cm, 15%).
   - Lệch > 30%: ghi chú "nghi nhầm ID".
"""

from __future__ import annotations

import dataclasses
from collections import defaultdict
import math
from typing import TYPE_CHECKING, Callable, Iterable, Mapping, Sequence

import numpy as np

from pointsnap.core.model import Cuboid, ErrorType, Finding, Severity

if TYPE_CHECKING:
    from pointsnap.core.config import SizeConfig

DIM_NAMES = ("length", "width", "height")
DIM_VI = {"length": "chiều dài", "width": "chiều rộng", "height": "chiều cao"}

# Thống kê phân vị [p1, p99] tính từ 5 cảnh tinh chỉnh nuScenes v1.0-mini
DEFAULT_CLASS_RANGES: dict[str, dict[str, tuple[float, float]]] = {
    "car": {"length": (3.48, 5.76), "width": (1.60, 2.38), "height": (1.40, 2.30)},
    "truck": {"length": (4.54, 10.20), "width": (1.79, 2.88), "height": (1.72, 3.96)},
    "bus": {"length": (6.91, 13.82), "width": (2.56, 3.52), "height": (2.81, 3.61)},
    "trailer": {"length": (1.79, 14.01), "width": (2.17, 2.33), "height": (3.31, 3.89)},
    "construction_vehicle": {"length": (3.71, 7.56), "width": (2.11, 3.02), "height": (2.03, 2.92)},
    "pedestrian": {"length": (0.37, 1.04), "width": (0.43, 0.98), "height": (1.35, 2.00)},
    "motorcycle": {"length": (1.81, 2.40), "width": (0.56, 1.20), "height": (1.34, 1.93)},
    "bicycle": {"length": (1.34, 2.07), "width": (0.43, 0.93), "height": (1.03, 1.93)},
    "traffic_cone": {"length": (0.30, 0.64), "width": (0.29, 1.21), "height": (0.51, 1.31)},
    "barrier": {"length": (0.40, 0.76), "width": (1.79, 3.59), "height": (0.89, 1.34)},
}


def compute_class_ranges(
    cuboids: Iterable[Cuboid],
    percentile_low: float = 1.0,
    percentile_high: float = 99.0,
    min_instances: int = 20,
    manual_ranges: Mapping[str, Mapping[str, tuple[float, float]]] | None = None,
) -> dict[str, dict[str, tuple[float, float]]]:
    """Tính khoảng kích thước [p_low, p_high] cho từng class từ tập box.

    Class có ít hơn `min_instances` box sẽ dùng `manual_ranges`.
    """
    by_label: dict[str, list[tuple[float, float, float]]] = {}
    for c in cuboids:
        if not c.outside:
            by_label.setdefault(c.label, []).append(c.dims)

    ranges: dict[str, dict[str, tuple[float, float]]] = {}
    for label, dims_list in by_label.items():
        if len(dims_list) < min_instances and manual_ranges and label in manual_ranges:
            ranges[label] = dict(manual_ranges[label])
            continue

        arr = np.array(dims_list)
        class_dict = {}
        for idx, dim_name in enumerate(DIM_NAMES):
            p_lo = float(np.percentile(arr[:, idx], percentile_low))
            p_hi = float(np.percentile(arr[:, idx], percentile_high))
            class_dict[dim_name] = (p_lo, p_hi)
        ranges[label] = class_dict

    # Bổ sung các class có trong manual_ranges nếu tập box chưa có
    if manual_ranges:
        for label, m_dict in manual_ranges.items():
            if label not in ranges:
                ranges[label] = dict(m_dict)

    return ranges


def get_resolved_class_ranges(
    config: SizeConfig,
    custom_ranges: Mapping[str, Mapping[str, tuple[float, float]]] | None = None,
) -> dict[str, dict[str, tuple[float, float]]]:
    """Kết hợp default ranges, thống kê `class_range.stats` và `manual_ranges` trong config (sau ghi đè trước)."""
    resolved = {label: dict(dim_dict) for label, dim_dict in DEFAULT_CLASS_RANGES.items()}
    for label, stats_dict in config.class_range.stats.items():
        resolved.setdefault(label, {}).update(stats_dict)
    if config.manual_ranges:
        for label, manual_dict in config.manual_ranges.items():
            resolved.setdefault(label, {}).update(manual_dict)
    if custom_ranges:
        for label, c_dict in custom_ranges.items():
            resolved.setdefault(label, {}).update(c_dict)
    return resolved


def range_key(cuboid: Cuboid, config: SizeConfig, class_ranges: Mapping[str, object]) -> str:
    """Khóa tra khoảng kích thước: `Class/giá trị thuộc tính phân loại` nếu guideline khai báo (spec 3.1.2, vd
    `Vehicle/bus`, `Two-wheels/with_rider`) và có khoảng cho khóa đó; ngược lại là `Class`."""
    attr = config.key_attributes.get(cuboid.label)
    value = cuboid.attrs.get(attr) if attr else None
    if value not in (None, ""):
        key = f"{cuboid.label}/{value}"
        if key in class_ranges:
            return key
    return cuboid.label


def detect_size_class_range_for_box(
    cuboid: Cuboid,
    config: SizeConfig,
    class_ranges: Mapping[str, Mapping[str, tuple[float, float]]],
) -> list[Finding]:
    """Kiểm tra kiểu 1: kích thước bất thường so với class (hoặc class + thuộc tính phân loại)."""
    key = range_key(cuboid, config, class_ranges)
    if not cuboid.visible or not cuboid.keyframe or key not in class_ranges:
        return []

    c_cfg = config.class_range
    warn_m = c_cfg.warning_margin
    err_m = c_cfg.error_margin

    ranges = class_ranges[key]
    findings: list[Finding] = []

    for dim_name, val in zip(DIM_NAMES, cuboid.dims):
        if dim_name not in ranges:
            continue
        p_lo, p_hi = ranges[dim_name]

        warn_min = p_lo * (1.0 - warn_m)
        warn_max = p_hi * (1.0 + warn_m)
        err_min = p_lo * (1.0 - err_m)
        err_max = p_hi * (1.0 + err_m)

        severity: Severity | None = None
        threshold: float | None = None
        bound_type: str = ""

        if val < err_min:
            severity = Severity.ERROR
            threshold = err_min
            bound_type = "nhỏ"
        elif val > err_max:
            severity = Severity.ERROR
            threshold = err_max
            bound_type = "lớn"
        elif val < warn_min:
            severity = Severity.WARNING
            threshold = warn_min
            bound_type = "nhỏ"
        elif val > warn_max:
            severity = Severity.WARNING
            threshold = warn_max
            bound_type = "lớn"

        if severity is not None and threshold is not None:
            vi_name = DIM_VI[dim_name]
            msg = (
                f"{vi_name.capitalize()} {val:.2f} m {bound_type} bất thường so với class {key} "
                f"(khoảng chuẩn [{p_lo:.2f}, {p_hi:.2f}] m)"
            )
            findings.append(
                Finding(
                    error_type=ErrorType.SIZE,
                    rule="size.class_range",
                    severity=severity,
                    frame=cuboid.frame,
                    label=cuboid.label,
                    track_id=cuboid.track_id,
                    source_id=cuboid.source_id,
                    message=msg,
                    value=float(val),
                    threshold=float(threshold),
                    details={
                        "dimension": dim_name,
                        "class_range": (p_lo, p_hi),
                        "range_key": key,
                        "bound_type": bound_type,
                    },
                )
            )

    return findings


def detect_size_in_track(
    track_boxes: Sequence[Cuboid],
    config: SizeConfig,
) -> list[Finding]:
    """Kiểm tra kiểu 2: dao động kích thước trong cùng track."""
    if not track_boxes:
        return []

    label = track_boxes[0].label
    t_cfg = config.in_track

    # Bỏ qua class người đi bộ do tư thế thay đổi
    if label in t_cfg.excluded_classes:
        return []

    # Lọc các box hợp lệ (không outside)
    active_boxes = [b for b in track_boxes if b.visible and b.keyframe]
    if len(active_boxes) < t_cfg.min_keyframes:
        return []

    dims_arr = np.array([b.dims for b in active_boxes])
    medians = np.median(dims_arr, axis=0)  # (length_med, width_med, height_med)

    findings: list[Finding] = []

    for b in active_boxes:
        for idx, (dim_name, val, med) in enumerate(zip(DIM_NAMES, b.dims, medians)):
            diff = abs(val - med)
            rel = diff / med if med > 0 else 0.0

            warn_thresh = max(t_cfg.warning_abs_m, t_cfg.warning_rel * med)
            err_thresh = max(t_cfg.error_abs_m, t_cfg.error_rel * med)

            severity: Severity | None = None
            threshold: float | None = None

            if diff > err_thresh:
                severity = Severity.ERROR
                threshold = err_thresh
            elif diff > warn_thresh:
                severity = Severity.WARNING
                threshold = warn_thresh

            if severity is not None and threshold is not None:
                vi_name = DIM_VI[dim_name]
                suspect_note = ""
                if rel > t_cfg.suspect_id_rel:
                    suspect_note = " (lệch > 30%, nghi nhầm ID)"

                msg = (
                    f"{vi_name.capitalize()} {val:.2f} m lệch {diff:.2f} m ({rel*100:.1f}%) "
                    f"so với trung vị track ({med:.2f} m){suspect_note}"
                )
                findings.append(
                    Finding(
                        error_type=ErrorType.SIZE,
                        rule="size.in_track",
                        severity=severity,
                        frame=b.frame,
                        label=b.label,
                        track_id=b.track_id,
                        source_id=b.source_id,
                        message=msg,
                        value=float(diff),
                        threshold=float(threshold),
                        details={
                            "dimension": dim_name,
                            "median": float(med),
                            "relative_diff": float(rel),
                            "suspect_id": bool(rel > t_cfg.suspect_id_rel),
                        },
                    )
                )

    return findings


def _worst(findings: Sequence[Finding]) -> Finding | None:
    """Finding nặng nhất: mức Lỗi trước, rồi vượt ngưỡng nhiều nhất (tương đối)."""
    def excess(f: Finding) -> float:
        return abs(f.value - f.threshold) / max(abs(f.threshold), 1e-6) if f.value is not None and f.threshold else 0.0

    return min(findings, key=lambda f: (f.severity.rank, -excess(f)), default=None)


def detect_size_class_range_for_track(
    track_boxes: Sequence[Cuboid],
    config: SizeConfig,
    class_ranges: Mapping[str, Mapping[str, tuple[float, float]]],
) -> list[Finding]:
    """Kiểu 1 cho cả track: xét trung vị kích thước, báo một mục gắn vào keyframe lệch nhiều nhất."""
    active = sorted((b for b in track_boxes if b.visible and b.keyframe),
                    key=lambda b: (b.frame, b.source_id if b.source_id is not None else -1))
    if not active:
        return []
    median_dims = tuple(float(v) for v in np.median(np.array([b.dims for b in active]), axis=0))
    worst = _worst(detect_size_class_range_for_box(active[0].replace(dims=median_dims), config, class_ranges))
    if worst is None:
        return []
    dim_index = DIM_NAMES.index(worst.details["dimension"])
    pick = max if worst.details["bound_type"] == "lớn" else min
    box = pick(active, key=lambda b: b.dims[dim_index])
    message = worst.message
    if len(active) > 1:
        message = message.replace(" m ", f" m (trung vị của {len(active)} keyframe) ", 1)
    return [dataclasses.replace(worst, frame=box.frame, source_id=box.source_id, message=message,
                                details={**worst.details, "keyframes": len(active)})]


def detect_size(
    cuboids: Sequence[Cuboid],
    config: SizeConfig,
    class_ranges: Mapping[str, Mapping[str, tuple[float, float]]] | None = None,
) -> list[Finding]:
    """Phát hiện lỗi kích thước (cả kiểu 1 và kiểu 2) trên tập box.

    Kiểu 1: box lẻ xét từng box (mục nặng nhất), track xét theo trung vị (một mục mỗi track).
    Kiểu 2: mỗi keyframe tối đa một mục (chiều lệch nặng nhất).
    """
    resolved_ranges = get_resolved_class_ranges(config, class_ranges)
    cuboids = [c for c in cuboids if c.visible and c.keyframe]
    findings: list[Finding] = []
    # Không trộn baseline của các class/subtype khác nhau trong cùng track.
    tracks: dict[tuple[int, str], list[Cuboid]] = defaultdict(list)
    for cuboid in cuboids:
        if cuboid.track_id is not None:
            tracks[(cuboid.track_id, range_key(cuboid, config, resolved_ranges))].append(cuboid)

    # Kiểu 1: theo class
    for c in cuboids:
        if c.track_id is None:
            worst = _worst(detect_size_class_range_for_box(c, config, resolved_ranges))
            findings.extend([worst] if worst else [])
    for track_boxes in tracks.values():
        findings.extend(detect_size_class_range_for_track(track_boxes, config, resolved_ranges))

    # Kiểu 2: theo track, một mục mỗi keyframe
    for track_boxes in tracks.values():
        per_box: dict[int, list[Finding]] = {}
        for f in detect_size_in_track(track_boxes, config):
            per_box.setdefault(f.frame, []).append(f)
        findings.extend(_worst(items) for items in per_box.values())

    return findings

FILLED_END_GAP = 0.075
"""Điểm của vật phải chạm tới cách mỗi đầu của chiều bị vượt không quá 7,5% chiều đó (chiều cao: chỉ xét đỉnh)."""
FILLED_BINS = 10
FILLED_OCCUPANCY = 0.8
"""… và phủ liên tục: ≥ 80% trong 10 đoạn đều nhau dọc chiều đó có điểm (chiều cao: bỏ 0,3 m sát đáy, nơi điểm mặt đất
đã bị bỏ). Box phóng to nuốt cột / cây bên cạnh thì chạm được hai đầu nhưng để trống đoạn giữa."""


def relax_filled_oversize(findings: Sequence[Finding], cuboids: Sequence[Cuboid], frames, cargo_classes: Sequence[str],
                          max_frames: int = 3, *, class_key: Callable[[Cuboid], str] | None = None) -> list[Finding]:
    """C5: mục `size.class_range` mức Lỗi "lớn bất thường" mà điểm LiDAR của vật trải kín chiều đó → hạ Cảnh báo.

    Chỉ cho class hay chở hàng (`cargo_classes`, vd xe máy chở hàng cồng kềnh, box gồm cả hàng theo spec 4.3C):
    kích thước vượt class nhưng đúng với vật. Box bị phóng to so với vật thì điểm không phủ kín nên vẫn là Lỗi. Thử
    trên mọi class thì người đứng cạnh cột, ô tô cạnh bụi cây bị phóng to vẫn "phủ kín" (lẫn điểm vật bên cạnh).
    """
    from pointsnap.core.box_points import box_point_sets

    # A subtype needs an explicit key resolver; arbitrary notes are not a classification.
    class_key = class_key or (lambda box: box.label)

    by_frame: dict[int, list[Cuboid]] = {}
    for c in cuboids:
        if c.visible:
            by_frame.setdefault(c.frame, []).append(c)
    out = []
    for f in findings:
        owners = [c for c in cuboids if c.visible and c.keyframe and c.frame == f.frame and c.label == f.label
                  and (c.track_id == f.track_id if f.track_id is not None else c.source_id == f.source_id)]
        owner = owners[0] if len(owners) == 1 else None
        cargo = owner is not None and any(key in (owner.label, class_key(owner)) for key in cargo_classes)
        if (f.rule != "size.class_range" or f.severity is not Severity.ERROR
                or f.details.get("bound_type") != "lớn" or not cargo):
            out.append(f)
            continue
        axis = DIM_NAMES.index(f.details["dimension"])
        boxes = [c for c in cuboids if c.visible and c.keyframe and c.label == owner.label
                 and class_key(c) == class_key(owner)
                 and (c.track_id == f.track_id if f.track_id is not None else c is owner)]
        boxes = sorted(boxes, key=lambda c: math.hypot(c.center[0], c.center[1]))[:max_frames]
        filled, gap_seen = False, 1.0
        for box in boxes:
            frame_boxes = by_frame.get(box.frame, [])
            index = next(i for i, c in enumerate(frame_boxes) if c is box)
            item = box_point_sets(frames.frame_data(box.frame).points, frame_boxes, margin=0.5, clearance=0.25,
                                  margin_rel=0.25)[index]
            pts = item.local[item.inside]
            if len(pts) < 20:
                continue
            size, half = box.dims[axis], box.dims[axis] / 2
            lo, hi = np.percentile(pts[:, axis], [2, 98])
            gaps = [half - hi] if axis == 2 else [half - hi, lo + half]  # chiều cao: điểm sát đất đã bị bỏ
            gap = max(gaps) / size
            start = -half + 0.3 if axis == 2 else -half
            counts, _ = np.histogram(pts[:, axis], bins=FILLED_BINS, range=(start, half))
            gap_seen = min(gap_seen, gap)
            filled |= gap <= FILLED_END_GAP and float(np.mean(counts > 0)) >= FILLED_OCCUPANCY
        if filled:
            out.append(dataclasses.replace(
                f, severity=Severity.WARNING,
                message=(f"{f.message}; điểm LiDAR của vật trải kín chiều này: có thể vật chở hàng / hình dạng đặc "
                         f"biệt, kiểm tra lại"),
                details={**f.details, "points_end_gap": gap_seen}))
        else:
            out.append(f)
    return out
