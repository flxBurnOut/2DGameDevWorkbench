import {resolveSpritePipelineTarget} from './sprite-pipeline-supervisor.mjs';
import {digest, failure, pixels, summary} from './image-edit-target-common.mjs';

async function motion(route, body){
  const {baseUrl}=resolveSpritePipelineTarget();
  const response=await fetch(baseUrl.replace(/\/$/,'')+'/v1/'+route,{
    method:body?'POST':'GET', redirect:'error', signal:AbortSignal.timeout(30000),
    headers:{...(process.env.SPRITE_PIPELINE_API_TOKEN?{authorization:'Bearer '+process.env.SPRITE_PIPELINE_API_TOKEN}:{}),
      ...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw failure('动画帧或其锁定状态已变化，请重新读取当前作品。',response.status,'MOTION_FRAME_UNAVAILABLE');
  return response;
}
function contextRoute(ref){
  const q=new URLSearchParams({revision:ref.workRevision,candidate:ref.candidateIndex});
  if(ref.stageIndex!==undefined)q.set('stage',ref.stageIndex);
  return 'open-motion/'+ref.workId+'/adjustments?'+q;
}
async function read(_root,_manifest,ref){
  const context=await (await motion(contextRoute(ref))).json(), frame=context.frames[ref.frameIndex];
  if(!frame)throw failure('所选帧不存在。',404);
  const response=await motion('open-motion/'+ref.workId+'/edit-source/'+ref.frameIndex+'?'+contextRoute(ref).split('?')[1]+'&token='+context.token);
  const bytes=Buffer.from(await response.arrayBuffer()), info=await pixels(bytes,{sha256:frame.sha256,width:context.width,height:context.height,mime:'image/png'});
  const locked=context.locked_frames.includes(ref.frameIndex);
  return {...summary(ref,info,{revision:ref.workRevision,slotFingerprint:context.token,kind:'prop',locked,editable:!locked,
    readOnlyReason:locked?'此帧已锁定为接续边界或状态图。':undefined,name:'候选 '+ref.candidateIndex+' · 第 '+(ref.frameIndex+1)+' 帧',
    adoptionMode:'motion_alternative',viewPath:'/tools/sprite-generator?work='+ref.workId+'&version='+ref.workRevision}),bytes};
}
async function apply(root,manifest,ref,parsed,candidate,bytes){
  if(!parsed.frameRegion || !parsed.expectedSlotFingerprint || parsed.expectedRevision!==ref.workRevision ||
     parsed.frameRegion.source_sha256!==parsed.expectedSha256 || parsed.frameRegion.frame!==ref.frameIndex)
    throw failure('动画帧采用需要原始选区、作品版本与来源摘要。');
  const body={expected_revision:ref.workRevision,candidate_index:ref.candidateIndex,stage_index:ref.stageIndex,
    token:parsed.expectedSlotFingerprint,request_key:'image-'+digest({ref,commandId:parsed.commandId}),
    description:'图片局部调整候选 '+candidate.task.id,frames:[{region:parsed.frameRegion,png_base64:bytes.toString('base64')}]};
  const {adjustment}=await (await motion('open-motion/'+ref.workId+'/local-frame-edits',body)).json();
  if(adjustment.proposed_frames?.[ref.frameIndex]?.sha256!==candidate.info.sha256)throw failure('动画备选回执与像素候选不一致。',409);
  // A lost response can be recovered even after the animation advanced.
  const saved=Buffer.from(await (await motion('open-motion/'+ref.workId+'/adjustments/'+adjustment.id+'/source/'+ref.frameIndex)).arrayBuffer());
  const target=summary(ref,await pixels(saved,{sha256:parsed.expectedSha256}),{revision:ref.workRevision,name:'原动画帧',kind:'prop',slotFingerprint:parsed.expectedSlotFingerprint,editable:true,locked:false});
  return {target,revision:ref.workRevision,currentRevision:ref.workRevision,adoption:{status:'saved_variant',sourceChanged:false,adjustmentId:adjustment.id,sha256:candidate.info.sha256,commandId:parsed.commandId}};
}
// Enumeration is intentionally scoped to an exact work to avoid traversing all frames on a device.
async function list(_root,_manifest,scope,add){
  if(!scope.workId||!scope.workRevision||!scope.candidateIndex)return;
  const {workId,workRevision,candidateIndex,stageIndex}=scope;
  const ref={kind:'motion-frame',workId,workRevision,candidateIndex,...(stageIndex!==undefined?{stageIndex}:{})};
  const context=await (await motion(contextRoute(ref))).json();
  context.frames.forEach((_,frameIndex)=>add({...ref,frameIndex},'候选 '+candidateIndex+' 第 '+(frameIndex+1)+' 帧'));
}
export const motionFrameSource={kinds:['motion-frame'],integerRevision:true,read,apply,list};
