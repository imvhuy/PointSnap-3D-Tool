"""Đọc PandaSet (Scale AI / Hesai) trực tiếp từ thư mục dữ liệu, cùng kiểu dữ liệu với `adapters.nuscenes`.

PandaSet: 103 cảnh × 80 frame (10 Hz, 8 s), LiDAR quay 360° Pandar64 (64 tia) + LiDAR trước PandarGT, 6 camera, nhãn cuboid
có `uuid` theo track ở **mọi** frame. Dày gấp đôi `LIDAR_TOP` 32 tia của nuScenes, nên `box_fit` đo được nhiều box hơn.

Cấu trúc một cảnh (theo pandaset-devkit, không cần cài devkit)::

    <root>/<cảnh>/lidar/00.pkl.gz … 79.pkl.gz      DataFrame x, y, z, i, t, d (d = 0 Pandar64, 1 PandarGT); hệ toàn cục
    <root>/<cảnh>/lidar/poses.json                   pose LiDAR → toàn cục mỗi frame: position {x,y,z}, heading {w,x,y,z}
    <root>/<cảnh>/lidar/timestamps.json
    <root>/<cảnh>/annotations/cuboids/00.pkl.gz …   DataFrame một dòng / box, hệ toàn cục (cột ở `_to_cuboid`)
    <root>/<cảnh>/camera/<tên>_camera/00.jpg …, intrinsics.json (fx, fy, cx, cy), poses.json (camera → toàn cục)

Bản Kaggle (`pz19930809/pandaset`) giữ cấu trúc này dưới `PandaSet/` nhưng file là `.pkl` (không nén): đọc được cả hai.

Điểm và box được đổi về **hệ LiDAR của từng frame** (gốc ở cảm biến, như nuScenes): `box_fit` coi gốc tọa độ là vị trí
cảm biến để chọn mặt box nhìn thấy được.

File `.pkl.gz` là pickle của pandas, nên cần `pandas` (`pip install pandas`) và **chỉ đọc dữ liệu tải từ nguồn chính thức**:
mở pickle là chạy code trong file.
"""

from __future__ import annotations

import json
import math
from functools import cached_property, lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from pointsnap.core.camera import CameraView
from pointsnap.core.geometry import invert_pose, pose_matrix, transform_points
from pointsnap.core.model import Cuboid, FrameData

LABELS: dict[str, str] = {
    "Car": "car",
    "Pickup Truck": "car",  # nuScenes xếp xe bán tải vào car
    "Medium-sized Truck": "truck",
    "Semi-truck": "truck",
    "Towed Object": "trailer",
    "Bus": "bus",
    "Other Vehicle - Construction Vehicle": "construction_vehicle",
    "Motorcycle": "motorcycle",
    "Motorized Scooter": "motorcycle",
    "Bicycle": "bicycle",
    "Pedestrian": "pedestrian",
    "Pedestrian with Object": "pedestrian",
    "Cones": "traffic_cone",
    "Pylons": "traffic_cone",
    "Temporary Construction Barriers": "barrier",
    "Road Barriers": "barrier",
}
"""Class PandaSet → 10 class nuScenes của task. Class khác (xe lạ, xe cấp cứu, tàu điện, biển báo…) giữ làm vật cản."""

OBSTACLE_LABEL = "obstacle"
"""Box của class ngoài `LABELS` (`attrs["obstacle"]`): giữ để điểm của nó không bị tính vào vật bên cạnh (riêng cảnh 001
frame 00 có 27 box "Other Vehicle - Uncommon"), nhưng đánh giá không chấm box này."""

LIDARS = {"pandar64": (0,), "both": (0, 1)}
"""`d` của điểm: 0 = Pandar64 quay 360° (gần với LIDAR_TOP nuScenes), 1 = PandarGT nhìn trước."""

CAMERAS = ("front_camera", "front_left_camera", "front_right_camera", "left_camera", "right_camera", "back_camera")
IMAGE_SIZE = (1920, 1080)


def _pickle_path(folder: Path, frame: int) -> Path:
    """`00.pkl.gz` (bản tải từ trang PandaSet) hoặc `00.pkl` (bản Kaggle đã giải nén)."""
    gz = folder / f"{frame:02d}.pkl.gz"
    return gz if gz.is_file() else folder / f"{frame:02d}.pkl"


def _read_pickle(path: Path):
    try:
        import pandas as pd
    except ImportError as exc:  # pragma: no cover - phụ thuộc môi trường
        raise ImportError("Đọc PandaSet cần pandas: pip install pandas") from exc
    return pd.read_pickle(path)


