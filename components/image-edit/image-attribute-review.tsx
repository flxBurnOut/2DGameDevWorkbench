'use client';
import {useRef,useState} from 'react';
import {imageEditRequest,type ImageCandidate} from '@/features/image-edit/client';
export function ImageAttributeReview({editId,candidate,disabled}:{editId:string;candidate:ImageCandidate;disabled:boolean}){
  const [target,setTarget]=useState('uncertain'),[preserved,setPreserved]=useState('uncertain'),[boundary,setBoundary]=useState('uncertain');
  const [defect,setDefect]=useState(''),[x,setX]=useState(0),[y,setY]=useState(0),[message,setMessage]=useState(''),[saving,setSaving]=useState(false);
  const attempt=useRef<{key:string;id:string}|null>(null);
  const save=async()=>{
    if(saving||disabled||!candidate.sha256)return;
    const convert=(v:string)=>v==='uncertain'?null:v==='pass';
    const body={editId,candidateVersion:candidate.version,expectedCandidateSha256:candidate.sha256,reviewer:'网页用户',reviewerType:'human',targetAchieved:convert(target),preservedContent:convert(preserved),boundaryAndAlpha:convert(boundary),defects:defect.trim()?[{description:defect.trim(),x,y}]:[]};
    const key=JSON.stringify(body);if(attempt.current?.key!==key)attempt.current={key,id:crypto.randomUUID()};
    setSaving(true);setMessage('');try{const result=await imageEditRequest<{review:{verdict:string}}>('review-record',{...body,commandId:attempt.current.id});setMessage(`已保存此版本的观察：${result.review.verdict}。采用仍由你决定。`);}catch(cause){setMessage(cause instanceof Error?cause.message:String(cause));}finally{setSaving(false);}
  };
  return <details className="ie-attribute-review"><summary>记录本候选的逐项检查</summary><fieldset disabled={disabled||saving}>
    {[[target,setTarget,'目标变化'],[preserved,setPreserved,'应保内容'],[boundary,setBoundary,'边界与透明度']].map(([value,setter,label])=><label key={label as string}>{label as string}<select value={value as string} onChange={e=>(setter as (v:string)=>void)(e.target.value)}><option value="uncertain">证据不足</option><option value="pass">通过</option><option value="fail">有缺陷</option></select></label>)}
    <label>缺陷描述<textarea value={defect} maxLength={2000} onChange={e=>setDefect(e.target.value)}/></label><div className="ie-row"><label>原图 X<input type="number" min={0} max={3840} value={x} onChange={e=>setX(Number(e.target.value))}/></label><label>原图 Y<input type="number" min={0} max={3840} value={y} onChange={e=>setY(Number(e.target.value))}/></label></div>
    <button type="button" onClick={()=>void save()}>保存检查记录</button><output>{message}</output>
    <p className="ie-hint">此记录是当前查看者的判断，不标记为独立盲评。机器像素保护检查另行保留。</p>
  </fieldset></details>;
}
