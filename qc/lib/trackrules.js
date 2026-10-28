'use strict';
/*
 * Luật chỉ QC làm (cần nhìn nhiều frame / cả job), chủ yếu cho nhãn pre-label: keyframe ở mọi frame, tracker của model
 * đứt / đổi ID, box rung từng frame.
 * - track.jump: vị trí / kích thước ở một keyframe lệch mọi cách đoán từ keyframe lân cận; hoặc track "nhảy chỗ" giữa
 *   hai keyframe liền nhau (quá khứ và tương lai của track không nối được) mà không có track khác đổi chỗ cùng lúc.
 * - track.swap: hai track nhảy chỗ cùng lúc, mỗi track nhảy sang đúng đường đi của track kia → nghi đổi ID.
 * - track.fragment: một đoạn track kết thúc, đoạn track khác cùng class bắt đầu đúng chỗ đoán được trong vài frame.
 * - track.duplicate: hai box cỡ gần bằng nhau chồng nhau nhiều frame liền → một vật vẽ hai lần.
 * Mỗi track tách thành các đoạn liền (cắt ở keyframe outside); chỉ so keyframe trong cùng đoạn. Lời nhắn ghi object kia
 * dạng #track:<id>; scan.js đổi thành số CVAT hiện trong danh sách object.
 */
const B = require('../../extension/src/annotator/box.js');

/** Ngưỡng mặc định; đo trên nhãn chuẩn nuScenes / AV2 (qc/README.md). Project ghi đè qua guideline, nhánh `qc`. */
const QC_DEFAULTS = {
  jump: {
    posM: 1.0, // lệch vị trí tối thiểu để báo
    // Lệch dọc hướng đi được nới theo quãng đường (vật đổi tốc độ, thời điểm frame lệch); lệch ngang / lên xuống thì không
    // có lý do vật lý nào, nên chỉ nới rất ít (xe vào cua).
    posStepRatio: 0.3, // dọc hướng đi: lệch > tỉ lệ này × quãng đường giữa hai keyframe
    latStepRatio: 0.05, // ngang hướng đi

    dimsRel: 0.15, // kích thước đổi > 15% (vật cứng)
    nonRigidDimsRel: 0.35, // người, động vật
    endFactor: 2, // keyframe đầu / cuối đoạn chỉ có ngoại suy: nới ngưỡng
  },
  // Đứt track: lệch chỗ đoán ≤ max(sizeRatio × cỡ vật trong [minDistM, maxDistM], distStepRatio × quãng đường trong khoảng đứt).
  fragment: { maxGapFrames: 5, minDistM: 0.5, maxDistM: 2.0, sizeRatio: 0.25, distStepRatio: 0.5, maxDimsRel: 0.3,
    maxSpeedRel: 0.3, minSpeedDiffM: 0.5 }, // vận tốc hai đoạn lệch > max(30%, 0.5 m/frame) là hai vật
  duplicate: { minRatio: 0.7, minVolumeRatio: 0.5, minFrames: 3 },
  // ≥ minTracks track và ≥ minShare số track có mặt cùng nhảy ở một frame → lỗi cả frame, không báo từng track.
  common: { minTracks: 3, minShare: 0.15, movingM: 0.3 }, // movingM: m mỗi frame thì coi là đang chạy
};
const QC_NUMBERS = ['jump.posM', 'jump.posStepRatio', 'jump.latStepRatio', 'jump.dimsRel', 'jump.nonRigidDimsRel', 'jump.endFactor',
  'fragment.maxGapFrames', 'fragment.minDistM', 'fragment.maxDistM', 'fragment.sizeRatio', 'fragment.distStepRatio', 'fragment.maxDimsRel', 'fragment.maxSpeedRel', 'fragment.minSpeedDiffM',
  'duplicate.minRatio', 'duplicate.minVolumeRatio', 'duplicate.minFrames', 'common.minTracks', 'common.minShare', 'common.movingM'];

