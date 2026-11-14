'use client';
/* oxlint-disable next/no-img-element -- Native source pixels with an annotation-only canvas. */
import {toFrameRegion} from '../../features/image-edit/frame-region.mjs';
import {useCallback,useEffect,useRef,useState,type PointerEvent} from 'react';

export type EditRegion={frame:number;source_sha256:string;spans:{start:number;length:number}[]};
export type RegionDraft={token:string;frames:Record<number,EditRegion>};

function pixels(region:EditRegion|undefined,size:number){
  const result=new Uint8Array(size);
  if(!Array.isArray(region?.spans))return result;
  for(const span of region.spans){
    if(!Number.isInteger(span.start)||!Number.isInteger(span.length)||span.start<0||span.length<1||span.start+span.length>size)return new Uint8Array(size);
    result.fill(1,span.start,span.start+span.length);
  }
  return result;
}
export function MotionEditRegion({start,end,width,height,frames,regions,source,onChange}:{
  start:number;end:number;width:number;height:number;frames:{sha256:string}[];regions:Record<number,EditRegion>;
  source:(frame:number)=>string;onChange:(region:EditRegion)=>void;
}){
  const [position,setPosition]=useState(start),[brush,setBrush]=useState(5),[erase,setErase]=useState(false),[loaded,setLoaded]=useState('');
  const canvas=useRef<HTMLCanvasElement|null>(null),stroke=useRef<{id:number;source:string;x:number;y:number;bits:Uint8Array}|null>(null);
  const frame=Math.max(start,Math.min(end,position)),url=source(frame);
  const region=regions[frame]?.source_sha256===frames[frame]?.sha256?regions[frame]:undefined;
  const done=Array.from({length:end-start+1},(_,n)=>n+start).filter(i=>regions[i]?.source_sha256===frames[i]?.sha256&&regions[i]?.spans?.length).length;
  const render=useCallback((bits:Uint8Array)=>{
    const ctx=canvas.current?.getContext('2d');if(!ctx)return;
    const overlay=ctx.createImageData(width,height);
    for(let i=0;i<bits.length;i++)if(bits[i]){overlay.data.set([30,225,225,105],i*4);}
    ctx.putImageData(overlay,0,0);
  },[width,height]);
  useEffect(()=>{render(pixels(region,width*height));stroke.current=null;},[region,width,height,frame,render,url]);
  function point(e:PointerEvent<HTMLCanvasElement>){
    const rect=e.currentTarget.getBoundingClientRect();
    return {x:Math.max(0,Math.min(width-1,Math.floor((e.clientX-rect.left)*width/rect.width))),
      y:Math.max(0,Math.min(height-1,Math.floor((e.clientY-rect.top)*height/rect.height)))};
  }
  function draw(e:PointerEvent<HTMLCanvasElement>,begin=false){
    if(loaded!==url||begin&&e.button!==0)return;
    const p=point(e);
    if(begin){stroke.current={id:e.pointerId,source:url,...p,bits:pixels(region,width*height)};e.currentTarget.setPointerCapture(e.pointerId);}
    const current=stroke.current;if(!current||current.id!==e.pointerId)return;
    const steps=Math.max(1,Math.abs(p.x-current.x),Math.abs(p.y-current.y)),radius=Math.floor(brush/2);
    for(let s=0;s<=steps;s++){
      const x=Math.round(current.x+(p.x-current.x)*s/steps),y=Math.round(current.y+(p.y-current.y)*s/steps);
      for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++){
        if(dx*dx+dy*dy>radius*radius||x+dx<0||x+dx>=width||y+dy<0||y+dy>=height)continue;
        current.bits[(y+dy)*width+x+dx]=erase?0:1;
      }
    }
    current.x=p.x;current.y=p.y;render(current.bits);
  }
  function finish(e:PointerEvent<HTMLCanvasElement>){
    const current=stroke.current;if(!current||current.id!==e.pointerId)return;
    stroke.current=null;
    if(current.source===url)onChange(toFrameRegion(frame,frames[frame].sha256,current.bits,width,height));
    if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
  }
  return <div className="motion-region-editor">
    <p><b>涂选允许修改的位置</b> · 已涂选 {done} / {end-start+1} 帧</p>
    <p className="motion-muted">覆盖要改的轮廓、碎片及少量周围空间。青色区域允许变化，其余像素从原帧原样保留；每帧单独选择。</p>
    <div className="motion-region-controls">
      <label>编辑帧<select aria-label="区域编辑帧" value={frame} onChange={e=>setPosition(Number(e.target.value))}>{Array.from({length:end-start+1},(_,i)=>i+start).map(i=><option key={i} value={i}>第 {i+1} 帧{regions[i]?.spans?.length?' · 已涂选':''}</option>)}</select></label>
      <label>操作<select aria-label="区域画笔模式" value={erase?'erase':'paint'} onChange={e=>setErase(e.target.value==='erase')}><option value="paint">涂选</option><option value="erase">擦除选区</option></select></label>
      <label>画笔<select aria-label="区域画笔大小" value={brush} onChange={e=>setBrush(Number(e.target.value))}>{[1,3,5,9,15].map(n=><option key={n} value={n}>{n} px</option>)}</select></label>
      <button type="button" onClick={()=>onChange({frame,source_sha256:frames[frame].sha256,spans:[]})}>清空本帧选区</button>
    </div>
    <div className="motion-region-canvas" style={{aspectRatio:`${width}/${height}`}}>
      <img src={url} alt={`区域编辑原版第 ${frame+1} 帧`} draggable={false} onLoad={()=>setLoaded(url)}/>
      <canvas ref={canvas} width={width} height={height} aria-label={`第 ${frame+1} 帧允许修改区域`} onPointerDown={e=>draw(e,true)} onPointerMove={e=>draw(e)} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={()=>{stroke.current=null;}}/>
    </div>
    {frame<end&&<button type="button" onClick={()=>setPosition(frame+1)}>涂选下一帧</button>}
  </div>;
}
