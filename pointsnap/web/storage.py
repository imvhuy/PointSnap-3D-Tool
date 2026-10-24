"""Đọc JSON có kiểm kiểu; thay file nguyên vẹn sau khi ghi xong."""
import json
import math
import os
from pathlib import Path
import tempfile
import time
from typing import Any


class StorageError(ValueError):
    """File trạng thái không đọc được; không trả một kết quả rỗng thay dữ liệu hỏng."""


def replace_file(source: Path, destination: Path) -> None:
    """Atomic replace with bounded retries for Windows sharing/access denials."""
    delays = (0.02,0.05,0.1)
    for attempt in range(len(delays)+1):
        try:
            os.replace(source,destination)
            return
        except PermissionError as exc:
            if getattr(exc,"winerror",None) not in (5,32,33) or attempt == len(delays):
                raise
            time.sleep(delays[attempt])


def read_json(path: Path, expected: type = dict) -> Any:
    def reject_constant(value):
        raise ValueError("JSON chứa số không hữu hạn")
    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            reject_constant(value)
        return number
    try:
        data = json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant, parse_float=finite_float)
    except (OSError, ValueError) as exc:
        raise StorageError(f"Không đọc được {path.name}; kiểm tra hoặc khôi phục bản sao lưu.") from exc
    if not isinstance(data, expected):
        raise StorageError(f"Sai kiểu dữ liệu trong {path.name}.")
    if expected is list and any(not isinstance(item, dict) for item in data):
        raise StorageError(f"Mục trong {path.name} phải là object JSON.")
    return data


def write_text(path: Path, text: str) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".ps-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(text)
        replace_file(temporary,path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write_json(path: Path, data: Any) -> None:
    write_text(path, json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False))
