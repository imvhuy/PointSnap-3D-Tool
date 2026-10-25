'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/annotator/cloud-colors.js');
const Colors = globalThis.PointSnapCloudColors;

const cloud = () => ({ material: { vertexColors: true }, geometry: { attributes: { color: { array: new Float32Array(12).fill(0.5), needsUpdate: false } } } });

test('tô điểm trong box xanh lá, điểm lòi ra đỏ, rồi trả lại màu gốc khi bỏ chọn', () => {
  const c = cloud();
  assert.equal(Colors.highlight(c, [0, 1], [3]), true);
  const a = c.geometry.attributes.color.array;
  assert.ok(a[1] > 0.7 && a[0] < 0.2 && a[2] < 0.5, 'điểm 0 xanh lá');
  assert.ok(a[9] > 0.9 && a[10] < 0.3, 'điểm 3 đỏ');
  assert.equal(a[6], 0.5, 'điểm 2 giữ nguyên');
  Colors.clear();
  assert.ok(a.every((v) => v === 0.5));
});

test('đổi box: màu của box trước được trả lại trước khi tô box mới', () => {
  const c = cloud();
  Colors.highlight(c, [0], []);
  Colors.highlight(c, [2], []);
  const a = c.geometry.attributes.color.array;
  assert.equal(a[0], 0.5);
  assert.ok(a[6] < 0.2);
  Colors.clear();
});

test('cloud không có màu theo điểm: báo để vẽ lớp phủ thay thế', () => {
  assert.equal(Colors.highlight({ material: {}, geometry: { attributes: {} } }, [0], []), false);
});
