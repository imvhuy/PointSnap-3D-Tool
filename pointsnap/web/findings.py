"""Presentation policy. Stored indices never depend on filters or pagination."""
from __future__ import annotations

GROUPS = {"floating": "Lơ lửng / lún", "size": "Kích thước", "heading": "Sai hướng box",
          "fit": "Box lệch khỏi vật", "attribute": "Thuộc tính / spec"}


def is_actionable(finding):
    if isinstance(finding, dict):
        severity, kind, rule = finding.get("severity"), finding.get("error_type"), finding.get("rule", "")
    else:
        severity, kind, rule = finding.severity.value, finding.error_type.value, finding.rule
    return severity in ("error", "warning") and kind in GROUPS


def indexed(findings):
    return [{**f, "finding_index": i, "actionable": is_actionable(f)} for i, f in enumerate(findings)]


def present_run(run):
    if "findings" not in run:
        return run
    items = indexed(run["findings"])
    run["findings"] = items
    run["diagnostics"] = [f for f in items if not f["actionable"]]
    summary = dict(run.get("summary") or {})
    summary.update(num_errors=sum(f["actionable"] and f["severity"] == "error" for f in items),
                   num_warnings=sum(f["actionable"] and f["severity"] == "warning" for f in items),
                   num_diagnostics=len(run["diagnostics"]))
    run["summary"] = summary
    return run
