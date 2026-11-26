export const srgbToLinear = v => v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;
export const linearToSrgb = v => v<=0.0031308?v*12.92:1.055*v**(1/2.4)-0.055;
const rgb = hex => [1,3,5].map(i=>srgbToLinear(parseInt(hex.slice(i,i+2),16)/255));

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
  const before=rgb(from),after=rgb(to),output=new Uint8Array(pixels);
  let clippedChannels=0,changedPixels=0;
  if(from.toLowerCase()===to.toLowerCase())return {pixels:output,clippedChannels,changedPixels};
  for(let i=0;i<mask.length;i++)if(mask[i]&&pixels[i*4+3]){
    let changed=false;
    for(let c=0;c<3;c++){
      const original=srgbToLinear(pixels[i*4+c]/255),anchor=Math.fround(original);
      const mapped=before[c]<.01 ? anchor+(after[c]-before[c]) : anchor*(after[c]/before[c]);
      const value=original+(mapped-anchor);
      if(value<0||value>1)clippedChannels++;
      const byte=Math.round(linearToSrgb(Math.max(0,Math.min(1,value)))*255);
      changed ||= byte!==output[i*4+c];output[i*4+c]=byte;
    }
    changedPixels+=Number(changed);
  }
  return {pixels:output,clippedChannels,changedPixels};
}
