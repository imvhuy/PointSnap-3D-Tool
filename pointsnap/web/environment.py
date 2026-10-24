"""Project-scoped preflight. Never downloads weights or runs a detector on page load."""
from __future__ import annotations

import hashlib
import importlib
import json
import sys
from functools import lru_cache
from pathlib import Path

from pointsnap.core.rules import rules_catalog_dict
from pointsnap.web.findings import GROUPS


@lru_cache(maxsize=16)
def _critic_check(path, size, modified):
    try:
        import torch
        model = torch.jit.load(path, map_location="cpu").eval()
        with torch.inference_mode():
            logit, delta = model(torch.zeros(1, 256, 4), torch.zeros(1, 20))
        return bool(logit.numel() == 1 and tuple(delta.shape) == (1, 7)
                    and torch.isfinite(logit).all() and torch.isfinite(delta).all())
    except Exception:  # noqa: BLE001 - A corrupt optional model must be reported as unavailable.
        return False


@lru_cache(maxsize=16)
def _weight_hash(path, size, modified, prefix):
    # file_digest only exists on Python 3.11+. Hash bounded chunks on every
    # supported Python, without loading a several-hundred-MB weight into RAM.
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest().startswith(prefix)
    except OSError:
        return False


def _hf_cache_ready(repo, revision, processor_class, model_class, transformers):
    """Check local processor/config and every safetensors shard, without a model.

    Checking a config or a single shard alone reports incomplete downloads as
    usable. safe_open validates the file layout without loading tensor data.
    All Hugging Face resolution stays explicitly offline, including processors
    (tokenizer, vocabulary and image processing files).
    """
    from safetensors import safe_open
    from transformers.utils.hub import cached_file

    if not callable(getattr(model_class, "from_pretrained", None)):
        return False
    config_class = getattr(model_class, "config_class", None) or transformers.AutoConfig
    config_class.from_pretrained(repo, revision=revision, local_files_only=True)
    processor_class.from_pretrained(repo, revision=revision, local_files_only=True)

    def cached(name):
        return cached_file(repo, name, revision=revision, local_files_only=True,
                           _raise_exceptions_for_missing_entries=False,
                           _raise_exceptions_for_connection_errors=False)

    weight = cached("model.safetensors")
    paths = [weight] if weight else []
    if not paths:
        index = cached("model.safetensors.index.json")
        if not index or Path(index).stat().st_size > 2 * 1024 * 1024:
            return False
        mapping = json.loads(Path(index).read_text(encoding="utf-8")).get("weight_map")
        if not isinstance(mapping, dict) or not mapping:
            return False
        names = set(mapping.values())
        if any(not isinstance(name, str) or "/" in name or "\\" in name
               or not name.endswith(".safetensors") for name in names):
            return False
        paths = [cached(name) for name in sorted(names)]
    if not paths or not all(paths):
        return False
    for path in paths:
        with safe_open(path, framework="np") as tensors:
            keys = list(tensors.keys())
            if not keys:
                return False
            for key in keys:
                tensors.get_slice(key).get_shape()
    return True


def _maskrcnn_ready(torch):
    from torchvision.models.detection import MaskRCNN_ResNet50_FPN_V2_Weights

    url = MaskRCNN_ResNet50_FPN_V2_Weights.COCO_V1.url
    name = url.rsplit("/", 1)[-1]
    weight = Path(torch.hub.get_dir()) / "checkpoints" / name
    if not weight.is_file():
        return False
    stat = weight.stat()
    return _weight_hash(str(weight), stat.st_size, stat.st_mtime_ns, name.rsplit("-", 1)[-1].split(".")[0])


def _camera_weights_ready(key, model, runtime):
    if key == "camera" and model in ("maskrcnn", "hybrid") and not _maskrcnn_ready(runtime["torch"]):
        return False
    if key == "camera" and model == "maskrcnn":
        return True
    transformers = runtime["transformers"]
    from pointsnap.vision import detector2d as d

    if key == "face":
        from pointsnap.vision.face_clip import CLIP_ID, CLIP_REVISION
        specs = ((CLIP_ID, CLIP_REVISION, "CLIPProcessor", "CLIPModel"),)
    elif key == "sam":
        specs = ((d.SAM2_ID, d.SAM2_REVISION, "Sam2Processor", "Sam2Model"),)
    else:
        specs = ((d.GDINO_ID, d.GDINO_REVISION, "AutoProcessor", "AutoModelForZeroShotObjectDetection"),
                 (d.SAM2_ID, d.SAM2_REVISION, "Sam2Processor", "Sam2Model"))
    return all(_hf_cache_ready(repo, revision, getattr(transformers, processor), getattr(transformers, cls),
                               transformers) for repo, revision, processor, cls in specs)


