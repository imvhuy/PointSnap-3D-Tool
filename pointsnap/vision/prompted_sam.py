"""Cắt mặt nạ vật trên ảnh camera bằng SAM 2.1, prompt lấy từ chính box 3D và điểm LiDAR (luật `fit.offset`).

Khác `vision.detector2d` (Grounding DINO tìm vật trên cả ảnh rồi SAM cắt theo khung của DINO): ở đây mỗi box 3D tự tạo
prompt (khung chiếu của box, điểm LiDAR của vật làm điểm dương, điểm của box lân cận làm điểm âm), nên không phụ thuộc DINO
có thấy vật hay không và không phải ghép vật theo IoU.

Mỗi ảnh chỉ mã hóa một lần (`get_image_embeddings`), giữ `cache_images` ảnh gần nhất (6 camera của một frame); mọi prompt
của ảnh giải mã theo lô. Kết quả không phải mặt nạ đầy đủ mà là: các điểm truy vấn (điểm LiDAR chiếu lên ảnh) có nằm
trong mặt nạ không, diện tích và khung bao của mặt nạ. Như vậy không phải chép mặt nạ 900×1600 về CPU cho từng prompt.

Dùng cùng trọng số SAM 2.1 (revision cố định) với `detector2d`.
"""

from __future__ import annotations

import contextlib
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, Sequence

import numpy as np

from pointsnap.vision.detector2d import SAM2_ID, SAM2_REVISION

_EMPTY = np.zeros((0, 2), dtype=np.float64)


@dataclass(frozen=True, eq=False)
class Prompt:
    """Prompt cho một vật: khung (x1, y1, x2, y2 pixel), điểm dương / âm (K, 2), điểm truy vấn (M, 2).

    `prefer` (bool theo `queries`, tùy chọn): các điểm truy vấn chắc thuộc vật. Khi có, SAM trả 3 mặt nạ (một phần / cả
    vật / vật và nền quanh) và chọn mặt nạ chứa nhiều điểm `prefer` nhất: một prompt trên xe tải dễ chỉ ra thùng hàng
    mà không có cabin."""

    box: tuple[float, float, float, float]
    positive: np.ndarray = field(default_factory=lambda: _EMPTY)
    negative: np.ndarray = field(default_factory=lambda: _EMPTY)
    queries: np.ndarray = field(default_factory=lambda: _EMPTY)
    prefer: np.ndarray | None = None


@dataclass(frozen=True, eq=False)
class MaskResult:
    """`inside[i]`: điểm truy vấn thứ i nằm trong mặt nạ. `bbox` là khung bao mặt nạ (None nếu mặt nạ rỗng)."""

    inside: np.ndarray
    area: int
    bbox: tuple[float, float, float, float] | None
    score: float


class PromptSegmenter(Protocol):
    def segment(self, path: Path, prompts: Sequence[Prompt]) -> list[MaskResult]: ...


def available() -> bool:
    try:
        import torch  # noqa: F401
        import torchvision  # noqa: F401 - Sam2Processor(use_fast=True) requires torchvision ops.
        from transformers import Sam2Model, Sam2Processor  # noqa: F401
    except (ImportError, OSError, RuntimeError):
        return False
    return True


