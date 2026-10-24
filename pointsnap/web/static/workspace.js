/* Shared workspace preflight; no installation, annotation writes or automatic downloads. */
(function(root){
  'use strict';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let slug=null,epoch=0,last=null;
  function render(data){
    const box=document.getElementById('system-checks');if(!box)return;
    last=data;
    const m=data.models || {items:[]}, cvat=data.cvat || {}, ext=data.extension || {};
    box.innerHTML=`<div class="system-cards"><article class="system-card"><span class="eyebrow">01 · KẾT NỐI</span><h2>CVAT</h2><p class="${cvat.connected?'status-ready':'status-blocked'}">${esc(cvat.connected?'Đã kết nối · '+cvat.version:cvat.error)}</p><p class="muted">${esc(cvat.url)}</p><a class="btn btn-secondary" href="#connection">Cấu hình kết nối</a></article>
      <article class="system-card"><span class="eyebrow">02 · CÔNG CỤ SỬA TAY</span><h2>Extension</h2><p>${esc(ext.connected ? ext.compatible?'Đã kết nối · v'+ext.required_version:'Cần Reload extension v'+ext.required_version : 'Chờ bạn mở job CVAT')}</p><p class="muted">Kéo bằng CVAT · xem tọa độ trực tiếp · Save/Undo của CVAT</p>${!ext.compatible?`<p class="muted">Edge/Chrome → Extensions → Developer mode → Load unpacked hoặc Reload bản 0.3.0. Save công việc trước khi tải lại tab CVAT.</p>${ext.directory?`<div class="command-row"><code>${esc(ext.directory)}</code><button class="btn btn-ghost btn-sm" data-copy="${esc(ext.directory)}">Sao chép</button></div>`:''}`:''}<a class="btn btn-secondary" href="${esc(cvat.url || 'http://localhost:8080')}" target="_blank" rel="noopener">Mở CVAT ↗</a></article></div>
      <div class="system-models">${m.items.map(item=>`<article class="system-card"><div class="system-card-heading"><h2>${esc(item.name)}</h2><span class="pill-badge ${item.ready?'success':'warning'}">${item.fallback==='lidar'?'Dùng LiDAR':(item.selected??item.required)?(item.ready?'Sẵn sàng':'Cần cài / cấu hình'):'Không yêu cầu'}</span></div><p>${esc(item.reason)}</p>${!item.ready?`<p class="muted">Chạy trong PowerShell trên máy đang chạy PointSnap:</p><div class="command-row"><code>${esc('& '+item.install_command)}</code><button class="btn btn-ghost btn-sm" data-copy="${esc('& '+item.install_command)}">Sao chép</button></div>${item.weights_command?`<div class="command-row"><code>${esc('& '+item.weights_command)}</code><button class="btn btn-ghost btn-sm" data-copy="${esc('& '+item.weights_command)}">Sao chép</button></div>`:''}`:''}${item.id==='camera'?`<label class="field-label" for="system-camera-mode">Chế độ camera</label><div class="system-path-row"><select id="system-camera-mode" class="form-select"><option value="auto" ${item.mode==='auto'?'selected':''}>Tự chọn GPU (CUDA)</option><option value="true" ${item.mode==='true'?'selected':''}>Chạy trên CPU hoặc GPU hiện có</option><option value="false" ${item.mode==='false'?'selected':''}>Không dùng model camera</option></select><button id="system-save-camera" class="btn btn-secondary">Lưu chế độ</button></div>`:''}${item.id==='critic' && item.required?`<label class="field-label" for="system-critic-path">Đường dẫn trọng số Box Critic (.pt)</label><div class="system-path-row"><input id="system-critic-path" class="form-input" value="${esc(item.path || '')}" placeholder="D:\\models\\critic.pt"><button id="system-save-critic" class="btn btn-secondary">Lưu đường dẫn</button></div><p class="muted">Dùng trọng số do nhóm bàn giao. Nếu dự án không dùng Box Critic, tắt luật này trong Guideline.</p>`:''}</article>`).join('')}</div>
      <div class="system-footer"><p>${data.scan_ready?`<strong class="status-ready">Sẵn sàng quét</strong> · ${data.rules_count} luật chạy được`:`<strong class="status-blocked">Chưa thể quét</strong> · ${esc((data.blockers || []).join(' · '))}`}</p><p class="muted">Bạn vẫn có thể xem kết quả cũ và sửa tay trong CVAT.</p></div>`;
    document.getElementById('system-nav-state').textContent=data.scan_ready?'✓':'!';
    document.getElementById('btn-start-scan').disabled=!data.scan_ready;
    document.getElementById('system-continue').disabled=false;
  }
  async function check(next=slug){
    slug=next;const id=++epoch;
    document.getElementById('system-checks').innerHTML='<div class="system-loading" role="status">Đang kiểm tra CVAT, runtime và model theo Guideline…</div>';
    document.getElementById('system-continue').disabled=true;
    document.getElementById('system-recheck').disabled=true;
    try{
      const response=await fetch('/api/system/status'+(slug?'?project_slug='+encodeURIComponent(slug):''));
      const data=await response.json();if(!response.ok)throw Error(data.detail || 'Không kiểm tra được môi trường');
      if(id!==epoch)return null;render(data);window.dispatchEvent(new CustomEvent('pointsnap:environment',{detail:data}));return data;
    }catch(error){if(id===epoch){last=null;document.getElementById('system-checks').textContent=error.message;document.getElementById('btn-start-scan').disabled=true;}return null;}
    finally{if(id===epoch)document.getElementById('system-recheck').disabled=false;}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    document.getElementById('system-recheck').addEventListener('click',()=>check());
    document.getElementById('system-checks').addEventListener('click',async event=>{
      const copy=event.target.closest('[data-copy]');
      if(copy){await navigator.clipboard.writeText(copy.dataset.copy);copy.textContent='Đã sao chép';return;}
      if(['system-save-critic','system-save-camera'].includes(event.target.id) && slug){
        const current=slug,isCritic=event.target.id==='system-save-critic';
        const value=isCritic?document.getElementById('system-critic-path').value.trim():document.getElementById('system-camera-mode').value;
        const res=await fetch(`/api/projects/${current}/guideline`);if(!res.ok)return;
        const data=await res.json();if(current!==slug)return;
        if(isCritic)data.config.critic={...data.config.critic,model:value};
        else data.config.camera={...data.config.camera,enabled:value};
        const saved=await fetch(`/api/projects/${current}/guideline`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:data.config})});
        if(!saved.ok){document.getElementById('system-checks').textContent='Không lưu được đường dẫn. Kiểm tra lại Guideline.';return;}await check(current);
      }
    });
  });
  root.PointSnapWorkspace={check,get readiness(){return last;}};
})(window);
