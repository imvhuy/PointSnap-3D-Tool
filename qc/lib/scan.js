'use strict';
const crypto = require('node:crypto');
/*
 * Quét cả một job: mọi box ở mọi frame chạy qua đúng bộ luật của bảng annotator (extension/src/annotator/measure.js +
 * checks.js), cộng luật cấp track: hướng nhảy (như dải track của annotator) và luật chỉ QC ở trackrules.js (box nhảy,
 * đổi ID, đứt track, vẽ hai lần). Kết quả gộp theo object + luật: một track lệch kích thước ở 30 frame là một mục.
 */
const Checks = require('../../extension/src/annotator/checks.js');
const Measure = require('../../extension/src/annotator/measure.js');
const Tracks = require('./tracks');
const TrackRules = require('./trackrules');
const Icp = require('./icp');
const Evidence = require('./evidence');
const { QC_FULL_DEFAULTS } = require('./rules');

const RANK = { error: 0, warning: 1, info: 2 };
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Mục gộp: khoá ổn định theo object (ID trên server) + luật (+ object kia với luật theo cặp), giữ qua các lần quét. */
function groupKey(objKey, rule, otherKey) {
  if (!otherKey) return `${objKey}|${rule}`;
  return `${[objKey, otherKey].sort().join('+')}|${rule}`;
}

/** Hướng nhảy giữa các keyframe của từng track (cùng luật `angleOutliers` với dải track của annotator). */
function trackFindings(tracks, g) {
  const out = [];
  for (const t of tracks.values()) {
    const shown = t.keyframes.filter((k) => !k.outside && k.box);
    if (shown.length < 3) continue;
    const rigid = !g.size.nonRigidClasses.includes(t.label);
    const floor = g.trackOps.yawJumpDeg[rigid ? 'rigid' : 'nonRigid'];
    const flags = Checks.angleOutliers(shown.map((k) => k.box.rotation[2]), floor, shown.map((k) => k.frame));
    shown.forEach((k, i) => {
      if (!flags[i]) return;
      out.push({ objKey: t.key, frame: k.frame, keyframe: true, issue: {
        rule: 'heading.jump', severity: 'warning', title: 'Hướng nhảy giữa các keyframe',
        short: 'hướng nhảy',
        message: `Hướng ở keyframe ${k.frame} lệch quá ${floor}° so với mọi cách đoán từ các keyframe lân cận (lật đầu xe, quay ngang…).`,
      } });
    });
  }
  return out;
}

/**
 * Đứt track: xem point cloud ở frame cuối đoạn trước và frame đầu đoạn sau (evidence.js). Hai vật thì bỏ mục; một vật hoặc
 * không đủ điểm thì giữ, ghi kết quả vào lời nhắn và vào mục (`evidence`) để trang vẽ hình. Tải lại đúng gói frame cần.
 */
async function junctionEvidence(hits, { client, jobId, start, chunkSize, frames, poses, onProgress }) {
  const chunks = new Map(), cloud = async (f) => {
    const c = Math.floor((f - start) / chunkSize);
    if (!chunks.has(c)) chunks.set(c, await client.chunk(jobId, c).catch(() => []));
    return chunks.get(c)[(f - start) % chunkSize]?.positions;
  };
  const verdicts = new Map(), out = [], rejected = new Set();
  for (const h of hits) {
    if (h.issue.rule !== 'track.fragment') { out.push(h); continue; }
    const { endFrame: fe, startFrame: fs, ghostStart, ghostEnd } = h.link, a = h.objKey, b = h.issue.otherClientId, key = `${a}|${b}`;
    if (!verdicts.has(key)) {
      onProgress({ done: 0, total: 0, phase: `Xem point cloud chỗ nối ${fe}–${fs}` });
      const box = (f, k) => (frames.get(f) || []).find((o) => o.key === k)?.box;
      const others = (f) => (frames.get(f) || []).filter((o) => o.key !== a && o.key !== b).map((o) => o.box);
      const [pe, ps] = [await cloud(fe), await cloud(fs)], boxA = box(fe, a), boxB = box(fs, b);
      let ev = { verdict: 'unknown' };
      if (pe && ps && boxA && boxB) {
        // Box ma: hình của vật kia (toạ độ đã bù), đặt ở chỗ nó lẽ ra ở.
        const ghost = (bx, T, c) => ({ ...Evidence.boxToWorld(bx, T), center: [c[0], c[1], Evidence.boxToWorld(bx, T).center[2]] });
        const gEnd = ghost(boxB, poses.get(fs), ghostEnd), gStart = ghost(boxA, poses.get(fe), ghostStart);
        ev = Evidence.junction(
          { positions: pe, T: poses.get(fe), real: boxA, ghost: gEnd, others: others(fe) },
          { positions: ps, T: poses.get(fs), real: boxB, ghost: gStart, others: others(fs) });
        // Box ma theo toạ độ của frame đó (như CVAT hiển thị), để trang vẽ hình.
        ev.ghosts = [[fe, Evidence.boxToSensor(gEnd, poses.get(fe))], [fs, Evidence.boxToSensor(gStart, poses.get(fs))]]
          .map(([frame, g]) => ({ frame, center: g.center.slice(0, 2).map((v) => +v.toFixed(2)), dims: g.dims.slice(0, 2).map((v) => +v.toFixed(2)), yaw: +g.rotation[2].toFixed(3) }));
      }
      verdicts.set(key, ev);
    }
    const ev = verdicts.get(key);
    if (ev.verdict === 'two') { rejected.add(`${a}|${b}`); continue; }
    const note = ev.verdict === 'one'
      ? ` Point cloud: chỗ nối chỉ có một cụm điểm (${ev.end.own} điểm ở frame ${fe}, ${ev.start.own} điểm ở frame ${fs}), không thấy vật thứ hai.`
      : ' Point cloud: không đủ điểm để xác nhận, QC xem trên CVAT.';
    out.push({ ...h, issue: { ...h.issue, message: h.issue.message + note, evidence: { verdict: ev.verdict, end: ev.end, start: ev.start, ghosts: ev.ghosts || [] } } });
  }
  return { hits: out, rejected: rejected.size };
}

