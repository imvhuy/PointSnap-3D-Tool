"""Xem nhanh point cloud quanh box của một finding, không cần mở CVAT (A14)."""

from __future__ import annotations

import io
import math
import os
import threading
from pathlib import Path
from typing import Any

import numpy as np

from pointsnap.adapters.cvat.reader import ManifestFrames, find_manifest
from pointsnap.cli.common import export_dirs
from pointsnap.core.model import Cuboid
from pointsnap.core.serialize import load_cuboids
from pointsnap.web.storage import read_json, StorageError, write_json


class PreviewError(ValueError):
    """Không dựng được bản xem nhanh (thiếu snapshot, manifest, box hoặc point cloud)."""


def points_around_box(
    points: np.ndarray, cuboid: Cuboid, margin_m: float = 2.0, max_points: int = 4000
) -> np.ndarray:
    """Điểm quanh box, đổi sang hệ của box: x dọc chiều dài, y theo chiều rộng, z lên; gốc là tâm box.

    Giữ điểm trong footprint nới thêm `margin_m` và cao từ đáy − 1,5 m tới đỉnh + 1 m; quá `max_points` thì lấy đều.
    """
    pts = np.asarray(points, dtype=np.float64)[:, :3] - np.asarray(cuboid.center, dtype=np.float64)
    c, s = math.cos(-cuboid.yaw), math.sin(-cuboid.yaw)
    local = np.column_stack((c * pts[:, 0] - s * pts[:, 1], s * pts[:, 0] + c * pts[:, 1], pts[:, 2]))
    length, width, height = cuboid.dims
    keep = (
        (np.abs(local[:, 0]) <= length / 2 + margin_m)
        & (np.abs(local[:, 1]) <= width / 2 + margin_m)
        & (local[:, 2] >= -height / 2 - 1.5)
        & (local[:, 2] <= height / 2 + 1.0)
    )
    local = local[keep]
    if len(local) > max_points:
        local = local[np.linspace(0, len(local) - 1, max_points).astype(int)]
    return local


def preview_ground(finding: dict[str, Any], box: Cuboid) -> dict[str, float] | None:
    """Mặt đất đo được của finding lơ lửng / lún, theo hệ của box: độ cao tại tâm (z, gốc ở tâm box) và độ dốc dọc
    thân box (độ, dương = đầu box phía cao) để vẽ đường mặt đất nghiêng; `None` nếu finding không đo mặt đất."""
    details = finding.get("details") or {}
    ground_z = details.get("ground_z")
    if not isinstance(ground_z, (int, float)) or isinstance(ground_z, bool) or not math.isfinite(ground_z):
        return None
    pitch = details.get("pitch_deg")
    ok_pitch = isinstance(pitch, (int, float)) and not isinstance(pitch, bool) and math.isfinite(pitch)
    return {"z": round(float(ground_z) - box.center[2], 3), "pitch_deg": round(float(pitch), 2) if ok_pitch else 0.0}


def _find_box(cuboids: list[Cuboid], finding: dict[str, Any]) -> Cuboid | None:
    """Box của finding: đúng frame và track (hoặc id shape lẻ), không thay bằng frame gần nhất."""
    frame, track_id, source_id = finding.get("frame"), finding.get("track_id"), finding.get("source_id")
    boxes = [c for c in cuboids if not c.outside]
    if track_id is None:
        if source_id is None:
            return None
        return next((c for c in boxes if c.source_id == source_id and c.frame == frame), None)
    same_track = [c for c in boxes if c.track_id == track_id]
    if not same_track:
        return None
    return next((c for c in same_track if c.frame == frame), None)


def _missing_box(finding: dict[str, Any]) -> Cuboid | None:
    """Box tham khảo của cụm không có nhãn: đúng frame, tọa độ sensor; không chọn box khác trong snapshot."""
    if finding.get('rule') != 'lidar.missing' or finding.get('track_id') is not None or finding.get('source_id') is not None:
        return None
    details = finding.get('details') or {}
    try:
        frames = details['frames']
        centers = details['centers_3d']
        dims = details['size_m']
        yaw = details['yaw_rad']
        if (not all(type(f) is int and f >= 0 for f in frames) or len(set(frames)) != len(frames)
                or len(centers) != len(frames) or len(yaw) != len(frames)):
            raise ValueError('invalid cluster frame evidence')
        i = frames.index(finding['frame'])
        values = [*centers[i], *dims, yaw[i]]
        if len(centers[i]) != 3 or len(dims) != 3 or not all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in values):
            raise ValueError('invalid cluster geometry')
        return Cuboid(center=tuple(centers[i]), dims=tuple(dims), yaw=yaw[i], label=finding['label'], frame=frames[i])
    except (KeyError, TypeError, ValueError, IndexError) as exc:
        raise PreviewError('Cụm thiếu bằng chứng 3D hợp lệ ở frame này; hãy quét lại') from exc


