"""Điểm LiDAR của từng vật quanh box: dùng chung cho luật hướng box theo cụm điểm và luật box lệch khỏi vật (C1).

Với mỗi box của một frame lấy các điểm trong box nới mỗi phía max(`margin` mét, `margin_rel` × cạnh đó) theo hệ box,
bỏ điểm mặt đất (thấp hơn mặt đất cục bộ + `clearance`) và điểm thuộc box khác, rồi chỉ giữ điểm nối liền với các điểm
trong box. Phần còn lại coi là điểm của vật: nếu box vẽ đúng thì gần như
mọi điểm đó nằm trong box.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from pointsnap.core.geometry import to_box_frame
from pointsnap.core.ground import OtherBoxPoints, ring_ground_for_box
from pointsnap.core.model import Cuboid

INSIDE_TOLERANCE_M = 0.05
"""Điểm cách mặt box không quá 5 cm vẫn tính là trong box (sai số vẽ tay)."""

EMPTY_TOLERANCE_M = 0.2
"""Đếm điểm cho luật box rỗng trong box nới 20 cm: box chỉ hụt vật vài cm không bị coi là rỗng."""

EMPTY_FLOOR_M = 0.1
"""Khi đếm điểm cho luật box rỗng, bỏ điểm thấp hơn đáy box + 10 cm (25% chiều cao với vật thấp hơn 40 cm): box đặt
trên mặt đường trống vẫn là box rỗng."""

CONNECT_VOXEL_M = 0.3
"""Cạnh ô lưới khi loang điểm: hai điểm thuộc cùng vật nếu nối được qua các ô có điểm liền kề."""


CONNECT_SEED_M = 0.3
"""Bắt đầu loang từ các điểm cách mặt box không quá 30 cm: box co hẳn vào trong vật vẫn tìm được điểm của vật."""


def connected_to_box(local: np.ndarray, half: np.ndarray, voxel: float = CONNECT_VOXEL_M) -> np.ndarray:
    """Mask các điểm (hệ box) nối liền với các điểm nằm trong hoặc sát box, loang qua các ô lưới `voxel` có điểm.

    Vật bên cạnh (cây, tường, cột) tách khỏi vật bởi khoảng trống > 1 ô thì không được tính là điểm của vật.
    """
    if len(local) == 0:
        return np.zeros(0, dtype=bool)
    keys = np.floor(local / voxel).astype(np.int64)
    inside = np.all(np.abs(local) <= half + CONNECT_SEED_M, axis=1)
    cells: dict[tuple[int, int, int], list[int]] = {}
    for i, key in enumerate(map(tuple, keys)):
        cells.setdefault(key, []).append(i)
    frontier = [tuple(k) for k in {tuple(keys[i]) for i in np.flatnonzero(inside)}]
    seen = set(frontier)
    while frontier:
        x, y, z = frontier.pop()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    nb = (x + dx, y + dy, z + dz)
                    if nb in cells and nb not in seen:
                        seen.add(nb)
                        frontier.append(nb)
    mask = np.zeros(len(local), dtype=bool)
    for key in seen:
        mask[cells[key]] = True
    return mask


@dataclass(frozen=True, eq=False)
class BoxPointSet:
    """Điểm của một vật quanh box.

    - `local`: (M, 3) điểm của vật trong hệ box (gốc ở tâm, x theo hướng đầu box), trong box nới `margin`.
    - `inside`: mask (M,) các điểm nằm trong box.
    - `raw_inside`: số điểm nằm trong box (nới `EMPTY_TOLERANCE_M`), cao hơn đáy box `EMPTY_FLOOR_M`: 0 là box rỗng.
    - `ground_z`: mặt đất cục bộ đã dùng để bỏ điểm mặt đất (hệ point cloud); `None` nếu không đo được.
    - `sensor_local`: vị trí cảm biến (gốc point cloud) trong hệ box, để biết mặt nào của box nhìn thấy được.
    """

    box: Cuboid
    local: np.ndarray
    inside: np.ndarray
    raw_inside: int
    ground_z: float | None
    sensor_local: np.ndarray

    @property
    def range_m(self) -> float:
        return float(math.hypot(self.box.center[0], self.box.center[1]))

    @property
    def num_object_points(self) -> int:
        return int(len(self.local))

    @property
    def num_outside(self) -> int:
        return int(len(self.local) - int(self.inside.sum()))


RING_REACH_M = 1.5
"""Dư mỗi cạnh footprint khi lấy điểm ground; bán kính đường chéo giữ đủ góc box xoay."""


def box_point_sets(
    points: np.ndarray, boxes: Sequence[Cuboid], margin: float, clearance: float, margin_rel: float = 0.0,
) -> list[BoxPointSet]:
    """Điểm của vật quanh từng box trong `boxes` (cùng một frame, đã bỏ box `outside`)."""
    cloud = OtherBoxPoints(points, boxes)
    pts = cloud.points
    result: list[BoxPointSet] = []
    for index, box in enumerate(boxes):
        half = np.asarray(box.dims) / 2.0
        pad = np.maximum(margin, margin_rel * np.asarray(box.dims[:2]))
        reach = math.hypot(*(half[:2] + pad)) + 0.1
        near_idx = cloud.near(box.center[0], box.center[1], reach + 1e-6)
        near_idx = near_idx[(np.abs(pts[near_idx, 0] - box.center[0]) <= reach)
                            & (np.abs(pts[near_idx, 1] - box.center[1]) <= reach)]
        local_all = to_box_frame(pts[near_idx], box)

        own = cloud.without_others(index, reach=math.hypot(*(half[:2] + RING_REACH_M)))
        ground = ring_ground_for_box(own, box)
        ground_z = ground.ground_z if ground.is_valid else None
        base = (ground_z if ground_z is not None else box.bottom_z) - box.center[2]
        raw_inside = int((np.all(np.abs(local_all) <= half + EMPTY_TOLERANCE_M, axis=1)
                          & (local_all[:, 2] > -half[2] + min(EMPTY_FLOOR_M, 0.25 * box.height))).sum())
        floor_local = max(base + clearance, -half[2] - margin)

        others = cloud.belongs_to_others(index, near_idx)
        in_region = (np.all(np.abs(local_all[:, :2]) <= half[:2] + pad, axis=1)
                     & (local_all[:, 2] > floor_local) & (local_all[:, 2] <= half[2] + margin) & ~others)
        local = local_all[in_region]
        local = local[connected_to_box(local, half)]
        inside = np.all(np.abs(local) <= half + INSIDE_TOLERANCE_M, axis=1)
        sensor_local = to_box_frame(np.zeros((1, 3)), box)[0]
        result.append(BoxPointSet(box, local, inside, raw_inside, ground_z, sensor_local))
    return result
