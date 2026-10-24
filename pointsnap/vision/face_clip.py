"""Ảnh cắt một chiếc xe là **đầu xe hay đuôi xe** (luật `cam.face`), zero-shot bằng CLIP qua `transformers`.

Mỗi ảnh cắt so với hai nhóm câu mô tả ("ảnh chụp đầu / đuôi một chiếc {xe}", vài cách nói, lấy trung bình embedding),
trả xác suất đầu xe `p_front` (softmax trên độ tương đồng nhân `logit_scale` của CLIP). Danh từ theo class của box.

Ảnh cắt được kéo thành hình vuông quanh vật trước khi đưa vào CLIP (bộ xử lý của CLIP cắt giữa ảnh vuông, xe nằm ngang
mà không kéo vuông thì mất đầu / đuôi); phần ra ngoài ảnh tô xám.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Sequence

import numpy as np

CLIP_ID = "openai/clip-vit-large-patch14"
CLIP_REVISION = "32bd64288804d66eefd0ccbe215aa642df71cc41"

NOUNS = {"car": "car", "truck": "truck", "bus": "bus", "trailer": "trailer",
         "construction_vehicle": "construction vehicle", "Vehicle": "vehicle"}
FRONT = ("a photo of the front of a {}.", "the front view of a {}, with headlights and windshield.",
         "a {} seen from the front.", "a {} driving towards the camera.")
REAR = ("a photo of the back of a {}.", "the rear view of a {}, with taillights and rear window.",
        "a {} seen from behind.", "a {} driving away from the camera.")


@dataclass(frozen=True)
class Crop:
    """Vùng xe trên ảnh: khung (x1, y1, x2, y2 pixel) và class của box (chọn danh từ trong câu mô tả)."""

    box: tuple[float, float, float, float]
    label: str


class FaceClassifier(Protocol):
    def front_probability(self, path: Path, crops: Sequence[Crop]) -> list[float]: ...


def available() -> bool:
    try:
        import torch  # noqa: F401
        from transformers import CLIPModel, CLIPProcessor  # noqa: F401
    except (ImportError, OSError, RuntimeError):
        return False
    return True


def square_crop(image: np.ndarray, box: tuple[float, float, float, float], pad: float = 0.1) -> np.ndarray:
    """Cắt hình vuông cạnh max(rộng, cao) × (1 + 2·pad) quanh tâm khung; phần ngoài ảnh tô xám 128."""
    x1, y1, x2, y2 = box
    side = max(x2 - x1, y2 - y1) * (1.0 + 2.0 * pad)
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    left, top = int(round(cx - side / 2.0)), int(round(cy - side / 2.0))
    size = max(int(round(side)), 1)
    out = np.full((size, size, 3), 128, dtype=np.uint8)
    h, w = image.shape[:2]
    sx1, sy1, sx2, sy2 = max(left, 0), max(top, 0), min(left + size, w), min(top + size, h)
    if sx2 > sx1 and sy2 > sy1:
        out[sy1 - top:sy2 - top, sx1 - left:sx2 - left] = image[sy1:sy2, sx1:sx2]
    return out


class ClipFaceClassifier:
    """CLIP ViT-L/14 (revision cố định), nạp lười ở lần gọi đầu, fp16 trên GPU."""

    BATCH = 32

    def __init__(self, device: str | None = None, model_id: str = CLIP_ID, revision: str | None = CLIP_REVISION):
        self.device = device
        self.model_id, self.revision = model_id, revision
        self._model = None
        self._processor = None
        self._text: dict[str, np.ndarray] = {}

    def _load(self):
        if self._model is not None:
            return
        import torch
        from transformers import CLIPModel, CLIPProcessor

        device = self.device or ("cuda" if torch.cuda.is_available() else "cpu")
        dtype = torch.float16 if device.startswith("cuda") else torch.float32
        self._processor = CLIPProcessor.from_pretrained(self.model_id, revision=self.revision)
        self._model = CLIPModel.from_pretrained(self.model_id, revision=self.revision, use_safetensors=True,
                                                dtype=dtype).to(device).eval()
        self.device, self._dtype = device, dtype

    def _text_pair(self, label: str) -> np.ndarray:
        """(2, D) embedding chuẩn hóa của nhóm câu đầu xe / đuôi xe cho class `label`."""
        if label not in self._text:
            import torch

            noun = NOUNS.get(label, label.replace("_", " "))
            rows = []
            for templates in (FRONT, REAR):
                inputs = self._processor(text=[t.format(noun) for t in templates], return_tensors="pt", padding=True)
                with torch.inference_mode():
                    emb = self._model.get_text_features(**{k: v.to(self.device) for k, v in inputs.items()})
                emb = getattr(emb, "pooler_output", emb).float()
                emb = emb / emb.norm(dim=-1, keepdim=True)
                mean = emb.mean(dim=0)
                rows.append((mean / mean.norm()).cpu().numpy())
            self._text[label] = np.stack(rows)
        return self._text[label]

    def front_probability(self, path: Path, crops: Sequence[Crop]) -> list[float]:
        if not crops:
            return []
        import torch
        from PIL import Image

        self._load()
        with Image.open(path) as im:
            image = np.asarray(im.convert("RGB"))
        result: list[float] = []
        scale = float(self._model.logit_scale.exp())
        for start in range(0, len(crops), self.BATCH):
            chunk = crops[start:start + self.BATCH]
            pixels = self._processor(images=[square_crop(image, c.box) for c in chunk], return_tensors="pt")
            with torch.inference_mode():
                emb = self._model.get_image_features(pixel_values=pixels["pixel_values"].to(self.device, self._dtype))
            emb = getattr(emb, "pooler_output", emb).float()
            emb = (emb / emb.norm(dim=-1, keepdim=True)).cpu().numpy()
            for e, c in zip(emb, chunk):
                logits = scale * (self._text_pair(c.label) @ e)
                result.append(float(1.0 / (1.0 + np.exp(logits[1] - logits[0]))))
        return result
