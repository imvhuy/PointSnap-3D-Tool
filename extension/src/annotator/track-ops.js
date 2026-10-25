/*
 * Kế hoạch sửa cả track (hàm thuần): nhận danh sách keyframe, trả về danh sách thay đổi để xem trước rồi mới ghi.
 * Keyframe: { frame, box, outside, occluded, attrsKey } sắp theo frame; `attrsKey` là chuỗi đại diện thuộc tính.
 * Thay đổi: { frame, box } (đổi hình học) hoặc { frame, keyframe: false } (bỏ keyframe để CVAT tự nội suy).
 */
(function (root) {
  'use strict';

  const B = root.PointSnapBox || require('./box.js');
  const DEG = Math.PI / 180;

  /** Nội suy giữa hai keyframe đúng như CVAT (cuboid-track.ts): tâm / kích thước tuyến tính, góc theo cung ngắn nhất. */
  function interpolate(a, b, t) {
    const lerp = (x, y) => x + (y - x) * t;
    return {
      center: a.center.map((v, i) => lerp(v, b.center[i])),
      dims: a.dims.map((v, i) => lerp(v, b.dims[i])),
      rotation: a.rotation.map((v, i) => B.wrapAngle(v + B.angleDiff(v, b.rotation[i]) * t)),
    };
  }

  function median(values) {
    const s = values.slice().sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }

  const visible = (keyframes) => keyframes.filter((k) => !k.outside);

  /**
   * Đồng bộ kích thước cả track về `dims`. Giữ cố định các mặt LiDAR nhìn thấy (mặt gần cảm biến có điểm, là phần
   * annotator đã canh đúng) và chỉ kéo dài / co về phía bị che; giữ nguyên đáy box.
   */
  function planSizeSync(keyframes, dims, origin = [0, 0, 0]) {
    const edits = [];
    let maxShiftM = 0;
    for (const k of visible(keyframes)) {
      if (k.box.dims.every((d, i) => Math.abs(d - dims[i]) < 1e-3)) continue;
      const sensor = B.toLocal(k.box, origin);
      const shift = [0, 1].map((i) => {
        const half = k.box.dims[i] / 2, newHalf = dims[i] / 2;
        return Math.abs(sensor[i]) > half ? Math.sign(sensor[i]) * (half - newHalf) : 0;
      });
      shift.push((dims[2] - k.box.dims[2]) / 2);
      const center = B.toWorld(k.box, shift);
      maxShiftM = Math.max(maxShiftM, Math.hypot(...center.map((v, i) => v - k.box.center[i])));
      edits.push({ frame: k.frame, box: { ...k.box, center, dims: [...dims] } });
    }
    return { edits, summary: { changed: edits.length, maxShiftM } };
  }

  /** Trung vị kích thước các keyframe nhìn thấy: nguồn mặc định cho đồng bộ kích thước. */
  function medianDims(keyframes) {
    const shown = visible(keyframes);
    return shown.length ? [0, 1, 2].map((i) => median(shown.map((k) => k.box.dims[i]))) : null;
  }

  /**
   * Làm mượt yaw: sửa frame lật đầu (lệch ≈ 180° so với lân cận) rồi lọc trung vị cửa sổ `window`.
   * Lọc trung vị giữ được đoạn xe rẽ thật; chỉ đổi frame lệch hơn `minChangeDeg`.
   */
  function planYawSmoothing(keyframes, { window = 5, minChangeDeg = 2, flipToleranceDeg = 30 } = {}) {
    const shown = visible(keyframes);
    if (shown.length < 3) return { edits: [], summary: { changed: 0, flips: 0 } };
    const unwrap = (angles) => angles.reduce((out, a, i) => {
      out.push(i ? out[i - 1] + B.angleDiff(out[i - 1], a) : a);
      return out;
    }, []);
    const half = Math.floor(window / 2);
    const around = (values, i) => values.filter((_, j) => j !== i && Math.abs(j - i) <= half);
    // Cửa sổ đối xứng (co lại ở hai đầu track): cửa sổ lệch một phía kéo đầu / cuối đoạn rẽ về phía giữa.
    const symmetric = (values, i) => {
      const r = Math.min(half, i, values.length - 1 - i);
      return values.slice(i - r, i + r + 1);
    };

    // Lật đầu: đa số keyframe lân cận ngược hướng ≈ 180°. So trên góc gốc, không unwrap trước: unwrap qua chỗ lật
    // làm lệch 2π mọi frame phía sau. Một đoạn dài bị ngược (không phải frame lẻ) không đạt đa số nên giữ nguyên;
    // lọc trung vị cũng giữ nguyên bước nhảy đó, để annotator tự xoay cả đoạn.
    const yaws = shown.map((k) => k.box.rotation[2]);
    let flips = 0;
    const corrected = unwrap(yaws.map((yaw, i) => {
      const neighbours = around(yaws, i);
      const opposite = neighbours.filter((n) => Math.abs(B.angleDiff(n, yaw)) >= Math.PI - flipToleranceDeg * DEG).length;
      if (opposite * 2 <= neighbours.length) return yaw;
      flips += 1;
      return B.wrapAngle(yaw + Math.PI);
    }));
    const smoothed = corrected.map((_, i) => median(symmetric(corrected, i)));

    const edits = [];
    shown.forEach((k, i) => {
      const yaw = B.wrapAngle(smoothed[i]);
      if (Math.abs(B.angleDiff(k.box.rotation[2], yaw)) <= minChangeDeg * DEG) return;
      edits.push({ frame: k.frame, box: { ...k.box, rotation: [k.box.rotation[0], k.box.rotation[1], yaw] } });
    });
    return { edits, summary: { changed: edits.length, flips } };
  }

  /** Sai số đã chuẩn hóa theo dung sai: > 1 nghĩa là nội suy không tái tạo được keyframe này. */
  function normalizedError(actual, predicted, tol) {
    const center = Math.hypot(...actual.center.map((v, i) => v - predicted.center[i])) / tol.centerM;
    const dims = Math.max(...actual.dims.map((v, i) => Math.abs(v - predicted.dims[i]))) / tol.dimsM;
    const angle = Math.max(...actual.rotation.map((v, i) => Math.abs(B.angleDiff(v, predicted.rotation[i])))) / (tol.yawDeg * DEG);
    return Math.max(center, dims, angle);
  }

  /**
   * Tỉa keyframe thừa (Douglas–Peucker theo thời gian): bỏ keyframe mà nội suy giữa hai keyframe được giữ đã tái tạo
   * trong dung sai `tol` ({ centerM, dimsM, yawDeg }). Luôn giữ keyframe đầu / cuối, keyframe `outside` và keyframe
   * kề chỗ đổi outside / occluded / thuộc tính: nội suy không mang được các thay đổi đó.
   */
  function planThinning(keyframes, tol) {
    const n = keyframes.length;
    const keep = new Array(n).fill(false);
    const differs = (a, b) => a.outside !== b.outside || a.occluded !== b.occluded || a.attrsKey !== b.attrsKey;
    keyframes.forEach((k, i) => {
      keep[i] = i === 0 || i === n - 1 || k.outside || differs(k, keyframes[i - 1]) || differs(k, keyframes[i + 1]);
    });

    let maxError = 0;
    const simplify = (i, j) => {
      let worst = -1, worstError = 1;
      for (let k = i + 1; k < j; k += 1) {
        const t = (keyframes[k].frame - keyframes[i].frame) / (keyframes[j].frame - keyframes[i].frame);
        const e = normalizedError(keyframes[k].box, interpolate(keyframes[i].box, keyframes[j].box, t), tol);
        if (e > worstError) { worstError = e; worst = k; }
      }
      if (worst < 0) return;
      keep[worst] = true;
      simplify(i, worst);
      simplify(worst, j);
    };
    let start = 0;
    for (let i = 1; i < n; i += 1) {
      if (!keep[i]) continue;
      simplify(start, i);
      start = i;
    }

    // Sai số thực tế sau khi tỉa, để báo cho annotator.
    let left = 0;
    for (let i = 1; i < n; i += 1) {
      if (!keep[i]) continue;
      for (let k = left + 1; k < i; k += 1) {
        const t = (keyframes[k].frame - keyframes[left].frame) / (keyframes[i].frame - keyframes[left].frame);
        const predicted = interpolate(keyframes[left].box, keyframes[i].box, t);
        maxError = Math.max(maxError, Math.hypot(...keyframes[k].box.center.map((v, a) => v - predicted.center[a])));
      }
      left = i;
    }
    const edits = keyframes.filter((_, i) => !keep[i]).map((k) => ({ frame: k.frame, keyframe: false }));
    return { edits, summary: { changed: edits.length, kept: keep.filter(Boolean).length, total: n, maxCenterErrorM: maxError } };
  }

  /** Hạ / nâng box để đáy chạm `contactZ` (giữ tâm XY, kích thước, góc). */
  function snapToGround(box, contactZ) {
    const dz = contactZ - B.bottomZ(box);
    return { ...box, center: [box.center[0], box.center[1], box.center[2] + dz] };
  }

  const api = { interpolate, planSizeSync, medianDims, planYawSmoothing, planThinning, snapToGround };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapTrackOps = api;
})(globalThis);
