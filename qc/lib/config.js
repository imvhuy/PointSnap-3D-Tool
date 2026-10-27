'use strict';
/*
 * Cấu hình từ biến môi trường, hoặc file qc/.env.local (KEY=VALUE, không commit). Biến môi trường thật thắng file.
 *   CVAT_URL     địa chỉ CVAT, ví dụ http://localhost:8080
 *   CVAT_TOKEN   access token cá nhân (CVAT → hồ sơ → Access tokens); nên để "chỉ đọc"
 *   QC_HOST      mặc định 127.0.0.1 (chỉ máy này); đặt 0.0.0.0 khi chạy trên máy chủ trong mạng công ty
 *   QC_PORT      mặc định 8766
 *   QC_HOME      nơi lưu kết quả, mặc định qc/.data
 *   QC_MAX_WARN_PER_100  ngưỡng gate "Cần xem": số box có cảnh báo trên 100 box, mặc định 5
 */
const fs = require('node:fs');
const path = require('node:path');

function readEnvFile(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function loadConfig(env = process.env) {
  const root = path.resolve(__dirname, '..');
  const e = { ...readEnvFile(path.join(root, '.env.local')), ...env };
  return {
    cvatUrl: (e.CVAT_URL || 'http://localhost:8080').replace(/\/+$/, ''),
    cvatToken: e.CVAT_TOKEN || '',
    host: e.QC_HOST || '127.0.0.1',
    port: Number(e.QC_PORT || 8766),
    home: path.resolve(root, e.QC_HOME || '.data'),
    gate: { maxWarningsPer100: Number(e.QC_MAX_WARN_PER_100 || 5) },
  };
}

module.exports = { loadConfig };
