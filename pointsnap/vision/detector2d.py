"""Nhận diện vật thể trên ảnh camera bằng model 2D có sẵn (việc C3, lớp 2 của Box Verifier).

Ba lựa chọn, theo `camera.model` của guideline:

- `maskrcnn`: Mask R-CNN ResNet-50 FPN v2 của torchvision, huấn luyện trên COCO. Chỉ có 4 nhóm vật dùng được (người, xe
  hai bánh, xe, động vật); COCO không có cọc tiêu, rào chắn.
- `gdino-sam2`: **Grounding DINO** (IDEA Research, Apache 2.0) tìm vật theo từ khóa (`PROMPTS`), rồi **SAM 2.1** (Meta,
  Apache 2.0) cắt mặt nạ từ từng khung. Nhận diện theo từ khóa nên có thêm cọc tiêu, rào chắn. Cần thêm `transformers`;
  trọng số tải từ Hugging Face ở lần chạy đầu (~1 GB).
- `hybrid`: Mask R-CNN cho các nhóm COCO có (người, xe…), Grounding DINO + SAM 2.1 **chỉ** cho nhóm COCO không có (cọc
  tiêu, rào chắn). Đo trên nuScenes: Grounding DINO nhận người kém Mask R-CNN nhưng là model duy nhất thấy cọc tiêu.

Các model không huấn luyện trên nuScenes, nên đánh giá trên nuScenes không bị rò dữ liệu. Kết quả mỗi ảnh (khung, điểm tin
cậy, tên vật, mặt nạ thu nhỏ 1/4) được lưu vào bộ đệm `~/.pointsnap/cache/det2d/`, khóa theo model, nên chỉ chạy model một
lần cho mỗi ảnh; quét lại / đánh giá nhiều vòng chỉ đọc bộ đệm.

PyTorch là phụ thuộc tùy chọn (`pip install -e ".[vision]"`); không có thì `available()` trả `False` và các luật ảnh
bỏ qua.
"""

from __future__ import annotations

import dataclasses

import hashlib
import importlib.metadata
import json
import os
import re
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pointsnap.web.storage import replace_file

MODELS = ("maskrcnn", "gdino-sam2", "hybrid")
MODEL_NAME = "maskrcnn_resnet50_fpn_v2_coco"
"""Tên của `maskrcnn` trong khóa bộ đệm (giữ nguyên để dùng lại bộ đệm cũ)."""
GDINO_ID = "IDEA-Research/grounding-dino-base"
SAM2_ID = "facebook/sam2.1-hiera-small"
GDINO_REVISION = "12bdfa3120f3e7ec7b434d90674b3396eccf88eb"
SAM2_REVISION = "ee5bba1d82bb8749febdf90f45e84b687142ba03"
CACHE_SCHEMA = 3
MASK_SCALE = 4
"""Mặt nạ lưu ở độ phân giải 1/4 để bộ đệm nhỏ."""

GROUP_OF_COCO = {
    "person": "person",
    "bicycle": "two_wheeler", "motorcycle": "two_wheeler",
    "car": "vehicle", "bus": "vehicle", "truck": "vehicle", "train": "vehicle",
    "dog": "animal", "cat": "animal", "cow": "animal", "horse": "animal", "sheep": "animal",
}
"""Class COCO → nhóm dùng để so với nhãn 3D. Class COCO khác (biển báo, đèn…) bỏ qua."""

PROMPTS = {
    "car": "vehicle", "truck": "vehicle", "bus": "vehicle", "trailer": "vehicle", "construction vehicle": "vehicle",
    "person": "person", "bicycle": "two_wheeler", "motorcycle": "two_wheeler",
    "traffic cone": "traffic_cone", "barrier": "barrier", "dog": "animal",
}
"""Từ khóa gửi Grounding DINO → nhóm."""
FRAGMENTS = {"vehicle": "vehicle", "construction": "vehicle"}
"""Grounding DINO đôi khi chỉ trả một phần từ khóa nhiều chữ ("construction vehicle"). "traffic" một mình không rõ là
cọc tiêu hay đèn nên bỏ."""

