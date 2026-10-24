"""Quản lý lưu trữ dự án và guideline của PointSnap 3D (A11).

Thư mục lưu trữ: `POINTSNAP_HOME` (mặc định: `~/.pointsnap/projects/<slug>/`).
"""

from __future__ import annotations

import datetime
import json
import os
import re
import shutil
import threading
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit
from typing import Any, Mapping

import yaml
from pointsnap.adapters.cvat.client import CvatError, validate_cvat_url
from pointsnap.web.storage import read_json, write_json, write_text

from pointsnap.core.config import (
    Config,
    ConfigError,
    _deep_merge,
    _read_yaml,
    default_config_text,
    load_config,
    parse_config,
)

SLUG_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")


class ProjectError(ValueError):
    """Lỗi quản lý dự án: slug không hợp lệ, dự án đã tồn tại, hoặc không tìm thấy."""


def validate_slug(slug: str) -> str:
    """Kiểm tra tính an toàn của slug dự án (chống path traversal)."""
    if not slug or not SLUG_PATTERN.fullmatch(slug) or ".." in slug:
        raise ProjectError(
            f"Slug '{slug}' không hợp lệ. Chỉ chấp nhận chữ cái, số, gạch ngang và gạch dưới."
        )
    return slug


def project_cvat_url(url: str) -> str:
    try:
        return validate_cvat_url(url)
    except CvatError as exc:
        raise ProjectError(str(exc)) from exc


def cvat_origin(url: str) -> tuple:
    parts = urlsplit(url)
    return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80), parts.path.rstrip('/')


def clean_guideline_dict(data: dict[str, Any]) -> dict[str, Any]:
    """Xóa bỏ khóa `token` khỏi mục `cvat` của guideline nếu có (Điểm 1 Mục 6)."""
    cleaned = dict(data)
    if "cvat" in cleaned and isinstance(cleaned["cvat"], dict):
        cvat_dict = dict(cleaned["cvat"])
        cvat_dict.pop("token", None)
        cleaned["cvat"] = cvat_dict
    return cleaned


def merge_guideline_with_default(incoming: Mapping[str, Any]) -> dict[str, Any]:
    """Trộn guideline với cấu hình mặc định để điền các khóa schema còn thiếu.

    Các dynamic mapping (nơi key do người dùng định nghĩa, ví dụ class trong manual_ranges)
    sẽ được lấy nguyên vẹn từ incoming nếu người dùng đã cung cấp,
    tránh việc deep-merge hồi sinh các class/khóa đã bị xóa (Lỗi bắt buộc 2 — Mục 7).
    """
    base_data = clean_guideline_dict(_read_yaml(default_config_text(), "config.yaml mặc định"))
    merged = _deep_merge(base_data, incoming)
    if "size" in incoming and isinstance(incoming["size"], Mapping):
        if "manual_ranges" in incoming["size"] and "size" in merged and isinstance(merged["size"], dict):
            if not isinstance(incoming["size"]["manual_ranges"], Mapping):
                raise ConfigError("size.manual_ranges phải là mapping")
            merged["size"]["manual_ranges"] = dict(incoming["size"]["manual_ranges"])
    return merged


def slugify(text: str) -> str:
    """Tạo slug an toàn từ tên dự án."""
    text = unicodedata.normalize("NFKD", text.lower().strip().replace("đ", "d"))
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_-]+", "-", text)
    return text.strip("-") or "project"


