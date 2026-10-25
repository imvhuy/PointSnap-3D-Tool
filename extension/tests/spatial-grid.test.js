'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Grid = require('../src/annotator/spatial-grid.js');

test('pointsNearBox lấy đúng điểm trong footprint xoay nới margin', () => {
  const grid = Grid.build(new Float32Array([0, 0, 0, 1.4, 0, 0, 3, 0, 0, 0, 1.4, 0]), 1);
  const box = { center: [0, 0, 0], dims: [2, 2, 1], rotation: [0, 0, Math.PI / 4] };
  assert.deepEqual(Grid.pointsNearBox(grid, box, 0).sort(), [0, 1, 3]);
});

test('segmentBlocked: có điểm chắn giữa đoạn thì bị che, điểm được bỏ qua thì không', () => {
  const wall = [];
  for (let z = -0.2; z <= 0.2; z += 0.1) wall.push(5, 0, z);
  const grid = Grid.build(new Float32Array(wall), 1);
  assert.equal(Grid.segmentBlocked(grid, [0, 0, 0], [10, 0, 0]), true);
  assert.equal(Grid.segmentBlocked(grid, [0, 0, 0], [10, 0, 0], { ignore: () => true }), false);
  assert.equal(Grid.segmentBlocked(grid, [0, 5, 0], [10, 5, 0]), false);
});
