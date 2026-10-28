'use strict';
/* Xuất kết quả quét ra CSV (mở bằng Excel / Google Sheets): một dòng mỗi mục gộp, kèm kết luận của QC và link CVAT. */

const VERDICT = { confirmed: 'Đúng', false_alarm: 'Báo nhầm' };
const SEVERITY = { error: 'Lỗi', warning: 'Cảnh báo', info: 'Thông tin' };

const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Chặn công thức khi mở bằng bảng tính (=, +, -, @ ở đầu ô).
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * Link mở CVAT tại frame. Mục một object: kèm serverID để CVAT lọc đúng object đó. Mục theo cặp (chồng lấn, đổi ID…):
 * không lọc, vì CVAT chỉ lọc được một object qua URL và sẽ ẩn object kia.
 */
function cvatLink(cvatUrl, job, finding, frame = finding.frames[0], only = !finding.other) {
  const base = `${cvatUrl}/tasks/${job.taskId}/jobs/${job.id}?frame=${frame}`;
  return only ? `${base}&type=${finding.kind}&serverID=${finding.serverId}` : base;
}

function toCsv(scan, reviews, cvatUrl) {
  const head = ['Mức', 'Luật', 'Vấn đề', 'Class', 'Số CVAT', 'Class object kia', 'Số CVAT object kia', 'Số frame', 'Số keyframe',
    'Frame đầu', 'Frame cuối', 'Chi tiết', 'Kết luận QC', 'Ghi chú QC', 'Link CVAT'];
  const rows = scan.findings.map((f) => {
    const r = reviews[f.key] || {};
    return [SEVERITY[f.severity], f.rule, f.title, f.label, f.cvatId ?? f.objKey, f.otherLabel || '', f.otherCvatId ?? f.other ?? '', f.frames.length, f.keyframes,
      f.frames[0], f.frames[f.frames.length - 1], f.message, VERDICT[r.verdict] || '', r.note || '', cvatLink(cvatUrl, scan.job, f)];
  });
  // BOM để Excel nhận đúng UTF-8 (chữ tiếng Việt).
  return `﻿${[head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { toCsv, cvatLink };
