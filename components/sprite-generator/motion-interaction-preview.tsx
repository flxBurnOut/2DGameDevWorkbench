'use client';
/* oxlint-disable next/no-img-element -- Shows hash-bound native PNGs without rewriting frames. */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AssetImportPicker } from '@/components/workbench/asset-import-picker';
import { contextFromAsset } from '@/features/interaction-preview/import';
import { evaluateInteraction, localPoint, objectLocalPoint, objectWorldPoint, previewBounds, sampleAt, worldPoint, type InteractionContext, type InteractionView, type Anchor, type Point, type InteractionSource } from '@/features/interaction-preview/model.mjs';
import { motionRequest, motionUrl } from './open-motion-model';
import { publishEditorSession, removeEditorSession } from '@/lib/workbench/editor-session';
import './motion-interaction-preview.css';

function recordPoint(anchors: Anchor[], frame: number, point: Point, part: string): Anchor[] {
  const anchor=anchors.find(a=>a.id==='contact') || {id:'contact',name:'交互点',part,provenance:'manual' as const,evidence:'用户在当前实际帧点击标注；未观察帧保持未知',samples:[]};
  return [...anchors.filter(a=>a.id!=='contact'),{...anchor,samples:[...anchor.samples.filter(s=>s.frame!==frame),{frame,state:'visible',point}]}];
}

export function JointCanvas({source,context,seconds,onPoint,pointTarget,showPoints=false,onImageError}: {
  source:InteractionSource;context:InteractionContext;seconds:number;
  onPoint?:(entity:'actor'|'object',frame:number,state:string,point:Point)=>void;pointTarget?:'actor'|'object';showPoints?:boolean;onImageError?:()=>void;
}) {
  const tintId=`joint-tint-${useId().replace(/:/g,'')}`;
  const sample=sampleAt(source,context,seconds),bounds=previewBounds(source,context);
  const frame=sample.actor,object=sample.object;
  const actorUrl=motionUrl(`open-motion/${source.work_id}/interaction/frames/${frame.index}`,{
    revision:String(source.revision),candidate:String(source.candidate),...(source.stage===null?{}:{stage:String(source.stage)}),token:source.token,
  });
  const objectOrigin=objectWorldPoint({x:0,y:0},context,object.state),objectExtent=objectWorldPoint({x:object.state.width,y:object.state.height},context,object.state);
  const objectMatrix=`matrix(${(objectExtent.x-objectOrigin.x)/object.state.width} 0 0 ${(objectExtent.y-objectOrigin.y)/object.state.height} ${objectOrigin.x} ${objectOrigin.y})`;
  const tint=object.state.tint||'#ffffff',rgb=[1,3,5].map(i=>parseInt(tint.slice(i,i+2),16)/255);
  const layers=[{id:'actor' as const,p:context.actor,w:frame.width,h:frame.height,url:actorUrl,anchors:context.actor_anchors,index:frame.index,region:null,native:frame,visible:true},
    {id:'object' as const,p:context.object,w:object.state.width,h:object.state.height,url:`data:image/png;base64,${object.image.png_base64}`,anchors:object.state.anchors,index:object.frame,region:object.image.region,native:object.image,visible:object.state.visible!==false}].sort((a,b)=>a.p.depth-b.p.depth);
  return <svg className="joint-canvas" aria-label="角色与物件联合效果" viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} onPointerDown={event=>{
    if (!onPoint) return;
    const matrix=event.currentTarget.getScreenCTM();if(!matrix)return;
    const world=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
    for(const layer of [...layers].reverse()) {
      if(!layer.visible||(pointTarget&&layer.id!==pointTarget))continue;
      const point=layer.id==='object'?objectLocalPoint(world,context,object.state):localPoint(world,layer.p);
      if(point.x>=0&&point.y>=0&&point.x<layer.w&&point.y<layer.h) {onPoint(layer.id,layer.index,object.state.id,{x:Math.floor(point.x),y:Math.floor(point.y)});break;}
    }
  }}>
    <title>角色与物件联合效果</title>
    <defs><filter id={tintId} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values={`${rgb[0]} 0 0 0 0 0 ${rgb[1]} 0 0 0 0 0 ${rgb[2]} 0 0 0 0 0 1 0`}/></filter></defs>
    {layers.filter(layer=>layer.visible).map(layer=><g key={layer.id} transform={layer.id==='object'?objectMatrix:`translate(${layer.p.position.x} ${layer.p.position.y}) scale(${layer.p.scale*(layer.p.flip_x?-1:1)} ${layer.p.scale}) translate(${-layer.p.origin.x} ${-layer.p.origin.y})`}>
      <svg width={layer.w} height={layer.h} preserveAspectRatio="none" viewBox={layer.region?`${layer.region.x} ${layer.region.y} ${layer.region.width} ${layer.region.height}`:`0 0 ${layer.w} ${layer.h}`}>
        <image href={layer.url} width={layer.native.width} height={layer.native.height} filter={layer.id==='object'?`url(#${tintId})`:undefined} onError={onImageError}/>
      </svg>
    </g>)}
    {showPoints&&layers.filter(layer=>layer.visible).flatMap(layer=>layer.anchors.flatMap(anchor=>{
      const item=anchor.samples.find(s=>s.frame===layer.index);if(item?.state!=='visible'||!item.point)return [];
      const point=layer.id==='object'?objectWorldPoint(item.point,context,object.state):worldPoint(item.point,layer.p);
      return <circle key={`${layer.id}-${anchor.id}`} cx={point.x} cy={point.y} r={2} fill={layer.id==='actor'?'#b69aff':'#69e3ed'} stroke="#101521" strokeWidth={.5}/>;
    }))}
    {showPoints&&object.state.visible!==false&&object.state.surfaces?.map(surface=>{
      const start=objectWorldPoint(surface.start,context,object.state),end=objectWorldPoint(surface.end,context,object.state);
      return <line key={`surface-${surface.id}`} x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#69e3ed" strokeWidth={.75}><title>{surface.name}</title></line>;
    })}
  </svg>;
}

