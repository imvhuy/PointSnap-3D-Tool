"""Lệnh `pointsnap gate`: cổng kiểm tra trước khi nộp, trả về ĐẠT (0) hoặc KHÔNG ĐẠT (1) (A5)."""

from __future__ import annotations

import argparse
import sys

from pointsnap.adapters.cvat.client import CvatClient, CvatError
from pointsnap.adapters.cvat.reader import load_job
from pointsnap.cli.common import frames_for_job
from pointsnap.core.config import Config
from pointsnap.core.gate import gate_verdict
from pointsnap.core.model import Severity
from pointsnap.core.scanner import scan_coverage_gaps, scan_cuboids

EXIT_OK = 0
EXIT_GATE_FAILED = 1
EXIT_RUNTIME_ERROR = 3


def run(args: argparse.Namespace, config: Config) -> int:
    try:
        client = CvatClient(config.cvat.url, config.cvat.token)
    except CvatError as exc:
        print(f"Lỗi kết nối CVAT: {exc}", file=sys.stderr)
        return EXIT_RUNTIME_ERROR

    try:
        job = load_job(client, args.job)
    except Exception as exc:
        client.session.close()
        print(f"Lỗi khi đọc job #{args.job}: {exc}", file=sys.stderr)
        return EXIT_RUNTIME_ERROR

    try:
        return _gate(job, args, config)
    finally:
        client.session.close()


def _gate(job, args: argparse.Namespace, config: Config) -> int:
    try:
        frames, note = frames_for_job(job, getattr(args, "manifest", None))
        if frames is None:
            print(note, file=sys.stderr)
        findings = scan_cuboids(job, config, frames)
        coverage_gaps = scan_coverage_gaps(job, config, frames)
    except (OSError, KeyError, ValueError) as exc:
        print(f"Lỗi khi quét job #{args.job}: {exc}", file=sys.stderr)
        return EXIT_RUNTIME_ERROR

    errors = [f for f in findings if f.severity == Severity.ERROR]
    warnings = [f for f in findings if f.severity == Severity.WARNING]

    num_errors = len(errors)
    num_warnings = len(warnings)

    max_err = config.gate.max_errors
    max_warn = config.gate.max_warnings

    passed, reasons = gate_verdict(findings, config.gate, coverage_gaps=coverage_gaps)

    if not passed:
        print(f"❌ [KHÔNG ĐẠT] Cổng kiểm tra Job #{args.job} không đạt yêu cầu!")
        for r in reasons:
            print(f"   • {r}")
        if errors:
            print("\nDanh sách các lỗi chính:")
            for e in errors[:5]:
                print(f"   - Frame {e.frame}, Track {e.track_id}: {e.message}")
            if len(errors) > 5:
                print(f"   - ... và {len(errors) - 5} lỗi khác.")
        return EXIT_GATE_FAILED

    print(f"✅ [ĐẠT] Cổng kiểm tra Job #{args.job} đạt ngưỡng của các luật đang bật.")
    print(f"   • Số lỗi:     {num_errors} (ngưỡng: {max_err})")
    print(f"   • Cảnh báo:   {num_warnings} (ngưỡng: {max_warn})")
    print(f"   • Tổng số box: {sum(not c.outside for c in job.cuboids)}")
    return EXIT_OK
