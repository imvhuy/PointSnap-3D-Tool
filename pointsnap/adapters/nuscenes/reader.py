"""Đọc nuScenes trực tiếp từ thư mục dữ liệu (việc B1).

Trả về kiểu dữ liệu của core: `Cuboid` cho nhãn chuẩn (trong hệ LiDAR của từng frame) và `FrameData`
cho point cloud `LIDAR_TOP` kèm ma trận đổi sang hệ toàn cục. Chỉ đọc các bảng JSON và file `.pcd.bin`,
không cần nuscenes-devkit. Quy ước tọa độ: CONVENTIONS.md mục 3.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path, PureWindowsPath
from typing import Any

import numpy as np

from pointsnap.core.camera import CameraView
from pointsnap.core.geometry import invert_pose, pose_matrix
from pointsnap.core.model import Cuboid, FrameData
from pointsnap.datasets.taxonomy import spec_label

TAXONOMIES = ("nuscenes", "spec-vn")

LIDAR_CHANNEL = "LIDAR_TOP"
POINT_FIELDS = 5
"""Mỗi điểm trong `.pcd.bin`: x, y, z, intensity, ring index (float32)."""

CATEGORY_TO_LABEL: dict[str, str] = {
    "vehicle.car": "car",
    "vehicle.truck": "truck",
    "vehicle.bus.bendy": "bus",
    "vehicle.bus.rigid": "bus",
    "vehicle.trailer": "trailer",
    "vehicle.construction": "construction_vehicle",
    "vehicle.motorcycle": "motorcycle",
    "vehicle.bicycle": "bicycle",
    "human.pedestrian.adult": "pedestrian",
    "human.pedestrian.child": "pedestrian",
    "human.pedestrian.construction_worker": "pedestrian",
    "human.pedestrian.police_officer": "pedestrian",
    "movable_object.trafficcone": "traffic_cone",
    "movable_object.barrier": "barrier",
}
"""Category nuScenes → 10 class của task, theo bảng chuẩn của bài toán detection nuScenes.

