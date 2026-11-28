'use client';
/* oxlint-disable next/no-img-element -- Exact local PNG target. */
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {useState} from 'react';
import {motionRequest,motionUrl,type MotionWork} from './open-motion-model';

export function MotionTargets({work,onSaved}:{work:MotionWork;onSaved:(value:MotionWork)=>void}) {
  const [stage,setStage]=useState(0),[png,setPng]=useState(''),[note,setNote]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const prop = work.spec.object_type === 'interactable';
  async function save(remove=false) {
    setBusy(true);setError('');
    try {onSaved(await motionRequest<MotionWork>(`open-motion/${work.id}/target`,{expected_revision:work.revision,stage_index:stage,expected_targets:work.target_set_sha256,png_base64:remove?null:png,note}));setPng('');}
    catch(e){setError((e as Error).message);} finally{setBusy(false);}
  }
  const stages=work.plan?.stages||[];
  const imageCount=stages.filter((s,i)=>s.last_frame==='original'||work.end_targets?.some(t=>t.stage===i)).length;
  return <section className="motion-card" aria-label="段末姿势引导">
    <p className="motion-muted" data-testid="motion-target-status">{imageCount
      ? `段末姿势图片：${imageCount}/${stages.length} 段${imageCount===stages.length?'，全部已绑定。':'；其他段仅使用文字姿势要求。'}`
      : '段末姿势：当前仅使用文字要求，尚未绑定姿势图片。'}{' '}原图结构辅助不等于姿势图片约束。</p>
    <details><summary>{prop ? '用已有状态图约束本段末帧（可选）' : '用已有图片约束段末姿势（可选）'}</summary>
    <p>{prop ? '选择与当前物件同画布的 128 × 128 透明 PNG，核对视角、固定部件和本段目标状态。' : '先检查目标图的角色、朝向与装备，再绑定为本段结束参考。'}下一段从本段实际生成并确认的末帧继续。</p>
    {work.end_targets?.map(t=><div key={t.stage} className="motion-small-reference"><img loading="lazy" decoding="async" src={motionUrl(`open-motion/${work.id}/targets/${t.stage}`,{revision:String(work.revision),expected_sha256:t.sha256})} alt={`第 ${t.stage+1} 段目标图片`} /><p>第 {t.stage+1} 段：{t.note}</p></div>)}
    {!work.job&&work.status==='ready'&&work.latest_revision===work.revision&&<>
      <label>目标片段<NativeSelect value={stage} onChange={e=>setStage(Number(e.target.value))}>{work.plan?.stages.map((s,i)=><NativeSelectOption key={i} value={i}>{i+1} · {s.name}{prop ? ' → ' + (i === stages.length - 1 ? work.plan?.quality?.interactable?.target_state : s.checkpoint?.endpoint || s.goal) : ''}</NativeSelectOption>)}</NativeSelect></label>
      <label>透明 PNG<input aria-label="段末目标图片" type="file" accept="image/png" onChange={e=>{const f=e.target.files?.[0];setPng('');if(!f)return;if(f.size>1500000){setError('图片过大');return;}const r=new FileReader();r.onload=()=>{if(typeof r.result==='string')setPng(r.result.split(',')[1]);};r.readAsDataURL(f);}} /></label>
      {png&&<div className="motion-small-reference"><img src={`data:image/png;base64,${png}`} alt="待绑定目标姿势" /></div>}
      <label>目标图检查依据<textarea value={note} onChange={e=>setNote(e.target.value)} placeholder={prop ? '说明目标状态与应固定的部件' : '说明实际姿势、朝向、装备与本段目标是否一致'} maxLength={1000}/></label>
      <button disabled={busy||!png||note.trim().length<4} onClick={()=>void save()}>确认并绑定目标图</button>
      {work.end_targets?.some(t=>t.stage===stage)&&<button disabled={busy||note.trim().length<4} onClick={()=>void save(true)}>取消本段图片约束</button>}
    </>}
    {error&&<p className="motion-danger">{error}</p>}
    </details>
  </section>;
}
