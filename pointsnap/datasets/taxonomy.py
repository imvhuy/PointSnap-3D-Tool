"""Bộ class + thuộc tính theo Annotation Specification giao thông Việt Nam (việc C2), và ánh xạ từ nuScenes.

Spec 3.1: 5 class chính `Vehicle`, `Two-wheels`, `Pedestrian`, `Animal`, `Obstacle`; chi tiết nằm ở thuộc tính
(`subtype`, `rider_state`, `age_group`, `pose`, `species`, `type`), bắt buộc khi object thuộc phạm vi thuộc tính.
Tên giá trị giữ đúng như bảng của spec (kể cả `contruction`, `Trailer`, `Tricycle`, `traffic barrier`).

`spec_label` đổi category + thuộc tính của một nhãn nuScenes sang class và thuộc tính của spec, để demo PointSnap
trên task CVAT có bộ nhãn giống dự án thật (`pointsnap nuscenes to-cvat --taxonomy spec-vn`).
"""

from __future__ import annotations

from typing import Iterable

SPEC_VN_CLASSES: dict[str, dict[str, tuple[str, ...]]] = {
    "Vehicle": {"subtype": ("car", "van", "truck", "contruction", "bus", "pickup", "Trailer", "Tricycle", "Stroller",
                            "Wheelchair", "other")},
    "Two-wheels": {"rider_state": ("with_rider", "without_rider")},
    "Pedestrian": {"age_group": ("adult", "child"), "pose": ("standing", "sitting", "bending")},
    "Animal": {"species": ("dog", "cat", "cow", "buffalo", "other")},
    "Obstacle": {"type": ("brick", "traffic barrier", "traffic cone", "sack", "trash_bag", "container", "metal_sheet",
                          "wood", "charging point", "other")},
}
"""Class → {thuộc tính → giá trị cho phép}, theo spec 3.1.1–3.1.2."""

_CATEGORY: dict[str, tuple[str, dict[str, str]]] = {
    "vehicle.car": ("Vehicle", {"subtype": "car"}),
    "vehicle.truck": ("Vehicle", {"subtype": "truck"}),
    "vehicle.bus.rigid": ("Vehicle", {"subtype": "bus"}),
    "vehicle.bus.bendy": ("Vehicle", {"subtype": "bus"}),
    "vehicle.trailer": ("Vehicle", {"subtype": "Trailer"}),
    "vehicle.construction": ("Vehicle", {"subtype": "contruction"}),
    "vehicle.emergency.ambulance": ("Vehicle", {"subtype": "other"}),
    "vehicle.emergency.police": ("Vehicle", {"subtype": "other"}),
    "human.pedestrian.stroller": ("Vehicle", {"subtype": "Stroller"}),
    "human.pedestrian.wheelchair": ("Vehicle", {"subtype": "Wheelchair"}),
    "vehicle.motorcycle": ("Two-wheels", {}),
    "vehicle.bicycle": ("Two-wheels", {}),
    "human.pedestrian.adult": ("Pedestrian", {"age_group": "adult"}),
    "human.pedestrian.construction_worker": ("Pedestrian", {"age_group": "adult"}),
    "human.pedestrian.police_officer": ("Pedestrian", {"age_group": "adult"}),
    "human.pedestrian.personal_mobility": ("Pedestrian", {"age_group": "adult"}),  # spec 4.3B: người trên scooter
    "human.pedestrian.child": ("Pedestrian", {"age_group": "child"}),
    "animal": ("Animal", {"species": "other"}),
    "movable_object.trafficcone": ("Obstacle", {"type": "traffic cone"}),
    "movable_object.barrier": ("Obstacle", {"type": "traffic barrier"}),
    "movable_object.debris": ("Obstacle", {"type": "other"}),
    "movable_object.pushable_pullable": ("Obstacle", {"type": "other"}),
}
"""Category nuScenes → (class spec, thuộc tính cố định). `static_object.bicycle_rack` không thuộc spec nên bỏ."""

_POSE = {"pedestrian.moving": "standing", "pedestrian.standing": "standing", "pedestrian.sitting_lying_down": "sitting"}


def spec_label(category: str, nuscenes_attributes: Iterable[str]) -> tuple[str, dict[str, str]] | None:
    """(class, thuộc tính) theo spec VN của một nhãn nuScenes; `None` nếu category không thuộc spec."""
    mapped = _CATEGORY.get(category)
    if mapped is None:
        return None
    label, attrs = mapped[0], dict(mapped[1])
    names = set(nuscenes_attributes)
    if label == "Two-wheels":
        # Spec 3.1.3: chỉ with_rider khi có người trên xe; không chắc thì coi là không có người.
        attrs["rider_state"] = "with_rider" if "cycle.with_rider" in names else "without_rider"
    if label == "Pedestrian":
        attrs["pose"] = next((_POSE[n] for n in names if n in _POSE), "standing")
    return label, attrs