class Sam2PromptSegmenter:
    """SAM 2.1 hiera-small qua `transformers`, nạp lười ở ảnh đầu tiên."""

    BATCH = 32
    """Số prompt giải mã mỗi lượt (vừa GPU 4 GB cùng mặt nạ cỡ ảnh gốc)."""
    MAX_AREA_RATIO = 3.0
    """Khi chọn trong 3 mặt nạ, bỏ mặt nạ lớn hơn chừng này × khung prompt (vật và cả nền quanh)."""

    def __init__(self, device: str | None = None, cache_images: int = 6):
        self.device = device
        self.cache_images = cache_images
        self._model = None
        self._processor = None
        self._embeddings: OrderedDict[tuple[str, int], tuple[list, list]] = OrderedDict()

    def _load(self) -> None:
        import torch
        from transformers import Sam2Model, Sam2Processor

        self.device = self.device or ("cuda" if torch.cuda.is_available() else "cpu")
        self._processor = Sam2Processor.from_pretrained(SAM2_ID, revision=SAM2_REVISION, use_fast=True)
        self._model = Sam2Model.from_pretrained(SAM2_ID, revision=SAM2_REVISION,
                                                use_safetensors=True).to(self.device).eval()

    def _autocast(self):
        import torch

        return (torch.autocast("cuda", dtype=torch.float16) if str(self.device).startswith("cuda")
                else contextlib.nullcontext())

    def _embed(self, path: Path) -> tuple[list, list]:
        import torch
        from PIL import Image

        key = (str(Path(path).resolve()), Path(path).stat().st_mtime_ns)
        if key in self._embeddings:
            self._embeddings.move_to_end(key)
            return self._embeddings[key]
        if self._model is None:
            self._load()
        with Image.open(path) as im:
            image = im.convert("RGB")
        inputs = self._processor(images=image, return_tensors="pt").to(self.device)
        with torch.inference_mode(), self._autocast():
            embeddings = self._model.get_image_embeddings(inputs["pixel_values"])
        entry = (embeddings, inputs["original_sizes"].tolist())
        self._embeddings[key] = entry
        while len(self._embeddings) > self.cache_images:
            self._embeddings.popitem(last=False)
        return entry

    def segment(self, path: Path, prompts: Sequence[Prompt]) -> list[MaskResult]:
        import torch

        if not prompts:
            return []
        embeddings, sizes = self._embed(path)
        height, width = (int(v) for v in sizes[0])
        results: list[MaskResult] = []
        for start in range(0, len(prompts), self.BATCH):
            chunk = prompts[start:start + self.BATCH]
            kwargs = {"original_sizes": sizes, "input_boxes": [[[float(v) for v in p.box] for p in chunk]],
                      "return_tensors": "pt"}
            if any(len(p.positive) + len(p.negative) for p in chunk):
                # Vật không có điểm nào: processor đệm toàn bộ bằng điểm "bỏ qua" (-10).
                kwargs["input_points"] = [[[*map(list, p.positive), *map(list, p.negative)] or [[-10.0, -10.0]]
                                           for p in chunk]]
                kwargs["input_labels"] = [[[1] * len(p.positive) + [0] * len(p.negative) or [-10]
                                           for p in chunk]]
            enc = self._processor(**kwargs).to(self.device)
            multi = any(p.prefer is not None for p in chunk)
            with torch.inference_mode(), self._autocast():
                out = self._model(image_embeddings=embeddings, input_boxes=enc["input_boxes"],
                                  input_points=enc.get("input_points"), input_labels=enc.get("input_labels"),
                                  multimask_output=multi)
            low, iou = out.pred_masks[0].float(), out.iou_scores[0].float()  # (n, m, h, w), (n, m)
            best = [_choose(low[i], iou[i], p, width, height, self.MAX_AREA_RATIO) for i, p in enumerate(chunk)]
            chosen = torch.stack([low[i, b] for i, b in enumerate(best)])[None, :, None]
            masks = self._processor.post_process_masks(chosen, enc["original_sizes"])[0][:, 0]
            for i, prompt in enumerate(chunk):
                results.append(_summarize(masks[i], prompt.queries, width, height, float(iou[i, best[i]])))
        return results


def _choose(low, iou, prompt: Prompt, width: int, height: int, max_area_ratio: float) -> int:
    """Chỉ số mặt nạ (trong `low`: (m, h, w) logit độ phân giải thấp) nên dùng cho `prompt`.

    SAM 2 đổi ảnh về 1024×1024 không giữ tỉ lệ, nên mặt nạ thấp (h, w) ứng tuyến tính với ảnh gốc. Chọn mặt nạ chứa nhiều
    điểm `prefer` nhất, không quá lớn so với khung prompt; hòa thì lấy điểm IoU dự đoán cao hơn."""
    if low.shape[0] == 1 or prompt.prefer is None:
        return int(iou.argmax())
    import torch

    m, h, w = low.shape
    q = np.asarray(prompt.queries, dtype=np.float64).reshape(-1, 2)[np.asarray(prompt.prefer, dtype=bool)]
    q = q[np.isfinite(q).all(axis=1) & (q[:, 0] >= 0) & (q[:, 0] < width) & (q[:, 1] >= 0) & (q[:, 1] < height)]
    x1, y1, x2, y2 = prompt.box
    rect_low = max((x2 - x1) * (y2 - y1), 1.0) * (h * w) / (width * height)
    area = (low > 0).flatten(1).sum(dim=1).float()
    if len(q):
        cols = torch.as_tensor((q[:, 0] * w / width).astype(np.int64), device=low.device)
        rows = torch.as_tensor((q[:, 1] * h / height).astype(np.int64), device=low.device)
        hits = (low[:, rows, cols] > 0).sum(dim=1).float()
    else:
        hits = torch.zeros(m, device=low.device)
    score = hits * 10.0 + iou  # số điểm thuộc vật trước, IoU dự đoán để phân hòa
    score = torch.where(area <= max_area_ratio * rect_low, score, torch.full_like(score, -1.0))
    return int(score.argmax())


def _summarize(mask, queries: np.ndarray, width: int, height: int, score: float) -> MaskResult:
    """Tra điểm truy vấn trong mặt nạ (tensor bool H×W) ngay trên thiết bị của mặt nạ."""
    import torch

    q = np.asarray(queries, dtype=np.float64).reshape(-1, 2)
    inside = np.zeros(len(q), dtype=bool)
    valid = np.isfinite(q).all(axis=1) & (q[:, 0] >= 0) & (q[:, 0] < width) & (q[:, 1] >= 0) & (q[:, 1] < height)
    if valid.any():
        cols = torch.as_tensor(q[valid, 0].astype(np.int64), device=mask.device)
        rows = torch.as_tensor(q[valid, 1].astype(np.int64), device=mask.device)
        inside[valid] = mask[rows, cols].cpu().numpy()
    area = int(mask.sum().item())
    if area == 0:
        return MaskResult(inside, 0, None, score)
    rows_any = torch.nonzero(mask.any(dim=1)).flatten()
    cols_any = torch.nonzero(mask.any(dim=0)).flatten()
    bbox = (float(cols_any[0]), float(rows_any[0]), float(cols_any[-1] + 1), float(rows_any[-1] + 1))
    return MaskResult(inside, area, bbox, score)
