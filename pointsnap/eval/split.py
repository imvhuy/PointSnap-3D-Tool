"""Chia 10 cảnh nuScenes v1.0-mini thành 5 cảnh tinh chỉnh và 5 cảnh kiểm tra (mục 8 của đề xuất).

Chia xen kẽ theo thứ tự trong bảng `scene.json` để cả hai nhóm đều có cảnh Boston và Singapore, ngày và đêm.
Ngưỡng và thống kê kích thước chỉ được chỉnh trên cảnh tinh chỉnh; số liệu báo cáo lấy trên cảnh kiểm tra.
"""

TUNING_SCENES = ("scene-0061", "scene-0553", "scene-0757", "scene-0916", "scene-1094")
TEST_SCENES = ("scene-0103", "scene-0655", "scene-0796", "scene-1077", "scene-1100")
