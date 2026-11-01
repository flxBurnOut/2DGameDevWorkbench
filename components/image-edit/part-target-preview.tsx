'use client';
import { useRef, useState, type PointerEvent } from 'react';
import type { PixelBounds } from '@/features/image-edit/core.mjs';

type Point = { x: number; y: number };
type Rectangle = PixelBounds & { type: 'rectangle' };

// Draw in original image coordinates. The SVG transform accounts for page zoom,
// scrolling and fitted aspect ratio; the clean crop is never resampled back into artwork.
export function PartTargetPreview({ crop, png, target, protectedBoxes, onChange }: {
  crop: PixelBounds; png: string; target: Rectangle; protectedBoxes: {part:string;region:PixelBounds}[]; onChange: (target: Rectangle) => void;
}) {
  const start = useRef<Point | null>(null);
  const pointer = useRef<number | null>(null);
  const [drag, setDrag] = useState<Rectangle | null>(null);
  function point(event: PointerEvent<SVGSVGElement>): Point | null {
    const transform = event.currentTarget.getScreenCTM();
    if (!transform) return null;
    const position = new DOMPoint(event.clientX,event.clientY).matrixTransform(transform.inverse());
    return { x: Math.max(crop.x,Math.min(crop.x+crop.width-1,Math.floor(position.x))),
      y: Math.max(crop.y,Math.min(crop.y+crop.height-1,Math.floor(position.y))) };
  }
  function selection(end: Point): Rectangle | null {
    if (!start.current) return null;
    return { type:'rectangle',x:Math.min(start.current.x,end.x),y:Math.min(start.current.y,end.y),
      width:Math.abs(start.current.x-end.x)+1,height:Math.abs(start.current.y-end.y)+1 };
  }
  function clear() { start.current = null; pointer.current = null; setDrag(null); }
  const shown = drag ?? target;
  const limits = {x:[crop.x,crop.x+crop.width-target.width],y:[crop.y,crop.y+crop.height-target.height],
    width:[1,crop.x+crop.width-target.x],height:[1,crop.y+crop.height-target.y]};
  return <figure className="ie-part-target"><svg aria-label="在干净局部图上核对或拖动重画目标框"
    viewBox={[crop.x,crop.y,crop.width,crop.height].join(' ')}
    onPointerDown={event=>{
      if (event.button!==0 || pointer.current!==null) return;
      const at=point(event); if (!at) return;
      start.current=at;pointer.current=event.pointerId;event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event=>{
      if (pointer.current!==event.pointerId) return;
      const at=point(event); if (at) setDrag(selection(at));
    }}
    onPointerUp={event=>{
      if (pointer.current!==event.pointerId) return;
      const at=point(event), result=at&&selection(at);
      if (result && result.width>1 && result.height>1) onChange(result);
      clear();
    }}
    onPointerCancel={clear} onLostPointerCapture={clear}>
    <title>核对目标与保护区</title>
    <image x={crop.x} y={crop.y} width={crop.width} height={crop.height} preserveAspectRatio="none" href={'data:image/png;base64,'+png}/>
    {protectedBoxes.map(({part,region},i)=><rect key={i} {...{x:region.x,y:region.y,width:region.width,height:region.height}} fill="#ed5151" fillOpacity=".22" stroke="#ed5151" vectorEffect="non-scaling-stroke"><title>{part}</title></rect>)}
    <rect x={shown.x} y={shown.y} width={shown.width} height={shown.height} fill="none" stroke="#f7cc43" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
  </svg><figcaption>黄框是目标，红框是建议保护区。可拖动重画目标，或在主画布用涂选进一步修正。</figcaption>
    <details><summary>按原图像素微调目标框</summary>
      {(['x','y','width','height'] as const).map(field=><label key={field}>{({x:'目标 X',y:'目标 Y',width:'目标宽',height:'目标高'})[field]}
        <input type="number" value={target[field]} min={limits[field][0]} max={limits[field][1]} onChange={event=>{
          const value=event.target.valueAsNumber;
          if(Number.isInteger(value))onChange({...target,[field]:Math.max(limits[field][0],Math.min(limits[field][1],value))});
        }}/></label>)}
    </details></figure>;
}
