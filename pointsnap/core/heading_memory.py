"""Small, scan-local motion memory. Positions must share a world coordinate system."""

from collections import OrderedDict, deque
from dataclasses import dataclass
import math

import numpy as np


@dataclass(frozen=True)
class HeadingPrediction:
    heading: float | None
    velocity: tuple[float, float]
    predicted_center: tuple[float, float]
    frames: tuple[int, ...]
    moving: bool
    confidence: float

    def to_dict(self):
        return {"heading_world_rad": self.heading, "velocity_world_mps": list(self.velocity),
                "predicted_center_world": list(self.predicted_center), "frames_used": list(self.frames),
                "moving": self.moving, "confidence": self.confidence}


class HeadingMemory:
    """Bounded FIFO per object and LRU across objects; never shared between jobs/scans."""

    def __init__(self, window=5, max_tracks=128, max_gap_s=3.0, min_motion_m=0.5, min_speed_mps=0.5):
        if window < 2 or max_tracks < 1 or max_gap_s <= 0:
            raise ValueError("Invalid heading memory limits")
        self.window, self.max_tracks, self.max_gap_s = window, max_tracks, max_gap_s
        self.min_motion_m, self.min_speed_mps = min_motion_m, min_speed_mps
        self.tracks = OrderedDict()

    def update(self, key, frame, timestamp, center, yaw, *, visible=True):
        values = [timestamp, *center[:2], yaw]
        if not all(math.isfinite(float(v)) for v in values):
            raise ValueError("Heading observations must be finite")
        if not visible:
            self.tracks.pop(key, None)
            return
        history = self.tracks.pop(key, deque(maxlen=self.window))
        if history and (frame <= history[-1][0] or timestamp <= history[-1][1]
                        or timestamp - history[-1][1] > self.max_gap_s):
            history.clear()
        history.append((frame, float(timestamp), float(center[0]), float(center[1]), float(yaw)))
        self.tracks[key] = history
        while len(self.tracks) > self.max_tracks:
            self.tracks.popitem(last=False)

    def predict(self, key, horizon_s=0.5):
        if not math.isfinite(horizon_s) or not 0 <= horizon_s <= self.max_gap_s:
            raise ValueError("Prediction horizon exceeds memory lifetime")
        history = self.tracks.get(key)
        if not history:
            return None
        last = history[-1]
        velocity = np.zeros(2)
        moving = False
        if len(history) >= 2:
            # Recent displacement follows a turn without averaging the whole trajectory.
            prev = history[-2]
            displacement = np.asarray(last[2:4]) - np.asarray(prev[2:4])
            velocity = displacement / (last[1] - prev[1])
            moving = (np.linalg.norm(displacement) >= self.min_motion_m
                      and np.linalg.norm(velocity) >= self.min_speed_mps)
        if not moving:
            velocity[:] = 0
        heading = math.atan2(velocity[1], velocity[0]) if moving else last[4]
        center = np.asarray(last[2:4]) + velocity * horizon_s
        return HeadingPrediction(heading, tuple(float(v) for v in velocity), tuple(float(v) for v in center),
                                 tuple(int(r[0]) for r in history), bool(moving),
                                 min(0.95, 0.5 + 0.1 * len(history)) if moving else 0.3)
