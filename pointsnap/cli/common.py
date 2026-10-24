"""Phần dùng chung của các lệnh quét: tìm point cloud cho job CVAT."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Sequence

from pointsnap.adapters.cvat.reader import JobData, ManifestFrames, find_manifest
from pointsnap.core.model import FrameSource

DEFAULT_EXPORT_DIR = Path("data/cvat")


def export_dirs(custom_dirs: Sequence[Path | str] | None = None) -> list[Path]:
    """Nơi tìm bản xuất `to-cvat`: `custom_dirs` nếu có, không thì biến môi trường `POINTSNAP_EXPORT_DIR`
    (nhiều thư mục cách nhau bởi `os.pathsep`), rồi `data/cvat` (mặc định của `nuscenes to-cvat --out`).
    """
    if custom_dirs is not None:
        dirs = [Path(p) for p in custom_dirs if p]
    else:
        dirs = [Path(p) for p in os.environ.get("POINTSNAP_EXPORT_DIR", "").split(os.pathsep) if p]
    return dirs + [DEFAULT_EXPORT_DIR]


def frames_for_job(
    job: JobData,
    manifest: Path | None = None,
    custom_export_dirs: Sequence[Path | str] | None = None,
    dataroot: str | Path | None = None,
) -> tuple[FrameSource | None, str]:
    """Nguồn point cloud cho job: `manifest` nếu có, không thì tìm bản xuất đã tạo task của job.

    Trả về `(frames, thông báo)`; `frames` là `None` khi không tìm được hoặc frame không khớp, khi đó luật lơ lửng /
    lún bị bỏ qua và luật đứt track chỉ báo mức Cảnh báo.
    """
    path = manifest or find_manifest(job.task_id, export_dirs(custom_export_dirs), url=job.url or None)
    # Operator khai báo cặp backend/web URL cho cùng CVAT khi container dùng DNS nội bộ.
    # Chỉ fallback cho đúng backend đó; project server khác vẫn cần manifest của chính nó.
    if (path is None and os.environ.get('CVAT_WEB_URL')
            and job.url.rstrip('/') == os.environ.get('CVAT_URL', '').rstrip('/')):
        path = find_manifest(job.task_id, export_dirs(custom_export_dirs), url=os.environ['CVAT_WEB_URL'])
    skipped = ("bỏ qua luật lơ lửng / lún và hướng/fit dùng LiDAR; "
               "luật chuyển động dùng tọa độ từng frame khi thiếu pose; gate kiểm tra dữ liệu theo luật đang bật")
    if path is None:
        return None, (f"Không tìm thấy manifest.json của task {job.task_id} ({skipped}). "
                      "Chỉ đường dẫn bằng --manifest hoặc cấu hình thư mục bản xuất.")
    try:
        effective_dataroot = str(dataroot) if dataroot else (os.environ.get("NUSCENES_ROOT") or None)
        frames = ManifestFrames(path, dataroot=effective_dataroot)
        if job.frame_names:
            frames.check_matches(job.frame_names)
    except (OSError, KeyError, ValueError) as exc:
        return None, f"Không đọc được point cloud từ {path}: {exc} ({skipped})."
    return frames, f"Point cloud: {path}"
