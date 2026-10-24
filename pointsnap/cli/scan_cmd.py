"""Lệnh `pointsnap scan`: quét một job trên CVAT, xuất báo cáo HTML/CSV, tùy chọn gắn cờ lỗi (A5)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from pointsnap.adapters.cvat.client import CvatClient, CvatError
from pointsnap.adapters.cvat.reader import load_job
from pointsnap.adapters.cvat.writer import flag_job_errors, save_snapshot
from pointsnap.cli.common import frames_for_job
from pointsnap.core.config import Config
from pointsnap.core.gate import gate_verdict
from pointsnap.core.model import Finding, Severity
from pointsnap.core.scanner import actionable, scan_coverage_gaps, scan_cuboids
from pointsnap.report.csv_rep import generate_csv_report
from pointsnap.report.html import generate_html_report


def print_summary(num_boxes: int, findings: list[Finding]) -> None:
    counts = {s: sum(1 for f in findings if f.severity is s) for s in Severity}
    print("\n--- TỔNG KẾT QUÉT ---")
    print(f"Tổng số box:      {num_boxes}")
    print(f"Lỗi (cần sửa):    {counts[Severity.ERROR]}")
    print(f"Cảnh báo:         {counts[Severity.WARNING]}")
    print(f"Thông tin:        {counts[Severity.INFO]}")
    print("----------------------")


def run(args: argparse.Namespace, config: Config) -> int:
    try:
        client = CvatClient(config.cvat.url, config.cvat.token)
    except CvatError as exc:
        print(f"Lỗi kết nối CVAT: {exc}", file=sys.stderr)
        return 3

    print(f"Đang tải dữ liệu job #{args.job} từ CVAT ({client.url})...")
    try:
        job = load_job(client, args.job)
    except Exception as exc:
        client.session.close()
        print(f"Lỗi khi đọc job #{args.job}: {exc}", file=sys.stderr)
        return 3

    try:
        return _scan(client, job, args, config)
    finally:
        client.session.close()


def _scan(client, job, args: argparse.Namespace, config: Config) -> int:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Tự động lưu bản chụp JSON
    snap_path = out_dir / f"snapshot_job_{args.job}.json"
    save_snapshot(job, snap_path)
    print(f"-> Đã lưu bản chụp nhãn: {snap_path}")

    # 2. Quét kiểm tra chất lượng nhãn
    frames, note = frames_for_job(job, getattr(args, "manifest", None))
    print(f"-> {note}", file=sys.stdout if frames is not None else sys.stderr)
    print(f"Đang quét {len(job.cuboids)} box của job #{args.job}...")
    findings = scan_cuboids(job, config, frames)
    gaps = scan_coverage_gaps(job, config, frames)
    passed, reasons = gate_verdict(findings, config.gate, coverage_gaps=gaps)

    # 3. Xuất báo cáo HTML và CSV
    html_path = out_dir / f"report_job_{args.job}.html"
    csv_path = out_dir / f"report_job_{args.job}.csv"
    generate_html_report(job, findings, html_path, coverage_gaps=gaps, gate_passed=passed, gate_reasons=reasons)
    generate_csv_report(job, findings, csv_path)
    print(f"-> Báo cáo HTML: {html_path}")
    print(f"-> Báo cáo CSV:  {csv_path}")

    # 4. Gắn cờ lỗi lên CVAT nếu có flag --flag (chỉ mức Lỗi / Cảnh báo; mục Thông tin không gắn cờ)
    if args.flag:
        print("Đang gắn cờ thuộc tính 'pointsnap_error' lên các box bị lỗi trên CVAT...")
        try:
            summary = flag_job_errors(client, job, actionable(findings), flag_attribute=config.cvat.flag_attribute)
            print(f"-> Đã gắn cờ lỗi lên {summary.flagged} box, gỡ cờ cũ ở {summary.cleared} box trên CVAT.")
            if summary.unmatched:
                print(f"   Cảnh báo: {summary.unmatched} finding không khớp box nào trên CVAT, không gắn được cờ.",
                      file=sys.stderr)
        except Exception as exc:
            print(f"Lỗi khi gắn cờ lỗi lên CVAT: {exc}", file=sys.stderr)
            return 3

    print_summary(sum(1 for c in job.cuboids if not c.outside), findings)
    return 0
