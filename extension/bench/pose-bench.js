'use strict';
/*
 * Bước 1: tự khớp tư thế xe thu từ point cloud (odometry.js) rồi so với pose thật của bộ dữ liệu.
 * - Từng cặp frame liền nhau: sai số tịnh tiến, roll / pitch / yaw; cặp hỏng (lệch > 0,5 m hoặc > 2°).
 * - Theo quãng đường: điểm mặt đất ngay dưới xe ở frame b đổi về frame a (a < b), so với chuỗi pose thật. Đây là phép
 *   "mặt đất xe sắp đi qua" của hướng 3 (kiểm tới 80 m). Hai cách: nối chuỗi các cặp liền nhau (sai số cộng dồn), và
 *   khớp thẳng frame b vào frame a lấy chuỗi làm điểm xuất phát (`--stride` frame một lần, vì tốn thời gian). nuScenes ghi z của xe luôn bằng 0, nên ở
 *   nuScenes chỉ tin được sai số ngang và sai số góc (chiều đứng suy từ pitch: quãng đường × tan(sai số pitch));
 *   Argoverse 2 có pose đủ 6 bậc.
 *
 *   node extension/bench/pose-bench.js --nuscenes <thư mục> [--scenes a,b] [--sweeps 1] [--stride n] [--av2 <thư mục av2_cvat>] [--out kq.json]
 */
const fs = require('fs');
const D = require('./datasets.js');
const Odo = require('./odometry.js');

const DEG = 180 / Math.PI;
const BINS = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 100]];
const quant = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
  return o;
}

/** Khớp cả chuỗi: T[k] đổi toạ độ frame k sang frame k − 1 (T[0] không dùng). */
function odometry(seq, o = Odo.OPT) {
  const prepared = seq.frames.map((f) => Odo.prepare(f.positions, f.boxes.map((b) => b.box), o));
  const steps = [null];
  let target = Odo.target(prepared[0]), guess;
  for (let k = 1; k < seq.frames.length; k += 1) {
    const res = Odo.register(prepared[k], target, guess);
    steps.push(res);
    guess = res.T; // chuyển động đều: frame sau đoán bằng bước vừa rồi
    target = Odo.target(prepared[k]);
  }
  return { steps, prepared };
}

function evaluate(seq, steps, groundUnderSensor, stats, stride, prepared) {
  const targets = new Map(), targetOf = (k) => { if (!targets.has(k)) targets.set(k, Odo.target(prepared[k])); return targets.get(k); };
  const P = seq.frames.map((f) => f.pose);
  for (let k = 1; k < P.length; k += 1) {
    const gt = D.compose(D.invert(P[k - 1]), P[k]), err = D.compose(D.invert(gt), steps[k].T), e = D.eulerZYX(err.R);
    const dt = Math.hypot(...err.t), dyaw = Math.abs(e.yaw) * DEG;
    stats.pairs.push({ dt, dxy: Math.hypot(err.t[0], err.t[1]), dz: Math.abs(err.t[2]), roll: Math.abs(e.roll) * DEG, pitch: Math.abs(e.pitch) * DEG, yaw: dyaw, move: Math.hypot(...gt.t) });
    if (dt > 0.5 || dyaw > 2) stats.failed += 1;
  }
  for (let a = 0; a < P.length; a += 1) {
    let est = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };
    for (let b = a + 1; b < P.length; b += 1) {
      est = D.compose(est, steps[b].T);
      const gt = D.compose(D.invert(P[a]), P[b]);
      const dist = Math.hypot(P[b].t[0] - P[a].t[0], P[b].t[1] - P[a].t[1]);
      const bin = BINS.findIndex(([lo, hi]) => dist >= lo && dist < hi);
      if (bin < 0) continue;
      const record = (into, T) => {
        const pe = D.applyT(T, groundUnderSensor), pg = D.applyT(gt, groundUnderSensor), err = D.compose(D.invert(gt), T);
        into.xy.push(Math.hypot(pe[0] - pg[0], pe[1] - pg[1]));
        into.z.push(Math.abs(pe[2] - pg[2]));
        into.pitch.push(Math.abs(D.eulerZYX(err.R).pitch) * DEG);
        if (Math.hypot(...err.t) > 0.5 || Math.abs(D.eulerZYX(err.R).yaw) * DEG > 2) into.failed += 1;
      };
      record(stats.chain[bin], est);
      if (a % stride === 0 && (b - a) % stride === 0) record(stats.direct[bin], Odo.register(prepared[b], targetOf(a), est).T);
    }
  }
}

