"""Validate sparse semantic observations and derive non-verdict tracking cues."""
from __future__ import annotations

from pathlib import Path
from PIL import Image

from ..errors import ConflictError, ValidationHarnessError
from ..jsonio import inside, sha256_file
from .structure_contracts import StructureProposal, coordinate_issues
from .tracking_observation import StructureObservations


def correction_inputs(reference, observations, paths, selected):
    proposal=StructureProposal.model_validate(reference)
    values=StructureObservations.model_validate(observations)
    if [f.frame_index for f in values.frames] != selected:
        raise ValidationHarnessError('关键帧观察编号与实际选取不一致')
    expected_parts={p.id for p in proposal.parts}
    expected_anchors={a.id for a in proposal.anchors}
    expected_relations={r.id for r in proposal.relations}
    corrections=[];issues=[];semantic=[]
    for frame in values.frames:
        current=frame.structure
        if {p.id for p in current.parts} != expected_parts:
            raise ValidationHarnessError('关键帧不能重命名、丢弃或交换参考部件身份')
        if {a.id for a in current.anchors} != expected_anchors or {r.id for r in current.relations} != expected_relations:
            raise ValidationHarnessError('关键帧锚点或关系身份与参考结构不同')
        original_parts={p.id:p for p in proposal.parts}
        if any(p.parent_id != original_parts[p.id].parent_id or p.kind != original_parts[p.id].kind for p in current.parts):
            raise ValidationHarnessError('关键帧不能改变参考部件类型或层级')
        original_anchors={a.id:a for a in proposal.anchors}
        if any(a.part_id != original_anchors[a.id].part_id for a in current.anchors):
            raise ValidationHarnessError('关键帧不能改变锚点所属部件')
        with Image.open(paths[frame.frame_index]) as im:
            problems=coordinate_issues(current,im)
        bad={issue['id'] for issue in problems}
        issues.extend({'frame_index':frame.frame_index,**issue} for issue in problems)
        for part in current.parts:
            correction={'frame_index':frame.frame_index,'part_id':part.id,
                        'state':'unknown' if part.id in bad else part.visibility,
                        'origin':'semantic_keyframe','evidence':part.evidence}
            if correction['state']=='visible':
                correction.update(box=part.box,points=[[p.x,p.y] for p in part.points],labels=[p.label for p in part.points])
            corrections.append(correction)
        verified=current.model_dump(mode='json')
        unresolved_parts={p.id for p in current.parts if p.visibility in ('unknown','occluded')} | (bad & expected_parts)
        for part in verified['parts']:
            if part['id'] in bad:
                part.update(visibility='unknown',box=None,points=[],evidence='部件坐标未通过实际像素校验；原提议另行保留')
        # Preserve the untouched proposal separately; invalid coordinates are
        # unusable evidence rather than silently snapped to the nearest pixel.
        for anchor in verified['anchors']:
            if anchor['id'] in bad or anchor['part_id'] in unresolved_parts:
                anchor.update(state='unknown',x=None,y=None,evidence='坐标或所属部件未通过实际像素校验；原提议另行保留')
        invalid_refs=bad|unresolved_parts|{a['id'] for a in verified['anchors'] if a['state'] in ('unknown','occluded')}
        for relation in verified['relations']:
            if relation['source'] in invalid_refs or relation['target'] in invalid_refs:
                relation.update(state='unknown',evidence='所依赖的实际部位尚不能确定')
        semantic.append({'frame_index':frame.frame_index,'structure':verified})
    return {'corrections':corrections,'issues':issues,'frames':semantic,'summary':values.summary}


