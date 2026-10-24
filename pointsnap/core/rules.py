"""Danh mục quy tắc kiểm tra chất lượng nhãn 3D (Rule Catalog) tập trung.

Single Source of Truth cho toàn bộ các quy tắc kiểm tra của PointSnap 3D.
Cung cấp định nghĩa, phân loại, nhãn tiếng Việt, mẫu nhận diện thông báo,
và hướng dẫn sửa lỗi (Fix Tips) đồng bộ cho cả Backend, Web UI và CVAT Extension.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any

from pointsnap.core.model import ErrorType, Severity


@dataclass(frozen=True)
class RuleDefinition:
    """Định nghĩa một quy tắc kiểm tra nhãn."""

    id: str
    switch_key: str
    label_vi: str
    error_type: ErrorType
    default_severity: Severity
    fix_tip: str
    patterns: list[str]
    measure_unit: str = ""
    category: str = "general"

    def to_dict(self) -> dict[str, Any]:
        """Xuất dict thân thiện với JSON API."""
        return {
            "id": self.id,
            "switch_key": self.switch_key,
            "label_vi": self.label_vi,
            "error_type": self.error_type.value,
            "default_severity": self.default_severity.value,
            "fix_tip": self.fix_tip,
            "patterns": self.patterns,
            "measure_unit": self.measure_unit,
            "category": self.category,
        }


SINK_FIX_TIP = "Nâng đáy box lên cho chạm mặt đường, đối chiếu ảnh camera trước và các frame lân cận của track."
DEFAULT_FIX_TIP = "Kiểm tra lại bounding box và nhãn trên CVAT theo hướng dẫn gán nhãn của dự án."

RULES_CATALOG: list[RuleDefinition] = [
    # 1. Nhóm Lơ lửng / Lún
    RuleDefinition(
        id="floating",
        switch_key="floating",
        label_vi="Lơ lửng / lún",
        error_type=ErrorType.FLOATING,
        default_severity=Severity.ERROR,
        fix_tip="Hạ đáy box cho chạm mặt đường, đối chiếu ảnh camera trước và các frame lân cận của track.",
        patterns=[r"\((lơ lửng|lún)\)|so với mặt đất"],
        measure_unit="m",
        category="geometry",
    ),
    RuleDefinition(
        id="floating.no_evidence",
        switch_key="floating",
        label_vi="Thiếu bằng chứng mặt đất",
        error_type=ErrorType.FLOATING,
        default_severity=Severity.INFO,
        fix_tip="Không cần sửa. Nếu nghi ngờ, kiểm tra bằng mắt trên ảnh camera.",
        patterns=[r"thiếu bằng chứng"],
        measure_unit="m",
        category="geometry",
    ),

    # 2. Nhóm Kích thước
    RuleDefinition(
        id="size.class_range",
        switch_key="size_class_range",
        label_vi="Kích thước lạ so với class",
        error_type=ErrorType.SIZE,
        default_severity=Severity.WARNING,
        fix_tip="Kiểm tra xem đối tượng có bị gán nhầm class không (ví dụ nhầm car với truck/bus); nếu đúng class thì điều chỉnh kích thước box cho vừa khít vật.",
        patterns=[r"bất thường so với class"],
        measure_unit="m",
        category="geometry",
    ),
    RuleDefinition(
        id="size.in_track",
        switch_key="size_in_track",
        label_vi="Kích thước lệch trong track",
        error_type=ErrorType.SIZE,
        default_severity=Severity.WARNING,
        fix_tip="Kiểm tra kích thước box so với các frame khác của cùng track; điều chỉnh lại box bất thường.",
        patterns=[r"so với trung vị track"],
        measure_unit="ratio",
        category="temporal",
    ),

    # 4. Nhóm Hướng (Heading)
    RuleDefinition(
        id="heading.flip",
        switch_key="heading_flip",
        label_vi="Hướng đổi đột ngột",
        error_type=ErrorType.HEADING,
        default_severity=Severity.ERROR,
        fix_tip="Xoay box về cùng hướng với các keyframe lân cận của track; bật Cuboid orientation và cho mũi tên đỏ chỉ đầu vật.",
        patterns=[r"đổi hướng nhanh bất thường"],
        measure_unit="rad",
        category="geometry",
    ),
    RuleDefinition(
        id="heading.motion",
        switch_key="heading_motion",
        label_vi="Ngược hướng chuyển động",
        error_type=ErrorType.HEADING,
        default_severity=Severity.WARNING,
        fix_tip="Xoay box cho mũi tên đỏ (Cuboid orientation) trùng hướng vật đang chạy (spec 4.2). Xe lùi thật thì bỏ qua.",
        patterns=[r"so với hướng chuyển động"],
        measure_unit="rad",
        category="temporal",
    ),
    RuleDefinition(
        id="heading.points",
        switch_key="heading_points",
        label_vi="Lệch trục cụm điểm",
        error_type=ErrorType.HEADING,
        default_severity=Severity.WARNING,
        fix_tip="Xoay box cho các cạnh song song với thân vật trên point cloud (nhìn từ Top view).",
        patterns=[r"trục của cụm điểm"],
        measure_unit="rad",
        category="geometry",
    ),
    RuleDefinition(
        id="heading.static",
        switch_key="heading_static",
        label_vi="Vật đứng yên: box xoay",
        error_type=ErrorType.HEADING,
        default_severity=Severity.WARNING,
        fix_tip="Vật đứng yên: xoay box về cùng hướng với các keyframe khác của track.",
        patterns=[r"^Vật đứng yên nhưng hướng box"],
        measure_unit="rad",
        category="temporal",
    ),

    # 5. Nhóm Khớp điểm (Fit)
    RuleDefinition(
        id="fit.empty",
        switch_key="fit_empty",
        label_vi="Box rỗng",
        error_type=ErrorType.FIT,
        default_severity=Severity.ERROR,
        fix_tip="Xóa box nếu không có vật; vật bị che khuất tạm thời thì đánh dấu occluded thay vì để box rỗng.",
        patterns=[r"^Box (không có|chỉ có) .*điểm LiDAR"],
        measure_unit="points",
        category="geometry",
    ),
    RuleDefinition(
        id="fit.outside",
        switch_key="fit_outside",
        label_vi="Điểm của vật ngoài box",
        error_type=ErrorType.FIT,
        default_severity=Severity.WARNING,
        fix_tip="Nới hoặc dời box cho bao trọn các điểm của vật (spec 4.2), đối chiếu Top / Side / Front view.",
        patterns=[r"nằm ngoài box"],
        measure_unit="ratio",
        category="geometry",
    ),
    RuleDefinition(
        id="fit.loose",
        switch_key="fit_loose",
        label_vi="Box dư",
        error_type=ErrorType.FIT,
        default_severity=Severity.WARNING,
        fix_tip="Kéo mặt box về sát các điểm của vật ở phía được nhìn rõ, không để dư khoảng trống.",
        patterns=[r"box dư so với vật"],
        measure_unit="ratio",
        category="geometry",
    ),
    RuleDefinition(
        id="fit.overlap",
        switch_key="fit_overlap",
        label_vi="Hai box chồng nhau",
        error_type=ErrorType.FIT,
        default_severity=Severity.ERROR,
        fix_tip="Kiểm tra hai box có cùng là một vật không: vẽ trùng thì xóa box thừa; hai vật sát nhau thì thu box cho khỏi lấn.",
        patterns=[r"^Box chồng .* diện tích"],
        measure_unit="ratio",
        category="geometry",
    ),

    # 6. Nhóm Thuộc tính & Spec
    RuleDefinition(
        id="attr.missing",
        switch_key="attr_missing",
        label_vi="Thiếu thuộc tính",
        error_type=ErrorType.ATTRIBUTE,
        default_severity=Severity.ERROR,
        fix_tip="Chọn giá trị cho thuộc tính bắt buộc; không chắc thì chọn other (spec 3.1.3).",
        patterns=[r"thiếu thuộc tính bắt buộc"],
        category="attribute",
    ),
    RuleDefinition(
        id="attr.invalid",
        switch_key="attr_invalid",
        label_vi="Thuộc tính sai giá trị",
        error_type=ErrorType.ATTRIBUTE,
        default_severity=Severity.ERROR,
        fix_tip="Chọn lại giá trị thuộc tính theo danh sách của guideline dự án.",
        patterns=[r"không có trong danh sách cho phép"],
        category="attribute",
    ),
    RuleDefinition(
        id="attr.height",
        switch_key="attr_height",
        label_vi="Thuộc tính lệch chiều cao",
        error_type=ErrorType.ATTRIBUTE,
        default_severity=Severity.WARNING,
        fix_tip="Xem vật trên point cloud / ảnh: sửa thuộc tính (tư thế, nhóm tuổi, có người lái) hoặc chiều cao box cho khớp.",
        patterns=[r"ngoài khoảng hợp lý .* kiểm tra lại thuộc tính"],
        measure_unit="m",
        category="attribute",
    ),
    RuleDefinition(
        id="attr.rider_state",
        switch_key="attr_rider_state",
        label_vi="Quên đổi trạng thái người lái",
        error_type=ErrorType.ATTRIBUTE,
        default_severity=Severity.WARNING,
        fix_tip="Spec 4.3C: lên xe thì đổi sang with_rider, xuống xe thì đổi sang without_rider (người xuống thành track Pedestrian mới).",
        patterns=[r"(chưa đổi sang|người lái đã xuống xe thì đổi)"],
        category="attribute",
    ),
    RuleDefinition(
        id="spec.inside",
        switch_key="spec_inside",
        label_vi="Người bên trong xe",
        error_type=ErrorType.ATTRIBUTE,
        default_severity=Severity.ERROR,
        fix_tip="Spec 4.3B: không gán người ngồi trong xe — xóa box người (người đứng trên nóc / thùng xe thì giữ).",
        patterns=[r"nằm bên trong box"],
        category="attribute",
    ),
    RuleDefinition(
        id="spec.rider_double",
        switch_key="spec_rider_double",
        label_vi="Người lái bị gán 2 lần",
        error_type=ErrorType.ATTRIBUTE,
        default_severity=Severity.ERROR,
        fix_tip="Spec 4.3C: người lái nằm trong box xe hai bánh — xóa box người; người đã xuống xe thì đổi xe sang without_rider.",
        patterns=[r"đã có người lái \(with_rider\)"],
        category="attribute",
    ),

    # 7. Nhóm Thị giác & LiDAR/Camera
    RuleDefinition(
        id="lidar.missing",
        switch_key="lidar_missing",
        label_vi="Nghi sót đối tượng (LiDAR)",
        error_type=ErrorType.FIT,
        default_severity=Severity.WARNING,
        fix_tip="Mở point cloud tại vị trí trong mục (tâm cụm từng frame): vật thật đang di chuyển mà chưa gán thì vẽ box và track mới (spec 4.2).",
        patterns=[r"mà không có box: nghi sót đối tượng"],
        category="vision",
    ),
    RuleDefinition(
        id="cam.sparse",
        switch_key="cam_sparse",
        label_vi="Box quá ít điểm, ảnh không thấy",
        error_type=ErrorType.FIT,
        default_severity=Severity.WARNING,
        fix_tip="Spec 4.2: không gán vật quá ít điểm. Xem lại point cloud / ảnh các frame khác: không suy luận được vật thì xóa box.",
        patterns=[r"^Vật chỉ có ≤ \d+ điểm LiDAR"],
        category="vision",
    ),
    RuleDefinition(
        id="cam.mismatch",
        switch_key="cam_mismatch",
        label_vi="Box lệch vật trên ảnh",
        error_type=ErrorType.FIT,
        default_severity=Severity.WARNING,
        fix_tip="Mở ảnh camera của frame, so khung box với vật: dời / chỉnh kích thước box cho khớp vật (đối chiếu cả point cloud).",
        patterns=[r"^Box chiếu lên ảnh"],
        category="vision",
    ),
    RuleDefinition(
        id="fit.offset",
        switch_key="fit_offset",
        label_vi="Box lệch vật (đo bằng mét)",
        error_type=ErrorType.FIT,
        default_severity=Severity.WARNING,
        fix_tip="Kéo box theo khung tham chiếu (khớp mặt box nhìn thấy vào điểm của vật, giữ kích thước) rồi Save trong "
                "CVAT; box dư (mặt xa cách vật) thì thu kích thước thay vì dời.",
        patterns=[r"^(Ảnh camera \+ )?LiDAR: tâm vật lệch"],
        measure_unit="m",
        category="geometry",
    ),
    RuleDefinition(
        id="fit.yaw",
        switch_key="fit_yaw",
        label_vi="Box xoay lệch trục vật",
        error_type=ErrorType.HEADING,
        default_severity=Severity.WARNING,
        fix_tip="Trục cụm điểm LiDAR của vật (khớp hình chữ L) lệch hướng box: xoay box theo khung tham chiếu rồi Save "
                "trong CVAT; phép đo này không xác định đầu / đuôi xe.",
        patterns=[r"^(Ảnh camera \+ )?LiDAR: trục vật lệch"],
        measure_unit="°",
        category="geometry",
    ),
    RuleDefinition(
        id="cam.face",
        switch_key="cam_face",
        label_vi="Box ngược đầu cả track (ảnh camera)",
        error_type=ErrorType.HEADING,
        default_severity=Severity.WARNING,
        fix_tip="Ảnh camera thấy đầu xe ở mặt đuôi box (hoặc ngược lại) ở đa số keyframe: mở ảnh các frame trong mục, "
                "đúng là ngược thì quay mọi keyframe của track 180° (hướng đề xuất yaw + 180°).",
        patterns=[r"^Ảnh camera: \d+/\d+ keyframe nhìn rõ thấy mặt ngược"],
        measure_unit="",
        category="vision",
    ),
    RuleDefinition(
        id="cam.class",
        switch_key="cam_class",
        label_vi="Ảnh camera thấy class khác",
        error_type=ErrorType.ATTRIBUTE,
        default_severity=Severity.WARNING,
        fix_tip="Xem vật trên ảnh camera: nhãn sai thì đổi class cho cả track; ảnh nhận nhầm (vật bị che, phản chiếu) thì bỏ qua.",
        patterns=[r"^Ảnh camera nhận vật là"],
        category="vision",
    ),
    RuleDefinition(
        id="cam.missing",
        switch_key="cam_missing",
        label_vi="Ảnh thấy vật chưa có box",
        error_type=ErrorType.FIT,
        default_severity=Severity.WARNING,
        fix_tip="Mở ảnh camera và point cloud của frame: có vật thật mà chưa gán thì vẽ thêm box (spec: gán mọi vật trong vùng quan tâm).",
        patterns=[r"không có box 3D nào"],
        category="vision",
    ),
    RuleDefinition(
        id="critic.box",
        switch_key="critic_box",
        label_vi="Box Critic nghi box sai",
        error_type=ErrorType.FIT,
        default_severity=Severity.WARNING,
        fix_tip="Box Critic nghi box sai: xem gợi ý sửa (dời / kích thước / xoay) trong chi tiết, đối chiếu point cloud rồi chỉnh tay.",
        patterns=[r"^Box Critic:"],
        category="vision",
    ),
]

_RULES_BY_ID: dict[str, RuleDefinition] = {r.id: r for r in RULES_CATALOG}
_RULES_BY_SWITCH: dict[str, RuleDefinition] = {r.switch_key: r for r in RULES_CATALOG}
_COMPILED_PATTERNS: list[tuple[str, re.Pattern]] = [
    (r.id, re.compile(p, re.IGNORECASE))
    for r in RULES_CATALOG
    for p in r.patterns
]


def get_rule(rule_id: str) -> RuleDefinition | None:
    """Lấy định nghĩa quy tắc theo id (`floating`, `track.jump`, ...)."""
    return _RULES_BY_ID.get(rule_id)


def rule_label(rule_id: str) -> str:
    """Tên tiếng Việt hiển thị của luật; trả về id nếu không có trong catalog."""
    rule = _RULES_BY_ID.get(rule_id)
    return rule.label_vi if rule else rule_id


def rule_fix_tip(rule_id: str, message: str = "") -> str:
    """Gợi ý sửa lỗi theo luật, có xử lý trường hợp lún đất."""
    if rule_id == "floating" and "box này chạm đất" in message.lower():
        return "Box này chạm đất; kiểm tra cao độ các frame khác của track trên point cloud và ảnh camera."
    if rule_id == "floating" and re.search(r"\(lún\)|nằm dưới mặt đất", message, re.IGNORECASE):
        return SINK_FIX_TIP
    rule = _RULES_BY_ID.get(rule_id)
    return rule.fix_tip if rule else DEFAULT_FIX_TIP


def rule_of_message(message: str) -> str | None:
    """Nhận diện rule_id từ chuỗi thông báo finding."""
    text = (message or "").strip()
    if not text:
        return None
    for rule_id, pattern in _COMPILED_PATTERNS:
        if pattern.search(text):
            return rule_id
    return None


def rule_switch_key(rule_id: str) -> str:
    """Khóa công tắc tương ứng trong config.rules."""
    rule = _RULES_BY_ID.get(rule_id)
    if rule:
        return rule.switch_key
    return rule_id.replace(".", "_")


def rules_catalog_dict() -> dict[str, Any]:
    """Toàn bộ danh mục phục vụ endpoint GET /api/rules."""
    return {
        "rules": [r.to_dict() for r in RULES_CATALOG],
        "labels": {r.id: r.label_vi for r in RULES_CATALOG},
        "tips": {r.id: r.fix_tip for r in RULES_CATALOG},
        "sink_fix_tip": SINK_FIX_TIP,
        "default_fix_tip": DEFAULT_FIX_TIP,
    }
