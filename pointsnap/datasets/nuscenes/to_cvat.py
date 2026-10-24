"""Chuyển một cảnh nuScenes sang CVAT (việc A2).

Hai bước, tách riêng để bước 1 chạy được khi chưa có CVAT:
1. `export_scene`: ghi `.pcd` cho từng keyframe, `manifest.json` (frame ↔ file ↔ `sample_token` ↔ pose),
   `ground_truth.json` (nhãn chuẩn) và file zip để tải lên CVAT.
2. `upload_scene`: tạo task 3D, tải zip, chờ CVAT xử lý, nạp nhãn chuẩn dạng track.
"""

from __future__ import annotations

import json
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from pointsnap.adapters.cvat.client import CvatClient, CvatError
from pointsnap.adapters.cvat.shapes import cuboid_to_points
from pointsnap.adapters.nuscenes.reader import NuScenesReader
from pointsnap.core.geometry import (
    LIDAR_TO_EGO_ROT,
    rotate_cuboid_to_ego,
    rotate_points_z90,
    rotate_pose_to_ego,
)
from pointsnap.core.model import Cuboid, add_track_markers, group_by_track
from pointsnap.core.serialize import load_cuboids, save_cuboids
from pointsnap.datasets.pcd import write_pcd
from pointsnap.datasets.taxonomy import SPEC_VN_CLASSES

TASK_CLASSES = (
    "car", "truck", "bus", "trailer", "construction_vehicle",
    "pedestrian", "motorcycle", "bicycle", "traffic_cone", "barrier",
)
REVIEWED_ATTRIBUTE = "reviewed"


def label_specs(flag_attribute: str, taxonomy: str = "nuscenes") -> list[dict[str, Any]]:
    """Label của task, mỗi label có thuộc tính cờ lỗi (văn bản) và `reviewed` (checkbox).

    Cả hai là thuộc tính `mutable`: giá trị có thể khác nhau ở từng frame của một track.
    `taxonomy="spec-vn"`: 5 class của spec giao thông VN, mỗi class thêm thuộc tính chọn (`select`, mutable) theo
    `datasets.taxonomy.SPEC_VN_CLASSES`, giá trị đầu là mặc định.
    """
    attributes = [
        {"name": flag_attribute, "mutable": True, "input_type": "text", "default_value": "", "values": [""]},
        {"name": REVIEWED_ATTRIBUTE, "mutable": True, "input_type": "checkbox", "default_value": "false",
         "values": ["false"]},
    ]
    if taxonomy == "spec-vn":
        return [{"name": name, "type": "cuboid", "attributes": [
            *({"name": attr, "mutable": True, "input_type": "select", "default_value": values[0],
               "values": list(values)} for attr, values in spec.items()),
            *attributes,
        ]} for name, spec in SPEC_VN_CLASSES.items()]
    return [{"name": name, "type": "cuboid", "attributes": attributes} for name in TASK_CLASSES]


@dataclass(frozen=True)
class SceneExport:
    scene: str
    directory: Path
    archive: Path
    manifest: Path
    ground_truth: Path
    num_frames: int
    num_boxes: int
    num_images: int = 0


