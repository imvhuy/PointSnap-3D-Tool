/* Read-only MAIN-world bridge. Selection/focus are the only CVAT commands. */
(function(root){
  'use strict';
  if(root.PointSnapManualBridge) return;
  const C=root.PointSnapCvatCompat,G=root.PointSnapGeometry;
  let store=null,unsubscribe=null,guide=null,guideToken=null,baseline=null,lastBox=null,lastIdentity='',lastGeometry='',revision=0;
  let evaluation=null,dragging=false,raf=null,timer=null,registered=false,destroyed=false,lastContext=null;
  let options={enabled:true,reference:true,rulers:true,points:true};
  let guideClientId=null,wasSaving=false;
  let inputAt=null;
  let contextKey='';
  const emit=(type,detail)=>window.postMessage({type,detail},location.origin);
  const identityKey=(ctx,record)=>`${ctx.jobId}:${ctx.frame}:${record?.state?.objectType}:${record?.state?.serverID}:${record?.state?.clientID}`;
  function scoped(ctx){return guide && guide.identity.job_id===ctx.jobId && guide.identity.frame===ctx.frame && C.sameOrigin(guide.identity.cvat_origin,location.origin);}
  function reset(){guide=null;guideToken=null;baseline=null;evaluation=null;lastBox=null;lastGeometry='';lastIdentity='';revision++;C.clearCache?.();root.PointSnapManualOverlay.clear();}
  function inspect(){try{return C.inspect(store);}catch(_){return null;}}
  function sample(){
    if(destroyed)return;
    try {
    const now=performance.now(),ctx=inspect();lastContext=ctx;
    if(!ctx){root.PointSnapManualOverlay.clear();lastBox=null;}
    else {
      if(guide && !scoped(ctx)){guide=null;guideToken=null;evaluation=null;baseline=null;revision++;}
      let rec=null;try{rec=C.record(ctx);}catch(_){}
      const box=rec?C.readBox(rec,ctx.frame):null;
      if(!box){root.PointSnapManualOverlay.clear();lastBox=null;}
      else {
        const id=identityKey(ctx,rec),geometry=JSON.stringify([box.center,box.dims,box.rotation]);
        if(id!==lastIdentity){baseline=JSON.parse(JSON.stringify(box));lastIdentity=id;evaluation=null;revision++;}
        if(geometry!==lastGeometry){lastGeometry=geometry;revision++;evaluation=null;
          clearTimeout(timer);if(!dragging){timer=setTimeout(evaluateDraft,350);}}
        lastBox=box;
        const activeGuide=scoped(ctx) && rec.state.clientID===guideClientId && rec.state.serverID===guide.identity.server_id && rec.state.objectType===guide.identity.kind?guide:null;
        root.PointSnapManualOverlay.render({context:ctx,box,baseline,guide:activeGuide,options,
          evaluation:activeGuide?evaluation:null,dragging,sampledAt:now,inputAt});
      }
      if(!box && scoped(ctx) && guide.missing && G.valid(guide.baseline)) {
        root.PointSnapManualOverlay.render({context:ctx,box:guide.baseline,baseline:guide.baseline,guide,options,evaluation:null,dragging:false,sampledAt:now});
      }
    }
    } catch (_) {
      root.PointSnapManualOverlay.clear();
    }
    raf=requestAnimationFrame(sample);
  }
  async function evaluateDraft(){
    const ctx=inspect();if(!ctx || !scoped(ctx) || guide.missing || !lastBox || dragging)return;
    const rec=C.record(ctx);
    if(rec?.state?.clientID!==guideClientId || rec?.state?.serverID!==guide.identity.server_id || rec?.state?.objectType!==guide.identity.kind)return;
    const token=guideToken,rev=revision,id=lastIdentity,box=JSON.parse(JSON.stringify(lastBox));
    evaluation={state:'checking',message:'Đang kiểm tra hình học vừa chỉnh…'};
    try {
      const payload=await C.draft(ctx,box,guide.rule);
      if(rev!==revision || token!==guideToken || id!==lastIdentity)return;
      payload.revision=rev;
      if(JSON.stringify(payload).length>1500000){evaluation={state:'insufficient',message:'Ngữ cảnh nhãn quá lớn; Save rồi quét lại để kiểm tra.'};return;}
      emit('POINTSNAP_MANUAL_DRAFT',{token,payload});
    }catch(_){if(rev===revision)evaluation={state:'insufficient',message:'Không đọc đủ nhãn chưa lưu; tiếp tục sửa tay hoặc quét lại.'};}
  }
  function setGuide(detail){
    const next=detail?.guide,ctx=inspect();
    if(next?.schema_version!==1 || !ctx || !next.identity || next.identity.job_id!==ctx.jobId || next.identity.frame!==ctx.frame || !C.sameOrigin(next.identity.cvat_origin,location.origin))return;
    guide=next;guideToken=detail.token;evaluation=null;revision++;
    if(next.missing)return;
    const rec=C.record(ctx,next.identity);
    if(!rec){emit('POINTSNAP_MANUAL_STATUS',{message:'Không tìm thấy đúng ID box; quét lại sau Save.',supported:true,code:'identity_missing'});return;}
    guideClientId=rec.state.clientID;
    if(detail.select!==false){
      ctx.dom.perspective.dispatchEvent(new CustomEvent('canvas.selected',{detail:{clientID:rec.state.clientID}}));
      ctx.canvas.focus(rec.state.clientID);
    }
  }
  function onMessage(event){
    if(event.source!==window || event.origin!==location.origin || !event.data?.type?.startsWith('POINTSNAP_MANUAL_'))return;
    const {type,detail}=event.data;
    if(type==='POINTSNAP_MANUAL_GUIDE')setGuide(detail);
    else if(type==='POINTSNAP_MANUAL_CLEAR'){guide=null;guideToken=null;evaluation=null;revision++;}
    else if(type==='POINTSNAP_MANUAL_OPTIONS' && detail){for(const key of Object.keys(options))if(typeof detail[key]==='boolean')options[key]=detail[key];}
    else if(type==='POINTSNAP_MANUAL_RESULT' && detail?.token===guideToken && detail.result?.revision===revision){evaluation=detail.result;emit('POINTSNAP_MANUAL_ACCEPTED',{token:guideToken,result:evaluation});}
  }
  function isCanvasTarget(target){
    if(!lastContext || !target)return false;
    const doms=Object.values(lastContext.dom);
    if(doms.includes(target))return true;
    for(const d of doms){
      if(d===target || d?.contains?.(target) || d?.parentElement?.contains?.(target))return true;
    }
    return false;
  }
  function onDown(event){
    if(!isCanvasTarget(event.target))return;
    if(lastBox)baseline=JSON.parse(JSON.stringify(lastBox));
    dragging=true;evaluation=null;revision++;emit('POINTSNAP_MANUAL_EDITING',{token:guideToken});clearTimeout(timer);
  }
  function onUp(){if(!dragging)return;dragging=false;clearTimeout(timer);timer=setTimeout(evaluateDraft,350);}
  function onMove(event){if(dragging && isCanvasTarget(event.target))inputAt=performance.now();}
  let boundCanvas=null;
  function stateChanged(){
    const ctx=inspect();
    if(ctx && contextKey!==`${ctx.jobId}:${ctx.frame}`){contextKey=`${ctx.jobId}:${ctx.frame}`;emit('POINTSNAP_MANUAL_CONTEXT',{jobId:ctx.jobId,frame:ctx.frame});}
    const saving=!!store?.getState?.()?.annotation?.annotations?.saving?.uploading;
    if(saving && !wasSaving){reset();emit('POINTSNAP_MANUAL_INVALIDATE',{jobId:store.getState().annotation.job.instance.id,message:'Vừa Save · quét lại để khớp ID và kết quả lỗi mới.'});}
    wasSaving=saving;
    if(ctx && boundCanvas!==ctx.dom.perspective){
      boundCanvas?.removeEventListener('canvas.edited',onEdited);boundCanvas=ctx.dom.perspective;
      boundCanvas.addEventListener('canvas.edited',onEdited);
      emit('POINTSNAP_MANUAL_STATUS',{supported:true,message:'Đã nối canvas 3D · kéo sửa bằng CVAT'});
    }
  }
  function onEdited(){evaluation=null;clearTimeout(timer);timer=setTimeout(evaluateDraft,350);}
  function connect(){
    if(registered || !window.cvatUI?.registerComponent)return;
    registered=true;
    window.cvatUI.registerComponent(({store:s})=>{
      store=s;unsubscribe=store.subscribe(stateChanged);stateChanged();
      emit('POINTSNAP_MANUAL_STATUS',{supported:!!inspect(),message:inspect()?'Đã nối canvas 3D':'Chờ mở job 3D tương thích CVAT 2.77.1'});
      return {name:'PointSnap Manual Guides v2',destructor:destroy};
    });
    raf=requestAnimationFrame(sample);
  }
  function destroy(){destroyed=true;unsubscribe?.();cancelAnimationFrame(raf);clearTimeout(timer);clearInterval(retry);boundCanvas?.removeEventListener('canvas.edited',onEdited);window.removeEventListener('message',onMessage);document.removeEventListener('mousedown',onDown,true);document.removeEventListener('mouseup',onUp,true);document.removeEventListener('pointerdown',onDown,true);document.removeEventListener('pointerup',onUp,true);document.removeEventListener('mousemove',onMove,true);window.removeEventListener('blur',onUp);document.removeEventListener('plugins.ready',connect);root.PointSnapManualOverlay.clear();}
  window.addEventListener('message',onMessage);document.addEventListener('plugins.ready',connect);
  document.addEventListener('mousedown',onDown,true);document.addEventListener('mouseup',onUp,true);
  if(typeof window!=='undefined' && typeof PointerEvent!=='undefined'){
    document.addEventListener('pointerdown',onDown,true);document.addEventListener('pointerup',onUp,true);
  }
  document.addEventListener('mousemove',onMove,{capture:true,passive:true});
  window.addEventListener('blur',onUp);
  const retry=setInterval(()=>{connect();if(registered)clearInterval(retry);},500);connect();
  root.PointSnapManualBridge={destroy,reset,getRevision:()=>revision,performanceStats:()=>root.PointSnapManualOverlay.performanceStats()};
})(globalThis);
