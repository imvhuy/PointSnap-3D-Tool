'use strict';
/*
 * Lưu trên đĩa (thư mục QC_HOME), file JSON nhỏ, ghi qua file tạm rồi đổi tên để không hỏng khi tắt giữa chừng:
 * - scans/job-<id>.json: kết quả lần quét mới nhất của job;
 * - reviews/job-<id>.json: kết luận Đúng / Báo nhầm theo khoá mục (object + luật), giữ qua các lần quét lại;
 * - objects/job-<id>.json: QC đã duyệt object nào (kèm dấu vân tay track lúc duyệt), job-<id>-done.json: lần hoàn thành;
 * - specs/<project-id | default>.json: các phiên bản guideline của project (ghi đè cùng định dạng file Export của trình
 *   sửa spec trong extension, thêm nhánh `qc` cho luật chỉ QC).
 */
const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(home) {
    this.home = home;
    for (const dir of ['scans', 'reviews', 'specs', 'objects', 'tickets', 'tokens']) fs.mkdirSync(path.join(home, dir), { recursive: true });
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
  /** Lần quét ngay trước lần hiện tại (để vòng duyệt lại so trước / sau), hoặc null. */
  prevScan(jobId) { return this.read('scans', `job-${jobId}-prev`); }
  saveScan(jobId, result) {
    const old = this.scan(jobId);
    if (old) this.write('scans', `job-${jobId}-prev`, old);
    this.write('scans', `job-${jobId}`, result);
  }
  reviews(jobId) { return this.read('reviews', `job-${jobId}`, {}); }

  /** `verdict`: 'confirmed' | 'false_alarm' | null (xoá kết luận). */
  setReview(jobId, key, verdict, note = '') {
    const all = this.reviews(jobId);
    if (verdict) all[key] = { verdict, note: String(note).slice(0, 500), at: new Date().toISOString() };
    else delete all[key];
    this.write('reviews', `job-${jobId}`, all);
    return all;
  }

  /** Duyệt từng object: { [objKey]: { status: 'ok' | 'returned', by, at, fingerprint } }. */
  objectReviews(jobId) { return this.read('objects', `job-${jobId}`, {}); }

  /** `items`: [{ key, fingerprint, issue?, ticket? }] (issue: lỗi QC ghi khi trả, ticket: phiếu đã gửi); `status` null thì xoá. */
  setObjectReviews(jobId, items, status, by = '') {
    const all = this.objectReviews(jobId), at = new Date().toISOString();
    for (const { key, fingerprint, ...extra } of items) {
      if (status) all[key] = { status, by: String(by).slice(0, 60), at, fingerprint, ...extra };
      else delete all[key];
    }
    this.write('objects', `job-${jobId}`, all);
    return all;
  }

  /**
   * Phiếu giao việc sửa lỗi (QC → annotator): [{ id: 'BUG-101', jobId, taskId, objKey, kind, serverId, cvatId, label, frames,
   * rule, title, message, priority: 'must' | 'warn', assignee,
   * status: 'draft' (thiếu vật chưa gửi) | 'open' | 'submitted' | 'accepted' | 'returned',
   * round (vòng gửi gần nhất), sends (số lần gửi annotator), fixed (annotator đánh dấu đã sửa, chờ nộp cả vòng),
   * held (QC trả lại, chờ gửi cùng vòng sau), thread: [{ by, name, role, at, text, kind, round }], createdBy, createdAt, updatedAt }].
   */
  tickets() { return this.read('tickets', 'all', []); }

  /** Token cho extension: [{ id, hash (sha256), username, name, role, label, createdAt, expiresAt, lastUsedAt }]. Không lưu token gốc. */
  extTokens() { return this.read('tokens', 'all', []); }

  saveExtTokens(list) { this.write('tokens', 'all', list); }

  saveTickets(list) { this.write('tickets', 'all', list); }

  /** `fn(ticket)` sửa một phiếu theo id; trả về phiếu sau khi sửa (null nếu không có). */
  updateTicket(id, fn) {
    const all = this.tickets(), t = all.find((x) => x.id === id);
    if (!t) return null;
    fn(t);
    t.updatedAt = new Date().toISOString();
    this.saveTickets(all);
    return t;
  }

  addTicket(fields) {
    const all = this.tickets(), n = all.reduce((m, t) => Math.max(m, Number(t.id.split('-')[1]) || 100), 100) + 1;
    const now = new Date().toISOString(), t = { id: `BUG-${n}`, ...fields, createdAt: now, updatedAt: now };
    all.push(t);
    this.saveTickets(all);
    return t;
  }

  /**
   * Các vòng QC ↔ annotator của job: [{ n, sentAt, sentBy, tickets: [id], fresh, reworked, submittedAt, submittedBy }].
   * Một vòng = QC gửi hết lỗi một lần (sau khi duyệt đủ object) → annotator nộp hết một lần.
   */
  rounds(jobId) { return this.read('objects', `job-${jobId}-rounds`, []); }
  saveRounds(jobId, list) { this.write('objects', `job-${jobId}-rounds`, list); }

  /** Lần QC bấm hoàn thành job: { at, by, scanAt } hoặc null. */
  completion(jobId) { return this.read('objects', `job-${jobId}-done`); }
  setCompletion(jobId, value) { this.write('objects', `job-${jobId}-done`, value); }

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
