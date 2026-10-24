"""Đọc và kiểm tra cấu hình.

Cấu hình mặc định nằm ở `pointsnap/config.yaml`. File người dùng (`--config`) chỉ cần chứa phần muốn
đổi: nó được trộn đè lên mặc định. Khóa lạ bị báo lỗi ngay để tránh gõ sai tên ngưỡng mà không biết.
"""

from __future__ import annotations

import dataclasses
import math
import os
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any, Mapping

import yaml

DIMENSIONS = ("length", "width", "height")


class ConfigError(ValueError):
    """Cấu hình sai: thiếu khóa, sai kiểu, khóa lạ hoặc ngưỡng mâu thuẫn."""


@dataclass(frozen=True)
class CvatConfig:
    url: str
    flag_attribute: str
    token: str | None = None


@dataclass(frozen=True)
class RulesConfig:
    floating: bool = True
    size_class_range: bool = True
    size_in_track: bool = True
    heading_flip: bool = True
    heading_motion: bool = True
    heading_points: bool = True
    fit_empty: bool = True
    fit_outside: bool = True
    fit_loose: bool = False
    fit_overlap: bool = True
    attr_height: bool = True
    spec_inside: bool = True
    spec_rider_double: bool = True
    attr_rider_state: bool = True
    cam_sparse: bool = True
    lidar_missing: bool = True
    attr_missing: bool = True
    attr_invalid: bool = True
    heading_static: bool = True
    cam_mismatch: bool = True
    cam_class: bool = True
    cam_missing: bool = True
    critic_box: bool = True
    fit_offset: bool = False
    fit_yaw: bool = False
    cam_face: bool = False


@dataclass(frozen=True)
class FloatingConfig:
    classes: tuple[str, ...]
    warning_m: float
    error_m: float
    ring_inner_m: float
    ring_outer_m: float
    min_ground_points: int
    # Luật so với track (`detect_floating_scene`, A10); mặc định để code cũ tạo FloatingConfig vẫn chạy.
    error_min_abs_m: float = 0.15
    single_warning_m: float = 0.15
    single_error_m: float = 0.30
    min_track_boxes: int = 2
    sweeps: int = 0
    """Số lượt quét LiDAR trung gian gộp thêm trước keyframe để đo mặt đất (C1, mặt đất v2); 0 = chỉ keyframe."""
    single_box: bool = False
    """So |d| tuyệt đối cho box lẻ / track có ít hơn `min_track_boxes` box khác đo được. Tắt thì chỉ so theo track."""
    ground_tolerance_m: float = 0.05
    """Sàn dung sai: bỏ qua khi lệch so với trung vị track (hoặc |d| của box lẻ) <= ground_tolerance_m."""


@dataclass(frozen=True)
class ClassRangeConfig:
    percentile_low: float
    percentile_high: float
    warning_margin: float
    error_margin: float
    min_instances: int
    stats: Mapping[str, Mapping[str, tuple[float, float]]] = dataclasses.field(default_factory=dict)
    """Khoảng [p_low, p_high] của từng class theo `length`, `width`, `height`."""


@dataclass(frozen=True)
class InTrackConfig:
    min_keyframes: int
    excluded_classes: tuple[str, ...]
    warning_abs_m: float
    warning_rel: float
    error_abs_m: float
    error_rel: float
    suspect_id_rel: float


@dataclass(frozen=True)
class SizeConfig:
    class_range: ClassRangeConfig
    manual_ranges: Mapping[str, Mapping[str, tuple[float, float]]]
    in_track: InTrackConfig
    key_attributes: Mapping[str, str] = dataclasses.field(default_factory=dict)
    """Class → thuộc tính phân loại chi tiết (spec 3.1.2, vd `Vehicle: subtype`): khoảng kích thước tra theo khóa
    `Class/giá trị` (vd `Vehicle/bus`), không có thì theo `Class`."""
    cargo_classes: tuple[str, ...] = ("motorcycle", "bicycle", "Two-wheels", "Vehicle/Tricycle")
    """Class hay chở hàng cồng kềnh (C5): "lớn bất thường" mà điểm LiDAR phủ kín chiều đó thì hạ Lỗi xuống Cảnh báo.
    Ghi `Class` hoặc `Class/thuộc tính`."""


@dataclass(frozen=True)
class TrackConfig:
    keyframe_interval_s: float
    """Khoảng thời gian giữa hai keyframe liền nhau (giây): dùng khi thiếu timestamp thật để đổi frame sang vận tốc."""


@dataclass(frozen=True)
class HeadingGroupConfig:
    classes: tuple[str, ...]
    min_speed_mps: float
    """Chỉ so hướng box với hướng chuyển động khi vật chạy nhanh hơn mức này."""
    motion_warning_deg: float
    motion_error_deg: float
    flip_warning_deg: float
    flip_error_deg: float
    yaw_rate_max_dps: float
    """Tốc độ quay tối đa hợp lý (độ / giây): hướng đổi chậm hơn mức này giữa hai keyframe không bị coi là lật."""
    reverse_max_mps: float = 0.0
    """Box ngược chiều chuyển động ở gần hết đoạn mà vật chạy không nhanh hơn mức này: có thể đang lùi thật → Cảnh báo
    thay vì Lỗi (C5). 0 = không xét."""


@dataclass(frozen=True)
class HeadingPointsConfig:
    classes: tuple[str, ...]
    min_points: int
    min_aspect: float
    warning_deg: float
    error_deg: float
    max_range_m: float


def _default_heading_groups() -> dict[str, HeadingGroupConfig]:
    return {
        "vehicle": HeadingGroupConfig(("car", "truck", "bus", "trailer", "construction_vehicle"),
                                      2.0, 60.0, 135.0, 45.0, 75.0, 60.0, 3.0),
        "two_wheeler": HeadingGroupConfig(("motorcycle", "bicycle"), 1.5, 60.0, 135.0, 45.0, 75.0, 90.0),
        "pedestrian": HeadingGroupConfig(("pedestrian",), 1.0, 90.0, 150.0, 120.0, 170.0, 180.0),
    }


@dataclass(frozen=True)
class HeadingConfig:
    """Sai hướng box (C1, spec 4.2: hướng box trùng hướng chuyển động chính; đứng yên thì theo trục dài)."""

    groups: Mapping[str, HeadingGroupConfig] = dataclasses.field(default_factory=_default_heading_groups)
    min_motion_m: float = 1.0
    """Quãng đường tối thiểu giữa hai keyframe lân cận để ước lượng hướng chuyển động."""
    points: HeadingPointsConfig = dataclasses.field(default_factory=lambda: HeadingPointsConfig(
        ("car", "truck", "bus", "trailer"), 60, 1.6, 12.0, 30.0, 40.0))

    def group_for(self, label: str) -> HeadingGroupConfig | None:
        for group in self.groups.values():
            if label in group.classes:
                return group
        return None


