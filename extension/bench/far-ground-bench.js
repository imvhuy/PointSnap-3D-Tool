'use strict';
/*
 * Lơ lửng / lún tới 80 m mà không cần tư thế xe cả chuỗi: đo ba cách so với luật hiện tại, theo dải khoảng cách.
 * - Hiện tại: luật mặt đất (ô đất quanh 4 góc), tầm 50 m; và cùng luật nới tầm 80 m.
 * - A, chặn theo chính vật: đáy box ≥ điểm cao nhất của vật − chiều cao track, và ≤ điểm thấp nhất trong footprint.
 * - B, mặt đường quanh box: khớp mặt phẳng bền qua điểm thấp nhất mỗi ô 1 m và đáy các box lân cận, bán kính tăng theo
 *   khoảng cách; chỉ kết luận khi mặt phẳng khớp tốt.
 * - C, gộp đất ±2 frame: khớp từng cặp frame liền nhau (odometry.js), gộp điểm (bỏ điểm trong box) vào frame đang xét,
 *   chạy luật mặt đất hiện tại tầm 80 m.
 * Cài lỗi: nâng / hạ đáy 30 và 50 cm từng box nhãn chuẩn; báo đúng chiều mới tính là bắt.
 *
 *   node extension/bench/far-ground-bench.js --nuscenes <thư mục> [--scenes a,b] [--av2 <thư mục av2_cvat>]
 */
const B = require('../src/annotator/box.js');
const Grid = require('../src/annotator/spatial-grid.js');
const Terrain = require('../src/annotator/terrain.js');
const Checks = require('../src/annotator/checks.js');
const Measure = require('../src/annotator/measure.js');
const G = require('../src/annotator/guideline.js');
const D = require('./datasets.js');
const Odo = require('./odometry.js');

const BINS = [[0, 30], [30, 50], [50, 80]];
const SHIFTS = [0, 0.3, 0.5, -0.3, -0.5];
const METHODS = ['hiện tại (50 m)', 'hiện tại nới 80 m', 'A: theo chính vật', 'B: mặt đường quanh box', 'C: gộp ±2 frame', 'A hoặc B hoặc C'];
const TOL = 0.2; // ngưỡng Cảnh báo hiện tại
const WINDOW = 2;

const g50 = G.DEFAULT_GUIDELINE;
const g80 = G.resolve({ ground: { maxRangeM: 80 } }).guideline;

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
  return o;
}

const shiftZ = (box, dz) => ({ ...box, center: [box.center[0], box.center[1], box.center[2] + dz] });
const insideAny = (boxes, x, y, z, margin) => boxes.some((b) => {
  if (Math.abs(x - b.center[0]) > b.dims[0] + margin + 3 || Math.abs(y - b.center[1]) > b.dims[0] + margin + 3) return false;
  return B.toLocal(b, [x, y, z]).every((v, k) => Math.abs(v) <= b.dims[k] / 2 + margin);
});

/** Luật hiện tại: độ lệch có dấu khi đủ tin, null khi không kết luận. */
function current(frame, target, others, g) {
  const r = Measure.measureBox(frame, target, others, null, g);
  if (!Checks.usableContact(r.contact, target.box, g)) return null;
  const flagged = r.issues.find((i) => (i.rule === 'ground.gap' || i.rule === 'ground.points_below') && i.severity !== 'info');
  return flagged ? (i => (i.rule === 'ground.gap' ? r.contact.gapM : 1))(flagged) : 0;
}

/** A: { gap } theo chính vật; null khi quá ít điểm của vật. */
function ownBounds(grid, pos, box, height, others) {
  const bottom = B.bottomZ(box), top = bottom + box.dims[2];
  let hi = -Infinity, lo = Infinity, n = 0;
  for (const i of Grid.pointsNearBox(grid, box, 0)) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    if (z < bottom - 1 || z > top + 1 || insideAny(others, x, y, z, 0.1)) continue;
    n += 1; if (z > hi) hi = z; if (z < lo) lo = z;
  }
  if (n < 5) return null;
  if (bottom < hi - height - TOL) return bottom - (hi - height);
  if (bottom > lo + TOL) return bottom - lo;
  return 0;
}