def model_status(config):
    result = []
    camera_on = config.camera.enabled != "false" and any(
        getattr(config.rules, r, False) for r in ("cam_mismatch", "cam_class", "cam_missing", "cam_sparse"))
    face_on = config.camera.enabled != "false" and getattr(config.rules, "cam_face", False)
    sam_on = (any(getattr(config.rules, rule, False) for rule in ("fit_offset", "fit_yaw"))
              and getattr(getattr(config, "box_fit", None), "source", "lidar") == "sam")
    for key, selected, required, name, packages, command in (
        ("critic", config.rules.critic_box, config.rules.critic_box, "Box Critic", ("torch",), None),
        ("camera", camera_on, camera_on, f"Camera · {config.camera.model}",
         ("torch", "torchvision") + (("transformers",) if config.camera.model != "maskrcnn" else ()),
         f"prepare-camera --model {config.camera.model}"),
        ("face", face_on, face_on, "Đầu / đuôi xe · CLIP", ("torch", "transformers", "PIL"), "prepare-face"),
        ("sam", sam_on, False, "Box fit · SAM 2.1", ("torch", "torchvision", "transformers", "PIL"), "prepare-sam"),
    ):
        install_packages = {"transformers": '"transformers>=5.0"', "PIL": '"pillow>=10"'}
        entry = {"id": key, "selected": bool(selected), "required": bool(required), "ready": not selected,
                 "name": name,
                 "reason": "Không dùng trong cấu hình hiện tại", "install_command": f'"{sys.executable}" -m pip install ' +
                 ' '.join(install_packages.get(package, package) for package in packages)}
        if command:
            entry["weights_command"] = f'"{sys.executable}" -m pointsnap.models {command}'
        if key == "sam":
            entry["fallback"] = None
        if key == "critic":
            entry.update(config_key="critic.model", path=config.critic.model)
        elif key == "camera":
            entry["mode"] = config.camera.enabled
        if not selected:
            result.append(entry)
            continue
        try:
            if key != "critic" and config.camera.enabled == "false":
                entry["reason"] = "camera.enabled: false đã tắt model camera"
            else:
                runtime = {package: importlib.import_module(package) for package in packages}
                if key == "critic":
                    path = Path(config.critic.model).expanduser() if config.critic.model else None
                    valid = bool(path and path.is_file())
                    if valid:
                        stat = path.stat()
                        valid = _critic_check(str(path.resolve()), stat.st_size, stat.st_mtime_ns)
                    entry.update(ready=valid, reason="Model hợp lệ" if valid else "Cần cấu hình critic.model trỏ tới trọng số TorchScript hợp lệ",
                                 path=str(path) if path else "")
                elif config.camera.enabled == "auto" and not runtime["torch"].cuda.is_available():
                    entry["reason"] = "Camera auto cần GPU CUDA; chọn camera.enabled: true để chạy CPU hoặc tắt các luật camera"
                else:
                    valid = _camera_weights_ready(key, config.camera.model, runtime)
                    entry.update(ready=valid, reason="Runtime và trọng số có sẵn" if valid else
                                 "Thiếu/hỏng trọng số hoặc bộ xử lý; chuẩn bị model theo hướng dẫn rồi kiểm tra lại")
        except Exception:  # noqa: BLE001 - Optional packages and cache formats have heterogeneous exceptions.
            # Optional runtime imports, processor classes and inaccessible/broken
            # caches are a readiness result, never an HTTP 500 on page load.
            entry.update(ready=False, reason="Thiếu/lỗi runtime, lớp model hoặc bộ đệm trọng số: " + ", ".join(packages))
        if key == "sam" and not entry["ready"]:
            entry.update(fallback="lidar", reason=entry["reason"] + "; đo bằng LiDAR thay thế")
        result.append(entry)
    return {"items": result, "all_ready": all(m["ready"] for m in result if m["required"]), "python": sys.executable}


def project_catalog(config=None):
    data = rules_catalog_dict()
    models = model_status(config) if config else None
    status = {m["id"]: m for m in models["items"]} if models else {}
    rules, seen = [], set()
    for rule in data["rules"]:
        if rule["error_type"] not in GROUPS or rule["default_severity"] == "info" or rule["switch_key"] in seen:
            continue
        seen.add(rule["switch_key"])
        enabled = bool(getattr(config.rules, rule["switch_key"], False)) if config else None
        dependency = ("critic" if rule["id"].startswith("critic.") else "face" if rule["id"] == "cam.face"
                      else "camera" if rule["id"].startswith("cam.") else "sam"
                      if config and rule["switch_key"] in ("fit_offset", "fit_yaw") and config.box_fit.source == "sam"
                      else None)
        model = status.get(dependency, {})
        fallback = model.get("fallback")
        ready = not dependency or not config or model["ready"] or bool(fallback)
        if dependency in ("camera", "face") and config and config.camera.enabled == "false":
            ready = False
        rule.update(enabled=enabled, runnable=bool(enabled and ready), dependency=dependency,
                    fallback=fallback,
                    unavailable_reason=("camera.enabled: false đã tắt model camera" if config and
                                        dependency in ("camera", "face") and config.camera.enabled == "false"
                                        else model.get("reason", "")) if not ready else "",
                    fallback_reason=model.get("reason", "") if fallback else "")
        rules.append(rule)
    data.update(rules=rules, groups=GROUPS, models=models)
    return data
