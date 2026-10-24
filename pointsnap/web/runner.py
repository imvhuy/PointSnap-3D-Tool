"""Quản lý các tác vụ quét nền của PointSnap 3D (A11)."""

from __future__ import annotations

import datetime
import logging
import math
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from pointsnap.adapters.cvat.client import CvatClient
from pointsnap.adapters.cvat.reader import frame_url, load_job
from pointsnap.adapters.cvat.writer import flag_job_errors, save_snapshot
from pointsnap.cli.common import frames_for_job
from pointsnap.core.gate import gate_verdict
from pointsnap.core.model import Finding, Severity
from pointsnap.core.scanner import actionable, scan_coverage_gaps, scan_cuboids
from pointsnap.report.csv_rep import generate_csv_report
from pointsnap.report.html import generate_html_report
from pointsnap.learn import apply as apply_learned
from pointsnap.learn import load_model
from pointsnap.web.projects import ProjectError, ProjectManager
from pointsnap.web.findings import is_actionable, present_run
from pointsnap.web.storage import StorageError, read_json, write_json

logger = logging.getLogger(__name__)
RUN_ID_RE = re.compile(r"\d{8}-\d{6}(?:-\d+)?-job\d+")


class ScanBusyError(ValueError):
    """Giới hạn hàng đợi hoặc dự án đang được quét."""


def finding_to_dict(
    f: Finding,
    cvat_url: str = "",
    task_id: int | None = None,
    job_id: int | None = None,
) -> dict[str, Any]:
    link = ""
    if cvat_url and task_id is not None and job_id is not None:
        link = frame_url(
            cvat_url,
            task_id,
            job_id,
            f.frame,
            track_id=f.track_id,
            shape_id=f.source_id if f.track_id is None else None,
        )
    return {
        "error_type": f.error_type.value,
        "error_type_label": f.error_type.label_vi,
        "rule": f.rule,
        "severity": f.severity.value,
        "severity_label": f.severity.label_vi,
        "frame": f.frame,
        "label": f.label,
        "message": f.message,
        "track_id": f.track_id,
        "source_id": f.source_id,
        "value": f.value,
        "threshold": f.threshold,
        "confidence": f.details.get("confidence"),
        "cvat_link": link,
        "details": _scalar_details(f.details),
    }


def _scalar_details(details: Any) -> dict[str, Any]:
    """Giá trị scalar hữu hạn và các list hình học phục vụ preview; không serialize đối tượng tùy ý."""
    geometry_keys = {"frames", "centers", "centers_3d", "size_m", "yaw_rad", "reference_frames", "proposed_center"}
    # Box đề xuất của fit.offset / fit.yaw / cam.face: guide và ghost đọc lại từ findings.json.
    label_lists = {"observed_axes": bool, "cameras": str}
    label_dicts = {"size_off_track"}
    def numeric_list(value, depth=0):
        if depth > 2 or not isinstance(value, (list, tuple)) or len(value) > 10000:
            return None
        result = []
        for item in value:
            if isinstance(item, (list, tuple)):
                item = numeric_list(item, depth + 1)
                if item is None:
                    return None
            elif isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(float(item)):
                item = float(item) if not isinstance(item, int) else int(item)
            else:
                return None
            result.append(item)
        return result
    out: dict[str, Any] = {}
    for key, value in (details or {}).items():
        if isinstance(value, (bool, str)):
            out[key] = value
        elif isinstance(value, (int, float)) and math.isfinite(float(value)):
            out[key] = float(value) if not isinstance(value, int) else int(value)
        elif hasattr(value, "item") and getattr(value, "ndim", 1) == 0:  # số numpy
            scalar = value.item()
            if isinstance(scalar, (int, float)) and math.isfinite(float(scalar)):
                out[key] = scalar
        elif key in geometry_keys and (clean := numeric_list(value)) is not None:
            out[key] = clean
        elif (key in label_lists and isinstance(value, (list, tuple)) and len(value) <= 16
              and all(isinstance(v, label_lists[key]) for v in value)):
            out[key] = list(value)
        elif key in label_dicts and isinstance(value, dict):
            out[key] = _scalar_details(value)
    return out