/** B: mặt phẳng bền quanh box từ đất thưa + đáy box lân cận; độ lệch có dấu hoặc null. */
function roadPlane(grid, pos, box, allBoxes, others) {
  const r = B.rangeXY(box), R = Math.max(5, 0.15 * r), [cx, cy] = box.center;
  const cells = new Map();
  for (const i of Grid.pointsNearBox(grid, { center: box.center, dims: [2 * R, 2 * R, 1], rotation: [0, 0, 0] }, 0)) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    if (Math.hypot(x - cx, y - cy) > R || insideAny(allBoxes, x, y, z, 0.3)) continue;
    const k = `${Math.floor(x)},${Math.floor(y)}`;
    if (!cells.has(k) || cells.get(k)[2] > z) cells.set(k, [x, y, z, 1]);
  }
  let pts = [...cells.values()];
  for (const o of others) {
    if (Math.hypot(o.center[0] - cx, o.center[1] - cy) <= R) pts.push([o.center[0], o.center[1], B.bottomZ(o), 3]);
  }
  if (pts.length < 6) return null;
  const zs = pts.map((p) => p[2]).sort((a, b) => a - b), floor = zs[Math.floor(zs.length * 0.3)];
  pts = pts.filter((p) => p[2] < floor + 1);
  let plane = null;
  for (let it = 0; it < 5 && pts.length >= 6; it += 1) {
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], t = [0, 0, 0];
    for (const [x, y, z, w] of pts) {
      const v = [1, x - cx, y - cy];
      for (let a = 0; a < 3; a += 1) { t[a] += w * v[a] * z; for (let b = 0; b < 3; b += 1) S[a][b] += w * v[a] * v[b]; }
    }
    plane = solve3(S, t);
    if (!plane) return null;
    const res = (p) => p[2] - (plane[0] + plane[1] * (p[0] - cx) + plane[2] * (p[1] - cy));
    const keep = pts.filter((p) => res(p) < 0.15 && res(p) > -0.5);
    if (keep.length === pts.length) break;
    pts = keep;
  }
  if (!plane || pts.length < 6) return null;
  const quads = new Set(pts.map((p) => (p[0] >= cx ? 1 : 0) + (p[1] >= cy ? 2 : 0)));
  const sd = Math.sqrt(pts.reduce((s, p) => s + (p[2] - (plane[0] + plane[1] * (p[0] - cx) + plane[2] * (p[1] - cy))) ** 2, 0) / pts.length);
  if (quads.size < 2 || sd > 0.15) return null;
  const heights = B.footprint(box).map(([x, y]) => plane[0] + plane[1] * (x - cx) + plane[2] * (y - cy));
  const bottom = B.bottomZ(box), lo = Math.min(...heights), hi = Math.max(...heights);
  const gap = bottom > hi ? bottom - hi : bottom < lo ? bottom - lo : 0;
  return Math.abs(gap) > TOL ? gap : 0;
}

function solve3(A, b) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(A);
  if (Math.abs(d) < 1e-9) return null;
  return [0, 1, 2].map((c) => det(A.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)))) / d);
}

/** C: điểm của frame k cộng các frame k ± WINDOW (bỏ điểm trong box của frame đó), đổi về hệ frame k. */
function accumulate(seq, steps, k) {
  const chunks = [seq.frames[k].positions];
  for (let j = Math.max(0, k - WINDOW); j <= Math.min(seq.frames.length - 1, k + WINDOW); j += 1) {
    if (j === k) continue;
    // T: hệ frame j → hệ frame k, nối các bước liền nhau (steps[m]: frame m → frame m − 1).
    let T = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] }, ok = true;
    if (j > k) for (let m = j; m > k; m -= 1) { T = D.compose(steps[m].T, T); ok = ok && steps[m].inliers > 0.4; }
    else for (let m = j + 1; m <= k; m += 1) { T = D.compose(D.invert(steps[m].T), T); ok = ok && steps[m].inliers > 0.4; }
    if (!ok) continue; // khớp kém: bỏ frame đó, không đoán
    const f = seq.frames[j], boxes = f.boxes.map((b) => b.box), p = f.positions, out = [];
    for (let i = 0; i < p.length; i += 3) {
      if (insideAny(boxes, p[i], p[i + 1], p[i + 2], 0.3)) continue;
      out.push(...D.applyT(T, [p[i], p[i + 1], p[i + 2]]));
    }
    chunks.push(Float32Array.from(out));
  }
  const all = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