const get = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
function validateQc(q) {
  return QC_NUMBERS.filter((n) => !(Number.isFinite(get(q, n)) && get(q, n) >= 0)).map((n) => `qc.${n} phải là số ≥ 0`);
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dist = (a, b) => Math.hypot(...sub(a, b));
/** Giá trị tại frame f trên đường thẳng qua (fa, va) và (fb, vb), từng phần tử. */
const line = (fa, va, fb, vb, f) => va.map((v, i) => v + (vb[i] - v) * ((f - fa) / (fb - fa)));

function segments(track) {
  const out = [[]];
  for (const k of track.keyframes) {
    if (k.outside || !k.box) { if (out.at(-1).length) out.push([]); } else out.at(-1).push(k);
  }
  return out.filter((s) => s.length);
}

/** Cách đoán keyframe i từ lân cận (giống `angleOutliers`): nội suy 2 kiểu, ngoại suy từ trước, từ sau. */
function guesses(seg, i, pick) {
  const n = seg.length, at = (a, b) => line(seg[a].frame, pick(seg[a]), seg[b].frame, pick(seg[b]), seg[i].frame);
  const inner = [], outer = [];
  if (i >= 1 && i + 1 < n) inner.push(at(i - 1, i + 1));
  if (i >= 2 && i + 2 < n) inner.push(at(i - 2, i + 2));
  if (i >= 2) outer.push(at(i - 2, i - 1));
  if (i + 2 < n) outer.push(at(i + 2, i + 1));
  return { all: [...inner, ...outer], end: !inner.length };
}

/** Quãng đường mỗi keyframe quanh i, không tính chính i (để keyframe sai không tự nới ngưỡng cho mình). */
function localStep(seg, i) {
  const c = (j) => seg[j].box.center, n = seg.length;
  if (i >= 1 && i + 1 < n) return dist(c(i - 1), c(i + 1)) / 2;
  if (i + 2 < n) return dist(c(i + 1), c(i + 2));
  if (i >= 2) return dist(c(i - 1), c(i - 2));
  return 0;
}

/** Hướng đi (đơn vị, mặt phẳng xy) quanh keyframe i, không dùng chính i; vật gần như đứng yên thì null. */
function heading2d(seg, i) {
  const c = (j) => seg[j].box.center, n = seg.length;
  const v = i >= 1 && i + 1 < n ? sub(c(i + 1), c(i - 1)) : i + 2 < n ? sub(c(i + 2), c(i + 1)) : i >= 2 ? sub(c(i - 1), c(i - 2)) : [0, 0];
  const len = Math.hypot(v[0], v[1]);
  return len > 1e-3 ? [v[0] / len, v[1] / len] : null;
}

/** Sai lệch `e` (vector 3D) tách thành phần dọc hướng đi `u` và phần còn lại (ngang + lên xuống). */
function split(e, u) {
  const along = u ? Math.abs(e[0] * u[0] + e[1] * u[1]) : 0;
  return { along, lat: Math.sqrt(Math.max(0, e[0] ** 2 + e[1] ** 2 + e[2] ** 2 - along ** 2)) };
}

/**
 * Lệch quá ngưỡng: vùng cho phép là hình elip, dài dọc hướng đi (nới theo quãng đường `step`), hẹp theo chiều ngang. Vật
 * chạy chậm thì elip thành hình tròn bán kính posM, đúng như luật cũ đo theo khoảng cách.
 */
function offTrack(e, u, step, cfg, factor = 1) {
  const { along, lat } = split(e, u);
  const a = Math.max(cfg.posM, cfg.posStepRatio * step) * factor, b = Math.max(cfg.posM, cfg.latStepRatio * step) * factor;
  return (along / a) ** 2 + (lat / b) ** 2 > 1;
}

const cm = (m) => `${Math.round(m * 100)} cm`;

function jumpsInSegment(track, seg, cfg, nonRigid) {
  const out = [], flagged = new Set();
  if (seg.length < 3) return { out, flagged };
  seg.forEach((k, i) => {
    const pos = guesses(seg, i, (x) => x.box.center), dims = guesses(seg, i, (x) => x.box.dims);
    const factor = pos.end ? cfg.endFactor : 1;
    const posErr = Math.min(...pos.all.map((g) => dist(g, k.box.center)));
    const u = heading2d(seg, i), step = localStep(seg, i);
    // Báo khi mọi cách đoán đều lệch quá ngưỡng (dọc hoặc ngang).
    const posBad = pos.all.every((g) => offTrack(sub(k.box.center, g), u, step, cfg, factor));
    const dimsErr = Math.min(...dims.all.map((g) => Math.max(...g.map((v, d) => Math.abs(k.box.dims[d] - v) / Math.max(v, 0.1)))));
    const dimsTol = (nonRigid ? cfg.nonRigidDimsRel : cfg.dimsRel) * factor;
    const parts = [];
    if (posBad) parts.push(`vị trí lệch ${cm(posErr)}`);
    if (dimsErr > dimsTol) parts.push(`kích thước lệch ${Math.round(dimsErr * 100)}%`);
    if (!parts.length) return;
    flagged.add(i);
    out.push({ objKey: track.key, frame: k.frame, keyframe: true, issue: {
      rule: 'track.jump', severity: 'warning', title: 'Box nhảy trong một frame', short: parts.join(', '),
      message: `Keyframe ${k.frame}: ${parts.join(', ')} so với mọi cách đoán từ các keyframe lân cận (box rung / đặt nhầm vật).` } });
  });
  return { out, flagged };
}

/**
 * Chỗ đứt giữa keyframe i và i+1: đoán i+1 từ (i−1, i) và đoán i từ (i+2, i+1) đều lệch quá ngưỡng. Trả về
 * [{ track, seg, i, from, to, predNext, predPrev }]. Bỏ chỗ kề keyframe đã bị báo nhảy một frame.
 */
function breaksInSegment(track, seg, cfg, flagged) {
  const out = [];
  for (let i = 1; i + 2 < seg.length; i += 1) {
    if (flagged.has(i) || flagged.has(i + 1)) continue;
    const c = (j) => seg[j].box.center, f = (j) => seg[j].frame;
    const predNext = line(f(i - 1), c(i - 1), f(i), c(i), f(i + 1));
    const predPrev = line(f(i + 2), c(i + 2), f(i + 1), c(i + 1), f(i));
    const step = (dist(c(i - 1), c(i)) + dist(c(i + 1), c(i + 2))) / 2;
    const tol = Math.max(cfg.posM, cfg.posStepRatio * step);
    const dir = (v) => { const l = Math.hypot(v[0], v[1]); return l > 1e-3 ? [v[0] / l, v[1] / l] : null; };
    if (offTrack(sub(c(i + 1), predNext), dir(sub(c(i), c(i - 1))), step, cfg) && offTrack(sub(c(i), predPrev), dir(sub(c(i + 2), c(i + 1))), step, cfg)) {
      out.push({ track, seg, i, from: f(i), to: f(i + 1), predNext, predPrev, tol });
    }
  }
  return out;
}

function swapsAndBreaks(breaks) {
  const out = [], paired = new Set();
  for (const a of breaks) {
    for (const b of breaks) {
      if (a === b || paired.has(a) || paired.has(b) || a.track.label !== b.track.label || a.to !== b.to) continue;
      // Quá khứ của a nối sang tương lai của b và ngược lại.
      const cA = a.seg[a.i + 1].box.center, cB = b.seg[b.i + 1].box.center;
      if (dist(a.predNext, cB) <= Math.max(a.tol, b.tol) && dist(b.predNext, cA) <= Math.max(a.tol, b.tol)) {
        paired.add(a); paired.add(b);
        out.push({ objKey: a.track.key, frame: a.to, keyframe: true, issue: {
          rule: 'track.swap', severity: 'error', title: 'Nghi đổi ID giữa hai track', short: `đổi chỗ với #${b.track.key}`,
          message: `Từ frame ${a.to}, track này đi tiếp đường của ${b.track.label} #${b.track.key} và ngược lại: nghi tracker đổi ID.`,
          otherClientId: b.track.key } });
      }
    }
  }
  for (const a of breaks) {
    if (paired.has(a)) continue;
    const gap = dist(a.predNext, a.seg[a.i + 1].box.center);
    out.push({ objKey: a.track.key, frame: a.to, keyframe: true, issue: {
      rule: 'track.jump', severity: 'warning', title: 'Box nhảy trong một frame', short: `track nhảy ${cm(gap)} từ frame ${a.to}`,
      message: `Từ frame ${a.to} track không nối được với đoạn trước (lệch ${cm(gap)} so với đường đi): có thể hai vật dùng chung một ID.` } });
  }
  return out;
}

/** Frame mà track có mặt (keyframe không outside). */
const shownFrames = (t) => new Set(t.keyframes.filter((k) => !k.outside && k.box).map((k) => k.frame));

/**
 * Ghép một-một nhỏ nhất tổng chi phí (thuật toán Hungarian, dạng có thế vị). `cost`: ma trận n × m, Infinity = không được
 * ghép. Trả về [[hàng, cột]] của các cặp có chi phí hữu hạn.
 */
function assign(cost) {
  const n = cost.length, m = n ? cost[0].length : 0;
  if (!n || !m) return [];
  if (n > m) return assign(cost[0].map((_, j) => cost.map((row) => row[j]))).map(([i, j]) => [j, i]);
  const BIG = 1e9, c = (i, j) => (Number.isFinite(cost[i][j]) ? cost[i][j] : BIG);
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue;
        const cur = c(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = [];
  for (let j = 1; j <= m; j += 1) if (p[j] && Number.isFinite(cost[p[j] - 1][j - 1])) out.push([p[j] - 1, j - 1]);
  return out;
}

/**
 * Vận tốc (m mỗi frame, x y) khớp bình phương tối thiểu trên tối đa `k` keyframe ở một đầu đoạn; dưới 2 keyframe thì null.
 * k = 2 (hai keyframe sát chỗ đứt): k = 3 trễ khi xe đang rẽ, đoán lệch ngang quá cỡ xe (edge case "xe đang rẽ").
 */
function endVelocity(seg, atEnd, k = 2) {
  const pts = atEnd ? seg.slice(-k) : seg.slice(0, k);
  if (pts.length < 2) return null;
  const mf = pts.reduce((s0, q) => s0 + q.frame, 0) / pts.length;
  const den = pts.reduce((s0, q) => s0 + (q.frame - mf) ** 2, 0);
  return [0, 1].map((d) => {
    const mv = pts.reduce((s0, q) => s0 + q.box.center[d], 0) / pts.length;
    return pts.reduce((s0, q) => s0 + (q.frame - mf) * (q.box.center[d] - mv), 0) / den;
  });
}

/**
 * Đứt track: mỗi đoạn track kết thúc giữa job được ghép với tối đa một đoạn bắt đầu sau đó vài frame (cùng class, hai track
 * không cùng lúc có mặt), và ngược lại, bằng Hungarian trên chi phí chuẩn hoá:
 * - dự đoán vận tốc không đổi (từ hai keyframe sát chỗ đứt), hai chiều; độ bất định dọc hướng chạy tăng theo quãng
 *   đường đi trong khoảng đứt, ngang hướng chạy chỉ theo cỡ vật (xe làn bên không được nối);
 * - vận tốc hai đoạn phải gần nhau; kích thước lệch ít.
 * Cặp vượt ngưỡng nào cũng bị loại trước khi ghép. Ghép một-một nên hai xe nối đuôi không cùng nối vào một đoạn.
 */
function fragments(tracks, cfg, stop, coords = 'xe thu', display = tracks) {
  const segs = [];
  for (const t of tracks.values()) for (const seg of segments(t)) segs.push({ t, seg });
  const shown = new Map([...tracks.values()].map((t) => [t, shownFrames(t)]));
  // Hai track cùng có mặt ở một frame là hai vật khác nhau, không thể là một vật bị tách ID.
  const coexist = (a, b) => [...shown.get(a)].some((f) => shown.get(b).has(f));
  const norm = (v) => Math.hypot(...v);
  const ends = segs.filter(({ seg }) => seg.at(-1).frame < stop), starts = segs;
  const cand = ends.map(() => starts.map(() => Infinity)), info = new Map();
  ends.forEach(({ t: ta, seg: a }, i) => {
    const last = a.at(-1), va = endVelocity(a, true);
    starts.forEach(({ t: tb, seg: b }, j) => {
      const first = b[0], gap = first.frame - last.frame;
      // `maxGapFrames`: số frame trống giữa hai đoạn.
      if (tb === ta || tb.label !== ta.label || gap < 1 || gap - 1 > cfg.maxGapFrames || coexist(ta, tb)) return;
      const vb = endVelocity(b, false), v = va || vb;
      const speedTol = Math.max(cfg.minSpeedDiffM, cfg.maxSpeedRel * Math.max(va ? norm(va) : 0, vb ? norm(vb) : 0));
      const speedErr = va && vb ? norm(sub(va, vb)) : 0;
      if (speedErr > speedTol) return; // hướng hoặc tốc độ khác hẳn: hai vật (xe sau chậm hơn, xe ngược chiều)
      // Đoán hai chiều: đoạn trước đi tới frame đầu đoạn sau, đoạn sau lùi về frame cuối đoạn trước.
      const errs = [];
      if (va) errs.push(sub(last.box.center.slice(0, 2).map((x, d) => x + va[d] * gap), first.box.center.slice(0, 2)));
      if (vb) errs.push(sub(first.box.center.slice(0, 2).map((x, d) => x - vb[d] * gap), last.box.center.slice(0, 2)));
      if (!errs.length) errs.push(sub(last.box.center, first.box.center).slice(0, 2));
      // Ngưỡng theo cỡ vật (nón 45 cm: hai nón cách 1,3 m là hai vật; xe 4,5 m: lệch 1 m vẫn là một xe).
      const size = Math.min(cfg.maxDistM, Math.max(cfg.minDistM, cfg.sizeRatio * Math.max(last.box.dims[0], last.box.dims[1])));
      const u = v && norm(v) > 0.05 ? v.map((x) => x / norm(v)) : null;
      const alongTol = Math.max(size, cfg.distStepRatio * (v ? norm(v) : 0) * gap);
      let worst = 0;
      for (const e of errs) {
        const along = u ? Math.abs(e[0] * u[0] + e[1] * u[1]) : norm(e), cross = u ? Math.abs(e[0] * u[1] - e[1] * u[0]) : 0;
        if (along > alongTol || cross > size) return;
        worst = Math.max(worst, (along / alongTol) ** 2 + (cross / size) ** 2);
      }
      const dimsRel = Math.max(...first.box.dims.map((x, k) => Math.abs(x - last.box.dims[k]) / Math.max(last.box.dims[k], 0.1)));
      if (dimsRel > cfg.maxDimsRel) return;
      cand[i][j] = worst + (dimsRel / cfg.maxDimsRel) ** 2 + (speedErr / speedTol) ** 2 + 0.1 * (gap - 1);
      // Chỗ mỗi vật lẽ ra ở frame của vật kia (cho bằng chứng point cloud, evidence.js).
      const ghostStart = last.box.center.slice(0, 2).map((x, d) => x + (v ? v[d] : 0) * gap);
      const ghostEnd = first.box.center.slice(0, 2).map((x, d) => x - ((vb || v) ? (vb || v)[d] : 0) * gap);
      info.set(`${i},${j}`, { d: Math.max(...errs.map(norm)), gap, perFrame: v ? norm(v) : 0, ghostStart, ghostEnd });
    });
  });
  const out = [];
  for (const [i, j] of assign(cand)) {
    const { t: ta, seg: a } = ends[i], { t: tb, seg: b } = starts[j], last = a.at(-1), first = b[0], m0 = info.get(`${i},${j}`);
    // Hai box ở hai frame khác nhau: trong CVAT (toạ độ xe thu) chúng có thể trông cách xa nhau, nên ghi rõ khoảng cách đó
    // bằng đúng quãng vật đi trong khoảng đứt thì mới là một vật.
    // Khoảng cách theo toạ độ CVAT hiển thị (`display`), để QC đối chiếu được trên CVAT.
    const at = (t, f) => display.get(t.key).keyframes.find((k) => k.frame === f).box.center.slice(0, 2);
    const apart = dist(at(ta, last.frame), at(tb, first.frame)), m = (x) => `${x.toFixed(1).replace('.', ',')} m`;
    const shown = `trong CVAT hai box cách ${m(apart)}${display !== tracks ? ' (cả cảnh trôi theo xe thu)' : ''}`;
    const moved = m0.perFrame > 0.3 ? `vật đi ${m(m0.perFrame * m0.gap)} trong ${m0.gap} frame` : 'vật đứng yên';
    const why = `${shown}; theo toạ độ ${coords}, ${moved} và đoạn sau bắt đầu lệch chỗ đoán ${cm(m0.d)}`;
    // Hai frame: cuối đoạn trước và đầu đoạn sau, để QC mở được cả hai chỗ.
    for (const frame of [last.frame, first.frame]) {
      out.push({ objKey: ta.key, frame, keyframe: true, link: { endFrame: last.frame, startFrame: first.frame, ghostStart: m0.ghostStart, ghostEnd: m0.ghostEnd }, issue: {
        rule: 'track.fragment', severity: 'warning', title: 'Nghi đứt track (một vật, hai ID)', short: `có thể cùng vật với #${tb.key}`,
        message: `#${ta.key} hết ở frame ${last.frame}; ${tb.label} #${tb.key} bắt đầu ở frame ${first.frame} (${m0.gap - 1} frame trống); ${why}: nghi cùng một vật bị tách ID.`,
        otherClientId: tb.key } });
    }
  }
  return out;
}

const volume = (b) => b.dims[0] * b.dims[1] * b.dims[2];

/** Cùng class, cỡ gần bằng nhau, chồng nhiều (khác class thì luật chồng lấn chung đã báo). */
function duplicates(frames, cfg) {
  const runs = new Map(); // cặp → { a, b, frames: [] }
  for (const [f, objs] of [...frames.entries()].sort((x, y) => x[0] - y[0])) {
    for (let i = 0; i < objs.length; i += 1) {
      for (let j = i + 1; j < objs.length; j += 1) {
        const a = objs[i], b = objs[j];
        if (a.key === b.key || a.label !== b.label) continue;
        const va = volume(a.box), vb = volume(b.box);
        if (Math.min(va, vb) / Math.max(va, vb) < cfg.minVolumeRatio || B.overlapRatio(a.box, b.box) < cfg.minRatio) continue;
        const key = [a.key, b.key].sort().join('+');
        if (!runs.has(key)) runs.set(key, { a, b, frames: [] });
        runs.get(key).frames.push(f);
      }
    }
  }
  const out = [];
  for (const { a, b, frames: fs } of runs.values()) {
    // Dài nhất các frame liền nhau.
    let best = 1, cur = 1;
    for (let i = 1; i < fs.length; i += 1) { cur = fs[i] === fs[i - 1] + 1 ? cur + 1 : 1; best = Math.max(best, cur); }
    if (best < cfg.minFrames) continue;
    for (const f of fs) {
      out.push({ objKey: a.key, frame: f, keyframe: true, issue: {
        rule: 'track.duplicate', severity: 'error', title: 'Nghi một vật vẽ hai lần', short: `trùng ${b.label} #${b.key}`,
        message: `${a.label} #${a.key} và ${b.label} #${b.key} cỡ gần bằng nhau, chồng ≥ ${Math.round(cfg.minRatio * 100)}% ở ${fs.length} frame (${best} frame liền): nghi một vật vẽ hai lần.`,
        otherClientId: b.key } });
    }
  }
  return out;
}

/**
 * Nhiều track cùng "nhảy" ở một frame là do cả frame (xe thu tăng tốc / rẽ, thời điểm frame lệch, pre-label lỗi cả
 * frame), không phải lỗi từng track: bỏ các mục đó, ghi một dòng cấp frame cho QC xem.
 */
function commonJumps(hits, tracks, q) {
  // Lệch thời điểm frame chỉ làm lệch vật đang chạy, nên so với số track đang chạy (toạ độ đã bù chuyển động xe thu).
  const moving = new Map(); // frame → Set(track)
  for (const t of tracks.values()) {
    for (const seg of segments(t)) {
      for (let i = 1; i < seg.length; i += 1) {
        const speed = dist(seg[i].box.center, seg[i - 1].box.center) / (seg[i].frame - seg[i - 1].frame);
        if (speed < q.common.movingM) continue;
        for (const f of [seg[i - 1].frame, seg[i].frame]) (moving.get(f) || moving.set(f, new Set()).get(f)).add(t.key);
      }
    }
  }
  const byFrame = new Map();
  for (const h of hits) if (h.issue.rule === 'track.jump') (byFrame.get(h.frame) || byFrame.set(h.frame, new Set()).get(h.frame)).add(h.objKey);
  const frames = [...byFrame].map(([frame, keys]) => ({ frame, tracks: keys.size, of: new Set([...(moving.get(frame) || []), ...keys]).size }))
    .filter((x) => x.tracks >= q.common.minTracks && x.tracks >= q.common.minShare * x.of);
  const drop = new Set(frames.map((x) => x.frame));
  return { kept: hits.filter((h) => !(h.issue.rule === 'track.jump' && drop.has(h.frame))), frames };
}

/** Phép quay + tịnh tiến 2D khớp nhất `src` → `dst` (bình phương tối thiểu): { c, s, tx, ty }. */
function fitRigid(src, dst) {
  const n = src.length, mean = (p) => [p.reduce((a, v) => a + v[0], 0) / n, p.reduce((a, v) => a + v[1], 0) / n];
  const [sx, sy] = mean(src), [dx, dy] = mean(dst);
  let a = 0, b = 0;
  for (let i = 0; i < n; i += 1) {
    const x = src[i][0] - sx, y = src[i][1] - sy, u = dst[i][0] - dx, v = dst[i][1] - dy;
    a += x * u + y * v; b += x * v - y * u;
  }
  const r = Math.hypot(a, b) || 1, c = a / r, s = b / r;
  return { c, s, tx: dx - (c * sx - s * sy), ty: dy - (s * sx + c * sy) };
}
const apply = (T, p) => [T.c * p[0] - T.s * p[1] + T.tx, T.s * p[0] + T.c * p[1] + T.ty, p[2]];
const compose = (A, Bt) => ({ c: A.c * Bt.c - A.s * Bt.s, s: A.s * Bt.c + A.c * Bt.s, tx: A.c * Bt.tx - A.s * Bt.ty + A.tx, ty: A.s * Bt.tx + A.c * Bt.ty + A.ty }); // A ∘ B
const invert = (T) => ({ c: T.c, s: -T.s, tx: -(T.c * T.tx + T.s * T.ty), ty: -(-T.s * T.tx + T.c * T.ty) });
const IDENTITY = { c: 1, s: 0, tx: 0, ty: 0 };

/**
 * Phép biến đổi được nhiều cặp đồng ý nhất (RANSAC vét hết cặp 2 điểm): vật đứng yên khớp nhau tới vài cm, xe đang chạy
 * mỗi chiếc một kiểu nên không thành đa số. Cần ≥ 3 cặp khớp trong `tolM`; không thì null.
 */
function consensus(src, dst, tolM = 0.3) {
  const n = src.length;
  if (n < 3) return null;
  /** Cặp khớp trong `tolM` và tổng sai lệch của chúng. */
  const inliers = (T) => src.reduce((acc, p, j) => {
    const q = apply(T, p), e = Math.hypot(q[0] - dst[j][0], q[1] - dst[j][1]);
    if (e <= tolM) { acc.ids.push(j); acc.err += e; }
    return acc;
  }, { ids: [], err: 0 });
  let best = { ids: [], err: Infinity };
  // shortcut: vét O(n²) cặp, đủ nhanh tới ~150 track mỗi frame; nhiều hơn thì lấy mẫu ngẫu nhiên.
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (Math.hypot(src[i][0] - src[j][0], src[i][1] - src[j][1]) < 2) continue; // hai điểm quá gần: góc quay không chắc
      const ins = inliers(fitRigid([src[i], src[j]], [dst[i], dst[j]]));
      // Bằng số cặp thì lấy bên khớp sát hơn: vật đứng yên khớp tới vài cm, phép nối một xe đang chạy với vật đứng yên
      // chỉ "khớp" thêm được vật ở gần nhờ ngưỡng `tolM`.
      if (ins.ids.length > best.ids.length || (ins.ids.length === best.ids.length && ins.err < best.err)) best = ins;
    }
  }
  best = best.ids;
  return best.length >= 3 ? fitRigid(best.map((j) => src[j]), best.map((j) => dst[j])) : null;
}

