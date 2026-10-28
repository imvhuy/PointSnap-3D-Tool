'use strict';
/*
 * Kết nối extension PointSnap trong trang CVAT với dịch vụ QC: tạo token riêng cho extension (chỉ hiện một lần), chép vào
 * Tùy chọn của extension. Xem / xoá token đã tạo. Token mang đúng vai trò của người tạo (QC hoặc annotator).
 */
(function () {
  const { api, esc, toast, $, fmtTime } = window.QC;

  async function open(fresh = null) {
    const list = await api('/api/ext-tokens');
    const el = $('#modal');
    el.hidden = false;
    el.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="m-h"><div><h2 id="m-title">Kết nối extension CVAT</h2><div class="muted">Để làm việc ngay trong trang CVAT, không chuyển tab</div></div>
        <button type="button" class="act" data-close aria-label="Đóng">✕</button></div>
      <div class="m-body">
        ${fresh ? `<div class="ro"><div class="ro-h"><b>Token mới</b><span class="c-err">Chỉ hiện một lần</span></div>
          <code class="tok" id="tok">${esc(fresh.token)}</code>
          <div class="actions"><button type="button" class="btn sm primary" data-copy>Chép token</button></div>
          <div class="muted small">Mở Tùy chọn của extension PointSnap → mục Dịch vụ QC → dán địa chỉ <b>${esc(location.origin)}</b> và token này → Kiểm tra.</div></div>` : ''}
        <label>Tên gợi nhớ<input name="label" maxlength="60" placeholder="Ví dụ: Edge máy công ty"></label>
        <div class="muted small">Token hết hạn sau 30 ngày, mang vai trò của bạn (${esc(window.QC.S.me?.role === 'qc' ? 'QC' : 'annotator')}). Mất máy thì xoá token ở đây.</div>
        <div class="tok-list">${list.map((t) => `<div class="tok-row"><div><b>${esc(t.label)}</b><div class="muted small">tạo ${fmtTime(t.createdAt)} · hết hạn ${fmtTime(t.expiresAt)} · ${t.lastUsedAt ? `dùng lần cuối ${fmtTime(t.lastUsedAt)}` : 'chưa dùng'}</div></div>
          <button type="button" class="btn sm" data-revoke="${esc(t.id)}">Xoá</button></div>`).join('') || '<div class="muted small">Chưa có token nào.</div>'}</div>
        <div class="err" id="m-err" role="alert"></div></div>
      <div class="m-f"><button type="button" class="btn" data-close>Đóng</button><button class="btn primary" type="submit">Tạo token mới</button></div></form>`;
    const form = el.querySelector('form');
    const close = () => { el.hidden = true; el.innerHTML = ''; };
    el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await open(await api('/api/ext-tokens', { method: 'POST', body: JSON.stringify({ label: form.label.value }) })); } catch (error) { $('#m-err').textContent = error.message; }
    });
    form.addEventListener('click', async (e) => {
      if (e.target.closest('[data-copy]')) {
        try { await navigator.clipboard.writeText($('#tok').textContent); toast('Đã chép token'); } catch (_) { toast('Không chép được: bôi đen rồi Ctrl+C'); }
      }
      const r = e.target.closest('[data-revoke]');
      if (r && confirm('Xoá token này? Extension dùng token đó sẽ mất kết nối.')) { await api(`/api/ext-tokens/${r.dataset.revoke}`, { method: 'DELETE' }); open(); }
    });
  }

  document.addEventListener('click', (e) => { if (e.target.closest('[data-ext]')) { $('#acct-menu').hidden = true; open().catch((error) => toast(error.message)); } });
}());