def _finding_box(run_dir: Path, project: dict[str, Any], index: int) -> tuple[dict[str, Any], Cuboid, ManifestFrames]:
    """Finding số `index` của lần quét, box của nó trong bản chụp nhãn và nguồn frame (manifest của bản xuất)."""
    findings_path, snapshot_path = run_dir / "findings.json", run_dir / "snapshot.json"
    if not findings_path.is_file() or not snapshot_path.is_file():
        raise PreviewError("Lần quét này thiếu findings.json hoặc snapshot.json")
    findings = read_json(findings_path, list)
    if not 0 <= index < len(findings):
        raise PreviewError(f"Không có mục số {index}")
    finding = findings[index]

    try:
        cuboids, meta = load_cuboids(snapshot_path)
    except (KeyError, TypeError, ValueError) as exc:
        raise PreviewError("snapshot.json không hợp lệ; hãy quét lại") from exc
    box = _find_box(cuboids, finding)
    if box is None:
        box = _missing_box(finding)
    if box is None:
        raise PreviewError("Không tìm thấy box của mục này trong bản chụp nhãn")

    manifest = find_manifest(meta.get("task_id"), export_dirs(project.get("export_dirs") or None), url=meta.get("url"))
    if manifest is None:
        raise PreviewError("Không tìm thấy manifest.json của task: kiểm tra thư mục bản xuất ở tab Kết nối CVAT")
    dataroot = project.get("nuscenes_root") or os.environ.get("NUSCENES_ROOT") or None
    try:
        frames = ManifestFrames(manifest, dataroot=dataroot)
    except (OSError, KeyError, ValueError) as exc:
        raise PreviewError(f"Không đọc được manifest.json của task: {exc}") from exc
    return finding, box, frames


# Cạnh của box theo thứ tự góc của `geometry.corners` (0–3 đáy, 4–7 nóc; góc 0, 3, 4, 7 ở mặt đầu box).
_BOX_EDGES = [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4), (0, 4), (1, 5), (2, 6), (3, 7)]
_FRONT_EDGES = {(0, 3), (3, 0), (4, 7), (7, 4), (0, 4), (3, 7)}


def finding_camera(run_dir: Path, project: dict[str, Any], index: int, full: bool = False) -> tuple[bytes, str]:
    """Ảnh camera thấy box của finding rõ nhất, vẽ khung 3D (mặt đầu box màu đỏ); trả (JPEG, kênh camera).

    Mặc định cắt quanh box (nới 60%, tối thiểu 360 px) và thu về rộng tối đa 720 px; `full` trả cả ảnh, rộng tối đa
    1600 px. Cần Pillow (`pip install pointsnap[vision]`) và ảnh camera của bản xuất trong thư mục nuScenes.
    """
    from pointsnap.core.camera import project_box
    from pointsnap.core.geometry import corners

    try:
        from PIL import Image, ImageDraw
    except ImportError as exc:
        raise PreviewError("Xem ảnh camera cần Pillow: pip install \"pointsnap[vision]\"") from exc

    _, box, frames = _finding_box(run_dir, project, index)
    try:
        pose = frames.frame_data(box.frame, with_points=False).sensor_to_world
        views = frames.camera_views(box.frame)
    except (OSError, KeyError, ValueError, AttributeError) as exc:
        raise PreviewError(f"Không đọc được ảnh camera frame {box.frame}: {exc}") from exc
    if pose is None or not views:
        raise PreviewError("Bản xuất này không có ảnh camera hoặc vị trí xe thu cho frame này")

    best = None
    for view in views:
        proj = project_box(box, pose, view)
        if proj is None:
            continue
        x1, y1, x2, y2 = proj.box
        score = (x2 - x1) * (y2 - y1) * proj.inside_ratio
        if best is None or score > best[0]:
            best = (score, view, proj)
    if best is None:
        raise PreviewError("Không camera nào thấy box này (box ở sau hoặc ngoài khung hình mọi camera)")
    _, view, proj = best

    try:
        image = Image.open(view.path).convert("RGB")
    except OSError as exc:
        raise PreviewError(f"Không mở được ảnh {view.path.name}: {exc}") from exc
    draw = ImageDraw.Draw(image)
    pixels = [tuple(map(float, p)) for p in proj.polygon]
    width = max(2, round(image.width / 640))
    for a, b in _BOX_EDGES:
        if (a, b) not in _FRONT_EDGES:
            draw.line([pixels[a], pixels[b]], fill=(255, 196, 0), width=width)
    for a, b in _BOX_EDGES:
        if (a, b) in _FRONT_EDGES:
            draw.line([pixels[a], pixels[b]], fill=(235, 40, 40), width=width + 1)
    del draw

    if not full:
        x1, y1, x2, y2 = proj.box
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        half = max((x2 - x1) * 0.8, (y2 - y1) * 0.8, 180.0)
        image = image.crop((max(0, int(cx - half)), max(0, int(cy - half)),
                            min(image.width, int(cx + half)), min(image.height, int(cy + half))))
    limit = 1600 if full else 720
    if image.width > limit:
        image = image.resize((limit, round(image.height * limit / image.width)))
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=85)
    return out.getvalue(), view.channel


