"""Persistent Rollback History Manager (Milestone M3, Features F9, F10).

Quản lý các bản ghi lịch sử snapshot dạng JSON bất biến tại:
~/.pointsnap/projects/{slug}/history/job_{job_id}/{history_id}.json
Cho phép hoàn tác 1-click chuẩn xác 100% cấu trúc track, keyframes và thuộc tính ban đầu.
"""

from __future__ import annotations

import copy
import dataclasses
import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Any, Sequence
import uuid

from pointsnap.adapters.cvat.shapes import PITCH_ATTR, ROLL_ATTR, points_to_geometry
from pointsnap.core.model import Cuboid
from pointsnap.core.serialize import cuboid_from_dict, cuboid_to_dict

logger = logging.getLogger(__name__)


class SnapshotIsolationError(ValueError):
    """Raised when a snapshot violates job or track boundary isolation (Defect 1)."""
    pass



def compute_track_etag(track_dict: dict[str, Any]) -> str:
    """Tính ETag SHA-256 từ dictionary track được chuẩn hóa phục vụ kiểm tra OCC."""
    normalized_json = json.dumps(track_dict, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(normalized_json.encode("utf-8")).hexdigest()[:16]


def sanitize_history_id(history_id: str) -> str:
    """Kiểm tra và chuẩn hóa history_id nhằm ngăn chặn tấn công Path Traversal (Defect 6).
    
    Chỉ cho phép chuỗi hợp lệ dạng UUID hoặc alphanumeric (chữ cái, chữ số, gạch ngang, gạch dưới).
    Nghiêm cấm ký tự duyệt thư mục ('..', '/', '\\') và ký tự rỗng.
    """
    if not history_id or not isinstance(history_id, str):
        raise ValueError("history_id must be a non-empty string")

    cleaned = history_id.strip()
    if not cleaned:
        raise ValueError("history_id cannot be blank")

    if ".." in cleaned or "/" in cleaned or "\\" in cleaned or "\0" in cleaned:
        raise ValueError(f"Directory traversal detected in history_id: '{history_id}'")

    if not re.match(r"^[a-zA-Z0-9_\-]+$", cleaned):
        raise ValueError(f"Invalid characters in history_id: '{history_id}'")

    return cleaned


def sanitize_slug(slug: str | None) -> str:
    """Chuẩn hóa slug dự án để ngăn Path Traversal."""
    if slug is None:
        return "default"
    s = str(slug).strip()
    if not s:
        return "default"
    if ".." in s or "/" in s or "\\" in s or "\0" in s:
        raise ValueError(f"Directory traversal detected in slug: '{slug}'")
    if not re.match(r"^[a-zA-Z0-9_\-]+$", s):
        raise ValueError(f"Invalid characters in slug: '{slug}'")
    return s


def validate_history_snapshot_schema(snapshot: dict[str, Any]) -> tuple[bool, str]:
    """Kiểm tra tính hợp lệ của snapshot schema theo PROJECT.md § 4."""
    required_keys = {
        "history_id",
        "timestamp",
        "job_id",
        "track_id",
        "frame",
        "pre_repair_track",
        "post_repair_track",
        "applied_repair",
    }
    missing = required_keys - set(snapshot.keys())
    if missing:
        return False, f"Missing required snapshot keys: {missing}"

    try:
        uuid.UUID(str(snapshot["history_id"]))
    except ValueError:
        return False, f"Invalid history_id format: {snapshot['history_id']} is not UUID"

    if not isinstance(snapshot["job_id"], int) or snapshot["job_id"] <= 0:
        return False, f"Invalid job_id: {snapshot['job_id']}"

    if not isinstance(snapshot["track_id"], int):
        return False, f"Invalid track_id: {snapshot['track_id']}"

    if not isinstance(snapshot["frame"], int) or snapshot["frame"] < 0:
        return False, f"Invalid frame index: {snapshot['frame']}"

    if not isinstance(snapshot["pre_repair_track"], dict) or not isinstance(snapshot["post_repair_track"], dict):
        return False, "pre_repair_track and post_repair_track must be dict structures"

    return True, "Valid"


def track_dict_to_cuboids(data: Any, label_name: str = "car") -> list[Cuboid]:
    """Chuyển đổi dữ liệu track (raw CVAT track dict hoặc serialized cuboids) thành list[Cuboid]."""
    if isinstance(data, list):
        if data and isinstance(data[0], Cuboid):
            return data
        return [cuboid_from_dict(d) if isinstance(d, dict) else d for d in data]

    if isinstance(data, dict):
        if "cuboids" in data and isinstance(data["cuboids"], list):
            return [cuboid_from_dict(d) for d in data["cuboids"]]

        if "shapes" in data and isinstance(data["shapes"], list):
            cuboids: list[Cuboid] = []
            track_id = data.get("id")
            track_attrs = {
                a.get("name") or f"attr_{a.get('id', a.get('spec_id'))}": a.get("value")
                for a in data.get("attributes", [])
            }
            for shape in sorted(data.get("shapes", []), key=lambda s: s.get("frame", 0)):
                if shape.get("type") == "cuboid" or "points" in shape:
                    geo = points_to_geometry(shape["points"])
                    attrs: dict[str, Any] = {
                        "occluded": bool(shape.get("occluded", False)),
                        ROLL_ATTR: geo["roll"],
                        PITCH_ATTR: geo["pitch"],
                        **track_attrs,
                    }
                    for a in shape.get("attributes", []):
                        attrs[a.get("name") or f"attr_{a.get('id', a.get('spec_id'))}"] = a.get("value")

                    label = shape.get("label") or data.get("label") or label_name
                    cuboids.append(
                        Cuboid(
                            center=geo["center"],
                            dims=geo["dims"],
                            yaw=geo["yaw"],
                            label=label,
                            frame=int(shape["frame"]),
                            track_id=track_id,
                            source_id=shape.get("id"),
                            keyframe=bool(shape.get("keyframe", True)),
                            outside=bool(shape.get("outside", False)),
                            attrs=attrs,
                        )
                    )
            return cuboids

    return []


def _normalize_track_for_storage(track_obj: Any, track_id: int) -> dict[str, Any]:
    """Chuẩn hóa dữ liệu track thành dạng dictionary để lưu JSON snapshot hợp lệ."""
    if isinstance(track_obj, dict):
        return copy.deepcopy(track_obj)
    elif isinstance(track_obj, list):
        # List of Cuboid
        return {
            "track_id": track_id,
            "cuboids": [cuboid_to_dict(c) if isinstance(c, Cuboid) else dict(c) for c in track_obj],
        }
    elif isinstance(track_obj, Cuboid):
        return {
            "track_id": track_id,
            "cuboids": [cuboid_to_dict(track_obj)],
        }
    return {}


def _normalize_repair_for_storage(repair_obj: Any) -> dict[str, Any]:
    """Chuẩn hóa applied_repair thành dictionary."""
    if hasattr(repair_obj, "to_dict") and callable(repair_obj.to_dict):
        return repair_obj.to_dict()
    elif isinstance(repair_obj, dict):
        return copy.deepcopy(repair_obj)
    return {}


class HistoryManager:
    """Quản lý lưu vết lịch sử sửa đổi và hoàn tác nhãn 3D."""

    def __init__(self, home_dir: Path | str | None = None, slug: str = "default") -> None:
        if home_dir is not None:
            self.home_dir = Path(home_dir)
        else:
            self.home_dir = Path.home() / ".pointsnap"
        self.slug = slug

    def history_dir(self, job_id: int, slug: str | None = None, base_dir: Path | str | None = None) -> Path:
        """Xác định thư mục lưu trữ lịch sử cho một job cụ thể."""
        if base_dir is not None:
            p = Path(base_dir)
            if p.name == f"job_{job_id}":
                target = p
            else:
                target = p / f"job_{job_id}"
        else:
            effective_slug = sanitize_slug(slug or self.slug)
            target = self.home_dir / "projects" / effective_slug / "history" / f"job_{job_id}"
        target.mkdir(parents=True, exist_ok=True)
        return target

    def save_snapshot(
        self,
        job_id: int,
        track_id: int,
        frame: int,
        pre_repair_track: Any,
        post_repair_track: Any,
        applied_repair: Any,
        history_id: str | None = None,
        slug: str | None = None,
        base_dir: Path | str | None = None,
    ) -> str:
        """Lưu bản ghi snapshot trước và sau khi sửa nhãn.
        
        Trả về `history_id` dạng chuỗi UUID4.
        """
        hid = history_id or str(uuid.uuid4())
        hid = sanitize_history_id(hid)
        # Đảm bảo hid có định dạng UUID hợp lệ
        try:
            uuid.UUID(str(hid))
        except ValueError:
            hid = str(uuid.uuid4())

        ts = datetime.now(timezone.utc).isoformat()
        pre_dict = _normalize_track_for_storage(pre_repair_track, track_id)
        post_dict = _normalize_track_for_storage(post_repair_track, track_id)
        repair_dict = _normalize_repair_for_storage(applied_repair)

        snapshot = {
            "history_id": hid,
            "timestamp": ts,
            "job_id": int(job_id),
            "track_id": int(track_id),
            "frame": int(frame),
            "pre_repair_track": pre_dict,
            "post_repair_track": post_dict,
            "applied_repair": repair_dict,
        }

        h_dir = self.history_dir(job_id, slug=slug, base_dir=base_dir)
        target_path = h_dir / f"{hid}.json"
        target_path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False), encoding="utf-8")
        return hid

    def get_snapshot(
        self,
        job_id: int,
        history_id: str,
        slug: str | None = None,
        base_dir: Path | str | None = None,
        track_id: int | None = None,
    ) -> dict[str, Any]:
        """Tải bản ghi snapshot theo job_id và history_id."""
        history_id = sanitize_history_id(history_id)
        effective_slug = sanitize_slug(slug or self.slug)

        candidate_paths: list[Path] = []
        if base_dir is not None:
            p = Path(base_dir)
            candidate_paths.append(p / f"{history_id}.json")
            candidate_paths.append(p / f"job_{job_id}" / f"{history_id}.json")

        candidate_paths.append(self.home_dir / "projects" / effective_slug / "history" / f"job_{job_id}" / f"{history_id}.json")
        candidate_paths.append(Path.home() / ".pointsnap" / "projects" / effective_slug / "history" / f"job_{job_id}" / f"{history_id}.json")

        found_path: Path | None = None
        for cp in candidate_paths:
            if cp.is_file():
                found_path = cp
                break

        # Tìm kiếm mở rộng đa job (Cross-Job History Search - Defect 5)
        # Khi job_id <= 0 hoặc không tìm thấy tại candidate_paths
        if found_path is None:
            search_roots: list[Path] = []
            if base_dir is not None:
                bp = Path(base_dir)
                search_roots.append(bp if not bp.name.startswith("job_") else bp.parent)
            search_roots.append(self.home_dir / "projects" / effective_slug / "history")
            search_roots.append(Path.home() / ".pointsnap" / "projects" / effective_slug / "history")

            for root in search_roots:
                if root.is_dir():
                    matches = list(root.glob(f"job_*/*{history_id}.json"))
                    if not matches:
                        matches = list(root.glob(f"*{history_id}.json"))
                    for m in matches:
                        if m.is_file():
                            found_path = m
                            break
                if found_path is not None:
                    break

        if found_path is None:
            raise FileNotFoundError(f"Snapshot '{history_id}' not found for job {job_id}")

        content = found_path.read_text(encoding="utf-8")
        snapshot = json.loads(content)

        # Kiểm tra tính toàn vẹn schema snapshot (Defect 4)
        if not isinstance(snapshot, dict):
            raise ValueError(f"Snapshot '{history_id}' content must be a JSON object, got {type(snapshot).__name__}")
        valid, msg = validate_history_snapshot_schema(snapshot)
        if not valid:
            raise ValueError(f"Invalid snapshot schema for '{history_id}': {msg}")

        # Kiểm tra cách ly job_id và track_id (Defect 1)
        if job_id > 0:
            try:
                snap_job = int(snapshot.get("job_id", -1))
            except (ValueError, TypeError):
                snap_job = -1
            if snap_job != job_id:
                raise SnapshotIsolationError(
                    f"Snapshot '{history_id}' does not belong to job {job_id} (belongs to job {snapshot.get('job_id')})"
                )

        if track_id is not None:
            try:
                snap_track = int(snapshot.get("track_id", -1))
            except (ValueError, TypeError):
                snap_track = -1
            if snap_track != track_id:
                raise SnapshotIsolationError(
                    f"Snapshot '{history_id}' does not belong to track {track_id} (belongs to track {snapshot.get('track_id')})"
                )

        return snapshot

    def list_snapshots(
        self,
        job_id: int | None = None,
        slug: str | None = None,
        base_dir: Path | str | None = None,
    ) -> list[dict[str, Any]]:
        """Liệt kê tất cả snapshot của job, sắp xếp theo thời gian giảm dần."""
        effective_slug = sanitize_slug(slug or self.slug)
        search_dirs: list[Path] = []
        if base_dir is not None:
            p = Path(base_dir)
            if job_id is not None:
                if p.name == f"job_{job_id}":
                    search_dirs.append(p)
                else:
                    search_dirs.append(p / f"job_{job_id}")
            else:
                search_dirs.append(p)
        else:
            base_history = self.home_dir / "projects" / effective_slug / "history"
            if job_id is not None:
                search_dirs.append(base_history / f"job_{job_id}")
            elif base_history.is_dir():
                search_dirs.extend(base_history.glob("job_*"))

        results: list[dict[str, Any]] = []
        for sdir in search_dirs:
            if not sdir.is_dir():
                continue
            for jf in sdir.glob("*.json"):
                try:
                    data = json.loads(jf.read_text(encoding="utf-8"))
                    # Chỉ gom các bản ghi dạng dict (Defect 3)
                    if isinstance(data, dict):
                        results.append(data)
                except Exception:
                    continue

        # Sắp xếp an toàn phòng ngừa TypeError/AttributeError khi timestamp là None/int/vắng mặt (Defect 3)
        results.sort(key=lambda s: str(s.get("timestamp") or ""), reverse=True)
        return results

    def rollback_track(
        self,
        job_id: int,
        history_id: str,
        cvat_client: Any = None,
        slug: str | None = None,
        base_dir: Path | str | None = None,
    ) -> list[Cuboid]:
        """Hoàn tác track về trạng thái pre-repair và đồng bộ lên CVAT nếu có client."""
        snapshot = self.get_snapshot(job_id, history_id, slug=slug, base_dir=base_dir)
        pre_repair_track = snapshot["pre_repair_track"]

        if cvat_client is not None and isinstance(pre_repair_track, dict) and "shapes" in pre_repair_track:
            cvat_client.patch_job_annotations(job_id, {"tracks": [pre_repair_track]}, action="update")

        return track_dict_to_cuboids(pre_repair_track)


