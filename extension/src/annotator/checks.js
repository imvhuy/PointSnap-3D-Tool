/*
 * Kiểm tra một cuboid ngay khi đang sửa. Hàm thuần: nhận số đo đã tính sẵn, trả về danh sách vấn đề.
 * Mỗi vấn đề: { rule, severity: 'error' | 'warning' | 'info', title, message }.
 * Luật và ngưỡng khớp với bộ quét Python (pointsnap/detectors) để annotator và QC thấy cùng một kết luận.
 */
(function (root) {
  'use strict';

  const B = root.PointSnapBox || require('./box.js');

  const DIMS = ['length', 'width', 'height'];
  const DIM_VI = { length: 'Chiều dài', width: 'Chiều rộng', height: 'Chiều cao' };
  const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };
  const cm = (m) => `${Math.round(m * 100)} cm`;

  function issue(rule, severity, title, message) {
    return { rule, severity, title, message };
  }

  function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }

  /** Kích thước ngoài khoảng của class: một vấn đề cho chiều lệch nặng nhất. */
  function sizeRange(box, key, g) {
    const ranges = g.size.ranges[key];
    if (!ranges) return [];
    let worst = null;
    DIMS.forEach((dim, i) => {
      const [lo, hi] = ranges[dim], value = box.dims[i];
      for (const [severity, margin] of [['error', g.size.errorMargin], ['warning', g.size.warningMargin]]) {
        const min = lo * (1 - margin), max = hi * (1 + margin);
        if (value >= min && value <= max) continue;
        const excess = value < min ? (min - value) / min : (value - max) / max;
        if (!worst || SEVERITY_RANK[severity] < SEVERITY_RANK[worst.severity]
            || (severity === worst.severity && excess > worst.excess)) {
          worst = { severity, excess, dim, value, lo, hi, small: value < min };
        }
        break;
      }
    });
    if (!worst) return [];
    return [issue('size.class_range', worst.severity, 'Kích thước ngoài ngưỡng',
      `${DIM_VI[worst.dim]} ${worst.value.toFixed(2)} m ${worst.small ? 'nhỏ' : 'lớn'} bất thường với ${key} `
      + `(khoảng chuẩn ${worst.lo.toFixed(2)}–${worst.hi.toFixed(2)} m)`)];
  }

  /** Kích thước keyframe này lệch so với trung vị các keyframe khác cùng track. */
  function sizeInTrack(box, label, trackDims, g) {
    const cfg = g.size.inTrack;
    if (!trackDims || trackDims.length < cfg.minKeyframes - 1 || g.size.nonRigidClasses.includes(label)) return [];
    let worst = null;
    DIMS.forEach((dim, i) => {
      const med = median(trackDims.map((d) => d[i]));
      const diff = Math.abs(box.dims[i] - med);
      const severity = diff > Math.max(cfg.errorAbsM, cfg.errorRel * med) ? 'error'
        : diff > Math.max(cfg.warningAbsM, cfg.warningRel * med) ? 'warning' : null;
      if (severity && (!worst || SEVERITY_RANK[severity] < SEVERITY_RANK[worst.severity]
          || (severity === worst.severity && diff > worst.diff))) {
        worst = { severity, diff, dim, med };
      }
    });
    if (!worst) return [];
    return [issue('size.in_track', worst.severity, 'Scale không đồng bộ',
      `${DIM_VI[worst.dim]} lệch ${cm(worst.diff)} so với trung vị track (${worst.med.toFixed(2)} m, `
      + `${trackDims.length} keyframe khác)`)];
  }

  /**
   * Số đo tiếp đất đủ tin để báo / hiển thị: độ tin cậy ≥ `minConfidence` và box trong `maxRangeM`. Đo trên Argoverse 2
   * so với bản đồ mặt đất thật: trong 50 m sai số p90 ≤ 10 cm, xa hơn sai tới 1,4 m. Dùng chung cho luật, HUD và hạ đáy.
   */
  function usableContact(contact, box, g) {
    const cfg = g.ground;
    return contact && contact.confidence >= cfg.minConfidence && B.rangeXY(box, g.sensorOrigin) <= cfg.maxRangeM ? contact : null;
  }

  function ground(box, contact, label, g) {
    const cfg = g.ground;
    if (!cfg.classes.includes(label)) return [];
    if (B.rangeXY(box, g.sensorOrigin) > cfg.maxRangeM) {
      return [issue('ground.no_evidence', 'info', 'Quá xa để đo cao độ',
        `Box xa hơn ${cfg.maxRangeM} m: mặt đất ước lượng từ LiDAR không đủ tin; kiểm tra bằng mắt ở view Side / Front`)];
    }
    if (!usableContact(contact, box, g)) {
      return [issue('ground.no_evidence', 'info', 'Không đủ điểm mặt đất',
        'Quanh box quá ít điểm mặt đất để đo cao độ; kiểm tra bằng mắt ở view Side / Front')];
    }
    const out = [];
    if (contact.pointsBelowBottom >= cfg.pointsBelowBottomMin && contact.gapM > cfg.okM) {
      out.push(issue('ground.points_below', 'error', 'Box lơ lửng',
        `${contact.pointsBelowBottom} điểm của vật nằm dưới đáy box: hạ đáy box xuống`));
    }
    const gap = Math.abs(contact.gapM);
    const severity = gap > cfg.errorM ? 'error' : gap > cfg.warningM ? 'warning' : null;
    if (severity) {
      out.push(issue('ground.gap', severity, contact.gapM > 0 ? 'Box lơ lửng' : 'Box lún',
        `Đáy box ${contact.gapM > 0 ? 'cao hơn' : 'thấp hơn'} mặt đất ${cm(gap)}`
        + (contact.spreadM > 0.08 ? ` (mặt đất dưới box chênh ${cm(contact.spreadM)}: dốc hoặc bờ vỉa)` : '')));
    }
    return out;
  }

  function zRange(box, coarseGroundZ, g) {
    if (!Number.isFinite(coarseGroundZ) || B.rangeXY(box, g.sensorOrigin) > g.zRange.maxRangeM) return [];
    const d = B.bottomZ(box) - coarseGroundZ;
    if (d >= g.zRange.minM && d <= g.zRange.maxM) return [];
    return [issue('z.range', 'warning', 'Z ngoài ngưỡng',
      `Đáy box ${d > 0 ? 'cao hơn' : 'thấp hơn'} mặt đất chung của vùng ${cm(Math.abs(d))} `
      + `(cho phép ${g.zRange.minM} … +${g.zRange.maxM} m)`)];
  }

  function tooFar(box, g) {
    if (g.maxDistanceM === null) return [];
    const range = B.rangeXY(box, g.sensorOrigin);
    if (range <= g.maxDistanceM) return [];
    return [issue('range.too_far', 'warning', 'Quá xa',
      `Box cách LiDAR ${range.toFixed(1)} m, ngoài phạm vi gán nhãn ${g.maxDistanceM} m`)];
  }

  function overlaps(target, others, g) {
    const cfg = g.overlap;
    const names = (o) => [o.label, o.classKey];
    if (!names(target).some((n) => cfg.classes.includes(n))) return [];
    const allowed = (a, b) => cfg.allowedPairs.some(([x, y]) =>
      (names(a).includes(x) && names(b).includes(y)) || (names(a).includes(y) && names(b).includes(x)));
    const out = [];
    for (const other of others) {
      if (!names(other).some((n) => cfg.classes.includes(n))) continue;
      const ratio = B.overlapRatio(target.box, other.box);
      if (ratio <= cfg.warning) continue;
      const pct = Math.round(ratio * 100);
      // Cặp spec cho phép (người trên thùng xe, người lái…) vẫn hiện ở mức Thông tin để annotator thấy box đang chồng.
      const found = allowed(target, other)
        ? issue('overlap.allowed', 'info', 'Chồng lấn (spec cho phép)', `Chồng ${pct}% lên ${other.label} #${other.clientId}: cặp này được phép chồng theo spec`)
        : issue('overlap', ratio > cfg.error ? 'error' : 'warning', 'Chồng lấn',
          `Chồng ${pct}% lên ${other.label} #${other.clientId}: nghi vẽ trùng hoặc hai box lấn nhau`);
      out.push({ ...found, otherClientId: other.clientId, ratio });
    }
    return out;
  }

  function empty(pointsInside, occluded, groundMeasured) {
    if (occluded || !groundMeasured || pointsInside > 0) return [];
    return [issue('fit.empty', 'warning', 'Box rỗng',
      'Không có điểm LiDAR nào trong box: vẽ vào chỗ trống, hoặc vật bị che thì đánh dấu occluded')];
  }

  function requiredAttributes(label, attributes, g) {
    const missing = (g.attributes.required[label] || []).filter((name) => attributes[name] === undefined || attributes[name] === '');
    return missing.length ? [issue('attr.missing', 'error', 'Thiếu thuộc tính', `Chưa chọn: ${missing.join(', ')}`)] : [];
  }

  /**
   * `input`: { box, label, classKey, attributes, occluded, trackDims (kích thước các keyframe khác cùng track),
   * contact (PointSnapTerrain.measureContact), coarseGroundZ, others: [{ box, label, classKey, clientId }],
   * pointsInside (điểm trong box cao hơn đáy 10 cm) }.
   */
  function checkBox(input, g) {
    const { box, label, classKey, attributes, occluded } = input;
    const geometric = occluded ? [] : [
      ...ground(box, input.contact, label, g),
      ...zRange(box, input.coarseGroundZ, g),
      ...empty(input.pointsInside, occluded, !!input.contact),
    ];
    return [
      ...sizeRange(box, classKey, g),
      ...sizeInTrack(box, label, input.trackDims, g),
      ...geometric,
      ...tooFar(box, g),
      ...overlaps({ box, label, classKey }, input.others || [], g),
      ...requiredAttributes(label, attributes || {}, g),
    ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  }

  /**
   * Ngoại lai theo trung vị và MAD: |x − trung vị| > k × 1,4826 × MAD và vượt `floor` (đơn vị của giá trị).
   * Bền với nhiễu hơn trung bình ± độ lệch chuẩn; `floor` tránh báo khi cả track gần như bằng nhau.
   */
  function madOutliers(values, floor, k = 3) {
    if (values.length < 3) return values.map(() => false);
    const med = median(values), mad = median(values.map((v) => Math.abs(v - med)));
    const limit = Math.max(k * 1.4826 * mad, floor);
    return values.map((v) => Math.abs(v - med) > limit);
  }

  /**
   * Keyframe có góc (yaw) nhảy đột ngột, ngưỡng `floorDeg` độ. Mỗi keyframe được đoán từ lân cận bằng 4 cách: nội suy
   * giữa i−1 và i+1, giữa i−2 và i+2 (theo frame, cung ngắn nhất, như CVAT nội suy), ngoại suy thẳng từ hai keyframe
   * trước, từ hai keyframe sau. Chỉ đánh dấu khi **mọi** cách đoán đều lệch quá ngưỡng:
   * - xe rẽ thật (kể cả rẽ gắt, tốc độ quay đổi dần) luôn có cách đoán khớp, không bị đánh dấu;
   * - một keyframe sai (lật 180°, quay ngang 90°) không cách nào khớp; keyframe kề nó vẫn còn cách đoán không đi qua
   *   keyframe sai nên không bị đánh dấu lây;
   * - keyframe đầu / cuối track được kiểm bằng ngoại suy.
   * Không unwrap cả track: unwrap qua một keyframe lật đúng 180° biến nó thành bước lệch 360° kéo tới cuối track.
   * Hai bản trước (so với hướng trung bình của lân cận; rồi bỏ dần lân cận lệch nhất) đánh dấu nhầm xe rẽ gắt ở ngã tư
   * (nuScenes scene-1077: −156° → 176° → 153° → 137°, 2 Hz).
   */
  function angleOutliers(angles, floorDeg, frames = angles.map((_, i) => i)) {
    const n = angles.length;
    if (n < 3) return angles.map(() => false);
    const at = (a, b, f) => { // góc tại frame f trên đường thẳng qua keyframe a, b (nội suy hoặc ngoại suy)
      const t = (f - frames[a]) / (frames[b] - frames[a]);
      return angles[a] + B.angleDiff(angles[a], angles[b]) * t;
    };
    return angles.map((angle, i) => {
      const guesses = [];
      if (i >= 1 && i + 1 < n) guesses.push(at(i - 1, i + 1, frames[i]));
      if (i >= 2 && i + 2 < n) guesses.push(at(i - 2, i + 2, frames[i]));
      if (i >= 2) guesses.push(at(i - 2, i - 1, frames[i]));
      if (i + 2 < n) guesses.push(at(i + 2, i + 1, frames[i]));
      const best = Math.min(...guesses.map((g) => Math.abs(B.angleDiff(g, angle)) * 180 / Math.PI));
      return best > floorDeg;
    });
  }

  /** Keyframe có một chiều lệch trung vị track quá ngưỡng Cảnh báo của `size.in_track` (cùng ngưỡng với luật). */
  function inTrackOutliers(values, g) {
    const cfg = g.size.inTrack, med = median(values);
    return values.map((v) => Math.abs(v - med) > Math.max(cfg.warningAbsM, cfg.warningRel * med));
  }

  const api = { checkBox, usableContact, median, madOutliers, angleOutliers, inTrackOutliers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapChecks = api;
})(globalThis);