@dataclass(frozen=True)
class FitConfig:
    """Box vẽ lệch khỏi vật (C1, spec 4.2: bao trọn vật thể, không dư thừa quá mức; không gán box khi quá ít điểm)."""

    empty_max_points: int = 0
    """Box có số điểm LiDAR (cao hơn đáy box) <= mức này, không đánh `occluded`, là box rỗng: Cảnh báo."""
    sparse_warning_points: int = 0
    """Box có ít điểm hơn mức này: Cảnh báo "quá ít điểm" (spec 4.2). 0 = tắt, đợi chốt P-009."""
    outside_margin_m: float = 0.5
    outside_margin_rel: float = 0.25
    """Vùng xét nới mỗi phía max(`outside_margin_m`, `outside_margin_rel` × cạnh box): xe dài thò ra xa hơn."""
    outside_min_points: int = 15
    outside_min_object_points: int = 30
    """`fit.outside` chỉ xét vật có ít nhất chừng này điểm (trước đây dùng chung `outside_min_points`)."""
    outside_warning_ratio: float = 0.4
    outside_error_ratio: float = 0.7
    ground_clearance_m: float = 0.25
    loose_min_points: int = 40
    loose_max_range_m: float = 30.0
    loose_warning_m: float = 0.4
    loose_error_m: float = 1.0
    loose_rise_m: float = 0.3
    """`fit.loose`: mặt dư hơn trung vị các frame khác của track quá mức này (m) mới báo."""
    overlap_warning: float = 0.2
    overlap_error: float = 0.5
    overlap_classes: tuple[str, ...] = (
        "car", "truck", "bus", "trailer", "construction_vehicle", "motorcycle", "bicycle", "pedestrian",
    )
    """Chỉ xét chồng box giữa hai class trong danh sách này (vật cản nhỏ như cọc tiêu, rào chắn hay đặt sát nhau)."""
    overlap_allowed_pairs: tuple[tuple[str, str], ...] = (
        ("pedestrian", "pedestrian"), ("pedestrian", "bicycle"), ("pedestrian", "motorcycle"),
        ("pedestrian", "car"), ("pedestrian", "truck"), ("pedestrian", "construction_vehicle"),
        ("bicycle", "bicycle"), ("motorcycle", "motorcycle"), ("bicycle", "motorcycle"), ("truck", "trailer"), ("car", "trailer"), ("construction_vehicle", "trailer"),
    )


@dataclass(frozen=True)
class StaticConfig:
    """Vật đứng yên: box xoay lệch giữa các keyframe trong hệ toàn cục (C3, lớp 1 của Box Verifier)."""

    max_spread_m: float = 0.10
    """Các keyframe còn lại của track tụ trong khoảng này (p90, hệ toàn cục) thì coi vật đứng yên."""
    min_keyframes: int = 4
    yaw_warning_deg: float = 4.0
    yaw_error_deg: float = 10.0
    yaw_excluded_classes: tuple[str, ...] = ("pedestrian", "Pedestrian", "Animal", "traffic_cone")
    """Người, động vật đứng yên vẫn xoay người; vật tròn / đối xứng (cọc tiêu) hướng box không có nghĩa: không xét hướng.
    Ghi `Class` hoặc `Class/giá trị thuộc tính` (vd `Obstacle/traffic cone`)."""


def _default_camera_groups() -> dict[str, tuple[str, ...]]:
    return {
        "vehicle": ("car", "truck", "bus", "trailer", "construction_vehicle", "Vehicle"),
        "two_wheeler": ("motorcycle", "bicycle", "Two-wheels"),
        "person": ("pedestrian", "Pedestrian"),
        "animal": ("Animal",),
        "traffic_cone": ("traffic_cone",),
        "barrier": ("barrier",),
    }


@dataclass(frozen=True)
class CameraConfig:
    """Đối chiếu box 3D với ảnh camera (C3, lớp 2 của Box Verifier; cần PyTorch, `pip install -e ".[vision]"`)."""

    enabled: str = "auto"
    """`auto`: chạy khi có PyTorch + GPU (CPU chạy được nhưng chậm); `true` / `false`: bật / tắt hẳn."""
    model: str = "maskrcnn"
    """Model ảnh (`vision.detector2d`): `maskrcnn` (Mask R-CNN COCO), `gdino-sam2` (Grounding DINO + SAM 2.1, nhận diện
    theo từ khóa, có thêm cọc tiêu / rào chắn; cần `transformers`) hoặc `hybrid` (Mask R-CNN, cộng Grounding DINO cho
    cọc tiêu / rào chắn)."""
    min_score: float = 0.5
    min_inside: float = 0.85
    max_depth_m: float = 50.0
    min_box_px: float = 25.0
    max_occlusion: float = 0.3
    min_track_observations: int = 2
    min_brightness: float = 90.0
    """Frame có trung vị độ sáng các ảnh camera (xám 0–255) dưới mức này thì bỏ qua: model COCO kém tin cậy ban đêm.
    Trên nuScenes mini: frame ngày 100–114, frame đêm 20–88."""
    min_mask_iou: float = 0.05
    """Vật trên ảnh phải chồng khung chiếu ít nhất chừng này (IoU) mới coi là cùng vật; không thì bỏ (model 2D sót vật)."""
    mask_rise_warning: float = 0.2
    """`cam.mismatch`: tỉ lệ mặt nạ vật nằm ngoài khung chiếu cao hơn trung vị các frame khác của track quá mức này."""
    mismatch_severity: str = "info"
    """Mức của `cam.mismatch`: `info` (mặc định, bằng chứng phụ) hoặc `warning`. Đo trên nuScenes: bật ở mức Cảnh báo chỉ
    bắt thêm 4/400 lỗi chèn mà tăng báo nhầm 0,24 (tuning) / 0,75 (test) trên 100 box."""
    class_min_observations: int = 3
    class_vote: float = 0.6
    class_min_score: float = 0.7
    missing_min_score: float = 0.85
    missing_min_px: float = 40.0
    missing_min_points: int = 15
    sparse_max_points: int = 5
    """`cam.sparse` (C8, spec 4.2): vật có ≤ chừng này điểm LiDAR ở mọi keyframe mà ảnh camera không thấy → Thông tin."""
    groups: Mapping[str, tuple[str, ...]] = dataclasses.field(default_factory=_default_camera_groups)
    """Nhóm vật trên ảnh (person / two_wheeler / vehicle / animal / traffic_cone / barrier) → các class nhãn 3D thuộc
    nhóm đó. Nhóm model ảnh không nhận được (Mask R-CNN: cọc tiêu, rào chắn) thì bỏ qua."""

    def group_of(self, label: str) -> str | None:
        for group, labels in self.groups.items():
            if label in labels:
                return group
        return None

    def tracked_groups(self) -> set[str]:
        return {g for g, labels in self.groups.items() if labels}

    def active(self, backend: str = "detector2d") -> bool:
        if self.enabled == "false":
            return False
        if backend != "detector2d":
            from pointsnap.vision import face_clip, prompted_sam

            if backend not in ("face", "sam"):
                raise ValueError(f"Unknown camera backend: {backend}")
            available = face_clip.available if backend == "face" else prompted_sam.available
            if not available():
                return False
            if self.enabled == "true":
                return True
            import torch

            return bool(torch.cuda.is_available())
        from pointsnap.vision import detector2d

        if self.enabled == "true":
            return detector2d.available(self.effective_model())
        return detector2d.cuda_available(self.effective_model())

    def effective_model(self) -> str:
        """Model ảnh thực dùng: `hybrid` lùi về `maskrcnn` khi máy chưa cài `transformers` (cùng ngưỡng, chỉ mất phần cọc
        tiêu); `gdino-sam2` thì không lùi vì ngưỡng của nó khác thang điểm Mask R-CNN."""
        from pointsnap.vision import detector2d

        if self.model == "hybrid" and not detector2d.available("hybrid"):
            return "maskrcnn"
        return self.model


