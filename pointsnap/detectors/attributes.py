"""Bộ phát hiện thiếu / sai thuộc tính theo guideline của dự án (việc C2).

Spec 3.1.3: attribute là bắt buộc nếu object thuộc phạm vi attribute (vd `Vehicle` phải có `subtype`, `Pedestrian`
phải có `age_group` và `pose`, `Two-wheels` phải có `rider_state`). Hai luật, đều mức Lỗi:

1. `attr.missing`: box thuộc class có trong `spec.required_attributes` mà thiếu thuộc tính hoặc để trống.
2. `attr.invalid`: giá trị thuộc tính không nằm trong danh sách `spec.allowed_values` của thuộc tính đó (khóa
   `Label.thuộc_tính` cho riêng một class, hoặc `thuộc_tính` dùng chung).

Mỗi track (hoặc box lẻ) báo tối đa một mục cho mỗi thuộc tính, gắn vào keyframe đầu tiên bị sai, kèm số keyframe sai.
Cấu hình rỗng (mặc định, nhãn nuScenes không có thuộc tính) thì không báo gì.

Luật bám spec theo hình học (C6, mức Cảnh báo):

3. `attr.height`: thuộc tính không khớp chiều cao box (`spec.attribute_height`), vd `pose=standing` (người lớn) mà box
   cao 1,3 m, `rider_state=without_rider` mà box cao 1,8 m. Xét trung vị chiều cao của từng đoạn liền cùng giá trị thuộc
   tính trong track. Ngưỡng đo trên nhãn chuẩn nuScenes (spec-vn): người lớn đứng 1,56–2,00 m, ngồi 1,28–1,52 m, trẻ em
   1,33–1,49 m; xe hai bánh có người 1,56–1,93 m, không người 0,95–1,53 m.
4. `spec.inside` (spec 4.3B: không gán người bên trong xe): tâm box vật trong nằm trong footprint box vật bao, đáy không
   cao hơn đáy vật bao `inside_min_lift_m` (người đứng trên nóc / thùng xe vẫn được).
5. `spec.rider_double` (spec 4.3C: người lái nằm trong box xe hai bánh): box người chồng ≥ 50% footprint lên box xe
   `with_rider` cùng frame — người lái bị gán hai lần.
6. `attr.rider_state` (C8, spec 4.3C: lên / xuống xe phải đổi `rider_state`): xe ghi `without_rider` mà chạy nhanh hơn
   `rider_max_speed_mps` ở ≥ 2 bước liền (quên đổi khi lên xe; trên nhãn chuẩn nuScenes xe không người chạy tối đa
   1,0 m/s, có người thường > 2 m/s); hoặc xe `with_rider` đứng yên mà một track người mới bắt đầu sát xe (≤ 1,2 m)
   và xe vẫn ghi `with_rider` ≥ 2 keyframe sau đó (quên đổi khi xuống xe).
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import TYPE_CHECKING, Iterable, Sequence

import numpy as np

from pointsnap.core.geometry import _clip_convex, footprint, polygon_area
from pointsnap.core.model import Cuboid, ErrorType, Finding, Severity, group_by_frame, group_by_track

if TYPE_CHECKING:
    from pointsnap.core.config import SpecConfig


def _problems(box: Cuboid, cfg: SpecConfig) -> list[tuple[str, str, str]]:
    """[(luật, thuộc tính, giá trị)] của một box."""
    found = []
    for name in cfg.required_attributes.get(box.label, ()):
        value = box.attrs.get(name)
        if value is None or str(value).strip() == "":
            found.append(("attr.missing", name, ""))
    for name, value in box.attrs.items():
        allowed = allowed_values_for(box.label, name, cfg)
        if allowed is None or value is None or str(value).strip() == "":
            continue
        if str(value) not in allowed:
            found.append(("attr.invalid", name, str(value)))
    return found


def allowed_values_for(label: str, name: str, cfg: SpecConfig) -> tuple[str, ...] | None:
    """Danh sách giá trị cho phép của thuộc tính `name` ở class `label`: khóa `Label.thuộc_tính` ưu tiên hơn khóa
    `thuộc_tính` dùng chung; `None` nếu guideline không giới hạn giá trị."""
    return cfg.allowed_values.get(f"{label}.{name}", cfg.allowed_values.get(name))


def detect_attribute_errors(cuboids: Iterable[Cuboid], cfg: SpecConfig) -> list[Finding]:
    groups: dict[tuple, list[Cuboid]] = defaultdict(list)
    for box in sorted((c for c in cuboids if not c.outside and c.keyframe), key=lambda c: c.frame):
        for rule, name, value in _problems(box, cfg):
            owner = box.track_id if box.track_id is not None else ("shape", box.frame, box.source_id, id(box))
            groups[(owner, box.label, rule, name, value)].append(box)
    findings: list[Finding] = []
    for (_, _label, rule, name, value), boxes in groups.items():
        first = boxes[0]
        where = f"{len(boxes)} keyframe, từ frame {first.frame}" if len(boxes) > 1 else f"frame {first.frame}"
        if rule == "attr.missing":
            message = f"{first.label} thiếu thuộc tính bắt buộc `{name}` ({where}); spec 3.1.3: không chắc thì chọn other"
        else:
            allowed = ", ".join(allowed_values_for(first.label, name, cfg) or ())
            message = f"Thuộc tính `{name}` = '{value}' không có trong danh sách cho phép ({allowed}) ({where})"
        findings.append(Finding(
            error_type=ErrorType.ATTRIBUTE, rule=rule, severity=Severity.ERROR, frame=first.frame, label=first.label,
            track_id=first.track_id, source_id=first.source_id, message=message, value=float(len(boxes)),
            details={"attribute": name, "value": value, "frames": [b.frame for b in boxes]},
        ))
    return findings


# --- C6: luật bám spec theo hình học ---------------------------------------------------------------------------


def _matches(box: Cuboid, key: str, cfg: SpecConfig | None = None) -> bool:
    """`key` = `Class` hoặc `Class/giá trị[/giá trị…]`: box đúng class và mang đủ các giá trị thuộc tính."""
    parts = key.split("/")
    if box.label != parts[0]:
        return False
    names = None
    if cfg is not None:
        names = set(cfg.required_attributes.get(box.label, ()))
        for name in cfg.allowed_values:
            owner, separator, attribute = name.partition(".")
            if not separator:
                names.add(name)
            elif owner == box.label:
                names.add(attribute)
        names = names or None  # legacy custom rules without an attribute schema
    values = {str(v) for name, v in box.attrs.items() if names is None or name in names}
    return all(p in values for p in parts[1:])


def _best_key(box: Cuboid, keys: Iterable[str], cfg: SpecConfig | None = None) -> str | None:
    found = [k for k in keys if _matches(box, k, cfg)]
    return max(found, key=lambda k: k.count("/")) if found else None


def detect_attribute_height(cuboids: Iterable[Cuboid], cfg: SpecConfig) -> list[Finding]:
    """`attr.height`: mỗi đoạn liền cùng khóa thuộc tính trong track (hoặc box lẻ), trung vị chiều cao ngoài khoảng."""
    if not cfg.attribute_height:
        return []
    findings: list[Finding] = []
    boxes = [c for c in cuboids if c.visible and c.keyframe]
    runs: list[list[Cuboid]] = []
    for tid, track in group_by_track(boxes).items():
        current: list[Cuboid] = []
        for box in sorted(track, key=lambda b: b.frame):
            if current and _best_key(box, cfg.attribute_height, cfg) != _best_key(current[0], cfg.attribute_height, cfg):
                runs.append(current)
                current = []
            current.append(box)
        if current:
            runs.append(current)
    runs += [[c] for c in boxes if c.track_id is None]
    for run in runs:
        key = _best_key(run[0], cfg.attribute_height, cfg)
        if key is None:
            continue
        lo, hi = cfg.attribute_height[key]
        height = float(np.median([b.height for b in run]))
        if lo <= height <= hi:
            continue
        first = run[0]
        values = ", ".join(f"{k}={v}" for k, v in first.attrs.items() if isinstance(v, str) and v in key.split("/"))
        where = f"frame {first.frame}" if len(run) == 1 else f"{len(run)} keyframe ({first.frame}–{run[-1].frame})"
        findings.append(Finding(
            error_type=ErrorType.ATTRIBUTE, rule="attr.height", severity=Severity.WARNING, frame=first.frame,
            label=first.label, track_id=first.track_id, source_id=first.source_id, value=height,
            threshold=lo if height < lo else hi,
            message=(f"{first.label} có {values} nhưng box cao {height:.2f} m, ngoài khoảng hợp lý [{lo:.2f}, {hi:.2f}] m "
                     f"({where}): kiểm tra lại thuộc tính hoặc chiều cao box"),
            details={"key": key, "height_m": height, "range": (lo, hi), "frames": [b.frame for b in run]},
        ))
    return findings


def _footprint_contains(outer: Cuboid, x: float, y: float, margin: float = 0.0) -> bool:
    c, s = math.cos(outer.yaw), math.sin(outer.yaw)
    dx, dy = x - outer.center[0], y - outer.center[1]
    lx, ly = c * dx + s * dy, -s * dx + c * dy
    return abs(lx) <= outer.length / 2 - margin and abs(ly) <= outer.width / 2 - margin


def _overlap_fraction(small: Cuboid, big: Cuboid) -> float:
    """Exact clipped footprint area, using the same geometry primitive as fit.overlap."""
    origin = np.asarray(big.center[:2])
    inner, outer = footprint(small) - origin, footprint(big) - origin
    area = polygon_area(inner)
    return min(1.0, max(0.0, polygon_area(_clip_convex(inner, outer)) / area)) if area > 0 else 0.0


def detect_spec_geometry(cuboids: Sequence[Cuboid], cfg: SpecConfig) -> list[Finding]:
    """`spec.inside` và `spec.rider_double`: một mục mỗi cặp track (keyframe đầu tiên vi phạm, kèm số keyframe)."""
    if not cfg.inside_forbidden and not cfg.rider_double:
        return []
    hits: dict[tuple[str, object, object], list[tuple[Cuboid, Cuboid]]] = defaultdict(list)
    # Xét cả box occluded: người ngồi trong xe thường bị đánh occluded, nhưng câu hỏi là box đó có nên tồn tại không.
    for frame, boxes in group_by_frame(c for c in cuboids if not c.outside and c.keyframe).items():
        for inner in boxes:
            for outer in boxes:
                if inner is outer:
                    continue
                inner_id = ("track", inner.label, inner.track_id) if inner.track_id is not None else ("shape", id(inner))
                outer_id = ("track", outer.label, outer.track_id) if outer.track_id is not None else ("shape", id(outer))
                for a, b in cfg.inside_forbidden:
                    if (_matches(inner, a, cfg) and _matches(outer, b, cfg)
                            and _footprint_contains(outer, inner.center[0], inner.center[1], margin=0.1)
                            and inner.bottom_z - outer.bottom_z < cfg.inside_min_lift_m
                            and inner.center[2] < outer.center[2] + outer.height / 2):
                        hits[("spec.inside", inner_id, outer_id)].append((inner, outer))
                for a, b in cfg.rider_double:
                    if (_matches(outer, a, cfg) and _matches(inner, b, cfg) and _overlap_fraction(inner, outer) >= 0.5
                            and abs(inner.bottom_z - outer.bottom_z) < 1.0):
                        hits[("spec.rider_double", inner_id, outer_id)].append(
                            (inner, outer))
    findings: list[Finding] = []
    for (rule, _, _), pairs_ in hits.items():
        pairs_.sort(key=lambda p: p[0].frame)
        inner, outer = pairs_[0]
        n = len(pairs_)
        where = f"frame {inner.frame}" if n == 1 else f"{n} keyframe (từ frame {inner.frame})"
        other = f"{outer.label}" + (f" (track {outer.track_id})" if outer.track_id is not None else "")
        if rule == "spec.inside":
            message = (f"Box {inner.label} nằm bên trong box {other} ở {where}: spec 4.3B không gán người bên trong xe "
                       f"(trừ người đứng trên nóc / thùng xe)")
        else:
            message = (f"Box {inner.label} chồng lên box {other} đã có người lái (with_rider) ở {where}: spec 4.3C người "
                       f"lái nằm trong box xe, không gán thêm box riêng; người đã xuống xe thì đổi xe sang without_rider")
        findings.append(Finding(
            error_type=ErrorType.ATTRIBUTE, rule=rule, severity=Severity.WARNING, frame=inner.frame, label=inner.label,
            track_id=inner.track_id, source_id=inner.source_id, value=float(n), threshold=None, message=message,
            details={"other_label": outer.label, "other_track_id": outer.track_id,
                     "frames": [p[0].frame for p in pairs_]},
        ))
    return findings


def detect_rider_state(cuboids: Sequence[Cuboid], cfg: SpecConfig, sensor_to_world=None,
                       interval_s: float = 0.5, timestamps=None) -> list[Finding]:
    """`attr.rider_state`: thuộc tính có người lái không khớp chuyển động / người xuống xe."""
    rs = cfg.rider_state
    if not rs or not sensor_to_world:
        return []
    cls, attr, with_v, without_v, person = rs["class"], rs["attribute"], rs["with"], rs["without"], rs["person"]

    def world(box: Cuboid) -> np.ndarray:
        m = np.asarray(sensor_to_world[box.frame])
        return (m[:3, :3] @ np.asarray(box.center) + m[:3, 3])[:2]

    findings: list[Finding] = []
    tracks = group_by_track([c for c in cuboids if c.visible and c.keyframe])
    starts = [(t[0].frame, world(t[0]), tid) for tid, t in ((tid, sorted(tb, key=lambda b: b.frame))
                                                         for tid, tb in tracks.items()) if t[0].label == person
              and t[0].frame in sensor_to_world]
    for tid, tb in tracks.items():
        tb = sorted(tb, key=lambda b: b.frame)
        tb = [b for b in tb if b.label == cls]
        if not tb or not all(b.frame in sensor_to_world for b in tb):
            continue
        pos = [world(b) for b in tb]
        times = ([float(timestamps[b.frame]) for b in tb] if timestamps and all(b.frame in timestamps for b in tb)
                 else [b.frame * interval_s for b in tb])
        speed = [float(np.linalg.norm(pos[i] - pos[i - 1])) / (times[i] - times[i - 1])
                 if times[i] > times[i - 1] else 0.0 for i in range(1, len(tb))]
        # Lên xe mà quên đổi: without_rider chạy nhanh ≥ 2 bước liền
        fast = [i + 1 for i, v in enumerate(speed) if v > cfg.rider_max_speed_mps
                and tb[i].attrs.get(attr) == without_v and tb[i + 1].attrs.get(attr) == without_v]
        runs = [i for n, i in enumerate(fast) if n > 0 and fast[n - 1] == i - 1]
        if runs:
            first = tb[runs[0] - 1]
            v = max(speed[i - 1] for i in fast)
            findings.append(Finding(
                error_type=ErrorType.ATTRIBUTE, rule="attr.rider_state", severity=Severity.WARNING, frame=first.frame,
                label=first.label, track_id=tid, source_id=first.source_id, value=v, threshold=cfg.rider_max_speed_mps,
                message=(f"{cls} ghi {attr}={without_v} nhưng chạy {v:.1f} m/s (từ frame {first.frame}; dắt xe chỉ ~1,3 "
                         f"m/s): có người lái mà chưa đổi sang {with_v}? (spec 4.3C)"),
                details={"frames": [tb[i].frame for i in fast], "speed_mps": v, "kind": "mount"},
            ))
            continue
        # Xuống xe mà quên đổi: người mới bắt đầu sát xe đứng yên, xe vẫn with_rider ≥ 2 keyframe sau đó
        for k, box in enumerate(tb):
            if box.attrs.get(attr) != with_v or k == 0 or speed[k - 1] > 0.5:
                continue
            here = pos[k]
            newcomer = next((t for f, p, t in starts if f == box.frame and np.linalg.norm(p - here) <= 1.2), None)
            after = tb[k + 1:k + 3]
            if (newcomer is None or len(after) < 2 or any(b.attrs.get(attr) != with_v for b in after)
                    or any(v > 0.5 for v in speed[k:k + 2])):
                continue
            findings.append(Finding(
                error_type=ErrorType.ATTRIBUTE, rule="attr.rider_state", severity=Severity.WARNING, frame=box.frame,
                label=box.label, track_id=tid, source_id=box.source_id, value=float(len(after)), threshold=2.0,
                message=(f"Người (track {newcomer}) xuất hiện sát {cls} đang đứng ở frame {box.frame} nhưng xe vẫn ghi "
                         f"{attr}={with_v} các frame sau: người lái đã xuống xe thì đổi xe sang {without_v} (spec 4.3C)"),
                details={"frames": [box.frame] + [b.frame for b in after], "person_track_id": newcomer, "kind": "dismount"},
            ))
            break
    return findings
