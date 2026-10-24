"""API báo cáo PointSnap, dùng PAT và quyền truy cập job của người gọi trên CVAT."""

from __future__ import annotations

import dataclasses
import json
import os
import re
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit

import requests
import numpy as np

from pointsnap.adapters.cvat.client import CvatClient, CvatError
from pointsnap.adapters.cvat.reader import load_job
from pointsnap.cli.common import frames_for_job
from pointsnap.core.config import load_config
from pointsnap.core.gate import gate_verdict
from pointsnap.core.model import Severity
from pointsnap.core.scanner import scan_cuboids, scan_coverage_gaps
from pointsnap.report.csv_rep import generate_csv_report
from pointsnap.report.html import generate_html_report


class ReportCvatError(CvatError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class ReportCvatClient(CvatClient):
    """Giữ giới hạn origin và mã HTTP trong adapter của API bổ sung."""

    def _request(self, method, path, *, expected=(200,), **kwargs):
        url = urljoin(f"{self.url}/api/", path)
        origin, target = urlsplit(self.url), urlsplit(url)
        def identity(parts):
            return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80)
        if identity(origin) != identity(target) or target.username or target.password:
            raise ReportCvatError("CVAT trả đường dẫn ngoài origin cấu hình")
        try:
            response = self.session.request(method, url, timeout=self.timeout,
                                            allow_redirects=False, **kwargs)
        except requests.RequestException as exc:
            raise ReportCvatError("Không kết nối được CVAT") from exc
        if response.status_code not in expected:
            raise ReportCvatError("CVAT trả lỗi", response.status_code)
        try:
            return response.json() if response.content else {}
        except ValueError as exc:
            raise ReportCvatError("CVAT trả JSON không hợp lệ") from exc


def create_report(client: CvatClient, job_id: int):
    # Mỗi lần gọi đều đọc CVAT bằng token người gọi, không dùng report cache/token dịch vụ.
    job = load_job(client, job_id)
    task = client.get_task(job.task_id)
    if task.get("dimension") != "3d":
        raise ReportCvatError("Job không phải 3D", status_code=422)
    config = load_config(env={"CVAT_URL": client.url})
    frames, note = frames_for_job(job)
    findings = scan_cuboids(job, config, frames)
    job.url = os.environ.get("CVAT_WEB_URL") or client.url
    gaps = scan_coverage_gaps(job, config, frames)
    pose_available = frames is not None and all(frames.frame_data(c.frame, with_points=False).sensor_to_world is not None
                                              for c in job.cuboids if c.visible and c.track_id is not None)
    metadata = {"point_cloud_available": frames is not None, "pose_available": pose_available,
                "point_cloud_note": note, "coverage_gaps": gaps}
    visible_frames = {c.frame for c in job.cuboids if c.visible and c.keyframe}
    metadata["camera_available"] = bool(
        frames is not None and hasattr(frames, "camera_views") and config.camera.active()
        and visible_frames and all(frames.camera_views(frame) for frame in visible_frames)
        and not any(f.rule == "camera.no_evidence" for f in findings)
    )
    from pointsnap.critic import available as critic_available
    metadata["critic_available"] = bool(frames is not None and config.critic.model and critic_available())
    return job, findings, config, metadata


def _json_numeric(value):
    """Report details can contain NumPy measurements; keep strict JSON and reject arbitrary objects."""
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(f'Unsupported report value: {type(value).__name__}')


def report_bytes(job, findings, config, report_format: str, metadata: dict | None = None) -> bytes:
    if report_format not in ("json", "html", "csv"):
        raise ValueError("format phải là json, html hoặc csv")
    findings = list(findings)
    metadata = metadata or {}
    gaps = metadata.get("coverage_gaps")
    if gaps is None:
        gaps = scan_coverage_gaps(job, config, None)
    passed, reasons = gate_verdict(findings, config.gate, coverage_gaps=gaps)
    enabled = [field.name.replace("_", ".", 1) if field.name != "floating" else "floating"
               for field in dataclasses.fields(config.rules) if getattr(config.rules, field.name)]
    cloud_rules = {"floating", "heading.points", "fit.empty", "fit.outside", "fit.loose", "lidar.missing", "critic.box",
                   "fit.offset", "fit.yaw"}
    pose_rules = {"heading.flip", "heading.motion", "heading.static", "lidar.missing", "attr.rider_state", "cam.face"}
    checks = [name for name in enabled if (name not in cloud_rules or metadata.get("point_cloud_available"))
              and (name not in pose_rules or metadata.get("pose_available"))
              and (not name.startswith("cam.") or metadata.get("camera_available"))
              and (name != "critic.box" or (config.critic.model and metadata.get("critic_available")))]
    if report_format == "json":
        errors = sum(f.severity == Severity.ERROR for f in findings)
        warnings = sum(f.severity == Severity.WARNING for f in findings)
        payload = {
            "job_id": job.job_id,
            "task_id": job.task_id,
            "boxes": sum(not b.outside for b in job.cuboids),
            "errors": errors,
            "warnings": warnings,
            "info": sum(f.severity == Severity.INFO for f in findings),
            **metadata,
            "passed": passed,
            "gate_reasons": reasons,
            "coverage_gaps": gaps,
            "enabled_checks": enabled,
            "checks": checks,
            "checks_scope": "Eligible configured rules; not per-box completeness or model quality acceptance",
            "findings": [
                {**dataclasses.asdict(f), "severity": f.severity.value, "error_type": f.error_type.value,
                 "cvat_url": job.frame_url(f.frame, track_id=f.track_id,
                                           shape_id=f.source_id if f.track_id is None else None)}
                for f in findings
            ],
        }
        return json.dumps(payload, ensure_ascii=False, allow_nan=False, default=_json_numeric).encode("utf-8")
    with tempfile.TemporaryDirectory(prefix="pointsnap-report-") as directory:
        path = Path(directory) / f"report.{report_format}"
        generator = generate_html_report if report_format == "html" else generate_csv_report
        if report_format == "html":
            generator(job, findings, path, coverage_gaps=gaps, gate_passed=passed, gate_reasons=reasons)
        else:
            generator(job, findings, path)
        return path.read_bytes()


class ReportServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, backend_url: str):
        super().__init__(address, ReportHandler)
        self.backend_url = backend_url
        self.report_slots = threading.BoundedSemaphore(2)


class ReportHandler(BaseHTTPRequestHandler):
    def log_request(self, code='-', size='-') -> None:
        # Không ghi query/request target: caller có thể gửi credential nhầm trong URL.
        self.log_message('%s %s %s', self.command, code, size)

    def log_error(self, format, *args) -> None:
        self.log_message('HTTP protocol error')

    def send_body(self, status: int, body: bytes, content_type: str, filename: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("Vary", "Authorization")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 401:
            self.send_header("WWW-Authenticate", 'Bearer realm="PointSnap"')
        if status == 405:
            self.send_header("Allow", "GET")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, payload: dict) -> None:
        self.send_body(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/pointsnap/health":
            self.send_json(200, {"status": "ok"})
            return
        match = re.fullmatch(r"/pointsnap/jobs/([1-9][0-9]{0,9})/report", parsed.path)
        if not match:
            self.send_json(404, {"detail": "Không tìm thấy endpoint PointSnap"})
            return
        formats = parse_qs(parsed.query, keep_blank_values=True).get("format", ["json"])
        if (set(parse_qs(parsed.query, keep_blank_values=True)) - {'format'}
                or len(formats) != 1 or formats[0] not in ("json", "html", "csv")):
            self.send_json(400, {"detail": "format phải là json, html hoặc csv"})
            return
        authentication = re.fullmatch(r"Bearer ([^\s]{1,4096})", self.headers.get("Authorization", ""), re.I)
        if not authentication:
            self.send_json(401, {"detail": "Cần Authorization: Bearer <CVAT_PAT>"})
            return
        if not self.server.report_slots.acquire(blocking=False):
            self.send_json(429, {"detail": "PointSnap đang bận, hãy thử lại sau"})
            return
        client = None
        try:
            client = ReportCvatClient(self.server.backend_url, authentication[1], timeout=30)
            client.session.trust_env = False
            job, findings, config, metadata = create_report(client, int(match[1]))
            report_format = formats[0]
            body = report_bytes(job, findings, config, report_format, metadata)
            mime_types = {"json": "application/json", "html": "text/html", "csv": "text/csv"}
            filename = None if report_format == "json" else f"pointsnap-job-{job.job_id}.{report_format}"
            self.send_body(200, body, f"{mime_types[report_format]}; charset=utf-8", filename)
        except CvatError as exc:
            code = getattr(exc, "status_code", None)
            status = code if code in (401, 403, 404, 422) else 502
            messages = {
                401: "Token CVAT không hợp lệ hoặc đã hết hạn",
                403: "Token không có quyền truy cập job này",
                404: "Job không tồn tại hoặc token không có quyền truy cập",
                422: "PointSnap chỉ hỗ trợ job 3D cuboid",
                502: "Không đọc được dữ liệu từ CVAT",
            }
            self.send_json(status, {"detail": messages[status]})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.log_message("report failed: %s", type(exc).__name__)
            self.send_json(500, {"detail": "Không tạo được báo cáo PointSnap"})
        finally:
            if client is not None:
                client.session.close()
            self.server.report_slots.release()

    def do_POST(self) -> None:
        self.send_json(405, {"detail": "Dùng GET để lấy báo cáo"})


if __name__ == "__main__":
    host = os.environ.get('POINTSNAP_REPORT_HOST', '127.0.0.1')
    server = ReportServer((host, 8081), os.environ.get("CVAT_URL", "http://cvat-server:8080"))
    print(f"PointSnap report API listening on {host}:8081", flush=True)
    server.serve_forever()