function odometrySteps(seq) {
  const prepared = seq.frames.map((f) => Odo.prepare(f.positions, f.boxes.map((b) => b.box)));
  const steps = [null];
  let target = Odo.target(prepared[0]), guess;
  for (let k = 1; k < seq.frames.length; k += 1) {
    const res = Odo.register(prepared[k], target, guess);
    steps.push(res);
    guess = res.T;
    target = Odo.target(prepared[k]);
  }
  return steps;
}

const newStats = () => BINS.map(() => Object.fromEntries(METHODS.map((m) => [m, Object.fromEntries(SHIFTS.map((s) => [s, { n: 0, flagged: 0, covered: 0 }]))])));

function runSequence(seq, stats) {
  const steps = odometrySteps(seq);
  seq.frames.forEach((f, k) => {
    const boxes = f.boxes.map((b) => b.box);
    const frame50 = Measure.buildFrame(f.positions, boxes, g50);
    const acc = accumulate(seq, steps, k);
    const accFrame = Measure.buildFrame(acc, boxes, g80);
    const all = f.boxes.map((b, i) => ({ box: b.box, label: b.label, attributes: {}, clientId: i }));
    f.boxes.forEach((b, i) => {
      const bin = BINS.findIndex(([lo, hi]) => { const r = B.rangeXY(b.box); return r >= lo && r < hi; });
      if (bin < 0) return;
      const others = all.filter((_, j) => j !== i), otherBoxes = others.map((o) => o.box);
      for (const dz of SHIFTS) {
        const box = shiftZ(b.box, dz), target = { ...all[i], box };
        const verdicts = {
          'hiện tại (50 m)': current(frame50, target, others, g50),
          'hiện tại nới 80 m': current(frame50, target, others, g80),
          'A: theo chính vật': ownBounds(frame50.grid, f.positions, box, b.box.dims[2], otherBoxes),
          'B: mặt đường quanh box': roadPlane(frame50.grid, f.positions, box, boxes, otherBoxes),
          'C: gộp ±2 frame': current(accFrame, target, others, g80),
        };
        const any = Object.entries(verdicts).filter(([m]) => m.startsWith('A') || m.startsWith('B') || m.startsWith('C')).map(([, v]) => v);
        verdicts['A hoặc B hoặc C'] = any.every((v) => v === null) ? null : any.find((v) => v && Math.sign(v) === Math.sign(dz || v)) || 0;
        for (const [m, v] of Object.entries(verdicts)) {
          const s = stats[bin][m][dz];
          s.n += 1;
          if (v === null) continue;
          s.covered += 1;
          // Box đúng: báo bất kỳ chiều nào là báo nhầm; box cài lỗi: phải báo đúng chiều.
          if (dz === 0 ? v !== 0 : v !== 0 && Math.sign(v) === Math.sign(dz)) s.flagged += 1;
        }
      }
    });
  });
}

function report(title, stats) {
  const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '—');
  const line = (c) => `| ${c.join(' | ')} |`;
  const out = [`### ${title}`, ''];
  for (const [bi, [lo, hi]] of BINS.entries()) {
    out.push(`**${lo}–${hi} m** (${stats[bi][METHODS[0]][0].n} box)`, '', line(['Cách', 'Kết luận được', 'Báo nhầm', 'Bắt +30', 'Bắt +50', 'Bắt −30', 'Bắt −50']), line(new Array(7).fill('---')));
    for (const m of METHODS) {
      const s = stats[bi][m];
      out.push(line([m, pct(s[0].covered, s[0].n), pct(s[0].flagged, s[0].n), ...[0.3, 0.5, -0.3, -0.5].map((dz) => pct(s[dz].flagged, s[dz].n))]));
    }
    out.push('');
  }
  return out.join('\n');
}

function main() {
  const o = args();
  if (o.nuscenes) {
    const scenes = o.scenes ? o.scenes.split(',') : D.nusScenes(o.nuscenes), stats = newStats();
    for (const sc of scenes) {
      const t0 = Date.now();
      runSequence(D.loadNuScenes(o.nuscenes, sc), stats);
      process.stderr.write(`${sc}: ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
    }
    console.log(report(`nuScenes mini (${scenes.length} cảnh, keyframe 2 Hz)`, stats));
  }
  if (o.av2) {
    const stats = newStats();
    runSequence(D.loadAv2(o.av2), stats);
    console.log(report('Argoverse 2 (1 log, 40 frame 10 Hz)', stats));
  }
}

main();
