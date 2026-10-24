"""Học từ kết luận của người duyệt (việc C3, lớp 4 của Box Verifier).

Người duyệt ghi **Đúng là lỗi** (`ok`) / **Báo nhầm** (`fp`) cho từng mục trên web hoặc extension (`reviews.json` của mỗi
lần quét). Module này dùng các kết luận đó để chấm **độ tin cậy** cho từng mục ở lần quét sau, theo hai tầng:

1. **Thống kê theo luật** (luôn có): precision của mỗi luật ước lượng bằng phân phối Beta(1 + số Đúng, 1 + số Báo nhầm),
   nên luật ít kết luận có độ tin cậy gần 50% và khoảng tin cậy rộng.
2. **Mô hình logistic** (khi có ≥ `MIN_SAMPLES_MODEL` kết luận và đủ cả hai loại): xác suất mục là lỗi thật theo luật,
   mức, class và **độ vượt ngưỡng** (số đo / ngưỡng). Chỉ dùng mô hình mới nếu sai số kiểm chéo (log-loss, 5 lần chia)
   **tốt hơn** tầng 1 trên cùng các fold tách theo job; mọi phiên bản cũ được giữ lại để quay về.

Độ tin cậy dùng để xếp mục (mục chắc chắn lên trước) và, nếu guideline bật `learning.adjust_severity`, hạ mục Cảnh báo có
độ tin cậy < `downgrade_below` xuống Thông tin. Tool không bao giờ tự sửa box.
"""

from __future__ import annotations

import json
import math
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

from pointsnap.web.storage import StorageError, read_json, write_json

MIN_SAMPLES_MODEL = 40
"""Cần ít nhất chừng này kết luận (có cả Đúng và Báo nhầm) mới thử mô hình logistic."""

L2 = 1.0
FOLDS = 5


@dataclass
class Sample:
    rule: str
    severity: str
    label: str
    value: float | None
    threshold: float | None
    verdict: str  # "ok" | "fp"
    group: str | None = None  # source job; all rescans/tracks remain in one CV fold

    @property
    def target(self) -> int:
        return 1 if self.verdict == "ok" else 0


def collect_reviews(project_dir: str | Path) -> list[Sample]:
    """Mọi kết luận xem tay của dự án (tất cả lần quét)."""
    samples: dict[tuple, Sample] = {}
    runs = Path(project_dir) / "runs"
    for run_dir in sorted(p for p in runs.iterdir() if p.is_dir()) if runs.is_dir() else []:
        review_path, findings_path = run_dir / "reviews.json", run_dir / "findings.json"
        if not findings_path.is_file():
            if review_path.is_file():
                raise StorageError("reviews.json thiếu findings.json tương ứng")
            continue
        from pointsnap.web.preview import load_reviews
        reviews = load_reviews(run_dir)
        findings = read_json(findings_path, list)
        summary_path = run_dir / "summary.json"
        summary = read_json(summary_path) if summary_path.is_file() else {}
        if (not isinstance(summary.get("cvat_url", ""), str)
                or summary.get("job_id") is not None and
                (type(summary["job_id"]) is not int or summary["job_id"] < 0)):
            raise StorageError("summary.json có nguồn job không hợp lệ")
        source = (summary.get("cvat_url", "").rstrip("/"), summary.get("job_id"))
        # Without source metadata, preserve old runs independently rather than guessing box identity.
        group = json.dumps(source) if source[1] is not None else run_dir.name
        for i, f in enumerate(findings):
            rule, label, severity = f.get("rule"), f.get("label", ""), f.get("severity", "warning")
            if (not isinstance(rule, str) or not rule or not isinstance(label, str)
                    or severity not in ("error", "warning", "info")
                    or any(v is not None and (type(v) is not int or v < 0)
                           for v in (f.get("track_id"), f.get("source_id"), f.get("frame")))
                    or any(v is not None and (isinstance(v, bool) or not isinstance(v, (int, float))
                           or not math.isfinite(v)) for v in (f.get("value"), f.get("threshold")))):
                raise StorageError("findings.json có dữ liệu học không hợp lệ")
            owner = ("track", f["track_id"]) if f.get("track_id") is not None else ("shape", f.get("source_id"))
            if owner[1] is not None and f.get("frame") is not None and source[1] is not None:
                # Same observation only: changed measurements must not inherit a stale verdict.
                key = (group, owner, f["frame"], rule, label, severity, f.get("value"), f.get("threshold"))
            else:
                key = (run_dir.name, i)
            samples.pop(key, None)
            verdict = reviews.get(str(i))
            if verdict is not None:
                samples[key] = Sample(rule, severity, label, f.get("value"), f.get("threshold"), verdict, group)
    return list(samples.values())