def _pose(record: dict[str, Any]) -> np.ndarray:
    p, q = record["position"], record["heading"]
    return pose_matrix((p["x"], p["y"], p["z"]), (q["w"], q["x"], q["y"], q["z"]))


class PandaSetReader:
    """Đọc các cảnh trong `root` (mỗi thư mục con có `lidar/` là một cảnh).

    `lidar`: `pandar64` (mặc định) hoặc `both` (thêm PandarGT phía trước). Box chỉ có ở PandarGT (`cuboids.sensor_id`
    = 1) bị bỏ khi `lidar` = `pandar64`; box nằm ở vùng hai LiDAR chồng nhau có 2 dòng (`sibling`), giữ dòng của
    Pandar64 (`sensor_id` = -1 hoặc 0).
    `frame_step`: lấy 1 frame mỗi `frame_step` frame (5 → 2 Hz như keyframe nuScenes), số frame đánh lại 0, 1, 2…
    """

    def __init__(self, root: str | Path, lidar: str = "pandar64", frame_step: int = 1) -> None:
        if lidar not in LIDARS:
            raise ValueError(f"lidar phải là một trong {sorted(LIDARS)}")
        if frame_step < 1:
            raise ValueError("frame_step phải ≥ 1")
        self.root = Path(root)
        self.lidar = lidar
        self.frame_step = frame_step

    def scenes(self) -> list[str]:
        return sorted(p.name for p in self.root.iterdir() if (p / "lidar" / "poses.json").is_file())

    def _scene_dir(self, scene: str) -> Path:
        path = self.root / scene
        if not (path / "lidar" / "poses.json").is_file():
            raise FileNotFoundError(f"Không thấy cảnh PandaSet {scene!r} trong {self.root}")
        return path

    @lru_cache(maxsize=8)
    def _poses(self, scene: str, sensor: str = "lidar") -> tuple[np.ndarray, ...]:
        records = json.loads((self._scene_dir(scene) / sensor / "poses.json").read_text(encoding="utf-8"))
        return tuple(_pose(r) for r in records)

    @lru_cache(maxsize=8)
    def _timestamps(self, scene: str, sensor: str = "lidar") -> tuple[float, ...]:
        path = self._scene_dir(scene) / sensor / "timestamps.json"
        return tuple(float(t) for t in json.loads(path.read_text(encoding="utf-8"))) if path.is_file() else ()

    def source_frames(self, scene: str) -> list[int]:
        """Chỉ số frame gốc của PandaSet được dùng, theo `frame_step`."""
        return list(range(0, len(self._poses(scene)), self.frame_step))

    def sensor_to_world(self, scene: str, frame: int) -> np.ndarray:
        return self._poses(scene)[self.source_frames(scene)[frame]]

    def load_points(self, scene: str, frame: int) -> np.ndarray:
        """Điểm LiDAR (N, 4): x, y, z trong hệ LiDAR của frame, cường độ."""
        source = self.source_frames(scene)[frame]
        df = _read_pickle(_pickle_path(self._scene_dir(scene) / "lidar", source))
        if "d" in df.columns:
            df = df[df["d"].isin(LIDARS[self.lidar])]
        world = df[["x", "y", "z"]].to_numpy(dtype=np.float64)
        local = transform_points(world, invert_pose(self.sensor_to_world(scene, frame)))
        intensity = df["i"].to_numpy(dtype=np.float64)[:, None] if "i" in df.columns else np.zeros((len(local), 1))
        points = np.hstack([local, intensity])
        return points[np.isfinite(points[:, :3]).all(axis=1)]

    def frame_data(self, scene: str, frame: int, with_points: bool = True) -> FrameData:
        stamps = self._timestamps(scene)
        source = self.source_frames(scene)[frame]
        return FrameData(
            frame=frame,
            points=self.load_points(scene, frame) if with_points else np.empty((0, 4)),
            sensor_to_world=self.sensor_to_world(scene, frame),
            timestamp=stamps[source] if source < len(stamps) else None,
            source_ref=f"{scene}/{source:02d}",
        )

    def frames(self, scene: str) -> PandaSetFrames:
        return PandaSetFrames(self, scene)

    def camera_views(self, scene: str, frame: int) -> list[CameraView]:
        """Ảnh 6 camera của frame. Ảnh PandaSet đã khử méo; pose camera theo đúng thời điểm chụp ảnh."""
        source = self.source_frames(scene)[frame]
        views = []
        for name in CAMERAS:
            folder = self._scene_dir(scene) / "camera" / name
            image = folder / f"{source:02d}.jpg"
            if not image.is_file() or not (folder / "intrinsics.json").is_file():
                continue
            k = json.loads((folder / "intrinsics.json").read_text(encoding="utf-8"))
            intrinsic = np.array([[k["fx"], 0.0, k["cx"]], [0.0, k["fy"], k["cy"]], [0.0, 0.0, 1.0]])
            views.append(CameraView(channel=name, path=image, intrinsic=intrinsic,
                                    camera_to_world=self._poses(scene, f"camera/{name}")[source],
                                    width=IMAGE_SIZE[0], height=IMAGE_SIZE[1]))
        return views

    # --- Nhãn chuẩn ------------------------------------------------------------------------------

    @cached_property
    def _track_ids(self) -> dict[str, int]:
        return {}

    def _track_id(self, uuid: str) -> int:
        return self._track_ids.setdefault(uuid, len(self._track_ids))

    def annotations(self, scene: str) -> list[Cuboid]:
        """Nhãn chuẩn của cả cảnh (mọi frame được lấy đều là keyframe), mỗi box trong hệ LiDAR của frame chứa nó. Box của
        class ngoài `LABELS` có nhãn `OBSTACLE_LABEL`, `attrs["obstacle"] = True`."""
        cuboids: list[Cuboid] = []
        for frame, source in enumerate(self.source_frames(scene)):
            path = _pickle_path(self._scene_dir(scene) / "annotations" / "cuboids", source)
            if not path.is_file():
                continue
            world_to_sensor = invert_pose(self.sensor_to_world(scene, frame))
            for row in _read_pickle(path).to_dict("records"):
                cuboid = self._to_cuboid(row, frame, world_to_sensor)
                if cuboid is not None:
                    cuboids.append(cuboid)
        return cuboids

    def _to_cuboid(self, row: dict[str, Any], frame: int, world_to_sensor: np.ndarray) -> Cuboid | None:
        label = LABELS.get(str(row.get("label")))
        sensor_id = int(row.get("cuboids.sensor_id", -1))
        if sensor_id == 1 and self.lidar == "pandar64":
            return None
        sibling = row.get("cuboids.sibling_id")
        if sensor_id == 1 and isinstance(sibling, str) and sibling not in ("", "-"):
            return None  # vùng chồng nhau: đã có dòng của Pandar64 (sibling_id là uuid của dòng kia)
        center = transform_points(np.array([[row["position.x"], row["position.y"], row["position.z"]]]),
                                  world_to_sensor)[0]
        # PandaSet: dimensions.x = bề ngang, dimensions.y = chiều dài; yaw = 0 nghĩa là chiều dài theo (0, 1, 0), quay ngược
        # chiều kim đồng hồ. Hướng đầu xe trong hệ toàn cục là yaw + π/2.
        heading_world = float(row["yaw"]) + math.pi / 2.0
        heading = math.atan2(world_to_sensor[1, 0] * math.cos(heading_world) + world_to_sensor[1, 1] * math.sin(heading_world),
                             world_to_sensor[0, 0] * math.cos(heading_world) + world_to_sensor[0, 1] * math.sin(heading_world))
        length, width, height = float(row["dimensions.y"]), float(row["dimensions.x"]), float(row["dimensions.z"])
        if min(length, width, height) <= 0 or not all(map(math.isfinite, (*center, heading))):
            return None
        return Cuboid(
            center=tuple(float(v) for v in center),
            dims=(length, width, height),
            yaw=heading,
            label=label or OBSTACLE_LABEL,
            frame=frame,
            track_id=self._track_id(str(row["uuid"])),
            attrs={"pandaset_uuid": str(row["uuid"]), "pandaset_label": str(row["label"]),
                   "stationary": bool(row.get("stationary", False)), **({"obstacle": True} if label is None else {})},
        )


class PandaSetFrames:
    """`FrameSource` cho một cảnh PandaSet (frame theo `frame_step` của reader)."""

    def __init__(self, reader: PandaSetReader, scene: str) -> None:
        self.reader = reader
        self.scene = scene

    @property
    def num_frames(self) -> int:
        return len(self.reader.source_frames(self.scene))

    def frame_data(self, frame: int, with_points: bool = True) -> FrameData:
        return self.reader.frame_data(self.scene, frame, with_points=with_points)

    def camera_views(self, frame: int) -> list[CameraView]:
        return self.reader.camera_views(self.scene, frame)