SUPPORTED_GROUPS = {
    "maskrcnn": frozenset(GROUP_OF_COCO.values()),
    "gdino-sam2": frozenset(PROMPTS.values()),
    "hybrid": frozenset(PROMPTS.values()) | frozenset(GROUP_OF_COCO.values()),
}
"""Nhóm vật mỗi model nhận được. Box 3D thuộc nhóm model không nhận được thì không đối chiếu (không có bằng chứng)."""


def group_of_name(name: str) -> str | None:
    """Nhóm của tên vật model trả về. Grounding DINO đôi khi ghép hai từ khóa liền nhau ("car truck"): lấy từ khóa
    đứng đầu."""
    name = " ".join(name.lower().split())
    if name in GROUP_OF_COCO:
        return GROUP_OF_COCO[name]
    if name in PROMPTS:
        return PROMPTS[name]
    if name in FRAGMENTS:
        return FRAGMENTS[name]
    hits = [(m.start(), -len(p), g) for p, g in PROMPTS.items()
            if (m := re.search(r"(?<!\w)"+re.escape(p)+r"(?!\w)",name))]
    return min(hits)[2] if hits else None


@dataclass(frozen=True, eq=False)
class Detections:
    """Kết quả nhận diện của một ảnh. `masks[i]` là mặt nạ bool (H/4, W/4) của vật thứ i."""

    boxes: np.ndarray  # (N, 4) x1, y1, x2, y2 pixel ảnh gốc
    scores: np.ndarray  # (N,)
    names: list[str]
    masks: list[np.ndarray]
    brightness: float | None = None
    """Độ sáng trung bình của ảnh (xám 0–255); ảnh đêm của nuScenes 7–89, ảnh ngày 95–117."""
    image_size: tuple[int, int] | None = None  # original (height, width), including partial mask edge cells

    def __post_init__(self):
        boxes, scores = np.asarray(self.boxes), np.asarray(self.scores)
        n = len(boxes)
        if (boxes.shape != (n,4) or scores.shape != (n,) or boxes.dtype.kind not in "fiu"
                or scores.dtype.kind not in "fiu" or not np.isfinite(boxes).all() or not np.isfinite(scores).all()
                or np.any(boxes[:,2:] < boxes[:,:2]) or np.any((scores < 0) | (scores > 1))
                or len(self.names) != n or any(not isinstance(v,str) for v in self.names)
                or len(self.masks) not in (0,n)):
            raise ValueError("Invalid camera detection arrays")
        if any(np.asarray(m).ndim != 2 or not np.isfinite(m).all() for m in self.masks):
            raise ValueError("Invalid camera detection masks")
        if any(not np.isin(m,[0,1]).all() for m in self.masks):
            raise ValueError("Camera masks must be binary")
        if self.masks and any(m.shape != self.masks[0].shape for m in self.masks):
            raise ValueError("Camera masks must have a common shape")
        if self.brightness is not None and (not np.isfinite(self.brightness) or not 0 <= self.brightness <= 255):
            raise ValueError("Invalid camera brightness")
        if self.image_size is not None and (len(self.image_size) != 2 or any(type(v) is not int or v < 1 for v in self.image_size)):
            raise ValueError("Invalid original camera image size")
        object.__setattr__(self,"boxes",boxes.astype(np.float32))
        object.__setattr__(self,"scores",scores.astype(np.float32))
        object.__setattr__(self,"masks",[np.asarray(m,dtype=bool) for m in self.masks])

    def groups(self) -> list[str | None]:
        return [group_of_name(n) for n in self.names]


def available(model: str = "maskrcnn") -> bool:
    try:
        import torch  # noqa: F401
        import torchvision  # noqa: F401

        if model in ("gdino-sam2", "hybrid"):
            from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor, Sam2Model, Sam2Processor  # noqa: F401
    except (ImportError, OSError, RuntimeError):
        return False
    return True


def cuda_available(model: str = "maskrcnn") -> bool:
    if not available(model):
        return False
    import torch

    return bool(torch.cuda.is_available())


def default_cache_dir() -> Path:
    home = os.environ.get("POINTSNAP_HOME")
    return (Path(home) if home else Path.home() / ".pointsnap") / "cache" / "det2d"


