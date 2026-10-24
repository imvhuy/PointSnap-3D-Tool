"""Bộ chèn lỗi giả có kiểm soát theo mục 8.1 của đề xuất (việc A7).

Hỗ trợ 3 loại lỗi:
1. Lơ lửng / lún: dịch Z của box lên hoặc xuống (5, 10, 20, 40 cm).
2. Kích thước trong track: làm lệch (l, w, h) ở một keyframe (5%, 15%, 30%).
3. Kích thước theo class: phóng to/thu nhỏ cả track (x0.6; x1.5) hoặc gán kích thước class khác.

Giai đoạn 3 (C1) thêm bộ lỗi `C1_ERRORS` cho hai luật mới:
4. Sai hướng - xoay một keyframe: cộng 15°, 30°, 60°, 90°, 180° vào yaw.
5. Sai hướng - ngược cả track: cộng 180° vào yaw mọi keyframe (vật đang chạy thì box ngược chiều chuyển động).
6. Box lệch - dịch ngang: dời một keyframe sang ngang (vuông góc trục box) 0.3, 0.5, 1.0 m.
7. Box lệch - co / phóng: nhân chiều dài và rộng của một keyframe với 0.7 hoặc 1.3, giữ tâm và chiều cao.
8. Box lệch - vẽ trùng: thêm một box nữa (track mới) cho cùng vật, lệch 0.3 m.

Kèm cơ chế xuất log JSON để script B6 (đo Precision / Recall) so sánh đối chiếu.
"""

from __future__ import annotations

import dataclasses
import json
import math
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

from pointsnap.core.model import Cuboid, group_by_track


@dataclass(frozen=True)
class InjectedError:
    """Bản ghi mô tả chi tiết một lỗi được chèn giả."""

    error_type: str
    """Loại lỗi: 'floating', 'size_in_track', 'size_class_range';
    từ C1 thêm 'heading_rotate', 'heading_reverse', 'fit_shift', 'fit_scale', 'fit_duplicate'."""
    magnitude: float | str
    """Mức độ: số đo (m, tỉ lệ) hoặc chuỗi mô tả."""
    track_id: int
    frame: int | None
    source_id: int | None
    description: str
    original_value: Any
    injected_value: Any


def inject_floating(
    cuboids: list[Cuboid],
    track_id: int,
    frame: int,
    delta_z_m: float,
) -> tuple[list[Cuboid], InjectedError]:
    """Dịch Z của box ở một frame cụ thể lên/xuống `delta_z_m`."""
    res: list[Cuboid] = []
    injected: InjectedError | None = None

    for c in cuboids:
        if c.track_id == track_id and c.frame == frame and not c.outside:
            old_z = c.center[2]
            new_z = old_z + delta_z_m
            new_center = (c.center[0], c.center[1], new_z)
            mod = c.replace(center=new_center)
            res.append(mod)
            direction = "lơ lửng" if delta_z_m > 0 else "lún"
            injected = InjectedError(
                error_type="floating",
                magnitude=abs(delta_z_m),
                track_id=track_id,
                frame=frame,
                source_id=c.source_id,
                description=f"{direction.capitalize()} {abs(delta_z_m)*100:.0f} cm",
                original_value=old_z,
                injected_value=new_z,
            )
        else:
            res.append(c)

    if injected is None:
        raise ValueError(f"Không tìm thấy box track_id={track_id}, frame={frame} để chèn floating")
    return res, injected


def inject_size_in_track(
    cuboids: list[Cuboid],
    track_id: int,
    frame: int,
    scale_factor: float,
) -> tuple[list[Cuboid], InjectedError]:
    """Làm lệch kích thước (l, w, h) của một keyframe trong track theo tỉ lệ `scale_factor`."""
    res: list[Cuboid] = []
    injected: InjectedError | None = None

    for c in cuboids:
        if c.track_id == track_id and c.frame == frame and not c.outside:
            old_dims = c.dims
            new_dims = (old_dims[0] * scale_factor, old_dims[1] * scale_factor, old_dims[2] * scale_factor)
            mod = c.replace(dims=new_dims)
            res.append(mod)
            pct = (scale_factor - 1.0) * 100
            injected = InjectedError(
                error_type="size_in_track",
                magnitude=abs(scale_factor - 1.0),
                track_id=track_id,
                frame=frame,
                source_id=c.source_id,
                description=f"Lệch kích thước keyframe {pct:+.0f}%",
                original_value=list(old_dims),
                injected_value=list(new_dims),
            )
        else:
            res.append(c)

    if injected is None:
        raise ValueError(f"Không tìm thấy box track_id={track_id}, frame={frame} để chèn size_in_track")
    return res, injected