const bins = () => BINS.map(() => ({ xy: [], z: [], pitch: [], failed: 0 }));
const newStats = () => ({ pairs: [], failed: 0, chain: bins(), direct: bins() });

function report(title, s, zTrusted) {
  const cm = (v) => (v === null ? '—' : `${(v * 100).toFixed(1)} cm`);
  const deg = (v) => (v === null ? '—' : `${v.toFixed(3)}°`);
  const pairs = s.pairs;
  const lines = [`### ${title}`, '',
    `Cặp frame: ${pairs.length}, hỏng (> 0,5 m hoặc > 2°): ${s.failed}. Xe đi mỗi cặp: trung vị ${quant(pairs.map((p) => p.move), 0.5)?.toFixed(2)} m.`, '',
    '| Sai số một cặp | p50 | p90 | max |', '| --- | --- | --- | --- |'];
  for (const [name, k, fmt] of [['Tịnh tiến ngang', 'dxy', cm], ['Độ cao', 'dz', cm], ['Roll', 'roll', deg], ['Pitch', 'pitch', deg], ['Yaw', 'yaw', deg]]) {
    if (k === 'dz' && !zTrusted) continue;
    const v = pairs.map((p) => p[k]);
    lines.push(`| ${name} | ${fmt(quant(v, 0.5))} | ${fmt(quant(v, 0.9))} | ${fmt(quant(v, 1))} |`);
  }
  lines.push('', '| Mặt đất dưới xe ở frame sau, đổi về frame trước | ' + BINS.map(([a, b]) => `${a}–${b} m`).join(' | ') + ' |',
    '| --- |' + BINS.map(() => ' --- |').join(''));
  for (const [name, rows] of [['nối chuỗi', s.chain], ['khớp thẳng', s.direct]]) {
    lines.push(`| **${name}**: số cặp (hỏng) | ` + rows.map((c) => `${c.xy.length} (${c.failed})`).join(' | ') + ' |');
    lines.push('| lệch ngang p50 / p90 | ' + rows.map((c) => `${cm(quant(c.xy, 0.5))} / ${cm(quant(c.xy, 0.9))}`).join(' | ') + ' |');
    if (zTrusted) lines.push('| lệch độ cao p50 / p90 | ' + rows.map((c) => `${cm(quant(c.z, 0.5))} / ${cm(quant(c.z, 0.9))}`).join(' | ') + ' |');
    lines.push('| sai pitch p50 / p90 | ' + rows.map((c) => `${deg(quant(c.pitch, 0.5))} / ${deg(quant(c.pitch, 0.9))}`).join(' | ') + ' |');
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const o = args(), out = {};
  if (o.nuscenes) {
    const scenes = o.scenes ? o.scenes.split(',') : D.nusScenes(o.nuscenes), stats = newStats();
    for (const sc of scenes) {
      const t0 = Date.now(), seq = D.loadNuScenes(o.nuscenes, sc, { sweeps: !!o.sweeps });
      // Sweep: box lấy từ keyframe gần nhất, vật đang chạy lệch tới 0,25 s nên nới lề bỏ điểm quanh box.
      const { steps, prepared } = odometry(seq, o.sweeps ? { ...Odo.OPT, boxMargin: 1.5 } : Odo.OPT);
      // Mặt đất ngay dưới LiDAR: cảm biến cao ~1,84 m trên mặt đường (calibrated_sensor của nuScenes).
      evaluate(seq, steps, [0, 0, -1.84], stats, Number(o.stride || 2), prepared);
      process.stderr.write(`${sc}: ${((Date.now() - t0) / 1000).toFixed(0)} s, hỏng tới giờ ${stats.failed}\n`);
    }
    console.log(report(`nuScenes mini (${scenes.length} cảnh, ${o.sweeps ? 'sweep 20 Hz' : 'keyframe 2 Hz'}; z của pose gốc luôn 0 nên không đo độ cao trực tiếp)`, stats, false));
    out.nuscenes = stats;
  }
  if (o.av2) {
    const seq = D.loadAv2(o.av2), stats = newStats();
    const { steps, prepared } = odometry(seq);
    evaluate(seq, steps, [0, 0, 0], stats, Number(o.stride || 2), prepared); // hệ ego AV2: gốc ở mặt đất dưới trục sau
    console.log(report('Argoverse 2 (1 log, 40 frame 10 Hz, pose đủ 6 bậc)', stats, true));
    out.av2 = stats;
  }
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(out));
}

main();
