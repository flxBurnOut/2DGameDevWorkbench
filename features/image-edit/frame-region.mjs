// Emit exactly the selected source pixels; never infer or dilate a frame mask.
export function toFrameRegion(frame, sourceSha256, mask, width, height) {
  if (!Number.isInteger(frame)||frame<0||frame>63||!/^[a-f0-9]{64}$/.test(sourceSha256)||
      ![64,128].includes(width)||width!==height||mask.length!==width*height) throw new Error('动画帧或选区尺寸无效。');
  const spans=[];
  for(let i=0;i<mask.length;){
    if(!mask[i]){i++;continue;}
    const start=i;
    while(i<mask.length&&mask[i])i++;
    spans.push({start,length:i-start});
  }
  return {frame,source_sha256:sourceSha256,spans};
}