# --- Tầng 1: thống kê theo luật ---------------------------------------------------------------------------


def rule_stats(samples: Iterable[Sample]) -> dict[str, dict[str, float]]:
    stats: dict[str, dict[str, float]] = {}
    for s in samples:
        row = stats.setdefault(s.rule, {"ok": 0, "fp": 0})
        row[s.verdict] += 1
    for rule, row in stats.items():
        a, b = 1 + row["ok"], 1 + row["fp"]
        row["precision"] = a / (a + b)
        row["n"] = row["ok"] + row["fp"]
        # độ lệch chuẩn của Beta: thể hiện độ chắc của ước lượng
        row["std"] = math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)))
    return stats


# --- Tầng 2: mô hình logistic ------------------------------------------------------------------------------


def _ratio(value: float | None, threshold: float | None) -> float:
    if value is None or not threshold:
        return 0.0
    return float(np.clip(math.log(max(abs(value), 1e-6) / max(abs(threshold), 1e-6)), -3.0, 3.0))


@dataclass
class Vocabulary:
    rules: list[str]
    labels: list[str]

    @classmethod
    def build(cls, samples: Sequence[Sample]) -> Vocabulary:
        return cls(sorted({s.rule for s in samples}), sorted({s.label for s in samples}))

    def features(self, rule: str, severity: str, label: str, value: float | None, threshold: float | None) -> np.ndarray:
        x = [1.0, _ratio(value, threshold), 1.0 if severity == "error" else 0.0]
        x += [1.0 if rule == r else 0.0 for r in self.rules]
        x += [1.0 if label == lb else 0.0 for lb in self.labels]
        return np.array(x)


def _fit(x: np.ndarray, y: np.ndarray, iterations: int = 500, lr: float = 0.5) -> np.ndarray:
    w = np.zeros(x.shape[1])
    for _ in range(iterations):
        p = 1.0 / (1.0 + np.exp(-x @ w))
        grad = x.T @ (p - y) / len(y) + L2 * np.r_[0.0, w[1:]] / len(y)
        w -= lr * grad
    return w


def _logloss(p: np.ndarray, y: np.ndarray) -> float:
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def _review_folds(samples: Sequence[Sample], seed: int = 0):
    groups: dict[str, list[Sample]] = {}
    for i, s in enumerate(samples):
        groups.setdefault(s.group if s.group is not None else f"sample:{i}", []).append(s)
    if len(groups) < 2:
        return []
    keys = sorted(groups)
    order = np.random.default_rng(seed).permutation(len(keys))
    folds = np.array_split(order, min(FOLDS, len(keys)))
    return [([s for i in test for s in groups[keys[i]]],
             [s for i in order if i not in set(test) for s in groups[keys[i]]]) for test in folds]


def _cross_validate(samples: Sequence[Sample], seed: int = 0) -> tuple[float, float]:
    """Log-loss kiểm chéo của (tầng 1, mô hình logistic)."""
    p_rule, p_model, ys = [], [], []
    for test, train in _review_folds(samples, seed):
        stats = rule_stats(train)
        vocab = Vocabulary.build(train)
        w = _fit(np.stack([vocab.features(s.rule, s.severity, s.label, s.value, s.threshold) for s in train]),
                 np.array([s.target for s in train], dtype=float))
        for s in test:
            p_rule.append(stats.get(s.rule, {}).get("precision", 0.5))
            p_model.append(_sigmoid(float(vocab.features(s.rule, s.severity, s.label, s.value, s.threshold) @ w)))
            ys.append(s.target)
    y = np.array(ys, dtype=float)
    return _logloss(np.array(p_rule), y), _logloss(np.array(p_model), y)


