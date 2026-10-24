"""Đổi giữa `Cuboid` và shape `cuboid` của task 3D trên CVAT.

Định dạng `points` (16 số) đã xác minh trong mã nguồn CVAT 2.77.1, xem CONVENTIONS.md mục 2:
`[px, py, pz, rx, ry, rz, sx, sy, sz, 0, 0, 0, 0, 0, 0, 0]` = tâm, góc Euler XYZ, kích thước đầy đủ.
"""

from __future__ import annotations

from typing import Sequence
import math

from pointsnap.core.model import Cuboid

NUM_POINTS = 16
ROLL_ATTR = "cvat_rx"
PITCH_ATTR = "cvat_ry"


def cuboid_to_points(cuboid: Cuboid) -> list[float]:
    """16 số `points` cho CVAT. Roll, pitch lấy lại từ `attrs` nếu box vốn đọc từ CVAT."""
    roll = float(cuboid.attrs.get(ROLL_ATTR, 0.0))
    pitch = float(cuboid.attrs.get(PITCH_ATTR, 0.0))
    if not math.isfinite(roll) or not math.isfinite(pitch):
        raise ValueError("Roll/pitch của cuboid phải hữu hạn")
    return [*cuboid.center, roll, pitch, cuboid.yaw, *cuboid.dims] + [0.0] * (NUM_POINTS - 9)


def points_to_geometry(points: Sequence[float]) -> dict:
    """Tách `points` của CVAT thành tâm, kích thước, yaw, roll, pitch."""
    if len(points) < 9:
        raise ValueError(f"Shape cuboid 3D cần ít nhất 9 số, nhận {len(points)}")
    px, py, pz, rx, ry, rz, sx, sy, sz = (float(v) for v in points[:9])
    if not all(math.isfinite(v) for v in (px, py, pz, rx, ry, rz, sx, sy, sz)):
        raise ValueError("Shape cuboid phải có tâm, góc quay và kích thước hữu hạn")
    return {"center": (px, py, pz), "dims": (sx, sy, sz), "yaw": rz, "roll": rx, "pitch": ry}
