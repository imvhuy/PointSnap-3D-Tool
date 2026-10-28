'use strict';
/* Trang đăng nhập (tài khoản CVAT) và hiệu ứng khởi động sau khi đăng nhập, theo Figma "Đăng nhập · PointSnap 3D · v2". */
(function () {
  const { api, esc, $ } = window.QC;

  /** Cảnh LiDAR vẽ bằng SVG: vòng quét quanh xe ego, một cuboid xe chạm đất (giống logo) và một người đi bộ. Seed cố định nên lần nào cũng như nhau. */
  function sceneSvg(W, H) {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const Fo = 600, hz = 110, camH = 1.9, camZ = -5;
    const P = (X, Y, Z) => { const z = Z - camZ; return [W / 2 + X * Fo / z, hz + (camH - Y) * Fo / z, z]; };
    const f = (n) => n.toFixed(1);
    let dots = '';
    for (let r = 1.6; r <= 42; r += 0.35 + r * 0.05) {
      const n = Math.round(2 * Math.PI * r / 0.15);
      for (let i = 0; i < n; i++) {
        const a = i / n * 2 * Math.PI, [x, y, z] = P(Math.cos(a) * r, 0, Math.sin(a) * r);
        if (z < 1.6 || x < 0 || x > W || y > H || y < 0) continue;
        if (rnd() > 2.2 / z) continue; // mật độ đều trên màn hình: gần thì thưa theo mét, xa thì giữ hết
        dots += `<circle cx="${f(x)}" cy="${f(y)}" r="${Math.min(1.8, Math.max(0.6, 8 / z)).toFixed(2)}" fill="${r < 9 ? '#4C9AFF' : '#9FB0C4'}" fill-opacity="${Math.max(0.12, 0.95 - r / 44).toFixed(2)}"/>`;
      }
    }
    let ring = '';
    for (let i = 0; i <= 120; i++) {
      const a = i / 120 * 2 * Math.PI, [x, y, z] = P(Math.cos(a) * 7, 0, Math.sin(a) * 7);
      if (z > 1.6) ring += (ring ? 'L' : 'M') + f(x) + ' ' + f(y);
    }
    const box = (cx, cz, w, l, h, yaw, n) => {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const pts = [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]].map(([dx, dz]) => [cx + dx * c - dz * s, cz + dx * s + dz * c]);
      let cloud = '';
      for (let i = 0; i < n; i++) {
        const u = rnd(), v = rnd(), face = i % 3;
        let X, Z, Y;
        if (face === 2) {
          const [a, b, d] = [pts[0], pts[1], pts[3]];
          X = a[0] + (b[0] - a[0]) * u + (d[0] - a[0]) * v; Z = a[1] + (b[1] - a[1]) * u + (d[1] - a[1]) * v; Y = h * (0.8 + rnd() * 0.2);
        } else {
          const [a, b] = face === 0 ? [pts[0], pts[1]] : [pts[3], pts[0]];
          X = a[0] + (b[0] - a[0]) * u; Z = a[1] + (b[1] - a[1]) * u; Y = (0.1 + v * 0.8) * h;
        }
        const [x, y, z] = P(X, Y, Z);
        cloud += `<circle cx="${f(x)}" cy="${f(y)}" r="${Math.min(1.8, 10 / z).toFixed(2)}" fill="#E6EAF0" fill-opacity="${(0.5 + rnd() * 0.45).toFixed(2)}"/>`;
      }
      const lo = pts.map(([X, Z]) => P(X, 0, Z)), hi = pts.map(([X, Z]) => P(X, h, Z));
      const seg = (a, b) => `M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}`;
      let d = '';
      for (let i = 0; i < 4; i++) d += seg(lo[i], lo[(i + 1) % 4]) + seg(hi[i], hi[(i + 1) % 4]) + seg(lo[i], hi[i]);
      return { cloud, d, g: P((pts[0][0] + pts[1][0]) / 2, 0, (pts[0][1] + pts[1][1]) / 2), top: hi.reduce((m, p) => (p[1] < m[1] ? p : m)) };
    };
    const car = box(2.4, 7.5, 1.9, 4.6, 1.55, 0.5, 260), ped = box(-2.8, 5, 0.7, 0.7, 1.75, 0, 70);
    const g = car.g, t = car.top, tw = 156, ego = P(0, 0, 0);
    return `<svg viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">${dots}
      <path class="sweep" transform-origin="${f(ego[0])} ${f(ego[1])}" d="${ring}" stroke="#4C9AFF" stroke-width="1.5"/>
      ${ped.cloud}<path d="${ped.d}" stroke="#4C9AFF" stroke-opacity="0.6" stroke-width="1.2" stroke-dasharray="4 3"/>
      ${car.cloud}<path class="cuboid" d="${car.d}" stroke="#4C9AFF" stroke-width="2" stroke-linejoin="round"/>
      <path d="M${f(g[0] - 52)} ${f(g[1])}H${f(g[0] - 15)}M${f(g[0] + 15)} ${f(g[1])}H${f(g[0] + 52)}" stroke="#E6EAF0" stroke-opacity="0.45" stroke-width="3" stroke-linecap="round"/>
      <circle class="dot" cx="${f(g[0])}" cy="${f(g[1])}" r="7" fill="#4C9AFF"/>
      <rect x="${f(t[0] - tw / 2)}" y="${f(t[1] - 46)}" width="${tw}" height="26" rx="13" fill="#0B63CE"/>
      <text x="${f(t[0])}" y="${f(t[1] - 29)}" font-family="IBM Plex Mono, ui-monospace, monospace" font-size="11" font-weight="500" fill="#FFFFFF" text-anchor="middle">CAR · CHẠM ĐẤT ✓</text></svg>`;
  }

  function show() {
    for (const id of ['#top', '#layout']) $(id).hidden = true;
    const el = $('#login');
    el.hidden = false;
    el.innerHTML = `<section class="login-art">
        <div class="login-brand"><svg class="logo" aria-hidden="true"><use href="#i-logo"/></svg><b>PointSnap <span>3D</span></b></div>
        <div class="login-hero">
          <div class="login-copy"><div class="mono">PRECISION IN EVERY POINT</div>
            <h1>Đúng từng nhãn.<br>Vững mọi hành trình.</h1>
            <p>Không gian kiểm duyệt và sửa nhãn cuboid 3D cho đội ngũ xe tự hành — dữ liệu không rời CVAT.</p></div>
          <figure class="login-visual" aria-hidden="true">${sceneSvg(688, 420)}</figure>
        </div>
        <div class="login-foot mono"><span>LiDAR 3D</span><span>Quality Control</span><span>Annotation</span></div></section>
      <section class="login-form-wrap">
        <form class="login-form" id="login-form" novalidate>
          <div class="login-head"><span class="chip mono">QC · Annotator</span>
            <h2>Chào mừng trở lại</h2>
            <p class="sub">Đăng nhập bằng tài khoản CVAT của bạn.</p></div>
          <label>Tên đăng nhập CVAT<input name="username" autocomplete="username" placeholder="vd: nguyen.an" required autofocus></label>
          <label>Mật khẩu<span class="pw"><input name="password" type="password" autocomplete="current-password" required><button type="button" class="lnk" data-pw>Hiện</button></span></label>
          <div class="row"><label class="check"><input type="checkbox" name="remember"> Ghi nhớ đăng nhập</label>
            <a class="lnk" href="${esc((window.QC.S.status?.cvatUrl || '') + '/auth/password/reset')}" target="_blank" rel="noopener">Quên mật khẩu?</a></div>
          <div class="err" id="login-err" role="alert"></div>
          <button class="login-btn" type="submit">Đăng nhập <span aria-hidden="true">→</span></button>
          <p class="note">Quyền QC hay Annotator được xác định theo tài khoản CVAT. PointSnap không lưu mật khẩu.</p>
        </form>
        <p class="login-sec mono">Kết nối bảo mật · CVAT Workspace</p></section>`;
    const toggle = $('#theme').cloneNode(true); // cùng nút sáng / tối với đầu trang; click do app.js bắt chung
    toggle.removeAttribute('id');
    toggle.classList.add('login-theme');
    el.querySelector('.login-form-wrap').prepend(toggle);
    window.QC.paintTheme();
    for (const f of ['intro-car-dark.png', 'intro-car-light.png', 'intro-glow.png']) new Image().src = 'assets/' + f; // nạp trước cho hiệu ứng khởi động khỏi giật
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
        const ready = window.QC.start(me); // dựng app phía sau lớp hiệu ứng để lúc mờ đi là thấy ngay app, không lóe lại trang đăng nhập
        await intro(me, ready);
        await ready;
      } catch (error) {
        $('#login-err').textContent = error.message;
        btn.disabled = false;
      }
    });
  }

  const LOGO = '<svg class="i-logo" viewBox="0 0 56 56" aria-hidden="true"><path d="M28 44.33 11.67 35V16.33L28 7l16.33 9.33V35zM44.33 16.33 28 25.67M28 25.67 11.67 16.33M28 25.67v18.66" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path class="gl" d="M3.5 44.33h15.17M37.33 44.33H52.5" stroke="currentColor" stroke-opacity=".4" stroke-width="3.5" stroke-linecap="round"/><circle cx="28" cy="44.33" r="5.25" fill="#4C9AFF"/></svg>';

  /** Hiệu ứng khởi động theo Figma "Unified Login Animation": xe bật đèn pha → logo tự vẽ nét + thanh nạp → "Không gian làm việc đã sẵn sàng". */
  function intro(me, ready = Promise.resolve()) {
    const el = $('#intro');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
    el.hidden = false;
    el.innerHTML = `<div class="i-stage s1"><div class="i-car" aria-hidden="true"><div class="i-plate">${LOGO}PointSnap&nbsp;<span>3D</span></div></div>
        <div class="i-brand">${LOGO}<b>PointSnap <span>3D</span></b></div>
        <div class="i-copy"><div class="mono">KHỞI ĐỘNG HÀNH TRÌNH</div><h2>Sẵn sàng cho độ chính xác.</h2></div>
        <div class="i-status mono">VinFast&nbsp; / &nbsp;Electric startup</div></div>
      <div class="i-stage s2">${LOGO}<div class="i-name">PointSnap <span>3D</span></div><div class="muted">Đang chuẩn bị không gian làm việc…</div>
        <div class="rail"><i></i></div><div class="mono">${me.role === 'qc' ? 'QC' : 'ANNOTATOR'} · ${esc(me.name)}</div></div>
      <div class="i-stage s3">${LOGO}<h2>Không gian làm việc đã sẵn sàng</h2><div class="muted">PointSnap <span class="acc">3D</span> · QC &amp; Annotator</div></div>`;
    const shown = new Promise((resolve) => setTimeout(resolve, 9400)); // + 0,6s mờ dần = 10s
    return Promise.all([shown, ready.catch(() => {})]).then(() => new Promise((resolve) => {
      el.classList.add('out');
      setTimeout(() => { el.hidden = true; el.classList.remove('out'); el.innerHTML = ''; resolve(); }, 600);
    }));
  }

  window.QCLogin = { show, intro };
}());