def export_scene(reader: NuScenesReader, scene: str, out_dir: str | Path, with_images: bool = True) -> SceneExport:
    """Ghi dữ liệu của cảnh vào `out_dir/<scene>/`.

    Dữ liệu được xoay sang hệ xe thu (x hướng trước, y sang trái, z hướng lên, QĐ-008)
    để hiển thị đúng trên canvas 3D của CVAT.

    Với `with_images`, file zip kèm ảnh của các camera chụp cùng keyframe làm ảnh ngữ cảnh (context image) của CVAT:
    `pointcloud/000000.pcd` và `related_images/000000_pcd/CAM_FRONT.jpg`, … Ảnh không có trên máy thì bỏ qua.
    """
    directory = Path(out_dir) / scene
    pointcloud_dir = directory / "pointcloud"
    pointcloud_dir.mkdir(parents=True, exist_ok=True)

    refs = reader.samples(scene)
    frames = []
    for ref in refs:
        filename = f"{ref.frame:06d}.pcd"  # CVAT sắp frame theo tên file
        points_ego = rotate_points_z90(reader.load_points(ref))
        write_pcd(pointcloud_dir / filename, points_ego)
        sensor_to_world_ego = rotate_pose_to_ego(ref.sensor_to_world)
        images = {}
        if with_images:
            images = {channel: path.relative_to(reader.dataroot).as_posix()
                      for channel, path in reader.camera_images(ref).items() if path.is_file()}
        frames.append({
            "frame": ref.frame,
            "file": filename,
            "sample_token": ref.sample_token,
            "timestamp": ref.timestamp,
            "sensor_to_world": sensor_to_world_ego.tolist(),
            "images": images,
        })

    manifest = directory / "manifest.json"
    manifest.write_text(json.dumps({
        "scene": scene,
        "dataroot": str(reader.dataroot),
        "version": reader.version,
        "num_frames": len(refs),
        "coordinate_system": "ego",
        "transform": LIDAR_TO_EGO_ROT.tolist(),
        "frames": frames,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    cuboids = [rotate_cuboid_to_ego(c) for c in reader.annotations(scene)]
    ground_truth = directory / "ground_truth.json"
    save_cuboids(
        ground_truth,
        cuboids,
        meta={"scene": scene, "source": "nuscenes", "coordinate_system": "ego", "num_frames": len(refs),
              "taxonomy": reader.taxonomy},
    )

    archive = directory / f"{scene}.zip"
    num_images = 0
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as zf:
        for frame in frames:
            zf.write(pointcloud_dir / frame["file"], arcname=f"pointcloud/{frame['file']}")
            context_dir = f"related_images/{Path(frame['file']).stem}_pcd"
            for channel, filename in frame["images"].items():
                zf.write(reader.dataroot / filename, arcname=f"{context_dir}/{channel}{Path(filename).suffix}")
                num_images += 1

    return SceneExport(scene, directory, archive, manifest, ground_truth, len(refs), len(cuboids), num_images)



def _shape(cuboid: Cuboid, outside: bool, attribute_ids: Mapping[str, int] | None = None) -> dict[str, Any]:
    """Shape cuboid của CVAT; `attribute_ids` (tên → id thuộc tính của label) để ghi các thuộc tính có trong
    `cuboid.attrs` (vd `subtype` khi nạp nhãn theo spec VN)."""
    attribute_ids = attribute_ids or {}
    return {
        "type": "cuboid",
        "frame": cuboid.frame,
        "points": cuboid_to_points(cuboid),
        "outside": outside,
        "occluded": bool(cuboid.attrs.get("occluded", False)),
        "z_order": 0,
        "rotation": 0.0,
        "attributes": [{"spec_id": spec_id, "value": str(cuboid.attrs[name])}
                       for name, spec_id in attribute_ids.items() if name in cuboid.attrs],
    }


def build_tracks(
    cuboids: Iterable[Cuboid], num_frames: int, label_ids: Mapping[str, int],
    attribute_ids: Mapping[str, Mapping[str, int]] | None = None,
) -> list[dict[str, Any]]:
    """Gom box thành track của CVAT, đánh dấu đoạn vắng theo spec 4.4 (`core.model.add_track_markers`).

    Trong CVAT, một track kéo dài tới frame cuối của job cho tới khi gặp keyframe `outside`. Vì vậy:
    - sau frame cuối của track (nếu chưa phải frame cuối cảnh) thêm một keyframe `outside`;
    - track khuyết ≤ 6 frame ở giữa: thêm keyframe `occluded` (vị trí nội suy) ở frame đầu đoạn vắng, giữ track;
    - khuyết lâu hơn: `outside` sau frame có mặt cuối cùng, phần sau thành track mới.
    """
    tracks = []
    for track_id, boxes in group_by_track(add_track_markers(cuboids, num_frames)).items():
        labels = {b.label for b in boxes}
        if len(labels) != 1:
            raise ValueError(f"Track {track_id} có nhiều class: {sorted(labels)}")
        attrs = (attribute_ids or {}).get(boxes[0].label)
        shapes = [_shape(box, outside=box.outside, attribute_ids=attrs) for box in boxes]
        tracks.append({
            "frame": boxes[0].frame,
            "label_id": label_ids[boxes[0].label],
            "group": 0,
            "source": "manual",
            "attributes": [],
            "shapes": shapes,
        })
    return tracks


def build_annotations(
    cuboids: list[Cuboid], num_frames: int, label_ids: Mapping[str, int],
    attribute_ids: Mapping[str, Mapping[str, int]] | None = None,
) -> dict[str, Any]:
    """Dữ liệu cho `PUT /api/tasks/<id>/annotations`: box có track thành track, box lẻ thành shape."""
    attribute_ids = attribute_ids or {}
    shapes = [{**_shape(c, outside=False, attribute_ids=attribute_ids.get(c.label)), "label_id": label_ids[c.label],
               "group": 0, "source": "manual"} for c in cuboids if c.track_id is None]
    shapes = [{k: v for k, v in s.items() if k != "outside"} for s in shapes]
    return {"version": 0, "tags": [], "shapes": shapes,
            "tracks": build_tracks(cuboids, num_frames, label_ids, attribute_ids)}


def upload_scene(
    client: CvatClient,
    export: SceneExport,
    task_name: str,
    flag_attribute: str,
    timeout: float = 900.0,
) -> dict[str, Any]:
    """Tạo task 3D trên CVAT từ bản xuất, nạp nhãn chuẩn. Ghi `cvat_task.json` cạnh bản xuất."""
    cuboids, meta = load_cuboids(export.ground_truth)
    taxonomy = meta.get("taxonomy", "nuscenes")
    task = client.create_task(task_name, label_specs(flag_attribute, taxonomy))
    try:
        rq_id = client.upload_task_data(task["id"], export.archive)
        client.wait_request(rq_id, timeout=timeout)
        labels = client.task_labels(task["id"])
        label_ids = {label["name"]: label["id"] for label in labels}
        attribute_ids = {label["name"]: {a["name"]: a["id"] for a in label.get("attributes", [])
                                         if a["name"] not in (flag_attribute, REVIEWED_ATTRIBUTE)} for label in labels}
        client.put_task_annotations(task["id"], build_annotations(cuboids, export.num_frames, label_ids, attribute_ids))
        info = {
            "url": client.url,
            "task_id": task["id"],
            "job_ids": [job["id"] for job in client.task_jobs(task["id"])],
            "scene": export.scene,
            "num_frames": export.num_frames,
            "num_boxes": len(cuboids),
        }
        if not info["job_ids"]:
            raise CvatError(f"Task {task['id']} đã upload nhưng không có job")
        (export.directory / "cvat_task.json").write_text(json.dumps(info, indent=1), encoding="utf-8")
        return info
    except Exception as exc:
        try:
            client.delete_task(task["id"])
        except Exception as cleanup_exc:
            raise CvatError(f"Upload task {task['id']} thất bại; chưa xóa được task thử: {cleanup_exc}") from exc
        raise
