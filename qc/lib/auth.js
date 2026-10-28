'use strict';
/*
 * Đăng nhập bằng chính tài khoản CVAT: dịch vụ gửi tên + mật khẩu tới CVAT (/api/auth/login) để kiểm, lấy thông tin người
 * dùng, rồi đăng xuất phiên CVAT vừa tạo. Mật khẩu không lưu, không ghi log. Dịch vụ cấp cookie phiên riêng (HttpOnly,
 * SameSite=Strict), giữ trong bộ nhớ: khởi động lại dịch vụ thì đăng nhập lại.
 * Vai trò: tài khoản trong QC_USERS là QC; QC_USERS trống thì admin của CVAT là QC; còn lại là annotator.
 */
const crypto = require('node:crypto');

const DAY = 24 * 3600 * 1000;
const ACCEPT = 'application/vnd.cvat+json';

class Auth {
  constructor({ cvatUrl, qcUsers = [] }) {
    this.cvatUrl = cvatUrl;
    this.qcUsers = qcUsers;
    this.sessions = new Map(); // token → { username, name, role, exp }
  }

  roleOf(user) {
    const name = String(user.username || '').toLowerCase();
    if (this.qcUsers.length) return this.qcUsers.includes(name) ? 'qc' : 'annotator';
    return user.is_superuser || (user.groups || []).includes('admin') ? 'qc' : 'annotator';
  }

  /** Kiểm tên + mật khẩu với CVAT. Trả về { username, name, role } hoặc ném lỗi có `status`. */
  async verify(username, password) {
    if (!username || !password) throw Object.assign(new Error('Nhập tên đăng nhập và mật khẩu CVAT'), { status: 400 });
    const res = await fetch(`${this.cvatUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
      body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15000) });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw Object.assign(new Error('Sai tên đăng nhập hoặc mật khẩu CVAT'), { status: 401 });
    if (!res.ok) throw Object.assign(new Error(`CVAT trả ${res.status} khi đăng nhập`), { status: 502 });
    const { key } = await res.json();
    const headers = { Authorization: `Token ${key}`, Accept: ACCEPT };
    try {
      const me = await (await fetch(`${this.cvatUrl}/api/users/self`, { headers, signal: AbortSignal.timeout(15000) })).json();
      const name = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username;
      return { username: me.username, name, role: this.roleOf(me) };
    } finally {
      // Không để lại phiên CVAT: dịch vụ chỉ cần biết tài khoản này đúng.
      await fetch(`${this.cvatUrl}/api/auth/logout`, { method: 'POST', headers }).catch(() => {});
    }
  }

  open(user, remember) {
    const token = crypto.randomBytes(24).toString('base64url');
    const ttl = remember ? 7 * DAY : 12 * 3600 * 1000;
    this.sessions.set(token, { ...user, exp: Date.now() + ttl });
    const cookie = `qc_session=${token}; HttpOnly; SameSite=Strict; Path=/${remember ? `; Max-Age=${ttl / 1000}` : ''}`;
    return { token, cookie };
  }

  /** Phiên của request (cookie qc_session) hoặc null. */
  session(req) {
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)qc_session=([\w-]+)/);
    const s = m && this.sessions.get(m[1]);
    if (!s) return null;
    if (s.exp < Date.now()) { this.sessions.delete(m[1]); return null; }
    return { ...s, token: m[1] };
  }

  close(req) {
    const s = this.session(req);
    if (s) this.sessions.delete(s.token);
    return 'qc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
  }
}

module.exports = { Auth };
