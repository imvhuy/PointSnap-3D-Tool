"""Lệnh `pointsnap eval`: đánh giá các bộ phát hiện bằng lỗi chèn giả trên nuScenes (việc B6)."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from pointsnap.adapters.nuscenes import NuScenesReader
from pointsnap.core.config import Config
from pointsnap.eval.evaluate import run_evaluation
from pointsnap.eval.split import TEST_SCENES, TUNING_SCENES

SCENE_SETS = {"test": TEST_SCENES, "tuning": TUNING_SCENES, "all": TUNING_SCENES + TEST_SCENES}


def add_parser(sub: argparse._SubParsersAction) -> None:
    ev = sub.add_parser("eval", help="đánh giá precision / recall bằng lỗi chèn giả trên nuScenes")
    ev.add_argument(
        "--dataroot", type=Path, default=os.environ.get("NUSCENES_ROOT"),
        help="thư mục nuScenes (mặc định: biến môi trường NUSCENES_ROOT)",
    )
    ev.add_argument("--scenes", nargs="+", default=["test"],
                    help="test | tuning | all, hoặc danh sách tên cảnh (mặc định: test = 5 cảnh kiểm tra)")
    ev.add_argument("--rounds", type=int, default=10, help="số vòng chèn lỗi mỗi cảnh (mặc định: 10)")
    ev.add_argument("--seed", type=int, default=0, help="seed của bộ chèn lỗi (mặc định: 0)")
    ev.add_argument("--out", type=Path, default=Path("out/eval"), help="thư mục ghi kết quả (mặc định: out/eval)")
    ev.add_argument("--errors", choices=("core", "c1", "all"), default="all",
                    help="bộ lỗi chèn: core = 6 loại của mục 8.1, c1 = sai hướng và box lệch, all = cả hai (mặc định)")


def add_critic_parser(sub: argparse._SubParsersAction) -> None:
    cd = sub.add_parser("critic-data", help="xuất dữ liệu huấn luyện Box Critic từ nhãn chuẩn nuScenes (docs/huong-dan/huan-luyen-box-critic.md)")
    cd.add_argument("--dataroot", type=Path, default=os.environ.get("NUSCENES_ROOT"),
                    help="thư mục nuScenes (mặc định: biến môi trường NUSCENES_ROOT)")
    cd.add_argument("--scenes", nargs="+", default=["tuning"], help="tuning hoặc tên cảnh học; không xuất 5 cảnh held-out")
    cd.add_argument("--samples-per-box", type=int, default=6, help="số mẫu nhiễu mỗi box (mặc định: 6)")
    cd.add_argument("--seed", type=int, default=0)
    cd.add_argument("--out", type=Path, default=Path("data/critic"), help="thư mục ghi (mặc định: data/critic)")


def run_critic(args: argparse.Namespace, config: Config) -> int:
    from pointsnap.critic import export_dataset

    if args.dataroot is None:
        print("Thiếu --dataroot (hoặc biến môi trường NUSCENES_ROOT).", file=sys.stderr)
        return 3
    scenes: list[str] = []
    for item in args.scenes:
        scenes.extend(SCENE_SETS.get(item, (item,)))
    if set(scenes) & set(TEST_SCENES):
        print("Không xuất cảnh held-out làm dữ liệu học Critic; dùng --scenes tuning.", file=sys.stderr)
        return 3
    totals = export_dataset(NuScenesReader(args.dataroot), scenes, args.out, samples_per_box=args.samples_per_box,
                            seed=args.seed)
    print(f"-> {totals['samples']} mẫu ({totals['errors']} mẫu sai) trong {args.out}")
    return 0


def run(args: argparse.Namespace, config: Config) -> int:
    if args.dataroot is None:
        print("Thiếu --dataroot (hoặc biến môi trường NUSCENES_ROOT).", file=sys.stderr)
        return 3
    scenes: list[str] = []
    for item in args.scenes:
        scenes.extend(SCENE_SETS.get(item, (item,)))
    label = " ".join(args.scenes)
    try:
        reader = NuScenesReader(args.dataroot)
        run_evaluation(reader, scenes, config, args.out, rounds=args.rounds, seed=args.seed, catalog=args.errors,
                       title=f"Kết quả đánh giá PointSnap 3D ({label}, {args.rounds} vòng chèn lỗi, bộ lỗi {args.errors})")
    except (FileNotFoundError, KeyError, ValueError) as exc:
        print(f"Lỗi: {exc}", file=sys.stderr)
        return 3
    print(f"-> Kết quả: {args.out / 'ket-qua.md'}")
    return 0