/**
 * Chuyển động xe thu ước lượng từ chính nhãn: CVAT không lưu pose, point cloud theo toạ độ xe thu nên vật đứng yên vẫn
 * "chạy" theo xe (rào chắn trôi 5 m mỗi frame ở scene-0061). Với mỗi cặp frame liền nhau, tìm phép quay + tịnh tiến mà
 * các vật đứng yên đồng ý (`consensus`). Trả về Map frame → phép biến đổi từ toạ độ frame đó sang toạ độ frame đầu.
 * Không đủ vật đứng yên thì giữ chuyển động của bước trước (xe thu chạy đều).
 */
function egoPoses(tracks) {
  const at = new Map(); // frame → Map(track → tâm)
  for (const t of tracks.values()) for (const k of t.keyframes) {
    if (k.outside || !k.box) continue;
    if (!at.has(k.frame)) at.set(k.frame, new Map());
    at.get(k.frame).set(t.key, k.box.center);
  }
  const frames = [...at.keys()].sort((a, b) => a - b), poses = new Map();
  let world = IDENTITY, last = IDENTITY;
  frames.forEach((f, i) => {
    if (i > 0) {
      const prev = at.get(frames[i - 1]), cur = at.get(f), src = [], dst = [];
      for (const [key, p] of cur) if (prev.has(key)) { src.push(p); dst.push(prev.get(key)); }
      const T = consensus(src, dst);
      if (T) last = T;
      world = compose(world, last); // toạ độ frame f → frame trước → … → frame đầu
    }
    poses.set(f, world);
  });
  return poses;
}