Category không có trong bảng (động vật, xe cấp cứu, xe đẩy, xe lăn, vật cản rời, giá để xe…) bị bỏ qua.
"""


@dataclass(frozen=True)
class SceneInfo:
    name: str
    token: str
    description: str
    num_frames: int


@dataclass(frozen=True, eq=False)
class SampleRef:
    """Một keyframe của cảnh: số thứ tự frame và các khóa để đọc dữ liệu của frame đó."""

    scene: str
    frame: int
    sample_token: str
    lidar_token: str
    lidar_path: Path
    timestamp: float
    sensor_to_world: np.ndarray


class NuScenesReader:
    """Đọc một bản nuScenes (mặc định v1.0-mini) từ `dataroot`.

    `dataroot` là thư mục chứa `samples/`, `sweeps/` và thư mục bảng (`v1.0-mini/`).
    `min_lidar_points`: bỏ các box có ít điểm LiDAR hơn số này. Mặc định 1, tức bỏ box không có điểm
    nào: người gán nhãn không thấy được các box đó trên point cloud.
    `taxonomy`: `nuscenes` (10 class của bài toán detection nuScenes, mặc định) hoặc `spec-vn` (5 class + thuộc tính
    theo spec gán nhãn giao thông Việt Nam, `datasets.taxonomy`).
    """

    def __init__(self, dataroot: str | Path, version: str = "v1.0-mini", min_lidar_points: int = 1,
                 taxonomy: str = "nuscenes") -> None:
        if taxonomy not in TAXONOMIES:
            raise ValueError(f"taxonomy phải là một trong {TAXONOMIES}, nhận {taxonomy!r}")
        self.dataroot = Path(dataroot).resolve()
        self.version = version
        self.min_lidar_points = min_lidar_points
        self.taxonomy = taxonomy
        self._table_dir = self._dataset_path(version)
        if not self._table_dir.is_dir():
            raise FileNotFoundError(f"Không thấy thư mục bảng nuScenes: {self._table_dir}")
        self._tables: dict[str, dict[str, dict[str, Any]]] = {}

    def _dataset_path(self, filename: str) -> Path:
        if not isinstance(filename, str) or Path(filename).is_absolute() or PureWindowsPath(filename).drive:
            raise ValueError('Đường dẫn dataset phải tương đối trong dataroot')
        path = (self.dataroot / filename).resolve()
        if not path.is_relative_to(self.dataroot):
            raise ValueError('Đường dẫn dataset nằm ngoài phạm vi dataroot')
        return path

    # --- Bảng JSON -------------------------------------------------------------------------------

    def _table(self, name: str) -> dict[str, dict[str, Any]]:
        """Bảng `name` dạng token → bản ghi, giữ thứ tự trong file."""
        if name not in self._tables:
            path = self._dataset_path(f'{self.version}/{name}.json')
            try:
                with path.open(encoding="utf-8") as f:
                    records = json.load(f)
            except FileNotFoundError:
                raise FileNotFoundError(f"Thiếu bảng nuScenes: {path}") from None
            self._tables[name] = {record["token"]: record for record in records}
            if len(self._tables[name]) != len(records):
                raise ValueError(f"Bảng nuScenes {path} có token trùng")
        return self._tables[name]

    @cached_property
    def _scenes_by_name(self) -> dict[str, dict[str, Any]]:
        return {scene["name"]: scene for scene in self._table("scene").values()}

    @cached_property
    def _track_ids(self) -> dict[str, int]:
        """`instance_token` → track id: số thứ tự trong bảng instance, cố định giữa các lần chạy."""
        return {token: index for index, token in enumerate(self._table("instance"))}

    @cached_property
    def _lidar_by_sample(self) -> dict[str, dict[str, Any]]:
        """`sample_token` → bản ghi `sample_data` của keyframe LIDAR_TOP."""
        sensors = self._table("sensor")
        calibrations = self._table("calibrated_sensor")
        lidar_sensors = {token for token, s in sensors.items() if s["channel"] == LIDAR_CHANNEL}
        result = {}
        for record in self._table("sample_data").values():
            if record["is_key_frame"] and calibrations[record["calibrated_sensor_token"]]["sensor_token"] in lidar_sensors:
                result[record["sample_token"]] = record
        return result

    @cached_property
    def _cameras_by_sample(self) -> dict[str, dict[str, str]]:
        """`sample_token` → {kênh camera → đường dẫn tương đối của ảnh keyframe}, kênh sắp theo tên."""
        sensors = self._table("sensor")
        calibrations = self._table("calibrated_sensor")
        result: dict[str, dict[str, str]] = defaultdict(dict)
        for record in self._table("sample_data").values():
            sensor = sensors[calibrations[record["calibrated_sensor_token"]]["sensor_token"]]
            if record["is_key_frame"] and sensor.get("modality") == "camera":
                result[record["sample_token"]][sensor["channel"]] = record["filename"]
        return {token: dict(sorted(cams.items())) for token, cams in result.items()}

    @cached_property
    def _camera_records_by_sample(self) -> dict[str, list[dict[str, Any]]]:
        """`sample_token` → bản ghi `sample_data` của các ảnh camera keyframe, sắp theo kênh."""
        sensors = self._table("sensor")
        calibrations = self._table("calibrated_sensor")
        result: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
        for record in self._table("sample_data").values():
            sensor = sensors[calibrations[record["calibrated_sensor_token"]]["sensor_token"]]
            if record["is_key_frame"] and sensor.get("modality") == "camera":
                result[record["sample_token"]].append((sensor["channel"], record))
        return {token: [r for _, r in sorted(items, key=lambda x: x[0])] for token, items in result.items()}

    def camera_views(self, ref: SampleRef) -> list[CameraView]:
        """Các ảnh camera chụp cùng keyframe, kèm thông số để chiếu box 3D lên ảnh (`core.camera`).

        Pose camera lấy theo `ego_pose` của chính ảnh đó (thời điểm chụp ảnh lệch thời điểm quét LiDAR).
        Ảnh không có trên máy thì bỏ qua.
        """
        sensors = self._table("sensor")
        calibrations = self._table("calibrated_sensor")
        views = []
        for record in self._camera_records_by_sample.get(ref.sample_token, []):
            path = self._dataset_path(record["filename"])
            if not path.is_file():
                continue
            calibration = calibrations[record["calibrated_sensor_token"]]
            channel = sensors[calibration["sensor_token"]]["channel"]
            views.append(CameraView(
                channel=channel, path=path, intrinsic=np.asarray(calibration["camera_intrinsic"], dtype=np.float64),
                camera_to_world=self._sensor_to_world(record), width=int(record["width"]),
                height=int(record["height"]),
            ))
        return views

    def camera_images(self, ref: SampleRef) -> dict[str, Path]:
        """Ảnh camera chụp cùng keyframe với point cloud: {kênh, ví dụ `CAM_FRONT` → đường dẫn file}."""
        return {channel: self._dataset_path(filename)
                for channel, filename in self._cameras_by_sample.get(ref.sample_token, {}).items()}

    @cached_property
    def _annotations_by_sample(self) -> dict[str, list[dict[str, Any]]]:
        result: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for record in self._table("sample_annotation").values():
            result[record["sample_token"]].append(record)
        return result

    # --- Cảnh và frame ---------------------------------------------------------------------------

    def scenes(self) -> list[SceneInfo]:
        return [
            SceneInfo(name=s["name"], token=s["token"], description=s.get("description", ""), num_frames=s["nbr_samples"])
            for s in self._table("scene").values()
        ]

    def _scene(self, name: str) -> dict[str, Any]:
        try:
            return self._scenes_by_name[name]
        except KeyError:
            known = ", ".join(self._scenes_by_name)
            raise KeyError(f"Không có cảnh '{name}'. Các cảnh hiện có: {known}") from None

    def _sensor_to_world(self, lidar: dict[str, Any]) -> np.ndarray:
        calibration = self._table("calibrated_sensor")[lidar["calibrated_sensor_token"]]
        ego = self._table("ego_pose")[lidar["ego_pose_token"]]
        ego_to_world = pose_matrix(ego["translation"], ego["rotation"])
        sensor_to_ego = pose_matrix(calibration["translation"], calibration["rotation"])
        return ego_to_world @ sensor_to_ego

    def samples(self, scene: str) -> list[SampleRef]:
        """Các keyframe của cảnh theo thứ tự thời gian; `frame` đánh số từ 0."""
        samples = self._table("sample")
        refs: list[SampleRef] = []
        scene_info = self._scene(scene)
        token = scene_info["first_sample_token"]
        visited: set[str] = set()
        while token:
            if token in visited or samples[token]["scene_token"] != scene_info["token"]:
                raise ValueError(f"Chuỗi sample của cảnh '{scene}' bị lặp hoặc đi sang cảnh khác: {token}")
            visited.add(token)
            lidar = self._lidar_by_sample.get(token)
            if lidar is None:
                raise ValueError(f"Keyframe {token} của cảnh '{scene}' không có dữ liệu {LIDAR_CHANNEL}")
            timestamp = lidar["timestamp"] / 1e6
            if not math.isfinite(timestamp) or (refs and timestamp <= refs[-1].timestamp):
                raise ValueError(f"Timestamp LiDAR của cảnh '{scene}' phải hữu hạn và tăng theo frame")
            refs.append(
                SampleRef(
                    scene=scene,
                    frame=len(refs),
                    sample_token=token,
                    lidar_token=lidar["token"],
                    lidar_path=self._dataset_path(lidar["filename"]),
                    timestamp=timestamp,
                    sensor_to_world=self._sensor_to_world(lidar),
                )
            )
            token = samples[token]["next"]
        if len(refs) != scene_info["nbr_samples"] or not refs or refs[-1].sample_token != scene_info["last_sample_token"]:
            raise ValueError(f"Chuỗi sample của cảnh '{scene}' không khớp số frame hoặc sample cuối")
        return refs

    def load_points(self, ref: SampleRef) -> np.ndarray:
        """Point cloud của keyframe, mảng (N, 5) float32: x, y, z, intensity, ring index."""
        return self._load_points(ref.lidar_path)

    @staticmethod
    def _load_points(path: Path) -> np.ndarray:
        if path.stat().st_size % (4 * POINT_FIELDS):
            raise ValueError(f"{path}: số byte không chia hết cho 5 float32 mỗi điểm")
        raw = np.fromfile(path, dtype='<f4')
        if raw.size % POINT_FIELDS:
            raise ValueError(f"{path}: số giá trị ({raw.size}) không chia hết cho {POINT_FIELDS}")
        points = raw.reshape(-1, POINT_FIELDS)
        if not np.isfinite(points[:, :4]).all():
            raise ValueError(f"{path}: tọa độ/intensity có NaN hoặc Inf")
        return points

    def load_sweeps(self, ref: SampleRef, count: int) -> list[tuple[float, np.ndarray]]:
        """Tối đa `count` lượt quét LiDAR trung gian (sweep) ngay trước keyframe: [(thời điểm, điểm (N, 3))], điểm đã
        đổi về hệ LiDAR của keyframe, sweep gần keyframe nhất trước.

        LiDAR quay 20 Hz, keyframe 2 Hz: giữa hai keyframe có 9 sweep. Vật đang chạy bị kéo vệt qua các sweep, nên người
        dùng phải bỏ điểm của vật theo vị trí nội suy tại thời điểm từng sweep (`detectors.floating`).
        """
        sample_data = self._table("sample_data")
        world_to_key = invert_pose(ref.sensor_to_world)
        chunks: list[tuple[float, np.ndarray]] = []
        token = sample_data[ref.lidar_token]["prev"]
        visited = {ref.lidar_token}
        while token and len(chunks) < count:
            if token in visited:
                raise ValueError(f"Chuỗi sweep bị lặp: {token}")
            visited.add(token)
            record = sample_data[token]
            path = self._dataset_path(record["filename"])
            if not path.is_file():
                break  # bản tải về thiếu sweep: dùng những gì có
            points = self._load_points(path)[:, :3].astype(np.float64)
            matrix = world_to_key @ self._sensor_to_world(record)
            chunks.append((record["timestamp"] / 1e6, points @ matrix[:3, :3].T + matrix[:3, 3]))
            token = record["prev"]
        return chunks

    def frame_data(self, ref: SampleRef, with_points: bool = True) -> FrameData:
        points = self.load_points(ref) if with_points else np.empty((0, POINT_FIELDS), dtype=np.float32)
        return FrameData(
            frame=ref.frame,
            points=points,
            sensor_to_world=ref.sensor_to_world,
            timestamp=ref.timestamp,
            source_ref=ref.sample_token,
        )

    def frames(self, scene: str) -> NuScenesFrames:
        """Nguồn point cloud + pose theo số frame của cảnh, dùng cho bộ quét (`FrameSource`)."""
        return NuScenesFrames(self, scene)

    # --- Nhãn chuẩn ------------------------------------------------------------------------------

    def category_of(self, annotation: dict[str, Any]) -> str:
        instance = self._table("instance")[annotation["instance_token"]]
        return self._table("category")[instance["category_token"]]["name"]

    def annotations(self, scene: str) -> list[Cuboid]:
        """Nhãn chuẩn của cả cảnh, mỗi box trong hệ LiDAR của frame chứa nó.

        Box có category ngoài `CATEGORY_TO_LABEL` hoặc ít điểm hơn `min_lidar_points` bị bỏ qua, nên
        một track có thể bị khuyết vài frame ở giữa.
        """
        cuboids: list[Cuboid] = []
        for ref in self.samples(scene):
            world_to_sensor = invert_pose(ref.sensor_to_world)
            for annotation in self._annotations_by_sample.get(ref.sample_token, []):
                cuboid = self._to_cuboid(annotation, ref.frame, world_to_sensor)
                if cuboid is not None:
                    cuboids.append(cuboid)
        return cuboids

    def _to_cuboid(self, annotation: dict[str, Any], frame: int, world_to_sensor: np.ndarray) -> Cuboid | None:
        category = self.category_of(annotation)
        extra: dict[str, str] = {}
        if self.taxonomy == "spec-vn":
            attribute_names = [self._table("attribute")[t]["name"] for t in annotation.get("attribute_tokens", [])]
            mapped = spec_label(category, attribute_names)
            label, extra = mapped if mapped is not None else (None, {})
        else:
            label = CATEGORY_TO_LABEL.get(category)
        if label is None or annotation["num_lidar_pts"] < self.min_lidar_points:
            return None
        box_to_sensor = world_to_sensor @ pose_matrix(annotation["translation"], annotation["rotation"])
        rotation = box_to_sensor[:3, :3]
        width, length, height = annotation["size"]  # nuScenes ghi [w, l, h]
        return Cuboid(
            center=tuple(box_to_sensor[:3, 3]),
            dims=(length, width, height),
            yaw=math.atan2(rotation[1, 0], rotation[0, 0]),
            label=label,
            frame=frame,
            track_id=self._track_ids[annotation["instance_token"]],
            attrs={
                "nuscenes_annotation": annotation["token"],
                "nuscenes_instance": annotation["instance_token"],
                "nuscenes_category": category,
                "num_lidar_pts": annotation["num_lidar_pts"],
                # Góc giữa trục z của box và trục z của LiDAR. Core coi box chỉ có yaw nên bỏ phần nghiêng này.
                "tilt_rad": math.acos(max(-1.0, min(1.0, rotation[2, 2]))),
                **extra,
            },
        )


class NuScenesFrames:
    """`FrameSource` cho một cảnh nuScenes: frame → point cloud LiDAR và pose, hệ LiDAR như `annotations`."""

    def __init__(self, reader: NuScenesReader, scene: str) -> None:
        self.reader = reader
        self.refs = {ref.frame: ref for ref in reader.samples(scene)}

    @property
    def num_frames(self) -> int:
        return len(self.refs)

    def frame_data(self, frame: int, with_points: bool = True) -> FrameData:
        return self.reader.frame_data(self.refs[frame], with_points=with_points)

    def ground_sweeps(self, frame: int, sweeps: int) -> list[tuple[float, np.ndarray]]:
        """`sweeps` lượt quét LiDAR trung gian trước keyframe, hệ LiDAR của keyframe: [(thời điểm, điểm (N, 3))]."""
        return self.reader.load_sweeps(self.refs[frame], sweeps)

    def camera_views(self, frame: int) -> list[CameraView]:
        """Ảnh camera của frame (`NuScenesReader.camera_views`)."""
        return self.reader.camera_views(self.refs[frame])