@dataclass(frozen=True)
class BoxFitConfig:
    """Box lệch / xoay lệch vật, đo bằng mét / độ (`detectors.box_fit`, luật `fit.offset`, `fit.yaw`): chọn điểm LiDAR của
    vật quanh box rồi fit lại box (giữ kích thước).

    `source: sam` dùng chung `camera.enabled` (cần PyTorch + `transformers`) và `camera.min_brightness`."""

    source: str = "lidar"
    """Cách chọn điểm của vật: `lidar` (điểm nối liền với box; không cần camera / GPU, chạy trên mọi task) hoặc `sam`
    (mặt nạ SAM 2.1 trên ảnh camera, prompt từ box + LiDAR; cần ảnh + calibration, GPU). Trên nuScenes mini `sam` bắt
    nhiều hơn mà báo nhầm chỉ bằng ⅓ `lidar` (docs/ket-qua/ket-qua-box-fit.md); ngưỡng mặc định là của `lidar`, dùng
    `guidelines/box-fit-sam.yaml` cho `sam`."""
    search_margin_m: float = 1.2
    """Tìm điểm của vật trong box nới mỗi phía chừng này (box lệch 1 m vẫn còn vật trong vùng tìm)."""
    ground_clearance_m: float = 0.25
    """Bỏ điểm thấp hơn mặt đất cục bộ + chừng này (vật thấp: tối đa 30% chiều cao)."""
    min_inside: float = 0.2
    """Chỉ dùng ảnh mà khung chiếu box nằm trong ảnh ít nhất chừng này (xe lớn ở gần trải qua nhiều camera: mỗi ảnh chỉ
    chứa một phần, điểm ngoài ảnh không xét, các ảnh gộp lại)."""
    max_depth_m: float = 50.0
    min_box_px: float = 20.0
    prompt_expand: float = 0.1
    """Nới khung prompt mỗi phía chừng này × cạnh khung chiếu."""
    max_mask_area_ratio: float = 3.0
    """Mặt nạ lớn hơn chừng này × khung prompt (SAM cắt nhầm nền, tòa nhà) thì bỏ ảnh đó."""
    depth_slack_m: float = 0.5
    min_points: int = 30
    """Cần ít nhất chừng này điểm LiDAR của vật mới đo."""
    full_cover: float = 0.85
    """Điểm của vật phủ ≥ chừng này cạnh box thì canh giữa; ít hơn thì canh mặt gần cảm biến."""
    yaw_min_points: int = 40
    yaw_min_aspect: float = 1.5
    yaw_classes: tuple[str, ...] = ("car", "truck", "bus", "trailer", "construction_vehicle", "Vehicle")
    offset_warning_m: float = 1.0
    offset_error_m: float = 2.5
    yaw_warning_deg: float = 15.0
    yaw_error_deg: float = 25.0
    reference: str = "absolute"
    """`absolute`: so độ lệch tuyệt đối; `track`: trừ trung vị độ lệch các frame khác của track (bỏ sai số ổn định
    theo vật) khi track có ≥ 2 frame khác đo được."""


@dataclass(frozen=True)
class FaceConfig:
    """Box ngược đầu cả track, hỏi ảnh camera "đầu xe hay đuôi xe" (`detectors.face`, luật `cam.face`). Dùng chung
    `camera.enabled` (cần PyTorch + `transformers`) và `camera.min_brightness`."""

    classes: tuple[str, ...] = ("car", "bus", "Vehicle")
    """Xe tải, xe công trình: CLIP gần như đoán mò (AUC 0,58 / 0,27 trên cảnh tinh chỉnh), không xét."""
    min_inside: float = 0.7
    """Chỉ dùng ảnh chứa gần trọn khung chiếu box (xe bị mép ảnh cắt mất đầu / đuôi thì không hỏi)."""
    max_depth_m: float = 40.0
    min_box_px: float = 40.0
    """Khung chiếu cao ít nhất chừng này pixel."""
    max_view_deg: float = 60.0
    """Camera nằm trong góc này quanh trục đầu (đuôi) box thì coi là nhìn mặt đầu (đuôi); nhìn ngang hơn thì bỏ."""
    max_occlusion: float = 0.3
    """Bỏ ảnh mà khung chiếu bị box gần hơn che quá chừng này."""
    front_min: float = 0.6
    """Phiếu "ảnh thấy đầu xe": xác suất đầu xe ≥ chừng này."""
    rear_max: float = 0.15
    """Phiếu "ảnh thấy đuôi xe": xác suất đầu xe ≤ chừng này. Hai ngưỡng riêng vì CLIP nghiêng về "đuôi xe" (trung vị
    xác suất đầu xe khi camera thấy đầu xe chỉ ~0,6), chọn trên cảnh tinh chỉnh."""
    min_votes: int = 2
    """Cần ít nhất chừng này phiếu chắc chắn nói ngược."""
    vote_ratio: float = 0.75
    """... và chiếm ≥ chừng này số phiếu chắc chắn của track."""
    error_votes: int = 4
    """≥ chừng này phiếu ngược thì báo mức Lỗi."""


@dataclass(frozen=True)
class EvidenceConfig:
    """Box có quá ít điểm LiDAR thì người duyệt không kiểm được trên point cloud: hạ finding xuống mức Thông tin."""

    min_points: int = 0
    """Ít hơn chừng này điểm của vật trong box (frame của finding) thì không kết luận; 0 = tắt."""
    rules: tuple[str, ...] = ("floating", "size.class_range")


