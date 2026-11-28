export function adjustmentRangeError(start:number|null,end:number|null,count:number,locked:number[],appearanceMax:number,spatial:boolean):string {
  if(start===null||end===null)return '请选择开始帧和结束帧。';
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>=count)return `帧号应在 1–${count} 之间。`;
  if(start>end)return '开始帧不能大于结束帧。';
  if(locked.some(i=>i>=start&&i<=end))return '范围包含受保护的起始帧或已锁定锚点，请调整选择。';
  const length=end-start+1;
  if(length<2)return '当前只选了 1 帧，请至少选择相邻的 2 帧。';
  if(length%2)return `当前选择了 ${length} 帧；提供方要求偶数帧，请手动调整起止帧。`;
  if(spatial&&length>appearanceMax)return `精确区域编辑一次最多支持 ${appearanceMax} 帧，请缩小范围。限制的是选中数量，不是帧号。`;
  if(length>appearanceMax&&(length<4||length>16))return `当前范围超出限制：原帧编辑最多 ${appearanceMax} 帧，动作重生成最多 16 帧。`;
  return '';
}

type AttemptContext={attempt_scope?:string;attempt_limit:number;legacy_frame_attempts?:number[];
  tasks:{start:number;end:number;generation_calls:unknown[]}[]};

export function adjustmentAttemptBudget(context:AttemptContext,start:number,end:number) {
  // Recompute from the current task responses after polling/decisions. The
  // server independently enforces the same limit under the workspace lock.
  if(context.attempt_scope!=='selected_frames')return {remaining:Math.max(0,context.attempt_limit-context.tasks.length),blocked:[],legacy:true};
  const counts=Array.from({length:end-start+1},(_,j)=>{
    const i=start+j;
    return (context.legacy_frame_attempts?.[i]||0)+context.tasks.reduce((used,t)=>used+(t.start<=i&&i<=t.end?t.generation_calls.length:0),0);
  });
  return {remaining:Math.max(0,context.attempt_limit-Math.max(0,...counts)),
    blocked:counts.flatMap((used,j)=>used>=context.attempt_limit?[start+j+1]:[]),legacy:false};
}
