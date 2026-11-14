'use client';
/* oxlint-disable next/no-img-element -- Displays hash-bound original/alternative PNGs. */
import {useEffect,useRef,useState} from 'react';
import {motionRequest,motionUrl,motionPlanningRequestKey,type MotionWork,type MotionReview} from './open-motion-model';
import {MotionVisualReview} from './motion-visual-review';
import {MotionEditRegion,type RegionDraft,type EditRegion} from './motion-edit-region';
import {MotionPanel} from './motion-panel';
import {adjustmentRangeError,adjustmentAttemptBudget} from './motion-adjustment-range';

type ComparisonFinding={status:'pass'|'fail'|'uncertain';evidence:string;requires_human_adjudication:boolean};

type Adjustment={repair_level?:'deterministic'|'restricted_generation'|'window_redraw'|'stage_redraw';usage?:{units?:number;cost_usd?:number};id:string;request_key?:string;state:string;message:string;start:number;end:number;source_token:string;preview_token?:string;
  user_request:string;intent_source:string;intent?:{goal:string;preserve:string;method:string;conflict:string};
  proposed_frames?:{sha256:string}[];review?:MotionReview&{comparison?:{findings:{change:ComparisonFinding;preservation:ComparisonFinding}}};qa?:{hard_failures:unknown[];warnings:unknown[]};
  spatial_protection?:{frames:{protected_pixels:number;protected_changed_pixels:number;changed_inside_pixels:number}[]};
  planning_calls:unknown[];generation_calls:unknown[];review_calls:unknown[];fps:number};
type Context={token:string;frames:{sha256:string}[];width:number;height:number;fps:number;locked_frames:number[];editable_stage_end?:boolean;appearance_max:number;attempt_limit:number;attempt_scope?:string;legacy_frame_attempts?:number[];
  suggestions:{text:string;frames:number[]}[];tasks:Adjustment[];budget:{planning:number;generation:number;review:number}};
type Response={adjustment:Adjustment;work:MotionWork};
const processing=new Set(['queued','planning','submitting','pending','reviewing','adopting']);
const unresolved=new Set([...processing,'ready','unknown']);

