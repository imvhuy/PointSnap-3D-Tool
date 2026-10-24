"""Bộ phát hiện box vẽ lệch khỏi vật (việc C1).

Spec 4.2: box phải bao trọn toàn bộ vật thể, không dư thừa quá mức; không gán box khi vật quá ít điểm. Bốn luật:

1. `fit.empty`: vùng quanh box được LiDAR quét dày (đo được mặt đất) nhưng trong box không có điểm nào cao hơn mặt
   box (≤ `empty_max_points`), và box không đánh `occluded` → Cảnh báo (vẽ vào chỗ trống, hoặc vật bị che mà chưa
   đánh occluded; trên nhãn chuẩn có cả vật thấp / đổ chỉ để lại vài điểm sát đáy nên không để mức Lỗi). Box có ít điểm
   hơn `sparse_warning_points` → Cảnh báo "quá ít điểm" (tắt mặc định, chờ chốt P-009).
2. `fit.outside`: trong vùng box nới `outside_margin_m`, sau khi bỏ mặt đất và điểm của box khác, tỉ lệ điểm của vật
   nằm ngoài box cao hơn trung vị của các frame khác cùng track quá `outside_warning_ratio` → box nhỏ hoặc lệch.
3. `fit.loose`: mặt box quay về phía cảm biến (nhìn thấy được, không bị che) mà cách điểm gần nhất của vật hơn
   `loose_warning_m` và dư hơn các frame khác của track quá `loose_rise_m` → box dư. Chỉ xét box gần, nhiều điểm; mặt sau
   của vật vốn không có điểm nên không xét.
4. `fit.overlap`: hai box cùng frame chồng nhau (diện tích phần chung nhìn từ trên / diện tích box nhỏ hơn, và chồng
   theo chiều cao) > `overlap_warning` → nghi vẽ trùng một vật. Chỉ xét class trong `overlap_classes`; spec 4.3B cho
   phép người đứng sát nhau chồng box, xe kéo rơ-moóc chồng ở chỗ nối (`overlap_allowed_pairs`). Báo trên box nhỏ hơn.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from itertools import combinations
from typing import TYPE_CHECKING, Callable, Iterable, Sequence

import numpy as np

from pointsnap.core.box_points import BoxPointSet
from pointsnap.core.geometry import _clip_convex, footprint, polygon_area
from pointsnap.core.model import Cuboid, ErrorType, Finding, Severity

if TYPE_CHECKING:
    from pointsnap.core.config import Config, FitConfig
    from pointsnap.core.context import DetectionContext

FACE_NAMES = {(0, 1): "đầu", (0, -1): "đuôi", (1, 1): "bên trái", (1, -1): "bên phải"}


def _finding(rule: str, severity: Severity, box: Cuboid, message: str, value: float, threshold: float,
             details: dict) -> Finding:
    return Finding(error_type=ErrorType.FIT, rule=rule, severity=severity, frame=box.frame, label=box.label,
                   track_id=box.track_id, source_id=box.source_id, message=message, value=value,
                   threshold=threshold, details=details)


def empty_finding(item: BoxPointSet, cfg: FitConfig) -> Finding | None:
    box = item.box
    if box.attrs.get("occluded"):
        return None
    if item.raw_inside <= cfg.empty_max_points and item.ground_z is not None:
        return _finding("fit.empty", Severity.WARNING, box,
                        f"Box không có điểm LiDAR nào ({item.raw_inside} điểm): vẽ vào chỗ trống, hoặc vật bị che "
                        f"thì đánh dấu occluded", float(item.raw_inside), float(cfg.empty_max_points),
                        {"num_points": item.raw_inside})
    if cfg.sparse_warning_points and item.raw_inside < cfg.sparse_warning_points:
        return _finding("fit.empty", Severity.WARNING, box,
                        f"Box chỉ có {item.raw_inside} điểm LiDAR (< {cfg.sparse_warning_points}): spec 4.2 không "
                        f"nên gán box khi vật quá ít điểm", float(item.raw_inside), float(cfg.sparse_warning_points),
                        {"num_points": item.raw_inside})
    return None


@dataclass(frozen=True)
class OutsideMeasure:
    """Số đo của luật `fit.outside` cho một box: số điểm của vật, số điểm nằm ngoài box, phía và độ thò ra nhiều nhất."""

    box: Cuboid
    outside: int
    total: int
    side: str
    reach_m: float

    @property
    def ratio(self) -> float:
        return self.outside / self.total


def outside_measure(item: BoxPointSet, cfg: FitConfig) -> OutsideMeasure | None:
    """Đo điểm của vật nằm ngoài box; `None` nếu vật có ít hơn `outside_min_object_points` điểm."""
    total, outside = item.num_object_points, item.num_outside
    if total < cfg.outside_min_object_points:
        return None
    side, reach = "", 0.0
    if outside:
        out = item.local[~item.inside]
        half = np.asarray(item.box.dims) / 2.0
        excess = np.maximum(np.abs(out) - half, 0.0)
        axis = int(np.argmax(excess[:, :2].sum(axis=0)))
        sign = 1 if np.sum(np.sign(out[:, axis]) * excess[:, axis]) >= 0 else -1
        side, reach = FACE_NAMES[(axis, sign)], float(np.percentile(excess[:, axis], 90))
    return OutsideMeasure(item.box, outside, total, side, reach)


def outside_findings(measures: Sequence[OutsideMeasure], cfg: FitConfig) -> list[Finding]:
    """Luật `fit.outside`: tỉ lệ điểm của vật nằm ngoài box, **so với trung vị của các box khác cùng track**.

    Vật mang đồ, người đứng sát không có box, cây sát xe… làm tỉ lệ này cao đều trong cả track (đo trên 5 cảnh kiểm
    tra: gần như mọi báo nhầm thuộc vài track người đi bộ); keyframe bị co / dời lệch khác thường so với chính track
    mới là lỗi vẽ. Box lẻ hoặc track có ít hơn 2 box khác đo được thì so tỉ lệ tuyệt đối.
    """
    by_track: dict[tuple[int, str], list[float]] = {}
    for m in measures:
        if m.box.track_id is not None:
            by_track.setdefault((m.box.track_id, m.box.label), []).append(m.ratio)
    findings: list[Finding] = []
    for m in measures:
        if m.outside < cfg.outside_min_points:
            continue
        # Bỏ qua nếu độ thò ra quá nhỏ (< 20 cm): gương xe, ba-đờ-sốc cong hoặc điểm mặt đất sát mép
        if m.reach_m < 0.20 and m.outside < cfg.outside_min_points * 2:
            continue
        others = list(by_track.get((m.box.track_id, m.box.label), [])) if m.box.track_id is not None else []
        if others:
            others.remove(m.ratio)
        reference = float(np.median(others)) if len(others) >= 2 else 0.0
        excess = m.ratio - reference
        if excess <= cfg.outside_warning_ratio:
            continue
        if m.reach_m < 0.20 and excess <= cfg.outside_warning_ratio * 1.5:
            continue
        severity = Severity.ERROR if excess > cfg.outside_error_ratio else Severity.WARNING
        threshold = cfg.outside_error_ratio if excess > cfg.outside_error_ratio else cfg.outside_warning_ratio
        relative = f"; các frame khác của track: {reference:.0%}" if len(others) >= 2 else ""
        findings.append(_finding(
            "fit.outside", severity, m.box,
            f"{m.outside}/{m.total} điểm của vật ({m.ratio:.0%}) nằm ngoài box, nhiều nhất phía {m.side} "
            f"(tới {m.reach_m * 100:.0f} cm){relative}: box nhỏ hoặc lệch khỏi vật (ngưỡng {threshold:.0%})",
            excess, threshold, {"outside": m.outside, "total": m.total, "ratio": m.ratio, "track_median": reference,
                                "side": m.side, "reach_m": m.reach_m},
        ))
    return findings


def outside_finding(item: BoxPointSet, cfg: FitConfig) -> Finding | None:
    """`fit.outside` cho một box đứng riêng (so tỉ lệ tuyệt đối)."""
    measure = outside_measure(item, cfg)
    found = outside_findings([measure], cfg) if measure is not None else []
    return found[0] if found else None


def _occluded(points: np.ndarray, target: np.ndarray, own: np.ndarray, radius: float = 0.3) -> bool:
    """Đường từ cảm biến (gốc) tới `target` có bị điểm khác (ngoài vật) chắn không."""
    distance = float(np.linalg.norm(target))
    if distance < 1e-6:
        return False
    direction = target / distance
    along = points @ direction
    candidate = (along > 1.0) & (along < distance - 0.5)
    if not candidate.any():
        return False
    pts = points[candidate]
    perp = np.linalg.norm(pts - np.outer(along[candidate], direction), axis=1)
    blocking = perp < radius
    if own.size:
        blocking &= ~np.isin(np.flatnonzero(candidate), own)
    return int(blocking.sum()) >= 3


@dataclass(frozen=True)
class LooseMeasure:
    """Số đo của luật `fit.loose` cho một box: mặt nhìn thấy (không bị che) dư nhất so với điểm của vật."""

    box: Cuboid
    gap_m: float
    """Khoảng dư (m) của mặt dư nhất; 0 nếu không mặt nhìn thấy nào dư."""
    face: str
    num_points: int


def loose_measure(item: BoxPointSet, cfg: FitConfig, frame_points: np.ndarray | None = None) -> LooseMeasure | None:
    """Đo khoảng dư của box; `None` nếu box ngoài phạm vi luật (ít điểm, xa)."""
    box = item.box
    if item.num_object_points < cfg.loose_min_points or item.range_m > cfg.loose_max_range_m:
        return None
    half = np.asarray(box.dims) / 2.0
    inside = item.local[item.inside]
    if len(inside) < cfg.loose_min_points:
        return None
    worst = (0.0, "")
    for axis in (0, 1):
        for side in (1, -1):
            if side * item.sensor_local[axis] <= half[axis]:
                continue  # mặt này quay lưng về cảm biến
            extent = float(np.percentile(side * inside[:, axis], 98))
            max_reach = float(np.max(side * inside[:, axis]))
            # Nếu điểm xa nhất của vật đã vươn tới sát thành box (<= 35 cm),
            # chứng minh vật thể thực sự vươn tới đó (cản xe/đuôi xe có điểm), không coi mặt này bị dư
            if half[axis] - max_reach <= 0.35:
                continue
            gap = half[axis] - extent
            if gap <= worst[0]:
                continue
            if frame_points is not None:
                c, s = math.cos(box.yaw), math.sin(box.yaw)
                local = np.zeros(2)
                local[axis] = side * half[axis]
                face = np.array([box.center[0] + c * local[0] - s * local[1],
                                 box.center[1] + s * local[0] + c * local[1], box.center[2]])
                if _occluded(frame_points, face, np.empty(0, dtype=np.int64)):
                    continue
            worst = (gap, FACE_NAMES[(axis, side)])

    # Đo độ dư cả hai đầu đối diện: CHỈ BÁO KHI BOX BỊ PHÓNG TO QUÁ CỠ (x1.3) CẢ HAI ĐẦU
    # - Cụm điểm chiếm <= 80% chiều dài box (thừa >= 20% chiều dài)
    # - Tổng độ hở cả hai đầu >= 0.8m và mỗi đầu hở >= 0.35m
    # Với xe dài thực tế (xe buýt 18m, xe tải dài), cụm điểm chiếm > 85% chiều dài box nên không bao giờ báo nhầm
    if box.length >= 1.2 * box.width:
        extent_pos = float(np.percentile(inside[:, 0], 98))
        extent_neg = float(np.percentile(-inside[:, 0], 98))
        gap_pos = max(0.0, half[0] - extent_pos)
        gap_neg = max(0.0, half[0] - extent_neg)
        total_gap = gap_pos + gap_neg
        cluster_span = box.length - total_gap
        if (gap_pos >= 0.35 and gap_neg >= 0.35
                and total_gap >= max(cfg.loose_warning_m * 1.5, 0.8)
                and cluster_span <= 0.80 * box.length):
            half_gap = total_gap / 2.0
            if half_gap > worst[0]:
                worst = (half_gap, "đầu và đuôi")

    return LooseMeasure(box, worst[0], worst[1], int(len(inside)))



def loose_findings(measures: Sequence[LooseMeasure], cfg: FitConfig) -> list[Finding]:
    """Luật `fit.loose`: mặt dư > `loose_warning_m` **và** dư hơn trung vị các frame khác của track quá `loose_rise_m`.

    Vật có hình dạng đặc thù (thùng xe hở, cần cẩu) hoặc box vẽ rộng có chủ ý thì dư đều trong cả track; so với chính
    track thì hạ được ngưỡng tuyệt đối (0,5 → 0,4 m) mà không tăng báo nhầm. Box lẻ hoặc track có ít hơn 2 frame khác đo
    được thì so ngưỡng tuyệt đối.
    """
    by_track: dict[tuple[int, str], list[LooseMeasure]] = {}
    for m in measures:
        if m.box.track_id is not None:
            by_track.setdefault((m.box.track_id, m.box.label), []).append(m)
    findings: list[Finding] = []
    for m in measures:
        if m.gap_m <= cfg.loose_warning_m:
            continue
        others = [o.gap_m for o in by_track.get((m.box.track_id, m.box.label), []) if o.box.frame != m.box.frame]
        reference = float(np.median(others)) if len(others) >= 2 else None
        if reference is not None and m.gap_m - reference <= cfg.loose_rise_m:
            continue
        severity = Severity.ERROR if m.gap_m > cfg.loose_error_m else Severity.WARNING
        threshold = cfg.loose_error_m if m.gap_m > cfg.loose_error_m else cfg.loose_warning_m
        relative = f"; các frame khác của track dư {reference * 100:.0f} cm" if reference is not None else ""
        findings.append(_finding(
            "fit.loose", severity, m.box,
            f"Mặt {m.face} của box cách điểm gần nhất của vật {m.gap_m * 100:.0f} cm dù nhìn thấy rõ từ LiDAR{relative}: "
            f"box dư so với vật (ngưỡng {threshold * 100:.0f} cm)", m.gap_m, threshold,
            {"gap_m": m.gap_m, "face": m.face, "num_points": m.num_points, "track_median_m": reference}))
    return findings


def loose_finding(item: BoxPointSet, cfg: FitConfig, frame_points: np.ndarray | None = None) -> Finding | None:
    """`fit.loose` cho một box đứng riêng (chỉ so ngưỡng tuyệt đối)."""
    measure = loose_measure(item, cfg, frame_points)
    found = loose_findings([measure], cfg) if measure is not None else []
    return found[0] if found else None


def _overlap_ratio(a: Cuboid, b: Cuboid) -> float:
    z_overlap = min(a.top_z, b.top_z) - max(a.bottom_z, b.bottom_z)
    if z_overlap <= 0.3 * min(a.height, b.height):
        return 0.0
    origin = np.asarray(a.center[:2])
    fa, fb = footprint(a) - origin, footprint(b) - origin
    inter = polygon_area(_clip_convex(fa, fb))
    smaller = min(polygon_area(fa), polygon_area(fb))
    return inter / smaller if smaller > 0 else 0.0


def overlap_findings(
    boxes: Iterable[Cuboid], cfg: FitConfig, typed: Callable[[Cuboid], str] | None = None,
) -> list[Finding]:
    """Luật `fit.overlap`. `typed(box)` cho tên chi tiết `Class/thuộc tính phân loại` (vd `Vehicle/truck`) để cặp
    được phép có thể ghi theo tên chi tiết; mặc định chỉ dùng class."""
    allowed = {frozenset(p) for p in cfg.overlap_allowed_pairs}
    typed = typed or (lambda box: box.label)
    findings: list[Finding] = []
    active = sorted((b for b in boxes if b.visible), key=lambda b: (
        b.frame, b.track_id if b.track_id is not None else -1,
        b.source_id if b.source_id is not None else -1, b.label, b.center, b.dims, b.yaw,
    ))
    for a, b in combinations(active, 2):
        reach = (math.hypot(a.length, a.width) + math.hypot(b.length, b.width)) / 2.0
        if math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) > reach:
            continue
        if a.label not in cfg.overlap_classes or b.label not in cfg.overlap_classes:
            continue
        names_a, names_b = {a.label, typed(a)}, {b.label, typed(b)}
        if any(frozenset((x, y)) in allowed for x in names_a for y in names_b):
            continue
        ratio = _overlap_ratio(a, b)
        if ratio <= cfg.overlap_warning:
            continue
        small, other = (a, b) if a.length * a.width <= b.length * b.width else (b, a)
        severity = Severity.ERROR if ratio > cfg.overlap_error else Severity.WARNING
        threshold = cfg.overlap_error if ratio > cfg.overlap_error else cfg.overlap_warning
        who = f"track {other.track_id}" if other.track_id is not None else "box khác"
        findings.append(_finding("fit.overlap", severity, small,
                                 f"Box chồng {ratio:.0%} diện tích lên box {other.label} ({who}): nghi vẽ trùng một "
                                 f"vật hoặc hai box lấn nhau (ngưỡng {threshold:.0%})", ratio, threshold,
                                 {"other_track_id": other.track_id, "other_label": other.label}))
    return findings


def fit_findings_for_frame(
    items: Sequence[BoxPointSet], cfg: FitConfig, frame_points: np.ndarray | None,
    empty: bool = True, outside: bool = True, loose: bool = True,
) -> tuple[list[Finding], list[OutsideMeasure], list[LooseMeasure]]:
    """Luật box rỗng của một frame, cùng số đo cho luật điểm ngoài box và box dư (chốt sau khi có cả job:
    `outside_findings`, `loose_findings`). Box rỗng thì không xét hai luật kia."""
    findings: list[Finding] = []
    measures: list[OutsideMeasure] = []
    loose_measures: list[LooseMeasure] = []
    for item in items:
        if empty and (f := empty_finding(item, cfg)) is not None:
            findings.append(f)
            continue
        if outside and (m := outside_measure(item, cfg)) is not None:
            measures.append(m)
        if loose and (m := loose_measure(item, cfg, frame_points)) is not None:
            loose_measures.append(m)
    return findings, measures, loose_measures


from pointsnap.detectors.base import BaseDetector


class FitDetector(BaseDetector):
    """Bộ phát hiện lỗi khớp box với cụm điểm LiDAR (fit.empty, fit.outside, fit.loose, fit.overlap)."""

    rule_id = "fit.outside"
    name = "FitDetector"

    def is_enabled(self, config: Config) -> bool:
        r = config.rules
        return bool(r.fit_empty or r.fit_outside or r.fit_loose or r.fit_overlap)

    def detect(self, ctx: DetectionContext) -> list[Finding]:
        from pointsnap.core.box_points import box_point_sets

        r = ctx.config.rules
        cfg = ctx.config.fit
        findings: list[Finding] = []
        outside: list[OutsideMeasure] = []
        loose: list[LooseMeasure] = []

        visible_boxes = [c for c in ctx.cuboids if c.visible]
        from pointsnap.core.model import group_by_frame
        by_frame = group_by_frame(visible_boxes)

        for frame, boxes in by_frame.items():
            if r.fit_overlap:
                findings.extend(overlap_findings(boxes, cfg))

            if ctx.frames is None or not (r.fit_empty or r.fit_outside or r.fit_loose):
                continue

            points = ctx.get_points(frame)
            if points is None:
                continue

            items = box_point_sets(
                points,
                boxes,
                margin=cfg.outside_margin_m,
                clearance=cfg.ground_clearance_m,
                margin_rel=cfg.outside_margin_rel,
            )
            frame_findings, frame_outside, frame_loose = fit_findings_for_frame(
                items,
                cfg,
                points[:, :3],
                empty=r.fit_empty,
                outside=r.fit_outside,
                loose=r.fit_loose,
            )
            findings.extend(frame_findings)
            outside.extend(frame_outside)
            loose.extend(frame_loose)

        if r.fit_outside:
            findings.extend(outside_findings(outside, cfg))
        if r.fit_loose:
            findings.extend(loose_findings(loose, cfg))

        return findings