@dataclass
class LearnedModel:
    """Kết quả học: thống kê theo luật và (nếu tốt hơn) trọng số mô hình logistic."""

    version: int
    trained_at: str
    n_samples: int
    rule_stats: dict[str, dict[str, float]]
    use_model: bool = False
    weights: list[float] = field(default_factory=list)
    vocabulary: dict[str, list[str]] = field(default_factory=dict)
    cv_logloss_rule: float | None = None
    cv_logloss_model: float | None = None

    def confidence(self, rule: str, severity: str, label: str, value: float | None, threshold: float | None) -> float:
        """Xác suất mục là lỗi thật."""
        if (self.use_model and self.weights and rule in self.vocabulary["rules"]
                and label in self.vocabulary["labels"]):
            vocab = Vocabulary(self.vocabulary["rules"], self.vocabulary["labels"])
            z = float(vocab.features(rule, severity, label, value, threshold) @ np.array(self.weights))
            return _sigmoid(z)
        return float(self.rule_stats.get(rule, {}).get("precision", 0.5))

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> LearnedModel:
        try:
            model = cls(**data)
            if (type(model.version) is not int or model.version < 1
                    or type(model.n_samples) is not int or model.n_samples < 0
                    or not isinstance(model.trained_at, str) or type(model.use_model) is not bool
                    or not isinstance(model.rule_stats, dict)):
                raise ValueError("invalid metadata")
            for rule, row in model.rule_stats.items():
                if (not isinstance(rule, str) or not isinstance(row, dict)
                        or not all(type(row.get(k)) in (int, float) and math.isfinite(row[k])
                                   for k in ("ok", "fp", "n", "precision", "std"))
                        or min(row["ok"], row["fp"], row["n"], row["std"]) < 0
                        or not 0 <= row["precision"] <= 1 or row["n"] != row["ok"] + row["fp"]):
                    raise ValueError("invalid statistics")
            if model.use_model:
                vocab = Vocabulary(**model.vocabulary)
                if (any(not isinstance(v, list) or any(not isinstance(k, str) for k in v)
                        for v in (vocab.rules, vocab.labels))
                        or len(model.weights) != 3 + len(vocab.rules) + len(vocab.labels)
                        or any(type(w) not in (int, float) or not math.isfinite(w) for w in model.weights)):
                    raise ValueError("invalid weights")
            for loss in (model.cv_logloss_rule, model.cv_logloss_model):
                if loss is not None and (type(loss) not in (int, float) or not math.isfinite(loss) or loss < 0):
                    raise ValueError("invalid loss")
            return model
        except (TypeError, ValueError, KeyError, AttributeError) as exc:
            raise StorageError("learned.json có mô hình không hợp lệ; khôi phục bản sao lưu") from exc


def train(samples: Sequence[Sample], previous: LearnedModel | None = None) -> LearnedModel:
    """Mô hình logistic chỉ được dùng khi kiểm chéo theo nguồn tốt hơn thống kê theo luật."""
    model = LearnedModel(
        version=(previous.version + 1) if previous else 1,
        trained_at=time.strftime("%Y-%m-%d %H:%M:%S"),
        n_samples=len(samples),
        rule_stats=rule_stats(samples),
    )
    targets = {s.target for s in samples}
    if len(samples) >= MIN_SAMPLES_MODEL and targets == {0, 1} and _review_folds(samples):
        cv_rule, cv_model = _cross_validate(samples)
        model.cv_logloss_rule, model.cv_logloss_model = cv_rule, cv_model
        # Old CV scores use different reviews/folds and cannot rank this dataset.
        if cv_model < cv_rule:
            vocab = Vocabulary.build(samples)
            x = np.stack([vocab.features(s.rule, s.severity, s.label, s.value, s.threshold) for s in samples])
            model.weights = _fit(x, np.array([s.target for s in samples], dtype=float)).tolist()
            model.vocabulary = {"rules": vocab.rules, "labels": vocab.labels}
            model.use_model = True
    return model


