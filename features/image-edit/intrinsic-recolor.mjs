export const srgbToLinear = v => v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;
export const linearToSrgb = v => v<=0.0031308?v*12.92:1.055*v**(1/2.4)-0.055;
const rgb = hex => [1,3,5].map(i=>srgbToLinear(parseInt(hex.slice(i,i+2),16)/255));
const quantile=(values,p)=>{const a=values.sort((a,b)=>a-b);return a[Math.min(a.length-1,Math.floor(a.length*p))]??0;};

// This is a conservative experiment gate, not a calibrated probability of correctness.
export function assessIntrinsics(pixels,mask,{albedo,shading,residual,uncertainty,origin},thresholds={errorP90:0.15,uncertaintyP90:0.12},surface) {
  const errors=[],disagreement=[];
  const originCounts={};
  let visible=0,unstablePixels=0;
  for(let i=0;i<mask.length;i++)if(mask[i]&&pixels[i*4+3]>=128){
    visible++;let err=0,u=0;
    for(let c=0;c<3;c++){const j=i*3+c;err=Math.max(err,Math.abs(srgbToLinear(pixels[i*4+c]/255)-albedo[j]*shading[j]-residual[j]));u=Math.max(u,uncertainty[j]);}
    errors.push(err);disagreement.push(u);
    if (u > thresholds.uncertaintyP90) {
      unstablePixels++;
      if (origin) {
        const label = origin.labels[origin.indices[i]];
        originCounts[label] = (originCounts[label] ?? 0) + 1;
      }
    }
  }
  const errorP90=quantile(errors,.9),uncertaintyP90=quantile(disagreement,.9);
  const reasons = [];
  if (surface && surface !== 'diffuse') {
    const labels = {reflective:'强反光表面',emissive:'含自发光或光晕',translucent:'半透明材质',unknown:'尚未确认表面材质'};
    reasons.push(labels[surface] + '，优先采用简单换色');
  }
  if (!visible) reasons.push('选区内缺少可评估的可见像素');
  if (errorP90 > thresholds.errorP90) reasons.push('底色、明暗与残差重建原图的误差过大');
  if (uncertaintyP90 > thresholds.uncertaintyP90) reasons.push('选区内的分层预测不稳定');
  return {visible,errorP90,uncertaintyP90,thresholds,surface:surface??null,unstablePixels,originCounts,reasons,eligible:reasons.length===0,calibrated:false};
}
export function recolorIntrinsic(pixels,mask,layers,from,to) {
  const before=rgb(from),after=rgb(to),output=new Uint8Array(pixels);let clippedChannels=0,changedPixels=0;
  if(from.toLowerCase()===to.toLowerCase())return {pixels:output,clippedChannels,changedPixels};
  for(let i=0;i<mask.length;i++)if(mask[i]&&pixels[i*4+3]){
    let changed=false;
    for(let c=0;c<3;c++){
      const j=i*3+c,a=layers.albedo[j];
      // For near-black anchors, transfer the linear difference to avoid an undefined or unstable gain.
      const mapped=before[c]<.01 ? a+(after[c]-before[c]) : a*(after[c]/before[c]);
      const value=srgbToLinear(pixels[i*4+c]/255)+(mapped-a)*layers.shading[j];
      if(value<0||value>1)clippedChannels++;
      const byte=Math.round(linearToSrgb(Math.max(0,Math.min(1,value)))*255);
      changed ||= byte!==output[i*4+c];output[i*4+c]=byte;
    }
    changedPixels+=Number(changed);
  }
  return {pixels:output,clippedChannels,changedPixels};
}
export function recolorSimple(pixels,mask,from,to,mapping='rgb') {
  if (mapping==='luminance') {
    const output=new Uint8Array(pixels);
    let changedPixels=0,clippedChannels=0;
    if (from.toLowerCase()===to.toLowerCase()) return {pixels:output,changedPixels,clippedChannels};
    const luminance=(r,g,b)=>.2126*r+.7152*g+.0722*b;
    const anchor=luminance(...rgb(from)),target=rgb(to);
    if (anchor===0) throw Object.assign(new Error('保明暗映射需要可见的原底色，请选取比纯黑更亮的样本。'),{code:'INVALID_IMAGE_EDIT',status:400});
    for (let i=0;i<mask.length;i++) {
      const j=i*4;
      if (!mask[i] || !pixels[j+3]) continue;
      const intensity=luminance(srgbToLinear(pixels[j]/255),srgbToLinear(pixels[j+1]/255),srgbToLinear(pixels[j+2]/255))/anchor;
      for (let c=0;c<3;c++) {
        const value=intensity*target[c];
        if (value>1) clippedChannels++;
        output[j+c]=Math.round(255*linearToSrgb(Math.min(1,value)));
      }
      if (pixels[j]!==output[j] || pixels[j+1]!==output[j+1] || pixels[j+2]!==output[j+2]) changedPixels++;
    }
    return {pixels:output,changedPixels,clippedChannels};
  }
  // A declared simple RGB control; no inferred layer is presented as physical truth.
  const count=mask.length,layers={albedo:new Float32Array(count*3),shading:new Float32Array(count*3).fill(1)};
  for(let i=0;i<count;i++)for(let c=0;c<3;c++)layers.albedo[i*3+c]=srgbToLinear(pixels[i*4+c]/255);
  return recolorIntrinsic(pixels,mask,layers,from,to);
}
