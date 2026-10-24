"""Xuất báo cáo CSV chứa chi tiết các phát hiện để thống kê và phân tích (A5)."""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Iterable

from pointsnap.adapters.cvat.reader import JobData, frame_url
from pointsnap.core.model import Finding


def _text_cell(value: str) -> str:
    visible = value.lstrip(' \t\r\n\v\f\ufeff\u200b')
    return "'" + value if visible.startswith(("=", "+", "-", "@")) else value


def generate_csv_report(
    job: JobData,
    findings: Iterable[Finding],
    output_path: str | Path,
) -> Path:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow([
            "frame",
            "track_id",
            "source_id",
            "label",
            "severity",
            "error_type",
            "rule",
            "message",
            "value",
            "threshold",
            "cvat_url",
        ])
        for finding in sorted(findings, key=lambda f: f.sort_key()):
            url = (
                frame_url(
                    job.url,
                    job.task_id,
                    job.job_id,
                    finding.frame,
                    track_id=finding.track_id,
                    shape_id=finding.source_id if finding.track_id is None else None,
                )
                if job.url
                else ""
            )
            writer.writerow([
                finding.frame,
                finding.track_id if finding.track_id is not None else "",
                finding.source_id if finding.source_id is not None else "",
                _text_cell(finding.label),
                finding.severity.value,
                finding.error_type.value,
                _text_cell(finding.rule),
                _text_cell(finding.message),
                finding.value if finding.value is not None else "",
                finding.threshold if finding.threshold is not None else "",
                url,
            ])
    return path
