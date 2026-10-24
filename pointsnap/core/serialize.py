"""Lưu / đọc danh sách `Cuboid` dạng JSON.

Dùng cho nhãn chuẩn kèm theo bản xuất, bản chụp nhãn trước khi ghi cờ (A4) và log lỗi chèn giả (A7).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

from pointsnap.core.model import Cuboid

FORMAT_VERSION = 1


def cuboid_to_dict(cuboid: Cuboid) -> dict[str, Any]:
    return {
        "frame": cuboid.frame,
        "label": cuboid.label,
        "track_id": cuboid.track_id,
        "source_id": cuboid.source_id,
        "center": list(cuboid.center),
        "dims": list(cuboid.dims),
        "yaw": cuboid.yaw,
        "keyframe": cuboid.keyframe,
        "outside": cuboid.outside,
        "attrs": dict(cuboid.attrs),
    }


def cuboid_from_dict(data: dict[str, Any]) -> Cuboid:
    return Cuboid(
        center=data["center"],
        dims=data["dims"],
        yaw=data["yaw"],
        label=data["label"],
        frame=data["frame"],
        track_id=data.get("track_id"),
        source_id=data.get("source_id"),
        keyframe=data.get("keyframe", True),
        outside=data.get("outside", False),
        attrs=data.get("attrs", {}),
    )


def save_cuboids(path: str | Path, cuboids: Iterable[Cuboid], meta: dict[str, Any] | None = None) -> None:
    payload = {"version": FORMAT_VERSION, "meta": meta or {}, "cuboids": [cuboid_to_dict(c) for c in cuboids]}
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")


def load_cuboids(path: str | Path) -> tuple[list[Cuboid], dict[str, Any]]:
    """Trả về (danh sách box, meta)."""
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("version") != FORMAT_VERSION:
        raise ValueError(f"{path}: không hỗ trợ phiên bản {payload.get('version')!r}, cần {FORMAT_VERSION}")
    return [cuboid_from_dict(d) for d in payload["cuboids"]], payload.get("meta", {})
