'use strict';
/*
 * Bước 0: đo luật dùng chung (annotator + QC) theo dải khoảng cách tới xe thu, trên nhãn chuẩn công khai.
 * - Báo nhầm: box nhãn chuẩn bị báo Cảnh báo / Lỗi, theo nhóm luật.
 * - Độ phủ: box mà luật mặt đất đo được (độ tin cậy đủ, trong tầm).
 * - Độ bắt: cài từng lỗi vào một box (nâng / hạ đáy, nâng thô, kéo dài, lật hướng 180° một keyframe) rồi xem luật đúng
 *   nhóm có báo không.
 * Gần đúng: bản đồ địa hình dựng với box nhãn chuẩn (như CVAT khi box đúng); box cài lỗi chỉ đổi phần đo của chính nó.
 *
 *   node extension/bench/rules-bench.js --nuscenes <thư mục nuScenes> [--scenes a,b] [--av2 <thư mục av2_cvat>] [--out kq.json]
 */
const fs = require('fs');
const B = require('../src/annotator/box.js');
const Checks = require('../src/annotator/checks.js');
const Measure = require('../src/annotator/measure.js');
const G = require('../src/annotator/guideline.js');
const D = require('./datasets.js');

const BINS = [[0, 30], [30, 50], [50, 80]];
const binOf = (r) => BINS.findIndex(([a, b]) => r >= a && r < b);
const familyOf = (rule) => (rule.startsWith('ground.') ? 'ground' : rule.split('.')[0] === 'size' ? rule : rule.startsWith('overlap') ? 'overlap' : rule.split('.')[0] === 'spec' ? 'spec' : rule);

const shift = (box, dz) => ({ ...box, center: [box.center[0], box.center[1], box.center[2] + dz] });
const FAULTS = [
  { name: 'nâng 30 cm', family: 'ground', make: (b) => shift(b, 0.3) },
  { name: 'nâng 50 cm', family: 'ground', make: (b) => shift(b, 0.5) },
  { name: 'hạ 30 cm', family: 'ground', make: (b) => shift(b, -0.3) },
  { name: 'hạ 50 cm', family: 'ground', make: (b) => shift(b, -0.5) },
  { name: 'nâng thô 2 m', family: 'ground|z.range', make: (b) => shift(b, 2) },
  { name: 'dài thêm 30%', family: 'size.class_range', make: (b) => ({ ...b, dims: [b.dims[0] * 1.3, b.dims[1], b.dims[2]] }), needsRange: true },
];

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
  return o;
}

function newStats() {
  return BINS.map(() => ({ boxes: 0, groundCovered: 0, alarms: {}, alarmBoxes: 0, faults: Object.fromEntries(FAULTS.map((f) => [f.name, { n: 0, caught: 0 }])), yaw: { n: 0, caught: 0, clean: 0, cleanN: 0 } }));
}