class Detector2D:
    """Model 2D theo `model` (`maskrcnn` / `gdino-sam2` / `hybrid`), chạy lười (chỉ nạp model khi gặp ảnh chưa có trong bộ đệm).

    `min_score` là ngưỡng giữ vật khi ghi bộ đệm; luật ảnh lọc tiếp bằng ngưỡng của guideline. Điểm tin cậy của
    Grounding DINO thấp hơn Mask R-CNN (vật rõ thường 0,4 – 0,6), nên bộ đệm của `gdino-sam2` giữ từ 0,2.
    """

    def __init__(self, cache_dir: str | Path | None = None, device: str | None = None, min_score: float = 0.3,
                 model: str = "maskrcnn"):
        if model not in MODELS:
            raise ValueError(f"model ảnh không hỗ trợ: {model!r} (chọn {', '.join(MODELS)})")
        self._parts: tuple[Detector2D, Detector2D] | None = None
        if model == "hybrid":
            self._parts = (Detector2D(cache_dir, device, min_score, "maskrcnn"),
                           Detector2D(cache_dir, device, min_score, "gdino-sam2"))
        self.cache_dir = Path(cache_dir) if cache_dir else default_cache_dir()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.device = device
        self.model = model
        self.min_score = min_score if model == "maskrcnn" else min(min_score, 0.2)
        self.supported_groups = SUPPORTED_GROUPS[model]
        self.fallback_reason: str | None = None
        self._model = None
        self._categories: list[str] | None = None

    def _key(self, path: Path) -> Path:
        stat = path.stat()
        versions = {}
        for library in ("torch","torchvision","transformers","pillow"):
            try: versions[library] = importlib.metadata.version(library)
            except importlib.metadata.PackageNotFoundError: versions[library] = None
        raw = json.dumps({"schema":CACHE_SCHEMA,"model":self.model,"weights":MODEL_NAME+"|COCO_V1|73cbd019",
                          "gdino":(GDINO_ID,GDINO_REVISION),"sam2":(SAM2_ID,SAM2_REVISION),
                          "prompts":PROMPTS,"mask_scale":MASK_SCALE,"min_score":self.min_score,"versions":versions,
                          "processor_backends":{"gdino_fast":False,"sam2_fast":True},
                          "path":str(path.resolve()),"size":stat.st_size,"mtime_ns":stat.st_mtime_ns,
                          "image_sha256":hashlib.sha256(path.read_bytes()).hexdigest()},sort_keys=True)
        return self.cache_dir / f"{hashlib.sha1(raw.encode('utf-8')).hexdigest()}.npz"

    def _load_model(self):
        import torch

        self.device = self.device or ("cuda" if torch.cuda.is_available() else "cpu")
        if self.model == "gdino-sam2":
            self._model = _GroundedSam2(self.device, self.min_score)
            return
        from torchvision.models.detection import MaskRCNN_ResNet50_FPN_V2_Weights, maskrcnn_resnet50_fpn_v2

        weights = MaskRCNN_ResNet50_FPN_V2_Weights.COCO_V1
        model = maskrcnn_resnet50_fpn_v2(weights=weights, box_score_thresh=self.min_score)
        self._model = model.eval().to(self.device)
        self._categories = list(weights.meta["categories"])

    def detect(self, path: str | Path) -> Detections:
        if self._parts is not None:
            return self._detect_hybrid(path)
        path = Path(path)
        cache = self._key(path)
        if cache.is_file():
            try:
                result = _load(cache)
            except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile):
                result = None  # an invalid cache is recomputed, never treated as a clean image
            if result is not None:
                if result.brightness is None:
                    result = dataclasses.replace(result, brightness=image_brightness(path))
                    _save(cache, result)
                return result
        try:
            result = dataclasses.replace(self._run(path),brightness=image_brightness(path))
        except (OSError,ImportError,RuntimeError,ValueError) as exc:
            raise RuntimeError(f"Camera inference unavailable: {exc}") from exc
        _save(cache, result)
        return result

    def _detect_hybrid(self, path: str | Path) -> Detections:
        """Vật của Mask R-CNN, cộng vật của Grounding DINO thuộc nhóm Mask R-CNN không có. Ngưỡng điểm của guideline
        (chọn theo Mask R-CNN) áp dụng chung: cọc tiêu rõ được Grounding DINO chấm 0,5 – 0,75; cộng thêm điểm cho
        Grounding DINO chỉ phủ thêm 1 – 2% box mà bắt đầu báo nhầm `cam.class` (đo trên 5 cảnh tinh chỉnh)."""
        coco = self._parts[0].detect(path)
        if self.fallback_reason is not None:
            return coco
        try:
            extra = self._parts[1].detect(path)
        except (OSError, ImportError, RuntimeError) as exc:
            # Keep COCO evidence; unavailable extra weights do not expand effective capabilities.
            self.fallback_reason = f"hybrid chạy phần COCO; DINO/SAM chưa dùng được: {exc}"
            self.supported_groups = SUPPORTED_GROUPS["maskrcnn"]
            return coco
        keep = [i for i, g in enumerate(extra.groups()) if g is not None and g not in SUPPORTED_GROUPS["maskrcnn"]]
        if not keep:
            return coco
        return Detections(
            np.concatenate([np.asarray(coco.boxes, dtype=np.float32).reshape(-1, 4), extra.boxes[keep]]),
            np.concatenate([np.asarray(coco.scores, dtype=np.float32), extra.scores[keep].astype(np.float32)]),
            list(coco.names) + [extra.names[i] for i in keep],
            list(coco.masks) + [extra.masks[i] for i in keep],
            coco.brightness,
            coco.image_size,
        )

    def _run(self, path: Path) -> Detections:
        import torch
        from PIL import Image
        from torchvision.transforms.functional import to_tensor

        if self._model is None:
            try:
                self._load_model()
            except Exception as exc:
                raise RuntimeError(f"Không nạp được model ảnh {self.model}: {exc}") from exc
        if self.model == "gdino-sam2":
            with Image.open(path) as im:
                return self._model(im.convert("RGB"))
        with Image.open(path) as im:
            size = (im.height,im.width)
            image = to_tensor(im.convert("RGB")).to(self.device)
        with torch.inference_mode():
            out = self._model([image])[0]
        boxes = out["boxes"].cpu().numpy().astype(np.float32)
        scores = out["scores"].cpu().numpy().astype(np.float32)
        names = [self._categories[int(i)] for i in out["labels"].cpu().numpy()]
        return Detections(boxes, scores, names, _shrink(out["masks"][:, 0] > 0.5),image_size=size)


