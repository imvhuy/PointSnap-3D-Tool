"""Box Critic: dữ liệu huấn luyện và chỗ cắm model (việc C3, lớp 3 của Box Verifier).

Nhóm tự huấn luyện model (xem `docs/huong-dan/huan-luyen-box-critic.md`); module này chỉ lo hai đầu:

- **Xuất dữ liệu** (`export_dataset`, lệnh `pointsnap critic-data`): lấy box nhãn chuẩn nhìn thấy được, làm nhiễu có kiểm
  soát (dời, xoay, co / phóng, nâng / hạ) hoặc giữ nguyên, rồi lấy điểm LiDAR quanh **box đã làm nhiễu** đúng như bộ quét
  thấy. Vì biết đã làm nhiễu bao nhiêu nên có sẵn đáp án: box có sai không và cần sửa bao nhiêu để về box chuẩn.
- **Dùng model** (`critic_findings`, luật `critic.box`): nạp model TorchScript ở `critic.model` của guideline, chấm từng box
  nhìn thấy được; xác suất sai ≥ `critic.min_probability` thì báo kèm **gợi ý sửa** "trước → sau" (không tự áp dụng).

Đặc trưng đầu vào giống hệt nhau ở hai đầu (`box_features`), nên model huấn luyện trên dữ liệu xuất ra dùng được ngay.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
import hashlib
from typing import TYPE_CHECKING, Sequence

import numpy as np

from pointsnap.core.box_points import box_point_sets
from pointsnap.core.model import Cuboid, ErrorType, Finding, Severity, group_by_frame

if TYPE_CHECKING:
    from pointsnap.core.config import CriticConfig

NUM_POINTS = 256
"""Mỗi mẫu lấy đúng 256 điểm (lấy mẫu lại / lặp lại), toạ độ hệ box chia cho nửa kích thước box."""
CLASSES = ("car", "truck", "bus", "trailer", "construction_vehicle", "pedestrian", "motorcycle", "bicycle",
           "traffic_cone", "barrier", "Vehicle", "Two-wheels", "Pedestrian", "Animal", "Obstacle")
TARGETS = ("dx", "dy", "dz", "dl", "dw", "dh", "dyaw")
"""Thứ tự 7 giá trị sửa: dịch tâm (m, hệ box đã nhiễu), đổi kích thước (m), đổi hướng (rad)."""

PERTURB = {"shift_m": 0.6, "z_m": 0.3, "scale": 0.25, "yaw_deg": 30.0}
"""Biên độ nhiễu tối đa khi xuất dữ liệu."""
TOLERANCE = {"shift_m": 0.15, "z_m": 0.08, "scale": 0.06, "yaw_deg": 4.0}
"""Nhiễu nhỏ hơn mức này coi như box vẫn đúng (nhãn `is_error` = 0)."""


def box_features(points_local: np.ndarray, box: Cuboid, range_m: float, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """(điểm (256, 4), đặc trưng box) cho một box.

    Điểm: x, y, z hệ box chia nửa kích thước, cờ 1 nếu nằm trong box. Đặc trưng box: l, w, h, khoảng cách (chia 50),
    log số điểm, one-hot class.
    """
    half = np.asarray(box.dims) / 2.0
    pts = np.asarray(points_local, dtype=np.float32)
    if len(pts) == 0:
        cloud = np.zeros((NUM_POINTS, 4), dtype=np.float32)
    else:
        idx = rng.choice(len(pts), NUM_POINTS, replace=len(pts) < NUM_POINTS)
        sel = pts[idx]
        inside = np.all(np.abs(sel) <= half, axis=1).astype(np.float32)
        cloud = np.column_stack([sel / half, inside]).astype(np.float32)
    onehot = [1.0 if box.label == c else 0.0 for c in CLASSES]
    meta = np.array([*box.dims, range_m / 50.0, math.log1p(len(pts)), *onehot], dtype=np.float32)
    return cloud, meta


def _perturb(box: Cuboid, rng: np.random.Generator) -> tuple[Cuboid, np.ndarray, int]:
    """Box đã làm nhiễu, 7 giá trị sửa về box chuẩn (hệ box đã nhiễu), và nhãn có sai không."""
    if rng.random() < 0.35:
        return box, np.zeros(7, dtype=np.float32), 0
    shift = rng.uniform(-PERTURB["shift_m"], PERTURB["shift_m"], 2) * (rng.random(2) < 0.6)
    dz = rng.uniform(-PERTURB["z_m"], PERTURB["z_m"]) * (rng.random() < 0.3)
    scale = 1 + rng.uniform(-PERTURB["scale"], PERTURB["scale"], 3) * (rng.random(3) < 0.4)
    dyaw = math.radians(rng.uniform(-PERTURB["yaw_deg"], PERTURB["yaw_deg"])) * (rng.random() < 0.4)
    c, s = math.cos(box.yaw), math.sin(box.yaw)
    center = (box.center[0] + c * shift[0] - s * shift[1], box.center[1] + s * shift[0] + c * shift[1],
              box.center[2] + dz)
    noisy = box.replace(center=center, dims=tuple(np.asarray(box.dims) * scale), yaw=box.yaw + dyaw)
    # Sửa từ box nhiễu về box chuẩn, trong hệ box nhiễu.
    cn, sn = math.cos(noisy.yaw), math.sin(noisy.yaw)
    gx, gy = box.center[0] - noisy.center[0], box.center[1] - noisy.center[1]
    target = np.array([cn * gx + sn * gy, -sn * gx + cn * gy, box.center[2] - noisy.center[2],
                       *(np.asarray(box.dims) - np.asarray(noisy.dims)), -dyaw], dtype=np.float32)
    wrong = (np.hypot(*shift) > TOLERANCE["shift_m"] or abs(dz) > TOLERANCE["z_m"]
             or np.max(np.abs(scale - 1)) > TOLERANCE["scale"] or abs(math.degrees(dyaw)) > TOLERANCE["yaw_deg"])
    return noisy, target, int(wrong)


def export_dataset(reader, scenes: Sequence[str], out_dir: str | Path, samples_per_box: int = 6,
                   min_points: int = 10, seed: int = 0, progress=print) -> dict[str, int]:
    """Ghi `<out>/<cảnh>.npz`: points (N, 256, 4), meta (N, M), is_error (N,), target (N, 7), track_id, frame."""
    from pointsnap.core.model import add_track_markers

    if samples_per_box < 1 or min_points < 1:
        raise ValueError("samples_per_box and min_points must be positive")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for scene in scenes:
        if (out / f"{scene}.npz").exists():
            raise FileExistsError(f"Critic dataset already exists: {scene}.npz; choose a new output directory")
    totals = {"samples": 0, "errors": 0}
    for scene in scenes:
        scene_seed = int.from_bytes(hashlib.sha256(scene.encode()).digest()[:8], "little")
        rng = np.random.default_rng([seed, scene_seed])
        frames = reader.frames(scene)
        boxes = [b for b in add_track_markers(reader.annotations(scene), frames.num_frames) if b.visible and b.keyframe]
        rows = {"points": [], "meta": [], "is_error": [], "target": [], "track_id": [], "frame": []}
        for frame, frame_boxes in group_by_frame(boxes).items():
            points = np.asarray(frames.frame_data(frame).points)
            for index, box in enumerate(frame_boxes):
                if int(box.attrs.get("num_lidar_pts", min_points)) < min_points:
                    continue
                # Mọi phép đo đều cục bộ quanh box (vành đai mặt đất ≤ 1,5 m): cắt sẵn vùng quanh box một lần để
                # mỗi mẫu không phải xét cả frame.
                reach = max(box.dims) + 3.0
                near = (np.abs(points[:, 0] - box.center[0]) <= reach) & (np.abs(points[:, 1] - box.center[1]) <= reach)
                local_points = points[near]
                others = [b for j, b in enumerate(frame_boxes) if j != index
                          and math.hypot(b.center[0] - box.center[0], b.center[1] - box.center[1]) <= reach + max(b.dims)]
                for _ in range(samples_per_box):
                    noisy, target, wrong = _perturb(box, rng)
                    item = box_point_sets(local_points, [noisy, *others], margin=0.5, clearance=0.25,
                                          margin_rel=0.25)[0]
                    cloud, meta = box_features(item.local, noisy, item.range_m, rng)
                    for key, value in (("points", cloud), ("meta", meta), ("is_error", wrong), ("target", target),
                                       ("track_id", box.track_id if box.track_id is not None else -1),
                                       ("frame", frame)):
                        rows[key].append(value)
        shapes = {"points": (NUM_POINTS, 4), "meta": (5 + len(CLASSES),), "target": (7,)}
        arrays = {k: np.asarray(v, dtype=np.float32 if k in shapes else np.int64)
                  .reshape((-1, *shapes.get(k, ()))) for k, v in rows.items()}
        np.savez_compressed(out / f"{scene}.npz", **arrays)
        totals["samples"] += len(rows["is_error"])
        totals["errors"] += int(np.sum(rows["is_error"]))
        progress(f"{scene}: {len(rows['is_error'])} mẫu, {int(np.sum(rows['is_error']))} mẫu sai")
    return totals


@dataclass
class _Model:
    module: object


_LOADED: dict[str, tuple[tuple[int, int], _Model]] = {}


def available() -> bool:
    try:
        import torch  # noqa: F401
    except (ImportError, OSError):
        return False
    return True


def _load(path: str) -> _Model:
    path = str(Path(path).resolve())
    stat = Path(path).stat()
    signature = (stat.st_mtime_ns, stat.st_size)
    if path not in _LOADED or _LOADED[path][0] != signature:
        import torch

        # TorchScript is executable: only load checkpoints from a trusted author.
        _LOADED[path] = (signature, _Model(torch.jit.load(path, map_location="cpu").eval()))
    return _LOADED[path][1]


def critic_findings(cuboids: Sequence[Cuboid], frames, cfg: CriticConfig) -> list[Finding]:
    """Luật `critic.box`: model TorchScript nhận (points (B, 256, 4), meta (B, M)), trả (logit sai (B,), sửa (B, 7)).

    Box thuộc track được so với **chính các frame khác của track** (logit và gợi ý sửa trừ trung vị của track), như các
    luật khác của PointSnap: model huấn luyện trên ít cảnh lệch đều theo từng vật / cảnh (trên cảnh để riêng, 20% box
    chuẩn có xác suất sai > 0.7), so theo track thì độ lệch đó triệt tiêu. Box lẻ (shape) dùng xác suất thô.
    """
    import torch

    model = _load(cfg.model).module
    rng = np.random.default_rng(0)
    scored: list[tuple[Cuboid, float, np.ndarray]] = []
    for frame, boxes in sorted(group_by_frame(c for c in cuboids if c.visible and c.keyframe).items()):
        items = [i for i in box_point_sets(frames.frame_data(frame).points, boxes, margin=0.5, clearance=0.25,
                                           margin_rel=0.25) if i.num_object_points >= cfg.min_points]
        if not items:
            continue
        batch = [box_features(i.local, i.box, i.range_m, rng) for i in items]
        with torch.inference_mode():
            logit, delta = model(torch.from_numpy(np.stack([b[0] for b in batch])),
                                 torch.from_numpy(np.stack([b[1] for b in batch])))
        if (not isinstance(logit, torch.Tensor) or not isinstance(delta, torch.Tensor)
                or tuple(logit.shape) != (len(items),) or tuple(delta.shape) != (len(items), 7)
                or not logit.is_floating_point() or not delta.is_floating_point()
                or not torch.isfinite(logit).all() or not torch.isfinite(delta).all()):
            raise ValueError("Critic checkpoint must return finite floating tensors (B,) and (B, 7)")
        scored.extend(zip((i.box for i in items), logit.cpu().numpy().astype(float), delta.cpu().numpy()))

    by_track: dict[tuple[int, str], list[tuple[Cuboid, float, np.ndarray]]] = {}
    for row in scored:
        if row[0].track_id is not None:
            by_track.setdefault((row[0].track_id, row[0].label), []).append(row)
    findings: list[Finding] = []
    for box, lg, d in scored:
        others = [r for r in by_track.get((box.track_id, box.label), [])
                  if r[0].frame != box.frame] if box.track_id is not None else []
        if len(others) >= 2:
            ref_logit = float(np.median([r[1] for r in others]))
            rise = lg - ref_logit
            if rise <= cfg.min_logit_rise:
                continue
            fix = d - np.median(np.stack([r[2] for r in others]), axis=0)
            severity = Severity.ERROR if rise > cfg.error_logit_rise else Severity.WARNING
            value, threshold = rise, cfg.error_logit_rise if severity is Severity.ERROR else cfg.min_logit_rise
            why = (f"điểm sai cao hơn các frame khác của track {rise:.1f} (ngưỡng {cfg.min_logit_rise:g}; "
                   f"điểm sigmoid {_sigmoid(lg):.0%}, chưa hiệu chuẩn)")
        else:
            p = _sigmoid(lg)
            if p < cfg.min_probability:
                continue
            fix = d
            severity = Severity.ERROR if p >= cfg.error_probability else Severity.WARNING
            value, threshold = p, cfg.error_probability if severity is Severity.ERROR else cfg.min_probability
            why = f"điểm sigmoid {p:.0%}, chưa hiệu chuẩn"
        text = (f"dời ({fix[0]:+.2f}, {fix[1]:+.2f}, {fix[2]:+.2f}) m, kích thước ({fix[3]:+.2f}, {fix[4]:+.2f}, "
                f"{fix[5]:+.2f}) m, xoay {math.degrees(fix[6]):+.1f}°")
        findings.append(Finding(
            error_type=ErrorType.FIT, rule="critic.box", severity=severity, frame=box.frame, label=box.label,
            track_id=box.track_id, source_id=box.source_id, value=float(value), threshold=threshold,
            message=f"Box Critic: box nghi vẽ sai ({why}); gợi ý sửa: {text}",
            details={"suggested_fix": dict(zip(TARGETS, map(float, fix))), "logit": lg},
        ))
    return findings


def _sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    exp = math.exp(x)
    return exp / (1.0 + exp)
