"""Cổng kiểm tra chất lượng nhãn: đánh giá findings theo cấu hình gate."""

from __future__ import annotations

from typing import Iterable

from pointsnap.core.config import GateConfig
from pointsnap.core.model import Finding, Severity


def gate_verdict(
    findings: Iterable[Finding], gate_config: GateConfig, *, coverage_gaps: Iterable[str] = (),
) -> tuple[bool, list[str]]:
    """Kiểm tra danh sách finding theo tiêu chí gate.

    Trả về `(passed, reasons)`.
    - `passed`: `True` nếu không thiếu dữ liệu kiểm tra và số lỗi/cảnh báo không vượt ngưỡng.
    - `reasons`: danh sách lý do nếu không đạt (rỗng nếu đạt).
    """
    findings = list(findings)
    errors = [f for f in findings if f.severity is Severity.ERROR]
    warnings = [f for f in findings if f.severity is Severity.WARNING]

    num_errors = len(errors)
    num_warnings = len(warnings)

    max_err = gate_config.max_errors
    max_warn = gate_config.max_warnings

    reasons = list(coverage_gaps)
    if any(f.rule == "floating.no_evidence" for f in findings):
        reasons.append("Kiểm tra một phần: có box thiếu bằng chứng mặt đất (floating.no_evidence)")
    if any(f.rule == "camera.no_evidence" for f in findings):
        reasons.append("Kiểm tra một phần: thiếu bằng chứng camera (camera.no_evidence)")
    if num_errors > max_err:
        reasons.append(f"Số lỗi ({num_errors}) vượt quá ngưỡng cho phép ({max_err})")
    if num_warnings > max_warn:
        reasons.append(f"Số cảnh báo ({num_warnings}) vượt quá ngưỡng cho phép ({max_warn})")

    return (len(reasons) == 0, reasons)
