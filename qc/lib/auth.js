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

const TOKEN_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const publicToken = ({ hash, ...t }) => t;

class Auth {
  /** `store`: nơi lưu token extension (qc/lib/store.js); không có thì extension không đăng nhập được. */
  constructor({ cvatUrl, qcUsers = [], store = null }) {
    this.cvatUrl = cvatUrl;
    this.qcUsers = qcUsers;
    this.store = store;
    this.sessions = new Map(); // token → { username, name, role, exp }
  }

  /**
   * Token cho extension trong trang CVAT: người dùng đã đăng nhập trang QC tạo, chép vào extension. Chỉ trả token gốc một
   * lần; dịch vụ giữ sha256. Hết hạn sau TOKEN_DAYS ngày, xoá được bất cứ lúc nào.
   */
  issueToken(user, label = '') {
    const raw = `psq_${crypto.randomBytes(24).toString('base64url')}`, now = Date.now();
    const t = { id: crypto.randomBytes(6).toString('hex'), hash: sha(raw), username: user.username, name: user.name, role: user.role,
      label: String(label).slice(0, 60) || 'Extension', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + TOKEN_DAYS * DAY).toISOString(), lastUsedAt: null };
    this.store.saveExtTokens([...this.store.extTokens(), t]);
    return { token: raw, ...publicToken(t) };
  }

  tokensOf(username) { return this.store.extTokens().filter((t) => t.username === username).map(publicToken); }

  revokeToken(username, id) {
    const all = this.store.extTokens(), left = all.filter((t) => !(t.id === id && t.username === username));
    this.store.saveExtTokens(left);
    return left.length < all.length;
  }

  /**
   * Người dùng theo phiên đăng nhập CVAT, khi dịch vụ chạy cùng địa chỉ với CVAT (plugin trong trang CVAT, nginx của CVAT
   * chuyển /pointsnap-qc/ về đây nên trình duyệt gửi kèm cookie của CVAT). Hỏi CVAT `/api/users/self` bằng đúng cookie
   * phiên đó; nhớ kết quả 5 phút theo sha256 của sessionid. Không lưu, không ghi log cookie.
   */
  async fromCvatSession(req) {
    const cookies = Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k, v.join('=')]));
    if (!cookies.sessionid) return null;
    this.cvatSessions ||= new Map();
    const key = sha(cookies.sessionid), hit = this.cvatSessions.get(key);
    if (hit && hit.exp > Date.now()) return hit.user;
    const res = await fetch(`${this.cvatUrl}/api/users/self`, { headers: { Accept: ACCEPT, Cookie: `sessionid=${cookies.sessionid}${cookies.csrftoken ? `; csrftoken=${cookies.csrftoken}` : ''}` },
      signal: AbortSignal.timeout(15000) }).catch(() => null);
    const me = res?.ok ? await res.json() : null;
    const user = me && { username: me.username, name: [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username, role: this.roleOf(me), token: `cvat:${key.slice(0, 12)}`, via: 'cvat' };
    if (this.cvatSessions.size > 1000) this.cvatSessions.clear();
    this.cvatSessions.set(key, { user, exp: Date.now() + (user ? 5 * 60 * 1000 : 30 * 1000) });
    return user;
  }

  /** Người dùng của header `Authorization: Bearer psq_…` hoặc null. */
  bearer(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer (psq_[\w-]+)$/);
    if (!m || !this.store) return null;
    const all = this.store.extTokens(), t = all.find((x) => x.hash === sha(m[1]));
    if (!t || Date.parse(t.expiresAt) < Date.now()) return null;
    // Ghi lần dùng cuối tối đa mỗi giờ một lần, khỏi ghi file mỗi request.
    if (!t.lastUsedAt || Date.now() - Date.parse(t.lastUsedAt) > 3600 * 1000) { t.lastUsedAt = new Date().toISOString(); this.store.saveExtTokens(all); }
    return { username: t.username, name: t.name, role: t.role, token: `ext:${t.id}`, via: 'extension' };
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

  /** Phiên của request (cookie qc_session, hoặc token extension) hoặc null. */
  session(req) {
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)qc_session=([\w-]+)/);
    const s = m && this.sessions.get(m[1]);
    if (!s) return this.bearer(req);
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
