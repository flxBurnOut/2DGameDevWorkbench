'use client';
/* oxlint-disable next/no-img-element -- Displays exact saved pixel frames. */
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { useEffect, useState } from 'react';
import { motionRequest, motionUrl, type MotionWork, type MotionStage, type MotionReview } from './open-motion-model';
import { MotionLocalRepair, type RepairAttempt } from './motion-local-repair';
import { MotionVisualReview } from './motion-visual-review';
import { MotionAdjustment } from './motion-adjustment';
import { MotionTemporalStructure } from './motion-temporal-structure';
import { MotionPanel } from './motion-panel';
import { MotionFrameEditor } from '@/components/sprite-generator/motion-frame-editor';
import { MotionInteractionPreview } from './motion-interaction-preview';
import type { ReactNode } from 'react';

type Evidence = {
  token: string;
  job_revision?: number;
  state: string;
  fps: number;
  frames: { sha256: string; raw_index: number }[];
  definition: MotionStage;
  transition?: {from_state: string; to_state: string};
  repairs?: RepairAttempt[];
  state_checkpoint?: {frame: number; sha256: string} | null;
  review: MotionReview;
};

export function MotionStageReview({work, candidate, stage, readOnly, onSaved, expertRecord}: {
  work: MotionWork; candidate: number; stage: number; readOnly: boolean; onSaved: (w: MotionWork) => void;
  expertRecord?: ReactNode;
}) {
  const [reviewSeconds,setReviewSeconds]=useState('');
  const [data,setData]=useState<Evidence|null>(null), [error,setError]=useState('');
  const [frame,setFrame]=useState(0), [playing,setPlaying]=useState(false), [loadedToken,setLoadedToken]=useState('');
  const [played,setPlayed]=useState(false), [watched,setWatched]=useState(false), [slow,setSlow]=useState(false);
  const [note,setNote]=useState(''), [ack,setAck]=useState(false), [busy,setBusy]=useState(false);
  const [anchor,setAnchor]=useState<number|null>(null), [ackTrim,setAckTrim]=useState(false);
  const [adjustmentPending,setAdjustmentPending]=useState(false);
  const [localVersion,setLocalVersion]=useState(0);
  const [pixelFrame,setPixelFrame]=useState<number|null>(null);
  const [adjustmentOpen,setAdjustmentOpen]=useState(false);
  const [evidenceRevision,setEvidenceRevision]=useState<number|null>(null);
  const route=`open-motion/${work.id}/candidates/${candidate}/stages/${stage}`;
  const query={revision:String(work.revision)};
  useEffect(()=>{
    const abort=new AbortController();
    void motionRequest<Evidence>(route,undefined,{revision:String(work.revision)},abort.signal).then(next=>{
      if(abort.signal.aborted)return;
      setData(previous=>previous?.token===next.token&&previous?.state===next.state&&previous?.state_checkpoint?.sha256===next.state_checkpoint?.sha256&&JSON.stringify(previous?.review)===JSON.stringify(next.review)&&JSON.stringify(previous?.repairs)===JSON.stringify(next.repairs)?previous:next);
      setEvidenceRevision(next.job_revision??work.job?.revision??null);
    }).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
    return ()=>abort.abort();
  },[route,work.revision,work.job?.revision]);
  const evidenceToken=data?.token, frameCount=data?.frames.length || 0, frameFps=data?.fps;
  useEffect(()=>{
    if(!evidenceToken)return;
    let live=true;
    void Promise.all(Array.from({length:frameCount},(_,i)=>new Promise<void>((resolve,reject)=>{
      const img=new Image();img.onload=()=>resolve();img.onerror=()=>reject(new Error('片段图片未完整加载，请刷新后检查。'));
      img.src=motionUrl(`${route}/frames/${i}`,{revision:String(work.revision),token:evidenceToken});
    }))).then(()=>{if(live){setLoadedToken(evidenceToken);setPlayed(false);setWatched(false);setFrame(0);setPlaying(false);}}).catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;};
  },[evidenceToken,frameCount,frameFps,route,work.revision]);
  const loaded=Boolean(data&&loadedToken===data.token&&evidenceRevision===work.job?.revision);
  useEffect(()=>{
    if(!playing||!data||!loaded)return;
    if(frame>=data.frames.length-1){
      const timer=setTimeout(()=>{setPlaying(false);setPlayed(true);},1000/data.fps*(slow?2:1));
      return ()=>clearTimeout(timer);
    }
    const timer=setTimeout(()=>setFrame(i=>i+1),1000/data.fps*(slow?2:1));
    return ()=>clearTimeout(timer);
  },[playing,frame,data,loaded,slow]);
  async function decide(decision:'accept'|'reject'|'accept_state') {
    if(!data)return;setBusy(true);setError('');
    try {onSaved(await motionRequest<MotionWork>(`open-motion/${work.id}/review-stage`,{
      expected_revision:work.revision,candidate_index:candidate,stage_index:stage,token:data.token,
      note,decision,...(reviewSeconds===''?{}:{human_seconds:Number(reviewSeconds)}),acknowledge_warnings:ack,anchor_frame:data.state_checkpoint?.frame ?? anchor,acknowledge_trim:ackTrim,
    }));} catch(e){setError((e as Error).message);} finally{setBusy(false);}
  }
  if(!data)return <section className="motion-card">{error||'正在读取当前片段…'}</section>;
  const endpoint=data.state_checkpoint?.frame??anchor??data.frames.length-1, trimmed=endpoint<data.frames.length-1;
  const canAccept=!readOnly&&!busy&&!adjustmentPending&&loaded&&played&&watched&&note.trim().length>=4&&
    data.state==='awaiting_review'&&(data.review.verdict==='pass'||ack)&&(!trimmed||ackTrim)&&!data.repairs?.some(a=>['submitting','pending','unknown','awaiting_review'].includes(a.state));
  return <section className="motion-card motion-checkpoint">
    {!adjustmentOpen&&<>
    <h2>确认第 {stage+1} 段 · {data.definition.name}</h2>
    {data.transition && <p>{data.transition.from_state} → {data.transition.to_state}</p>}
    <p>候选 {candidate} · 本段 {data.frames.length} 帧。检查完整片段后，末帧将锁定为下一段的实际姿势锚点。</p>
    <MotionInteractionPreview key={`${work.id}:${work.revision}:${candidate}:${stage}:${data.token}`} workId={work.id} revision={work.revision} candidate={candidate} stage={stage} onStop={()=>setPlaying(false)}>
    <div className="motion-canvas motion-large">
      <img src={motionUrl(`${route}/frames/${frame}`,{...query,token:data.token})} alt={`当前片段第 ${frame+1} 帧`} onError={()=>{setLoadedToken('');setError('图片读取失败，不能确认此段。');}} />
    </div>
    <div className="motion-card-title">
      <label>人工检查用时（秒，可留空）<input aria-label="人工检查用时" type="number" min={0} max={86400} step={1} value={reviewSeconds} onChange={e=>setReviewSeconds(e.target.value)}/></label>
      <button disabled={!loaded||playing} onClick={()=>{setFrame(0);setPlaying(true);setPlayed(false);setWatched(false);}}>播放当前完整片段</button>
      <span>{frame+1} / {data.frames.length} · {data.fps} FPS</span>
      <label><input type="checkbox" checked={slow} onChange={e=>setSlow(e.target.checked)} />半速查看</label>
    </div>
    <input aria-label="当前片段逐帧查看" type="range" min={0} max={data.frames.length-1} value={frame} disabled={playing} onChange={e=>setFrame(Number(e.target.value))} />
    </MotionInteractionPreview>
    <button disabled={readOnly||!loaded||playing||frame===0||data.state_checkpoint?.frame===frame||(frame===data.frames.length-1&&(data.definition.last_frame==='original'||work.end_targets?.some(t=>t.stage===stage)))} onClick={()=>setPixelFrame(frame)}>局部调整当前帧</button>
    {pixelFrame!==null&&<MotionFrameEditor work={work} target={{kind:'motion-frame',workId:work.id,workRevision:work.revision,candidateIndex:candidate,stageIndex:stage,frameIndex:pixelFrame}}
      onClose={()=>setPixelFrame(null)} onAdopt={value=>{setReviewSeconds('');setPixelFrame(null);setLocalVersion(v=>v+1);onSaved(value);}}/>}
    <MotionVisualReview report={data.review} compact />
    <div className="motion-secondary-actions">
    <MotionPanel title="检查详情">
      <MotionVisualReview report={data.review} />
      <h3>本段要求</h3><ul>{data.definition.acceptance.map(item=><li key={item}>{item}</li>)}</ul>
      {expertRecord}
    </MotionPanel>
    <MotionPanel title="高级工具">
    <MotionTemporalStructure work={work} candidate={candidate} stage={stage} frame={frame} frameSha={data.frames[frame]?.sha256||''}
      playing={false} readOnly={readOnly} onFrame={value=>setFrame(Math.max(0,Math.min(data.frames.length-1,value)))} onStop={()=>setPlaying(false)}>
      <img src={motionUrl(`${route}/frames/${frame}`,{...query,token:data.token})} alt={`结构观察第 ${frame+1} 帧`} decoding="async" />
    </MotionTemporalStructure>
    <input aria-label="工具逐帧查看" type="range" min={0} max={data.frames.length-1} value={frame} onChange={e=>{setPlaying(false);setFrame(Number(e.target.value));}} />
    <div className="motion-small-reference">
      <img src={motionUrl(`${route}/frames/${endpoint}`,{...query,token:data.token})} alt="待确认的实际末姿势" decoding="async" />
      <div><b>目标末姿势</b><p>{data.definition.checkpoint?.endpoint}</p><p>{data.definition.checkpoint?.rhythm}</p></div>
    </div>
    <details><summary>目标姿势提前到达时，选择实际锚点</summary>
      <p>默认使用最后一帧。若末尾已越过目标，可明确选择较早的真实帧结束本段。原始尾帧保留，后段从选中图片继续。</p>
      <label>本段结束锚点<NativeSelect aria-label="本段结束锚点" value={endpoint} disabled={!!data.state_checkpoint} onChange={e=>{setAnchor(Number(e.target.value));setAckTrim(false);setWatched(false);}}>{data.frames.map((_,i)=><NativeSelectOption key={i} value={i}>第 {i+1} 帧{i===data.frames.length-1?'（原始末帧）':''}</NativeSelectOption>)}</NativeSelect></label>
      {trimmed&&<label><input type="checkbox" checked={ackTrim} onChange={e=>setAckTrim(e.target.checked)} />确认采用第 1–{endpoint+1} 帧，其余原始帧保留在记录中</label>}
    </details>
    {!!data.repairs?.length&&<details><summary>旧版局部修复记录</summary><MotionLocalRepair work={work} candidate={candidate} stage={stage} token={data.token} count={data.frames.length} attempts={data.repairs} onSaved={onSaved} readOnly={readOnly}/></details>}
    <h3>停止后续制作</h3><p>保留已确认片段和原始帧。返回描述修改方案时建立新版本，不会自动重新收费生成。</p>
    <label>停止原因<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={2000}/></label>
    <button disabled={readOnly||busy||note.trim().length<4||adjustmentPending} onClick={()=>void decide('reject')}>本段不合格，停止后续制作</button>
    </MotionPanel>
    </div>
    {trimmed&&<p className="motion-notice">将以第 {endpoint+1} 帧结束本段。其余原始帧保留。</p>}
    <label><input type="checkbox" checked={watched} disabled={!played} onChange={e=>setWatched(e.target.checked)} />{work.plan?.quality?.interactable ? '我已播放此段并检查状态帧、固定部件和过渡' : '我已播放此段并检查实际末姿势、装备和节奏'}</label>
    <label>本段检查结论<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={2000} placeholder="记录实际看到的姿势、运动及衔接情况" /></label>
    {(data.review.verdict!=='pass'||work.plan?.quality?.interactable)&&<label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} />已核对模型的未通过或不确定意见，按实际画面确认接受</label>}
    {error&&<p className="motion-danger">{error}</p>}
    {work.plan?.quality?.interactable && (data.state_checkpoint
      ? <p>第 {data.state_checkpoint.frame + 1} 帧已单独确认为状态帧，可继续修复过渡。</p>
      : <button disabled={readOnly||busy||adjustmentPending||!loaded||!played||!watched||note.trim().length<4||data.state!=='awaiting_review'} onClick={()=>void decide('accept_state')}>只确认第 {endpoint + 1} 帧，保留过渡待修复</button>)}
    <button className="motion-primary" disabled={!canAccept} onClick={()=>void decide('accept')}>确认此段，继续制作</button>
    </>}
    <MotionAdjustment key={localVersion} work={work} candidate={candidate} stage={stage} onSaved={onSaved} readOnly={readOnly} onPendingChange={setAdjustmentPending} onOpenChange={setAdjustmentOpen}/>
  </section>;
}
