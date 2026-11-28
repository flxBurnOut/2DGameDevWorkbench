"""Keep user requirements separate from proposed realization details.

Only the optional structure-assisted dispute uses this contract. The frozen
baseline and ordinary experts_v1 schema and judgments are unchanged.
"""
from typing import Literal
from pydantic import Field
from .dispute_review import Resolution, ResolutionCheck, apply_resolution


class StructureResolutionCheck(ResolutionCheck):
    basis: Literal['explicit_user_requirement','reference_continuity','visible_event_discontinuity','planner_preference','insufficient_evidence']
    requirement_quote: str = Field(max_length=500)


class StructureResolution(Resolution):
    checks: list[StructureResolutionCheck] = Field(min_length=3,max_length=3)


JUDGMENT_RULES=(
    'For each dimension state basis and requirement_quote. Use explicit_user_requirement only with an EXACT quote '
    'from visual_structure.requirement_provenance.explicit_user_text. A planner paraphrase is not a user quote. '
    'Use reference_continuity for visible loss, duplication, replacement or broken ownership of actual reference objects. '
    'Use visible_event_discontinuity for a demonstrated unsupported pose jump or an extra complete event, not merely a '
    'hold, timing preference, different pose path, or an unconfirmed planner criterion. '
    'Use planner_preference when the deviation concerns proposed realization details without a visible break of the '
    'requested outcome or reference continuity; use insufficient_evidence when the cause cannot be established. '
    'For non-user bases leave requirement_quote empty. Describe the actual finding even when it is a preference. '
)


def apply_structure_resolution(augmented,result,evidence):
    permitted=evidence.explicit_requirements()
    checks=[];guards=[]
    for item in result.checks:
        value=item.model_dump(exclude={'basis','requirement_quote'})
        if item.classification=='material_defect':
            reason=None
            if item.basis=='planner_preference':
                value['classification']='preference'
                reason='planner_detail_is_not_a_user_requirement'
            elif item.basis=='insufficient_evidence':
                value['classification']='insufficient_evidence'
                reason='defect_requires_actual_evidence'
            elif item.basis=='explicit_user_requirement' and (
                not item.requirement_quote.strip() or not any(item.requirement_quote in text for text in permitted)
            ):
                value.update(classification='insufficient_evidence',confidence=0)
                reason='user_requirement_quote_is_not_in_source'
            if reason:
                guards.append({'dimension':item.dimension,'reason':reason,'original':item.model_dump()})
        checks.append(value)
    normalized=Resolution(summary=result.summary,checks=checks)
    return {**apply_resolution(augmented,normalized,len(evidence.paths)),
            'source_resolution':result.model_dump(mode='json'),'requirement_guards':guards}