export function MotionAdjustment({work,candidate,stage,readOnly,onSaved,onPendingChange,onOpenChange}:{work:MotionWork;candidate:number;stage?:number;
  readOnly:boolean;onSaved:(w:MotionWork)=>void;onPendingChange?:(pending:boolean)=>void;onOpenChange?:(open:boolean)=>void}) {
  const [reviewSeconds,setReviewSeconds]=useState('');
  const [open,setOpen]=useState(false),[context,setContext]=useState<Context|null>(null),[task,setTask]=useState<Adjustment|null>(null);
  const [start,setStart]=useState<number|null>(null),[end,setEnd]=useState<number|null>(null),[user,setUser]=useState('');
  const [level,setLevel]=useState<'auto'|'local'|'appearance'|'transition'>('auto');
  const [paletteFrom,setPaletteFrom]=useState('#808080'),[paletteTo,setPaletteTo]=useState('#00ff00');
  const [spatial,setSpatial]=useState(false),[historyPreview,setHistoryPreview]=useState(false);
  const [regionDraft,setRegionDraft]=useState<RegionDraft|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[frame,setFrame]=useState(0),[playing,setPlaying]=useState(false);
  const [loaded,setLoaded]=useState(''),[played,setPlayed]=useState(false),[note,setNote]=useState(''),[ack,setAck]=useState(false);
  const drag=useRef<number|null>(null),request=useRef<{key:string;body:string}|null>(null);
  const route=`open-motion/${work.id}/adjustments`;
  const draftKey=`forge-adjustment:${work.id}:${work.revision}:${candidate}:${stage??'clip'}`;
  const pending=Boolean(task&&unresolved.has(task.state)),running=Boolean(task&&processing.has(task.state));
  const ready=task?.state==='ready';
  useEffect(()=>{onPendingChange?.(pending);},[pending,onPendingChange]);
  useEffect(()=>{onOpenChange?.(open);return()=>onOpenChange?.(false);},[open,onOpenChange]);
  useEffect(()=>{
    if(readOnly)return;
    const abort=new AbortController();
    void motionRequest<Context>(route,undefined,{revision:String(work.revision),candidate:String(candidate),...(stage===undefined?{}:{stage:String(stage)})},abort.signal).then(c=>{
      setContext(c);const current=c.tasks.find(t=>unresolved.has(t.state))||c.tasks.at(-1)||null;setTask(current);
      if(current&&unresolved.has(current.state))setOpen(true);
    }).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
    return()=>abort.abort();
  },[route,work.revision,work.job?.revision,candidate,stage,readOnly]);
  useEffect(()=>{
    let live=true;
    void Promise.resolve().then(()=>{try {const saved=JSON.parse(localStorage.getItem(draftKey)||'null');if(saved&&live){setStart(saved.start);setEnd(saved.end);setUser(saved.user||'');setSpatial(saved.spatial===true);setRegionDraft(saved.regionDraft?.frames?saved.regionDraft:null);}}
      catch { /* A corrupt UI draft is never submitted. */ }});
    return()=>{live=false;};
  },[draftKey]);
  function editSelection(a:number,b:number){setStart(Math.min(a,b));setEnd(Math.max(a,b));request.current=null;}
  useEffect(()=>{if(start!==null||user) localStorage.setItem(draftKey,JSON.stringify({start,end,user,spatial,regionDraft}));},[draftKey,start,end,user,spatial,regionDraft]);
  useEffect(()=>{
    if(!task||!processing.has(task.state))return;
    const abort=new AbortController();
    const timer=setTimeout(()=>{void motionRequest<Response>(`${route}/${task.id}`,undefined,undefined,abort.signal).then(r=>{
      setReviewSeconds('');setTask(r.adjustment);setContext(c=>c?{...c,tasks:c.tasks.map(t=>t.id===r.adjustment.id?r.adjustment:t)}:c);
      if(!processing.has(r.adjustment.state))onSaved(r.work);
    }).catch(e=>{if(!abort.signal.aborted)setError(e.message);});},1500);
    return()=>{clearTimeout(timer);abort.abort();};
  },[task,route,onSaved]);
  useEffect(()=>{
    const stop=()=>{drag.current=null;};window.addEventListener('pointerup',stop);return()=>window.removeEventListener('pointerup',stop);
  },[]);
  const evidence=task?.preview_token;
  const previewCount=task?.proposed_frames?.length||0;
  useEffect(()=>{
    if(!evidence||!previewCount||!task?.id)return;
    let live=true;
    void Promise.all(Array.from({length:previewCount},(_,i)=>i).flatMap(i=>['source','proposed'].map(kind=>new Promise<void>((resolve,reject)=>{
      const img=new Image();img.onload=()=>resolve();img.onerror=()=>reject(new Error('对比图片未完整加载，请稍后重试'));
      img.src=motionUrl(`${route}/${task.id}/${kind}/${i}`,{v:evidence});
    })))).then(()=>{if(live){setLoaded(evidence);setPlaying(false);setPlayed(false);setFrame(0);setAck(false);setNote('');}}).catch(e=>{if(live)setError(e.message);});
    return()=>{live=false;};
  },[evidence,task?.id,previewCount,route]);
  useEffect(()=>{
    if(!playing||!task?.proposed_frames)return;
    const timer=setTimeout(()=>{if(frame===task.proposed_frames!.length-1){setPlaying(false);setPlayed(true);}else setFrame(f=>f+1);},1000/task.fps);
    return()=>clearTimeout(timer);
  },[playing,frame,task]);
  if(readOnly)return null;
  const count=context?.frames.length||0,length=start!==null&&end!==null?end-start+1:0;
  const rangeError=context?adjustmentRangeError(start,end,count,context.locked_frames,context.appearance_max,spatial):'';
  const valid=Boolean(context&&!rangeError);
  const attempts=context&&valid?adjustmentAttemptBudget(context,start!,end!):null;
  const suggestion=context?.suggestions.filter(s=>s.frames.some(f=>start!==null&&end!==null&&f-1>=start&&f-1<=end)).map(s=>s.text).join('；')||'';
  const regions=regionDraft?.token===context?.token?regionDraft?.frames||{}:{};
  const selectedRegions=valid?Array.from({length},(_,i)=>regions[start!+i]):[];
  const regionsReady=Boolean(context&&valid&&selectedRegions.every((r,i)=>r?.source_sha256===context.frames[start!+i]?.sha256&&
    Array.isArray(r?.spans)&&r.spans.length>0&&r.spans.reduce((total,s)=>total+s.length,0)<context.width*context.height));
  function changeRegion(region:EditRegion){if(context)setRegionDraft({token:context.token,frames:{...regions,[region.frame]:region}});request.current=null;}
  const warning=Boolean(task&&(task.review?.verdict!=='pass'||task.qa?.warnings?.length));
  const blocked=Boolean(task?.qa?.hard_failures?.length);
  async function submit(){
    if(!context||!valid||(spatial&&!regionsReady))return;setBusy(true);setError('');setHistoryPreview(false);
    const body={expected_revision:work.revision,candidate_index:candidate,stage_index:stage??null,token:context.token,start,end,user_request:user,
      ...(level==='appearance'?{requested_method:'appearance',preserve_motion:true}:level==='transition'?{requested_method:'transition'}:{}),
      ...(spatial?{preserve_motion:true,edit_regions:selectedRegions}:{}),
      authorized:true,max_planning_calls:1,max_generation_calls:1,max_review_calls:context.budget.review};
    const identity=JSON.stringify(body);request.current={key:motionPlanningRequestKey(task,request.current?.body===identity?request.current.key:''),body:identity};
    try {const r=await motionRequest<Response>(route,{...body,request_key:request.current.key});setTask(r.adjustment);
      setContext(c=>c?{...c,tasks:[...c.tasks.filter(t=>t.id!==r.adjustment.id),r.adjustment]}:c);onSaved(r.work);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function localPalette(){
    if(!context||start===null||end===null)return;
    const indices=context.frames.map((_,i)=>i).filter(i=>i>=start&&i<=end&&!context.locked_frames.includes(i));
    if(!indices.length)return;
    const body={expected_revision:work.revision,candidate_index:candidate,stage_index:stage,token:context.token,
      description:'整帧精确替色 '+paletteFrom+' → '+paletteTo,palette:[{source:paletteFrom,target:paletteTo}],
      frames:indices.map(i=>({region:{frame:i,source_sha256:context.frames[i].sha256,spans:[{start:0,length:context.width*context.height}]}}))};
    const identity=JSON.stringify(body);request.current={key:motionPlanningRequestKey(task,request.current?.body===identity?request.current.key:''),body:identity};
    setBusy(true);setError('');
    try{const r=await motionRequest<{adjustment:Adjustment}>(`open-motion/${work.id}/local-frame-edits`,{...body,request_key:request.current.key});setTask(r.adjustment);setContext(c=>c?{...c,tasks:[...c.tasks,r.adjustment]}:c);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function decide(decision:'accept'|'reject'){
    if(!task)return;setBusy(true);setError('');
    try{const r=await motionRequest<Response>(`${route}/${task.id}/decision`,{token:task.preview_token||task.source_token,decision,note,...(reviewSeconds===''?{}:{human_seconds:Number(reviewSeconds)}),acknowledge_warnings:ack});
      setReviewSeconds('');setTask(r.adjustment);setContext(c=>c?{...c,tasks:c.tasks.map(t=>t.id===r.adjustment.id?r.adjustment:t)}:c);
      onSaved(r.work);localStorage.removeItem(draftKey);setOpen(false);setStart(null);setEnd(null);setUser('');setSpatial(false);setRegionDraft(null);setHistoryPreview(false);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const original=(i:number)=>motionUrl(stage===undefined?`jobs/${work.job?.job_id}/candidates/${candidate}/frames/${i}/image`:
    `open-motion/${work.id}/candidates/${candidate}/stages/${stage}/frames/${i}`,{revision:String(work.revision),v:context?.token||''});
  return <section className="motion-adjustment">
    {!open?<button onClick={()=>setOpen(true)}>调整部分帧{pending?' · 有备选待处理':''}</button>:<div className="motion-card-title"><h3>调整部分帧</h3><button onClick={()=>{setOpen(false);setPlaying(false);}}>返回动画检查</button></div>}
    {open&&<div className="motion-adjustment-body">
      <p className="motion-muted">选择允许替换的连续帧，其余帧保持原样。个人偏好也可以作为修改目标。</p>
      {error&&<p role="alert" className="motion-danger">{error}</p>}
      {task&&(pending||historyPreview)?<>
        <output>{task.message}</output>
        <p>本次替换第 {task.start+1}–{task.end+1} 帧 · {task.user_request||task.intent?.goal||'按所选范围的专家建议'}</p>
        {task.proposed_frames&&<>
          <div className="motion-adjustment-compare">{(['source','proposed'] as const).map(kind=><figure key={kind}>
            <figcaption>{kind==='source'?'原版':'备选'}</figcaption><div className="motion-canvas"><img alt={`${kind==='source'?'原版':'备选'}第 ${frame+1} 帧`} src={motionUrl(`${route}/${task.id}/${kind}/${frame}`,{v:task.preview_token||''})} /></div>
          </figure>)}</div>
          <div className="motion-card-title"><button disabled={loaded!==task.preview_token} onClick={()=>{setFrame(0);setPlayed(false);setPlaying(true);}}>同步播放完整对比</button><span>{frame+1} / {task.proposed_frames.length} · {task.fps} FPS</span></div>
          <input aria-label="备选对比逐帧" type="range" min={0} max={task.proposed_frames.length-1} value={frame} onChange={e=>{setPlaying(false);setFrame(Number(e.target.value));}} />
          {task.spatial_protection&&<p className="motion-notice">未涂选区域已逐像素核验，保持原样。{task.spatial_protection.frames.every(f=>f.changed_inside_pixels===0)?'本次涂选区域也没有实际变化，不能视为修改成功。':'请重点检查涂选区域与边缘衔接。'}</p>}
          <MotionPanel title="备选检查详情">
          {task.review?.comparison&&<div className="motion-comparison-results">{(['change','preservation'] as const).map(key=>{
            const finding=task.review!.comparison!.findings[key];
            return <section key={key}><h3>{key==='change'?'修改目标':'其他内容保持'}：{finding.status==='pass'?'模型判断通过':finding.status==='fail'?'发现问题':'需要实际对比确认'}</h3><p>{finding.evidence}</p>{finding.requires_human_adjudication&&<p>复核提出取消先前疑点，仍须实际画面确认。</p>}</section>;
          })}</div>}
          {task.review&&<MotionVisualReview report={task.review}/>}
          {task.repair_level&&<p>工具级别：{{deterministic:'确定性编辑',restricted_generation:'受限生成',window_redraw:'段内重画',stage_redraw:'全部可编辑帧重画'}[task.repair_level]} · {task.repair_level==='deterministic'?'费用 0':task.usage?.cost_usd!==undefined?'绘图回执 $'+task.usage.cost_usd:task.usage?.units!==undefined?'绘图回执 '+task.usage.units+' 单位':'绘图费用尚未确认'}</p>}
          <p>需求理解 {task.planning_calls.length} 次 · 绘图 {task.generation_calls.length} 次 · 复核 {task.review_calls.length} 次</p><p>{task.intent?.preserve}</p>
          </MotionPanel>
          {task.review&&<MotionVisualReview report={task.review} compact/>}
          {ready&&<>
          {blocked&&<p className="motion-danger">备选存在技术阻断，请保留原版。</p>}
          <label>人工检查用时（秒，可留空）<input aria-label="人工检查用时" type="number" min={0} max={86400} step={1} value={reviewSeconds} onChange={e=>setReviewSeconds(e.target.value)}/></label>
      <label>对比结论<textarea aria-label="备选对比结论" value={note} onChange={e=>setNote(e.target.value)} maxLength={2000} placeholder="实际播放后，简要说明为什么选择这个版本" /></label>
          {warning&&<label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>已看过实际画面，接受本次视觉与技术提醒</label>}
          <div className="motion-card-title"><button className="motion-primary" disabled={busy||!played||note.trim().length<4||blocked||(warning&&!ack)} onClick={()=>void decide('accept')}>采用新版</button><button disabled={busy} onClick={()=>void decide('reject')}>保留原版</button></div>
          {!played&&<p className="motion-muted">先播放完整对比，再决定是否采用。</p>}
          </>}
        </>}
        {task.state==='unknown'&&<><p>结果未知，尚无备选可展示；不会自动重新生成。</p><button disabled={busy} onClick={()=>void decide('reject')}>结束此次尝试，保留记录</button></>}
        {historyPreview&&<button onClick={()=>setHistoryPreview(false)}>返回新建修改</button>}
      </>:<>
        {task&&['failed','needs_input','rejected'].includes(task.state)&&<p className="motion-notice">{!task.intent&&!task.generation_calls.length&&task.planning_calls.length?`修改要求理解未完成，尚未绘图，没有生成备选。${task.message.replace('视觉检查','修改要求理解')}`:task.message}</p>}
        {context?<>
          <label>修正工具<select aria-label="修正工具" value={level} onChange={e=>{setLevel(e.target.value as typeof level);setSpatial(e.target.value==='appearance');request.current=null;}}>
            <option value="auto">按修改要求推荐</option><option value="local">确定性替色 · 免费</option><option value="appearance">受限生成 · 保留动作与选区外像素</option><option value="transition">段内重画 / 全部可编辑帧重画</option></select></label>
          <div className="motion-frame-selection"  aria-label="选择允许修改的帧">{context.frames.map((_,i)=><button type="button" key={i}
            aria-label={`选择第 ${i+1} 帧`} aria-pressed={start!==null&&end!==null&&i>=start&&i<=end} disabled={busy||context.locked_frames.includes(i)}
            onPointerDown={e=>{if(e.button!==0)return;drag.current=i;editSelection(i,i);}}
            onPointerEnter={()=>{if(drag.current!==null)editSelection(drag.current,i);}}
            onClick={e=>{if(e.detail===0)editSelection(start===null?i:start,i);}}>
            <img src={original(i)} alt="" draggable={false}/><span>{i+1}{context.locked_frames.includes(i)?' · 保留':context.editable_stage_end&&i===count-1?' · 未锁定段尾':''}</span>
          </button>)}</div>
          <div className="motion-adjustment-range"><label>开始帧<input aria-label="修改开始帧" type="number" min={1} max={count} value={start===null?'':start+1} onChange={e=>{setStart(e.target.value?Number(e.target.value)-1:null);request.current=null;}}/></label>
          <label>结束帧<input aria-label="修改结束帧" type="number" min={1} max={count} value={end===null?'':end+1} onChange={e=>{setEnd(e.target.value?Number(e.target.value)-1:null);request.current=null;}}/></label>
          <span>{valid?`仅替换第 ${start!+1}–${end!+1} 帧`:'拖动选择一段连续帧，或输入起止帧'}</span></div>
          {level==='local'?<><p>对范围内每个可编辑帧的全部像素执行同一精确 RGB 映射；透明像素、未命中的颜色与锁定帧保留。生成备选后再播放确认。</p>
          <label>原色<input type="color" value={paletteFrom} onChange={e=>setPaletteFrom(e.target.value)}/></label>
          <label>新色<input type="color" value={paletteTo} onChange={e=>setPaletteTo(e.target.value)}/></label>
          <button onClick={()=>editSelection(0,count-1)}>选中全部可编辑帧</button>
          <button disabled={busy||start===null||end===null||start<0||end>=count||start>end||!context.frames.some((_,i)=>i>=start&&i<=end&&!context.locked_frames.includes(i))} onClick={()=>void localPalette()}>保存替色备选</button></>:<>
          {(start!==null||end!==null)&&!valid&&<p role="alert" className="motion-danger">{rangeError}</p>}
          {valid&&length>context.appearance_max&&<p className="motion-notice">当前尺寸的原帧细节编辑最多 {context.appearance_max} 帧。此范围仅适合明确要求重做动作；只修外观时请缩小范围，不会因数量限制改做另一种动作。</p>}
          {valid&&context.editable_stage_end&&end===count-1&&<p className="motion-muted">本段末帧尚未锁定，可以一起调整；采用并确认本段后，后续制作才会使用新的末帧。</p>}
          <label>修改要求（选填）<textarea aria-label="修改要求（选填）" value={user} maxLength={1800} onChange={e=>{setUser(e.target.value);request.current=null;}} placeholder="例如：我希望这里抬手幅度小一点。留空时按上述建议；填写后以你的要求为准。"/></label>
          {!user.trim()&&<p className="motion-muted">{suggestion?`留空将采用建议：${suggestion.slice(0,110)}${suggestion.length>110?'…':''}`:'所选范围暂无可用建议，请填写希望怎样修改。'}</p>}
          {!!suggestion&&<MotionPanel title="查看专家建议"><p>{suggestion}</p><p>填写自己的要求后，以你的要求为准，不额外执行其他建议。</p></MotionPanel>}
          <label><input type="checkbox" disabled={level==='appearance'||level==='transition'} checked={spatial} onChange={e=>{setSpatial(e.target.checked);request.current=null;}}/>精确限定修改区域（可选）</label>
          {spatial&&<p className="motion-muted">逐帧涂选允许改变的位置，区域外像素原样保留。未勾选时按原帧和文字要求修改，再对比复核；未要求改变的内容仍应保持。</p>}
          {valid&&spatial&&context.width&&context.height&&<MotionEditRegion start={start!} end={end!} width={context.width} height={context.height} frames={context.frames} regions={regions} source={original} onChange={changeRegion}/>}
          <p className="motion-muted">本次最多 1 次需求理解、1 次绘图、{context.budget.review} 次复核，按实际调用计费。生成备选后再决定是否采用；不会自动再次尝试。</p>
          {valid&&spatial&&!regionsReady&&<p className="motion-muted">先为每个选中帧涂选局部区域，再生成备选；也可以取消勾选，直接按文字要求修改。</p>}
          <button className="motion-primary" disabled={busy||running||!valid||(spatial&&!regionsReady)||(!user.trim()&&!suggestion)||attempts?.remaining===0} onClick={()=>void submit()}>生成一个备选</button>
          {attempts&&<p className="motion-muted">{attempts.legacy?(attempts.remaining===0?'当前服务仍按整个片段限制次数，请刷新服务后再检查。':''):
            attempts.remaining===0?`第 ${attempts.blocked.join('、')} 帧已达到 ${context.attempt_limit} 次绘图试做上限；其他帧仍可选择，原版与记录保留。`:
            `当前选区还可试做 ${attempts.remaining} 次。其他帧的修改和未进入绘图的失败不占用这里的次数。`}</p>}
          </>}
          {!!context.tasks.length&&<MotionPanel title={`修改记录 · ${context.tasks.length}`}>{context.tasks.map(t=><section key={t.id}><p>第 {t.start+1}–{t.end+1} 帧 · {!t.generation_calls.length&&!t.proposed_frames?.length?'未生成备选。':''}{!t.generation_calls.length&&t.planning_calls.length?t.message.replace('视觉检查','修改要求理解'):t.message}</p><p>需求理解 {t.planning_calls.length} 次，绘图 {t.generation_calls.length} 次，复核 {t.review_calls.length} 次</p>{!!t.proposed_frames?.length&&<button onClick={()=>{setTask(t);setHistoryPreview(true);}}>查看此次对比</button>}</section>)}</MotionPanel>}
        </>:<p>正在读取可调整范围…</p>}
      </>}
    </div>}
  </section>;
}
