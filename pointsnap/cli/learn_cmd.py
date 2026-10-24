"""Lệnh `pointsnap learn`: học từ kết luận Đúng / Báo nhầm của người duyệt (việc C3, lớp 4 của Box Verifier)."""

from __future__ import annotations

import argparse
import sys

from pointsnap.core.config import Config
from pointsnap.learn import learn_project, report
from pointsnap.web.projects import ProjectError, ProjectManager


def add_parser(sub: argparse._SubParsersAction) -> None:
    learn = sub.add_parser("learn", help="học từ kết luận Đúng / Báo nhầm đã duyệt của một dự án trên giao diện web")
    learn.add_argument("--project", required=True, help="slug dự án (tên thư mục trong ~/.pointsnap/projects)")


def run(args: argparse.Namespace, config: Config) -> int:
    try:
        project_dir = ProjectManager()._project_dir(args.project)
    except ProjectError as exc:
        print(f"Lỗi: {exc}", file=sys.stderr)
        return 3
    if not project_dir.is_dir():
        print(f"Lỗi: không có dự án '{args.project}'", file=sys.stderr)
        return 3
    print(report(learn_project(project_dir)))
    print(f"-> Đã lưu {project_dir / 'learned.json'}; áp dụng từ lần quét sau trên giao diện web.")
    return 0