def apply(findings: Sequence[Any], model: LearnedModel | None, adjust_severity: bool = False,
          downgrade_below: float = 0.15, min_rule_reviews: int = 20) -> list[Any]:
    """Gắn `details["confidence"]` cho từng mục; nếu `adjust_severity`, hạ Cảnh báo kém tin cậy xuống Thông tin."""
    import dataclasses

    from pointsnap.core.model import Severity

    if model is None:
        return list(findings)
    result = []
    for f in findings:
        p = model.confidence(f.rule, f.severity.value, f.label, f.value, f.threshold)
        details = {**f.details, "confidence": round(p, 3)}
        n_rule = model.rule_stats.get(f.rule, {}).get("n", 0)
        if (adjust_severity and f.severity is Severity.WARNING and p < downgrade_below
                and n_rule >= min_rule_reviews):
            result.append(dataclasses.replace(
                f, severity=Severity.INFO, details={**details, "downgraded": True},
                message=f"{f.message} [hạ xuống Thông tin: độ tin cậy {p:.0%} theo {int(n_rule)} kết luận đã duyệt]"))
        else:
            result.append(dataclasses.replace(f, details=details))
    return result


# --- Lưu / nạp theo dự án ---------------------------------------------------------------------------------


def model_path(project_dir: str | Path) -> Path:
    return Path(project_dir) / "learned.json"


def load_model(project_dir: str | Path) -> LearnedModel | None:
    path = model_path(project_dir)
    if not path.is_file():
        return None
    return LearnedModel.from_dict(read_json(path))


def _sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    exp = math.exp(z)
    return exp / (1.0 + exp)


@contextmanager
def _learning_lock(project_dir: Path):
    # Exclusive file creation serializes CLI and web writers, including separate processes.
    lock = project_dir / ".learn.lock"
    try:
        lock.open("x", encoding="utf-8").close()
    except FileExistsError as exc:
        raise StorageError("Dự án đang học; thử lại sau. Nếu tiến trình đã dừng, xóa .learn.lock.") from exc
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def learn_project(project_dir: str | Path) -> LearnedModel:
    """Học lại từ mọi kết luận của dự án, lưu `learned.json` (bản cũ chuyển vào `learned-history/`)."""
    project_dir = Path(project_dir)
    with _learning_lock(project_dir):
        previous = load_model(project_dir)
        model = train(collect_reviews(project_dir), previous)
        history = project_dir / "learned-history"
        versions = [int(p.stem.removeprefix("learned-v")) for p in history.glob("learned-v*.json")
                    if p.stem.removeprefix("learned-v").isdigit()]
        model.version = max([model.version, *(v + 1 for v in versions)])
        if previous is not None:
            history.mkdir(exist_ok=True)
            archive = history / f"learned-v{previous.version}.json"
            if archive.exists() and read_json(archive) != previous.to_dict():
                raise StorageError("Lịch sử có nội dung khác cùng phiên bản; giữ mô hình đang dùng")
            if not archive.exists():
                write_json(archive, previous.to_dict())
        write_json(model_path(project_dir), model.to_dict())
        return model


def report(model: LearnedModel) -> str:
    lines = [f"Học từ {model.n_samples} kết luận (phiên bản {model.version}, {model.trained_at})."]
    for rule, row in sorted(model.rule_stats.items(), key=lambda kv: -kv[1]["n"]):
        lines.append(f"  {rule:24s} Đúng {int(row['ok']):3d} · Báo nhầm {int(row['fp']):3d} · "
                     f"precision ước lượng {row['precision']:.0%} (± {row['std']:.0%})")
    if model.cv_logloss_model is not None:
        used = "dùng" if model.use_model else "không dùng (chưa tốt hơn thống kê theo luật)"
        lines.append(f"Mô hình logistic: log-loss kiểm chéo {model.cv_logloss_model:.3f} so với "
                     f"{model.cv_logloss_rule:.3f} của thống kê theo luật → {used}.")
    else:
        lines.append(f"Cần ≥ {MIN_SAMPLES_MODEL} kết luận, cả Đúng và Báo nhầm và ≥ 2 nhóm nguồn độc lập để kiểm chéo.")
    return "\n".join(lines)