@dataclass(frozen=True)
class MissingConfig:
    """Sót đối tượng bằng LiDAR (C7, `detectors.missing`; spec 4.2 NÊN gán vật rõ trong point cloud)."""

    min_range_m: float = 3.0
    max_range_m: float = 40.0
    box_margin_m: float = 0.3
    """Bỏ điểm trong box nhãn nới chừng này."""
    cell_m: float = 0.25
    min_points: int = 15
    min_points_per_cell: float = 1.2
    """Mật độ điểm / ô của cụm: nhiễu mưa, bụi ~1; mặt vật thật bị nhiều tia LiDAR quét chồng nên dày hơn."""
    max_bottom_m: float = 0.6
    """Chân cụm (p2 độ cao trên mặt đất) không cao hơn mức này: vật đứng trên đường, không phải tán cây / biển báo."""
    max_elevation_m: float = 1.5
    """Chân cụm cao hơn mặt đất chung của frame (mặt phẳng khớp trên điểm thấp) quá mức này thì bỏ: mái che, tầng nhà,
    thùng xe trên cao. Mặt đất cục bộ (`max_bottom_m`) lấy điểm thấp nhất quanh cụm nên bị lừa khi đất bên dưới bị che."""
    max_persistence: float = 0.4
    """Tỉ lệ ô của cụm vẫn có điểm sau / trước 1 giây quá mức này thì coi là vật đứng yên (tường, cây, cột): bỏ."""
    first_gate_m: float = 7.0
    link_gate_m: float = 2.0
    min_frames: int = 3
    min_motion_m: float = 3.0
    min_motion_person_m: float = 1.5
    """Cụm cỡ người đi chậm: dời ≥ mức này nhưng cần thêm 1 keyframe."""
    static_min_persistence: float = 0.2
    """Nhánh vật đứng yên: cụm có tỉ lệ ô còn bị chiếm sau / trước 1 s lớn hơn mức này."""
    static_gate_m: float = 1.0
    """Vật đứng yên: tâm cụm các keyframe cách tâm chung ≤ mức này (phần nhìn thấy đổi theo góc nhìn)."""
    static_min_views: int = 2
    """Vật đứng yên chỉ báo khi ảnh camera thấy vật cùng loại ở ≥ chừng này keyframe."""
    static_min_iou: float = 0.5
    """Phần khung chiếu của cụm nằm trong khung vật trên ảnh (LiDAR thường chỉ thấy một mặt nên không dùng IoU)."""
    static_min_score: float = 0.7
    static_labelled_iou: float = 0.5
    """Vật trên ảnh trùng khung chiếu của box đã gán (IoU) từ mức này thì coi là vật đã có box."""
    keyframe_interval_s: float = 0.5


@dataclass(frozen=True)
class CriticConfig:
    """Box Critic do nhóm tự huấn luyện (C3, lớp 3; `docs/huong-dan/huan-luyen-box-critic.md`). `model` rỗng thì không chạy."""

    model: str = ""
    """Đường dẫn file TorchScript (.pt)."""
    min_points: int = 20
    min_probability: float = 0.7
    error_probability: float = 0.9
    """Box không thuộc track (shape): báo theo xác suất sai thô ≥ `min_probability` / `error_probability`."""
    min_logit_rise: float = 4.4
    error_logit_rise: float = 6.0
    """Box thuộc track: logit "box sai" cao hơn trung vị các frame khác của track quá mức này thì báo Cảnh báo / Lỗi.
    Đo trên cảnh để riêng scene-0916: 4.4 ≈ 0,5% box chuẩn bị báo, 6.0 < 0,3%."""


@dataclass(frozen=True)
class LearningConfig:
    """Dùng kết luận của người duyệt (C3, lớp 4): độ tin cậy luôn hiện; hạ mức chỉ khi bật `adjust_severity`."""

    adjust_severity: bool = False
    downgrade_below: float = 0.15
    """Mục Cảnh báo có độ tin cậy dưới mức này (và luật đã có đủ kết luận) thì hạ xuống Thông tin."""
    min_rule_reviews: int = 20


@dataclass(frozen=True)
class SpecConfig:
    """Thuộc tính bắt buộc và giá trị cho phép theo spec của dự án (C2, spec 3.1.2–3.1.3)."""

    required_attributes: Mapping[str, tuple[str, ...]] = dataclasses.field(default_factory=dict)
    """Class → các thuộc tính bắt buộc, vd `Vehicle: [subtype]`."""
    allowed_values: Mapping[str, tuple[str, ...]] = dataclasses.field(default_factory=dict)
    """Thuộc tính (hoặc `Class.thuộc_tính`) → các giá trị cho phép."""
    attribute_height: Mapping[str, tuple[float, float]] = dataclasses.field(default_factory=dict)
    """`attr.height` (C6): `Class/giá trị[/giá trị…]` → [min, max] chiều cao box (m), vd `Pedestrian/standing/adult`.
    Khóa khớp khi box mang đủ các giá trị; nhiều khóa khớp thì lấy khóa cụ thể nhất."""
    inside_forbidden: tuple[tuple[str, str], ...] = ()
    """`spec.inside` (C6, spec 4.3B): cặp [vật bên trong, vật bao] không được gán lồng nhau, vd [Pedestrian, Vehicle]."""
    inside_min_lift_m: float = 0.6
    """Đáy vật bên trong cao hơn đáy vật bao từ mức này trở lên (đứng trên nóc / thùng xe) thì không tính là bên trong."""
    rider_double: tuple[tuple[str, str], ...] = ()
    """`spec.rider_double` (C6, spec 4.3C): cặp [box đã gồm người lái, box người], vd [Two-wheels/with_rider, Pedestrian]."""
    rider_state: Mapping[str, str] = dataclasses.field(default_factory=dict)
    """`attr.rider_state` (C8, spec 4.3C): khóa xe → thuộc tính trạng thái người lái, gồm `class`, `attribute`,
    `with`, `without`, `person` (class người). Rỗng thì không chạy."""
    rider_max_speed_mps: float = 2.5
    """Xe `without` chạy nhanh hơn mức này ở ≥ 2 bước liền: có người lái mà quên đổi (dắt xe ~1,3 m/s)."""


@dataclass(frozen=True)
class GateConfig:
    max_errors: int
    max_warnings: int


@dataclass(frozen=True)
class Config:
    cvat: CvatConfig
    floating: FloatingConfig
    size: SizeConfig
    track: TrackConfig
    gate: GateConfig
    rules: RulesConfig = dataclasses.field(default_factory=RulesConfig)
    heading: HeadingConfig = dataclasses.field(default_factory=HeadingConfig)
    fit: FitConfig = dataclasses.field(default_factory=FitConfig)
    spec: SpecConfig = dataclasses.field(default_factory=SpecConfig)
    static: StaticConfig = dataclasses.field(default_factory=StaticConfig)
    camera: CameraConfig = dataclasses.field(default_factory=CameraConfig)
    box_fit: BoxFitConfig = dataclasses.field(default_factory=BoxFitConfig)
    face: FaceConfig = dataclasses.field(default_factory=FaceConfig)
    learning: LearningConfig = dataclasses.field(default_factory=LearningConfig)
    critic: CriticConfig = dataclasses.field(default_factory=CriticConfig)
    missing: MissingConfig = dataclasses.field(default_factory=MissingConfig)
    evidence: EvidenceConfig = dataclasses.field(default_factory=EvidenceConfig)

    def to_dict(self, redact: bool = True) -> dict[str, Any]:
        """Dạng dict thuần (list thay cho tuple) để in hoặc lưu kèm báo cáo. Mặc định ẩn token."""
        data = _plain(dataclasses.asdict(self))
        if redact and data["cvat"].get("token"):
            data["cvat"]["token"] = "***"
        return data


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def _is_finite(value: int | float) -> bool:
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


