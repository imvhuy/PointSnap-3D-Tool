"""Mô hình dữ liệu dùng chung giữa core, adapter và báo cáo.

Core chỉ nhận và trả các kiểu trong file này, nên đổi nền tảng (CVAT) hay bộ dữ liệu (nuScenes)
chỉ cần viết thêm adapter. Quy ước tọa độ: xem CONVENTIONS.md.
"""

from __future__ import annotations

import dataclasses
import math
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping, Protocol

import numpy as np

from pointsnap.core.geometry import normalize_angle, validate_pose

Vec3 = tuple[float, float, float]


def _vec3(value: Iterable[float], name: str) -> Vec3:
    vec = tuple(float(v) for v in value)
    if len(vec) != 3 or not all(math.isfinite(v) for v in vec):
        raise ValueError(f"{name} phải gồm 3 số hữu hạn, nhận {value!r}")
    return vec  # type: ignore[return-value]


@dataclass(frozen=True)
class Cuboid:
    """Một box 3D tại một frame, trong hệ tọa độ point cloud của frame đó.

    - `center`: tâm hình học (x, y, z).
    - `dims`: (length, width, height); length nằm dọc trục x local của box (hướng đầu xe, QĐ-008).
    - `yaw`: góc quay quanh trục z, chuẩn hóa về [-π, π).
    - `track_id`: id track; `None` nếu box là shape đơn lẻ.
    - `source_id`: id bên hệ thống nguồn (ví dụ id shape trên CVAT), dùng khi ghi ngược lại.
    - `keyframe`: `False` nếu box được nội suy, không do người nhập tay.
    - `outside`: `True` nếu track đánh dấu đối tượng đã ra khỏi khung hình từ frame này.
    """

    center: Vec3
    dims: Vec3
    yaw: float
    label: str
    frame: int
    track_id: int | None = None
    source_id: int | None = None
    keyframe: bool = True
    outside: bool = False
    attrs: Mapping[str, Any] = field(default_factory=dict, compare=False, hash=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "center", _vec3(self.center, "center"))
        dims = _vec3(self.dims, "dims")
        if min(dims) <= 0.0:
            raise ValueError(f"dims phải dương, nhận {dims}")
        object.__setattr__(self, "dims", dims)
        if not math.isfinite(self.yaw):
            raise ValueError(f"yaw phải là số hữu hạn, nhận {self.yaw}")
        object.__setattr__(self, "yaw", normalize_angle(float(self.yaw)))

    @property
    def length(self) -> float:
        return self.dims[0]

    @property
    def width(self) -> float:
        return self.dims[1]

    @property
    def height(self) -> float:
        return self.dims[2]

    @property
    def bottom_z(self) -> float:
        return self.center[2] - self.dims[2] / 2.0

    @property
    def top_z(self) -> float:
        return self.center[2] + self.dims[2] / 2.0

    @property
    def occluded(self) -> bool:
        """Box đánh dấu bị che khuất (thuộc tính `occluded` của CVAT): vật không nhìn thấy, vị trí do người gán ước
        lượng, nên các luật hình học bỏ qua box này (spec 4.4.5)."""
        return bool(self.attrs.get("occluded"))

    @property
    def visible(self) -> bool:
        """Box có mặt và không bị che: dùng cho các luật hình học."""
        return not self.outside and not self.occluded

    def replace(self, **changes: Any) -> Cuboid:
        """Bản sao với một số trường thay đổi."""
        return dataclasses.replace(self, **changes)


