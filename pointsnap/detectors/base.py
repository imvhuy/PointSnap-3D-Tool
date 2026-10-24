"""Lớp cơ sở cho các bộ phát hiện lỗi nhãn 3D (BaseDetector).

Chuẩn hóa kiến trúc detector theo nguyên lý DRY:
- Cung cấp interface chung `detect(ctx: DetectionContext) -> list[Finding]`
- Tự động kiểm tra công tắc luật qua `is_enabled(config)`
- Hỗ trợ gọi dưới dạng hàm `detector(job, config, frames)` để tương thích 100% với scanner và test suites cũ.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, Mapping, Sequence

from pointsnap.core.context import DetectionContext
from pointsnap.core.model import Cuboid, ErrorType, Finding, FrameSource, Severity
from pointsnap.core.rules import get_rule, rule_switch_key

if TYPE_CHECKING:
    from pointsnap.adapters.cvat.reader import JobData
    from pointsnap.core.config import Config


class BaseDetector(ABC):
    """Lớp cơ sở trừu tượng cho mọi bộ phát hiện lỗi nhãn 3D."""

    rule_id: str = ""
    switch_key: str = ""
    name: str = ""

    def __init__(self, rule_id: str | None = None, switch_key: str | None = None) -> None:
        if rule_id is not None:
            self.rule_id = rule_id
        if switch_key is not None:
            self.switch_key = switch_key
        elif self.rule_id and not self.switch_key:
            self.switch_key = rule_switch_key(self.rule_id)
        if not self.name:
            self.name = self.__class__.__name__

    def is_enabled(self, config: Config) -> bool:
        """Kiểm tra xem bộ phát hiện này có được bật trong config.rules không."""
        if not self.switch_key:
            return True
        return bool(getattr(config.rules, self.switch_key, True))

    @abstractmethod
    def detect(self, ctx: DetectionContext) -> list[Finding]:
        """Thực thi phát hiện lỗi dựa trên DetectionContext."""
        ...

    def __call__(
        self,
        job_or_ctx: JobData | Sequence[Cuboid] | DetectionContext | Any,
        config: Config | None = None,
        frames: FrameSource | None = None,
    ) -> list[Finding]:
        """Tương thích ngược hoàn toàn với chữ ký hàm DetectorFn cũ: detector(job, config, frames)."""
        if isinstance(job_or_ctx, DetectionContext):
            ctx = job_or_ctx
        else:
            if config is None:
                raise ValueError("Cần cung cấp config khi gọi detector bằng job.")
            ctx = DetectionContext.from_job(job_or_ctx, config, frames)

        if not self.is_enabled(ctx.config):
            return []

        return self.detect(ctx)

    def create_finding(
        self,
        rule: str,
        error_type: ErrorType,
        severity: Severity,
        frame: int,
        label: str,
        message: str,
        track_id: int | None = None,
        source_id: int | None = None,
        value: float | None = None,
        threshold: float | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> Finding:
        """Helper tạo Finding tiện dụng."""
        return Finding(
            error_type=error_type,
            rule=rule,
            severity=severity,
            frame=frame,
            label=label,
            message=message,
            track_id=track_id,
            source_id=source_id,
            value=value,
            threshold=threshold,
            details=details or {},
        )