function runSequence(seq, g, stats) {
  const tracks = new Map(); // track → [{ frame, yaw, range }]
  for (const f of seq.frames) {
    const frame = Measure.buildFrame(f.positions, f.boxes.map((b) => b.box), g);
    const all = f.boxes.map((b, i) => ({ box: b.box, label: b.label, attributes: {}, clientId: i }));
    f.boxes.forEach((b, i) => {
      const range = B.rangeXY(b.box, g.sensorOrigin), bin = binOf(range);
      if (!tracks.has(b.track)) tracks.set(b.track, []);
      tracks.get(b.track).push({ frame: f.index, yaw: b.box.rotation[2], range, label: b.label });
      if (bin < 0) return;
      const s = stats[bin], others = all.filter((_, j) => j !== i);
      const clean = Measure.measureBox(frame, all[i], others, null, g);
      s.boxes += 1;
      if (Checks.usableContact(clean.contact, b.box, g)) s.groundCovered += 1;
      const flagged = clean.issues.filter((x) => x.severity !== 'info');
      if (flagged.length) s.alarmBoxes += 1;
      for (const fam of new Set(flagged.map((x) => familyOf(x.rule)))) s.alarms[fam] = (s.alarms[fam] || 0) + 1;
      for (const fault of FAULTS) {
        if (fault.needsRange && !g.size.ranges[b.label]) continue;
        const target = { ...all[i], box: fault.make(b.box) };
        const res = Measure.measureBox(frame, target, others, null, g);
        const fams = new Set(res.issues.filter((x) => x.severity !== 'info').map((x) => familyOf(x.rule)));
        s.faults[fault.name].n += 1;
        if (fault.family.split('|').some((fam) => fams.has(fam))) s.faults[fault.name].caught += 1;
      }
    });
  }
  // Hướng: luật dải track (angleOutliers) trên chuỗi keyframe của từng track; cài lật 180° vào một keyframe.
  for (const seqOf of tracks.values()) {
    if (seqOf.length < 3) continue;
    const rigid = !g.size.nonRigidClasses.includes(seqOf[0].label);
    const floor = g.trackOps.yawJumpDeg[rigid ? 'rigid' : 'nonRigid'];
    const yaws = seqOf.map((k) => k.yaw), frames = seqOf.map((k) => k.frame);
    const cleanFlags = Checks.angleOutliers(yaws, floor, frames);
    seqOf.forEach((k, i) => {
      const bin = binOf(k.range);
      if (bin < 0) return;
      stats[bin].yaw.cleanN += 1;
      if (cleanFlags[i]) stats[bin].yaw.clean += 1;
      const flipped = yaws.slice();
      flipped[i] = B.wrapAngle(flipped[i] + Math.PI);
      stats[bin].yaw.n += 1;
      if (Checks.angleOutliers(flipped, floor, frames)[i]) stats[bin].yaw.caught += 1;
    });
  }
}

function report(title, stats) {
  const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '—');
  const head = ['', ...BINS.map(([a, b]) => `${a}–${b} m`)];
  const rows = [
    ['Box', ...stats.map((s) => String(s.boxes))],
    ['Phủ: đo được mặt đất', ...stats.map((s) => pct(s.groundCovered, s.boxes))],
    ['Báo nhầm: box bị báo (mọi luật)', ...stats.map((s) => pct(s.alarmBoxes, s.boxes))],
  ];
  const fams = [...new Set(stats.flatMap((s) => Object.keys(s.alarms)))].sort();
  for (const fam of fams) rows.push([`  báo nhầm ${fam}`, ...stats.map((s) => pct(s.alarms[fam] || 0, s.boxes))]);
  for (const f of FAULTS) rows.push([`Bắt: ${f.name}`, ...stats.map((s) => pct(s.faults[f.name].caught, s.faults[f.name].n))]);
  rows.push(['Bắt: lật hướng 180° (một keyframe)', ...stats.map((s) => pct(s.yaw.caught, s.yaw.n))]);
  rows.push(['Báo nhầm: hướng nhảy (dải track)', ...stats.map((s) => pct(s.yaw.clean, s.yaw.cleanN))]);
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [`### ${title}`, '', line(head), line(head.map(() => '---')), ...rows.map(line), ''].join('\n');
}

function main() {
  const o = args(), g = G.DEFAULT_GUIDELINE, out = {};
  const groups = [];
  if (o.nuscenes) {
    const scenes = o.scenes ? o.scenes.split(',') : D.nusScenes(o.nuscenes);
    const stats = newStats();
    for (const sc of scenes) {
      const t0 = Date.now();
      runSequence(D.loadNuScenes(o.nuscenes, sc), g, stats);
      process.stderr.write(`${sc}: ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
    }
    groups.push([`nuScenes mini (${scenes.length} cảnh, keyframe 2 Hz)`, stats]);
  }
  if (o.av2) {
    const stats = newStats();
    runSequence(D.loadAv2(o.av2), g, stats);
    groups.push(['Argoverse 2 (1 log, 40 frame 10 Hz)', stats]);
  }
  for (const [title, stats] of groups) {
    console.log(report(title, stats));
    out[title] = stats;
  }
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(out, null, 2));
}

main();