def validate_receipt(receipt, folder, job):
    """Reject missing/reordered frames, changed source, or substituted masks."""
    folder=Path(folder)
    if receipt.get('operation')!='track' or receipt.get('fps')!=job['fps']:
        raise ConflictError('时序结构的操作或播放速度不同')
    policy=job.get('tracking_policy','reference_and_corrections_v1')
    if (policy not in ('reference_and_corrections_v1','manual_first_frame_v2')
            or receipt.get('tracking_policy','reference_and_corrections_v1')!=policy):
        raise ConflictError('时序结构的纠正初始化规则与冻结输入不同')
    if receipt.get('reference')!=job['reference'] or receipt.get('source_frames')!=job['frames']:
        raise ConflictError('时序结构所依据的实际帧不同')
    if receipt.get('reference_parts')!=job['parts'] or receipt.get('corrections')!=job.get('corrections',[]):
        raise ConflictError('时序结构的部件或纠正输入不同')
    if not receipt.get('context_excluded_from_playback') or receipt.get('context_frame_count')!=1:
        raise ConflictError('参考图不得混入动画播放')
    frames=receipt.get('frames',[])
    if [f['frame_index'] for f in frames]!=list(range(len(job['frames']))):
        raise ConflictError('时序结构帧数或顺序不同')
    expected={p['id'] for p in job['parts']}
    for frame,source in zip(frames,job['frames']):
        if frame['source_sha256']!=source['sha256'] or frame['time_seconds']!=frame['frame_index']/job['fps']:
            raise ConflictError('时序结构的帧来源或时间不同')
        parts=frame.get('parts',[])
        if len(parts)!=len(expected) or {p['id'] for p in parts}!=expected:
            raise ConflictError('时序部件身份缺失或重复')
        for part in parts:
            path=inside(folder,folder/part['file'])
            if sha256_file(path)!=part['sha256']:
                raise ConflictError('时序区域文件发生变化')
            with Image.open(path) as im:
                if im.format!='PNG' or im.size!=(receipt['width'],receipt['height']):
                    raise ConflictError('时序区域尺寸或文件格式不同')
    for source in [job['reference'],*job['frames']]:
        if sha256_file(Path(source['path']))!=source['sha256']:
            raise ConflictError('时序结构原始图片已改变')
    for part in job['parts']:
        if sha256_file(Path(part['mask_path']))!=part['mask_sha256']:
            raise ConflictError('时序结构参考区域已改变')


def tracking_cues(receipt, folder, reference):
    """Measurements expose risky estimates. They never reject artwork."""
    import numpy as np
    proposal=StructureProposal.model_validate(reference)
    parents={p.id:p.parent_id for p in proposal.parts}
    def related(a,b):
        def ancestors(x):
            found=set()
            while parents.get(x):
                x=parents[x];found.add(x)
            return found
        return a in ancestors(b) or b in ancestors(a)
    initial={}
    for p in receipt['reference_parts']:
        with Image.open(p['mask_path']) as im: initial[p['id']]=int((np.asarray(im.convert('L'))>0).sum())
    cues=[];series=[]
    for frame in receipt['frames']:
        masks={}
        for part in frame['parts']:
            if part['state'] in ('unknown','occluded'):
                cues.append({'frame_index':frame['frame_index'],'parts':[part['id']], 'reason':'visibility_or_identity_unresolved'})
                continue
            with Image.open(Path(folder)/part['file']) as im: masks[part['id']]=np.asarray(im.convert('L'))>0
            if part['area']>max(3*initial[part['id']],initial[part['id']]+48):
                cues.append({'frame_index':frame['frame_index'],'parts':[part['id']], 'reason':'region_expansion_requires_visual_check'})
            elif initial[part['id']]>=8 and part['area']<initial[part['id']]*.25:
                cues.append({'frame_index':frame['frame_index'],'parts':[part['id']], 'reason':'region_contraction_requires_visual_check_not_proof_of_occlusion_or_loss'})
        names=list(masks)
        for i,a in enumerate(names):
            for b in names[i+1:]:
                if related(a,b):continue
                size=min(int(masks[a].sum()),int(masks[b].sum()))
                if size>=8 and int((masks[a]&masks[b]).sum())/size>.75:
                    cues.append({'frame_index':frame['frame_index'],'parts':[a,b], 'reason':'large_sibling_overlap_identity_may_be_ambiguous'})
        parts=[]
        for part in frame['parts']:
            observed={k:part.get(k) for k in ('id','state','area','box','centroid','axis_degrees_mod_180')}
            if part['state'] in ('unknown','occluded'):
                # Raw prediction masks remain in immutable receipts. They are
                # not positions or overlap evidence once identity is unknown.
                observed.update(area=None,box=None,centroid=None,axis_degrees_mod_180=None)
            parts.append(observed)
        series.append({'frame_index':frame['frame_index'],'time_seconds':frame['time_seconds'],'parts':parts})
    return {'version':2,'series':series,'cues':cues,
            'interpretation':'区域、轴向和重叠是观察提示；不是关节、朝向、握持、重复动作或画面缺陷的确定判断。未知项不得自动补齐。'}