/** Bản sao các track với tâm box đổi sang toạ độ frame đầu (vật đứng yên thì đứng yên). */
function toWorld(tracks, poses) {
  const out = new Map();
  for (const [key, t] of tracks) {
    out.set(key, { ...t, keyframes: t.keyframes.map((k) => (k.outside || !k.box || !poses.has(k.frame) ? k
      : { ...k, box: { ...k.box, center: apply(poses.get(k.frame), k.box.center) } })) });
  }
  return out;
}

/** Nhảy, đổi ID trên một hệ toạ độ. */
function motionRules(tracks, g, q, stop) {
  const hits = [], breaks = [];
  for (const t of tracks.values()) {
    const nonRigid = g.size.nonRigidClasses.includes(t.label);
    for (const seg of segments(t)) {
      const { out, flagged } = jumpsInSegment(t, seg, q.jump, nonRigid);
      hits.push(...out);
      breaks.push(...breaksInSegment(t, seg, q.jump, flagged));
    }
  }
  hits.push(...swapsAndBreaks(breaks));
  const { kept, frames } = commonJumps(hits, tracks, q);
  return { hits: kept, frames };
}

/**
 * Mọi luật cấp track. `g`: guideline đã resolve; `q`: ngưỡng QC đã merge.
 * Luật chuyển động chạy hai lần: theo toạ độ xe thu (như CVAT lưu) và theo toạ độ đã bù chuyển động xe thu ước lượng từ
 * nhãn / point cloud; báo khi cả hai cùng báo, riêng box nhảy của vật đứng yên thì chỉ cần toạ độ đã bù (khi có pose từ
 * point cloud). Đo trên 4 job chuẩn: xe thu chạy nhanh giữa nhiều rào chắn (scene-0061) thì toạ độ xe thu báo nhầm hàng trăm
 * mục; đường cao tốc ít vật đứng yên (scene-1077) thì ước lượng chuyển động sai và chỉ dùng toạ độ đã bù báo nhầm 14 mục.
 * Đo 28/10/2026 (12 box nhảy cài mỗi job × 3 cỡ, 4 job): bắt 1,0 / 1,5 / 2,0 m: 29 / 39 / 42 trên 48 (luật cũ 18 / 31 / 35),
 * báo nhầm trên nhãn chuẩn 5 mục (cũ 3).
 * Trả về { hits (như scanJob), commonFrames: [{ frame, tracks, of }] }.
 */
