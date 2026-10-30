'use strict';

/* Mọi script extension nạp vào trang (theo manifest) phải parse được: các file chỉ chạy trong trình duyệt (panel,
 * controller, adapter, overlay) không được test đơn vị nào require, lỗi cú pháp ở đó chỉ lộ ra khi mở CVAT. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const manifest = require('../manifest.json');

const scripts = [...new Set(manifest.content_scripts.flatMap((c) => c.js)), manifest.background.service_worker, 'options.js', 'sidepanel.js'];

for (const file of scripts) {
  test(`cú pháp: ${file}`, () => {
    const run = spawnSync(process.execPath, ['--check', path.join(__dirname, '..', file)], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  });
}
