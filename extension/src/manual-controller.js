/* ISOLATED-world controller: scoped guide requests, read-only draft checks, no annotation writes. */
(function(root){
  'use strict';
  const session=Date.now().toString(36)+Math.random().toString(36).slice(2);
  let sequence=0;
  const invalidatedRuns=new Set();
  const knownRuns=new Map();
  const runKey=c=>`${c.slug}:${c.run.run_id}`;
  let current=null,token=0,selected=null,pending=false,guide=null,error='',status='';
  let options={enabled:true,reference:true,rulers:true,points:true};
  let liveData=null;
  let lastRefreshTime=0,refreshTimer=null;

  const post=(type,detail)=>window.postMessage({type,detail},location.origin);
  const esc=s=>String(s || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function refresh(){root.PointSnapPanel?.render();}

  function throttledRefresh(immediate=false){
    const now=Date.now();
    if(immediate || now-lastRefreshTime>120){
      lastRefreshTime=now;
      if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=null;}
      refresh();
    }else if(!refreshTimer){
      refreshTimer=setTimeout(()=>{
        refreshTimer=null;
        lastRefreshTime=Date.now();
        refresh();
      },120);
    }
  }

  function publish(kind,state=null,revision=0,c=current,index=selected){
    if(!c || index==null)return;
    c.request('POST','/api/extension/events',{slug:c.slug,run_id:c.run.run_id,job_id:c.jobId,cvat_url:location.origin,
      finding_index:index,kind,state,revision,session,sequence:++sequence});
  }

  function clear(){
    token++;current=null;selected=null;guide=null;pending=false;error='';liveData=null;
    if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=null;}
    post('POINTSNAP_MANUAL_CLEAR',{});
  }

  function activate(next){
    const key=`${next.jobId}:${next.frame}:${next.run?.run_id}:${next.indices.join(',')}`;
    if(current?.key===key)return;
    clear();current={...next,key};selected=next.indices[0];
    current.findingIndex=selected;knownRuns.set(runKey(current),current);load();
  }

  async function load(){
    if(!current || selected==null)return;
    if(invalidatedRuns.has(runKey(current))){pending=false;guide=null;error='Vừa Save · quét lại để cập nhật ID và hướng dẫn.';refresh();return;}
    const id=++token,c=current;guide=null;pending=true;error='';post('POINTSNAP_MANUAL_CLEAR',{});
    const path=`/api/projects/${c.slug}/scans/${c.run.run_id}/findings/${selected}`;
    const res=await c.request('GET',`${path}/guide`);
    if(id!==token || current!==c)return;
    pending=false;
    if(res.ok && res.data?.schema_version===1){guide=res.data;current.path=path;post('POINTSNAP_MANUAL_GUIDE',{guide,token:id,select:true});}
    else error=res.error || 'Chưa có hướng dẫn · tọa độ/thước vẫn dùng được.';
    publish('selected');refresh();
  }

  function select(index){if(current?.indices.includes(index)){selected=index;current.findingIndex=index;load();refresh();}}
  function toggle(key){if(!(key in options))return;options[key]=!options[key];post('POINTSNAP_MANUAL_OPTIONS',options);refresh();}
  function action(act,param){post('POINTSNAP_MANUAL_ACTION',{action:act,param});}

  function controls(){
    const toggles = `<div class="manual-controls" style="display:flex;gap:4px;flex-wrap:wrap;padding:4px 0 6px">${
      [['enabled','Đo trực tiếp'],['reference','Khung'],['rulers','Thước'],['points','Điểm']].map(([k,label])=>
        `<button class="btn small ${options[k]?'chosen ok':''}" data-action="manual-toggle" data-k="${k}" aria-pressed="${options[k]}" style="flex:1;min-width:68px;justify-content:center;font-size:11px;font-weight:600" title="Bật/tắt ${label}">${options[k]?'●':'○'} ${label}</button>`
      ).join('')}</div>`;

    if(!liveData || !liveData.box) return toggles;

    const b = liveData.box;
    const dims = `${b.dims[0].toFixed(2)} × ${b.dims[1].toFixed(2)} × ${b.dims[2].toFixed(2)}m`;
    const yawDeg = (((b.rotation[2] || 0) * 180) / Math.PI).toFixed(1);
    const pDeg = (liveData.pitchDeg || 0).toFixed(1);
    const rDeg = (liveData.rollDeg || 0).toFixed(1);
    const dCm = Number(liveData.deltaCm || 0).toFixed(1);
    const sign = Number(dCm) > 0 ? '+' : '';

    const telemetryCard = `
      <div class="repair-box" style="margin-top:0;padding:8px 10px;gap:6px;background:var(--surface-2,#F7F9FB);border-left:3px solid var(--primary,#0B63CE)">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">
          <span style="font-weight:700;color:var(--topbar,#0F2A47)">📦 ${dims}</span>
          <span class="mono" style="font-size:11px;color:var(--text-2,#4A5563)">Yaw: ${yawDeg}°</span>
        </div>
        
        <div style="display:flex;align-items:center;justify-content:space-between;background:${liveData.gBg};border:1px solid ${liveData.gBorder};border-radius:4px;padding:4px 8px">
          <span style="font-weight:700;font-size:12px;color:${liveData.gColor}">↕ ${liveData.gStatus}</span>
          <span class="mono" style="font-weight:700;font-size:12px;color:${liveData.gColor}">ΔZ: ${sign}${dCm}cm</span>
        </div>

        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3,#68717D)" class="mono">
          <span>Đáy box: ${(liveData.bottomZ || 0).toFixed(2)}m</span>
          <span>Mặt đường: ${(liveData.activeGroundZ || 0).toFixed(2)}m</span>
        </div>

        <div style="display:flex;gap:6px;margin-top:2px">
          <button class="btn" data-action="manual-action" data-act="ground-adj" data-param="-0.05" style="flex:1;justify-content:center;height:30px;font-weight:600;font-size:12px" title="Hạ mặt đất chuẩn xuống 5cm">▼ -5cm</button>
          <button class="btn" data-action="manual-action" data-act="ground-adj" data-param="0.05" style="flex:1;justify-content:center;height:30px;font-weight:600;font-size:12px" title="Nâng mặt đất chuẩn lên 5cm">▲ +5cm</button>
          <button class="btn" data-action="manual-action" data-act="ground-set-bottom" style="flex:1.4;justify-content:center;height:30px;font-weight:600;font-size:12px;background:var(--primary-soft,#E8F1FC);border-color:var(--primary,#0B63CE);color:var(--primary-text,#0A57B5)" title="Đặt mặt đất chuẩn bằng đúng đáy box">🎯 Đất = Đáy</button>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;border-top:1px dashed var(--border,#DDE2E8);padding-top:6px">
          <span style="font-size:11px;font-weight:700;color:var(--topbar,#0F2A47);text-transform:uppercase;letter-spacing:.02em">Độ nghiêng mặt đường</span>
          <div style="display:flex;gap:4px">
            <button class="btn small" data-action="manual-action" data-act="slope-mode" data-param="vehicle" style="font-size:11px;padding:0 6px;height:22px" title="Căn góc dốc/nghiêng mặt đường theo xe">🚗 Theo xe</button>
            <button class="btn small" data-action="manual-action" data-act="slope-mode" data-param="flat" style="font-size:11px;padding:0 6px;height:22px" title="Đặt mặt đường phẳng ngang hoàn toàn (0°)">⚖️ Phẳng 0°</button>
          </div>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
          <span style="font-size:12px;font-weight:600;color:var(--text,#161B22);min-width:125px">Side (Dốc dọc): <b class="mono" style="color:var(--primary,#0B63CE)">${Number(pDeg)>=0?'+':''}${pDeg}°</b></span>
          <div style="display:flex;gap:4px;flex:1;justify-content:flex-end">
            <button class="btn small" data-action="manual-action" data-act="pitch-adj" data-param="-0.5" style="height:26px;min-width:40px;justify-content:center;font-weight:600" title="Giảm 0.5° góc dốc Side">-0.5°</button>
            <button class="btn small" data-action="manual-action" data-act="pitch-adj" data-param="0.5" style="height:26px;min-width:40px;justify-content:center;font-weight:600" title="Tăng 0.5° góc dốc Side">+0.5°</button>
            <button class="btn small" data-action="manual-action" data-act="pitch-reset" style="height:26px;min-width:30px;justify-content:center;font-size:11px" title="Đặt lại góc dốc Side về 0°">0°</button>
          </div>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
          <span style="font-size:12px;font-weight:600;color:var(--text,#161B22);min-width:125px">Front (Nghiêng): <b class="mono" style="color:var(--primary,#0B63CE)">${Number(rDeg)>=0?'+':''}${rDeg}°</b></span>
          <div style="display:flex;gap:4px;flex:1;justify-content:flex-end">
            <button class="btn small" data-action="manual-action" data-act="roll-adj" data-param="-0.5" style="height:26px;min-width:40px;justify-content:center;font-weight:600" title="Giảm 0.5° góc nghiêng Front">-0.5°</button>
            <button class="btn small" data-action="manual-action" data-act="roll-adj" data-param="0.5" style="height:26px;min-width:40px;justify-content:center;font-weight:600" title="Tăng 0.5° góc nghiêng Front">+0.5°</button>
            <button class="btn small" data-action="manual-action" data-act="roll-reset" style="height:26px;min-width:30px;justify-content:center;font-size:11px" title="Đặt lại góc nghiêng Front về 0°">0°</button>
          </div>
        </div>
      </div>
    `;

    return toggles + telemetryCard;
  }

  function card(){
    if(!current)return '';
    const short={floating:'↕ Cao độ',size:'↔ Kích thước',heading:'⤾ Hướng',fit:'▧ Vị trí'};
    const chips=current.indices.map(i=>{const rule=current.run.findings[i]?.rule || '';return `<button class="btn small ${i===selected?'chosen':''}" data-action="manual-rule" data-n="${i}" aria-pressed="${i===selected}" title="${esc(root.PointSnapCore.RULE_LABEL[rule] || rule)}">${esc(short[rule.split('.')[0]] || rule)}</button>`;}).join('');
    return `<div class="repair-box"><div style="display:flex;flex-wrap:wrap;gap:5px">${chips}</div><p class="small">${esc(pending?'Đang lấy số đo tham chiếu…':error || guide?.instruction || 'Chọn lỗi · kéo sửa bằng CVAT.')}</p><div class="small muted">${esc(status || 'Tâm/kích thước/góc hiện trên canvas · Save/Undo của CVAT')}</div></div>`;
  }

  window.addEventListener('message',async event=>{
    if(event.source!==window || event.origin!==location.origin)return;
    const {type,detail}=event.data || {};
    if(type==='POINTSNAP_MANUAL_TELEMETRY'){
      liveData=detail;
      throttledRefresh();
      return;
    }
    if(type==='POINTSNAP_MANUAL_EDITING' && detail?.token===token){publish('evaluated','insufficient');return;}
    if(type==='POINTSNAP_MANUAL_ACCEPTED' && detail?.token===token){publish('evaluated',detail.result.state,detail.result.revision);return;}
    if(type==='POINTSNAP_MANUAL_CONTEXT' && current && (current.jobId!==detail?.jobId || current.frame!==detail?.frame)){
      clear();return;
    }
    if(type==='POINTSNAP_MANUAL_INVALIDATE'){
      const jobId=detail?.jobId ?? current?.jobId;
      for(const context of knownRuns.values()){
        if(context.jobId!==jobId)continue;
        invalidatedRuns.add(runKey(context));publish('saved','stale',0,context,context.findingIndex);
      }
      if(current?.jobId===jobId){token++;guide=null;pending=false;error=detail?.message || 'Quét lại để cập nhật lỗi.';refresh();}
      return;
    }
    if(type==='POINTSNAP_MANUAL_STATUS'){
      status=detail?.message || '';
      if(detail?.code==='identity_missing'){guide=null;pending=false;error=status;}
      else if(detail?.supported && guide)post('POINTSNAP_MANUAL_GUIDE',{guide,token,select:true});
      refresh();
    }
    if(type!=='POINTSNAP_MANUAL_DRAFT' || !current?.path || detail?.token!==token)return;
    const c=current,t=token,revision=detail.payload?.revision;
    const res=await c.request('POST',`${c.path}/evaluate`,detail.payload);
    if(c!==current || t!==token)return;
    const result=res.ok?res.data:{revision,state:'insufficient',message:res.error || 'Mất kết nối; vẫn có thể sửa tay.'};
    post('POINTSNAP_MANUAL_RESULT',{token:t,result});
  });

  root.PointSnapManualController={activate,clear,select,toggle,action,controls,card,getRule:()=>current?.run?.findings?.[selected]?.rule};
})(globalThis);
