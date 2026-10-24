"""Ngữ cảnh quét nhãn 3D tập trung (DetectionContext).

Áp dụng DRY: Gom việc chia nhóm cuboids theo track/frame, trích xuất ma trận pose
(sensor_to_world), mốc thời gian (timestamps) và bộ nhớ đệm point cloud (PointCloudCache)
vào một ngữ cảnh duy nhất, tránh việc các detector lặp lại tính toán trùng lặp.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import cached_property
from typing import TYPE_CHECKING, Any, Mapping, Sequence

import numpy as np

from pointsnap.core.geometry import transform_points
from pointsnap.core.model import (
    Cuboid,
    ErrorType,
    Finding,
    FrameData,
    FrameSource,
    Severity,
    group_by_frame,
    group_by_track,
)
from pointsnap.core.rules import rule_label

if TYPE_CHECKING:
    from pointsnap.adapters.cvat.reader import JobData
    from pointsnap.core.config import Config


class PointCloudCache:
    """Bộ nhớ đệm point cloud theo frame trong bộ nhớ để tránh đọc lại nhiều lần từ ổ đĩa."""

    def __init__(self, frames: FrameSource | None = None) -> None:
        self._frames = frames
        self._cache: dict[int, np.ndarray] = {}
        self._frame_data_cache: dict[int, FrameData] = {}

    def get_frame_data(self, frame: int, with_points: bool = True) -> FrameData | None:
        if self._frames is None:
            return None
        if frame in self._frame_data_cache:
            data = self._frame_data_cache[frame]
            # Metadata-only sources return an empty ndarray too; only _cache records a completed cloud read.
            if not with_points or frame in self._cache:
                return data
        data = self._frames.frame_data(frame, with_points=with_points)
        self._frame_data_cache[frame] = data
        if with_points and data.points is not None:
            self._cache[frame] = data.points
        return data

    def get_points(self, frame: int) -> np.ndarray | None:
        if frame in self._cache:
            return self._cache[frame]
        data = self.get_frame_data(frame, with_points=True)
        return data.points if data is not None else None

    def clear(self) -> None:
        self._cache.clear()
        self._frame_data_cache.clear()


@dataclass
class DetectionContext:
    """Ngữ cảnh dùng chung cho toàn bộ pipeline phát hiện lỗi nhãn 3D."""

    cuboids: Sequence[Cuboid]
    config: Config
    frames: FrameSource | None = None
    job: Any = None
    pc_cache: PointCloudCache = field(default_factory=PointCloudCache)

    def __post_init__(self) -> None:
        if not hasattr(self.pc_cache, "_frames") or self.pc_cache._frames is None:
            self.pc_cache = PointCloudCache(self.frames)

    @classmethod
    def from_job(
        cls,
        job: JobData | Sequence[Cuboid] | Any,
        config: Config,
        frames: FrameSource | None = None,
    ) -> DetectionContext:
        """Khởi tạo context từ job hoặc danh sách cuboids."""
        cuboids = job.cuboids if hasattr(job, "cuboids") else list(job)
        return cls(
            cuboids=cuboids,
            config=config,
            frames=frames,
            job=job,
            pc_cache=PointCloudCache(frames),
        )

    @cached_property
    def tracks(self) -> dict[int, list[Cuboid]]:
        """Nhóm box theo track_id, mỗi track sắp xếp theo số thứ tự frame."""
        return group_by_track(self.cuboids)

    @cached_property
    def frames_map(self) -> dict[int, list[Cuboid]]:
        """Nhóm box theo số thứ tự frame."""
        return group_by_frame(self.cuboids)

    @cached_property
    def unique_frames(self) -> list[int]:
        """Danh sách các frame có xuất hiện cuboid, đã sắp xếp tăng dần."""
        return sorted({c.frame for c in self.cuboids})

    @cached_property
    def poses(self) -> tuple[dict[int, np.ndarray] | None, dict[int, float] | None]:
        """Lấy sensor_to_world và timestamps cho toàn bộ các frame."""
        if self.frames is None:
            return None, None
        data = {f: self.frames.frame_data(f, with_points=False) for f in self.unique_frames}
        sensor_to_world = {f: d.sensor_to_world for f, d in data.items() if d.sensor_to_world is not None} or None
        timestamps = {f: d.timestamp for f, d in data.items() if d.timestamp is not None} or None
        return sensor_to_world, timestamps

    @property
    def sensor_to_world(self) -> dict[int, np.ndarray] | None:
        return self.poses[0]

    @property
    def timestamps(self) -> dict[int, float] | None:
        return self.poses[1]

    def get_points(self, frame: int) -> np.ndarray | None:
        """Lấy mảng điểm point cloud của một frame (có cache)."""
        return self.pc_cache.get_points(frame)

    def get_world_centers(
        self,
        cuboids: Sequence[Cuboid],
    ) -> tuple[np.ndarray, bool]:
        """Đổi tọa độ tâm cuboid sang hệ toàn cục (world).

        Trả về (points, has_world): has_world=True nếu đổi thành công sang world,
        has_world=False nếu thiếu sensor_to_world (giữ tọa độ sensor).
        """
        sensor_centers = np.array([c.center for c in cuboids], dtype=np.float64)
        if len(sensor_centers) == 0:
            return np.empty((0, 3), dtype=np.float64), True

        s2w = self.sensor_to_world
        if s2w is None:
            return sensor_centers, False

        # Kiểm tra xem toàn bộ các frame có sensor_to_world hay không
        for c in cuboids:
            if c.frame not in s2w or s2w[c.frame] is None:
                return sensor_centers, False

        world_pts = np.zeros_like(sensor_centers)
        for i, c in enumerate(cuboids):
            center_1x3 = sensor_centers[i : i + 1]
            world_pts[i] = transform_points(center_1x3, s2w[c.frame])[0]

        return world_pts, True

    def create_finding(
        self,
        rule: str,
        error_type: ErrorType,
        severity: Severity,
        frame: int,
        label: str,
        message: str,
        track_id: int | None = None,
        source_id: int | None = None,
        value: float | None = None,
        threshold: float | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> Finding:
        """Tạo một finding chuẩn hóa."""
        return Finding(
            error_type=error_type,
            rule=rule,
            severity=severity,
            frame=frame,
            label=label,
            message=message,
            track_id=track_id,
            source_id=source_id,
            value=value,
            threshold=threshold,
            details=details or {},
        )
