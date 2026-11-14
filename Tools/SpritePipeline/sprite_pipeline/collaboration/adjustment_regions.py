"""Explicit frame-local edit regions and lossless protection outside them.

These regions are user authorization, not inferred semantic segmentation.
PixelLab still edits images; the local compositor enforces the spatial boundary.
"""
from __future__ import annotations

import hashlib
import io
from PIL import Image, ImageDraw
from pydantic import Field
from .contracts import Contract
from ..errors import ConflictError, ValidationHarnessError
from ..vision_evidence import image_part


class PixelSpan(Contract):
    start: int = Field(ge=0, le=16383)
    length: int = Field(ge=1, le=16384)


class FrameEditRegion(Contract):
    frame: int = Field(ge=0, le=63)
    source_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    spans: list[PixelSpan] = Field(min_length=1, max_length=8192)


def rgba(data):
    with Image.open(io.BytesIO(data)) as image:
        if image.format != 'PNG' or image.size not in {(64,64),(128,128)}:
            raise ValidationHarnessError('区域编辑需要原尺寸的 64/128 像素 PNG')
        return image.convert('RGBA')


def mask_for(region, size, *, allow_full=False):
    count=size[0]*size[1]; mask=bytearray(count);end=-1
    for span in region['spans']:
        start,length=span['start'],span['length']
        if start<end or start+length>count:
            raise ValidationHarnessError('编辑区域越界、重叠或顺序错误；不会自动扩大或纠正')
        mask[start:start+length]=b'\xff'*length;end=start+length
    selected=sum(v==255 for v in mask)
    if selected==0 or (selected==count and not allow_full):
        raise ValidationHarnessError('请涂选局部编辑区域，不能为空或覆盖整张图')
    return Image.frombytes('L',size,bytes(mask))


def validate_regions(regions, frames, data, start, end):
    values=[FrameEditRegion.model_validate(r).model_dump(mode='json') for r in regions]
    if [r['frame'] for r in values] != list(range(start,end+1)):
        raise ValidationHarnessError('每个选中帧都需要对应的编辑区域，不能遗漏、重复或包含其他帧')
    for region in values:
        i=region['frame']
        if region['source_sha256']!=frames[i]['sha256'] or hashlib.sha256(data[i]).hexdigest()!=region['source_sha256']:
            raise ConflictError('编辑区域所依据的原帧已改变，请重新涂选')
        mask_for(region,rgba(data[i]).size)
    return values


def region_summary(regions, sources):
    result=[]
    for region in regions:
        mask=mask_for(region,rgba(sources[region['frame']]).size)
        result.append({'frame':region['frame']+1,'box_xyxy':list(mask.getbbox()),
                       'editable_pixels':mask.histogram()[255]})
    return result


def region_panels(regions, sources):
    """Labeled overlays are evidence only, never sent as production frame pixels."""
    content=[]
    for offset in range(0,len(regions),4):
        group=regions[offset:offset+4];board=Image.new('RGB',(len(group)*256,280),(25,30,40))
        draw=ImageDraw.Draw(board)
        for n,region in enumerate(group):
            original=rgba(sources[region['frame']]);mask=mask_for(region,original.size)
            base=Image.new('RGBA',original.size,(25,30,40,255));base.alpha_composite(original)
            tint=Image.new('RGBA',original.size,(35,220,220,0));tint.putalpha(mask.point(lambda a:90 if a else 0))
            base.alpha_composite(tint)
            board.paste(base.convert('RGB').resize((256,256),Image.Resampling.NEAREST),(n*256,24))
            draw.text((n*256+4,5),f'SOURCE {region["frame"]+1}: CYAN = EDITABLE',fill='white')
        content.extend([{'type':'input_text','text':'AUTHORIZED REGION OVERLAY on ORIGINAL frames. Cyan is an annotation, not artwork or an effect. Only these pixels may change; the rest are restored from the exact source locally. Do not infer an object identity from the mask.'},image_part(board)])
    return content


def composite_region(source, generated, region):
    original=rgba(source);proposed=rgba(generated)
    if proposed.size!=original.size:raise ValidationHarnessError('备选尺寸改变，不能回填保护像素')
    mask=mask_for(region,original.size)
    merged=Image.composite(proposed,original,mask)
    out=io.BytesIO();merged.save(out,format='PNG');data=out.getvalue()
    final=rgba(data).tobytes();before=original.tobytes();raw=proposed.tobytes();bits=mask.tobytes()
    protected_changed=sum(before[i*4:i*4+4]!=final[i*4:i*4+4] for i,v in enumerate(bits) if not v)
    if protected_changed:raise ConflictError('区域外像素保护校验失败，不能交付备选')
    stats={'frame':region['frame']+1,'editable_pixels':sum(bool(v) for v in bits),
        'protected_pixels':sum(not v for v in bits),'protected_changed_pixels':protected_changed,
        'discarded_outside_changes':sum(before[i*4:i*4+4]!=raw[i*4:i*4+4] for i,v in enumerate(bits) if not v),
        'changed_inside_pixels':sum(before[i*4:i*4+4]!=final[i*4:i*4+4] for i,v in enumerate(bits) if v)}
    return data,stats


def verify_protection(source, proposed, region, *, allow_full=False):
    before=rgba(source);after=rgba(proposed)
    if before.size!=after.size:raise ConflictError('受保护备选尺寸已改变')
    bits=mask_for(region,before.size,allow_full=allow_full).tobytes();a=before.tobytes();b=after.tobytes()
    if any(a[i*4:i*4+4]!=b[i*4:i*4+4] for i,v in enumerate(bits) if not v):
        raise ConflictError('备选改变了区域外的受保护像素，不能采用')
