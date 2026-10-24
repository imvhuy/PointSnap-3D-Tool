"""Phát hiện sót đối tượng bằng LiDAR (việc C7, spec 4.2: NÊN gán box khi vật xuất hiện rõ trong point cloud).

Mỗi keyframe:

1. Ước lượng mặt đất cục bộ (điểm thấp nhất trong lưới 1 m, lấy min của ô và 8 ô quanh), giữ điểm cao hơn mặt đất
   0,3 – 4 m, trong khoảng `min_range_m` – `max_range_m` quanh cảm biến.
2. Bỏ điểm nằm trong box nhãn bất kỳ (nới `box_margin_m`), kể cả box `occluded`.
3. Gom cụm trên lưới nhìn từ trên (`cell_m`), hai ô cách nhau ≤ 1 ô là cùng cụm.
4. Giữ cụm **giống vật**: đủ điểm, kích thước trong khoảng của người / xe hai bánh / ô tô, chân cụm sát đất.

Rồi nối cụm giữa các keyframe liền nhau trong hệ toàn cục (dự đoán vận tốc không đổi, cổng `link_gate_m`). Chuỗi cụm
**di chuyển** (≥ `min_frames` keyframe, dời ≥ `min_motion_m` theo một hướng nhất quán) mà không box nào phủ → `lidar.missing`
(Cảnh báo).

Cụm **đứng yên** rất hay là cột, thùng rác, bụi cây không thuộc class cần gán, LiDAR không phân biệt được. Khi có ảnh
camera và model 2D (lớp 2), chuỗi cụm đứng yên giống vật (≥ `min_frames` keyframe, tâm lệch ≤ `static_gate_m`) được
chiếu lên ảnh: model 2D thấy vật **cùng loại** (cụm cỡ người ↔ person, cỡ xe ↔ car / truck / bus, cỡ xe hai bánh ↔
bicycle / motorcycle) trùng khung chiếu (IoU ≥ `static_min_iou`) ở ≥ `static_min_views` keyframe → `lidar.missing`
(Cảnh báo, `details.moving = False`): cả LiDAR lẫn ảnh cùng thấy vật mà không có box.

Không có box nên không gắn cờ lên CVAT được; mục ghi vị trí tâm cụm ở từng frame (hệ point cloud của frame) và kích thước
để người gán vẽ box.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Sequence

import numpy as np

from pointsnap.core.geometry import points_in_cuboid, validate_pose
from pointsnap.core.ground import fit_plane_ransac
from pointsnap.core.model import Cuboid, ErrorType, Finding, Severity, group_by_frame

if TYPE_CHECKING:
    from pointsnap.core.config import MissingConfig


@dataclass(eq=False)
class Cluster:
    frame: int
    center: np.ndarray       # (x, y) hệ point cloud của frame
    world: np.ndarray        # (x, y) hệ toàn cục
    length: float
    width: float
    height: float
    num_points: int
    cells: frozenset = frozenset()
    """Ô lưới (hệ toàn cục, cạnh `cell_m`) mà cụm chiếm."""
    bottom_z: float = 0.0
    """Mặt đất dưới cụm (hệ point cloud của frame)."""
    yaw: float = 0.0
    """Hướng trục dài của cụm (hệ point cloud của frame)."""
    persistence: float = 0.0


def _ground(points: np.ndarray, cell: float = 1.0) -> np.ndarray:
    """Độ cao mặt đất cục bộ dưới từng điểm: min z của ô lưới chứa điểm và 8 ô quanh."""
    keys = np.floor(points[:, :2] / cell).astype(np.int64)
    uniq, inverse = np.unique(keys, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    lowest = np.full(len(uniq), np.inf)
    np.minimum.at(lowest, inverse, points[:, 2])
    lookup = {tuple(k): i for i, k in enumerate(uniq)}
    local = lowest.copy()
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            if di == 0 and dj == 0:
                continue
            idx = np.array([lookup.get((i + di, j + dj), -1) for i, j in uniq])
            has = idx >= 0
            local[has] = np.minimum(local[has], lowest[idx[has]])
    return local[inverse]


def _frame_ground_plane(points: np.ndarray) -> tuple[float, float, float, float] | None:
    """Mặt đất chung của frame: mặt phẳng khớp (RANSAC) trên điểm thấp nhất mỗi ô 2 m; `None` nếu không khớp được."""
    keys = np.floor(points[:, :2] / 2.0).astype(np.int64)
    _, inverse = np.unique(keys, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    lowest = np.full(inverse.max() + 1, np.inf)
    np.minimum.at(lowest, inverse, points[:, 2])
    low = points[points[:, 2] <= lowest[inverse] + 0.2]
    if len(low) > 1500:  # đủ để khớp một mặt phẳng; giữ RANSAC nhanh trên frame dày điểm
        low = low[np.linspace(0, len(low) - 1, 1500).astype(int)]
    plane, _ = fit_plane_ransac(low, distance_threshold=0.2, max_iterations=50, min_inliers=max(50, len(low) // 5),
                                max_tilt_rad=math.radians(10.0))
    return plane


def _components(cells: np.ndarray, far: np.ndarray) -> list[np.ndarray]:
    """Nhóm chỉ số các ô kề nhau (8 hướng). Gần cảm biến không cho hở ô (người đứng sát tường không bị dính thành một
    cụm); ô ở xa (`far`, điểm thưa) cho hở 1 ô để xe xa không bị vỡ đôi."""
    index: dict[tuple[int, int], list[int]] = {}
    far_cell: set[tuple[int, int]] = set()
    for n, key in enumerate(map(tuple, cells)):
        index.setdefault(key, []).append(n)
        if far[n]:
            far_cell.add(key)
    seen: set[tuple[int, int]] = set()
    groups = []
    for start in index:
        if start in seen:
            continue
        seen.add(start)
        stack, members = [start], []
        while stack:
            i, j = stack.pop()
            members.extend(index[(i, j)])
            reach = (-2, -1, 0, 1, 2)
            for di in reach:
                for dj in reach:
                    nb = (i + di, j + dj)
                    if max(abs(di), abs(dj)) > 1 and (i, j) not in far_cell and nb not in far_cell:
                        continue
                    if nb in index and nb not in seen:
                        seen.add(nb)
                        stack.append(nb)
        groups.append(np.array(members))
    return groups


def frame_clusters(points: np.ndarray, boxes: Sequence[Cuboid], sensor_to_world: np.ndarray | None,
                   cfg: MissingConfig, frame: int, occupancy: set | None = None) -> list[Cluster]:
    """Cụm giống vật của một frame. `occupancy` (nếu có) được điền các ô (hệ toàn cục) có điểm không phải mặt đất,
    ngoài box nhãn — dùng để biết chỗ cụm đứng có còn bị chiếm ở frame kề không."""
    if sensor_to_world is None:
        return []  # World motion cannot be inferred from an unknown ego pose.
    m = validate_pose(sensor_to_world)
    pts = np.asarray(points, dtype=np.float64)[:, :3]
    rng = np.hypot(pts[:, 0], pts[:, 1])
    pts = pts[(rng >= cfg.min_range_m) & (rng <= cfg.max_range_m)]
    if len(pts) == 0:
        return []
    above = pts[:, 2] - _ground(pts)
    plane = _frame_ground_plane(pts)
    keep = (above > 0.3) & (above < 4.0)
    for box in boxes:
        if box.outside:
            continue
        reach = math.hypot(*(d / 2 + cfg.box_margin_m for d in box.dims[:2]))
        near = np.flatnonzero((np.abs(pts[:, 0] - box.center[0]) <= reach) & (np.abs(pts[:, 1] - box.center[1]) <= reach))
        if len(near):
            keep[near[points_in_cuboid(pts[near], box, margin=cfg.box_margin_m)]] = False
    pts, above = pts[keep], above[keep]
    world_xy = (pts @ m[:3, :3].T + m[:3, 3])[:, :2]
    world_cells = np.floor(world_xy / cfg.cell_m).astype(np.int64)
    if occupancy is not None:
        occupancy.update(map(tuple, world_cells))
    if len(pts) < cfg.min_points:
        return []
    clusters = []
    far = np.hypot(pts[:, 0], pts[:, 1]) > 12.0
    for idx in _components(np.floor(pts[:, :2] / cfg.cell_m).astype(np.int64), far):
        if len(idx) < cfg.min_points:
            continue
        xy, h = pts[idx, :2], above[idx]
        center = xy.mean(axis=0)
        cov = np.cov((xy - center).T) if len(idx) > 2 else np.eye(2)
        axes = np.linalg.eigh(cov)[1]
        major = axes[:, int(np.argmax(np.linalg.eigvalsh(cov)))]
        proj = (xy - center) @ axes
        extent = np.percentile(proj, 98, axis=0) - np.percentile(proj, 2, axis=0)
        width, length = float(min(extent)), float(max(extent))
        height = float(np.percentile(h, 98))
        bottom = float(np.percentile(h, 2))
        cells_used = len({tuple(c) for c in np.floor(xy / cfg.cell_m).astype(np.int64)})
        if (bottom > cfg.max_bottom_m or _kind(length, width, height) is None
                or len(idx) / cells_used < cfg.min_points_per_cell):
            continue  # nhiễu mưa / bụi rải rác: ~1 điểm mỗi ô; mặt vật thật bị nhiều tia quét chồng theo chiều đứng
        if plane is not None:
            a, b, c, d = plane
            if float(np.percentile(pts[idx, 2], 2)) + (a * center[0] + b * center[1] + d) / c > cfg.max_elevation_m:
                continue  # cụm treo trên cao (mái che, tầng nhà): đất ngay dưới bị che nên mặt đất cục bộ là chính nó
        world = world_xy[idx].mean(axis=0)
        clusters.append(Cluster(frame, center, world, length, width, height, len(idx),
                                frozenset(map(tuple, world_cells[idx])),
                                bottom_z=float(np.median(pts[idx, 2] - above[idx])),
                                yaw=float(math.atan2(major[1], major[0]))))
    return clusters


def _link(by_frame: dict[int, list[Cluster]], cfg: MissingConfig) -> list[list[Cluster]]:
    """Nối cụm giữa các keyframe liền nhau: dự đoán vận tốc không đổi, ghép gần nhất trong cổng."""
    chains: list[list[Cluster]] = []
    active: list[list[Cluster]] = []
    for frame in sorted(by_frame):
        free = list(by_frame[frame])
        next_active = []
        for chain in sorted(active, key=len, reverse=True):
            last = chain[-1]
            if last.frame != frame - 1:
                chains.append(chain)
                continue
            pred = last.world + (last.world - chain[-2].world if len(chain) > 1 else 0.0)
            # Bước đầu chưa biết vận tốc: cổng rộng theo tốc độ tối đa; sau đó dự đoán vận tốc không đổi.
            gate = cfg.link_gate_m if len(chain) > 1 else cfg.first_gate_m
            best = min(free, key=lambda c: np.linalg.norm(c.world - pred), default=None)
            if best is not None and np.linalg.norm(best.world - pred) <= gate:
                chain.append(best)
                free.remove(best)
                next_active.append(chain)
            else:
                chains.append(chain)
        next_active.extend([c] for c in free)
        active = next_active
    return chains + active


def _kind(length: float, width: float, height: float) -> str | None:
    """Loại vật theo kích thước cụm nhìn thấy (LiDAR thường chỉ thấy 1–2 mặt nên bề rộng cụm có thể rất nhỏ);
    `None` nếu không giống vật cần gán (quá dài, quá cao như tán cây, cột đèn)."""
    if length <= 1.3 and width <= 1.0 and 1.0 <= height <= 2.2:
        return "người"
    if length <= 2.8 and width <= 1.3 and 0.8 <= height <= 2.2:
        return "xe hai bánh"
    if 1.5 <= length <= 7.5 and width <= 3.2 and 0.8 <= height <= 3.8 and (height <= 2.5 or length >= 4.0):
        # Nhìn ngang chỉ thấy hông xe nên cụm có thể mỏng (tường mỏng dài bị loại bởi phép thử "chỗ cũ còn bị
        # chiếm"); xe cao > 2,5 m (tải, buýt) thì dài ≥ 4 m — cụm ngắn mà cao thường là tán cây, biển báo.
        return "xe"
    if 7.5 < length <= 18.0 and width <= 3.4 and 1.5 <= height <= 4.5:
        return "xe dài"  # xe buýt, xe tải dài, rơ-moóc: thường chỉ thấy một mặt hông nên bề rộng cụm nhỏ
    return None


def _persistence(cluster: Cluster, occupied: dict[int, set], frame: int, lag: int = 2) -> float:
    """Tỉ lệ ô của cụm vẫn có điểm ở frame cách `lag` keyframe (lấy lớn nhất của trước / sau; thiếu thì dùng frame kề).

    Cách 1 giây thì ô tô 4,5 m chạy ≥ 4 m/s, người đi bộ 1,2 m/s đã rời hẳn chỗ cũ; vật đứng yên vẫn chiếm chỗ."""
    best = 0.0
    for step in (-1, 1):
        other = frame + step * lag if frame + step * lag in occupied else frame + step
        if other in occupied and cluster.cells:
            best = max(best, sum(c in occupied[other] for c in cluster.cells) / len(cluster.cells))
    return best


def _steady(chain: list[Cluster]) -> bool:
    """Chuyển động đều và cùng hướng: mọi bước cùng chiều tổng (cos ≥ 0,5), độ dài bước trong [0,3; 2,5] × trung bình.
    Cụm đứng yên "trôi" theo góc nhìn hay nối nhầm hai vật đứng yên không qua được."""
    world = np.array([c.world for c in chain])
    steps = np.diff(world, axis=0)
    total = world[-1] - world[0]
    norm = np.linalg.norm(steps, axis=1)
    mean = float(norm.mean())
    if mean <= 0:
        return False
    cos = steps @ total / (norm * np.linalg.norm(total) + 1e-9)
    return bool(np.all(cos >= 0.5) and np.all(norm >= 0.3 * mean) and np.all(norm <= 2.5 * mean))


def detect_missing_objects(cuboids: Sequence[Cuboid], frames, cfg: MissingConfig, detector=None,
                           camera_cfg=None) -> tuple[list[Finding], list[list[Cluster]]]:
    """Mục `lidar.missing`: chuỗi cụm di chuyển không có box, và (có `detector`) chuỗi cụm đứng yên mà ảnh camera
    xác nhận. Trả kèm chuỗi cụm di chuyển."""
    boxes_by_frame = group_by_frame(cuboids)
    num_frames = getattr(frames, "num_frames", None) or (max(boxes_by_frame) + 1 if boxes_by_frame else 0)
    by_frame: dict[int, list[Cluster]] = {}
    occupied: dict[int, set] = {}
    timestamps = {}
    for f in range(num_frames):
        data = frames.frame_data(f)
        timestamps[f] = data.timestamp
        occupied[f] = set()
        by_frame[f] = frame_clusters(data.points, boxes_by_frame.get(f, []), data.sensor_to_world, cfg, f, occupied[f])
    # Vật đứng yên vẫn chiếm chỗ cũ ở frame kề; vật di chuyển thì chỗ cũ trống. Tách cụm đứng yên ra để đối chiếu ảnh.
    static_by_frame: dict[int, list[Cluster]] = {}
    for f, clusters in by_frame.items():
        for c in clusters:
            c.persistence = _persistence(c, occupied, f)
        # Người đứng yên lắc lư, cụm nhỏ: tỉ lệ chiếm chỗ dao động 0,2–0,4, nên nhánh đứng yên dùng ngưỡng thấp hơn
        # (chồng với nhánh di chuyển không sao: nhánh đó còn đòi dời ≥ 1,5–3 m).
        static_by_frame[f] = [c for c in clusters if c.persistence > cfg.static_min_persistence]
        by_frame[f] = [c for c in clusters if c.persistence <= cfg.max_persistence]
    chains = [c for c in _link(by_frame, cfg) if len(c) >= cfg.min_frames]
    findings, accepted = [], []
    for chain in chains:
        disp = float(np.linalg.norm(chain[-1].world - chain[0].world))
        size = (float(np.median([c.length for c in chain])), float(np.median([c.width for c in chain])),
                float(np.median([c.height for c in chain])))
        kind = _kind(*size) or "vật"
        # Người đi bộ chậm (~1,3 m/s): cần chuỗi dài hơn nhưng quãng dời ngắn hơn
        need_motion, need_frames = ((cfg.min_motion_person_m, cfg.min_frames + 1) if kind == "người"
                                    else (cfg.min_motion_m, cfg.min_frames))
        if disp < need_motion or len(chain) < need_frames or not _steady(chain):
            continue
        first, last = chain[0], chain[-1]
        start_time, stop_time = timestamps[first.frame], timestamps[last.frame]
        dt = (stop_time - start_time if start_time is not None and stop_time is not None and stop_time > start_time
              else (last.frame - first.frame) * cfg.keyframe_interval_s)
        accepted.append(chain)
        findings.append(Finding(
            error_type=ErrorType.FIT, rule="lidar.missing", severity=Severity.WARNING, frame=first.frame, label=kind,
            value=disp, threshold=need_motion,
            message=(f"Cụm điểm LiDAR cỡ {kind} ({size[0]:.1f} × {size[1]:.1f} × {size[2]:.1f} m, ~"
                     f"{int(np.median([c.num_points for c in chain]))} điểm) di chuyển {disp:.1f} m qua {len(chain)} "
                     f"keyframe ({first.frame}–{last.frame}) mà không có box: nghi sót đối tượng (spec 4.2)"),
            details={"frames": [c.frame for c in chain],
                     "centers": [[round(float(v), 2) for v in c.center] for c in chain],
                     "centers_3d": [[float(c.center[0]), float(c.center[1]), c.bottom_z + size[2] / 2] for c in chain],
                     "yaw_rad": [float(c.yaw) for c in chain],
                     "size_m": [round(v, 2) for v in size], "moving": True,
                     "speed_m_s": disp / dt if dt > 0 else 0., "duration_s": dt},
        ))
    if detector is not None and hasattr(frames, "camera_views"):
        moving_ids = {id(c) for chain in accepted for c in chain}
        static_by_frame = {f: [c for c in rows if id(c) not in moving_ids] for f, rows in static_by_frame.items()}
        findings.extend(_static_confirmed(_link_static(static_by_frame, cfg), cuboids, frames, detector, cfg,
                                          camera_cfg))
    return findings, accepted


def _link_static(by_frame: dict[int, list[Cluster]], cfg: MissingConfig) -> list[list[Cluster]]:
    """Chuỗi cụm đứng yên: keyframe liền nhau, tâm (hệ toàn cục) cách tâm đầu chuỗi ≤ `static_gate_m`."""
    chains, active = [], []
    for frame in sorted(by_frame):
        free = list(by_frame[frame])
        nxt = []
        for chain in active:
            if chain[-1].frame != frame - 1:
                chains.append(chain)
                continue
            anchor = chain[0].world
            best = min(free, key=lambda c: np.linalg.norm(c.world - anchor), default=None)
            if best is not None and np.linalg.norm(best.world - anchor) <= cfg.static_gate_m:
                chain.append(best)
                free.remove(best)
                nxt.append(chain)
            else:
                chains.append(chain)
        nxt.extend([c] for c in free)
        active = nxt
    return [c for c in chains + active if len(c) >= cfg.min_frames]


def _inside_fraction(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    """Tỉ lệ diện tích khung `a` nằm trong khung `b`."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    area = (a[2] - a[0]) * (a[3] - a[1])
    return ix * iy / area if area > 0 else 0.0