class ScanRunner:
    def __init__(self, project_manager: ProjectManager, max_workers: int = 1, max_pending: int = 16) -> None:
        self.pm = project_manager
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._scans: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self.max_pending = max_pending
        self._poll_cache = {}

    def run_dir(self, slug: str, run_id: str) -> Path:
        self.pm.get_project(slug)
        if not RUN_ID_RE.fullmatch(run_id):
            raise ProjectError("run_id không hợp lệ")
        parent = (self.pm._project_dir(slug) / "runs").resolve()
        path = (parent / run_id).resolve()
        if not path.is_relative_to(parent):
            raise ProjectError("Lần quét nằm ngoài phạm vi dự án")
        return path

    def delete_project(self, slug: str) -> None:
        with self._lock:
            if any(r["project_slug"] == slug and r["status"] in ("queued", "running")
                   for r in self._scans.values()):
                raise ScanBusyError("Dự án đang có tác vụ quét; chờ hoàn tất trước khi xóa.")
            self.pm.delete_project(slug)
            self._scans = {key: value for key, value in self._scans.items() if value["project_slug"] != slug}

    def _state(self, run_id: str, **updates: Any) -> None:
        with self._lock:
            info = self._scans[run_id]
            info.update(updates)
            write_json(self.run_dir(info["project_slug"], run_id) / "run.json", info)

    def start_scan(self, slug: str, job_id: int, flag: bool = False) -> str:
        """Bắt đầu quét một job trong luồng nền. Trả về `run_id`."""
        with self._lock:
            if sum(r["status"] in ("queued", "running") for r in self._scans.values()) >= self.max_pending:
                raise ScanBusyError("Hàng đợi quét đã đầy; hãy thử lại sau.")
            return self._start_scan(slug, job_id, flag)

    def _start_scan(self, slug: str, job_id: int, flag: bool) -> str:
        source_project = self.pm.get_project(slug)
        if job_id <= 0:
            raise ProjectError("job_id phải là số nguyên dương")
        now = datetime.datetime.now()
        now_str = now.strftime("%Y%m%d-%H%M%S")
        # Suffix ngắn cho đường dẫn Windows; mkdir độc quyền bảo đảm không đè run cũ.
        while True:
            run_id = f"{now_str}-{uuid.uuid4().int % 10**12:012d}-job{job_id}"
            path = self.run_dir(slug, run_id)
            try:
                path.mkdir(exist_ok=False)
                break
            except FileExistsError:
                continue

        run_info: dict[str, Any] = {
            "run_id": run_id,
            "project_slug": slug,
            "job_id": job_id,
            "source_cvat_url": source_project["cvat_url"],
            "flag": flag,
            "status": "queued",
            "progress": 0,
            "message": "Đang xếp hàng đợi...",
            "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "finished_at": None,
            "error": None,
            "summary": None,
        }
        write_json(path / "run.json", run_info)
        self._scans[run_id] = run_info
        try:
            self._executor.submit(self._execute_scan, run_id, slug, job_id, flag)
        except RuntimeError:
            self._state(run_id, status="failed", error="Không khởi động được worker", progress=100)
            raise
        return run_id

    def _execute_scan(self, run_id: str, slug: str, job_id: int, flag: bool) -> None:
        info = self._scans[run_id]
        info["progress"] = 5
        info["message"] = "Đang nạp cấu hình và kết nối CVAT..."

        client = None
        token = None
        try:
            self._state(run_id, status="running")
            config = self.pm.get_effective_config(slug)
            source_url = info.get("source_cvat_url")
            if not source_url or config.cvat.url.rstrip("/") != source_url.rstrip("/"):
                raise ProjectError("Nguồn CVAT của job trong hàng đợi đã đổi hoặc bị thiếu; chọn lại job và quét mới.")
            token = config.cvat.token
            proj = self.pm.get_project(slug)

            client = CvatClient(config.cvat.url, config.cvat.token)
            info["progress"] = 20
            info["message"] = f"Đang tải dữ liệu job #{job_id} từ CVAT ({client.url})..."

            job = load_job(client, job_id)

            run_dir = self.run_dir(slug, run_id)

            # 1. Lưu snapshot
            info["progress"] = 35
            info["message"] = "Đang lưu bản chụp nhãn..."
            save_snapshot(job, run_dir / "snapshot.json")

            # 2. Tìm point cloud (Điểm 3 Mục 6: truyền trực tiếp export_dirs và dataroot, không qua os.environ)
            info["progress"] = 50
            info["message"] = "Đang kiểm tra dữ liệu point cloud..."
            custom_exports = proj.get("export_dirs") or None
            custom_nuscenes = proj.get("nuscenes_root") or None
            frames, note = frames_for_job(
                job,
                custom_export_dirs=custom_exports,
                dataroot=custom_nuscenes,
            )

            # 3. Quét kiểm tra chất lượng nhãn
            info["progress"] = 65
            info["message"] = f"Đang quét {len(job.cuboids)} box của job #{job_id}..."
            findings = scan_cuboids(job, config, frames)
            learned = load_model(self.pm._project_dir(slug))
            findings = apply_learned(findings, learned, config.learning.adjust_severity,
                                     config.learning.downgrade_below, config.learning.min_rule_reviews)

            visible = [f for f in findings if is_actionable(f)]

            # 4. Xuất báo cáo HTML / CSV
            info["progress"] = 80
            info["message"] = "Đang tạo báo cáo HTML và CSV..."
            coverage_gaps = scan_coverage_gaps(job, config, frames)
            passed, reasons = gate_verdict(findings, config.gate, coverage_gaps=coverage_gaps)
            generate_html_report(job, visible, run_dir / "report.html", coverage_gaps=coverage_gaps,
                                 gate_passed=passed, gate_reasons=reasons)
            generate_csv_report(job, visible, run_dir / "report.csv")

            # 6. Gắn cờ lỗi lên CVAT nếu được yêu cầu
            flag_summary: dict[str, int] | None = None
            if flag:
                info["progress"] = 90
                info["message"] = "Đang gắn cờ lỗi trực tiếp lên CVAT..."
                act = visible
                f_res = flag_job_errors(
                    client, job, act, flag_attribute=config.cvat.flag_attribute
                )
                flag_summary = {
                    "flagged": f_res.flagged,
                    "cleared": f_res.cleared,
                    "unmatched": f_res.unmatched,
                }

            # 7. Ghi findings.json
            findings_dicts = [
                finding_to_dict(
                    f,
                    cvat_url=config.cvat.url,
                    task_id=job.task_id,
                    job_id=job.job_id,
                )
                for f in findings
            ]
            write_json(run_dir / "findings.json", findings_dicts)

            # 8. Ghi summary.json
            counts = {
                s.value: sum(1 for f in (findings if s is Severity.INFO else visible) if f.severity is s) for s in Severity
            }
            summary = {
                "run_id": run_id,
                "project_slug": slug,
                "job_id": job_id,
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "num_boxes": sum(1 for c in job.cuboids if not c.outside),
                "num_errors": counts["error"],
                "num_warnings": counts["warning"],
                "num_info": counts["info"],
                "gate_passed": passed,
                "gate_reasons": reasons,
                "coverage_gaps": coverage_gaps,
                "flagged": flag,
                "flag_summary": flag_summary,
                "note": note,
                "config": config.to_dict(),
                "cvat_url": config.cvat.url,
                "task_id": job.task_id,
            }
            write_json(run_dir / "summary.json", summary)

            info["progress"] = 100
            info["message"] = "Hoàn tất."
            info["summary"] = summary
            info["finished_at"] = datetime.datetime.now(
                datetime.timezone.utc
            ).isoformat()
            self._state(run_id, status="done")

        except Exception as exc:
            error = str(exc).replace(token, "***") if token else str(exc)
            logger.error("Lỗi khi quét job %s: %s", job_id, error)
            info["status"] = "failed"
            info["progress"] = 100
            info["message"] = f"Lỗi: {error}"
            info["error"] = error
            info["finished_at"] = datetime.datetime.now(
                datetime.timezone.utc
            ).isoformat()
            try:
                self._state(run_id)
            except (OSError, ValueError):
                logger.error("Không lưu được trạng thái thất bại của run %s", run_id)
        finally:
            if client is not None:
                client.session.close()

    def get_run(
        self, slug: str, run_id: str, include_findings: bool = False
    ) -> dict[str, Any]:
        """Lấy trạng thái chi tiết của một lần quét."""
        run_dir = self.run_dir(slug, run_id)
        # 1. Đang chạy trong memory
        if run_id in self._scans:
            run_data = dict(self._scans[run_id])
            if run_data.get("project_slug") != slug:
                raise ProjectError(f"Không tìm thấy lần quét '{run_id}' trong dự án '{slug}'")
            if run_data.get("status") == "done":
                self._check_outputs(run_dir)
                run_data["summary"] = read_json(run_dir / "summary.json")
            if include_findings and run_data.get("status") == "done":
                run_dir = self.pm._project_dir(slug) / "runs" / run_id
                f_path = run_dir / "findings.json"
                if f_path.is_file():
                    raw_findings = read_json(f_path, list)
                    run_data["findings"] = raw_findings
            return present_run(run_data)

        # 2. Đọc từ ổ đĩa
        state_file = run_dir / "run.json"
        if state_file.is_file():
            res = read_json(state_file)
            if res.get("project_slug") != slug or res.get("run_id") != run_id:
                raise StorageError("run.json không thuộc dự án/lần quét đang yêu cầu")
            if res.get("status") in ("queued", "running"):
                res.update(status="failed", progress=100, error="Quét bị gián đoạn do khởi động lại server.",
                           message="Quét bị gián đoạn; hãy quét lại.",
                           finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
                write_json(state_file, res)
            if res.get("status") == "done":
                self._check_outputs(run_dir)
                res["summary"] = read_json(run_dir / "summary.json")
                if include_findings:
                    raw_findings = read_json(run_dir / "findings.json", list)
                    res["findings"] = raw_findings
            return present_run(res)
        sum_file = run_dir / "summary.json"
        if not sum_file.is_file():
            raise ProjectError(f"Không tìm thấy lần quét '{run_id}'")

        summary = read_json(sum_file)
        res: dict[str, Any] = {
            "run_id": run_id,
            "project_slug": slug,
            "job_id": summary.get("job_id"),
            "status": "done",
            "progress": 100,
            "message": "Hoàn tất.",
            "started_at": summary.get("timestamp"),
            "finished_at": summary.get("timestamp"),
            "error": None,
            "summary": summary,
        }
        if include_findings:
            f_path = run_dir / "findings.json"
            res["findings"] = read_json(f_path, list)
        return present_run(res)

    def poll_state(self, slug: str, job_id: int) -> tuple[str | None, dict | None, str]:
        with self._lock:
            scans = [dict(r) for r in self._scans.values()
                     if r.get("project_slug") == slug and r.get("job_id") == job_id]
            active = next((r for r in scans if r.get("status") in ("queued", "running")), None)
            done = [r for r in scans if r.get("status") == "done"]
            runs_dir = self.pm._project_dir(slug) / "runs"
            stamp = runs_dir.stat().st_mtime_ns if runs_dir.is_dir() else None
            signature = (stamp, tuple((r["run_id"], r.get("finished_at")) for r in done))
            key = (slug, job_id)
            cached = self._poll_cache.get(key)
            if cached is None or cached[0] != signature:
                runs = [r for r in self.list_runs(slug)
                        if r.get("job_id") == job_id and r.get("status") == "done"]
                latest = runs[0].get("run_id") if runs else None
                started_at = (runs[0].get("started_at") or "") if runs else ""
                self._poll_cache[key] = (signature, latest, started_at)
            return self._poll_cache[key][1], active, self._poll_cache[key][2]

    @staticmethod
    def _check_outputs(run_dir: Path) -> None:
        for name in ("summary.json", "findings.json", "snapshot.json", "report.html", "report.csv"):
            if not (run_dir / name).is_file():
                raise StorageError(f"Lần quét thiếu {name}; hãy quét lại.")
        read_json(run_dir / "summary.json")
        read_json(run_dir / "findings.json", list)

    def list_runs(self, slug: str) -> list[dict[str, Any]]:
        """Lấy danh sách tóm tắt các lần quét của dự án (sắp xếp mới nhất trước)."""
        self.pm.get_project(slug)
        runs_dir = self.pm._project_dir(slug) / "runs"
        results: list[dict[str, Any]] = []
        seen_runs = set()

        # Đang active trong bộ nhớ
        with self._lock:
            active = list(self._scans.items())
        for r_id, r_info in active:
            if r_info.get("project_slug") == slug:
                try:
                    item = self.get_run(slug, r_id, include_findings=True)
                    item.pop("findings", None); item.pop("diagnostics", None)
                    results.append(item)
                except (ProjectError, StorageError) as exc:
                    results.append({"run_id": r_id, "project_slug": slug, "status": "failed",
                                    "error": str(exc), "progress": 100})
                seen_runs.add(r_id)

        # Đọc từ file
        if runs_dir.is_dir():
            for d in runs_dir.iterdir():
                if d.is_dir() and d.name not in seen_runs:
                    try:
                        item = self.get_run(slug, d.name, include_findings=True)
                        item.pop("findings", None); item.pop("diagnostics", None)
                        results.append(item)
                    except (ProjectError, StorageError) as exc:
                        results.append({"run_id": d.name, "project_slug": slug, "status": "failed",
                                        "error": str(exc), "progress": 100})

        return sorted(results, key=lambda r: r.get("started_at") or "", reverse=True)