# Singleton mặc định và module-level functions
_default_manager = HistoryManager()


def save_snapshot(
    job_id: int,
    track_id: int,
    frame: int,
    pre_repair_track: Any,
    post_repair_track: Any,
    applied_repair: Any,
    history_id: str | None = None,
    slug: str = "default",
    base_dir: Path | str | None = None,
) -> str:
    """Module-level helper lưu snapshot."""
    return _default_manager.save_snapshot(
        job_id=job_id,
        track_id=track_id,
        frame=frame,
        pre_repair_track=pre_repair_track,
        post_repair_track=post_repair_track,
        applied_repair=applied_repair,
        history_id=history_id,
        slug=slug,
        base_dir=base_dir,
    )


def get_snapshot(
    job_id: int,
    history_id: str,
    slug: str = "default",
    base_dir: Path | str | None = None,
    track_id: int | None = None,
) -> dict[str, Any]:
    """Module-level helper tải snapshot."""
    return _default_manager.get_snapshot(
        job_id=job_id,
        history_id=history_id,
        slug=slug,
        base_dir=base_dir,
        track_id=track_id,
    )


def list_snapshots(
    job_id: int | None = None,
    slug: str = "default",
    base_dir: Path | str | None = None,
) -> list[dict[str, Any]]:
    """Module-level helper liệt kê snapshot."""
    return _default_manager.list_snapshots(
        job_id=job_id,
        slug=slug,
        base_dir=base_dir,
    )


def rollback_track(
    job_id: int,
    history_id: str,
    cvat_client: Any = None,
    slug: str = "default",
    base_dir: Path | str | None = None,
) -> list[Cuboid]:
    """Module-level helper hoàn tác track."""
    return _default_manager.rollback_track(
        job_id=job_id,
        history_id=history_id,
        cvat_client=cvat_client,
        slug=slug,
        base_dir=base_dir,
    )
