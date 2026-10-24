"""Tính toán các chỉ số đánh giá Precision, Recall, False Alarms (việc B6).

Theo đặc tả mục 8.2 của docs/thiet-ke/de-xuat-de-tai.md:
- Recall theo loại lỗi (floating, size, track) và theo mức độ (error, warning).
- Precision theo từng loại lỗi.
- Sai số đo đạc: median và p90 của sai số số đo so với lỗi chèn.
- Tạo bảng markdown kết quả đánh giá cho docs/ket-qua/danh-gia.md.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from pointsnap.core.model import Finding, Severity


@dataclass(frozen=True)
class InjectedFault:
    """Một lỗi được chèn giả vào dữ liệu kiểm tra."""

    error_type: str  # "floating" | "size" | "track"
    frame: int
    track_id: int | None = None
    severity: str = "error"  # "error" | "warning"
    rule: str = ""
    delta: float = 0.0
    details: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class MetricSummary:
    total_injected: int = 0
    true_positives: int = 0
    false_positives: int = 0
    false_negatives: int = 0
    measurement_errors: list[float] = field(default_factory=list)

    @property
    def recall(self) -> float | None:
        return (self.true_positives / self.total_injected) if self.total_injected > 0 else None

    @property
    def precision(self) -> float | None:
        total_detected = self.true_positives + self.false_positives
        return (self.true_positives / total_detected) if total_detected > 0 else None

    @property
    def median_error(self) -> float:
        return float(np.median(self.measurement_errors)) if self.measurement_errors else 0.0

    @property
    def p90_error(self) -> float:
        return float(np.percentile(self.measurement_errors, 90)) if self.measurement_errors else 0.0


@dataclass
class EvaluationReport:
    overall: MetricSummary = field(default_factory=MetricSummary)
    by_type: dict[str, MetricSummary] = field(default_factory=dict)
    by_severity: dict[str, MetricSummary] = field(default_factory=dict)
    clean_boxes_total: int = 0
    clean_false_alarms: int = 0
    clean_warning_count: int = 0
    clean_error_count: int = 0
    clean_evaluated: bool = False

    @property
    def false_alarm_rate_per_100(self) -> float | None:
        if self.clean_boxes_total == 0 or not self.clean_evaluated:
            return None
        return (self.clean_false_alarms / self.clean_boxes_total) * 100.0

    def to_markdown(self) -> str:
        def pct(value): return f'{value*100:.1f}%' if value is not None else '—'
        def status(value, target): return 'CHƯA ĐO' if value is None else ('ĐẠT' if value >= target else 'CHƯA ĐẠT')
        lines = [
            "# BẢNG CHỈ SỐ ĐÁNH GIÁ (MỤC 8.2)",
            "",
            "## 1. Hiệu quả phát hiện (trên lỗi chèn giả)",
            "",
            "| Chỉ số | Mục tiêu | Kết quả thực tế | Đánh giá |",
            "|---|---|---|---|",
        ]

        # Recall theo loại lỗi
        for et in ("floating", "size", "track"):
            s = self.by_type.get(et, MetricSummary())
            target = 0.90
            lines.append(
                f"| Recall — {et} | ≥ 90% | **{pct(s.recall)}** ({s.true_positives}/{s.total_injected}) | {status(s.recall,target)} |"
            )

        # Recall theo mức độ
        for sev, target in (("error", 0.90), ("warning", 0.80)):
            s = self.by_severity.get(sev, MetricSummary())
            lines.append(
                f"| Recall — {sev} | ≥ {target*100:.0f}% | **{pct(s.recall)}** ({s.true_positives}/{s.total_injected}) | {status(s.recall,target)} |"
            )

        # Precision mỗi loại
        for et in ("floating", "size", "track"):
            s = self.by_type.get(et, MetricSummary())
            target = 0.70
            lines.append(
                f"| Precision — {et} | ≥ 70% | **{pct(s.precision)}** (TP: {s.true_positives}, FP: {s.false_positives}) | {status(s.precision,target)} |"
            )

        lines.extend([
            "",
            "## 2. Báo động giả trên nhãn sạch",
            "",
            "| Chỉ số | Mục tiêu | Kết quả thực tế | Đánh giá |",
            "|---|---|---|---|",
            "",
            "## 3. Độ chính xác số đo",
            "",
            "| Chỉ số | Mục tiêu | Sai số trung vị | Phân vị 90 (P90) |",
            "|---|---|---|---|",
        ])

        rows=[]
        for severity,count,target in [('warning',self.clean_warning_count,2.0),('error',self.clean_error_count,.5)]:
            rate=count/self.clean_boxes_total*100 if self.clean_boxes_total and self.clean_evaluated else None
            value=f'{rate:.2f} ({count}/{self.clean_boxes_total})' if rate is not None else '—'
            verdict='CHƯA ĐO' if rate is None else ('ĐẠT' if rate<=target else 'CHƯA ĐẠT')
            rows.append(f'| {severity} / 100 box | ≤ {target:g} | {value} | {verdict} |')
        where=lines.index('## 3. Độ chính xác số đo')-1
        lines[where:where]=rows

        for et in ("floating", "size"):
            s = self.by_type.get(et, MetricSummary())
            measured=f'**{s.median_error*100:.2f} cm** | {s.p90_error*100:.2f} cm' if s.measurement_errors else '— | —'
            lines.append(f"| Sai số đo {et} (n={len(s.measurement_errors)}) | Trung vị < 3 cm | {measured} |")

        return "\n".join(lines)


def evaluate_findings(
    injected_faults: Sequence[InjectedFault],
    findings: Sequence[Finding],
    clean_boxes_total: int = 0,
    clean_findings: Sequence[Finding] | None = None,
) -> EvaluationReport:
    """So khớp kết quả quét findings với tập lỗi chèn giả."""
    report = EvaluationReport()

    # Nhóm findings theo (error_type, frame, track_id)
    findings_by_key: dict[tuple, list[Finding]] = {}
    for f in findings:
        if f.severity is Severity.INFO:
            continue
        key = (f.details.get('scene'), f.error_type.value, f.frame, f.track_id)
        findings_by_key.setdefault(key, []).append(f)

    matched_finding_ids = set()

    # Khởi tạo metrics
    for et in ("floating", "size", "track"):
        report.by_type[et] = MetricSummary()
    for sev in ("error", "warning"):
        report.by_severity[sev] = MetricSummary()

    # Đếm và so khớp từng lỗi chèn
    for fault in injected_faults:
        report.overall.total_injected += 1
        t_sum = report.by_type.setdefault(fault.error_type, MetricSummary())
        s_sum = report.by_severity.setdefault(fault.severity, MetricSummary())
        t_sum.total_injected += 1
        s_sum.total_injected += 1

        key = (fault.details.get('scene'), fault.error_type, fault.frame, fault.track_id)
        candidates = [c for c in findings_by_key.get(key, []) if not fault.rule or c.rule == fault.rule]

        # Tìm candidate khớp severity trước, nếu không lấy candidate bất kỳ cùng loại
        matched: Finding | None = None
        for c in candidates:
            if id(c) not in matched_finding_ids and c.severity.value == fault.severity:
                matched = c
                break
        if matched is None and candidates:
            for c in candidates:
                if id(c) not in matched_finding_ids:
                    matched = c
                    break

        if matched is not None:
            matched_finding_ids.add(id(matched))
            report.overall.true_positives += 1
            t_sum.true_positives += 1
            s_sum.true_positives += 1

            expected = fault.details.get('expected_value')
            if expected is None and fault.error_type in ('floating', 'track') and fault.delta > 0:
                expected = fault.delta
            if expected is not None and matched.value is not None:
                err = abs(abs(matched.value) - abs(float(expected)))
                report.overall.measurement_errors.append(err)
                t_sum.measurement_errors.append(err)
        else:
            report.overall.false_negatives += 1
            t_sum.false_negatives += 1
            s_sum.false_negatives += 1

    # Đếm False Positives (các finding không khớp lỗi chèn nào)
    for f in findings:
        if id(f) not in matched_finding_ids and f.severity != Severity.INFO:
            report.overall.false_positives += 1
            t_sum = report.by_type.setdefault(f.error_type.value, MetricSummary())
            t_sum.false_positives += 1

    # Báo động giả trên nhãn sạch
    report.clean_boxes_total = clean_boxes_total
    report.clean_evaluated = clean_findings is not None
    if clean_findings is not None:
        report.clean_warning_count = sum(f.severity is Severity.WARNING for f in clean_findings)
        report.clean_error_count = sum(f.severity is Severity.ERROR for f in clean_findings)
        report.clean_false_alarms = sum(1 for f in clean_findings if f.severity in (Severity.WARNING, Severity.ERROR))

    return report


def load_injected_faults(path: str | Path) -> list[InjectedFault]:
    """Đọc file JSON chứa log lỗi đã chèn."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    faults = []
    if isinstance(data,list):
        items=data
    elif isinstance(data,dict) and isinstance(data.get('injected_faults'),list):
        items=data['injected_faults']
    else:
        raise ValueError('Cần list hoặc schema injected_faults; log injected_errors dùng evaluator canonical, không tự đổi thành dữ liệu rỗng')
    for it in items:
        faults.append(
            InjectedFault(
                error_type=it["error_type"],
                frame=int(it["frame"]),
                track_id=int(it["track_id"]) if it.get("track_id") is not None else None,
                severity=it.get("severity", "error"),
                rule=it.get("rule", ""),
                delta=float(it.get("delta", 0.0)),
                details=it.get("details", {}),
            )
        )
    return faults