/** Dấu vân tay nội dung một track / shape: đổi khi annotator sửa bất kỳ keyframe, thuộc tính hay label nào. */
function fingerprint(item) {
  const strip = ({ id, ...rest }) => rest;
  return crypto.createHash('sha1').update(JSON.stringify({ ...strip(item), shapes: (item.shapes || []).map(strip) })).digest('hex').slice(0, 16);
}

/**
 * Mọi object của job (kể cả object tool không báo gì), cho QC duyệt hết: khoảng frame, số box, số mục tool báo, số box tool
 * không đo được (không đo được mặt đất, frame thiếu point cloud), khoảng cách gần nhất, đứng yên hay không, dấu vân tay.
 */
function objectSummary({ annotations, frames, cvatIds, findings, noGround, noPoints, poses, g }) {
  const src = new Map([...(annotations.shapes || []).map((x) => [`shape:${x.id}`, x]), ...(annotations.tracks || []).map((x) => [`track:${x.id}`, x])]);
  const out = new Map();
  for (const [f, objs] of frames) {
    for (const o of objs) {
      if (!out.has(o.key)) out.set(o.key, { key: o.key, kind: o.kind, serverId: o.serverId, cvatId: cvatIds.get(o.key) ?? null, label: o.label,
        first: f, last: f, boxes: 0, minRange: Infinity, noGround: noGround.get(o.key) || 0, noPoints: 0, errors: 0, warnings: 0, infos: 0, world: [], len: o.box.dims[0] });
      const r = out.get(o.key);
      r.first = Math.min(r.first, f); r.last = Math.max(r.last, f); r.boxes += 1;
      r.minRange = Math.min(r.minRange, Math.hypot(o.box.center[0], o.box.center[1]));
      if (noPoints.has(f)) r.noPoints += 1;
      if (poses?.has(f)) r.world.push(Icp.apply(poses.get(f), o.box.center[0], o.box.center[1]));
    }
  }
  for (const x of findings) {
    for (const k of [x.objKey, x.other].filter(Boolean)) {
      const r = out.get(k);
      if (r) r[`${x.severity === 'error' ? 'error' : x.severity === 'warning' ? 'warning' : 'info'}s`] += 1;
    }
  }
  return [...out.values()].map(({ world, len, ...r }) => {
    // Đứng yên: theo toạ độ đã bù chuyển động xe thu, tâm box không đi xa hơn ¼ chiều dài vật (tối thiểu 0,5 m).
    const mx = world.reduce((s0, p) => s0 + p[0], 0) / (world.length || 1), my = world.reduce((s0, p) => s0 + p[1], 0) / (world.length || 1);
    const spread = world.length ? Math.max(...world.map((p) => Math.hypot(p[0] - mx, p[1] - my))) : Infinity;
    return { ...r, minRange: Number.isFinite(r.minRange) ? Math.round(r.minRange * 10) / 10 : null,
      far: Number.isFinite(r.minRange) && r.minRange > g.ground.maxRangeM,
      static: world.length >= 2 && spread <= Math.max(0.5, len / 4),
      fingerprint: src.has(r.key) ? fingerprint(src.get(r.key)) : null };
  });
}

/**
 * `client`: CvatClient; `guideline`: bộ ngưỡng đã resolve; `onProgress({ done, total, phase })`; `signal`: AbortSignal.
 * `qc`: ngưỡng luật chỉ QC + luật tắt (rules.js). `gate`: { maxWarningsPer100 }. Trả về kết quả quét (JSON được).
 */
