'use strict';
/*
 * Nhãn của job (JSON REST của CVAT) → các box có mặt ở từng frame, đúng như CVAT hiển thị:
 * - shape: box ở đúng frame của nó;
 * - track: keyframe giữ nguyên; frame giữa hai keyframe nội suy như cvat-core (cuboid-track.ts): tuyến tính cho mọi số,
 *   góc theo cung ngắn nhất; frame sau keyframe cuối giữ box cuối; keyframe `outside` thì vật không có mặt từ đó.
 * Thuộc tính đổi được (mutable) lấy giá trị của keyframe gần nhất phía trước, như CVAT.
 */
const B = require('../../extension/src/annotator/box.js');

/** { label_id → { name, attrs: { spec_id → { name, default } } } } từ danh sách label của job. */
function labelIndex(labels) {
  const out = new Map();
  for (const l of labels) {
    const attrs = new Map((l.attributes || []).map((a) => [a.id, { name: a.name, default: a.default_value ?? '' }]));
    out.set(l.id, { name: l.name, attrs });
    for (const s of l.sublabels || []) out.set(s.id, { name: s.name, attrs: new Map() });
  }
  return out;
}

/** Giá trị thuộc tính có trong `list` ([{ spec_id, value }]), theo tên. */
function pickAttributes(label, list) {
  const out = {};
  for (const a of list || []) {
    const spec = label.attrs.get(a.spec_id);
    if (spec) out[spec.name] = a.value;
  }
  return out;
}

/** Mọi thuộc tính của label: giá trị mặc định, ghi đè bằng `list`. */
function attributeValues(label, list) {
  const out = {};
  for (const a of label.attrs.values()) out[a.name] = a.default;
  return { ...out, ...pickAttributes(label, list) };
}

/** Nội suy points của cuboid giữa hai keyframe, như cvat-core: góc theo cung ngắn nhất. */
function interpolate(left, right, t) {
  const p = left.map((v, i) => v + (right[i] - v) * t);
  for (let i = 3; i < 6; i += 1) p[i] = B.wrapAngle(left[i] + B.angleDiff(left[i], right[i]) * t);
  return p;
}

/**
 * Trả về { frames: Map<frame, [object]>, tracks: Map<key, { key, label, keyframes: [{ frame, box, outside }] }>,
 * cvatIds: Map<key, số CVAT hiện> }.
 * object = { key ('track:<id>' | 'shape:<id>'), kind, serverId, frame, box, label, attributes, occluded, keyframe }.
 */
function expand(annotations, labels, { start, stop }) {
  const index = labelIndex(labels);
  const frames = new Map(), tracks = new Map();
  // Số CVAT hiện trong danh sách object (clientID): cvat-core đánh số 1, 2, … theo thứ tự tag, shape, track mà API trả về
  // (đã đối chiếu: job 69 track server 152 hiện là 129). QC tìm object trong CVAT bằng số này, không phải ID server.
  const nTags = (annotations.tags || []).length, nShapes = (annotations.shapes || []).length;
  const cvatIds = new Map([
    ...(annotations.shapes || []).map((s, i) => [`shape:${s.id}`, nTags + i + 1]),
    ...(annotations.tracks || []).map((t, i) => [`track:${t.id}`, nTags + nShapes + i + 1]),
  ]);
  const put = (frame, obj) => {
    if (frame < start || frame > stop || !obj.box) return;
    if (!frames.has(frame)) frames.set(frame, []);
    frames.get(frame).push(obj);
  };

  for (const s of annotations.shapes || []) {
    if (s.type !== 'cuboid' || s.outside) continue;
    const label = index.get(s.label_id) || { name: String(s.label_id), attrs: new Map() };
    put(s.frame, { key: `shape:${s.id}`, kind: 'shape', serverId: s.id, frame: s.frame, box: B.fromCvatPoints(s.points),
      label: label.name, attributes: attributeValues(label, s.attributes), occluded: !!s.occluded, keyframe: true });
  }

  for (const t of annotations.tracks || []) {
    const shapes = (t.shapes || []).filter((s) => s.type === 'cuboid').sort((a, b) => a.frame - b.frame);
    if (!shapes.length) continue;
    const label = index.get(t.label_id) || { name: String(t.label_id), attrs: new Map() };
    const key = `track:${t.id}`;
    tracks.set(key, { key, serverId: t.id, label: label.name,
      keyframes: shapes.map((s) => ({ frame: s.frame, box: B.fromCvatPoints(s.points), outside: !!s.outside, occluded: !!s.occluded })) });
    // Thuộc tính tích luỹ theo keyframe (giá trị đổi ở keyframe nào thì giữ tới keyframe sau).
    const attrsAt = [];
    let acc = attributeValues(label, t.attributes);
    for (const s of shapes) { acc = { ...acc, ...pickAttributes(label, s.attributes) }; attrsAt.push(acc); }
    for (let i = 0; i < shapes.length; i += 1) {
      const left = shapes[i], right = shapes[i + 1];
      if (left.outside) continue;
      const end = right ? right.frame - 1 : stop;
      for (let f = Math.max(left.frame, start); f <= Math.min(end, stop); f += 1) {
        const isKey = f === left.frame;
        const points = isKey || !right ? left.points : interpolate(left.points, right.points, (f - left.frame) / (right.frame - left.frame));
        put(f, { key, kind: 'track', serverId: t.id, frame: f, box: B.fromCvatPoints(points), label: label.name,
          attributes: attrsAt[i], occluded: !!left.occluded, keyframe: isKey });
      }
    }
  }
  return { frames, tracks, cvatIds };
}

module.exports = { expand, interpolate, labelIndex };
