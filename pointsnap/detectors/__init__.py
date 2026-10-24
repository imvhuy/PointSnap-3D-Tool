"""Các bộ phát hiện lỗi (Detectors) cho PointSnap 3D."""

from pointsnap.detectors.base import BaseDetector
from pointsnap.detectors.fit import FitDetector
from pointsnap.detectors.floating import FloatingDetector, detect_floating, detect_floating_for_box
from pointsnap.detectors.heading import HeadingDetector
from pointsnap.detectors.size import (
    compute_class_ranges,
    detect_size,
    detect_size_class_range_for_box,
    detect_size_in_track,
)

__all__ = [
    "BaseDetector",
    "FloatingDetector",
    "HeadingDetector",
    "FitDetector",
    "detect_floating",
    "detect_floating_for_box",
    "detect_size",
    "detect_size_class_range_for_box",
    "detect_size_in_track",
    "compute_class_ranges",
]

