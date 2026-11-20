"""Evaluate an explicit alternative before adoption using the existing reviewers."""
import copy
from .review_evaluation import ReviewEvidence, validated_audit
from .review_inputs import review_dimensions, observation_content, audit_content
from .visual_review import Observations, Audit, evidence_panels
from .production_review import independent_followup, diagnostic_report
from ..errors import ValidationHarnessError


def review_alternative(manager, task):
    evidence = ReviewEvidence(manager.folder(task)/'evidence')
    if task['diagnostic'] and not getattr(manager.s, 'adjustment_test_reviews', False):
        return {'state':'diagnostic','verdict':'uncertain','summary':'诊断备选，未调用真实模型；需实际播放确认。',**diagnostic_report()}
    def call(phase, content, schema):
        if phase!='observe':
            # Actual before/after evidence is necessary to verify "keep this pose".
            # Keep baseline observation candidate-only; audit/opinions/dispute compare
            # both sequences without adding calls or changing legacy review prompts.
            manager.verify(task,live=True)
            content=[*content,{'type':'input_text','text':
                'BEFORE / ORIGINAL COMPARISON ONLY. All preceding actual-frame panels are the PROPOSED alternative being judged. '
                'The following panels are the immutable ORIGINAL sequence at the same FPS and same one-based frame labels; they are NOT extra playback frames. '
                f"Only source frames {task['start']+1} through {task['end']+1} may change. Compare matching original/proposed poses, equipment and both joins. "
                'Judge whether the requested change occurred AND whether unrequested properties were preserved. Do not claim preservation from the alternative alone. '
                'Cited findings refer to the PROPOSED sequence. Keep observations of the two sequences distinct.'},
                *evidence_panels([manager.folder(task)/'source'/f'{i:03d}.png' for i in range(len(task['source_frames']))],
                                manager.folder(task)/'reference.png',task['fps'])]
        comparison=task.get('comparison_protocol')==1 and phase!='observe'
        visibility='equipment_visibility' in schema.model_fields
        if comparison:
            from .adjustment_comparison import AdjustmentAudit, AdjustmentResolution, RULES, remember
            schema=AdjustmentResolution if phase=='dispute' else AdjustmentAudit
            content=[*content,{'type':'input_text','text':RULES}]
            if task.get('edit_regions'):
                from .adjustment_regions import region_panels
                content+=region_panels(task['edit_regions'],[(manager.folder(task)/'source'/f'{i:03d}.png').read_bytes() for i in range(len(task['source_frames']))])
                content.append({'type':'input_text','text':'LOCAL SPATIAL PROTECTION RECEIPT (not a visual verdict): '+str(task['spatial_protection'])})
            if visibility:
                from .visibility_review import schema as visibility_schema
                schema=visibility_schema(schema)
        value=manager.model_call(task, 'reviewer', phase, content, schema, len(evidence.paths))
        if comparison:remember(task,phase,value);manager.save(task)
        return value
    pictures=evidence.pictures();segment=task['stage'] is not None
    observations=call('observe',observation_content(pictures,segment=segment,interactable=bool(task.get('interactable'))),Observations)
    if [f.frame for f in observations.frames] != list(range(1,len(evidence.paths)+1)):
        raise ValidationHarnessError('备选逐帧观察不完整；不自动重试')
    context=evidence.context();context['observations']=observations.model_dump(mode='json')
    result=call('audit',audit_content(pictures,context,task['fps'],segment=segment),Audit)
    baseline={'state':'complete',**validated_audit(result,len(evidence.paths), review_dimensions(context))}
    if task['protocol']!='experts_v1':return baseline
    original={**copy.deepcopy(baseline),'mode':'baseline','evidence_token':evidence.token,
              'model_snapshot':task['models'],'requests':copy.deepcopy(task['review_calls'])}
    details={'state':'running','max_calls':5,'baseline':original,'experts':{},'requires_human_adjudication':[]}
    def persist(**updates):
        details.update(updates);details['calls_used']=len(task['review_calls'])
        task['review']={'state':'running','verdict':'uncertain','protocol':'experts_v1','expert_review':copy.deepcopy(details)}
        manager.save(task)
    from .adjustment_comparison import disputes
    selected=independent_followup(evidence,original,call,persist,lambda:task['review_calls'],
        additional_disputes=(lambda:disputes(task)) if task.get('comparison_protocol')==1 else None,
        visibility_version=task.get('visibility_review_version'))
    if task['diagnostic']:details['simulated']=True
    return {**baseline,**selected,'protocol':'experts_v1','expert_review':details}


def context_for(task):
    """The current user goal replaces conflicting suggestions, not their history."""
    intent=task['intent']
    goal=(task['user_request'] or intent['goal'])
    policy=(f"This is an explicit adjustment of actual frames {task['start']+1}–{task['end']+1}. "
            'The current adjustment goal is authoritative for that range, even if the original was acceptable. '
            'Judge the requested change, preserved properties and BOTH joins. Outside the range, the original pixels and timing are fixed. '
            'Do not penalize an intentional user change because it differs from a superseded suggestion. '
            'No automatic adoption or further generation is authorized. ')
    if task.get('range_policy')=='unlocked_stage_tail_v2':
        policy=policy.replace('BOTH joins','the protected preceding join and the intended segment endpoint')
        policy+=' The selected range includes an UNLOCKED segment ending. There is no following generated frame; assess the original intended checkpoint pose, not an invented right-hand join. '
    if task.get('intent_format_version') in (3,4):
        policy=policy.replace('the intended segment endpoint','unrequested properties of the actual source ending')
        policy=policy.replace('assess the original intended checkpoint pose', 'compare the actual original ending')
        policy+=' The original actual frames, NOT an ideal planner endpoint, define what must be preserved. Improved target details do not excuse new unrequested pose, silhouette, facing, position or continuity regressions. '
        if task.get('preserve_motion') is True:
            policy+=' This is APPEARANCE ONLY: compare matching original/proposed poses and body silhouettes frame by frame. Report observed motion changes even if the new motion looks plausible. Intent claims are not preservation evidence. '
    context={'user_request':policy+'\nCURRENT GOAL: '+goal+'\nPRESERVE: '+intent['preserve'],
             'appearance':intent['preserve'],'seconds_per_frame':1/task['fps']}
    if task['stage'] is not None:
        context['segment']={'goal':goal,'preserve':intent['preserve'],'scope':'current complete segment including both joins'}
        if task.get('range_policy')=='unlocked_stage_tail_v2':
            context['segment'].update(scope='current complete segment, protected left join and editable ending',definition=task['stage_definition'])
            if task.get('intent_format_version') in (3,4):context['segment'].pop('definition')
    else:
        context['quality_contract']={'event_contract':goal,'appearance_contract':intent['preserve'],
            'ending_contract':'Keep unchanged source endpoints','rhythm_contract':'Keep FPS/frame order and natural joins; the chosen change must remain coherent with the full clip'}
    if task.get('interactable'):
        context['interactable'] = task['interactable']
    return context


def add_accepted_goals(context, candidate, stage=None):
    """Only new explicitly adopted adjustments affect later review context."""
    execution=candidate.plan_execution
    updates=(execution.stages[stage].adjustment_history if stage is not None else
             [a for r in execution.stages for a in r.adjustment_history])
    if not updates:return context
    value=copy.deepcopy(context)
    value['user_request'] += '\nEXPLICITLY ADOPTED LOCAL USER UPDATES (apply in recorded order; later updates override earlier overlapping updates and old suggestions only in their recorded ranges): '+str(updates)
    return value
