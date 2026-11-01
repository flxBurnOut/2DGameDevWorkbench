'use client';
/* oxlint-disable next/no-img-element -- These previews show immutable local evidence bytes. */
import { useEffect, useRef, useState } from 'react';
import { ImagePartPlanner, type PartSuggestion } from './image-part-planner';
import { attributeDefaults, attributeLabels, attributeNames, type AttributePolicy } from '@/features/image-edit/attribute-plan.mjs';
import type { RegionSpec } from '@/features/image-edit/core.mjs';
import { imageEditRequest, imageGuards, imageResolveInput, type ImageTargetInfo, type ImageEditSession, type ImageEditOperation, type ImageAiReference, type RecolorSurface, type SimpleColorMapping } from '@/features/image-edit/client';

type Analysis={analysisId:string;status:string;error?:string;previews?:Record<string,string>};
type Plan={planRef:string;part:string;previewPng:string;localPreviewPng?:string;warnings:string[];scope:{count:number};maxImageCalls:number;
  softReference?:{kind:'rgb'|'shading'};softReferencePreviewPng?:string;
  recolorDecision?:{route:'stop'|'simple-rgb-fallback'|'simple-luminance-fallback'|'intrinsic-delta';assessment:{reasons:string[];visible:number;unstablePixels:number;originCounts:Record<string,number>}}};
