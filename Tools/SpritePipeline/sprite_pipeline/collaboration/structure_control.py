"""Explicit, frozen reference structure for task-specific planning.

This does not send a rig or a spatial mask to PixelLab. The model must explain
which observed parts it used and compile their relevant constraints into the
existing per-stage motion hint; the provider consumes text/image conditions.
"""
from __future__ import annotations
import copy,io
from PIL import Image
from pydantic import model_validator
from ..errors import ConflictError,ValidationHarnessError
from .contracts import digest
from .structure_contracts import StructureProposal

VERSION=1
INSTRUCTIONS='''
OPTIONAL CHECKED VISUAL STRUCTURE is supplied in task data. It describes the original
reference pose, not a desired fixed skeleton. Use its visible parts, silhouette extents,
anchors and relationships to interpret identity and task-specific movement. Unknown or
inferred anatomy is not control truth. Do not preserve original screen coordinates across
motion, freeze facing without a task reason, or turn short perspective changes into a rule.
Appearance and motion still independently inspect the original image and may question the
structure. For each planned stage provide structure_usage with valid part_ids, optional
visible anchor_ids/relation_ids, and an effect explaining the concrete planning change.
Each stage's existing motion.generation_hint MUST carry the most relevant resulting
constraint, in compact English within its existing 140-character limit. It will actually
reach the drawing API; IDs alone are not a drawing instruction. Keep the total compiled
prompt under 1000 characters. Preserve open-ended action reasoning and user exceptions.
Use structure for natural ownership, supported movement and appearance continuity, not
for action-name templates or unrequested immobilization. Text guidance is not a hard pose
lock. A useful explicit target image is a separate existing tool with its own source and
authorization; do not invent a target PNG or silently generate it.
'''


def freeze_structure(service,selection,reference_sha256, *, object_type):
    if selection is None:return None
    from .structures import VisualStructures
    structures=VisualStructures(service);value=structures.view(selection.analysis_id)
    doc=value['document']
    if not value['source_current'] or not doc or doc['token']!=selection.token:
        raise ConflictError('所选角色结构已过期，请重新核对后选择；未调用模型')
    if doc['issues'] or not doc['confirmation'] or value['pending']:
        raise ValidationHarnessError('先确认已核对的角色结构，再用于制作；未知部位可保留')
    if value['source'].get('object_type','character') != object_type or value['source']['sha256']!=reference_sha256:
        raise ConflictError('结构与本次角色原图不一致；未调用模型')
    parts={p['id']:p for p in doc['data']['parts']};geometry=[]
    for mask in doc['masks']:
        part=parts[mask['id']]
        if part['visibility']!='visible':continue
        with Image.open(io.BytesIO(structures.image(value['id'],mask['id'],doc['revision']))) as im:
            im=im.convert('L');area=sum(im.histogram()[1:]);box=im.getbbox()
        if area and box:geometry.append({'part_id':mask['id'],'visible_area':area,'native_box':list(box),'mask_sha256':mask['sha256']})
    snapshot={'version':VERSION,'selection':selection.model_dump(mode='json'),'revision':doc['revision'],
        'source':{k:value['source'][k] for k in ('sha256','width','height')},
        'data':copy.deepcopy(doc['data']),'geometry':geometry,'confirmation':copy.deepcopy(doc['confirmation'])}
    snapshot['sha256']=digest(snapshot)
    return snapshot


def verify_structure(snapshot,reference_sha256):
    if snapshot is None:return
    if snapshot.get('version')!=VERSION or digest({k:v for k,v in snapshot.items() if k!='sha256'})!=snapshot.get('sha256'):
        raise ConflictError('冻结的角色结构被修改，停止使用旧方案')
    if snapshot['source']['sha256']!=reference_sha256:
        raise ConflictError('冻结结构不是此作品的参考图')
    StructureProposal.model_validate(snapshot['data'])


def require_current_structure(service,snapshot,reference_sha256):
    verify_structure(snapshot,reference_sha256)
    if snapshot is None:return
    from .structures import VisualStructures
    value=VisualStructures(service).view(snapshot['selection']['analysis_id'])
    if (not value['source_current'] or not value['document'] or value['document']['token']!=snapshot['selection']['token']
            or value['document']['data']!=snapshot['data'] or value['document']['revision']!=snapshot['revision']):
        raise ConflictError('所用角色结构已修改，先查看并重新制定方案；不继续提交绘图')


def eligible_structure(snapshot):
    data=snapshot['data']
    parts=[p for p in data['parts'] if p['visibility']=='visible'];part_ids={p['id'] for p in parts}
    anchors=[a for a in data['anchors'] if a['state']=='visible' and a['part_id'] in part_ids]
    endpoint_ids=part_ids|{a['id'] for a in anchors}
    relations=[r for r in data['relations'] if r['state']=='visible' and r['source'] in endpoint_ids and r['target'] in endpoint_ids]
    return {'parts':parts,'anchors':anchors,'relations':relations}


def validate_structure_binding(spec,snapshot,reference_sha256,plan):
    if spec.visual_structure is None:
        if snapshot is not None or any(s.structure_usage for s in plan.stages):
            raise ValidationHarnessError('未选择视觉结构，不得在方案中捏造结构控制来源')
        return
    if snapshot is None:raise ValidationHarnessError('结构增强方案缺少冻结的原图结构')
    verify_structure(snapshot,reference_sha256)
    if snapshot['selection']!=spec.visual_structure.model_dump(mode='json'):
        raise ConflictError('方案绑定的结构与用户选择不同')
    eligible=eligible_structure(snapshot)
    parts={p['id']:p for p in eligible['parts']}
    anchors={a['id']:a for a in eligible['anchors']}
    relations={r['id']:r for r in eligible['relations']}
    for stage in plan.stages:
        use=stage.structure_usage
        if not use or not stage.motion:raise ValidationHarnessError('结构增强的每段须给出 structure_usage 及实际发送的 motion.generation_hint')
        if any(i not in parts or parts[i]['visibility']!='visible' for i in use.part_ids):
            raise ValidationHarnessError('结构方案引用了不存在或不可见的部件')
        if any(i not in anchors or anchors[i]['state']!='visible' for i in use.anchor_ids):
            raise ValidationHarnessError('不能把未知或推断锚点作为确定控制条件')
        if any(i not in relations or relations[i]['state']!='visible' for i in use.relation_ids):
            raise ValidationHarnessError('不能把未知或推断关系作为确定控制条件')


