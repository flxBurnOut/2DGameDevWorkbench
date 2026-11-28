"""Versioned evidence for visibility versus actual object discontinuity.

No confidence-voting shortcut and no automatic artwork decision. The two
baseline calls stay unchanged. New opinions must justify a visible break, or
the geometry behind an absence claim; uncertainty does not prove either loss
or harmless occlusion. Raw opinions are retained beside guarded conclusions.
"""
from __future__ import annotations
import copy
from typing import Literal
from pydantic import Field,create_model
from .contracts import Contract
from .visual_review import Audit
from .dispute_review import Resolution
from ..errors import ValidationHarnessError

# Actual saved-image opinions plus local replay verified the uncertainty guard.
# The negative sample exposed a mistaken final clearance, not a perfect classifier.
DEFAULT_VISIBILITY_REVIEW=4


class VisibilityFinding(Contract):
    subject: str = Field(min_length=1,max_length=180)
    frames: list[int] = Field(min_length=1,max_length=64)
    before_frames: list[int] = Field(default_factory=list,max_length=16)
    after_frames: list[int] = Field(default_factory=list,max_length=16)
    observation: Literal['visible','partly_visible','not_visible','ambiguous']
    explanation: Literal['occlusion','foreshortening','effects','out_of_frame','none','uncertain']
    expected_visibility: Literal['supported','not_required','unknown']
    finding: Literal['consistent','visible_shape_break','visible_duplicate','identity_change','unexplained_absence','uncertain']
    contradiction_frames: list[int] = Field(default_factory=list,max_length=64)
    facts: str = Field(min_length=4,max_length=700)
    alternatives: str = Field(min_length=4,max_length=700)


class VisibilityEvidence(Contract):
    items: list[VisibilityFinding] = Field(default_factory=list,max_length=8)
    summary: str = Field(min_length=4,max_length=700)


RULES='''
VISIBILITY EVIDENCE policy 1: Return equipment_visibility in addition to the normal
checks. Track each disputed reference object through the ordered actual frames.
Use items=[] only when there is no relevant object/visibility dispute, and explain.
For each item cite actual frames plus available before/after frames, the directly
visible observation, strongest plausible explanation, and expected_visibility.
Do not assume that an object should be visible merely because it exists in REF.

Occlusion: identify the visible occluder/overlap and entry/exit order. Foreshortening:
describe the ordered rotation/projection, grip and appearance continuity; a short
projected blade alone is not a short physical blade. Effects may obscure boundaries.
If the cause cannot be distinguished, keep it uncertain rather than claiming either
disappearance or harmless occlusion. A long invisible interval does not by itself
prove loss; duration is contextual evidence, not a defect threshold.

For visible_shape_break/visible_duplicate/identity_change, contradiction_frames must
show a direct contradiction in a VISIBLE part. Explain in facts what is broken and
in alternatives why perspective/occlusion/effects do not explain that visible fact.
For unexplained_absence, establish why the object should be visible in that actual
pose and camera, rather than asserting a generic side-view rule or hidden anatomy.
If an occlusion/projection explanation remains plausible, classify it as uncertain.
Use before/after continuity when available; do not invent missing neighboring frames.
Keep real, clearly visible duplication/breakage as defects. Do not turn all short or
hidden shapes into passes. Human preference is not an objective geometry label.

The equipment check and its visibility evidence must agree. The application can
retain an unsupported fail/pass as uncertain, but will not auto-approve or redraw.
Full source images are authoritative; no mask, tracking failure or earlier report
can substitute for actual visible evidence. Use concise Chinese explanations.
'''


def schema(base):
    return create_model('Visibility'+base.__name__,__base__=base,equipment_visibility=(VisibilityEvidence,...))


def add_content(content,*,version=1,interactable=False):
    # Version 4 changes local adjudication only, not model prompts or schema.
    if version==4:version=3
    value=copy.deepcopy(content)
    rules=RULES
    if version in (2,3):
        rules=rules.replace('VISIBILITY EVIDENCE policy 1',f'VISIBILITY EVIDENCE policy {version}')
        rules+='\ncontradiction_frames may cite both the observed interval and explicitly listed before/after frames to explain a boundary change. Include at least one frame inside the observed interval; never cite other frames or invent neighbors.\n'
    if version==3:
        rules+='\nFrame lists are sets of cited evidence, not disjoint time intervals. A shared boundary/context frame may appear in more than one list. Verify temporal claims from the full ordered actual images, not from min/max of these evidence lists. Distinguish a comparison context from the defective frame; naming a context frame does not declare it defective.\n'
    if interactable:
        rules = rules.replace('The equipment check', 'The fixed_parts check')
        rules += '\nUse equipment_visibility for fixed prop components. Inspect attachment, mounting, opacity, projected motion and occlusion.\n'
    value[0]['text']=rules+'\n'+value[0]['text']
    return value


