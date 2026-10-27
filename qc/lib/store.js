'use strict';
/*
 * Lưu trên đĩa (thư mục QC_HOME), file JSON nhỏ, ghi qua file tạm rồi đổi tên để không hỏng khi tắt giữa chừng:
 * - scans/job-<id>.json: kết quả lần quét mới nhất của job;
 * - reviews/job-<id>.json: kết luận Đúng / Báo nhầm theo khoá mục (object + luật), giữ qua các lần quét lại;
 * - specs/<project-id | default>.json: các phiên bản guideline của project (ghi đè cùng định dạng file Export của trình
 *   sửa spec trong extension, thêm nhánh `qc` cho luật chỉ QC).
 */
const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(home) {
    this.home = home;
    for (const dir of ['scans', 'reviews', 'specs']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  }

  file(kind, name) {
    if (!/^[\w.-]+$/.test(name)) throw new Error('Tên không hợp lệ');
    return path.join(this.home, kind, `${name}.json`);
  }

  read(kind, name, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(this.file(kind, name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  write(kind, name, value) {
    const file = this.file(kind, name), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file);
  }

  scan(jobId) { return this.read('scans', `job-${jobId}`); }
  saveScan(jobId, result) { this.write('scans', `job-${jobId}`, result); }
  reviews(jobId) { return this.read('reviews', `job-${jobId}`, {}); }

  /** `verdict`: 'confirmed' | 'false_alarm' | null (xoá kết luận). */
  setReview(jobId, key, verdict, note = '') {
    const all = this.reviews(jobId);
    if (verdict) all[key] = { verdict, note: String(note).slice(0, 500), at: new Date().toISOString() };
    else delete all[key];
    this.write('reviews', `job-${jobId}`, all);
    return all;
  }

  /**
   * Guideline theo project, có lịch sử: { versions: [{ v, name, note, at, override }] }, phiên bản cuối là đang dùng.
   * File kiểu cũ ({ name, override }) đọc như phiên bản 1.
   */
  specHistory(projectId) {
    const data = this.read('specs', projectId ? `project-${projectId}` : 'default');
    if (!data) return { versions: [] };
    return data.versions ? data : { versions: [{ v: 1, name: data.name || 'Spec', note: '', at: null, override: data.override || {} }] };
  }

  /** Guideline đang dùng cho project (không có thì của mặc định, không có nữa thì null) kèm `project` nơi lấy. */
  spec(projectId) {
    for (const id of projectId ? [projectId, null] : [null]) {
      const last = this.specHistory(id).versions.at(-1);
      if (last) return { ...last, project: id };
    }
    return null;
  }

  /** Thêm một phiên bản (lưu mới hoặc khôi phục bản cũ). */
  addSpecVersion(projectId, { name, note, override }) {
    const history = this.specHistory(projectId);
    const v = (history.versions.at(-1)?.v || 0) + 1;
    history.versions.push({ v, name: String(name || 'Spec').slice(0, 80), note: String(note || '').slice(0, 300), at: new Date().toISOString(), override });
    this.write('specs', projectId ? `project-${projectId}` : 'default', history);
    return v;
  }
}

module.exports = { Store };
