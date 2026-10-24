"""Explicit, user-run weight installation. Preflight itself never downloads."""
import argparse


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare-camera", "prepare-face", "prepare-sam"])
    parser.add_argument("--model", choices=["maskrcnn", "gdino-sam2", "hybrid"])
    args = parser.parse_args()
    if args.action == "prepare-camera" and not args.model:
        parser.error("prepare-camera requires --model")
    if args.action != "prepare-camera" and args.model:
        parser.error("--model is only used with prepare-camera")
    if args.action == "prepare-camera" and args.model in ("maskrcnn", "hybrid"):
        from torchvision.models.detection import MaskRCNN_ResNet50_FPN_V2_Weights
        MaskRCNN_ResNet50_FPN_V2_Weights.COCO_V1.get_state_dict(progress=True, check_hash=True)
    repositories = []
    if args.action == "prepare-camera" and args.model in ("gdino-sam2", "hybrid"):
        from pointsnap.vision.detector2d import (
            GDINO_ID,
            GDINO_REVISION,
            SAM2_ID,
            SAM2_REVISION,
        )
        repositories = [(GDINO_ID, GDINO_REVISION), (SAM2_ID, SAM2_REVISION)]
    elif args.action == "prepare-face":
        from pointsnap.vision.face_clip import CLIP_ID, CLIP_REVISION
        repositories = [(CLIP_ID, CLIP_REVISION)]
    elif args.action == "prepare-sam":
        from pointsnap.vision.detector2d import SAM2_ID, SAM2_REVISION
        repositories = [(SAM2_ID, SAM2_REVISION)]
    if repositories:
        from huggingface_hub import snapshot_download
        for repo, revision in repositories:
            snapshot_download(repo_id=repo, revision=revision, allow_patterns=["*.json", "*.safetensors", "*.txt"])
    print("Trọng số đã sẵn sàng. Bấm Kiểm tra lại trong PointSnap.")


if __name__ == "__main__":
    main()