class _Reader:
    """Đọc một mục YAML, kiểm kiểu từng khóa, báo lỗi nếu còn khóa lạ."""

    def __init__(self, data: Any, path: str) -> None:
        if not isinstance(data, Mapping):
            raise ConfigError(f"'{path}' phải là một mục (mapping), nhận {type(data).__name__}")
        self._data = dict(data)
        self._path = path

    def _take(self, key: str) -> Any:
        if key not in self._data:
            raise ConfigError(f"Thiếu khóa '{self._path}.{key}'")
        return self._data.pop(key)

    def number(self, key: str, minimum: float | None = None) -> float:
        value = self._take(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ConfigError(f"'{self._path}.{key}' phải là số, nhận {value!r}")
        if not _is_finite(value):
            raise ConfigError(f"'{self._path}.{key}' phải là số hữu hạn, nhận {value!r}")
        if minimum is not None and value < minimum:
            raise ConfigError(f"'{self._path}.{key}' phải >= {minimum}, nhận {value}")
        return float(value)

    def integer(self, key: str, minimum: int | None = None) -> int:
        value = self._take(key)
        if isinstance(value, bool) or not isinstance(value, int):
            raise ConfigError(f"'{self._path}.{key}' phải là số nguyên, nhận {value!r}")
        if minimum is not None and value < minimum:
            raise ConfigError(f"'{self._path}.{key}' phải >= {minimum}, nhận {value}")
        return value

    def boolean(self, key: str) -> bool:
        value = self._take(key)
        if not isinstance(value, bool):
            raise ConfigError(f"'{self._path}.{key}' phải là true/false, nhận {value!r}")
        return value

    def string(self, key: str) -> str:
        value = self._take(key)
        if not isinstance(value, str) or not value:
            raise ConfigError(f"'{self._path}.{key}' phải là chuỗi khác rỗng, nhận {value!r}")
        return value

    def strings(self, key: str) -> tuple[str, ...]:
        value = self._take(key)
        if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
            raise ConfigError(f"'{self._path}.{key}' phải là danh sách chuỗi, nhận {value!r}")
        return tuple(value)

    def min_max(self, key: str) -> tuple[float, float]:
        value = self._take(key)
        if (not isinstance(value, list) or len(value) != 2
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and _is_finite(v)
                           for v in value)):
            raise ConfigError(f"'{self._path}.{key}' phải là [min, max], nhận {value!r}")
        _require_order(f"{self._path}.{key}", value[0], value[1], "min", "max")
        return float(value[0]), float(value[1])

    def section(self, key: str) -> _Reader:
        return _Reader(self._take(key), f"{self._path}.{key}")

    def keys(self) -> list[str]:
        return list(self._data)

    def discard(self, *keys: str) -> None:
        """Bỏ qua khóa của bản cấu hình cũ đã ngừng dùng, để guideline lưu từ trước vẫn tải được."""
        for key in keys:
            self._data.pop(key, None)

    def finish(self) -> None:
        if self._data:
            extra = ", ".join(f"'{self._path}.{k}'" for k in self._data)
            raise ConfigError(f"Khóa không hợp lệ: {extra}")


def _require_order(path: str, low: float, high: float, low_name: str, high_name: str) -> None:
    if not low < high:
        raise ConfigError(f"'{path}': cần {low_name} < {high_name}, nhận {low} và {high}")


def _parse_cvat(r: _Reader, env: Mapping[str, str]) -> CvatConfig:
    url = r.string("url")
    flag_attribute = r.string("flag_attribute")
    if "token" in r.keys():
        raise ConfigError("Không ghi token CVAT trong file cấu hình; đặt biến môi trường CVAT_TOKEN")
    r.finish()
    return CvatConfig(url=url, flag_attribute=flag_attribute, token=env.get("CVAT_TOKEN") or None)


_LEGACY_RULES = ("track_jump", "track_split_id", "track_long_interpolation", "track_reuse_id", "track_occluded_long",
                 "track_id_swap", "track_static_shift")
"""Luật đứt track đã gỡ bỏ: guideline lưu từ trước còn khóa này thì bỏ qua thay vì báo khóa lạ."""


def _parse_rules(r: _Reader) -> RulesConfig:
    r.discard(*_LEGACY_RULES)
    cfg = RulesConfig(
        floating=r.boolean("floating"),
        size_class_range=r.boolean("size_class_range"),
        size_in_track=r.boolean("size_in_track"),
        **{name: r.boolean(name) for name in _NEW_RULES if name in r.keys()},
    )
    r.finish()
    return cfg


_NEW_RULES = ("heading_flip", "heading_motion", "heading_points", "fit_empty", "fit_outside", "fit_loose",
              "fit_overlap", "attr_height", "spec_inside",
              "spec_rider_double", "attr_rider_state", "lidar_missing",
              "cam_sparse", "attr_missing", "attr_invalid",
              "heading_static", "cam_mismatch", "cam_class", "cam_missing",
              "critic_box", "fit_offset", "fit_yaw", "cam_face")
"""Luật thêm ở giai đoạn 3: file cấu hình cũ không có thì coi là bật."""


def _parse_heading(r: _Reader) -> HeadingConfig:
    gr = r.section("groups")
    groups: dict[str, HeadingGroupConfig] = {}
    seen: dict[str, str] = {}
    for name in gr.keys():
        g = gr.section(name)
        group = HeadingGroupConfig(
            classes=g.strings("classes"),
            min_speed_mps=g.number("min_speed_mps", 0.0),
            motion_warning_deg=g.number("motion_warning_deg", 0.0),
            motion_error_deg=g.number("motion_error_deg", 0.0),
            flip_warning_deg=g.number("flip_warning_deg", 0.0),
            flip_error_deg=g.number("flip_error_deg", 0.0),
            yaw_rate_max_dps=g.number("yaw_rate_max_dps", 0.0),
            reverse_max_mps=g.number("reverse_max_mps", 0.0) if "reverse_max_mps" in g.keys() else 0.0,
        )
        g.finish()
        for low, high in (("motion_warning_deg", "motion_error_deg"), ("flip_warning_deg", "flip_error_deg")):
            _require_order(f"heading.groups.{name}", getattr(group, low), getattr(group, high), low, high)
            if getattr(group, high) > 180:
                raise ConfigError(f"'heading.groups.{name}.{high}' phải <= 180")
        for label in group.classes:
            if label in seen:
                raise ConfigError(f"Class '{label}' nằm trong cả nhóm '{seen[label]}' và '{name}' của heading")
            seen[label] = name
        groups[name] = group
    gr.finish()
    pr = r.section("points")
    points = HeadingPointsConfig(
        classes=pr.strings("classes"),
        min_points=pr.integer("min_points", 3),
        min_aspect=pr.number("min_aspect", 1.0),
        warning_deg=pr.number("warning_deg", 0.0),
        error_deg=pr.number("error_deg", 0.0),
        max_range_m=pr.number("max_range_m", 0.0),
    )
    pr.finish()
    _require_order("heading.points", points.warning_deg, points.error_deg, "warning_deg", "error_deg")
    if points.error_deg > 45:
        raise ConfigError("'heading.points.error_deg' phải <= 45 (lệch trục chỉ đo được trong khoảng 0–45°)")
    cfg = HeadingConfig(groups=groups, min_motion_m=r.number("min_motion_m", 0.0), points=points)
    r.finish()
    return cfg