def inject_size_class_range(
    cuboids: list[Cuboid],
    track_id: int,
    scale_factor: float | None = None,
    override_dims: tuple[float, float, float] | None = None,
) -> tuple[list[Cuboid], InjectedError]:
    """Phóng to/thu nhỏ cả track hoặc gán kích thước bất thường theo class."""
    res: list[Cuboid] = []
    sample_box: Cuboid | None = None

    for c in cuboids:
        if c.track_id == track_id:
            if sample_box is None and not c.outside:
                sample_box = c
            if override_dims:
                new_dims = override_dims
            elif scale_factor:
                new_dims = (c.dims[0] * scale_factor, c.dims[1] * scale_factor, c.dims[2] * scale_factor)
            else:
                new_dims = c.dims
            res.append(c.replace(dims=new_dims))
        else:
            res.append(c)

    if sample_box is None:
        raise ValueError(f"Không tìm thấy track_id={track_id}")

    desc = f"Đổi kích thước cả track theo dims {override_dims}" if override_dims else f"Quy mô cả track x{scale_factor}"
    mag = "override" if override_dims else float(scale_factor or 1.0)
    injected = InjectedError(
        error_type="size_class_range",
        magnitude=mag,
        track_id=track_id,
        frame=None,
        source_id=None,
        description=desc,
        original_value=list(sample_box.dims),
        injected_value=list(override_dims) if override_dims else f"x{scale_factor}",
    )
    return res, injected


def _replace_one(cuboids: list[Cuboid], track_id: int, frame: int, change) -> tuple[list[Cuboid], Cuboid, Cuboid]:
    res: list[Cuboid] = []
    found: tuple[Cuboid, Cuboid] | None = None
    for c in cuboids:
        if c.track_id == track_id and c.frame == frame and not c.outside:
            new = change(c)
            res.append(new)
            found = (c, new)
        else:
            res.append(c)
    if found is None:
        raise ValueError(f"Không tìm thấy box track_id={track_id}, frame={frame}")
    return res, found[0], found[1]


def inject_heading_rotate(
    cuboids: list[Cuboid], track_id: int, frame: int, delta_deg: float,
) -> tuple[list[Cuboid], InjectedError]:
    """Xoay một keyframe thêm `delta_deg` độ quanh trục z (180° là lật đầu box)."""
    res, old, new = _replace_one(cuboids, track_id, frame, lambda c: c.replace(yaw=c.yaw + math.radians(delta_deg)))
    return res, InjectedError(
        error_type="heading_rotate", magnitude=float(delta_deg), track_id=track_id, frame=frame,
        source_id=old.source_id, description=f"Xoay box {delta_deg:.0f}°", original_value=old.yaw,
        injected_value=new.yaw,
    )


def inject_heading_reverse(cuboids: list[Cuboid], track_id: int) -> tuple[list[Cuboid], InjectedError]:
    """Quay ngược 180° mọi keyframe của track: box ngược chiều chuyển động trong suốt track."""
    res = [c.replace(yaw=c.yaw + math.pi) if c.track_id == track_id else c for c in cuboids]
    if not any(c.track_id == track_id for c in cuboids):
        raise ValueError(f"Không tìm thấy track_id={track_id}")
    return res, InjectedError(
        error_type="heading_reverse", magnitude=180.0, track_id=track_id, frame=None, source_id=None,
        description="Quay ngược 180° cả track", original_value=None, injected_value=None,
    )


def inject_fit_shift(
    cuboids: list[Cuboid], track_id: int, frame: int, shift_m: float,
) -> tuple[list[Cuboid], InjectedError]:
    """Dời một keyframe sang ngang (vuông góc trục box) `shift_m` mét."""
    def change(c: Cuboid) -> Cuboid:
        dx, dy = -math.sin(c.yaw) * shift_m, math.cos(c.yaw) * shift_m
        return c.replace(center=(c.center[0] + dx, c.center[1] + dy, c.center[2]))

    res, old, new = _replace_one(cuboids, track_id, frame, change)
    return res, InjectedError(
        error_type="fit_shift", magnitude=float(shift_m), track_id=track_id, frame=frame, source_id=old.source_id,
        description=f"Dời box sang ngang {shift_m:.1f} m", original_value=list(old.center),
        injected_value=list(new.center),
    )


