"""Lệnh `pointsnap ui`: khởi chạy máy chủ giao diện Web của PointSnap 3D (A11)."""

from __future__ import annotations

import argparse
import sys
import threading
import time
import webbrowser

import uvicorn

from pointsnap.core.config import Config


def add_parser(sub: argparse._SubParsersAction) -> argparse.ArgumentParser:
    parser = sub.add_parser("ui", help="khởi chạy giao diện Web trên trình duyệt")
    parser.add_argument(
        "--host", default="127.0.0.1", help="địa chỉ IP lắng nghe (mặc định: 127.0.0.1)"
    )
    parser.add_argument(
        "--port", type=int, default=8765, help="cổng máy chủ (mặc định: 8765)"
    )
    parser.add_argument(
        "--no-browser", action="store_true", help="không tự động mở trình duyệt"
    )
    return parser


def run(args: argparse.Namespace, config: Config) -> int:
    host = args.host
    port = args.port
    url = f"http://{host}:{port}"

    print(f"Khởi chạy giao diện PointSnap 3D tại {url} ...")

    if not args.no_browser:

        def open_browser() -> None:
            time.sleep(1.2)
            try:
                webbrowser.open(url)
            except Exception:
                pass

        threading.Thread(target=open_browser, daemon=True).start()

    try:
        uvicorn.run("pointsnap.web.app:app", host=host, port=port, log_level="info")
        return 0
    except KeyboardInterrupt:
        print("\nĐã dừng máy chủ giao diện.", file=sys.stderr)
        return 0
    except Exception as exc:
        print(f"Lỗi khởi chạy máy chủ giao diện: {exc}", file=sys.stderr)
        return 3
