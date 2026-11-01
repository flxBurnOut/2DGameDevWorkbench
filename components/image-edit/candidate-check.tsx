'use client';
/* oxlint-disable next/no-img-element -- inspect the exact frozen evidence sent for review. */
import {useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {imageEditRequest,type ImageCandidate} from '@/features/image-edit/client';

type Grade = 'pass'|'fail'|'uncertain';
type Result = {
  verdict?:Grade; target?:Grade; preservation?:Grade; boundary?:Grade; placement?:Grade; summary?:string;
  defects?:{x:number;y:number;severity:string;description:string}[];
  action?:'recompose'|'revise-plan'|'inspect'; explanation?:string; nextStep?:string;
};
interface Check {
  reviewRef:string; parentReviewRef?:string; phase:'review'|'diagnosis'; status:string;
  instruction:string; canDiagnose:boolean; error?:string; result?:Result;
  service:{configured:boolean;endpoint:string;profile:{model:string}};
  views:{role:string;png:string}[];
}
const gradeLabel={pass:'通过',fail:'有缺陷',uncertain:'证据不足'};
const roleLabel:Record<string,string>={'base-placement':'摆放尺寸原图','candidate-placement':'摆放尺寸成品','base-overview':'原图全貌','candidate-overview':'成品全貌','base-detail':'原图局部','candidate-detail':'成品局部','raw-overview':'原始返回全貌','raw-detail':'原始返回局部','original-authority':'最大授权范围','effective-mask':'实际合成范围'};
const statusLabel:Record<string,string>={prepared:'已准备',requesting:'复核中',completed:'已返回',failed:'失败',attention_required:'回执需核查'};

function CheckCard({value,canEdit,onRun,onAction}:{value:Check;canEdit:boolean;onRun:(value:Check)=>void;onAction:(action:'recompose'|'revise-plan')=>void}) {
  return <section className="ie-critic-card">
    <p>{value.phase==='review'?'独立成品复核':'原始返回诊断'} · {statusLabel[value.status]??value.status}</p>
    <p>{value.instruction}</p>
    <details><summary>查看送检视图（{value.views.length} 张）</summary><div className="ie-ai-references">
      {value.views.map(v=><figure key={v.role}><img alt={roleLabel[v.role]} src={'data:image/png;base64,'+v.png}/><figcaption>{roleLabel[v.role]}</figcaption></figure>)}
    </div></details>
    {canEdit&&value.status==='prepared'&&<><p>{value.service.profile.model} · {new URL(value.service.endpoint).host}</p>
      <Button size="sm" variant="outline" type="button" disabled={!value.service.configured} onClick={()=>onRun(value)}>
        {value.phase==='review'?'发送并复核成品（1 次视觉调用）':'发送并判断缺陷来源（1 次视觉调用）'}
      </Button></>}
    {value.error&&<output role="alert">{value.error}</output>}
    {value.result?.verdict&&<><strong>{gradeLabel[value.result.verdict]}</strong><p>{value.result.summary}</p>
      <p>{([['目标',value.result.target],['保持',value.result.preservation],['边界',value.result.boundary],['摆放尺寸',value.result.placement]] as const).map(([label,g])=>label+' '+(g?gradeLabel[g]:'—')).join(' · ')}</p>
      {value.result.defects?.map((d,i)=><p key={i}>({d.x}, {d.y}) {d.description}</p>)}
    </>}
    {value.result?.action&&<><p>{value.result.explanation}</p><p>{value.result.nextStep}</p>
      {canEdit&&value.result.action==='recompose'&&<Button size="sm" variant="outline" type="button" onClick={()=>onAction('recompose')}>查看原始返回并修选区</Button>}
      {canEdit&&value.result.action==='revise-plan'&&<Button size="sm" variant="outline" type="button" onClick={()=>onAction('revise-plan')}>回到部件与属性计划</Button>}
    </>}
  </section>;
}

export function CandidateCheck({editId,candidate,disabled,canEdit,onAction}:{editId:string;candidate:ImageCandidate;disabled:boolean;canEdit:boolean;onAction:(action:'recompose'|'revise-plan')=>void}){
  const [brief,setBrief]=useState(''),[width,setWidth]=useState(160);
  const [review,setReview]=useState<Check|null>(null),[diagnostic,setDiagnostic]=useState<Check|null>(null);
  const [message,setMessage]=useState(''),[working,setWorking]=useState(false);
  const busy=useRef(false),commands=useRef(new Map<string,string>());
  function id(key:string){if(!commands.current.has(key))commands.current.set(key,crypto.randomUUID());return commands.current.get(key)!;}
  async function work(fn:()=>Promise<void>){
    if(busy.current||disabled)return;busy.current=true;setWorking(true);setMessage('');
    try{await fn();}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{busy.current=false;setWorking(false);}
  }
  function display(value:Check){if(value.phase==='review')setReview(value);else setDiagnostic(value);}
  const get=async(reviewRef:string)=>(await imageEditRequest<{check:Check}>('critic-get',{reviewRef})).check;
  async function prepare(parent?:Check){
    if(!canEdit)return;
    const body={editId,candidateVersion:candidate.version,expectedCandidateSha256:candidate.sha256,
      ...(parent?{parentReviewRef:parent.reviewRef}:{previewWidth:width,...(brief.trim()?{instruction:brief.trim()}:{})})};
    const {check}=await imageEditRequest<{check:Check}>('critic-prepare',{...body,commandId:id(JSON.stringify(body))});
    if(!parent)setDiagnostic(null);
    display(check);
  }
  async function run(value:Check){
    if(!canEdit)return;
    const {check}=await imageEditRequest<{check:Check}>('critic-run',{reviewRef:value.reviewRef,commandId:id('run-'+value.reviewRef)});
    display(check);
  }
  async function recover(){
    const ref=diagnostic?.reviewRef??review?.reviewRef??candidate.visualReviewRefs?.at(-1);
    if(!ref)return;
    const value=await get(ref);
    if(value.parentReviewRef)setReview(await get(value.parentReviewRef));
    display(value);
  }
  return <details className="ie-attribute-review"><summary>独立复核成品</summary><fieldset disabled={disabled||working}>
    {canEdit&&<><label>复核目标<textarea value={brief} maxLength={12000} placeholder="生成候选可留空，沿用原始修改指令" onChange={e=>{setBrief(e.target.value);setReview(null);setDiagnostic(null);}}/></label>
    <label>无已存摆放尺寸时的预览宽度<input type="number" min={1} max={3840} value={width} onChange={e=>{setWidth(e.target.valueAsNumber||1);setReview(null);setDiagnostic(null);}}/></label>
    <Button size="sm" variant="outline" type="button" onClick={()=>void work(()=>prepare())}>准备成品复核（本地）</Button></>}
    {(review||diagnostic||candidate.visualReviewRefs?.length)?<Button size="sm" variant="outline" type="button" onClick={()=>void work(recover)}>查询原复核记录</Button>:null}
    {review&&<CheckCard value={review} canEdit={canEdit} onRun={v=>void work(()=>run(v))} onAction={onAction}/>}
    {canEdit && review?.status==='completed' && review.result?.verdict!=='pass' && review.canDiagnose && !diagnostic &&
      <Button size="sm" variant="outline" type="button" onClick={()=>void work(()=>prepare(review))}>准备原始返回诊断（本地）</Button>}
    {diagnostic&&<CheckCard value={diagnostic} canEdit={canEdit} onRun={v=>void work(()=>run(v))} onAction={onAction}/>}
    {message&&<output role="alert">{message}</output>}
  </fieldset></details>;
}
