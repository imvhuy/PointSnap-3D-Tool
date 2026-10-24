"""Box lệch khỏi vật và box xoay lệch trục vật, đo bằng mét / độ (luật `fit.offset`, `fit.yaw`; cấu hình `box_fit`).

Các luật box lệch cũ đều cho tỉ lệ so với trung vị track (`fit.outside`: tỉ lệ điểm ngoài box; `cam.mismatch`: tỉ lệ mặt nạ
ảnh ngoài khung chiếu), không ra số mét, không bắt được box phóng to hay box nhảy xa khỏi vật, và cần track. Ở đây đi từ box,
đo từng frame độc lập:

1. **Điểm ứng viên**: điểm LiDAR trong box nới `search_margin_m` mỗi phía, bỏ mặt đất và điểm của box khác. Box lệch 1 m
   vẫn còn vật trong vùng tìm (`fit.outside` chỉ loang từ điểm cách mặt box ≤ 0,3 m nên mất vật khi box lệch xa).
2. **Chọn điểm của vật** theo `box_fit.source`:
   - `lidar` (mặc định, không cần camera / GPU): điểm ứng viên nối liền với các điểm trong box.
   - `sam`: SAM 2.1 nhận prompt từ chính box (`vision.prompted_sam`) trên mỗi ảnh box chiếu tới: khung chiếu box, điểm LiDAR
     của vật làm điểm dương (bỏ điểm bị vật khác che trên ảnh), tâm box lân cận làm điểm âm; chọn trong 3 mặt nạ của SAM mặt
     nạ chứa nhiều điểm của vật nhất. Điểm rơi vào mặt nạ và không quá sâu sau mặt trước của vật là điểm của vật; gộp các
     ảnh, giữ cụm liền lớn nhất. Vật che phía trước tự bị loại; mặt bị che / ra ngoài ảnh không dùng để canh (bước 3).
3. **Fit lại box, giữ nguyên kích thước**: xe đủ dài, đủ điểm và cụm phủ ≥ ½ chiều dài thì tìm trục vật bằng phép khớp
   hình chữ L (`heading.rectangle_angle`). Theo từng trục: cụm phủ ≥ `full_cover` cạnh box thì canh giữa, không thì canh mặt
   gần cảm biến (mặt nhìn thấy được) vào điểm của vật; phần khuất suy từ kích thước.

`fit.offset`: tâm vật lệch tâm box > `offset_warning_m` (Cảnh báo), > `offset_error_m` (Lỗi). `fit.yaw`: trục vật lệch hướng
box > `yaw_warning_deg` / `yaw_error_deg` (modulo 90°: lật 180° do `heading.flip` / `heading.motion` / `cam.face` bắt).
Mỗi mục kèm box tham chiếu (`details.proposed_*`, khung ghost) chỉ đổi phần bị báo; người dùng kéo box theo khung rồi Save
trong CVAT (API ghi hình học đã ngừng). Thông báo nêu trục nào có bằng chứng, trục nào chưa đủ. Luật không kết luận kích
thước: đã thử báo "box to / nhỏ hơn vật" theo bề rộng cụm điểm, nhưng trên nhãn sạch nuScenes cờ đó bật gần bằng trên box
lỗi (điểm mặt gần không chạm góc vật bo tròn), nên đã bỏ. Thay vào đó so kích thước box với các keyframe khác cùng track
(`size_off_track`, ngưỡng Cảnh báo của `size.in_track`): lệch thì vẫn báo nhưng không đề xuất dời tâm, vì box dư / thiếu
trông như box lệch khi chỉ thấy mặt gần (đo trên nuScenes: trước đó mọi box phóng to bị đề xuất dời sai). Box vẽ dư ở mọi
frame của track thì cách này không thấy.

Đo trên nuScenes mini: docs/ket-qua/ket-qua-box-fit.md (`scripts/eval_box_fit.py`).
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

from pointsnap.core.box_points import connected_to_box
from pointsnap.core.camera import covered_fraction, iou_2d, project_box, project_points
from pointsnap.core.geometry import median_axis_degrees, normalize_angle, to_box_frame, wrap90
from pointsnap.core.ground import OtherBoxPoints, ring_ground_for_box
from pointsnap.core.model import Cuboid, ErrorType, Finding, Severity, group_by_frame
from pointsnap.detectors.camera import _hull, _inside_hull
from pointsnap.detectors.heading import rectangle_angle
from pointsnap.vision.prompted_sam import Prompt

if TYPE_CHECKING:
    from pointsnap.core.camera import CameraView
    from pointsnap.core.config import BoxFitConfig
    from pointsnap.vision.prompted_sam import PromptSegmenter

LIFT_VOXEL_M = 0.3
"""Hai điểm thuộc cùng vật nếu nối được qua các ô lưới cạnh chừng này có điểm."""
LIFT_VOXEL_PER_M = 0.025
"""Vật xa: ô lưới nới theo khoảng cách (2,5 cm mỗi mét). LiDAR 32 tia của nuScenes cách nhau ~1,3°, tức ~0,46 m ở 20 m:
ô 0,3 m cắt xe 20 m thành từng vệt tia rời nhau."""
SEED_TOLERANCE_M = 0.1
"""Điểm dương cho SAM: điểm của vật nằm trong box nới chừng này."""
MAX_POSITIVE, MAX_NEGATIVE = 3, 3
YAW_MIN_COVER = 0.5
"""Chỉ ước lượng trục vật khi cụm điểm phủ ≥ chừng này × chiều dài box."""
BLIND_REACH_M, BLIND_MIN_POINTS = 1.0, 3
"""Mặt cụm điểm bị cắt (không dùng để canh) nếu ngay ngoài mặt đó, trong 1 m, có ≥ 3 điểm ứng viên không ảnh nào nhìn
thấy: vật nằm một phần ngoài ảnh (xe tải sát xe thu) thì mép cụm là mép ảnh, không phải mặt vật."""
MIN_SEED_PROMPT = 20
"""Box có góc nằm sau mặt phẳng camera (vật lớn sát xe thu) thì lấy khung prompt từ ≥ chừng này điểm của vật trên ảnh."""


@dataclass(frozen=True, eq=False)
class FitMeasure:
    """Kết quả fit một box: độ lệch tâm vật so với tâm box theo hệ box (dọc x, ngang y, mét) và góc trục vật − hướng box."""

    box: Cuboid
    num_points: int
    cameras: tuple[str, ...]
    delta_local: tuple[float, float]
    delta_yaw: float
    yaw_measured: bool
    observed: tuple[bool, bool]
    extent: tuple[float, float]
    occlusion: float

    @property
    def offset_m(self) -> float:
        return float(math.hypot(*self.delta_local))

    def proposed(self, delta_local: tuple[float, float] | None = None, delta_yaw: float | None = None) -> Cuboid:
        dx, dy = self.delta_local if delta_local is None else delta_local
        dyaw = self.delta_yaw if delta_yaw is None else delta_yaw
        c, s = math.cos(self.box.yaw), math.sin(self.box.yaw)
        x, y, z = self.box.center
        return self.box.replace(center=(x + c * dx - s * dy, y + s * dx + c * dy, z),
                                yaw=normalize_angle(self.box.yaw + dyaw))


@dataclass(frozen=True, eq=False)
class _Candidates:
    index: np.ndarray     # chỉ số điểm trong point cloud của frame
    local: np.ndarray     # (M, 3) hệ box
    seed: np.ndarray      # (M,) điểm của vật nằm trong box: điểm dương cho SAM
    blockers: np.ndarray  # chỉ số các điểm thuộc box khác trong vùng tìm (có thể che điểm dương trên ảnh)


def candidate_points(cloud: OtherBoxPoints, slot: int, box: Cuboid, cfg: BoxFitConfig) -> _Candidates:
    """Điểm có thể thuộc vật của `box` (chiếm chỗ box thứ `slot` của `cloud`): trong box nới `search_margin_m`, cao hơn
    mặt đất cục bộ + `ground_clearance_m`, không thuộc box khác."""
    pts = cloud.points
    half = np.asarray(box.dims) / 2.0
    pad = cfg.search_margin_m
    reach = math.hypot(half[0] + pad, half[1] + pad) + 0.1
    idx = cloud.near(box.center[0], box.center[1], reach)
    local = to_box_frame(pts[idx], box)
    own = cloud.without_others(slot, reach=math.hypot(half[0] + 1.5, half[1] + 1.5))
    ground = ring_ground_for_box(own, box)
    base = (ground.ground_z if ground.is_valid else box.bottom_z) - box.center[2]
    floor = base + min(cfg.ground_clearance_m, 0.3 * box.height)
    region = (np.all(np.abs(local[:, :2]) <= half[:2] + pad, axis=1) & (local[:, 2] > floor)
              & (local[:, 2] <= half[2] + 0.3))
    others = cloud.belongs_to_others(slot, idx)
    blockers = idx[region & others]
    idx, local = idx[region & ~others], local[region & ~others]
    seed = connected_to_box(local, half) & np.all(np.abs(local) <= half + SEED_TOLERANCE_M, axis=1)
    return _Candidates(idx, local, seed, blockers)


OCCLUSION_PX, OCCLUSION_DEPTH_M = 6.0, 0.3
"""Điểm dương bị che trên ảnh nếu có điểm khác cách nó ≤ 6 px mà gần camera hơn ≥ 0,3 m (LiDAR và camera đặt ở hai chỗ
khác nhau nên LiDAR có thể thấy điểm mà camera bị cột / người che): khi đó SAM sẽ cắt vật che."""


def _clear(i: int, pixels: np.ndarray, depth: np.ndarray, occ_pixels: np.ndarray, occ_depth: np.ndarray) -> bool:
    near = np.sum((occ_pixels - pixels[i]) ** 2, axis=1) <= OCCLUSION_PX ** 2
    return not np.any(near & (occ_depth < depth[i] - OCCLUSION_DEPTH_M))


def _positives(pixels: np.ndarray, depth: np.ndarray, seed: np.ndarray, occ_pixels: np.ndarray, occ_depth: np.ndarray,
               k: int) -> np.ndarray:
    """Tối đa `k` điểm dương không bị che: gần trung vị cụm nhất, rồi lệch trái / phải ¼ bề ngang cụm."""
    usable = np.flatnonzero(seed & np.isfinite(pixels).all(axis=1))
    if len(usable) == 0:
        return np.zeros((0, 2))
    pix = pixels[usable]
    med = np.median(pix, axis=0)
    width = float(np.percentile(pix[:, 0], 90) - np.percentile(pix[:, 0], 10))
    chosen: list[int] = []
    for target in (med, med + (0.25 * width, 0.0), med - (0.25 * width, 0.0))[:k]:
        for j in np.argsort(np.sum((pix - target) ** 2, axis=1))[:50]:
            i = int(usable[j])
            if i in chosen:
                break
            if _clear(i, pixels, depth, occ_pixels, occ_depth):
                chosen.append(i)
                break
    return pixels[chosen]


@dataclass(frozen=True, eq=False)
class _SeedProjection:
    """Thay `core.camera.Projection` khi box có góc sau camera: khung bao điểm của vật trên ảnh."""

    box: tuple[float, float, float, float]
    depth: float
    polygon: np.ndarray
    inside_ratio: float = 1.0


def _seed_projection(pixels: np.ndarray, depth: np.ndarray, seed: np.ndarray, view: CameraView) -> _SeedProjection | None:
    ok = seed & np.isfinite(pixels).all(axis=1)
    ok &= (pixels[:, 0] >= 0) & (pixels[:, 0] < view.width) & (pixels[:, 1] >= 0) & (pixels[:, 1] < view.height)
    if ok.sum() < MIN_SEED_PROMPT:
        return None
    pix = pixels[ok]
    x1, y1 = pix.min(axis=0)
    x2, y2 = pix.max(axis=0)
    polygon = np.array([(x1, y1), (x2, y1), (x2, y2), (x1, y2)], dtype=np.float64)
    return _SeedProjection((float(x1), float(y1), float(x2), float(y2)), float(np.median(depth[ok])), polygon)


def _prompt(proj, view: CameraView, pixels: np.ndarray, depth: np.ndarray, seed: np.ndarray,
            blockers: tuple[np.ndarray, np.ndarray], others: Sequence[tuple[np.ndarray, float]],
            cfg: BoxFitConfig) -> Prompt:
    x1, y1, x2, y2 = proj.box
    ex, ey = (x2 - x1) * cfg.prompt_expand, (y2 - y1) * cfg.prompt_expand
    rect = (max(0.0, x1 - ex), max(0.0, y1 - ey), min(float(view.width), x2 + ex), min(float(view.height), y2 + ey))
    # Điểm có thể che điểm dương: điểm ứng viên không thuộc vật (cột, bụi sát vật) và điểm của box khác.
    occ_pixels = np.vstack([pixels[~seed], blockers[0]])
    occ_depth = np.concatenate([depth[~seed], blockers[1]])
    ok = np.isfinite(occ_pixels).all(axis=1)
    positive = _positives(pixels, depth, seed, occ_pixels[ok], occ_depth[ok], MAX_POSITIVE)
    hull = _hull(proj.polygon)
    centre = np.array([(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2])
    negative = [pix for pix, depth in others
                if rect[0] <= pix[0] <= rect[2] and rect[1] <= pix[1] <= rect[3]
                and (depth < proj.depth - 0.5 or not _inside_hull(pix[None], hull)[0])]
    negative.sort(key=lambda p: float(np.sum((p - centre) ** 2)))
    return Prompt(rect, positive, np.array(negative[:MAX_NEGATIVE]).reshape(-1, 2), pixels, prefer=seed)


def _largest_component(local: np.ndarray, voxel: float = LIFT_VOXEL_M) -> np.ndarray:
    """Mask cụm điểm liền (qua các ô lưới `voxel` kề nhau) có nhiều điểm nhất."""
    if len(local) == 0:
        return np.zeros(0, dtype=bool)
    keys = [tuple(k) for k in np.floor(local / voxel).astype(np.int64)]
    cells: dict[tuple, list[int]] = defaultdict(list)
    for i, key in enumerate(keys):
        cells[key].append(i)
    best: list[int] = []
    seen: set[tuple] = set()
    for start in cells:
        if start in seen:
            continue
        seen.add(start)
        frontier, members = [start], []
        while frontier:
            x, y, z = frontier.pop()
            members.extend(cells[(x, y, z)])
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        nb = (x + dx, y + dy, z + dz)
                        if nb in cells and nb not in seen:
                            seen.add(nb)
                            frontier.append(nb)
        if len(members) > len(best):
            best = members
    mask = np.zeros(len(local), dtype=bool)
    mask[best] = True
    return mask


def fit_measure(box: Cuboid, local: np.ndarray, sensor_local: np.ndarray, cameras: tuple[str, ...], occlusion: float,
                cfg: BoxFitConfig, blind: np.ndarray | None = None,
                hidden: Callable[[np.ndarray], np.ndarray] | None = None) -> FitMeasure | None:
    """Fit box (giữ kích thước) vào điểm của vật `local` (hệ box). `None` nếu quá ít điểm.

    Chỉ canh theo một mặt của cụm điểm khi vùng ngay ngoài mặt đó **thấy được và trống**:
    - `blind`: điểm (hệ box) có thể thuộc vật mà cụm không có: điểm ứng viên không ảnh nào nhìn thấy (vật nằm một phần
      ngoài ảnh), điểm LiDAR của vật trong box mà mặt nạ không chứa (vật bị che trên ảnh). Có ≥ `BLIND_MIN_POINTS` điểm
      như vậy ngay ngoài mặt thì mặt đó chưa phải mặt vật.
    - `hidden(điểm hệ box) → bool`: điểm không ảnh nào thấy được (ngoài ảnh, hoặc sau box gần hơn). Vùng ngay ngoài mặt bị
      che quá nửa (xe tải sau máy xúc) thì cũng không canh: vật có thể còn kéo dài vào chỗ bị che.
    """
    n = len(local)
    if n < cfg.min_points:
        return None
    xy = np.asarray(local, dtype=np.float64)[:, :2]
    theta, yaw_measured = 0.0, False
    # Cụm điểm chỉ thấy một đoạn ngắn của vật dài (xe tải ở sát, mặt nạ chỉ phủ cabin) cho trục chữ L sai: cần phủ ≥ ½
    # chiều dài box.
    if (box.label in cfg.yaw_classes and box.length >= cfg.yaw_min_aspect * box.width and n >= cfg.yaw_min_points
            and float(np.ptp(xy[:, 0])) >= YAW_MIN_COVER * box.length):
        theta, yaw_measured = rectangle_angle(xy), True
    c, s = math.cos(theta), math.sin(theta)
    rot = np.array([[c, s], [-s, c]])  # hệ box cũ → hệ box đã xoay theta
    p = xy @ rot.T
    sensor = rot @ np.asarray(sensor_local, dtype=np.float64)[:2]
    # Bỏ vài điểm lạc ở mỗi đầu (thứ hạng, không theo phần trăm: mặt gần cảm biến dày điểm hơn hẳn mặt xa nên
    # percentile kéo mép thưa vào trong).
    k = min(3, n // 100)
    ordered = np.sort(p, axis=0)
    lo, hi = ordered[k], ordered[n - 1 - k]
    half = np.asarray(box.dims[:2], dtype=np.float64) / 2.0
    others = np.zeros((0, 2)) if blind is None or len(blind) == 0 else np.asarray(blind, dtype=np.float64)[:, :2] @ rot.T

    def cut(a: int, edge: float, outward: float) -> bool:
        b = 1 - a
        beyond = (others[:, a] - edge) * outward
        # Bỏ 15 cm sát mặt: mặt nạ hụt vài pixel ở viền vật là bình thường.
        near = (beyond > 0.15) & (beyond <= BLIND_REACH_M) & (np.abs(others[:, b]) <= half[b] + 0.3)
        if int(near.sum()) >= BLIND_MIN_POINTS:
            return True
        if hidden is None:
            return False
        steps = edge + outward * np.array([0.25, 0.5, 0.75, 1.0]) * BLIND_REACH_M
        across = np.linspace(lo[b], hi[b], 5)
        grid = np.array([(t, u) if a == 0 else (u, t) for t in steps for u in across])
        samples = np.column_stack([grid @ rot, np.zeros(len(grid))])  # về hệ box cũ, giữa chiều cao box
        return float(np.mean(hidden(samples))) >= 0.5

    centre, observed = np.zeros(2), [False, False]
    for a in (0, 1):
        cut_lo, cut_hi = cut(a, lo[a], -1.0), cut(a, hi[a], 1.0)
        if hi[a] - lo[a] >= cfg.full_cover * box.dims[a] and not (cut_lo or cut_hi):
            centre[a], observed[a] = (lo[a] + hi[a]) / 2.0, True
        elif sensor[a] < lo[a]:
            if not cut_lo:
                centre[a], observed[a] = lo[a] + half[a], True    # mặt nhìn thấy ở phía âm
        elif sensor[a] > hi[a]:
            if not cut_hi:
                centre[a], observed[a] = hi[a] - half[a], True
        elif lo[a] < -half[a] and not cut_lo:
            centre[a], observed[a] = lo[a] + half[a], True    # cảm biến ngang vật: chỉ biết khi vật lòi khỏi mặt box
        elif hi[a] > half[a] and not cut_hi:
            centre[a], observed[a] = hi[a] - half[a], True
    delta = rot.T @ centre
    return FitMeasure(box, n, cameras, (float(delta[0]), float(delta[1])), float(theta), yaw_measured,
                      (observed[0], observed[1]), (float(hi[0] - lo[0]), float(hi[1] - lo[1])), float(occlusion))


def frame_measures(
    boxes: Sequence[Cuboid], points: np.ndarray, sensor_to_world: np.ndarray | None, views: Sequence[CameraView],
    segmenter: PromptSegmenter | None, cfg: BoxFitConfig, min_brightness: float = 0.0,
    targets: Sequence[tuple[int, Cuboid]] | None = None, brightness: dict | None = None,
) -> list[FitMeasure | None]:
    """Đo các box của một frame. `segmenter=None`: chỉ dùng LiDAR (không cần ảnh, pose). `targets` là (vị trí box trong
    `boxes` mà box đo chiếm chỗ, box đo); mặc định mọi keyframe. Đánh giá truyền thêm bản làm lệch của box để đo chung một
    lượt SAM. Kết quả cùng thứ tự `targets`."""
    targets = list(targets) if targets is not None else [(i, b) for i, b in enumerate(boxes) if b.keyframe]
    if segmenter is None:
        return _lidar_measures(boxes, points, targets, cfg)
    result: list[FitMeasure | None] = [None] * len(targets)
    if sensor_to_world is None or not views or not targets:
        return result
    from pointsnap.vision.detector2d import image_brightness

    cache = brightness if brightness is not None else {}
    for v in views:
        if v.path not in cache:
            cache[v.path] = image_brightness(v.path)
    light = [cache[v.path] for v in views]
    if float(np.median(light)) < min_brightness:
        return result  # frame ban đêm: SAM và màu ảnh kém tin cậy
    views = [v for v, b in zip(views, light) if b >= min_brightness]
    pts = np.asarray(points, dtype=np.float64)[:, :3]
    mat = np.asarray(sensor_to_world, dtype=np.float64)
    to_world = lambda p: p @ mat[:3, :3].T + mat[:3, 3]  # noqa: E731
    cloud = OtherBoxPoints(pts, boxes)
    centres = {j: to_world(np.median(pts[cloud.inside_indices(j)], axis=0)[None])
               for j in range(len(boxes)) if len(cloud.inside_indices(j)) >= 3}
    per_view = []
    for view in views:
        projections = [project_box(b, mat, view) for b in boxes]
        centre_pix = {}
        for j, w in centres.items():
            pix, depth = project_points(w, view)
            if depth[0] > 0.5:
                centre_pix[j] = (pix[0], float(depth[0]))
        per_view.append((projections, centre_pix))

    candidates: dict[int, _Candidates] = {}
    requests: dict[int, list[tuple[int, Prompt, np.ndarray, float, list]]] = defaultdict(list)
    for k, (slot, box) in enumerate(targets):
        cand = candidate_points(cloud, slot, box, cfg)
        if len(cand.index) < cfg.min_points:
            continue
        candidates[k] = cand
        world = to_world(pts[cand.index])
        blocker_world = to_world(pts[cand.blockers])
        for v, view in enumerate(views):
            proj = project_box(box, mat, view)
            if proj is not None and (proj.inside_ratio < cfg.min_inside or proj.depth > cfg.max_depth_m):
                continue
            pixels, depth = project_points(world, view)
            pixels = np.where((depth > 0.5)[:, None], pixels, np.nan)
            if proj is None:
                proj = _seed_projection(pixels, depth, cand.seed, view)
            if proj is None or proj.box[3] - proj.box[1] < cfg.min_box_px:
                continue
            blocker_pix, blocker_depth = project_points(blocker_world, view)
            blocker_pix = np.where((blocker_depth > 0.5)[:, None], blocker_pix, np.nan)
            projections, centre_pix = per_view[v]
            others = [p for j, p in centre_pix.items() if j != slot]
            nearer = [p.box for j, p in enumerate(projections) if j != slot and p is not None and p.depth < proj.depth - 0.5]
            prompt = _prompt(proj, view, pixels, depth, cand.seed, (blocker_pix, blocker_depth), others, cfg)
            requests[v].append((k, prompt, depth, covered_fraction(proj.box, nearer), nearer))

    lifted = {k: np.zeros(len(c.index), dtype=bool) for k, c in candidates.items()}
    seen = {k: np.zeros(len(c.index), dtype=bool) for k, c in candidates.items()}
    used: dict[int, list[tuple[CameraView, list]]] = defaultdict(list)  # ảnh đã dùng và khung các box gần hơn
    cameras: dict[int, list[str]] = defaultdict(list)
    occlusion: dict[int, float] = defaultdict(lambda: 1.0)
    for v, reqs in requests.items():
        masks = segmenter.segment(views[v].path, [r[1] for r in reqs])
        for (k, prompt, depth, occluded, nearer), mask in zip(reqs, masks):
            rect = prompt.box
            rect_area = max((rect[2] - rect[0]) * (rect[3] - rect[1]), 1.0)
            if (mask.bbox is None or mask.area > cfg.max_mask_area_ratio * rect_area
                    or iou_2d(mask.bbox, rect) < 0.05 or mask.inside.sum() < 3):
                continue
            box = targets[k][1]
            q = prompt.queries
            with np.errstate(invalid="ignore"):
                seen[k] |= ((q[:, 0] >= 0) & (q[:, 0] < views[v].width) & (q[:, 1] >= 0) & (q[:, 1] < views[v].height))
            front = float(np.percentile(depth[mask.inside], 5))
            keep = mask.inside & (depth <= front + 1.3 * math.hypot(box.length, box.width) + cfg.depth_slack_m)
            if keep.sum() < 3:
                continue
            lifted[k] |= keep
            used[k].append((views[v], nearer))
            cameras[k].append(views[v].channel)
            occlusion[k] = min(occlusion[k], occluded)

    for k, chosen in lifted.items():
        if chosen.sum() < cfg.min_points:
            continue
        box = targets[k][1]
        cand = candidates[k]
        voxel = max(LIFT_VOXEL_M, LIFT_VOXEL_PER_M * math.hypot(box.center[0], box.center[1]))
        component = np.zeros(len(cand.index), dtype=bool)
        component[np.flatnonzero(chosen)[_largest_component(cand.local[chosen], voxel)]] = True
        sensor_local = to_box_frame(np.zeros((1, 3)), box)[0]
        # Có thể thuộc vật mà cụm không có: điểm không ảnh nào thấy, điểm LiDAR của vật trong box ngoài cụm.
        blind = cand.local[(~seen[k] | cand.seed) & ~component]
        result[k] = fit_measure(box, cand.local[component], sensor_local, tuple(cameras[k]), occlusion[k], cfg,
                                blind=blind, hidden=_hidden_fn(box, mat, used[k]))
    return result


def _lidar_measures(boxes: Sequence[Cuboid], points: np.ndarray, targets: Sequence[tuple[int, Cuboid]],
                    cfg: BoxFitConfig) -> list[FitMeasure | None]:
    """Chế độ `lidar`: điểm của vật là điểm ứng viên nối liền với các điểm trong box (như `fit.outside`)."""
    result: list[FitMeasure | None] = [None] * len(targets)
    if not targets:
        return result
    cloud = OtherBoxPoints(np.asarray(points, dtype=np.float64)[:, :3], boxes)
    for k, (slot, box) in enumerate(targets):
        cand = candidate_points(cloud, slot, box, cfg)
        if len(cand.index) < cfg.min_points:
            continue
        local = cand.local[connected_to_box(cand.local, np.asarray(box.dims) / 2.0)]
        result[k] = fit_measure(box, local, to_box_frame(np.zeros((1, 3)), box)[0], (), 0.0, cfg)
    return result


def _hidden_fn(box: Cuboid, sensor_to_world: np.ndarray, used: Sequence[tuple[CameraView, list]]):
    """Hàm (điểm hệ box) → bool: không ảnh nào trong `used` thấy điểm (ngoài ảnh, sau camera, hoặc rơi vào khung chiếu
    của box gần camera hơn)."""
    c, s = math.cos(box.yaw), math.sin(box.yaw)
    rot = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])

    def hidden(local: np.ndarray) -> np.ndarray:
        world = (local @ rot.T + np.asarray(box.center)) @ sensor_to_world[:3, :3].T + sensor_to_world[:3, 3]
        visible = np.zeros(len(local), dtype=bool)
        for view, nearer in used:
            pix, depth = project_points(world, view)
            with np.errstate(invalid="ignore"):
                ok = ((depth > 0.5) & (pix[:, 0] >= 0) & (pix[:, 0] < view.width) & (pix[:, 1] >= 0)
                      & (pix[:, 1] < view.height))
            for x1, y1, x2, y2 in nearer:
                ok &= ~((pix[:, 0] >= x1) & (pix[:, 0] <= x2) & (pix[:, 1] >= y1) & (pix[:, 1] <= y2))
            visible |= ok
        return ~visible

    return hidden


def collect_fit_measures(cuboids: Sequence[Cuboid], frames, segmenter: PromptSegmenter | None, cfg: BoxFitConfig,
                         min_brightness: float = 0.0, *, missing_camera: list[int] | None = None) -> list[FitMeasure]:
    """Đo keyframe nhìn thấy; thiếu ảnh/pose ở frame nào thì dùng LiDAR và ghi frame đó vào `missing_camera`."""
    measures: list[FitMeasure] = []
    for frame, boxes in group_by_frame(c for c in cuboids if c.visible).items():
        if not any(b.keyframe for b in boxes):
            continue
        data = frames.frame_data(frame)
        views = list(frames.camera_views(frame)) if segmenter is not None else []
        use_segmenter = segmenter
        if segmenter is not None and (not views or data.sensor_to_world is None):
            use_segmenter = None
            if missing_camera is not None:
                missing_camera.append(frame)
        measures.extend(m for m in frame_measures(boxes, data.points, data.sensor_to_world, views, use_segmenter, cfg,
                                                  min_brightness) if m is not None)
    return measures


def _track_key(box: Cuboid):
    return ("track", box.track_id, box.label) if box.track_id is not None else ("shape", id(box))


def _references(measures: Sequence[FitMeasure]) -> dict[int, tuple[np.ndarray, float] | None]:
    """Trung vị (độ lệch tâm, góc) của các frame **khác** cùng track; mỗi phép đo cần ≥ 2 frame đủ bằng chứng."""
    by_track: dict[object, list[FitMeasure]] = defaultdict(list)
    for m in measures:
        by_track[_track_key(m.box)].append(m)
    refs: dict[int, tuple[np.ndarray, float] | None] = {}
    for m in measures:
        others = [o for o in by_track[_track_key(m.box)] if o.box.frame != m.box.frame]
        offsets = [o.delta_local for o in others if all(o.observed)]
        angles = [math.degrees(o.delta_yaw) for o in others if o.yaw_measured]
        refs[id(m)] = (None if len(others) < 2 else
                       (np.median(offsets, axis=0) if len(offsets) >= 2 else np.zeros(2),
                        math.radians(median_axis_degrees(angles)) if len(angles) >= 2 else 0.0))
    return refs


AXIS_NAMES = ("dọc", "ngang")
"""Trục x / y của box: dọc thân vật, ngang thân vật."""


def _axes_text(delta: np.ndarray, observed: Sequence[bool]) -> tuple[str, str]:
    """("ngang 42 cm, dọc 10 cm", câu nói trục chưa đủ bằng chứng)."""
    parts = [f"{AXIS_NAMES[a]} {abs(delta[a]) * 100:.0f} cm" for a in (1, 0) if observed[a] and abs(delta[a]) >= 0.05]
    missing = [AXIS_NAMES[a] for a in (0, 1) if not observed[a]]
    note = f" Chưa đủ bằng chứng theo chiều {' / '.join(missing)} thân vật." if missing else ""
    return ", ".join(parts), note


def track_dims(cuboids: Sequence[Cuboid]) -> dict[object, list[tuple[int, tuple[float, float, float]]]]:
    """(frame, kích thước) của các keyframe nhìn thấy theo track, để so kích thước một box với các frame khác."""
    out: dict[object, list[tuple[int, tuple[float, float, float]]]] = defaultdict(list)
    for c in cuboids:
        if c.visible and c.keyframe and c.track_id is not None:
            out[_track_key(c)].append((c.frame, tuple(float(v) for v in c.dims)))
    return out


def size_off_track(box: Cuboid, dims_by_track, abs_m: float, rel: float, min_others: int = 2) -> tuple[int, float] | None:
    """(trục, cạnh box − trung vị các frame khác) nếu dài / rộng box lệch trung vị các keyframe khác cùng track quá
    max(`abs_m`, `rel` × trung vị) (ngưỡng Cảnh báo của `size.in_track`); `None` nếu không lệch hoặc track quá ngắn."""
    others = [d for f, d in dims_by_track.get(_track_key(box), []) if f != box.frame]
    if len(others) < min_others:
        return None
    median = np.median(np.asarray(others), axis=0)
    worst = None
    for a in (0, 1):
        diff = float(box.dims[a] - median[a])
        if abs(diff) > max(abs_m, rel * float(median[a])) and (worst is None or abs(diff) > abs(worst[1])):
            worst = (a, diff)
    return worst


GATE_INTERP_M, GATE_INTERP_DEG, GATE_MAX_GAP, GATE_MIN_NEIGHBOURS = 0.4, 5.0, 3, 2
"""Kiểm tra theo track (`quiet_rules`): box lệch vị trí nội suy từ keyframe trước / sau cùng track ≤ 0,4 m (hướng ≤ 5°),
trong vòng 3 frame, và ≥ 2 keyframe lân cận đo được lệch dưới nửa ngưỡng Cảnh báo, tự dự đoán đúng vị trí / hướng box."""


def box_to_world(box: Cuboid, sensor_to_world: np.ndarray) -> Cuboid:
    """Box trong hệ toàn cục: đổi tâm và chiếu trục dài đã quay lên XY để lấy yaw (core không lưu roll/pitch)."""
    pose = np.asarray(sensor_to_world, dtype=np.float64)
    centre = pose[:3, :3] @ np.asarray(box.center, dtype=np.float64) + pose[:3, 3]
    heading = pose[:3, :3] @ np.array([math.cos(box.yaw), math.sin(box.yaw), 0.0])
    return box.replace(center=tuple(float(v) for v in centre), yaw=math.atan2(heading[1], heading[0]))


@dataclass(frozen=True)
class TrackEvidence:
    """Một keyframe khác cùng track: box trong hệ toàn cục, độ lệch tâm (m) và lệch trục (°, modulo 90) đo được nếu đủ
    điểm (`None` nếu không đo được). Độ lệch tâm chỉ xác nhận khi cả hai trục đều có bằng chứng."""

    frame: int
    box: Cuboid
    offset_m: float | None
    yaw_deg: float | None


def quiet_rules(box_world: Cuboid, others: Sequence[TrackEvidence], cfg: BoxFitConfig) -> set[str]:
    """Luật (`fit.offset`, `fit.yaw`) nên bỏ qua cho box này vì phép đo nhiều khả năng sai, không phải box sai.

    Box khớp vị trí nội suy từ keyframe trước và sau, và hai keyframe đo lệch nhỏ tự dự đoán đúng vị trí / hướng đó:
    độ lệch lớn chỉ ở frame này thường do vật bị che một phần (cụm điểm chỉ còn một đoạn vật; job 104 track 1013: xe đỗ
    bị xe chạy ngang che, báo dời 1,8 m trong khi frame 27–28 đo 0,1–0,2 m). Box lệch ở một frame thì không
    khớp nội suy; box lệch đều cả track thì các frame lân cận cũng đo ra lệch."""
    f = box_world.frame
    before = [o for o in others if f - GATE_MAX_GAP <= o.frame < f]
    after = [o for o in others if f < o.frame <= f + GATE_MAX_GAP]
    if not before or not after:
        return set()
    if len({o.frame for o in before + after}) != len(before) + len(after):
        return set()  # nhiều box cùng track/frame: bằng chứng mâu thuẫn, không bỏ cảnh báo

    def deviation(prev: TrackEvidence, nxt: TrackEvidence) -> tuple[float, float]:
        t = (f - prev.frame) / (nxt.frame - prev.frame)
        p0, p1 = np.asarray(prev.box.center[:2]), np.asarray(nxt.box.center[:2])
        dev = float(np.hypot(*(np.asarray(box_world.center[:2]) - (p0 + t * (p1 - p0)))))
        yaw = prev.box.yaw + t * normalize_angle(nxt.box.yaw - prev.box.yaw)
        return dev, abs(math.degrees(normalize_angle(box_world.yaw - yaw)))

    dev, turn = deviation(max(before, key=lambda o: o.frame), min(after, key=lambda o: o.frame))
    near = before + after
    quiet: set[str] = set()

    def supports(rule: str) -> bool:
        # Không dùng frame đang bị che làm bằng chứng phủ quyết frame đã nhìn rõ. Hai frame đo tốt phải tự dự đoán
        # đúng box đích; chỉ đếm hai số nhỏ sẽ bỏ sót một đoạn track bị dời nhưng bên trong vẫn khớp nội suy.
        values = [(o, o.offset_m if rule == "fit.offset" else o.yaw_deg) for o in near]
        limit = (cfg.offset_warning_m if rule == "fit.offset" else cfg.yaw_warning_deg) / 2
        clear = [o for o, value in values if value is not None and math.isfinite(value) and 0 <= value <= limit]
        if len({o.frame for o in clear}) < GATE_MIN_NEIGHBOURS:
            return False
        left, right = [o for o in clear if o.frame < f], [o for o in clear if o.frame > f]
        if left and right:
            pair = max(left, key=lambda o: o.frame), min(right, key=lambda o: o.frame)
        else:
            pair = sorted(clear, key=lambda o: abs(o.frame - f))[:2]
        support_dev, support_turn = deviation(*pair)
        return support_dev <= GATE_INTERP_M if rule == "fit.offset" else support_turn <= GATE_INTERP_DEG

    if dev <= GATE_INTERP_M and supports("fit.offset"):
        quiet.add("fit.offset")
    if turn <= GATE_INTERP_DEG and supports("fit.yaw"):
        quiet.add("fit.yaw")
    return quiet


def track_gate(cuboids: Sequence[Cuboid], measures: Sequence[FitMeasure], poses: Mapping[int, np.ndarray | None],
               cfg: BoxFitConfig, size_check: Callable[[Cuboid], tuple[int, float] | None] | None = None,
               ) -> Callable[[FitMeasure], set[str]]:
    """Hàm `gate(measure) → luật bỏ qua` cho `box_fit_findings` (`quiet_rules` trên các keyframe nhìn thấy của job).
    `poses`: frame → ma trận LiDAR → toàn cục; frame không có pose thì không kiểm tra. Box có kích thước lệch track
    (`size_check`) vẫn báo `fit.offset`: box phóng to giữ tâm nên khớp nội suy dù sai."""
    measured = {(_track_key(m.box), m.box.frame): m for m in measures
                if m.box.track_id is not None and m.num_points >= cfg.min_points}
    evidence: dict[object, list[TrackEvidence]] = defaultdict(list)
    for b in cuboids:
        pose = poses.get(b.frame)
        if b.track_id is None or not (b.visible and b.keyframe) or pose is None:
            continue
        m = measured.get((_track_key(b), b.frame))
        evidence[_track_key(b)].append(TrackEvidence(
            b.frame, box_to_world(b, pose), m.offset_m if m is not None and all(m.observed) else None,
            abs(wrap90(math.degrees(m.delta_yaw))) if m is not None and m.yaw_measured else None))

    def gate(m: FitMeasure) -> set[str]:
        pose = poses.get(m.box.frame)
        if m.box.track_id is None or pose is None:
            return set()
        others = [e for e in evidence.get(_track_key(m.box), []) if e.frame != m.box.frame]
        quiet = quiet_rules(box_to_world(m.box, pose), others, cfg)
        if "fit.offset" in quiet and size_check is not None and size_check(m.box) is not None:
            quiet.discard("fit.offset")
        return quiet

    return gate


def box_fit_findings(measures: Sequence[FitMeasure], cfg: BoxFitConfig, offset: bool = True,
                     yaw: bool = True, size_check: Callable[[Cuboid], tuple[int, float] | None] | None = None,
                     gate: Callable[[FitMeasure], set[str]] | None = None) -> list[Finding]:
    """Mỗi box tối đa một mục `fit.offset` và một mục `fit.yaw`; người dùng sửa tay trong CVAT theo khung tham chiếu
    (`details.proposed_*`, chỉ đổi phần bị báo) rồi Save.

    `size_check(box)`: kích thước box lệch các frame khác của track (`size_off_track`). Khi đó lệch mặt nhìn thấy có thể do
    box dư / thiếu chứ không phải box lệch: vẫn báo `fit.offset` nhưng không đề xuất dời tâm (dời sẽ làm box tệ hơn, đo trên
    nuScenes: mọi box phóng to bị dời sai), chỉ ra cạnh cần chỉnh.

    `gate(measure)`: luật bỏ qua theo track (`track_gate`)."""
    refs = _references(measures) if cfg.reference == "track" else {}
    findings: list[Finding] = []
    for m in measures:
        ref = refs.get(id(m))
        # Trục chưa thấy được có độ lệch bằng 0 để giữ nguyên vị trí, không phải phép đo tâm bằng 0.
        # Trừ trung vị ở frame này sẽ tạo ra một đề xuất dời theo trục hoàn toàn chưa có bằng chứng.
        delta = np.asarray(m.delta_local) - (ref[0] if ref is not None and all(m.observed) else 0.0)
        dyaw = math.radians(wrap90(math.degrees(m.delta_yaw - (ref[1] if ref is not None else 0.0))))
        cams = ", ".join(dict.fromkeys(m.cameras))
        source = "Ảnh camera + LiDAR" if cams else "LiDAR"
        evidence = f"{m.num_points} điểm LiDAR thuộc mặt nạ SAM trên {cams}" if cams else f"{m.num_points} điểm LiDAR của vật"
        relative = " so với các frame khác của track" if ref is not None else ""
        details = {
            "delta_local": [float(delta[0]), float(delta[1])], "delta_yaw_deg": math.degrees(dyaw),
            "cameras": list(dict.fromkeys(m.cameras)), "num_points": m.num_points, "observed_axes": list(m.observed),
            "extent": list(m.extent), "occlusion": m.occlusion, "reference": "track" if ref is not None else "absolute",
            "source": "sam" if cams else "lidar",
        }
        shift = float(np.hypot(*delta))
        quiet = gate(m) if gate is not None else set()
        turn = yaw and m.yaw_measured and abs(math.degrees(dyaw)) > cfg.yaw_warning_deg and "fit.yaw" not in quiet
        move = offset and shift > cfg.offset_warning_m and "fit.offset" not in quiet
        size = size_check(m.box) if move and size_check is not None else None
        if size is not None:
            details["size_off_track"] = {"axis": AXIS_NAMES[size[0]], "diff_m": size[1]}
            move = False  # không dời tâm khi kích thước đang lệch track
            findings.append(Finding(
                error_type=ErrorType.FIT, rule="fit.offset", severity=Severity.WARNING, frame=m.box.frame,
                label=m.box.label, track_id=m.box.track_id, source_id=m.box.source_id, value=shift,
                threshold=cfg.offset_warning_m,
                message=(f"{source}: tâm vật lệch {shift:.2f} m so với box, nhưng chiều {AXIS_NAMES[size[0]]} của box "
                         f"{'dài' if size[1] > 0 else 'ngắn'} hơn các frame khác của track {abs(size[1]) * 100:.0f} cm (theo "
                         f"{evidence}). Chỉnh kích thước trước rồi quét lại; không đề xuất dời tâm."),
                details=dict(details),
            ))
        if move or turn:
            # Box tham chiếu chỉ đổi phần bị báo: lệch dưới ngưỡng là nhiễu đo (~0,1–0,2 m), áp vào sẽ làm box đúng tệ đi.
            proposed = m.proposed((float(delta[0]), float(delta[1])) if move else (0.0, 0.0), dyaw if turn else 0.0)
            details.update({"proposed_center": [float(v) for v in proposed.center], "proposed_yaw": float(proposed.yaw)})
        if move:
            severity = Severity.ERROR if shift > cfg.offset_error_m else Severity.WARNING
            axes, note = _axes_text(delta, m.observed)
            findings.append(Finding(
                error_type=ErrorType.FIT, rule="fit.offset", severity=severity, frame=m.box.frame, label=m.box.label,
                track_id=m.box.track_id, source_id=m.box.source_id, value=shift,
                threshold=cfg.offset_error_m if severity is Severity.ERROR else cfg.offset_warning_m,
                message=(f"{source}: tâm vật lệch {shift:.2f} m so với box{relative} ({axes}), theo {evidence}.{note} "
                         f"Kéo box theo khung tham chiếu (giữ kích thước) rồi Save trong CVAT."
                         + ("" if cams else " Chỉ LiDAR không phân biệt box lệch với box to hơn vật: nhìn mặt xa của vật "
                                            "trước khi kéo, box dư thì thu kích thước.")),
                details=details,
            ))
        deg = abs(math.degrees(dyaw))
        if turn:
            severity = Severity.ERROR if deg > cfg.yaw_error_deg else Severity.WARNING
            findings.append(Finding(
                error_type=ErrorType.HEADING, rule="fit.yaw", severity=severity, frame=m.box.frame,
                label=m.box.label, track_id=m.box.track_id, source_id=m.box.source_id, value=deg,
                threshold=cfg.yaw_error_deg if severity is Severity.ERROR else cfg.yaw_warning_deg,
                message=(f"{source}: trục vật lệch {deg:.0f}° so với hướng box{relative}, theo {evidence}. Xoay box "
                         f"{math.degrees(dyaw):+.0f}° theo khung tham chiếu rồi Save trong CVAT; phép đo này không xác "
                         f"định đầu / đuôi xe."),
                details=details,
            ))
    return findings
