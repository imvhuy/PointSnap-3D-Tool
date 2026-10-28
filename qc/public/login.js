'use strict';
/* Trang đăng nhập (tài khoản CVAT) và hiệu ứng khởi động sau khi đăng nhập, theo Figma "Đăng nhập · PointSnap 3D". */
(function () {
  const { api, esc, $ } = window.QC;

  function show() {
    for (const id of ['#top', '#layout']) $(id).hidden = true;
    const el = $('#login');
    el.hidden = false;
    el.innerHTML = `<section class="login-art">
        <div class="login-brand"><svg class="logo" aria-hidden="true"><use href="#i-logo"/></svg>PointSnap <span>3D</span></div>
        <div class="login-copy"><div class="eyebrow">PRECISION IN EVERY POINT</div>
          <h1>Đúng từng nhãn.<br>Vững mọi hành trình.</h1>
          <p>Không gian kiểm duyệt và sửa nhãn 3D dành cho đội ngũ xe tự hành.</p></div>
        <figure class="login-visual" aria-hidden="true"></figure>
        <div class="login-foot">LiDAR 3D / Quality Control / Annotation</div></section>
      <section class="login-form-wrap">
        <form class="login-form" id="login-form" novalidate>
          <div class="eyebrow">POINTSNAP WORKSPACE</div>
          <h2>Chào mừng trở lại</h2>
          <p class="muted">Một tài khoản. Đúng không gian làm việc.</p>
          <span class="pill accent">QC · Annotator</span>
          <label>Tên đăng nhập CVAT<input name="username" autocomplete="username" required autofocus></label>
          <label>Mật khẩu<span class="pw"><input name="password" type="password" autocomplete="current-password" required><button type="button" class="lnk" data-pw>Hiện</button></span></label>
          <div class="row"><label class="check"><input type="checkbox" name="remember"> Ghi nhớ đăng nhập</label>
            <a class="lnk" href="${esc((window.QC.S.status?.cvatUrl || '') + '/auth/password/reset')}" target="_blank" rel="noopener">Quên mật khẩu?</a></div>
          <div class="err" id="login-err" role="alert"></div>
          <button class="btn primary big" type="submit">Đăng nhập →</button>
          <p class="muted small">Dùng tài khoản CVAT của bạn. Quyền QC / Annotator xác định theo tài khoản.</p>
          <p class="muted small center">Kết nối bảo mật · CVAT Workspace</p>
        </form></section>`;
    $('[data-pw]').addEventListener('click', (e) => {
      const input = $('#login-form [name=password]'), show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      e.target.textContent = show ? 'Ẩn' : 'Hiện';
    });
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('[type=submit]');
      btn.disabled = true;
      $('#login-err').textContent = '';
      try {
        const me = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: f.username.value, password: f.password.value, remember: f.remember.checked }) });
        f.password.value = '';
        await intro(me);
        await window.QC.start(me);
      } catch (error) {
        $('#login-err').textContent = error.message;
        btn.disabled = false;
      }
    });
  }

  /** Hiệu ứng khởi động: logo tự vẽ nét, đèn pha bừng sáng, thanh nạp, rồi "Không gian làm việc đã sẵn sàng". */
  function intro(me) {
    const el = $('#intro');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
    el.hidden = false;
    el.innerHTML = `<div class="i-stage s1"><div class="lights"><i></i><i></i></div>
        <svg class="i-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7zM3.5 7 12 11.5 20.5 7M12 11.5v10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
        <div class="eyebrow">KHỞI ĐỘNG HÀNH TRÌNH</div><h2>Sẵn sàng cho độ chính xác.</h2></div>
      <div class="i-stage s2"><div class="i-name">PointSnap <span>3D</span></div><div class="muted">Đang chuẩn bị không gian làm việc…</div>
        <div class="rail"><i></i></div><div class="eyebrow">${me.role === 'qc' ? 'QC' : 'ANNOTATOR'} · ${esc(me.name)}</div></div>
      <div class="i-stage s3"><h2>Không gian làm việc đã sẵn sàng</h2><div class="muted">PointSnap <span class="c-acc">3D</span> · QC &amp; Annotator</div></div>`;
    return new Promise((resolve) => setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => { el.hidden = true; el.classList.remove('out'); el.innerHTML = ''; resolve(); }, 350);
    }, 2600));
  }

  window.QCLogin = { show };
}());
