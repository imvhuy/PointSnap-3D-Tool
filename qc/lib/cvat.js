'use strict';
/*
 * Đọc CVAT qua REST bằng access token cá nhân (Authorization: Bearer). Chỉ đọc: job, task, label, nhãn, point cloud.
 * Token có đúng quyền của tài khoản tạo ra nó; job tài khoản đó không xem được thì CVAT trả 403 / 404.
 */
const { readZip } = require('./zip');
const { parsePcd } = require('./pcd');

class CvatError extends Error {
  constructor(status, path, detail) {
    super(`CVAT ${status} ở ${path}${detail ? `: ${detail}` : ''}`);
    this.status = status;
  }
}

class CvatClient {
  constructor({ url, token, timeoutMs = 120000 }) {
    if (!url) throw new Error('Thiếu CVAT_URL');
    if (!token) throw new Error('Thiếu CVAT_TOKEN (access token tạo ở trang hồ sơ CVAT)');
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  // CVAT 2.75 trả 406 cho `Accept: application/json`; chỉ nhận kiểu riêng của nó (hoặc */*).
  async request(path, { accept = 'application/vnd.cvat+json' } = {}) {
    const res = await fetch(this.url + path, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: accept },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (_) { /* không đọc được thân lỗi */ }
      throw new CvatError(res.status, path.split('?')[0], detail);
    }
    return res;
  }

  async json(path) {
    return (await this.request(path)).json();
  }

  /** Mọi trang của một danh sách phân trang (`results` + `next`). */
  async all(path) {
    const out = [];
    let page = 1;
    for (;;) {
      const sep = path.includes('?') ? '&' : '?';
      const data = await this.json(`${path}${sep}page_size=100&page=${page}`);
      out.push(...(data.results || []));
      if (!data.next) return out;
      page += 1;
    }
  }

  about() { return this.json('/api/server/about'); }
  self() { return this.json('/api/users/self'); }
  jobs() { return this.all('/api/jobs?dimension=3d'); }
  job(id) { return this.json(`/api/jobs/${id}`); }
  task(id) { return this.json(`/api/tasks/${id}`); }
  labels(jobId) { return this.all(`/api/labels?job_id=${jobId}`); }
  annotations(jobId) { return this.json(`/api/jobs/${jobId}/annotations`); }
  meta(jobId) { return this.json(`/api/jobs/${jobId}/data/meta`); }

  /** Gói frame thứ `index` của job (đếm từ 0 trong job): [{ name, positions: Float32Array x,y,z }] theo thứ tự frame. */
  async chunk(jobId, index) {
    const res = await this.request(`/api/jobs/${jobId}/data?type=chunk&index=${index}&quality=original`, { accept: '*/*' });
    const files = readZip(Buffer.from(await res.arrayBuffer()))
      .filter((f) => /\.pcd$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    return files.map((f) => ({ name: f.name, positions: parsePcd(f.data) }));
  }
}

module.exports = { CvatClient, CvatError };