@dataclass(frozen=True, eq=False)
class FrameData:
    """Point cloud của một frame và thông tin để đổi sang hệ toàn cục.

    - `points`: mảng (N, 3) hoặc (N, ≥3); chỉ dùng 3 cột đầu x, y, z.
    - `sensor_to_world`: ma trận 4x4 đổi từ hệ point cloud sang hệ toàn cục; `None` nếu không có
      vị trí xe thu (khi đó luật nhảy vị trí chỉ báo ở mức Cảnh báo).
    - `timestamp`: thời điểm chụp, giây.
    - `source_ref`: khóa bên nguồn dữ liệu, ví dụ `sample_token` của nuScenes.
    """

    frame: int
    points: np.ndarray
    sensor_to_world: np.ndarray | None = None
    timestamp: float | None = None
    source_ref: str | None = None

    def __post_init__(self) -> None:
        points = np.asarray(self.points)
        if (points.ndim != 2 or points.shape[1] < 3
                or points.dtype.kind not in "fiu" or not np.isfinite(points[:, :3]).all()):
            raise ValueError("Point cloud phải có shape (N, >=3) và tọa độ x/y/z hữu hạn")
        object.__setattr__(self, "points", points)
        if self.sensor_to_world is not None:
            object.__setattr__(self, "sensor_to_world", validate_pose(self.sensor_to_world))
        if self.timestamp is not None and not math.isfinite(self.timestamp):
            raise ValueError("Timestamp phải là số hữu hạn (giây)")


class FrameSource(Protocol):
    """Nguồn point cloud và pose theo frame (ví dụ `ManifestFrames` của adapter CVAT, `NuScenesFrames`)."""

    def frame_data(self, frame: int, with_points: bool = True) -> FrameData: ...