def inject_fit_scale(
    cuboids: list[Cuboid], track_id: int, frame: int, factor: float,
) -> tuple[list[Cuboid], InjectedError]:
    """Nhân chiều dài và rộng của một keyframe với `factor` (giữ tâm, chiều cao): < 1 là box nhỏ, > 1 là box dư."""
    res, old, new = _replace_one(
        cuboids, track_id, frame, lambda c: c.replace(dims=(c.length * factor, c.width * factor, c.height)))
    return res, InjectedError(
        error_type="fit_scale", magnitude=float(factor), track_id=track_id, frame=frame, source_id=old.source_id,
        description=f"Co / phóng box x{factor:g} theo chiều dài và rộng", original_value=list(old.dims),
        injected_value=list(new.dims),
    )


def inject_fit_duplicate(
    cuboids: list[Cuboid], track_id: int, frame: int, new_track_id: int, offset_m: float = 0.3,
) -> tuple[list[Cuboid], InjectedError]:
    """Thêm một box nữa (track mới) cho cùng vật ở một frame, lệch `offset_m` mét theo trục box."""
    source = next((c for c in cuboids if c.track_id == track_id and c.frame == frame and not c.outside), None)
    if source is None:
        raise ValueError(f"Không tìm thấy box track_id={track_id}, frame={frame}")
    copy = source.replace(
        center=(source.center[0] + math.cos(source.yaw) * offset_m, source.center[1] + math.sin(source.yaw) * offset_m,
                source.center[2]),
        track_id=new_track_id, source_id=None,
    )
    return list(cuboids) + [copy], InjectedError(
        error_type="fit_duplicate", magnitude=float(offset_m), track_id=track_id, frame=frame, source_id=None,
        description=f"Vẽ trùng: thêm track #{new_track_id} cho cùng vật, lệch {offset_m:.1f} m",
        original_value=track_id, injected_value=new_track_id,
    )


C1_ERRORS: list[tuple[str, Any]] = [
    ("heading_rotate", 180.0),
    ("heading_rotate", 15.0),
    ("heading_rotate", 30.0),
    ("heading_rotate", 60.0),
    ("heading_rotate", 90.0),
    ("heading_reverse", None),
    ("fit_shift", 0.3),
    ("fit_shift", 0.5),
    ("fit_shift", 1.0),
    ("fit_scale", 0.7),
    ("fit_scale", 1.3),
    ("fit_duplicate", 0.3),
]
"""Bộ lỗi chèn cho luật sai hướng và box lệch (C1)."""


# Kích thước (l, w, h) điển hình của một class khác, dùng cho lỗi "gán kích thước class khác" (mục 8.1).
OTHER_CLASS_DIMS: dict[str, tuple[float, float, float]] = {
    "car": (11.0, 2.9, 3.4),           # ô tô mang kích thước xe buýt
    "truck": (4.6, 1.9, 1.6),          # xe tải mang kích thước ô tô
    "bus": (4.6, 1.9, 1.6),
    "pedestrian": (1.8, 0.8, 1.3),     # người mang kích thước xe đạp
    "bicycle": (0.7, 0.7, 1.75),       # xe đạp mang kích thước người
    "motorcycle": (4.6, 1.9, 1.6),
    "traffic_cone": (0.5, 2.5, 1.0),   # cọc tiêu mang kích thước rào chắn
    "barrier": (0.4, 0.4, 0.7),        # rào chắn mang kích thước cọc tiêu
}