def _shrink(masks_full) -> list[np.ndarray]:
    """Mặt nạ (N, H, W) bool → danh sách mặt nạ 1/4 độ phân giải."""
    import torch

    if len(masks_full) == 0:
        return []
    small = torch.nn.functional.avg_pool2d(masks_full[:, None].float(), MASK_SCALE,ceil_mode=True)[:, 0] > 0.5
    return list(small.cpu().numpy())


def clamp_boxes_to_image(boxes: np.ndarray, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """Clip XYXY boxes and return their original indices, dropping empty/nonfinite intersections.

    The caller uses the same indices for scores/names before generating masks. Never modifies the input.
    """
    raw = np.asarray(boxes, dtype=np.float32).reshape(-1, 4)
    clipped = raw.copy()
    clipped[:, [0, 2]] = np.clip(clipped[:, [0, 2]], 0, width)
    clipped[:, [1, 3]] = np.clip(clipped[:, [1, 3]], 0, height)
    keep = np.flatnonzero(np.isfinite(clipped).all(axis=1) & np.isfinite(raw).all(axis=1)
                         & (clipped[:, 2] > clipped[:, 0]) & (clipped[:, 3] > clipped[:, 1]))
    return clipped[keep], keep


class _GroundedSam2:
    """Grounding DINO (khung theo từ khóa) + SAM 2.1 (mặt nạ từ khung)."""

    BATCH = 32
    """SAM 2.1 cắt tối đa chừng này khung mỗi lượt để vừa GPU 4 GB."""

    def __init__(self, device: str, min_score: float):
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor, Sam2Model, Sam2Processor

        self.device, self.min_score = device, min_score
        self.text = ". ".join(PROMPTS) + "."
        self.gdino_proc = AutoProcessor.from_pretrained(GDINO_ID,revision=GDINO_REVISION,use_fast=False)
        self.gdino = AutoModelForZeroShotObjectDetection.from_pretrained(GDINO_ID,revision=GDINO_REVISION,
                                                                      use_safetensors=True).to(device).eval()
        self.sam_proc = Sam2Processor.from_pretrained(SAM2_ID,revision=SAM2_REVISION,use_fast=True)
        self.sam = Sam2Model.from_pretrained(SAM2_ID,revision=SAM2_REVISION,use_safetensors=True).to(device).eval()

    def __call__(self, image) -> Detections:
        import contextlib

        import torch

        # Chỉ bật fp16 khi chạy GPU; trên CPU không gọi autocast("cuda") (PyTorch cảnh báo khi không có CUDA).
        half = (torch.autocast("cuda", dtype=torch.float16) if str(self.device).startswith("cuda")
                else contextlib.nullcontext())
        with torch.inference_mode(), half:
            inputs = self.gdino_proc(images=image, text=self.text, return_tensors="pt").to(self.device)
            out = self.gdino(**inputs)
        res = self.gdino_proc.post_process_grounded_object_detection(
            out, inputs.input_ids, threshold=self.min_score, text_threshold=0.25, target_sizes=[image.size[::-1]])[0]
        names = [str(n) for n in (res["text_labels"] if "text_labels" in res else res["labels"])]
        boxes, keep = clamp_boxes_to_image(res["boxes"].float().cpu().numpy(), image.width, image.height)
        scores = np.clip(res["scores"].float().cpu().numpy().astype(np.float32), 0.0, 1.0)
        scores = scores[keep]
        names = [names[i] for i in keep]
        masks: list[np.ndarray] = []
        for start in range(0, len(boxes), self.BATCH):
            chunk = boxes[start:start + self.BATCH]
            with torch.inference_mode():
                inp = self.sam_proc(images=image, input_boxes=[chunk.tolist()], return_tensors="pt").to(self.device)
                pred = self.sam(**inp, multimask_output=False).pred_masks
            full = self.sam_proc.post_process_masks(pred.cpu(), inp["original_sizes"])[0][:, 0]
            masks.extend(_shrink(full.bool()))
        return Detections(boxes, scores, names, masks,
                          image_size=(image.height,image.width))


def image_brightness(path: str | Path) -> float:
    from PIL import Image

    with Image.open(path) as im:
        im.draft("L", (im.width // 8, im.height // 8))
        return float(np.asarray(im.convert("L")).mean())


def _save(path: Path, det: Detections) -> None:
    shape = det.masks[0].shape if det.masks else (0, 0)
    packed = np.stack([np.packbits(m.ravel()) for m in det.masks]) if det.masks else np.zeros((0, 0), np.uint8)
    extra = {} if det.brightness is None else {"brightness": np.array(det.brightness)}
    if det.image_size is not None: extra["image_size"] = np.array(det.image_size)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb",dir=path.parent,prefix=".ps-",suffix=".tmp",delete=False) as handle:
            temporary = Path(handle.name)
            np.savez_compressed(handle, boxes=det.boxes, scores=det.scores, names=np.array(det.names, dtype=str),
                                masks=packed, shape=np.array(shape), **extra)
        replace_file(temporary,path)
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)


def _load(path: Path) -> Detections:
    with np.load(path,allow_pickle=False) as data:
        h, w = (int(v) for v in data["shape"])
        packed = data["masks"]
        if min(h,w) < 0 or packed.ndim != 2 or packed.dtype != np.uint8 or (h and packed.shape[1] != (h*w+7)//8):
            raise ValueError("Invalid packed camera masks")
        masks = [np.unpackbits(row)[:h*w].reshape(h,w).astype(bool) for row in packed] if h else []
        brightness = float(data["brightness"]) if "brightness" in data else None
        size = tuple(int(v) for v in data["image_size"]) if "image_size" in data else None
        return Detections(data["boxes"],data["scores"],[str(n) for n in data["names"]],masks,brightness,size)
