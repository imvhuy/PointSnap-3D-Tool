"""Ghi và xóa cờ lỗi `pointsnap_error` trên CVAT và lưu bản chụp JSON (việc A4).

Quy ước:
- Lưu bản chụp nhãn trước khi ghi cờ lỗi để có thể hoàn tác hoặc so sánh (`diff`).
- Endpoint PATCH `/api/jobs/<id>/annotations?action=update` của CVAT 2.x cập nhật shapes/tracks.
- Để bảo toàn 100% hình học box (center, dims, yaw, roll, pitch, occluded, outside):
  sử dụng đúng dữ liệu gốc từ `GET /api/jobs/<id>/annotations`, chỉ cập nhật mảng `attributes`
  của shape/keyframe tương ứng với thuộc tính `pointsnap_error`.
- Thuộc tính `pointsnap_error` là `mutable` nên nằm ở từng keyframe của track (hoặc shape lẻ).
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from pointsnap.adapters.cvat.client import CvatClient, CvatError
from pointsnap.adapters.cvat.reader import JobData, LabelInfo, annotations_to_cuboids
from pointsnap.adapters.cvat.shapes import cuboid_to_points
from pointsnap.core.model import Cuboid, Finding
from pointsnap.core.serialize import save_cuboids

DEFAULT_FLAG_ATTR = "pointsnap_error"
DEFAULT_REVIEWED_ATTR = "reviewed"


class OCCConflictError(CvatError):
    """Xung đột kiểm soát đồng thời lạc quan (OCC) khi ETag client không khớp server."""



def save_snapshot(job: JobData, path: str | Path, meta: dict[str, Any] | None = None) -> None:
    """Lưu bản chụp JSON của các box trong job trước khi sửa đổi nhãn."""
    default_meta = {
        "url": job.url,
        "task_id": job.task_id,
        "job_id": job.job_id,
        "start_frame": job.start_frame,
        "stop_frame": job.stop_frame,
    }
    if meta:
        default_meta.update(meta)
    if job.raw_annotations is not None:
        default_meta["cvat_annotations"] = job.raw_annotations
    save_cuboids(path, job.cuboids, meta=default_meta)


def format_finding_message(finding: Finding) -> str:
    """Định dạng thông báo lỗi hiển thị cho người dán nhãn trong CVAT."""
    return f"[{finding.severity.label_vi}] {finding.message}"


def _update_shape_attributes(
    shape: dict[str, Any],
    spec_id: int,
    error_value: str | None,
    force_empty: bool = False,
) -> bool:
    """Cập nhật thuộc tính `spec_id` trong `shape['attributes']`.

    - Nếu `error_value` có nội dung: gán giá trị mới.
    - Nếu `error_value` là `None` hoặc rỗng `""`: ghi giá trị rỗng để chặn kế thừa cờ mutable.
    Trả về `True` nếu thuộc tính thay đổi so với giá trị cũ.
    """
    attributes = list(shape.get("attributes", []))
    old_value: str | None = None
    target_idx: int | None = None

    for i, attr in enumerate(attributes):
        if attr.get("spec_id") == spec_id:
            old_value = attr.get("value", "")
            target_idx = i
            break

    new_val = error_value or ""
    if old_value == new_val or (old_value is None and not new_val and not force_empty):
        return False

    if target_idx is not None:
        attributes[target_idx] = {"spec_id": spec_id, "value": new_val}
    else:
        attributes.append({"spec_id": spec_id, "value": new_val})

    shape["attributes"] = attributes
    return True


FindingKey = tuple[int | None, int | None, int]

_KEEP = object()  # giá trị trả về của `value_for`: không đụng tới cờ của box này


@dataclass(frozen=True)
class FlagSummary:
    """Kết quả một lần đồng bộ cờ lỗi lên CVAT."""

    flagged: int  # số box được ghi cờ mới hoặc đổi nội dung cờ
    cleared: int  # số box được xóa cờ cũ (box đã hết lỗi)
    unmatched: int  # số khóa finding không khớp box nào trên CVAT (không ghi được cờ)


def build_findings_map(findings: Iterable[Finding]) -> dict[FindingKey, str]:
    """Gom các finding theo khóa `(track_id, source_id, frame)`.

    Nếu 1 box có nhiều finding, ghép các câu thông báo bằng `; `.
    """
    grouped: dict[FindingKey, list[str]] = {}
    for f in sorted(findings, key=lambda f: (f.sort_key(), f.message)):
        msgs = grouped.setdefault((f.track_id, f.source_id, f.frame), [])
        msg = format_finding_message(f)
        if msg not in msgs:
            msgs.append(msg)
    return {k: "; ".join(msgs) for k, msgs in grouped.items()}


def _plan_flag_updates(
    raw_annotations: dict[str, Any],
    labels: Mapping[int, LabelInfo],
    flag_attribute: str,
    value_for: Callable[[int | None, int | None, int], Any],
) -> tuple[dict[str, Any], int, int]:
    """Duyệt mọi box cuboid, đặt cờ theo `value_for(track_id, shape_id, frame)`.

    `value_for` trả về chuỗi (ghi cờ), `None` (xóa cờ) hoặc `_KEEP` (giữ nguyên).
    Chỉ đưa vào patch những shape/track thực sự đổi; hình học giữ nguyên vì dùng đúng dữ liệu gốc.
    Trả về `(patch, số box ghi cờ, số box xóa cờ)`.
    """
    patch: dict[str, Any] = {}
    flagged = cleared = 0

    def apply(shape: dict[str, Any], spec_id: int, value: Any) -> bool:
        nonlocal flagged, cleared
        if value is _KEEP or not _update_shape_attributes(shape, spec_id, value):
            return False
        if value:
            flagged += 1
        else:
            cleared += 1
        return True

    def spec_of(label_id: Any) -> int | None:
        info = labels.get(label_id)
        spec_id = info.attribute_ids.get(flag_attribute) if info else None
        if info and info.attribute_mutable.get(spec_id) is False:
            raise CvatError(f"Thuộc tính {flag_attribute} của {info.name} phải là mutable để ghi cờ từng keyframe")
        return spec_id

    for raw_shape in raw_annotations.get("shapes", []):
        spec_id = spec_of(raw_shape.get("label_id"))
        if raw_shape.get("type") != "cuboid" or spec_id is None:
            continue
        shape = copy.deepcopy(raw_shape)
        if apply(shape, spec_id, value_for(None, shape.get("id"), shape.get("frame"))):
            patch.setdefault("shapes", []).append(shape)

    for raw_track in raw_annotations.get("tracks", []):
        spec_id = spec_of(raw_track.get("label_id"))
        if spec_id is None:
            continue
        track = copy.deepcopy(raw_track)
        changed = False
        original_value = next((a["value"] for a in track.get("attributes", []) if a["spec_id"] == spec_id), "")
        planned_value = original_value
        for shape in sorted(track.get("shapes", []), key=lambda s: s["frame"]):
            if shape.get("type") == "cuboid":
                original_value = next((a["value"] for a in shape.get("attributes", []) if a["spec_id"] == spec_id), original_value)
                value = value_for(track.get("id"), shape.get("id"), shape.get("frame"))
                desired = original_value if value is _KEEP else (value or "")
                explicit = next((a["value"] for a in shape.get("attributes", []) if a["spec_id"] == spec_id), planned_value)
                if explicit != desired:
                    changed |= _update_shape_attributes(shape, spec_id, desired, force_empty=True)
                if original_value != desired:
                    if desired:
                        flagged += 1
                    else:
                        cleared += 1
                planned_value = desired
        if changed:
            patch.setdefault("tracks", []).append(track)

    return patch, flagged, cleared


def build_error_patch(
    raw_annotations: dict[str, Any],
    labels: Mapping[int, LabelInfo],
    findings_map: Mapping[FindingKey, str],
    flag_attribute: str = DEFAULT_FLAG_ATTR,
    clear_stale: bool = True,
) -> tuple[dict[str, Any], FlagSummary]:
    """Tạo payload PATCH `action=update` để cờ trên CVAT khớp đúng với `findings_map`.

    Khớp box theo đúng id: box lẻ bằng `(None, id shape, frame)`; keyframe của track bằng
    `(id track, id keyframe, frame)` hoặc `(id track, None, frame)`. Không có khớp "mọi box trong frame".
    Với `clear_stale=True`, box không còn finding nào thì xóa cờ cũ (lần quét sau tự gỡ cờ).
    """
    used: set[FindingKey] = set()

    def value_for(track_id: int | None, shape_id: int | None, frame: int) -> Any:
        keys = [(track_id, shape_id, frame)]
        if track_id is not None:
            keys.append((track_id, None, frame))
        for key in keys:
            if key in findings_map:
                used.add(key)
                return findings_map[key]
        return None if clear_stale else _KEEP

    patch, flagged, cleared = _plan_flag_updates(raw_annotations, labels, flag_attribute, value_for)
    unmatched = len(set(findings_map) - used)
    return patch, FlagSummary(flagged=flagged, cleared=cleared, unmatched=unmatched)


def flag_job_errors(
    client: CvatClient,
    job: JobData,
    findings: Iterable[Finding],
    snapshot_path: str | Path | None = None,
    flag_attribute: str = DEFAULT_FLAG_ATTR,
    clear_stale: bool = True,
) -> FlagSummary:
    """Đồng bộ cờ lỗi `pointsnap_error` trên CVAT với danh sách finding.

    - Nếu `snapshot_path` được cung cấp: lưu bản chụp JSON trước khi ghi.
    - Không có finding nào vẫn chạy, để xóa cờ cũ khi `clear_stale=True`.
    """
    raw_annos = _fresh_annotations(client, job, flag_attribute)
    if snapshot_path:
        save_snapshot(replace(job, cuboids=annotations_to_cuboids(raw_annos, job.labels), raw_annotations=raw_annos), snapshot_path)

    # CVAT update có thể cấp id mới cho keyframe. Chỉ khớp lại khi hình học/thuộc tính
    # đã được kiểm là chưa đổi và finding thực sự thuộc box trong lượt scan này.
    scanned = {(b.track_id, b.source_id, b.frame) for b in job.cuboids if b.track_id is not None}
    current = {(b.track_id, b.frame): b.source_id for b in annotations_to_cuboids(raw_annos, job.labels) if b.track_id is not None}
    rebound = [replace(f, source_id=current.get((f.track_id, f.frame), f.source_id))
               if (f.track_id, f.source_id, f.frame) in scanned else f for f in findings]
    findings_map = build_findings_map(rebound)
    patch_data, summary = build_error_patch(raw_annos, job.labels, findings_map, flag_attribute, clear_stale)
    if patch_data:
        _patch_if_unchanged(client, job.job_id, raw_annos, patch_data)
    return summary


def clear_job_errors(
    client: CvatClient,
    job: JobData,
    snapshot_path: str | Path | None = None,
    track_id: int | None = None,
    frame: int | None = None,
    flag_attribute: str = DEFAULT_FLAG_ATTR,
) -> int:
    """Xóa cờ lỗi `pointsnap_error` trên CVAT.

    - Nếu `track_id` hoặc `frame` được chỉ định: chỉ xóa box khớp điều kiện.
    - Nếu cả hai là `None`: xóa cờ lỗi của toàn bộ các box trong job.
    - Nếu `snapshot_path` được cung cấp: lưu bản chụp JSON trước khi xóa.
    - Trả về số lượng box được xóa cờ.
    """
    raw_annos = _fresh_annotations(client, job, flag_attribute)
    if snapshot_path:
        save_snapshot(replace(job, cuboids=annotations_to_cuboids(raw_annos, job.labels), raw_annotations=raw_annos), snapshot_path)

    def value_for(tid: int | None, _shape_id: int | None, f: int) -> Any:
        if (track_id is not None and tid != track_id) or (frame is not None and f != frame):
            return _KEEP
        return None

    patch_data, _, cleared = _plan_flag_updates(raw_annos, job.labels, flag_attribute, value_for)
    if patch_data:
        _patch_if_unchanged(client, job.job_id, raw_annos, patch_data)
    return cleared


def _fresh_annotations(client: CvatClient, job: JobData, flag_attribute: str) -> dict[str, Any]:
    raw = client.get_job_annotations(job.job_id)
    current = annotations_to_cuboids(raw, job.labels)
    def signature(boxes: Iterable[Cuboid]) -> list[str]:
        return sorted(repr((b.frame, b.track_id, b.source_id if b.track_id is None else None,
                            b.label, b.center, b.dims, b.yaw, b.keyframe, b.outside,
                            sorted((k, v) for k, v in b.attrs.items() if k != flag_attribute))) for b in boxes)
    if signature(current) != signature(job.cuboids):
        raise CvatError("Nhãn đã thay đổi sau lượt scan; quét lại trước khi ghi/gỡ cờ")
    return raw


def _patch_if_unchanged(client: CvatClient, job_id: int, before: dict[str, Any], patch: dict[str, Any]) -> None:
    if client.get_job_annotations(job_id) != before:
        raise CvatError("Nhãn thay đổi khi chuẩn bị PATCH; quét lại trước khi ghi/gỡ cờ")
    client.patch_job_annotations(job_id, patch, action="update")


def verify_geometry_preserved(
    before_cuboids: Iterable[Cuboid],
    after_cuboids: Iterable[Cuboid],
    tolerance: float = 1e-6,
) -> None:
    """Kiểm tra hình học của các box trước và sau khi ghi/xóa cờ lỗi.

    So theo frame/track/label và hình học, không phụ thuộc id keyframe CVAT cấp lại.
    Kiểm cả roll/pitch, outside, occluded và keyframe; dung sai tuyệt đối theo mét/radian.
    """
    key = lambda b: (b.frame, b.track_id if b.track_id is not None else -1, b.label, b.center, b.dims, b.yaw)
    before_list = sorted(before_cuboids, key=key)
    after_list = sorted(after_cuboids, key=key)

    if len(before_list) != len(after_list):
        raise ValueError(
            f"Số lượng box không khớp sau khi thao tác: trước {len(before_list)}, sau {len(after_list)}"
        )

    for b, a in zip(before_list, after_list):
        if (b.frame, b.track_id, b.label, b.outside, b.occluded, b.keyframe) != (a.frame, a.track_id, a.label, a.outside, a.occluded, a.keyframe):
            raise ValueError(f"Thứ tự hoặc định danh box bị thay đổi: {b} vs {a}")

        for i, name in enumerate(("x", "y", "z")):
            if not math.isclose(b.center[i], a.center[i], abs_tol=tolerance, rel_tol=0):
                raise ValueError(
                    f"Tâm box (frame={b.frame}, track={b.track_id}) bị lệch ở trục {name}: "
                    f"{b.center[i]} -> {a.center[i]}"
                )
            if not math.isclose(b.dims[i], a.dims[i], abs_tol=tolerance, rel_tol=0):
                raise ValueError(
                    f"Kích thước box (frame={b.frame}, track={b.track_id}) bị thay đổi ở trục {name}: "
                    f"{b.dims[i]} -> {a.dims[i]}"
                )

        for attr in ("cvat_rx", "cvat_ry"):
            if not math.isclose(float(b.attrs.get(attr, 0)), float(a.attrs.get(attr, 0)), abs_tol=tolerance, rel_tol=0):
                raise ValueError(f"Roll/pitch box bị thay đổi: {attr}")
        if not math.isclose(b.yaw, a.yaw, abs_tol=tolerance, rel_tol=0):
            raise ValueError(
                f"Yaw của box (frame={b.frame}, track={b.track_id}) bị thay đổi: "
                f"{b.yaw} -> {a.yaw}"
            )


def compute_track_etag(track_dict: dict[str, Any]) -> str:
    """Tính ETag SHA-256 biểu diễn nội dung của track phục vụ kiểm soát đồng thời lạc quan (OCC)."""
    normalized_json = json.dumps(track_dict, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(normalized_json.encode("utf-8")).hexdigest()[:16]


def patch_track_keyframe(
    client: CvatClient,
    job_id: int,
    track_id: int,
    frame: int,
    new_points: Sequence[float] | Cuboid,
    client_etag: str | None = None,
    clear_error_flag: bool = True,
    flag_attribute: str = DEFAULT_FLAG_ATTR,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Cập nhật an toàn một keyframe trong track trên CVAT (Feature F9).

    Tuân thủ tuyệt đối quy tắc Safe Update:
    1. Full track assembly: Lấy trọn vẹn track từ CVAT, chỉ thay đổi mảng `points` tại frame mục tiêu.
    2. Bảo toàn toàn bộ các keyframes khác, label_id, track_id, outside, occluded và mọi attributes.
    3. OCC pre-check: Kiểm tra `client_etag` khớp với ETag hiện tại trên server trước khi PATCH.
    4. Gửi PATCH /api/jobs/<job_id>/annotations?action=update với payload {"tracks": [post_repair_track]}.
    5. Trả về `(pre_repair_track, post_repair_track)`.
    """
    raw_annos = client.get_job_annotations(job_id)
    tracks = raw_annos.get("tracks", [])
    target_track = None
    for t in tracks:
        if t.get("id") == track_id:
            target_track = t
            break

    if target_track is None:
        raise CvatError(f"Track {track_id} không tồn tại trong job {job_id}")

    server_etag = compute_track_etag(target_track)
    if client_etag is not None and client_etag != server_etag:
        raise OCCConflictError(
            f"OCC conflict: Client ETag '{client_etag}' không khớp server ETag '{server_etag}' cho track {track_id}"
        )

    pre_repair_track = copy.deepcopy(target_track)
    post_repair_track = copy.deepcopy(target_track)

    target_shape = None
    for s in post_repair_track.get("shapes", []):
        if s.get("frame") == frame:
            target_shape = s
            break

    if target_shape is None:
        raise CvatError(f"Frame {frame} không tồn tại trong track {track_id}")

    if isinstance(new_points, Cuboid):
        pts = cuboid_to_points(new_points)
    else:
        pts = [float(v) for v in new_points]
        if len(pts) != 16:
            raise ValueError(f"Mảng points của CVAT cuboid phải có đúng 16 số thực, nhận {len(pts)}")

    target_shape["points"] = pts

    if clear_error_flag:
        attrs = list(target_shape.get("attributes", []))
        for a in attrs:
            if a.get("name") in (flag_attribute, "pointsnap_error") or "error" in str(a.get("name", "")).lower():
                a["value"] = ""
        target_shape["attributes"] = attrs

    patch_payload = {"tracks": [post_repair_track]}
    client.patch_job_annotations(job_id, patch_payload, action="update")
    return pre_repair_track, post_repair_track


def rollback_track_annotation(
    client: CvatClient,
    job_id: int,
    pre_repair_track: dict[str, Any],
) -> dict[str, Any]:
    """Khôi phục nguyên trạng track lên CVAT từ bản ghi pre_repair_track (Feature F10)."""
    client.patch_job_annotations(job_id, {"tracks": [pre_repair_track]}, action="update")
    return pre_repair_track