def _parse_static(r: _Reader) -> StaticConfig:
    r.discard("shift_warning_m", "shift_error_m")  # ngưỡng của luật track.static_shift đã gỡ bỏ
    cfg = StaticConfig(
        max_spread_m=r.number("max_spread_m", 0.0),
        min_keyframes=r.integer("min_keyframes", 3),
        yaw_warning_deg=r.number("yaw_warning_deg", 0.0),
        yaw_error_deg=r.number("yaw_error_deg", 0.0),
        yaw_excluded_classes=r.strings("yaw_excluded_classes"),
    )
    r.finish()
    _require_order("static", cfg.yaw_warning_deg, cfg.yaw_error_deg, "yaw_warning_deg", "yaw_error_deg")
    if cfg.yaw_error_deg > 90:
        raise ConfigError("'static.yaw_error_deg' phải <= 90")
    return cfg


def _parse_camera(r: _Reader) -> CameraConfig:
    enabled = r._take("enabled")
    enabled = {True: "true", False: "false"}.get(enabled, enabled)
    if enabled not in ("auto", "true", "false"):
        raise ConfigError(f"'camera.enabled' phải là auto, true hoặc false, nhận {enabled!r}")
    numbers = {name: r.number(name, 0.0) for name in (
        "min_score", "min_inside", "max_depth_m", "min_box_px", "max_occlusion", "min_brightness", "min_mask_iou",
        "mask_rise_warning", "class_vote", "class_min_score", "missing_min_score", "missing_min_px")}
    integers = {name: r.integer(name, 1) for name in (
        "min_track_observations", "class_min_observations", "missing_min_points")}
    model = r._take("model") if "model" in r.keys() else "maskrcnn"
    if model not in ("maskrcnn", "gdino-sam2", "hybrid"):
        raise ConfigError(f"'camera.model' phải là maskrcnn, gdino-sam2 hoặc hybrid, nhận {model!r}")
    if "sparse_max_points" in r.keys():
        integers["sparse_max_points"] = r.integer("sparse_max_points", 0)
    severity = r._take("mismatch_severity") if "mismatch_severity" in r.keys() else "info"
    if severity not in ("info", "warning"):
        raise ConfigError(f"'camera.mismatch_severity' phải là info hoặc warning, nhận {severity!r}")
    gr = r.section("groups")
    groups = {name: gr.strings(name) for name in gr.keys()}
    gr.finish()
    r.finish()
    return CameraConfig(enabled=enabled, model=model, groups=groups, mismatch_severity=severity, **numbers, **integers)


def _parse_box_fit(r: _Reader) -> BoxFitConfig:
    """Mọi khóa đều tùy chọn: thiếu khóa nào thì dùng mặc định của `BoxFitConfig`."""
    base = BoxFitConfig()
    values: dict[str, Any] = {}
    for f in dataclasses.fields(BoxFitConfig):
        if f.name not in r.keys():
            continue
        default = getattr(base, f.name)
        if f.name in ("reference", "source"):
            value = r.string(f.name)
            allowed = ("absolute", "track") if f.name == "reference" else ("lidar", "sam")
            if value not in allowed:
                raise ConfigError(f"'box_fit.{f.name}' phải là {' hoặc '.join(allowed)}, nhận {value!r}")
            values[f.name] = value
        elif isinstance(default, tuple):
            values[f.name] = r.strings(f.name)
        elif isinstance(default, int):
            values[f.name] = r.integer(f.name, 1)
        else:
            values[f.name] = r.number(f.name, 0.0)
    r.finish()
    if values.get("full_cover", base.full_cover) > 1.0 or values.get("min_inside", base.min_inside) > 1.0:
        raise ConfigError("'box_fit.full_cover' và 'box_fit.min_inside' phải trong [0, 1]")
    _require_order("box_fit.offset_warning_m", values.get("offset_warning_m", base.offset_warning_m),
                   values.get("offset_error_m", base.offset_error_m), "offset_warning_m", "offset_error_m")
    _require_order("box_fit.yaw_warning_deg", values.get("yaw_warning_deg", base.yaw_warning_deg),
                   values.get("yaw_error_deg", base.yaw_error_deg), "yaw_warning_deg", "yaw_error_deg")
    return BoxFitConfig(**values)


def _parse_face(r: _Reader) -> FaceConfig:
    """Mọi khóa đều tùy chọn: thiếu khóa nào thì dùng mặc định của `FaceConfig`."""
    base = FaceConfig()
    values: dict[str, Any] = {}
    for f in dataclasses.fields(FaceConfig):
        if f.name not in r.keys():
            continue
        default = getattr(base, f.name)
        if isinstance(default, tuple):
            values[f.name] = r.strings(f.name)
        elif isinstance(default, int):
            values[f.name] = r.integer(f.name, 1)
        else:
            values[f.name] = r.number(f.name, 0.0)
    r.finish()
    for name in ("min_inside", "front_min", "rear_max", "vote_ratio"):
        if values.get(name, getattr(base, name)) > 1.0:
            raise ConfigError(f"'face.{name}' phải trong [0, 1]")
    if values.get("rear_max", base.rear_max) >= values.get("front_min", base.front_min):
        raise ConfigError("'face.rear_max' phải nhỏ hơn 'face.front_min'")
    if values.get("max_view_deg", base.max_view_deg) > 90.0:
        raise ConfigError("'face.max_view_deg' phải trong [0, 90]")
    _require_order("face.min_votes", values.get("min_votes", base.min_votes),
                   values.get("error_votes", base.error_votes), "min_votes", "error_votes")
    return FaceConfig(**values)


def _parse_missing(r: _Reader) -> MissingConfig:
    values = {}
    for f in dataclasses.fields(MissingConfig):
        if f.name not in r.keys():
            continue
        values[f.name] = r.integer(f.name, 1) if f.type in ("int", int) else r.number(f.name, 0.0)
    r.finish()
    return MissingConfig(**values)


def _parse_evidence(r: _Reader) -> EvidenceConfig:
    cfg = EvidenceConfig(
        min_points=r.integer("min_points", 0) if "min_points" in r.keys() else EvidenceConfig.min_points,
        rules=r.strings("rules") if "rules" in r.keys() else EvidenceConfig.rules,
    )
    r.finish()
    return cfg


def _parse_critic(r: _Reader) -> CriticConfig:
    model = r._take("model")
    if not isinstance(model, str):
        raise ConfigError(f"'critic.model' phải là đường dẫn (chuỗi, để trống nếu chưa có), nhận {model!r}")
    cfg = CriticConfig(model=model, min_points=r.integer("min_points", 1),
                       min_probability=r.number("min_probability", 0.0),
                       error_probability=r.number("error_probability", 0.0),
                       min_logit_rise=r.number("min_logit_rise", 0.0),
                       error_logit_rise=r.number("error_logit_rise", 0.0))
    r.finish()
    _require_order("critic", cfg.min_probability, cfg.error_probability, "min_probability", "error_probability")
    _require_order("critic", cfg.min_logit_rise, cfg.error_logit_rise, "min_logit_rise", "error_logit_rise")
    return cfg