class Severity(Enum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"

    @property
    def label_vi(self) -> str:
        return {"error": "Lỗi", "warning": "Cảnh báo", "info": "Thông tin"}[self.value]

    @property
    def rank(self) -> int:
        """Thứ tự sắp xếp: Lỗi trước, Thông tin sau cùng."""
        return {"error": 0, "warning": 1, "info": 2}[self.value]


class ErrorType(Enum):
    FLOATING = "floating"
    SIZE = "size"
    HEADING = "heading"
    FIT = "fit"
    ATTRIBUTE = "attribute"
    TRACK = "track"

    @property
    def label_vi(self) -> str:
        return {"floating": "Lơ lửng / lún", "size": "Sai kích thước",
                "heading": "Sai hướng box", "fit": "Box lệch khỏi vật", "attribute": "Thiếu / sai thuộc tính",
                "track": "Đứt track"}[self.value]


@dataclass(frozen=True)
class Finding:
    """Một phát hiện của tool, gắn với một box (frame + track) cụ thể.

    - `rule`: mã luật, ví dụ `floating`, `size.class_range`, `heading.flip` (danh sách ở CONVENTIONS.md).
    - `message`: câu hiển thị cho người dùng, có số đo cụ thể.
    - `value`: số đo chính, đơn vị theo luật (mét hoặc tỉ lệ); `threshold`: ngưỡng đã vượt.
    """

    error_type: ErrorType
    rule: str
    severity: Severity
    frame: int
    label: str
    message: str
    track_id: int | None = None
    source_id: int | None = None
    value: float | None = None
    threshold: float | None = None
    details: Mapping[str, Any] = field(default_factory=dict, compare=False, hash=False)

    def sort_key(self) -> tuple:
        track = self.track_id if self.track_id is not None else -1
        source = self.source_id if self.source_id is not None else -1
        return (self.severity.rank, self.error_type.value, self.frame, track, self.rule, self.label, source)


def group_by_track(cuboids: Iterable[Cuboid]) -> dict[int, list[Cuboid]]:
    """Gom box theo `track_id`, mỗi track sắp theo frame. Bỏ qua box không có track."""
    tracks: dict[int, list[Cuboid]] = defaultdict(list)
    for cuboid in cuboids:
        if cuboid.track_id is not None:
            tracks[cuboid.track_id].append(cuboid)
    return {tid: sorted(boxes, key=lambda c: c.frame) for tid, boxes in sorted(tracks.items())}


def add_outside_markers(cuboids: Iterable[Cuboid], num_frames: int) -> list[Cuboid]:
    """Thêm keyframe `outside` cho track giống cách nạp lên CVAT (`build_tracks` của A2).

    Sau frame có mặt cuối cùng của mỗi đoạn (track hết hoặc khuyết frame ở giữa) thêm một box `outside` ở frame kế
    tiếp, trừ khi đó đã là frame cuối. Dùng khi quét thẳng nhãn nuScenes để kết quả giống khi quét trên CVAT.
    """
    cuboids = list(cuboids)
    result: list[Cuboid] = []
    loose = [c for c in cuboids if c.track_id is None]
    for boxes in group_by_track(cuboids).values():
        present = [b for b in boxes if not b.outside]
        for index, box in enumerate(present):
            result.append(box)
            next_frame = present[index + 1].frame if index + 1 < len(present) else num_frames
            if box.frame + 1 < next_frame:
                result.append(box.replace(frame=box.frame + 1, outside=True, source_id=None))
    return result + loose


MAX_OCCLUDED_FRAMES = 6
"""Spec (hướng dẫn CVAT): thuộc tính occluded dùng khi box bị che, tạm thời không nhìn thấy, tối đa 6 frame."""


def _interpolate(a: Cuboid, b: Cuboid, frame: int) -> Cuboid:
    t = (frame - a.frame) / (b.frame - a.frame)
    center = tuple(ca + (cb - ca) * t for ca, cb in zip(a.center, b.center))
    dims = tuple(da + (db - da) * t for da, db in zip(a.dims, b.dims))
    yaw = a.yaw + math.remainder(b.yaw - a.yaw, 2 * math.pi) * t
    return a.replace(center=center, dims=dims, yaw=yaw, frame=frame, source_id=None)


def add_track_markers(
    cuboids: Iterable[Cuboid], num_frames: int, max_occluded_frames: int = MAX_OCCLUDED_FRAMES,
) -> list[Cuboid]:
    """Đánh dấu đoạn vắng của track theo spec 4.4 (cách `to-cvat` nạp nhãn chuẩn lên CVAT từ giai đoạn 3).

    - Vắng ≤ `max_occluded_frames` frame ở giữa track (bị che, LiDAR thưa): giữ track, thêm một keyframe `occluded`
      ở frame đầu đoạn vắng, vị trí nội suy (spec 4.4.2, 4.4.5: che khuất không phải lý do kết thúc track).
    - Vắng lâu hơn: kết thúc track bằng keyframe `outside`, phần sau thành track mới (spec 4.4.3, 4.4.4: không dùng
      lại track_id sau khi đã kết thúc). Id track mới = id lớn nhất + 1, + 2, … theo thứ tự track, frame.
    - Sau frame có mặt cuối cùng (trừ khi là frame cuối cảnh): keyframe `outside`.
    """
    cuboids = list(cuboids)
    result: list[Cuboid] = [c for c in cuboids if c.track_id is None]
    tracks = group_by_track(cuboids)
    next_id = max(tracks, default=-1) + 1
    for track_id, boxes in tracks.items():
        present = [b for b in boxes if not b.outside]
        current = track_id
        for index, box in enumerate(present):
            result.append(box.replace(track_id=current))
            following = present[index + 1] if index + 1 < len(present) else None
            next_frame = following.frame if following is not None else num_frames
            gap = next_frame - box.frame - 1
            if gap <= 0:
                continue
            if following is not None and gap <= max_occluded_frames:
                hidden = _interpolate(box, following, box.frame + 1)
                result.append(hidden.replace(track_id=current, attrs={**box.attrs, "occluded": True}))
                continue
            result.append(box.replace(frame=box.frame + 1, outside=True, source_id=None, track_id=current))
            if following is not None:
                current, next_id = next_id, next_id + 1
    return result


def group_by_frame(cuboids: Iterable[Cuboid]) -> dict[int, list[Cuboid]]:
    """Gom box theo frame, sắp theo frame tăng dần."""
    frames: dict[int, list[Cuboid]] = defaultdict(list)
    for cuboid in cuboids:
        frames[cuboid.frame].append(cuboid)
    return dict(sorted(frames.items()))