def save_injection_log(path: str | Path, errors: Sequence[InjectedError], meta: dict[str, Any] | None = None) -> None:
    """Lưu danh sách lỗi đã chèn ra file JSON để script đánh giá (B6) sử dụng."""
    payload = {
        "version": 1,
        "meta": meta or {},
        "total_errors": len(errors),
        "injected_errors": [asdict(e) for e in errors],
    }
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_injection_log(path: str | Path) -> tuple[list[InjectedError], dict[str, Any]]:
    """Đọc file log lỗi đã chèn."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    errors = [
        InjectedError(
            error_type=e["error_type"],
            magnitude=e["magnitude"],
            track_id=e["track_id"],
            frame=e["frame"],
            source_id=e["source_id"],
            description=e["description"],
            original_value=e["original_value"],
            injected_value=e["injected_value"],
        )
        for e in data.get("injected_errors", [])
    ]
    return errors, data.get("meta", {})


def inject_dataset(
    cuboids: Iterable[Cuboid],
    seed: int = 42,
    error_rate: float = 0.10,
    offset: int = 0,
    catalog: str = "core",
) -> tuple[list[Cuboid], list[InjectedError]]:
    """Tự động chèn lỗi có kiểm soát vào ~10% số track theo mục 8.1.

    Mỗi track được chọn chỉ mang ĐÚNG MỘT lỗi, chèn vào box nhìn thấy được (không `outside`, không `occluded`).
    Phân bố đều qua các loại lỗi và các mức độ: track thứ i nhận kiểu lỗi thứ `(i + offset)` trong danh mục,
    nên khi chèn nhiều vòng, tăng `offset` để cảnh ít track vẫn lần lượt nhận đủ mọi kiểu.
    `catalog`: `core` (6 loại lỗi của mục 8.1), `c1` (sai hướng và box lệch, `C1_ERRORS`) hoặc `all` (cả hai).
    """
    if catalog not in ("core", "c1", "all"):
        raise ValueError(f"catalog phải là core, c1 hoặc all, nhận {catalog!r}")
    if not 0 <= error_rate <= 1:
        raise ValueError('error_rate phải nằm trong [0, 1]')
    rng = random.Random(seed)
    cuboid_list = list(cuboids)
    if error_rate == 0:
        return cuboid_list, []
    tracks = group_by_track(cuboid_list)

    # Lọc các track hợp lệ có ít nhất 3 frame hoạt động
    valid_tids = [
        tid for tid, boxes in tracks.items()
        if len([b for b in boxes if b.visible]) >= 3
    ]
    if not valid_tids:
        return cuboid_list, []

    num_to_inject = max(1, int(len(valid_tids) * error_rate))
    chosen_tids = rng.sample(valid_tids, min(num_to_inject, len(valid_tids)))

    # Danh mục lỗi và mức theo bảng mục 8.1
    error_configs = [
        # (loại lỗi, tham số)
        ("floating", 0.05),
        ("floating", -0.10),
        ("floating", 0.20),
        ("floating", -0.40),
        ("size_in_track", 1.05),
        ("size_in_track", 1.15),
        ("size_in_track", 1.30),
        ("size_class_range", 0.6),
        ("size_class_range", 1.5),
        ("size_class_range", "other_class"),
        ("floating", -0.05),
        ("floating", 0.10),
        ("floating", -0.20),
        ("floating", 0.40),
    ]
    if catalog == "c1":
        error_configs = list(C1_ERRORS)
    elif catalog == "all":
        error_configs = error_configs + list(C1_ERRORS)

    modified_cuboids = list(cuboid_list)
    injected_errors: list[InjectedError] = []

    next_free_track_id = max(tracks.keys(), default=0) + 1000

    for i, tid in enumerate(chosen_tids):
        active_boxes = [b for b in tracks[tid] if b.visible]
        mid_box = active_boxes[len(active_boxes) // 2]
        err_type, param = error_configs[(i + offset) % len(error_configs)]

        try:
            if err_type == "floating":
                modified_cuboids, log = inject_floating(modified_cuboids, tid, mid_box.frame, float(param))
            elif err_type == "size_in_track":
                modified_cuboids, log = inject_size_in_track(modified_cuboids, tid, mid_box.frame, float(param))
            elif err_type == "size_class_range" and param == "other_class":
                other = OTHER_CLASS_DIMS.get(mid_box.label)
                if other is None:
                    continue
                modified_cuboids, log = inject_size_class_range(modified_cuboids, tid, override_dims=other)
            elif err_type == "size_class_range":
                modified_cuboids, log = inject_size_class_range(modified_cuboids, tid, scale_factor=float(param))
            elif err_type == "heading_rotate":
                modified_cuboids, log = inject_heading_rotate(modified_cuboids, tid, mid_box.frame, float(param))
            elif err_type == "heading_reverse":
                modified_cuboids, log = inject_heading_reverse(modified_cuboids, tid)
            elif err_type == "fit_shift":
                modified_cuboids, log = inject_fit_shift(modified_cuboids, tid, mid_box.frame, float(param))
            elif err_type == "fit_scale":
                modified_cuboids, log = inject_fit_scale(modified_cuboids, tid, mid_box.frame, float(param))
            elif err_type == "fit_duplicate":
                next_free_track_id += 1
                modified_cuboids, log = inject_fit_duplicate(modified_cuboids, tid, mid_box.frame,
                                                             next_free_track_id, float(param))
            else:
                continue
            injected_errors.append(log)
        except Exception:
            # Nếu track không thỏa điều kiện của kiểu lỗi đó, bỏ qua
            continue

    return modified_cuboids, injected_errors