export function MotionInteractionPreview({workId,revision,candidate,stage,children,onStop}: {
  workId:string;revision:number;candidate:number;stage?:number;children:ReactNode;onStop:()=>void;
}) {
  const [joint,setJoint]=useState(false),[view,setView]=useState<InteractionView|null>(null),[context,setContext]=useState<InteractionContext|null>(null);
  const [error,setError]=useState(''),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[picker,setPicker]=useState(false),[editing,setEditing]=useState(false);
  const [seconds,setSeconds]=useState(0),[playing,setPlaying]=useState(false),[marking,setMarking]=useState(false),[imageError,setImageError]=useState(false);
  const [pending,setPending]=useState<{payload:unknown}|null>(null);
  const [rebinding,setRebinding]=useState(false);
  const [actorAnchor,setActorAnchor]=useState('contact');
  const [pointTarget,setPointTarget]=useState<'actor'|'object'>('actor');
  const playFrom=useRef(0);
  const route=`open-motion/${workId}/interaction`;
  const pendingKey=`forge-joint-pending:${workId}:${revision}:${candidate}:${stage??'full'}`;
  const query=useMemo(()=>({revision:String(revision),candidate:String(candidate),...(stage!==undefined?{stage:String(stage)}:{})}),[revision,candidate,stage]);
  const refresh=async()=>{
    const next=await motionRequest<InteractionView>(route,undefined,query);
    setView(next);setContext(next.document?.context||null);setDirty(false);setError(next.error||'');setPlaying(false);setSeconds(0);setImageError(false);setRebinding(false);
    setActorAnchor(next.document?.context.relations[0]?.actor_anchor||'contact');
  };
  useEffect(()=>{
    if(!joint)return;
    const abort=new AbortController();
    void motionRequest<InteractionView>(route,undefined,query,abort.signal).then(next=>{
      if(abort.signal.aborted)return;
      setView(next);setContext(next.document?.context||null);setDirty(false);setError(next.error||'');setSeconds(0);setImageError(false);
      setActorAnchor(next.document?.context.relations[0]?.actor_anchor||'contact');
      const saved=sessionStorage.getItem(pendingKey);
      if(saved){const draft=JSON.parse(saved) as {payload:{context:InteractionContext;expected_revision:number;candidate_index:number;stage_index:number|null}};
        if(draft.payload.expected_revision!==revision||draft.payload.candidate_index!==candidate||draft.payload.stage_index!==(stage??null))throw new Error('上次联合预览请求身份不匹配。');
        setPending(draft);setContext(draft.payload.context);setDirty(true);setError('上次保存的结果待核对，请点击“核对上次保存”。');}
    }).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
    return ()=>abort.abort();
  },[joint,route,query,pendingKey,revision,candidate,stage]);
  const source=view?.source;
  const duration=source?source.frames.length/source.fps:0;
  useEffect(()=>{
    if(!playing||!source)return;
    let raf=0;const start=performance.now(),from=playFrom.current;
    const tick=(now:number)=>{const time=from+(now-start)/1000;setSeconds(Math.min(time,duration-1e-8));if(time>=duration)setPlaying(false);else raf=requestAnimationFrame(tick);};
    raf=requestAnimationFrame(tick);return ()=>cancelAnimationFrame(raf);
  },[playing,source,duration]);
  useEffect(()=>{
    if(!dirty&&!pending)return;
    const prevent=(e:BeforeUnloadEvent)=>{e.preventDefault();};window.addEventListener('beforeunload',prevent);
    return ()=>window.removeEventListener('beforeunload',prevent);
  },[dirty,pending]);
  useEffect(()=>{
    if(!joint||(!dirty&&!busy&&!pending))return;
    const blocked=async()=>{throw new Error('请先在联合预览中保存或放弃未保存修改。');};
    publishEditorSession({capabilityId:'interaction-preview',items:[],dirty:dirty||!!pending,busy,save:blocked,beforeLeave:blocked});
    return ()=>removeEditorSession('interaction-preview');
  },[joint,dirty,busy,pending]);
  const reports=useMemo(()=>source&&context?evaluateInteraction(source,context):[],[source,context]);
  const change=(next:InteractionContext)=>{setContext(next);setDirty(true);setPlaying(false);setError('');};
  const save=async()=>{
    if(!source||!context||!view)return;
    setBusy(true);setPlaying(false);setError('');
    const submission=pending || {payload:{expected_revision:revision,candidate_index:candidate,stage_index:stage??null,source_token:source.token,expected_context_version:view.context_version,request_key:crypto.randomUUID(),context}};
    setPending(submission);
    try {
      sessionStorage.setItem(pendingKey,JSON.stringify(submission));
      const next=await motionRequest<InteractionView>(route,submission.payload);
      sessionStorage.removeItem(pendingKey);setPending(null);setView(next);setContext(next.document?.context||null);setDirty(false);setEditing(false);setMarking(false);setRebinding(false);
    } catch(e){
      const status=(e as Error & {status?:number}).status;
      const rejected=!!status&&status>=400&&status<500;
      if(rejected){setPending(null);sessionStorage.removeItem(pendingKey);}
      setError((e as Error).message+(!rejected?'；原记录保留。再次保存会核对同一次请求。':'；未保存本次修改，请调整输入或重新读取。'));
    } finally {setBusy(false);}
  };
  const rebind=async()=>{
    setBusy(true);setError('');setPlaying(false);
    try{
      const next=await motionRequest<InteractionView>(route,undefined,query);
      setView(next);
      if(!next.source||!next.work_current||next.error)throw new Error(next.error||'当前作品来源尚不可用。');
      const saved=next.document;
      if(saved?.source.token===next.source.token&&saved.context.structure_binding){
        if(next.structure.state!=='available')throw new Error('请先在结构观察中核对并确认当前版本，再重新核对这里的结构依据。');
        // The artwork and object agreement are unchanged. Replace only the
        // explicitly re-confirmed V2 evidence, without making the user re-mark it.
        setContext({...saved.context,structure_binding:next.structure.binding,
          actor_anchors:[...saved.context.actor_anchors.filter(a=>a.provenance==='manual'),...next.structure.anchors]});
        setDirty(true);
      }else{
        setContext(null);setDirty(false);
      }
      setRebinding(true);setSeconds(0);setImageError(false);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const play=async()=>{
    if(playing){setPlaying(false);return;}
    if(!source||!context)return;
    try{
      const next=await motionRequest<InteractionView>(route,undefined,query);
      if(next.source?.token!==source.token||!next.work_current||context.structure_binding&&JSON.stringify(context.structure_binding)!==JSON.stringify(next.structure.binding)){
        setView(next);setError('动画或结构版本已变化，请重新核对联合预览。');setPlaying(false);return;
      }
      playFrom.current=seconds>=duration-.01?0:seconds;if(playFrom.current===0)setSeconds(0);setPlaying(true);
    }catch(e){setError((e as Error).message);}
  };
  return <div className="joint-preview">
    <div className="joint-tabs" aria-label="预览内容">
      <button aria-pressed={!joint} disabled={busy||dirty||!!pending} onClick={()=>{setPlaying(false);setJoint(false);}}>角色</button>
      <button aria-pressed={joint} onClick={()=>{onStop();setJoint(true);}}>联合效果</button>
    </div>
    {!joint?children:<>
      {error&&<p role="alert" className="motion-danger">{error}</p>}
      {!view&&!error&&<p>正在读取联合预览…</p>}
      {view&&!view.source_current&&!rebinding&&<div role="alert"><p>动画或结构版本已变化，或尚无可用帧，联合预览已停止。原约定保留。</p>{view.work_current&&source&&!view.error&&<button disabled={busy||!!pending} onClick={()=>void rebind()}>{view.document?.source.token===source.token&&view.document.context.structure_binding?'重新核对结构依据':'为当前帧重新建立约定'}</button>}</div>}
      {source&&(view?.source_current||rebinding)&&<>
        {!context?<div className="joint-empty"><p>选择已保存的交互物，与此动画一起预览。</p><button onClick={()=>setPicker(true)}>从资产库选择物件</button></div>:<>
          <JointCanvas source={source} context={context} seconds={seconds} pointTarget={pointTarget} showPoints={editing} onImageError={()=>{setPlaying(false);setImageError(true);}} onPoint={marking&&!busy&&!pending?(entity,frame,state,point)=>{
            if(entity==='actor')change({...context,actor_anchors:recordPoint(context.actor_anchors,frame,point,'用户指定的角色部位')});
            else change({...context,object_states:context.object_states.map(s=>s.id===state?{...s,anchors:recordPoint(s.anchors,frame,point,'用户指定的物件部位')}:s)});
          }:undefined}/>
          {imageError&&<p role="alert">预览图片未完整加载，不能确认联合效果。</p>}
          <div className="joint-playback"><button disabled={imageError||busy} onClick={()=>void play()}>{playing?'暂停':'播放联合效果'}</button>
            <input aria-label="联合预览时间" type="range" min="0" max={Math.max(0,duration-1e-8)} step={1/120} value={seconds} onChange={e=>{setPlaying(false);setSeconds(Number(e.target.value));}}/>
            <span>{seconds.toFixed(2)} / {duration.toFixed(2)} 秒</span></div>
          <p className="motion-muted">{context.object_source.label} · 使用导入时的素材版本 · {dirty?'未保存':'已保存本机'} · 仅预览，不调用模型</p>
          <p className="motion-muted">物件状态：{sampleAt(source,context,seconds).object.state.name}{sampleAt(source,context,seconds).object.state.visible===false?' · 已隐藏':''}</p>
          <div className="joint-summary">{reports.length?reports.map(r=><span key={r.id} data-status={r.status}>{r.name}：{r.status==='matched'?'指定窗口符合约定':r.status==='mismatch'?'存在错配':'观察不足，待核对'}</span>):<span>尚未约定交互点和时机；摆放在一起不代表交互正确。</span>}</div>
          <button className="joint-edit-toggle" onClick={()=>{setPlaying(false);setEditing(e=>!e);}}> {editing?'收起设置':'调整联合预览'} </button>
          {editing&&<fieldset className="joint-settings" disabled={busy||!!pending}>
            <button onClick={()=>setPicker(true)}>更换预览物件</button>
            {view?.structure.state==='available'?<p>可复用已核对的 V2 结构（{view.structure.anchors.length} 类语义点，未观察的帧保持未知）。<button onClick={()=>{change({...context,structure_binding:view.structure.binding,actor_anchors:[...context.actor_anchors.filter(a=>a.provenance==='manual'),...view.structure.anchors]});setActorAnchor(context.relations[0]?.actor_anchor||view.structure.anchors[0]?.id||'contact');}}>使用已核对结构</button></p>:<p>当前动画没有可复用的已确认结构锚点。可先在“结构观察”核对，或明确使用人工标点；人工标点不算结构复用成功。</p>}
            <label>新增关系使用的角色作用点<select value={actorAnchor} onChange={e=>setActorAnchor(e.target.value)}><option value="contact">手工指定交互点</option>{context.actor_anchors.filter(a=>a.id!=='contact').map(a=><option key={a.id} value={a.id}>{a.name} · {a.part}</option>)}</select></label>
            <p>先摆放素材，再逐帧点击可见的交互点。没有标注的帧保持未知。</p>
            <div className="joint-placement">{(['actor','object'] as const).map(entity=><section key={entity}><b>{entity==='actor'?'角色':'物件'}</b>
              {(['x','y'] as const).map(axis=><label key={axis}>{axis.toUpperCase()}<input aria-label={`${entity} ${axis}`} type="number" value={context[entity].position[axis]} onChange={e=>change({...context,[entity]:{...context[entity],position:{...context[entity].position,[axis]:Number(e.target.value)}}})}/></label>)}
              <label>比例<input type="number" min="0.05" max="16" step="0.1" value={context[entity].scale} onChange={e=>{const scale=Number(e.target.value);if(scale>0)change({...context,[entity]:{...context[entity],scale}});}}/></label>
              <label><input type="checkbox" checked={context[entity].flip_x} onChange={e=>change({...context,[entity]:{...context[entity],flip_x:e.target.checked}})}/>水平翻转</label>
            </section>)}</div>
            <label>前景<select value={context.actor.depth>context.object.depth?'actor':'object'} onChange={e=>change({...context,actor:{...context.actor,depth:e.target.value==='actor'?1:0},object:{...context.object,depth:e.target.value==='object'?1:0}})}><option value="actor">角色</option><option value="object">物件</option></select></label>
            <label><input type="checkbox" checked={marking} onChange={e=>{setMarking(e.target.checked);setPlaying(false);}}/>点击画面标注当前帧的交互点</label>
            {marking&&<label>标注对象<select value={pointTarget} onChange={e=>setPointTarget(e.target.value as 'actor'|'object')}><option value="actor">角色</option><option value="object">物件</option></select></label>}
            <button onClick={()=>{
              const state=sampleAt(source,context,seconds).object.state;
              const target=state.anchors[0]||state.surfaces?.[0];
              if(!context.actor_anchors.some(a=>a.id===actorAnchor)||!target){setError('请先选用角色结构作用点，并提供物件的交互点或已保存表面。');return;}
              change({...context,relations:[...context.relations,{id:`relation_${crypto.randomUUID().slice(0,8)}`,name:'交互关系',kind:state.anchors.length?'contact':'surface_contact',actor_anchor:actorAnchor,object_anchor:target.id,window:{start:seconds,end:seconds},tolerance_px:Math.max(1,source.frames[0].width*context.actor.scale*.03),tolerance_reason:'初始值为角色显示宽度的 3%；请按实际交互部位核对后保存',response_state:null,response_window:null}]});
            }}>约定此刻的交互</button>
            {context.relations.map((r,i)=><div className="joint-relation" key={r.id}>
              <select aria-label="关系类型" value={r.kind} onChange={e=>{
                const kind=e.target.value as typeof r.kind,targets=context.object_states.flatMap<{id:string;name:string}>(s=>kind==='surface_contact'?s.surfaces||[]:s.anchors);
                if(!targets.length)return;
                change({...context,relations:context.relations.map((r,j)=>j===i?{...r,kind,object_anchor:targets.some(t=>t.id===r.object_anchor)?r.object_anchor:targets[0].id}:r)});
              }}><option value="contact" disabled={!context.object_states.some(s=>s.anchors.length)}>接触</option><option value="attached" disabled={!context.object_states.some(s=>s.anchors.length)}>保持连接</option><option value="separated" disabled={!context.object_states.some(s=>s.anchors.length)}>保持分离</option><option value="surface_contact" disabled={!context.object_states.some(s=>s.surfaces?.length)}>接触表面</option></select>
              <label>物件作用位置<select value={r.object_anchor} onChange={e=>change({...context,relations:context.relations.map((r,j)=>j===i?{...r,object_anchor:e.target.value}:r)})}>{[...new Map(context.object_states.flatMap<{id:string;name:string}>(s=>r.kind==='surface_contact'?s.surfaces||[]:s.anchors).map(a=>[a.id,a])).values()].map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              {(['start','end'] as const).map(key=><label key={key}>{key==='start'?'起始秒':'结束秒'}<input type="number" min="0" max={duration} step={1/source.fps} value={r.window[key]} onChange={e=>change({...context,relations:context.relations.map((r,j)=>j===i?{...r,window:{...r.window,[key]:Number(e.target.value)}}:r)})}/></label>)}
              <label>{r.kind==='separated'?'最小间隔':'允许偏差'}（像素）<input type="number" min="1" value={r.tolerance_px} onChange={e=>change({...context,relations:context.relations.map((r,j)=>j===i?{...r,tolerance_px:Number(e.target.value)}:r)})}/></label>
              <label>偏差依据<input aria-label="偏差依据" value={r.tolerance_reason} onChange={e=>change({...context,relations:context.relations.map((r,j)=>j===i?{...r,tolerance_reason:e.target.value}:r)})}/></label>
              <label>预期物件响应<select value={r.response_state||''} onChange={e=>change({...context,relations:context.relations.map((r,j)=>j===i?{...r,response_state:e.target.value||null,response_window:e.target.value?{...r.window}:null}:r)})}><option value="">不约定状态变化</option>{context.object_states.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
              {r.response_window&&(['start','end'] as const).map(key=><label key={`response-${key}`}>响应{key==='start'?'最早':'最晚'}秒<input type="number" min="0" max={duration} step={1/source.fps} value={r.response_window![key]} onChange={e=>change({...context,relations:context.relations.map((r,j)=>j===i?{...r,response_window:{...r.response_window!,[key]:Number(e.target.value)}}:r)})}/></label>)}
              <button onClick={()=>change({...context,relations:context.relations.filter((_,j)=>j!==i)})}>移除此约定</button>
            </div>)}
            {context.object_states.length>1&&<div className="joint-response"><label>物件在当前时刻切换到<select value="" onChange={e=>{
              if(!e.target.value)return;const current=sampleAt(source,context,Math.max(0,seconds-1e-8)).object.state.id;
              change({...context,events:[...context.events.filter(e=>e.time<seconds),{time:seconds,from_state:current,to_state:e.target.value}]});
            }}><option value="">选择状态</option>{context.object_states.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <p>重新播放会重置物件状态；此处只预览已保存外观，不执行游戏脚本。</p>
            {context.events.map((e,i)=><p key={i}>{e.time.toFixed(2)} 秒：{context.object_states.find(s=>s.id===e.from_state)?.name} → {context.object_states.find(s=>s.id===e.to_state)?.name} <button onClick={()=>change({...context,events:context.events.slice(0,i)})}>撤销此处及后续响应</button></p>)}</div>}
            <details><summary>来源与测量依据</summary><p>{context.object_source.asset_id} · {context.object_source.revision}</p><p>角色播放帧与原始帧映射已绑定哈希。人工点击是观察记录，不是自动识别结果。</p>
              {context.structure_binding&&view?.structure.point_evidence&&<p>当前帧结构依据：{view.structure.point_evidence.filter(p=>p.frame===sampleAt(source,context,seconds).actor.index).map(p=>`${p.anchor_id} · ${p.origin==='manual_anchor_correction'?'人工纠正':p.origin==='stale_manual_anchor'?'旧纠正已失效':p.origin==='unobserved'?'未观察':'模型观察'} · ${p.state}`).join('；')||'本帧没有已观察的语义点，不从相邻帧补造。'}</p>}
              {reports.map(r=><p key={r.id}>{r.name} · 最大距离 {r.max_distance?.toFixed(2)??'未知'} 像素 · 缺少观察 {r.missing} 处 · {r.timing?`响应偏差 ${r.timing.error_seconds??'未发生'} 秒`:'未约定响应时间'}</p>)}
            </details>
          </fieldset>}
          {(dirty||pending)&&<div className="joint-actions"><button disabled={busy} onClick={()=>void save()}>{busy?'正在保存…':pending?'核对上次保存':'保存联合预览'}</button><button disabled={busy||!!pending} onClick={()=>{void refresh().catch(e=>setError(e.message));}}>放弃未保存修改</button></div>}
        </>}
      </>}
      <AssetImportPicker open={picker} onClose={()=>setPicker(false)} purposes={['interactable']} onImport={async bundle=>{
        if(!source)return;change(await contextFromAsset(bundle,source));setEditing(true);
      }}/>
    </>}
  </div>;
}