function trackRules({ tracks, frames, stop, poses = null }, g, q) {
  // `poses`: chuyển động xe thu khớp từ point cloud (icp.js); không có thì ước lượng từ nhãn (kém hơn khi ít vật đứng yên).
  const worldTracks = toWorld(tracks, poses || egoPoses(tracks));
  const sensor = motionRules(tracks, g, q, stop), world = motionRules(worldTracks, g, q, stop);
  // Cùng luật, cùng object, cùng frame và cùng object kia (đổi ID, đứt track phải nối đúng một cặp ở cả hai hệ toạ độ).
  const id = (h) => `${h.issue.rule}|${h.objKey}|${h.frame}|${h.issue.otherClientId || ''}`;
  const inWorld = new Set(world.hits.map(id));
  const commonFrames = [...new Map([...sensor.frames, ...world.frames].map((x) => [x.frame, x])).values()].sort((a, b) => a.frame - b.frame);
  // Đứt track: báo khi một trong hai hệ toạ độ nối được. Phép thử cỡ vật + vận tốc đã chặn báo nhầm, còn đòi cả hai
  // thì bỏ sót nửa số ca cài (xe thu rẽ thì toạ độ xe thu lệch, cao tốc ít vật đứng yên thì ước lượng chuyển động lệch).
  const centerAt = (key, f) => worldTracks.get(key)?.keyframes.find((k) => k.frame === f && !k.outside)?.box.center;
  // Toạ độ xe thu nối nhầm hai vật đứng yên xếp hàng dọc đường (hàng nón, rào chắn) khi xe thu đổi tốc độ. Ở toạ độ đã bù,
  // vật đứng yên đứng yên thật: hai đoạn cách nhau hơn cỡ vật thì là hai vật.
  const staticApart = (h) => {
    const a = worldTracks.get(h.objKey), b = worldTracks.get(h.issue.otherClientId);
    const pa = centerAt(h.objKey, h.link.endFrame), pb = centerAt(h.issue.otherClientId, h.link.startFrame);
    const still = (t, f) => { const k = t.keyframes.filter((x) => !x.outside && x.box), i = k.findIndex((x) => x.frame === f), n = k[i + 1] || k[i - 1];
      return !n || dist(n.box.center, k[i].box.center) / Math.abs(n.frame - f) < q.common.movingM; };
    if (!pa || !pb || !still(a, h.link.endFrame) || !still(b, h.link.startFrame)) return false;
    const size = Math.min(q.fragment.maxDistM, Math.max(q.fragment.minDistM, q.fragment.sizeRatio * Math.max(...a.keyframes.find((x) => x.box).box.dims.slice(0, 2))));
    return dist(pa.slice(0, 2), pb.slice(0, 2)) > size;
  };
  // Có chuyển động xe thu từ point cloud thì toạ độ đã bù đáng tin: chỉ dùng nó. Không có thì gộp hai hệ như trên.
  // Cùng một cặp ở cả hai hệ thì giữ lời nhắn theo toạ độ xe thu: đó là toạ độ QC thấy trong CVAT.
  const frag = new Map((poses ? fragments(worldTracks, q.fragment, stop, 'đã bù chuyển động xe thu', tracks)
    : [...fragments(worldTracks, q.fragment, stop, 'đã bù chuyển động xe thu'), ...fragments(tracks, q.fragment, stop).filter((h) => !staticApart(h))])
    .map((h) => [id(h), h]));
  // Vật đứng yên (theo toạ độ đã bù, quanh frame bị báo) chỉ cần toạ độ đã bù báo: trong toạ độ xe thu nó trôi theo xe thu nên
  // box lệch dọc đường bị coi như xe thu đổi tốc độ. Chuyển động xe thu ước lượng sai thì lệch cả frame, đã bị commonJumps bỏ.
  const stillAt = (h) => {
    const k = worldTracks.get(h.objKey)?.keyframes.filter((x) => !x.outside && x.box) || [], i = k.findIndex((x) => x.frame === h.frame);
    const near = [k[i - 2], k[i - 1], k[i + 1], k[i + 2]].filter(Boolean);
    for (let a = 0; a < near.length; a += 1) for (let b = a + 1; b < near.length; b += 1) {
      if (dist(near[a].box.center.slice(0, 2), near[b].box.center.slice(0, 2)) / Math.abs(near[b].frame - near[a].frame) >= q.common.movingM) return false;
    }
    return near.length >= 2;
  };
  const inSensor = new Set(sensor.hits.map(id));
  const motion = world.hits.filter((h) => inSensor.has(id(h)) || (poses && h.issue.rule === 'track.jump' && stillAt(h)));
  return { hits: [...motion, ...frag.values(), ...duplicates(frames, q.duplicate)], commonFrames };
}

module.exports = { QC_DEFAULTS, validateQc, trackRules, segments, egoPoses, invert, fragments, toWorld, assign };