def finding_preview(run_dir: Path, project: dict[str, Any], index: int) -> dict[str, Any]:
    finding, box, frames = _finding_box(run_dir, project, index)
    try:
        points = frames.frame_data(box.frame).points
    except (OSError, KeyError, ValueError) as exc:
        raise PreviewError(f"Không đọc được point cloud frame {box.frame}: {exc}") from exc

    local = points_around_box(points, box)
    return {
        "ground": preview_ground(finding, box) if box.frame == finding.get("frame") else None,
        "frame": box.frame,
        "exact_frame": box.frame == finding.get("frame"),
        "label": box.label,
        "distance_m": round(math.hypot(box.center[0], box.center[1]), 1),
        "track_id": box.track_id,
        "synthetic_box": finding.get('rule') == 'lidar.missing' and box.track_id is None and box.source_id is None,
        "box": {"length": box.dims[0], "width": box.dims[1], "height": box.dims[2]},
        "points": np.round(local, 2).tolist(),
    }


def reviews_need_review(run_dir: Path) -> bool:
    source = run_dir / "findings.json"
    return ((run_dir / "reviews.json").is_file() and source.is_file()
            and not (run_dir / "reviews-index-v1.json").is_file()
            and any(f.get("rule", "").startswith("track.") for f in read_json(source, list)))


def load_reviews(run_dir: Path) -> dict[str, str]:
    path = run_dir / "reviews.json"
    reviews = read_json(path) if path.is_file() else {}
    if any(not key.isdigit() or value not in ("ok", "fp") for key, value in reviews.items()):
        raise StorageError("reviews.json có kết luận không hợp lệ")
    source = run_dir / "findings.json"
    marker = run_dir / "reviews-index-v1.json"
    if source.is_file() and not marker.is_file():
        findings = read_json(source, list)
        if any(f.get("rule", "").startswith("track.") for f in findings):
            return {}
    return reviews


_REVIEWS_LOCK = threading.Lock()


def save_review(run_dir: Path, index: int, verdict: str | None) -> dict[str, str]:
    """Ghi kết luận xem tay của một mục (`ok` = đúng là lỗi, `fp` = báo nhầm, `None` = bỏ).

    Khóa đọc-sửa-ghi để hai yêu cầu cùng lúc (bấm phím nhanh, nhiều tab, extension) không ghi đè nhau;
    ghi ra file tạm rồi thay thế để file không bao giờ bị ghi dở.
    """
    with _REVIEWS_LOCK:
        reviews = load_reviews(run_dir)
        if not (run_dir / "reviews-index-v1.json").is_file():
            old = run_dir / "reviews.json"
            if old.is_file():
                write_json(run_dir / "reviews-legacy.json", read_json(old))
            write_json(run_dir / "reviews-index-v1.json", {"schema_version": 1})
        if verdict is None:
            reviews.pop(str(index), None)
        else:
            reviews[str(index)] = verdict
        write_json(run_dir / "reviews.json", reviews)
        return reviews