class ProjectManager:
    def __init__(self, home_dir: Path | str | None = None) -> None:
        self._lock = threading.RLock()
        if home_dir is not None:
            self._home = Path(home_dir)
        elif os.environ.get("POINTSNAP_HOME"):
            self._home = Path(os.environ["POINTSNAP_HOME"])
        else:
            self._home = Path.home() / ".pointsnap"

    @property
    def home_dir(self) -> Path:
        return self._home

    @property
    def projects_dir(self) -> Path:
        p = self._home / "projects"
        p.mkdir(parents=True, exist_ok=True)
        return p

    def _project_dir(self, slug: str) -> Path:
        validate_slug(slug)
        proj_dir = (self.projects_dir / slug).resolve()
        # Chống path traversal
        try:
            proj_dir.relative_to(self.projects_dir.resolve())
        except ValueError as exc:
            raise ProjectError(f"Đường dẫn dự án '{slug}' không hợp lệ") from exc
        return proj_dir

    def list_projects(self) -> list[dict[str, Any]]:
        """Danh sách mọi dự án hiện có (không chứa token)."""
        projects: list[dict[str, Any]] = []
        if not self.projects_dir.exists():
            return projects

        for entry in sorted(self.projects_dir.iterdir()):
            if entry.is_dir() and (entry / "project.json").is_file():
                try:
                    projects.append(self.get_project(entry.name))
                except Exception:
                    continue
        return sorted(projects, key=lambda p: p.get("created_at", ""), reverse=True)

    def create_project(
        self,
        name: str,
        slug: str | None = None,
        description: str = "",
        cvat_url: str = "http://localhost:8080",
        cvat_token: str | None = None,
        nuscenes_root: str = "",
        export_dirs: list[str] | None = None,
        preset_slug: str | None = None,
    ) -> dict[str, Any]:
        """Tạo một dự án mới."""
        name = name.strip()
        if not name:
            raise ProjectError("Tên dự án không được để trống")
        cvat_url = project_cvat_url(cvat_url)

        actual_slug = validate_slug(slug or slugify(name))
        proj_dir = self.projects_dir / actual_slug
        if proj_dir.exists():
            raise ProjectError(f"Dự án với slug '{actual_slug}' đã tồn tại")

        # Kiểm preset trước khi tạo thư mục để lỗi input không để lại dự án dở.
        if preset_slug:
            clean_dict, _ = self.get_guideline(preset_slug)
            parse_config(merge_guideline_with_default(clean_dict), env={})
        else:
            clean_dict = clean_guideline_dict(load_config(env={}).to_dict(redact=False))

        try:
            proj_dir.mkdir(parents=True, exist_ok=False)
        except FileExistsError as exc:
            raise ProjectError(f"Dự án với slug '{actual_slug}' đã tồn tại") from exc
        (proj_dir / "runs").mkdir(parents=True, exist_ok=True)

        # 1. Ghi project.json
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        proj_data = {
            "name": name,
            "slug": actual_slug,
            "description": description.strip(),
            "cvat_url": cvat_url.strip(),
            "nuscenes_root": nuscenes_root.strip(),
            "export_dirs": export_dirs or [],
            "created_at": now,
        }
        write_json(proj_dir / "project.json", proj_data)

        # 2. Ghi secret.json (chỉ chứa token, không bao giờ lộ ra ngoài API)
        secret_data: dict[str, str] = {}
        if cvat_token and cvat_token.strip():
            secret_data["cvat_token"] = cvat_token.strip()
        write_json(proj_dir / "secret.json", secret_data)

        # 3. Tạo guideline.yaml (Điểm 1 Mục 6: loại bỏ khóa cvat.token)
        clean_yaml = yaml.safe_dump(clean_dict, allow_unicode=True, sort_keys=False)
        write_text(proj_dir / "guideline.yaml", clean_yaml)

        return self.get_project(actual_slug)

    def get_project(self, slug: str) -> dict[str, Any]:
        """Lấy thông tin dự án. API không trả token, chỉ trả has_token: bool."""
        proj_dir = self._project_dir(slug)
        meta_file = proj_dir / "project.json"
        if not meta_file.is_file():
            raise ProjectError(f"Không tìm thấy dự án '{slug}'")

        data = read_json(meta_file)

        secret_file = proj_dir / "secret.json"
        has_token = False
        if secret_file.is_file():
            try:
                secret_data = json.loads(secret_file.read_text(encoding="utf-8"))
                has_token = bool(secret_data.get("cvat_token"))
            except Exception:
                has_token = False
        data["has_token"] = has_token

        # Đếm số lần quét
        runs_dir = proj_dir / "runs"
        data["runs_count"] = (
            len([d for d in runs_dir.iterdir() if d.is_dir()])
            if runs_dir.is_dir()
            else 0
        )
        return data

    def update_project(self, slug: str, updates: dict[str, Any]) -> dict[str, Any]:
        """Cập nhật thông tin dự án hoặc token."""
        proj_dir = self._project_dir(slug)
        meta_file = proj_dir / "project.json"
        if not meta_file.is_file():
            raise ProjectError(f"Không tìm thấy dự án '{slug}'")

        with self._lock:
            return self._update_project(slug, updates)

    def _update_project(self, slug: str, updates: dict[str, Any]) -> dict[str, Any]:
        proj_dir = self._project_dir(slug)
        meta_file = proj_dir / "project.json"
        data = read_json(meta_file)
        if "name" in updates:
            updates = {**updates, "name": str(updates["name"]).strip()}
            if not updates["name"]:
                raise ProjectError("Tên dự án không được để trống")

        if 'cvat_url' in updates:
            updates = {**updates, 'cvat_url': project_cvat_url(updates['cvat_url'])}
            if cvat_origin(data['cvat_url']) != cvat_origin(updates['cvat_url']):
                # Xóa trước khi đổi server: lỗi ghi giữa hai file cũng không mang PAT cũ sang server mới.
                write_json(proj_dir / 'secret.json', {})

        for key in ("name", "description", "cvat_url", "nuscenes_root", "export_dirs"):
            if key in updates:
                data[key] = updates[key]

        write_json(meta_file, data)

        # Cập nhật token nếu được gửi (nếu gửi null hoặc rỗng thì giữ nguyên token cũ)
        if "cvat_token" in updates and updates["cvat_token"] is not None:
            new_tok = str(updates["cvat_token"]).strip()
            secret_file = proj_dir / "secret.json"
            secret_data = (
                read_json(secret_file)
                if secret_file.is_file()
                else {}
            )
            if new_tok:
                secret_data["cvat_token"] = new_tok
            else:
                secret_data.pop("cvat_token", None)
            write_json(secret_file, secret_data)

        return self.get_project(slug)

    def delete_project(self, slug: str) -> None:
        """Xóa toàn bộ dự án và lịch sử quét (Điểm 5 Mục 6)."""
        proj_dir = self._project_dir(slug)
        # Kiểm tra an toàn tuyệt đối
        resolved_proj = proj_dir.resolve()
        resolved_projects = self.projects_dir.resolve()
        if (
            resolved_proj == resolved_projects
            or not resolved_proj.is_relative_to(resolved_projects)
        ):
            raise ProjectError("Không thể xóa thư mục ngoài phạm vi dự án")

        if resolved_proj.exists():
            shutil.rmtree(resolved_proj)

    def get_token(self, slug: str) -> str | None:
        """Lấy token nội bộ của dự án để gọi CVAT (chỉ dùng nội bộ trong runner)."""
        proj_dir = self._project_dir(slug)
        secret_file = proj_dir / "secret.json"
        if secret_file.is_file():
            try:
                secret_data = json.loads(secret_file.read_text(encoding="utf-8"))
                return secret_data.get("cvat_token") or None
            except Exception:
                return None
        return None

    def get_guideline(self, slug: str) -> tuple[dict[str, Any], str]:
        """Đọc guideline của dự án: trả về (dict_data, raw_yaml)."""
        proj_dir = self._project_dir(slug)
        g_file = proj_dir / "guideline.yaml"
        if not g_file.is_file():
            raise ProjectError(f"Dự án '{slug}' thiếu guideline.yaml")
        data = _read_yaml(g_file.read_text(encoding="utf-8"), "guideline.yaml")
        clean = clean_guideline_dict(data)
        return clean, yaml.safe_dump(clean, allow_unicode=True, sort_keys=False)

    def save_guideline(
        self, slug: str, content: dict[str, Any] | str
    ) -> dict[str, Any]:
        """Lưu guideline mới. Bỏ token, validate bằng parse_config trước khi ghi (Điểm 1 Mục 6).

        Ghi thay thế hoàn toàn (không trộn với file cũ) để xóa class / khóa thực sự có hiệu lực
        (Lỗi bắt buộc 2 — mục 7). Chỉ trộn với cấu hình mặc định để kiểm hợp lệ / điền khóa còn
        thiếu, không kết hợp với guideline.yaml đang có.
        """
        proj_dir = self._project_dir(slug)
        self.get_project(slug)
        g_file = proj_dir / "guideline.yaml"

        if isinstance(content, str):
            try:
                raw_data = yaml.safe_load(content)
            except yaml.YAMLError as exc:
                mark = getattr(exc, 'problem_mark', None)
                location = f' (dòng {mark.line+1}, cột {mark.column+1})' if mark else ''
                raise ConfigError(f"Cú pháp YAML không hợp lệ{location}") from exc
            if not isinstance(raw_data, Mapping):
                raise ConfigError("Nội dung guideline phải là một mapping YAML")
            data = dict(raw_data)
        else:
            data = dict(content)

        clean_incoming = clean_guideline_dict(data)

        # Trộn với MẶC ĐỊNH (không phải file cũ) để điền khóa còn thiếu, rồi validate
        merged_clean = merge_guideline_with_default(clean_incoming)

        # Kiểm tra tính hợp lệ bằng parse_config (ném ConfigError nếu sai)
        parse_config(merged_clean, env={})

        # Lưu file — ghi đè hoàn toàn (ghi thay thế, không giữ khóa cũ)
        clean_yaml = yaml.safe_dump(merged_clean, allow_unicode=True, sort_keys=False)
        write_text(g_file, clean_yaml)
        return merged_clean

    def reset_guideline(self, slug: str) -> dict[str, Any]:
        """Khôi phục guideline về cấu hình mặc định."""
        default_cfg = load_config(env={})
        clean_data = clean_guideline_dict(default_cfg.to_dict(redact=False))
        return self.save_guideline(slug, clean_data)

    def get_effective_config(self, slug: str) -> Config:
        """Tải cấu hình hiệu lực của dự án (Điểm 1 & 2 Mục 6).

        - Cấu hình hiệu lực trộn guideline của dự án đè lên cấu hình mặc định.
        - cvat.url từ project.json luôn ghi đè cấu hình trong guideline.yaml.
        - cvat.token lấy từ secret.json (không nằm trong file guideline).
        """
        with self._lock:
            return self._effective_config(slug)

    def _effective_config(self, slug: str) -> Config:
        proj = self.get_project(slug)
        clean_data, _ = self.get_guideline(slug)

        merged_data = merge_guideline_with_default(clean_data)

        # Điểm 2: Ghi đè cvat.url của dự án lên cấu hình hiệu lực
        cvat_dict = dict(merged_data.get("cvat", {}))
        cvat_dict["url"] = proj["cvat_url"]
        merged_data["cvat"] = cvat_dict

        token = self.get_token(slug)
        env = {"CVAT_TOKEN": token} if token else {}
        return parse_config(merged_data, env)