COCO_FOR_KIND = {"người": ("person",), "xe hai bánh": ("bicycle", "motorcycle"), "xe": ("car", "truck", "bus"),
                 "xe dài": ("bus", "truck", "train")}
KIND_OF_COCO = {"person": "người", "bicycle": "xe hai bánh", "motorcycle": "xe hai bánh", "car": "xe", "truck": "xe",
                "bus": "xe", "train": "xe dài"}


def _static_confirmed(chains: list[list[Cluster]], cuboids: Sequence[Cuboid], frames, detector, cfg: MissingConfig,
                      camera_cfg) -> list[Finding]:
    """Chuỗi cụm đứng yên mà ảnh camera thấy vật cùng loại trùng khung chiếu ở ≥ `static_min_views` keyframe."""
    from pointsnap.core.camera import iou_2d, project_box
    from pointsnap.core.config import CameraConfig
    from pointsnap.vision.detector2d import group_of_name

    camera_cfg = camera_cfg or CameraConfig()
    findings = []
    boxes_by_frame = group_by_frame(c for c in cuboids if not c.outside)
    for chain in chains:
        chain = sorted({c.frame: c for c in chain}.values(), key=lambda c: c.frame)
        if len(chain) < cfg.min_frames:
            continue
        size = (float(np.median([c.length for c in chain])), float(np.median([c.width for c in chain])),
                float(np.median([c.height for c in chain])))
        # Phần nhìn thấy đổi theo góc nhìn (xe đỗ nhìn nghiêng chỉ lộ một đoạn, giống xe hai bánh): chấp nhận mọi loại
        # cụm từng mang trong chuỗi, loại vật lấy theo ảnh camera.
        kinds = {k for c in chain if (k := _kind(c.length, c.width, c.height))}
        wanted = {group_of_name(name) for k in kinds for name in COCO_FOR_KIND[k]}
        views_ok, names = [], []
        for c in chain:
            data = frames.frame_data(c.frame, with_points=False)
            if data.sensor_to_world is None:
                continue
            pseudo = Cuboid(center=(float(c.center[0]), float(c.center[1]), c.bottom_z + size[2] / 2),
                            dims=(max(c.length, 0.3), max(c.width, 0.3), size[2]), yaw=c.yaw, label="cluster",
                            frame=c.frame)
            views = list(frames.camera_views(c.frame))
            dets = [detector.detect(v.path) for v in views]
            bright = [d.brightness for d in dets if d.brightness is not None]
            if bright and float(np.median(bright)) < camera_cfg.min_brightness:
                continue
            seen = []
            for view, det in zip(views, dets):
                if det.brightness is not None and det.brightness < camera_cfg.min_brightness:
                    continue
                proj = project_box(pseudo, data.sensor_to_world, view)
                if proj is None or proj.inside_ratio < 0.5 or proj.depth > cfg.max_range_m:
                    continue
                labelled = [(b, p) for b in boxes_by_frame.get(c.frame, [])
                            if (p := project_box(b, data.sensor_to_world, view)) is not None]
                # Detection 2D không có độ sâu: vật đã gán ở phía trước có thể che cụm xa cùng tia nhìn.
                # Chỉ dùng mặt ảnh này khi không có box gần hơn che phần lớn khung cụm; biên độ sâu dùng
                # nửa đường chéo 3D để không coi hai thể tích còn chồng độ sâu là trước/sau chắc chắn.
                front_depth = proj.depth - float(np.linalg.norm(pseudo.dims)) / 2
                if any(p.depth + float(np.linalg.norm(b.dims)) / 2 < front_depth
                       and _inside_fraction(proj.box, p.box) >= cfg.static_min_iou for b, p in labelled):
                    continue
                for box2d, name, score in zip(det.boxes, det.names, det.scores):
                    group = group_of_name(name)
                    supported = getattr(detector, "supported_groups", None)
                    if group not in wanted or (supported is not None and group not in supported) or score < cfg.static_min_score:
                        continue
                    b2 = tuple(float(v) for v in box2d)
                    # LiDAR thường chỉ thấy một mặt vật nên khung chiếu nhỏ hơn vật trên ảnh: xét phần khung chiếu
                    # nằm trong khung vật (không dùng IoU)
                    if _inside_fraction(proj.box, b2) < cfg.static_min_iou:
                        continue
                    if any(iou_2d(b2, p.box) >= cfg.static_labelled_iou for _, p in labelled):
                        continue  # vật trên ảnh là vật đã có box 3D (xe đỗ sát nhau thì khung ảnh chồng một phần)
                    seen.append((view.channel, name, float(score), group))
                    break
            if seen and len({item[3] for item in seen}) == 1:
                views_ok.append(c.frame)
                names.append(max(seen, key=lambda item: item[2]))
        groups = [item[3] for item in names]
        supported = getattr(detector, "supported_groups", None)
        eligible = sorted({g for g in groups if groups.count(g) >= cfg.static_min_views
                           and (supported is None or g in supported)}, key=lambda g: (-groups.count(g), g))
        if not eligible:
            continue
        group = eligible[0]
        matching = [(f, n) for f, n in zip(views_ok, names) if n[3] == group]
        views_ok, names = [f for f, _ in matching], [n for _, n in matching]
        first = chain[0]
        name = max(names, key=lambda n: n[2])[1]
        kind = KIND_OF_COCO.get(name.lower().strip(),
                               {"person": "người", "two_wheeler": "xe hai bánh", "vehicle": "xe"}[group])
        findings.append(Finding(
            error_type=ErrorType.FIT, rule="lidar.missing", severity=Severity.WARNING, frame=first.frame, label=kind,
            value=float(len(views_ok)), threshold=float(cfg.static_min_views),
            message=(f"Vật đứng yên cỡ {kind} ({size[0]:.1f} × {size[1]:.1f} × {size[2]:.1f} m, ~"
                     f"{int(np.median([c.num_points for c in chain]))} điểm LiDAR) ở {len(chain)} keyframe "
                     f"({first.frame}–{chain[-1].frame}); ảnh camera cũng thấy {name} ở {len(views_ok)} keyframe "
                     f"({names[0][0]}) mà không có box: nghi sót đối tượng (spec 4.2)"),
            details={"frames": [c.frame for c in chain], "camera_frames": views_ok,
                     "centers": [[round(float(v), 2) for v in c.center] for c in chain],
                     "centers_3d": [[float(c.center[0]), float(c.center[1]), c.bottom_z + size[2] / 2] for c in chain],
                     "yaw_rad": [float(c.yaw) for c in chain],
                     "size_m": [round(v, 2) for v in size], "moving": False, "camera_class": name},
        ))
    return findings
