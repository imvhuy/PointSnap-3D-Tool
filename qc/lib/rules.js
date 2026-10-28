'use strict';
/*
 * Danh mục luật và ngưỡng cho trình sửa guideline của trang QC: tên tiếng Việt, nhóm, đơn vị. Giá trị mặc định nằm ở
 * guideline của extension (luật chung với annotator) và `QC_DEFAULTS` (luật chỉ QC); file này chỉ mô tả để hiển thị.
 * Ghi đè lưu dạng { ...ghi đè guideline chung, qc: { ...ghi đè QC, disabledRules: [luật tắt] } }.
 */
const G = require('../../extension/src/annotator/guideline.js');
const { QC_DEFAULTS, validateQc } = require('./trackrules');

const RULES = [
  { id: 'ground.gap', title: 'Lơ lửng / lún', group: 'Mặt đất' },
  { id: 'ground.points_below', title: 'Điểm của vật dưới đáy', group: 'Mặt đất' },
  { id: 'z.range', title: 'Z lệch mặt đất vùng', group: 'Mặt đất' },
  { id: 'size.class_range', title: 'Kích thước ngoài khoảng', group: 'Kích thước' },
  { id: 'size.in_track', title: 'Kích thước lệch trong track', group: 'Kích thước' },
  { id: 'fit.empty', title: 'Box rỗng', group: 'Kích thước' },
  { id: 'overlap', title: 'Chồng lấn', group: 'Chồng lấn & spec' },
  { id: 'overlap.allowed', title: 'Chồng lấn được phép', group: 'Chồng lấn & spec' },
  { id: 'spec.rider_double', title: 'Người lái có box riêng', group: 'Chồng lấn & spec' },
  { id: 'spec.inside', title: 'Người trong xe có box', group: 'Chồng lấn & spec' },
  { id: 'attr.missing', title: 'Thiếu thuộc tính', group: 'Chồng lấn & spec' },
  { id: 'range.too_far', title: 'Ngoài phạm vi gán nhãn', group: 'Chồng lấn & spec' },
  { id: 'heading.jump', title: 'Hướng nhảy', group: 'Track (chỉ QC)' },
  { id: 'track.jump', title: 'Box nhảy trong một frame', group: 'Track (chỉ QC)' },
  { id: 'track.swap', title: 'Đổi ID giữa hai track', group: 'Track (chỉ QC)' },
  { id: 'track.fragment', title: 'Đứt track (một vật, hai ID)', group: 'Track (chỉ QC)' },
  { id: 'track.duplicate', title: 'Một vật vẽ hai lần', group: 'Track (chỉ QC)' },
];

/** Ô ngưỡng hiện trên trình sửa. `pct`: lưu dạng tỉ lệ 0–1, hiện dạng %. `nullable`: để trống = tắt. */
const FIELDS = [
  { path: 'ground.warningM', label: 'Lơ lửng / lún: cảnh báo từ', unit: 'm', group: 'Mặt đất' },
  { path: 'ground.errorM', label: 'Lơ lửng / lún: lỗi từ', unit: 'm', group: 'Mặt đất' },
  { path: 'ground.minConfidence', label: 'Độ tin cậy mặt đất tối thiểu', unit: '%', pct: true, group: 'Mặt đất' },
  { path: 'ground.maxRangeM', label: 'Đo mặt đất tới', unit: 'm', group: 'Mặt đất' },
  { path: 'zRange.minM', label: 'Z vùng: thấp nhất', unit: 'm', group: 'Mặt đất' },
  { path: 'zRange.maxM', label: 'Z vùng: cao nhất', unit: 'm', group: 'Mặt đất' },
  { path: 'size.warningMargin', label: 'Nới khoảng kích thước: cảnh báo', unit: '%', pct: true, group: 'Kích thước' },
  { path: 'size.errorMargin', label: 'Nới khoảng kích thước: lỗi', unit: '%', pct: true, group: 'Kích thước' },
  { path: 'size.inTrack.warningAbsM', label: 'Lệch trong track: cảnh báo từ', unit: 'm', group: 'Kích thước' },
  { path: 'size.inTrack.errorAbsM', label: 'Lệch trong track: lỗi từ', unit: 'm', group: 'Kích thước' },
  { path: 'overlap.warning', label: 'Chồng lấn: cảnh báo khi trên', unit: '%', pct: true, group: 'Chồng lấn & spec' },
  { path: 'overlap.error', label: 'Chồng lấn: lỗi khi trên', unit: '%', pct: true, group: 'Chồng lấn & spec' },
  { path: 'maxDistanceM', label: 'Phạm vi gán nhãn', unit: 'm', nullable: true, group: 'Chồng lấn & spec' },
  { path: 'spec.insideMinLiftM', label: 'Người trên nóc xe: cao hơn đáy xe', unit: 'm', group: 'Chồng lấn & spec' },
  { path: 'trackOps.yawJumpDeg.rigid', label: 'Hướng nhảy: vật cứng', unit: '°', group: 'Track (chỉ QC)' },
  { path: 'trackOps.yawJumpDeg.nonRigid', label: 'Hướng nhảy: người, động vật', unit: '°', group: 'Track (chỉ QC)' },
  { path: 'qc.jump.posM', label: 'Box nhảy: lệch vị trí từ', unit: 'm', group: 'Track (chỉ QC)' },
  { path: 'qc.jump.dimsRel', label: 'Box nhảy: đổi kích thước từ', unit: '%', pct: true, group: 'Track (chỉ QC)' },
  { path: 'qc.fragment.maxGapFrames', label: 'Đứt track: cách tối đa', unit: 'frame', group: 'Track (chỉ QC)' },
  { path: 'qc.fragment.maxDistM', label: 'Đứt track: lệch chỗ đoán tối đa', unit: 'm', group: 'Track (chỉ QC)' },
  { path: 'qc.duplicate.minRatio', label: 'Vẽ hai lần: chồng từ', unit: '%', pct: true, group: 'Track (chỉ QC)' },
  { path: 'qc.duplicate.minFrames', label: 'Vẽ hai lần: số frame liền', unit: 'frame', group: 'Track (chỉ QC)' },
];

const QC_FULL_DEFAULTS = { ...QC_DEFAULTS, disabledRules: [] };

/** Ghi đè → { guideline, qc, errors }. Ghi đè lỗi thì trả mặc định kèm danh sách lỗi. */
function resolveSpec(override = {}) {
  const { qc = {}, ...shared } = override || {};
  const r = G.resolve(shared);
  const q = G.merge(QC_FULL_DEFAULTS, qc);
  const errors = [...r.errors, ...validateQc(q)];
  if (!Array.isArray(q.disabledRules) || !q.disabledRules.every((x) => typeof x === 'string')) errors.push('qc.disabledRules phải là danh sách mã luật');
  return errors.length ? { guideline: G.DEFAULT_GUIDELINE, qc: QC_FULL_DEFAULTS, errors } : { guideline: r.guideline, qc: q, errors: [] };
}

module.exports = { RULES, FIELDS, QC_FULL_DEFAULTS, resolveSpec };