async function scanJob({ client, jobId, guideline: g, qc: q = QC_FULL_DEFAULTS, gate = { maxWarningsPer100: 5 }, onProgress = () => {}, signal }) {
  const startedAt = new Date().toISOString(), t0 = Date.now();
  onProgress({ done: 0, total: 0, phase: 'Đọc nhãn' });
  const job = await client.job(jobId);
  const [task, labels, annotations, meta] = await Promise.all([
    client.task(job.task_id), client.labels(jobId), client.annotations(jobId), client.meta(jobId)]);
  const start = job.start_frame, stop = job.stop_frame;
  const { frames, tracks, cvatIds } = Tracks.expand(annotations, labels, { start, stop });
  // Lời nhắn của luật ghi object kia dạng #track:<id server>; đổi sang số CVAT hiện để QC tìm được trong danh sách object.
  const named = (s) => s && s.replace(/#((?:track|shape):\d+)/g, (m, k) => (cvatIds.has(k) ? `#${cvatIds.get(k)}` : m));
  const deleted = new Set(meta.deleted_frames || []);
  const chunkSize = meta.chunk_size || (stop - start + 1);
  const total = stop - start + 1;

  const objects = new Map(); // key → { key, kind, serverId, label, boxes, keyframes }
  const hits = []; // { objKey, frame, keyframe, issue }
  const coverage = { framesWithoutPoints: [], boxesWithoutGround: 0, chunkErrors: [] };
  let boxes = 0, done = 0;
  const noGround = new Map(); // object → số box không đo được mặt đất
  // Chuyển động xe thu từng bước (khớp point cloud frame này vào frame trước), null khi không khớp được.
  const steps = new Map();
  let prevStructure = null, prevFrame = null, guess = null;

  for (let c = 0; start + c * chunkSize <= stop; c += 1) {
    if (signal?.aborted) throw new Error('Đã dừng');
    const first = start + c * chunkSize, last = Math.min(stop, first + chunkSize - 1);
    onProgress({ done, total, phase: `Tải point cloud frame ${first}–${last}` });
    let clouds = [];
    try {
      clouds = await client.chunk(jobId, c);
    } catch (error) {
      coverage.chunkErrors.push(`frame ${first}–${last}: ${error.message}`);
    }
    for (let f = first; f <= last; f += 1) {
      if (signal?.aborted) throw new Error('Đã dừng');
      done += 1;
      const objs = deleted.has(f) ? [] : (frames.get(f) || []);
      const positions = clouds[f - first]?.positions;
      if (!positions) {
        if (!deleted.has(f)) coverage.framesWithoutPoints.push(f);
        continue;
      }
      const frameData = Measure.buildFrame(positions, objs.map((o) => o.box), g);
      const structure = Icp.structure(positions, objs.map((o) => o.box));
      if (prevStructure && prevFrame === f - 1) {
        const r = Icp.register(structure, prevStructure, guess);
        steps.set(f, r.ok ? r.T : null);
        if (r.ok) guess = r.T;
      }
      prevStructure = structure;
      prevFrame = f;
      for (const o of objs) {
        boxes += 1;
        if (!objects.has(o.key)) objects.set(o.key, { key: o.key, kind: o.kind, serverId: o.serverId, label: o.label, boxes: 0, keyframes: 0 });
        const rec = objects.get(o.key);
        rec.boxes += 1;
        if (o.keyframe) rec.keyframes += 1;
        const others = objs.filter((x) => x !== o).map((x) => ({ box: x.box, label: x.label, attributes: x.attributes, clientId: x.key }));
        const track = o.kind === 'track' ? tracks.get(o.key) : null;
        const trackDims = track ? track.keyframes.filter((k) => !k.outside && k.box && k.frame !== f).map((k) => k.box.dims) : null;
        const m = Measure.measureBox(frameData,
          { box: o.box, label: o.label, attributes: o.attributes, occluded: o.occluded, clientId: o.key }, others, trackDims, g);
        if (!m.contact) { coverage.boxesWithoutGround += 1; noGround.set(o.key, (noGround.get(o.key) || 0) + 1); }
        // "Không đo được mặt đất" không phải lỗi của nhãn: chỉ đếm vào coverage, không thành mục cho QC duyệt.
        for (const issue of m.issues) if (issue.rule !== 'ground.no_evidence') hits.push({ objKey: o.key, frame: f, keyframe: o.keyframe, issue });
      }
      onProgress({ done, total, phase: `Quét frame ${f}` });
      await tick();
    }
  }
  hits.push(...trackFindings(tracks, g));
  const { poses, weak } = Icp.chain(steps, start, stop);
  coverage.egoWeakFrames = weak;
  const motion = TrackRules.trackRules({ tracks, frames, stop, poses }, g, q);
  coverage.commonFrames = motion.commonFrames;
  const checked = poses ? await junctionEvidence(motion.hits, { client, jobId, start, chunkSize, frames, poses, onProgress }) : { hits: motion.hits, rejected: 0 };
  hits.push(...checked.hits);
  coverage.fragmentsRejected = checked.rejected; // cặp nghi đứt track mà point cloud cho thấy hai vật
  const off = new Set(q.disabledRules);
  if (off.size) hits.splice(0, hits.length, ...hits.filter((h) => !off.has(h.issue.rule)));

  // Gộp theo object + luật.
  const groups = new Map();
  for (const h of hits) {
    const other = h.issue.otherClientId || null; // luật theo cặp: chồng lấn, spec, đổi ID, đứt / trùng track
    const key = groupKey(h.objKey, h.issue.rule, other);
    if (!groups.has(key)) {
      const obj = objects.get(h.objKey) || tracks.get(h.objKey) || { key: h.objKey };
      groups.set(key, { key, objKey: h.objKey, kind: obj.kind || 'track', serverId: obj.serverId, cvatId: cvatIds.get(h.objKey) ?? null, label: obj.label,
        other, otherLabel: other ? (objects.get(other) || tracks.get(other))?.label || null : null, otherCvatId: other ? cvatIds.get(other) ?? null : null,
        rule: h.issue.rule, severity: h.issue.severity, title: h.issue.title, short: h.issue.short || h.issue.title,
        message: h.issue.message, ratio: h.issue.ratio, evidence: h.issue.evidence, frames: [], keyframes: 0 });
    }
    const grp = groups.get(key);
    // Mục giữ lời nhắn của frame nặng nhất (mức cao hơn, hoặc cùng mức mà chồng nhiều hơn).
    const worse = RANK[h.issue.severity] - RANK[grp.severity] || (grp.ratio ?? 0) - (h.issue.ratio ?? 0);
    if (worse < 0) Object.assign(grp, { severity: h.issue.severity, short: h.issue.short || grp.short, message: h.issue.message, ratio: h.issue.ratio });
    if (!grp.frames.includes(h.frame)) {
      grp.frames.push(h.frame);
      if (h.keyframe) grp.keyframes += 1;
    }
  }
  const findings = [...groups.values()]
    .map((x) => ({ ...x, short: named(x.short), message: named(x.message), frames: x.frames.sort((a, b) => a - b) }))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.frames.length - a.frames.length);

  // Tóm tắt: số box có vấn đề / 100 box, theo luật; gate theo mức nặng nhất.
  const boxesWith = (sev) => new Set(hits.filter((h) => h.issue.severity === sev).map((h) => `${h.objKey}@${h.frame}`)).size;
  const errorBoxes = boxesWith('error'), warningBoxes = boxesWith('warning');
  const perRule = {};
  for (const x of findings) {
    const r = perRule[x.rule] || (perRule[x.rule] = { rule: x.rule, title: x.title, severity: x.severity, groups: 0, boxes: 0 });
    r.groups += 1;
    r.boxes += x.frames.length;
    if (RANK[x.severity] < RANK[r.severity]) r.severity = x.severity;
  }
  const per100 = (n) => (boxes ? Math.round((n / boxes) * 1000) / 10 : 0);
  const errors = findings.filter((x) => x.severity === 'error').length;
  const warningsPer100 = per100(warningBoxes);
  const verdict = errors ? 'fail' : warningsPer100 > gate.maxWarningsPer100 ? 'review' : 'pass';

  return {
    job: { id: job.id, taskId: job.task_id, taskName: task.name, projectId: task.project_id ?? null, start, stop,
      stage: job.stage, state: job.state, assignee: job.assignee?.username || null },
    startedAt, seconds: Math.round((Date.now() - t0) / 100) / 10,
    summary: {
      frames: total - deleted.size, boxes, objects: objects.size, tracks: tracks.size,
      errorGroups: errors, warningGroups: findings.filter((x) => x.severity === 'warning').length,
      infoGroups: findings.filter((x) => x.severity === 'info').length,
      errorBoxesPer100: per100(errorBoxes), warningBoxesPer100: warningsPer100,
      gate: { verdict, maxWarningsPer100: gate.maxWarningsPer100 },
      perRule: Object.values(perRule).sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.boxes - a.boxes),
    },
    coverage: {
      ...coverage,
      notChecked: ['Sót vật', 'Sai class', 'Camera / ảnh'],
      disabledRules: [...off],
    },
    findings,
    objects: objectSummary({ annotations, frames, cvatIds, findings, noGround, noPoints: new Set(coverage.framesWithoutPoints), poses, g }),
  };
}

module.exports = { scanJob, groupKey, trackFindings, fingerprint };
