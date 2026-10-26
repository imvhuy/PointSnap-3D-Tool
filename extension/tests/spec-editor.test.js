'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/annotator/spec-editor.js');
const { parseRange } = globalThis.PointSnapSpecEditor;

test('ô khoảng: nhận "1.2–2.8", "1,2 - 2,8"; trống là không kiểm; sai dạng hoặc min > max là lỗi', () => {
  assert.deepEqual(parseRange('1.2–2.8'), [1.2, 2.8]);
  assert.deepEqual(parseRange(' 1,2 - 2,8 '), [1.2, 2.8]);
  assert.equal(parseRange(''), null);
  for (const bad of ['2.8–1.2', 'abc', '1.2', '0–1', '-1–2']) assert.equal(parseRange(bad), undefined, bad);
});