const disagreementLabels:Record<string,string>={
  'backdrop-albedo':'换衬底后的底色','backdrop-shading':'换衬底后的明暗','backdrop-residual':'换衬底后的残差',
  'ensemble-albedo':'同一衬底下多次估计的底色','ensemble-shading':'同一衬底下多次估计的明暗','ensemble-residual':'同一衬底下多次估计的残差',
};
interface Props {target:ImageTargetInfo;session:ImageEditSession;baseVersion:string;region:RegionSpec|null;prompt:string;references:readonly ImageAiReference[];preserveAlpha:boolean;disabled:boolean;offerPlanner:boolean;onSelectRegion:(region:RegionSpec)=>void;onExecute:(operation:ImageEditOperation,planRef:string)=>void;onBusy:(label:string)=>void;}
export function ImageAttributePlan(props:Props){
  const [part,setPart]=useState(''),[policy,setPolicy]=useState<AttributePolicy>({...attributeDefaults.recolor});
  const [criteria,setCriteria]=useState('目标变化在游戏摆放尺寸下可辨认\n保持指定结构与画风\n边界、透明度无新增缺陷');
  const [allowed,setAllowed]=useState<RegionSpec|null>(null),[targetRegion,setTargetRegion]=useState<RegionSpec|null>(null),[influenceRegion,setInfluence]=useState<RegionSpec|null>(null),[protectedRegions,setProtected]=useState<RegionSpec[]>([]);
  const [executor,setExecutor]=useState<'ai-edit'|'intrinsic-recolor'|'color-map'>('ai-edit'),[from,setFrom]=useState('#b66a32'),[to,setTo]=useState('#3270b6'),[fallback,setFallback]=useState<'stop'|'simple'>('stop');
  const [changesSilhouette,setChangesSilhouette]=useState(false);
  const [mapping,setMapping]=useState<SimpleColorMapping>('rgb');
  const [softKind,setSoftKind]=useState<'none'|'rgb'|'shading'>('none');
  const [surface,setSurface]=useState<RecolorSurface>('unknown');
  const [origin,setOrigin]=useState<{ref:string;instruction:string;alpha:boolean;revision:number}|null>(null);
  const [colorsConfirmed,setColorsConfirmed]=useState(false);
  const [lastTaggedRegion,setLastTaggedRegion]=useState<RegionSpec|null>(null);
  const [preset,setPreset]=useState('recolor');
  const originStale=origin && (origin.instruction!==props.prompt.trim() || origin.alpha!==props.preserveAlpha || origin.revision!==props.session.revision);
  const unassignedSelection=!!origin && JSON.stringify(lastTaggedRegion)!==JSON.stringify(props.region);
  function useSuggestion(ref:string,suggestion:PartSuggestion,maximum:RegionSpec,useBox:boolean) {
    if(!suggestion.target) return;
    if(!useBox && !props.region){setError('请先在画布上选择要保留的范围。');return;}
    const combined=new Map(protectedRegions.map(region=>[JSON.stringify(region),region]));
    if(useBox)for(const item of suggestion.protect ?? [])combined.set(JSON.stringify(item.region),item.region);
    if(combined.size>32){setError('合并后超过 32 个保护区。请先取消部分建议保护框。');return;}
    setAllowed(maximum);
    if(useBox) {
      setTargetRegion(suggestion.target); setInfluence(suggestion.influence ?? null);
      setProtected(Array.from(combined.values()));
      props.onSelectRegion(suggestion.target);
    } else {
      setTargetRegion(JSON.stringify(props.region)===JSON.stringify(maximum) ? null : props.region);
      setInfluence(null);
    }
    setPart(suggestion.part);
    setLastTaggedRegion(useBox?suggestion.target:props.region);
    setPreset('custom'); setPolicy({...suggestion.policy}); setCriteria(suggestion.successCriteria.join('\n'));
    setChangesSilhouette(suggestion.changesSilhouette); setContext(true);
    setExecutor(suggestion.kind==='recolor' && props.preserveAlpha ? 'color-map' : 'ai-edit');
    setColorsConfirmed(false); setReady(null);
    setOrigin({ref,instruction:props.prompt.trim(),alpha:props.preserveAlpha,revision:props.session.revision});
  }
  const [analysis,setAnalysis]=useState<Analysis|null>(()=>{const saved=props.session.analyses?.filter(a=>a.baseCandidateVersion===props.baseVersion).at(-1);return saved?{analysisId:saved.analysisId,status:'running'}:null;}),[error,setError]=useState(''),[pending,setPending]=useState(false),[context,setContext]=useState(true);
  const [ready,setReady]=useState<{plan:Plan;operation:ImageEditOperation;key:string}|null>(null);
  const softEnabled=executor==='ai-edit'&&context&&softKind!=='none';
  const softBlocked=softEnabled&&(props.references.length>6||(softKind==='shading'&&analysis?.status!=='completed'));
  const draftKey=JSON.stringify([props.session.editId,props.session.revision,props.baseVersion,props.region,props.prompt,props.references.map(r=>r.id),props.preserveAlpha,part,policy,criteria,allowed,targetRegion,influenceRegion,protectedRegions,executor,from,to,fallback,surface,mapping,context,softKind,analysis?.analysisId,changesSilhouette,origin?.ref,colorsConfirmed]);
  const planAttempt=useRef<{key:string;id:string}|null>(null),analysisAttempt=useRef<string|null>(null);
  const keyRef=useRef(draftKey);useEffect(()=>{keyRef.current=draftKey;},[draftKey]);
  const prepared=ready?.key===draftKey && !originStale && !unassignedSelection ? ready:null;
  const mainDisagreement=Object.entries(prepared?.plan.recolorDecision?.assessment.originCounts??{}).sort((a,b)=>b[1]-a[1])[0];
  useEffect(()=>{
    if(analysis?.status!=='running')return;
    let disposed=false;const id=analysis.analysisId;
    const timer=setInterval(()=>{void imageEditRequest<{analysis:Analysis}>('analysis-get',{analysisId:id}).then(r=>{if(!disposed)setAnalysis(r.analysis);}).catch(cause=>{if(!disposed)setError(String(cause.message));});},3000);
    return()=>{disposed=true;clearInterval(timer);};
  },[analysis?.analysisId,analysis?.status]);
  const prepare=async()=>{
    const region=allowed??props.region;if(!region||props.disabled||pending)return;
    const submittedKey=draftKey;setPending(true);props.onBusy('准备属性计划');setError('');
    try{
      const operation:ImageEditOperation=executor==='ai-edit'?{type:'ai-edit',prompt:props.prompt.trim(),...(props.references.length?{references:props.references.map(r=>r.source)}:{})}:executor==='color-map'?{type:'color-map',from,to,mapping}:{type:'intrinsic-recolor',from,to,analysisId:analysis?.analysisId??'',fallback,surface,fallbackMapping:mapping};
      const {regionRef}=await imageEditRequest<{regionRef:string}>('resolve',imageResolveInput(props.target,region));
      if(planAttempt.current?.key!==submittedKey)planAttempt.current={key:submittedKey,id:crypto.randomUUID()};
      const result=await imageEditRequest<{plan:Plan}>('plan-prepare',{...imageGuards(props.target),editId:props.session.editId,expectedEditRevision:props.session.revision,baseCandidateVersion:props.baseVersion,regionRef,commandId:planAttempt.current.id,...(origin?{partRef:origin.ref}:{}),part,policy,successCriteria:criteria.split('\n').map(s=>s.trim()).filter(Boolean),...(targetRegion?{targetRegion}:{}),...(influenceRegion?{influenceRegion}:{}),protectedRegions,operation,constraints:{preserveOutsideRegion:true,preserveDimensions:true,preserveAlpha:executor==='ai-edit'?props.preserveAlpha:true},changesSilhouette,localContext:context,...(softEnabled?{softReference:softKind==='shading'?{kind:'shading',analysisId:analysis?.analysisId}:{kind:'rgb'}}:{})});
      if(keyRef.current===submittedKey)setReady({plan:result.plan,operation,key:submittedKey});
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setPending(false);props.onBusy('');}
  };
  const analyze=async(fresh=false)=>{
    if(props.disabled||pending||analysis?.status==='running')return;setPending(true);props.onBusy('启动本地分层');setError('');
    if(analysis&&['completed','failed','attention_required'].includes(analysis.status))analysisAttempt.current=crypto.randomUUID();
    analysisAttempt.current??=crypto.randomUUID();
    try{const result=await imageEditRequest<{analysis:Analysis}>('analysis-create',{...imageGuards(props.target),editId:props.session.editId,expectedEditRevision:props.session.revision,baseCandidateVersion:props.baseVersion,commandId:analysisAttempt.current,...(fresh?{fresh:true}:{})});setAnalysis(result.analysis);}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setPending(false);props.onBusy('');}
  };
  return <details className="ie-attribute-plan" open={props.offerPlanner && !!props.prompt.trim()}><summary>部件与属性计划 · 试验</summary><fieldset disabled={props.disabled||pending}>
    {props.offerPlanner && <ImagePartPlanner target={props.target} session={props.session} baseVersion={props.baseVersion} allowed={allowed??props.region} instruction={props.prompt} preserveAlpha={props.preserveAlpha} disabled={props.disabled||pending} onBusy={props.onBusy} onUse={useSuggestion}/>}
    {origin&&<p>已载入视觉建议。修正画布选区后，点「将当前选区设为目标」更新计划。{originStale&&'原建议已过期。'} <button type="button" onClick={()=>{setOrigin(null);setReady(null);}}>转为手动计划</button></p>}
    <label>目标部件<input value={part} placeholder="例如：石座下方正面的圆形徽章" onChange={e=>setPart(e.target.value)} maxLength={500}/></label>
    <label>起始策略<select value={preset} onChange={e=>{setPreset(e.target.value);setPolicy({...attributeDefaults[e.target.value as keyof typeof attributeDefaults]});}}>{preset==='custom'&&<option value="custom">逐项指定</option>}<option value="recolor">保形换色</option><option value="material">替换材质</option><option value="part">替换部件</option></select></label>
    {attributeNames.map(name=><label key={name}>{attributeLabels[name]}<select value={policy[name]} onChange={e=>setPolicy({...policy,[name]:e.target.value as AttributePolicy[typeof name]})}><option value="preserve">保持</option><option value="edit">修改</option><option value="recompute">允许重算</option></select></label>)}
    <p className="ie-hint">先在画布选择最大授权范围，再选择目标或保护部分。所有坐标沿用当前原图。</p>
    <button type="button" disabled={!props.region} onClick={()=>{setOrigin(null);setAllowed(props.region);setTargetRegion(null);setInfluence(null);setProtected([]);}}>将当前选区设为授权范围</button>
    <button type="button" disabled={!allowed||!props.region} onClick={()=>{setTargetRegion(props.region);setLastTaggedRegion(props.region);}}>将当前选区设为目标</button>
    <button type="button" disabled={!allowed||!props.region} onClick={()=>{setInfluence(props.region);setLastTaggedRegion(props.region);}}>将当前选区设为允许影响区</button>
    <button type="button" disabled={!allowed||!props.region||protectedRegions.length>=32} onClick={()=>{if(props.region)setProtected([...protectedRegions,props.region]);setLastTaggedRegion(props.region);}}>将当前选区加入保护区</button>
    {unassignedSelection && <output>画布选区已改变。请先将它设为目标、影响区或保护区，再准备计划。</output>}
    <button type="button" onClick={()=>{setOrigin(null);setAllowed(null);setTargetRegion(null);setInfluence(null);setProtected([]);}}>使用当前选区，清除附加范围</button>
    <p className="ie-hint">{allowed?'授权范围已固定':'授权范围随当前选区'} · {targetRegion?'已单独指定目标':'目标沿用授权范围'} · {influenceRegion?'已指定影响区':'无附加影响区'} · {protectedRegions.length} 个保护区</p>
    {protectedRegions.map((_,i)=><button key={i} type="button" onClick={()=>setProtected(protectedRegions.filter((_,j)=>i!==j))}>移除保护区 {i+1}</button>)}
    <label>成功条件（每行一条）<textarea rows={3} value={criteria} onChange={e=>setCriteria(e.target.value)}/></label>
    <label><input type="checkbox" checked={changesSilhouette} onChange={e=>setChangesSilhouette(e.target.checked)}/>此任务需要改变透明轮廓</label>
    {changesSilhouette&&props.preserveAlpha&&<output>请先关闭上方“保持透明度”，或取消改变轮廓；冲突时不会生成。</output>}
    <label>执行方式<select value={executor} onChange={e=>setExecutor(e.target.value as typeof executor)}><option value="ai-edit">生成外观</option><option value="intrinsic-recolor">分层换色实验</option><option value="color-map">简单换色对照</option></select></label>
    {executor==='ai-edit'?<>
      <label><input type="checkbox" checked={context} onChange={e=>setContext(e.target.checked)}/>发送同一基准的干净局部图，辅助定位</label>
      {context&&<label>额外表面参考<select value={softKind} onChange={e=>setSoftKind(e.target.value as typeof softKind)}>
        <option value="none">仅用干净局部图</option><option value="rgb">普通 RGB 局部图（对照）</option><option value="shading">分层明暗图（试验）</option>
      </select></label>}
      {softEnabled&&props.references.length>6&&<p>干净局部图和额外参考各占一位。请将已选参考减至六张，或取消额外参考。</p>}
      {softEnabled&&softKind==='shading'&&<><p>生成器会看到同一区域的明暗估计，最终光照由生成结果决定。</p>
        {analysis?.status!=='completed'&&<button type="button" disabled={analysis?.status==='running'} onClick={()=>void analyze()}>准备明暗图（本机分析）</button>}</>}
    </>:<>
      <div className="ie-row"><label>原底色<input type="color" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>新底色<input type="color" value={to} onChange={e=>setTo(e.target.value)}/></label></div>
      <p className="ie-hint">适用于保形、保材质的换色。保持其余属性和透明度；请核对选区，排除需要保留原色的细节。</p>
      {(executor==='color-map'||fallback==='simple')&&<label>简单换色算法<select value={mapping} onChange={e=>setMapping(e.target.value as SimpleColorMapping)}><option value="rgb">RGB 通道比例</option><option value="luminance">保留相对明暗，统一色相</option></select></label>}
      {executor==='intrinsic-recolor'&&<>
        <label>部件表面<select value={surface} onChange={e=>setSurface(e.target.value as RecolorSurface)}>
          <option value="unknown">尚未确认</option><option value="diffuse">有明暗的哑光表面</option><option value="reflective">金属或强反光</option><option value="emissive">自发光或含光晕</option><option value="translucent">半透明材质</option>
        </select></label>
        {surface==='diffuse'?<button type="button" disabled={analysis?.status==='running'} onClick={()=>void analyze(analysis?.status==='completed')}>{analysis?.status==='completed'?'重新分析当前基准（本机运行）':'分析当前基准（可复用本地结果）'}</button>
          :<><p>此类表面建议先用简单换色检查目标颜色、明暗与边缘。</p><button type="button" onClick={()=>{setExecutor('color-map');setMapping('luminance');}}>使用保明暗简单换色</button></>}
        <label>分解不可信时<select value={fallback} onChange={e=>setFallback(e.target.value as typeof fallback)}><option value="stop">停止，不生成候选</option><option value="simple">整块回退到简单换色</option></select></label>
      </>}
    </>}
    {analysis&&<output>分层状态：{analysis.status}{analysis.error&&` · ${analysis.error}`}</output>}
    {analysis?.previews&&<div className="ie-ai-references">{Object.entries(analysis.previews).map(([name,png])=><figure key={name}><img src={`data:image/png;base64,${png}`} alt={name}/><figcaption>{{albedo:'底色',shading:'明暗',residual:'残差',uncertainty:'分歧'}[name]??name}</figcaption></figure>)}</div>}
    {origin&&executor!=='ai-edit'&&<label><input type="checkbox" checked={colorsConfirmed} onChange={e=>{setColorsConfirmed(e.target.checked);setReady(null);}}/>已核对原底色和目标色</label>}
    <button type="button" disabled={softBlocked||unassignedSelection||!!originStale||!!(origin&&executor!=='ai-edit'&&!colorsConfirmed)||!part.trim()||!criteria.trim()||!(allowed??props.region)||(executor==='ai-edit'&&!props.prompt.trim())||(executor==='intrinsic-recolor'&&analysis?.status!=='completed')} onClick={()=>void prepare()}>准备计划并预览范围</button>
    {prepared&&<><p>{prepared.plan.part} · {prepared.plan.scope.count} 个可写像素 · 图片调用 {prepared.plan.maxImageCalls} 次 · 每份计划一个候选</p><img width={256} src={`data:image/png;base64,${prepared.plan.previewPng}`} alt="绿色表示实际可写区域"/>{prepared.plan.softReferencePreviewPng&&<figure><img width={256} src={'data:image/png;base64,'+prepared.plan.softReferencePreviewPng} alt="计划中的额外表面参考"/><figcaption>{prepared.plan.softReference?.kind==='shading'?'额外参考 · 分层明暗':'额外参考 · 普通 RGB'}</figcaption></figure>}{prepared.plan.localPreviewPng&&<img width={256} src={`data:image/png;base64,${prepared.plan.localPreviewPng}`} alt="将发送的干净局部参考"/>}{prepared.plan.warnings.map(w=><p key={w}>{w}</p>)}{prepared.plan.recolorDecision&&<div className="ie-ai-reason"><strong>{{stop:'停止分层换色','simple-rgb-fallback':'本次整块采用 RGB 比例换色','simple-luminance-fallback':'本次整块采用保明暗换色','intrinsic-delta':'可试用分层换色'}[prepared.plan.recolorDecision.route]}</strong>
      {prepared.plan.recolorDecision.assessment.reasons.map(reason=><p key={reason}>{reason}</p>)}
      <p>可评估的 {prepared.plan.recolorDecision.assessment.visible} 个像素中，{prepared.plan.recolorDecision.assessment.unstablePixels} 个超过分歧阈值。</p>
      {mainDisagreement&&<p>其中 {mainDisagreement[1]} 个像素的最大分歧来自{disagreementLabels[mainDisagreement[0]]}。</p>}
      {prepared.plan.recolorDecision.route==='stop'&&<button type="button" onClick={()=>{setExecutor('color-map');setMapping('luminance');}}>改用保明暗换色并重新准备</button>}
    </div>}<button type="button" disabled={prepared.plan.recolorDecision?.route==='stop'} onClick={()=>props.onExecute(prepared.operation,prepared.plan.planRef)}>按此计划生成候选</button></>}
    {ready&&!prepared&&<p>范围、基准或属性已改变，请重新准备计划。</p>}
    {error&&<output role="alert">{error}</output>}
  </fieldset></details>;
}