def planning_structure(snapshot,*,version=1):
    if snapshot is None:return None
    limits='Reference-pose observations only; mask centers are not joints, sparse points are not a dense skeleton, and PixelLab consumes text/image conditions rather than these masks.'
    if version==1:return {**copy.deepcopy(snapshot),'limits':limits}
    if version!=2:raise ValidationHarnessError('未知的结构规划视图版本')
    eligible=copy.deepcopy(eligible_structure(snapshot));data=snapshot['data']
    allowed={name[:-1]+'_ids':[item['id'] for item in entries] for name,entries in eligible.items()}
    names={p['id']:p['name'] for p in data['parts']}|{a['id']:a['name'] for a in data['anchors']}
    unavailable=[]
    for p in data['parts']:
        if p['id'] not in allowed['part_ids']:unavailable.append({'kind':'part','name':p['name'],'state':p['visibility'],'evidence':p['evidence']})
    for a in data['anchors']:
        if a['id'] not in allowed['anchor_ids']:unavailable.append({'kind':'anchor','name':a['name'],'part':names[a['part_id']],'state':a['state'],'evidence':a['evidence']})
    for r in data['relations']:
        if r['id'] not in allowed['relation_ids']:unavailable.append({'kind':'relation','type':r['type'],'source':names[r['source']],'target':names[r['target']],'state':r['state'],'evidence':r['evidence']})
    return {'view_version':2,'source_structure_sha256':snapshot['sha256'],'revision':snapshot['revision'],
        'source':copy.deepcopy(snapshot['source']),'usable_structure':eligible,
        'geometry':[copy.deepcopy(g) for g in snapshot['geometry'] if g['part_id'] in allowed['part_ids']],
        'allowed_structure_usage':allowed,
        'not_control_evidence':{'unavailable_observations':unavailable,'uncertainties':copy.deepcopy(data['uncertainties'])},
        'limits':limits+' Only allowed_structure_usage identifiers may be cited as observed control evidence; unavailable observations remain uncertain and are not erased from the source document.'}


def bind_planning_schema(schema_type,snapshot,*,stage_type='PlanStage'):
    """Constrain reference citations from this task's actual visible structure.

    The local validator repeats the wire constraint if a provider ignores it.
    No unknown facts are dropped from the frozen source, and no poses are invented.
    """
    eligible=eligible_structure(snapshot)
    allowed={name[:-1]+'_ids':tuple(item['id'] for item in entries) for name,entries in eligible.items()}
    class BoundStructurePlan(schema_type):
        @classmethod
        def model_json_schema(cls,*args,**kwargs):
            schema=copy.deepcopy(schema_type.model_json_schema(*args,**kwargs))
            fields=schema['$defs']['StructureUsage']['properties']
            for key,values in allowed.items():
                if values:fields[key]['items']={'type':'string','enum':list(values)}
                else:fields[key]['maxItems']=0
            stage=schema['$defs'][stage_type]['properties']['structure_usage']
            stage.clear();stage.update({'$ref':'#/$defs/StructureUsage'})
            return schema

        @model_validator(mode='after')
        def visible_citations(self):
            plan=getattr(self,'proposal',None) or getattr(self,'plan',None)
            if plan:
                for stage in plan.stages:
                    if stage.structure_usage is None:raise ValueError('Checked structure requires explicit stage structure_usage')
                    for key,values in allowed.items():
                        if any(value not in values for value in getattr(stage.structure_usage,key)):
                            raise ValueError('structure_usage cites unavailable '+key)
            return self
    return BoundStructurePlan


def prop_structure_problem(prop, snapshot):
    if not snapshot:
        if prop and prop.motion_type in {'hinge_rotation', 'deformation'}:
            return '此运动需要已核对的部件结构。请解析或标注部件与锚点，确认结构并重新规划。'
        return None
    if not prop:
        return '交互物方案缺少部件合同'
    parts = {p['id'] for p in snapshot['data']['parts']}
    moving, fixed = set(prop.moving_parts), set(prop.fixed_parts)
    missing = sorted(parts - (moving | fixed))
    unknown = sorted((moving | fixed) - parts)
    shared = sorted(moving & fixed)
    duplicates = len(moving) != len(prop.moving_parts) or len(fixed) != len(prop.fixed_parts)
    if duplicates:
        return '同一部件在所属清单内只能登记一次。'
    if missing or unknown or shared:
        return f'部件必须按结构 ID 唯一归类。遗漏 {missing}，未知 {unknown}，重复归类 {shared}。'
    if prop.motion_type == 'hinge_rotation':
        eligible = eligible_structure(snapshot)
        pivots = {a['id'] for a in eligible['anchors'] if a['part_id'] in fixed}
        endpoints = {g['part_id'] for g in snapshot['geometry']} & moving
        if not prop.hinge or prop.hinge.pivot_anchor_id not in pivots or prop.hinge.endpoint_part_id not in endpoints:
            return '铰接转动须引用固定部件上已核对的可见轴点和具有蒙版的运动端点部件。'
    return None
