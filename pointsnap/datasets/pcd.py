"""Ghi / đọc file PCD nhị phân, đúng định dạng CVAT tự sinh khi chuyển file `.bin`.

Tiêu đề giống hệt `PcdReader.convert_bin_to_pcd_file` trong mã nguồn CVAT
(`utils/dataset_manifest/utils.py`): PCD 0.7, trường `x y z intensity` kiểu float32, `DATA binary`.
Không để CVAT tự chuyển file `.pcd.bin` của nuScenes: CVAT đọc 4 số mỗi điểm, còn nuScenes có 5.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

FIELDS = ("x", "y", "z", "intensity")


def _header(num_points: int) -> bytes:
    lines = [
        "VERSION 0.7",
        "FIELDS x y z intensity",
        "SIZE 4 4 4 4",
        "TYPE F F F F",
        "COUNT 1 1 1 1",
        f"WIDTH {num_points}",
        "HEIGHT 1",
        "VIEWPOINT 0 0 0 1 0 0 0",
        f"POINTS {num_points}",
        "DATA binary",
    ]
    return ("\n".join(lines) + "\n").encode("ascii")


def write_pcd(path: str | Path, points: np.ndarray) -> None:
    """Ghi point cloud (N, ≥3). Cột thứ 4 (nếu có) là intensity, không có thì ghi 0."""
    pts = np.asarray(points)
    if pts.ndim != 2 or pts.shape[1] < 3:
        raise ValueError(f"points phải có shape (N, ≥3), nhận {pts.shape}")
    if pts.dtype.kind not in "fiu" or not np.isfinite(pts[:, :4]).all() or np.any(np.abs(pts[:, :4]) > np.finfo(np.float32).max):
        raise ValueError("PCD cần tọa độ/intensity hữu hạn biểu diễn được bằng float32")
    data = np.zeros((len(pts), 4), dtype='<f4')
    data[:, : min(4, pts.shape[1])] = pts[:, :4]
    Path(path).write_bytes(_header(len(pts)) + data.tobytes())


def read_pcd(path: str | Path) -> np.ndarray:
    """Đọc file PCD nhị phân `x y z intensity` float32 (định dạng do `write_pcd` ghi). Trả về (N, 4)."""
    raw = Path(path).read_bytes()
    header: dict[str, str] = {}
    offset = 0
    while True:
        try:
            end = raw.index(b"\n", offset)
            line = raw[offset:end].decode("ascii").strip()
        except (ValueError, UnicodeDecodeError) as exc:
            raise ValueError(f"{path}: thiếu hoặc hỏng header PCD") from exc
        offset = end + 1
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition(" ")
        header[key.upper()] = value
        if key.upper() == "DATA":
            break
    if header.get("DATA") != "binary" or header.get("FIELDS") != " ".join(FIELDS):
        raise ValueError(f"{path}: chỉ đọc được PCD binary với FIELDS {' '.join(FIELDS)}")
    if (header.get("SIZE") != '4 4 4 4' or header.get("TYPE") != 'F F F F'
            or header.get("COUNT", '1 1 1 1') != '1 1 1 1'):
        raise ValueError(f"{path}: chỉ đọc được 4 trường float32, COUNT=1 mỗi trường")
    try:
        count = int(header["POINTS"])
        width, height = int(header["WIDTH"]), int(header["HEIGHT"])
    except (KeyError, ValueError) as exc:
        raise ValueError(f"{path}: thiếu hoặc sai POINTS/WIDTH/HEIGHT") from exc
    if count < 0 or width < 0 or height <= 0 or width * height != count:
        raise ValueError(f"{path}: WIDTH×HEIGHT không khớp POINTS")
    data = np.frombuffer(raw, dtype='<f4', offset=offset)
    if data.size != count * 4:
        raise ValueError(f"{path}: tiêu đề ghi {count} điểm nhưng dữ liệu có {data.size / 4:g} điểm")
    if not np.isfinite(data).all():
        raise ValueError(f"{path}: dữ liệu có NaN hoặc Inf")
    return data.reshape(count, 4)