def _parse_learning(r: _Reader) -> LearningConfig:
    cfg = LearningConfig(adjust_severity=r.boolean("adjust_severity"), downgrade_below=r.number("downgrade_below", 0.0),
                         min_rule_reviews=r.integer("min_rule_reviews", 1))
    r.finish()
    if cfg.downgrade_below >= 1:
        raise ConfigError("'learning.downgrade_below' phải < 1")
    return cfg


def _parse_spec(r: _Reader) -> SpecConfig:
    def rider_state() -> dict[str, str]:
        if "rider_state" not in r.keys():
            return {}
        section = r.section("rider_state")
        keys = set(section.keys())
        if not keys:
            return {}
        expected = {"class", "attribute", "with", "without", "person"}
        if keys != expected:
            raise ConfigError("'spec.rider_state' phải có đúng class, attribute, with, without, person")
        result = {key: section.string(key) for key in expected}
        section.finish()
        if any(not value.strip() for value in result.values()) or result["with"] == result["without"]:
            raise ConfigError("'spec.rider_state' phải có giá trị không rỗng và with khác without")
        return result

    def mapping_of_lists(key: str) -> dict[str, tuple[str, ...]]:
        if key not in r.keys():
            return {}
        section = r.section(key)
        result = {name: section.strings(name) for name in section.keys()}
        section.finish()
        return result

    def pairs(key: str) -> tuple[tuple[str, str], ...]:
        if key not in r.keys():
            return ()
        raw = r._take(key)
        if (not isinstance(raw, list) or not all(isinstance(p, list) and len(p) == 2
                                                 and all(isinstance(v, str) and v for v in p) for p in raw)):
            raise ConfigError(f"'spec.{key}' phải là danh sách cặp [a, b], nhận {raw!r}")
        return tuple((a, b) for a, b in raw)

    heights: dict[str, tuple[float, float]] = {}
    if "attribute_height" in r.keys():
        hr = r.section("attribute_height")
        heights = {key: hr.min_max(key) for key in hr.keys()}
        hr.finish()
    cfg = SpecConfig(required_attributes=mapping_of_lists("required_attributes"),
                     allowed_values=mapping_of_lists("allowed_values"), attribute_height=heights,
                     inside_forbidden=pairs("inside_forbidden"),
                     inside_min_lift_m=r.number("inside_min_lift_m", 0.0) if "inside_min_lift_m" in r.keys() else 0.6,
                     rider_double=pairs("rider_double"),
                     rider_state=rider_state(),
                     rider_max_speed_mps=(r.number("rider_max_speed_mps", 0.0) if "rider_max_speed_mps" in r.keys()
                                          else 2.5))
    r.finish()
    return cfg


def _parse_fit(r: _Reader) -> FitConfig:
    pairs_raw = r._take("overlap_allowed_pairs")
    if (not isinstance(pairs_raw, list)
            or not all(isinstance(p, list) and len(p) == 2 and all(isinstance(v, str) and v for v in p)
                       for p in pairs_raw)):
        raise ConfigError(f"'fit.overlap_allowed_pairs' phải là danh sách cặp class [a, b], nhận {pairs_raw!r}")
    cfg = FitConfig(
        empty_max_points=r.integer("empty_max_points", 0),
        sparse_warning_points=r.integer("sparse_warning_points", 0),
        outside_margin_m=r.number("outside_margin_m", 0.0),
        outside_margin_rel=r.number("outside_margin_rel", 0.0),
        outside_min_points=r.integer("outside_min_points", 1),
        outside_min_object_points=(r.integer("outside_min_object_points", 1) if "outside_min_object_points" in r.keys()
                                   else FitConfig.outside_min_object_points),
        outside_warning_ratio=r.number("outside_warning_ratio", 0.0),
        outside_error_ratio=r.number("outside_error_ratio", 0.0),
        ground_clearance_m=r.number("ground_clearance_m", 0.0),
        loose_min_points=r.integer("loose_min_points", 1),
        loose_max_range_m=r.number("loose_max_range_m", 0.0),
        loose_warning_m=r.number("loose_warning_m", 0.0),
        loose_error_m=r.number("loose_error_m", 0.0),
        loose_rise_m=r.number("loose_rise_m", 0.0) if "loose_rise_m" in r.keys() else FitConfig.loose_rise_m,
        overlap_warning=r.number("overlap_warning", 0.0),
        overlap_error=r.number("overlap_error", 0.0),
        overlap_classes=r.strings("overlap_classes"),
        overlap_allowed_pairs=tuple((a, b) for a, b in pairs_raw),
    )
    r.finish()
    for low, high in (("outside_warning_ratio", "outside_error_ratio"), ("loose_warning_m", "loose_error_m"),
                      ("overlap_warning", "overlap_error")):
        _require_order("fit", getattr(cfg, low), getattr(cfg, high), low, high)
    if cfg.outside_error_ratio > 1 or cfg.overlap_error > 1:
        raise ConfigError("'fit.outside_error_ratio' và 'fit.overlap_error' phải <= 1")
    return cfg


def _parse_floating(r: _Reader) -> FloatingConfig:
    cfg = FloatingConfig(
        classes=r.strings("classes"),
        warning_m=r.number("warning_m", 0.0),
        error_m=r.number("error_m", 0.0),
        error_min_abs_m=r.number("error_min_abs_m", 0.0),
        single_warning_m=r.number("single_warning_m", 0.0),
        single_error_m=r.number("single_error_m", 0.0),
        min_track_boxes=r.integer("min_track_boxes", 1),
        ring_inner_m=r.number("ring_inner_m", 0.0),
        ring_outer_m=r.number("ring_outer_m", 0.0),
        min_ground_points=r.integer("min_ground_points", 1),
        **({"sweeps": r.integer("sweeps", 0)} if "sweeps" in r.keys() else {}),
        **({"single_box": r.boolean("single_box")} if "single_box" in r.keys() else {}),
        **({"ground_tolerance_m": r.number("ground_tolerance_m", 0.0)} if "ground_tolerance_m" in r.keys() else {}),
    )
    r.finish()
    _require_order("floating", cfg.warning_m, cfg.error_m, "warning_m", "error_m")
    _require_order("floating", cfg.single_warning_m, cfg.single_error_m, "single_warning_m", "single_error_m")
    _require_order("floating", cfg.ground_tolerance_m, cfg.warning_m, "ground_tolerance_m", "warning_m")
    _require_order("floating", cfg.ground_tolerance_m, cfg.single_warning_m, "ground_tolerance_m", "single_warning_m")
    _require_order("floating", cfg.ring_inner_m, cfg.ring_outer_m, "ring_inner_m", "ring_outer_m")
    return cfg