def guard(result,count,*,resolution=False,version=1):
    """Only bound evidence supports a definite verdict; preserve raw output."""
    evidence=result.equipment_visibility
    for item in evidence.items:
        cited=[*item.frames,*item.before_frames,*item.after_frames,*item.contradiction_frames]
        if any(f<1 or f>count for f in cited):raise ValidationHarnessError('可见性核对引用了不存在的实际帧')
        allowed=set(item.frames) if version==1 else set(item.frames+item.before_frames+item.after_frames)
        if not set(item.contradiction_frames)<=allowed or (item.contradiction_frames and not set(item.contradiction_frames)&set(item.frames)):
            raise ValidationHarnessError('可见矛盾必须定位在本项实际观察帧内')
        if version<3 and item.before_frames and max(item.before_frames)>=min(item.frames):
            raise ValidationHarnessError('可见性前序证据必须早于观察区间')
        if version<3 and item.after_frames and min(item.after_frames)<=max(item.frames):
            raise ValidationHarnessError('可见性后序证据必须晚于观察区间')
    raw=result.model_dump(mode='json')
    normalized=copy.deepcopy(raw);normalized.pop('equipment_visibility')
    check=next((c for c in normalized['checks'] if c['dimension'] in {'equipment', 'fixed_parts'}),None)
    if check is None:raise ValidationHarnessError('可见性核对缺少装备维度')
    state=check['classification'] if resolution else check['status']
    defect_state='material_defect' if resolution else 'fail'
    pass_state='satisfied' if resolution else 'pass'
    def visible_contradiction(item):
        return bool(item.contradiction_frames) and item.finding in {
            'visible_shape_break','visible_duplicate','identity_change'} and item.observation in {'visible','partly_visible'}
    def grounded_absence(item):
        return bool(item.contradiction_frames) and item.finding=='unexplained_absence' and (
            item.expected_visibility=='supported' and item.explanation=='none')
    def has_external_context(item):
        return bool((set(item.before_frames) | set(item.after_frames)) - set(item.frames))
    definite=any(visible_contradiction(i) or grounded_absence(i) for i in evidence.items)
    unresolved=any(i.finding=='uncertain' or i.observation=='ambiguous' or (
        i.observation=='not_visible' and (i.explanation in {'none','uncertain'} or not has_external_context(i)))
        for i in evidence.items)
    reason=None
    if state==defect_state and not definite:reason='no_grounded_visible_contradiction_or_unexplained_absence'
    elif state==pass_state and (unresolved or definite):reason='visibility_uncertainty_or_contradiction_cannot_prove_consistency'
    if reason:
        check['classification' if resolution else 'status']='insufficient_evidence' if resolution else 'uncertain'
        check['confidence']=0
        check['evidence']=('当前可见性证据不足以确定外观是否断裂，需结合遮挡、投影和前后帧确认。'+check['evidence'])[:500]
    # The call's schema can extend Audit/Resolution (e.g. adjustment comparison).
    # Consumers retain their other fields; this only changes the equipment check.
    base=Resolution if resolution else Audit
    core=base.model_validate({k:v for k,v in normalized.items() if k in base.model_fields})
    trace={'version':version,'raw_opinion':raw,'equipment_visibility':evidence.model_dump(mode='json'),
           'guard_reason':reason,'definite_contradiction_reported':definite,
           'unresolved_visibility':unresolved,'verified_geometry':False}
    if version in (3,4):trace['frame_lists_are_evidence_sets_not_intervals']=True
    return core,trace


def retain_visible_disagreement(selected,traces,count):
    """A lone clearance cannot erase a grounded independent contradiction.

    This is an uncertainty gate, not voting for the two experts. Their claim may
    be mistaken; the visible frames still need a human decision. Also prevent an
    empty dispute visibility payload (``items=[]``) from silently clearing an
    independent expert's visibility concern. Keep the raw resolution and all
    original model responses alongside the guarded result.
    """
    from .visual_review import grounded_audit
    dimension = 'fixed_parts' if any(c['dimension'] == 'fixed_parts' for c in selected['checks']) else 'equipment'
    check=next(c for c in selected['checks'] if c['dimension']==dimension)
    if check['status']!='pass':return selected
    dispute_items=((traces.get('dispute') or {}).get('equipment_visibility') or {}).get('items') or []
    conflicting=[];unaddressed=[];frames=set()
    for name,trace in traces.items():
        if not name.startswith('expert_'):continue
        raw=next(c for c in trace['raw_opinion']['checks'] if c['dimension']==dimension)
        if raw.get('status')=='fail' and raw.get('confidence',0)>=.8 and trace['definite_contradiction_reported']:
            conflicting.append(name);frames.update(raw['frames'])
        elif not dispute_items and (trace.get('unresolved_visibility') or trace.get('guard_reason') or raw.get('status')!='pass'):
            unaddressed.append(name);frames.update(raw['frames'])
            for finding_item in (trace.get('equipment_visibility') or {}).get('items') or []:
                frames.update(finding_item.get('frames') or [])
    triggered=conflicting or unaddressed
    if not triggered:return selected
    value=copy.deepcopy(selected)
    item=next(c for c in value['checks'] if c['dimension']==dimension)
    prefix=('独立专家提出了具体帧中的外观矛盾，复核意见相反，尚未由实际画面裁定；不能直接通过。' if conflicting
            else '独立专家提出了可见性疑点，复核未提供具体对象的可见性核对证据；不能直接通过。')
    reason=('clearing_independent_visible_contradiction_requires_actual_frame_adjudication' if conflicting
            else 'clearing_independent_visibility_concern_without_evidence')
    item.update(status='uncertain',confidence=0,frames=sorted(frames|set(item['frames'])),
        evidence=(prefix+item['evidence'])[:500])
    pending=value.setdefault('requires_human_adjudication',[])
    if not any(p['dimension']==dimension for p in pending):
        prior=next(c for c in traces[triggered[0]]['raw_opinion']['checks'] if c['dimension']==dimension)
        pending.append({'dimension':dimension,'prior':copy.deepcopy(prior),'proposal':copy.deepcopy(check),
            'reason':reason})
    value['visibility_conflict']={'state':'needs_human_adjudication','dimension':dimension,
        'independent_opinions':triggered,'frames':item['frames'],
        'rule':'retain_conflicting_evidence_not_majority_vote' if conflicting else 'require_visibility_evidence_to_clear_expert_uncertainty'}
    verdict,checks,summary=grounded_audit(Audit.model_validate({k:value[k] for k in ('summary','checks')}),count)
    value.update(verdict=verdict,checks=checks,summary=summary)
    return value