def _parse_size(r: _Reader) -> SizeConfig:
    cr = r.section("class_range")
    percentile_low = cr.number("percentile_low", 0.0)
    percentile_high = cr.number("percentile_high", 0.0)
    warning_margin = cr.number("warning_margin", 0.0)
    error_margin = cr.number("error_margin", 0.0)
    min_instances = cr.integer("min_instances", 1)
    sr = cr.section("stats")
    stats: dict[str, dict[str, tuple[float, float]]] = {}
    for label in sr.keys():
        lr = sr.section(label)
        stats[label] = {dim: lr.min_max(dim) for dim in DIMENSIONS}
        lr.finish()
    sr.finish()
    cr.finish()
    class_range = ClassRangeConfig(
        percentile_low=percentile_low,
        percentile_high=percentile_high,
        warning_margin=warning_margin,
        error_margin=error_margin,
        min_instances=min_instances,
        stats=stats,
    )
    _require_order("size.class_range", class_range.percentile_low, class_range.percentile_high,
                   "percentile_low", "percentile_high")
    if class_range.percentile_high > 100:
        raise ConfigError("'size.class_range.percentile_high' phải <= 100")
    _require_order("size.class_range", class_range.warning_margin, class_range.error_margin,
                   "warning_margin", "error_margin")

    mr = r.section("manual_ranges")
    manual: dict[str, dict[str, tuple[float, float]]] = {}
    for label in mr.keys():
        lr = mr.section(label)
        manual[label] = {dim: lr.min_max(dim) for dim in DIMENSIONS}
        lr.finish()
    mr.finish()

    tr = r.section("in_track")
    in_track = InTrackConfig(
        min_keyframes=tr.integer("min_keyframes", 2),
        excluded_classes=tr.strings("excluded_classes"),
        warning_abs_m=tr.number("warning_abs_m", 0.0),
        warning_rel=tr.number("warning_rel", 0.0),
        error_abs_m=tr.number("error_abs_m", 0.0),
        error_rel=tr.number("error_rel", 0.0),
        suspect_id_rel=tr.number("suspect_id_rel", 0.0),
    )
    tr.finish()
    _require_order("size.in_track", in_track.warning_abs_m, in_track.error_abs_m, "warning_abs_m", "error_abs_m")
    _require_order("size.in_track", in_track.warning_rel, in_track.error_rel, "warning_rel", "error_rel")
    key_attributes: dict[str, str] = {}
    if "key_attributes" in r.keys():
        kr = r.section("key_attributes")
        key_attributes = {label: kr.string(label) for label in kr.keys()}
        kr.finish()
    cargo = r.strings("cargo_classes") if "cargo_classes" in r.keys() else SizeConfig.cargo_classes
    r.finish()
    return SizeConfig(class_range=class_range, manual_ranges=manual, in_track=in_track, key_attributes=key_attributes,
                      cargo_classes=cargo)


def _parse_track(r: _Reader) -> TrackConfig:
    # Ngưỡng của các luật đứt track đã gỡ bỏ; guideline lưu từ trước còn các khóa này thì bỏ qua.
    r.discard("groups", "split_max_gap_frames", "max_occluded_frames", "long_interpolation")
    keyframe_interval_s = r.number("keyframe_interval_s", 0.0)
    if keyframe_interval_s == 0:
        raise ConfigError("'track.keyframe_interval_s' phải > 0")
    cfg = TrackConfig(keyframe_interval_s=keyframe_interval_s)
    r.finish()
    return cfg


def _parse_gate(r: _Reader) -> GateConfig:
    cfg = GateConfig(max_errors=r.integer("max_errors", 0), max_warnings=r.integer("max_warnings", 0))
    r.finish()
    return cfg


def _deep_merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, Mapping) and isinstance(merged.get(key), Mapping):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _read_yaml(text: str, source: str) -> dict[str, Any]:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, 'problem_mark', None)
        location = f' (dòng {mark.line+1}, cột {mark.column+1})' if mark else ''
        raise ConfigError(f"Không đọc được YAML từ {source}{location}") from exc
    if data is None:
        return {}
    if not isinstance(data, Mapping):
        raise ConfigError(f"{source} phải chứa một mapping ở cấp ngoài cùng")
    return dict(data)


def parse_config(data: Mapping[str, Any], env: Mapping[str, str] | None = None) -> Config:
    """Kiểm tra dict cấu hình đầy đủ và trả về `Config`."""
    env = os.environ if env is None else env
    r = _Reader(data, "config")
    cvat = _parse_cvat(r.section("cvat"), env)
    rules = _parse_rules(r.section("rules")) if "rules" in r.keys() else RulesConfig()
    cfg = Config(
        cvat=cvat,
        floating=_parse_floating(r.section("floating")),
        size=_parse_size(r.section("size")),
        track=_parse_track(r.section("track")),
        gate=_parse_gate(r.section("gate")),
        rules=rules,
        heading=_parse_heading(r.section("heading")) if "heading" in r.keys() else HeadingConfig(),
        fit=_parse_fit(r.section("fit")) if "fit" in r.keys() else FitConfig(),
        spec=_parse_spec(r.section("spec")) if "spec" in r.keys() else SpecConfig(),
        static=_parse_static(r.section("static")) if "static" in r.keys() else StaticConfig(),
        camera=_parse_camera(r.section("camera")) if "camera" in r.keys() else CameraConfig(),
        box_fit=_parse_box_fit(r.section("box_fit")) if "box_fit" in r.keys() else BoxFitConfig(),
        face=_parse_face(r.section("face")) if "face" in r.keys() else FaceConfig(),
        learning=_parse_learning(r.section("learning")) if "learning" in r.keys() else LearningConfig(),
        critic=_parse_critic(r.section("critic")) if "critic" in r.keys() else CriticConfig(),
        missing=_parse_missing(r.section("missing")) if "missing" in r.keys() else MissingConfig(),
        evidence=_parse_evidence(r.section("evidence")) if "evidence" in r.keys() else EvidenceConfig(),
    )
    r.finish()
    return cfg


def default_config_text() -> str:
    return resources.files("pointsnap").joinpath("config.yaml").read_text(encoding="utf-8")


def load_config(path: str | Path | None = None, env: Mapping[str, str] | None = None) -> Config:
    """Đọc cấu hình theo thứ tự ưu tiên tăng dần: mặc định → biến môi trường → file `path`.

    `CVAT_URL` ghi đè URL mặc định, nhưng URL ghi rõ trong file `--config` được ưu tiên hơn,
    vì file đó do người dùng chỉ định riêng cho lần chạy này.
    """
    env = os.environ if env is None else env
    data = _read_yaml(default_config_text(), "config.yaml mặc định")
    if env.get("CVAT_URL"):
        data = _deep_merge(data, {"cvat": {"url": env["CVAT_URL"]}})
    if path is not None:
        path = Path(path)
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ConfigError(f"Không mở được file cấu hình {path}: {exc}") from exc
        data = _deep_merge(data, _read_yaml(text, str(path)))
    return parse_config(data, env)
