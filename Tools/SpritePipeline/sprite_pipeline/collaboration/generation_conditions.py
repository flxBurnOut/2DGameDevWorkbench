"""Versioned, inspectable drawing conditions. No action templates or paid work.

The original compiler remains the default for frozen tasks. Policy 1 sends the
existing motion fields explicitly instead of relying on a 140-character summary
to carry body mechanics AND structure. This is text conditioning, not a rig.
"""
from __future__ import annotations

import copy
import hashlib
from pydantic import model_validator

from ..errors import ValidationHarnessError

VERSION = 1
LIMIT = 1000
DEFAULT_GENERATION_POLICY = 6
# Policy 2 reserves capacity mechanically. Full expert findings, requirements,
# checkpoints' reasons and hold reasons remain available to planning/review.
# These limits apply only to the strings actually sent for drawing.
TEXT_LIMITS = {
    'MotionQuality': {'appearance_contract':45, 'ending_contract':40},
    'PlanStage': {'prompt':70},
    'PoseCheckpoint': {'endpoint':40, 'rhythm':55},
    'MotionConstraints': {'camera':25, 'orientation':35, 'drive':60, 'support':45,
                         'trajectory':45, 'appearance':50, 'generation_hint':45},
    'KeyPose': {'description':26},
}


def enabled(plan, policy_version):
    return policy_version in (1,2,3,4,5,6) and plan.quality is not None and plan.quality.version == 4


def condition_rows(plan, stage_index, *, policy_version=1):
    if policy_version == 6:
        from .structured_brief import checked_rows
        return checked_rows(plan, stage_index)
    if policy_version in (3,4,5):
        from .executable_brief import rows
        return rows(plan,stage_index)
    stage = plan.stages[stage_index]
    if stage.motion is None or stage.checkpoint is None:
        raise ValidationHarnessError('新绘图条件需要完整的段级运动、姿势与节奏方案；尚未提交绘图')
    motion = stage.motion
    rows = []

    def add(label, text, *sources):
        rows.append({'label': label, 'text': text, 'sources': list(sources)})

    # One identity source for drawing; local appearance remains separate so a
    # rigid/flexible shape or physical ownership rule cannot vanish in a summary.
    add('Identity', plan.quality.appearance_contract, 'quality.appearance_contract')
    add('This segment', stage.prompt, 'stage.prompt')
    add('Timing', stage.checkpoint.rhythm, 'checkpoint.rhythm')
    add('End pose', stage.checkpoint.endpoint, 'checkpoint.endpoint')
    for label, field in [('Camera', 'camera'), ('Facing', 'orientation'),
                         ('Drive', 'drive'), ('Support', 'support'),
                         ('Path', 'trajectory'), ('Shape', 'appearance')]:
        add(label, getattr(motion, field), 'motion.' + field)
    boundary = {
        'pass_through': 'Keep moving through the join; no endpoint hold.',
        'settle': 'Ease into the intended ending; no extra hold.',
        'intentional_hold': 'Hold only in the declared frame ranges.',
    }[motion.boundary]
    if policy_version == 2:
        boundary = {'pass_through':'Continue through join.', 'settle':'Ease into intended end.',
                    'intentional_hold':'Hold declared frames.'}[motion.boundary]
    if motion.holds:
        boundary += ' Holds: ' + '; '.join(f'{h.start}-{h.end}' + (f': {h.reason}' if policy_version==1 else '') for h in motion.holds)
    add('Boundary', boundary, 'motion.boundary', 'motion.holds')
    start = sum(s.frame_count for s in plan.stages[:stage_index])
    poses = [f'{p.frame-start}: {p.description}' for p in plan.quality.key_poses
             if start < p.frame <= start + stage.frame_count]
    if poses:
        add('Poses', '; '.join(poses), 'quality.key_poses')
    # This slot no longer competes with the explicitly transmitted mechanics.
    add('Relations', motion.generation_hint, 'motion.generation_hint')
    if stage_index == len(plan.stages)-1:
        add('Finish', plan.quality.ending_contract, 'quality.ending_contract')
    add('Input', 'Continue the supplied pose. Transparent background.' if policy_version==1
        else 'Continue pose; transparent.', 'actual_first_image')
    return rows


def compile_conditions(plan, stage_index, *, policy_version=1):
    if policy_version == 6:
        condition_rows(plan, stage_index, policy_version=6)
        return plan.stages[stage_index].prompt
    if policy_version in (3,4,5):
        from .executable_brief import compile_brief
        return compile_brief(plan,stage_index)
    if policy_version == 2: validate_text_limits(plan)
    rows = condition_rows(plan, stage_index, policy_version=policy_version)
    prompt = '\n'.join(f"{r['label']}: {r['text']}" for r in rows)
    if len(prompt) > LIMIT:
        counts = ', '.join(f"{r['label']}={len(r['text'])}" for r in rows)
        raise ValidationHarnessError(
            f'第 {stage_index+1} 段绘图条件共 {len(prompt)} 字符，超过 {LIMIT}。'
            '请去除重复表述，保留发力、支撑、轨迹、姿势和结构关系；不截断、不删除条件。' + counts)
    return prompt


def submission_conditions(binding, stage_index, prompt, first_sha256, last_sha256):
    """An audit of what was really sent, never a claim of visual compliance."""
    if not enabled(binding.plan, binding.generation_policy_version):
        return None
    version=binding.generation_policy_version
    expected = compile_conditions(binding.plan, stage_index, policy_version=version)
    if prompt != expected:
        raise ValidationHarnessError('冻结的绘图提示与当前方案条件不一致，尚未提交绘图')
    stage = binding.plan.stages[stage_index]
    return {
        'version': version, 'kind': 'text_and_images_not_pose_lock',
        'prompt_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
        'prompt_characters': len(prompt), 'rows': condition_rows(binding.plan, stage_index, policy_version=version),
        **({'review_only':['motion.entry','motion.exit','motion.holds.reason','quality.event_contract','quality.rhythm_contract']}
           if version==2 else {}),
        'first_sha256': first_sha256, 'last_sha256': last_sha256,
        'target_mode': 'image' if last_sha256 else 'text_only',
        'structure_usage': stage.structure_usage.model_dump(mode='json') if stage.structure_usage else None,
        'structure_sha256': binding.visual_structure['sha256'] if binding.visual_structure else None,
        **({'coverage_kind':'coordinator-authored brief; source fields are context, not verbatim copies'} if version in (3,4,5) else {}),
        **({'coverage_kind': 'approved coordinator fields assembled verbatim'} if version == 6 else {}),
    }


def planning_instructions(legacy, *, policy_version=1):
    """Select only for a new, frozen policy; never rewrite old task prompts."""
    if policy_version in (3, 6):
        if policy_version == 6:
            from .structured_brief import INSTRUCTIONS
        else:
            from .executable_brief import INSTRUCTIONS
        # Keep legacy string immutable. Remove conflicting length/compilation
        # advice only in this new policy, not by altering saved task data.
        start=legacy.index('Keep EACH contract field preferably')
        end=legacy.index('Per-stage prompts describe only',start)
        text=legacy[:start]+legacy[end:]
        start=text.index('Each pose description should be about')
        end=text.index('Every stage MUST have checkpoint:',start)
        text=text[:start]+text[end:]
        text=text.replace('Total compiled prompt, including this hint and key poses, must stay under 1000 characters.',
                          'The complete executable brief has its own 1000-character limit; analysis is not appended.')
        if policy_version == 6:
            text = text.replace('Prompts must\nbe self-contained, at most 1000 characters each, and include relevant identity/facing.',
                                'The assembled drawing brief must be self-contained and include the relevant identity and facing.')
        return text+'\n'+INSTRUCTIONS
    text = legacy.replace(
        'Keep EACH contract field preferably under 90 characters and each stage prompt under\n'
        '220 characters. They will ALL be compiled into each request (1000-character total cap).',
        'The exact drawing compiler is described below. Global event/rhythm prose remains\n'
        'planning/review context; do not replay the entire action in each segment.')
    text = text.replace(
        'Each pose description should be about 50-65 English characters; shorten stage.prompt\n'
        'to about 100-140 characters so the compiled request including poses stays under 1000.',
        'Use concise concrete key poses, about 25-40 English characters; avoid repeating\n'
        'the same pose as the endpoint. Keep each stage prompt near 60-90 characters.')
    text = text.replace(
        'generation_hint is a compact English drawing constraint of at most 140 characters,\n'
        'covering the highest-risk missing relations; full fields remain in the review contract.\n'
        'Total compiled prompt, including this hint and key poses, must stay under 1000 characters.',
        'generation_hint is for additional task-relevant visible relationships, not a replacement\n'
        'for drive/support/path. Those fields now reach drawing separately. Keep this hint concise.')
    text = text + '''
DRAWING CONDITIONS policy 1 (quality.version stays 4; same API, budget and review gates):
The drawing request includes EXACTLY: quality.appearance_contract; stage.prompt;
checkpoint.rhythm/endpoint; motion.camera/orientation/drive/support/trajectory/appearance;
boundary and declared holds; this stage's key_poses; generation_hint; final ending_contract.
Do not rely on a later summarizer to retain a field. All these strings together, labels
and boundary instructions MUST fit 1000 characters. Aim for at most 650 characters of
field text per stage, leaving room for labels and explicit holds; do not erase a required
relation to meet the limit. Each motion field should usually be 25-50 characters.
Use body-relative, observable changes: what leads, what follows, how support changes,
what moves along which path, and how momentum passes the boundary or settles. Preserve
intentional turns, airborne motion, flexible objects and user-requested holds. These
dimensions are not mandatory attack phases and do not imply physically verified joints.
Keep identity/count/material rules distinct from movement; a static mask or blade axis
does not define a future pose. Use checked structure for concrete task-relevant relations,
not redundant 'head remains attached' prose, universal planted feet or fixed coordinates.
Frame count and duration are quality choices, not billing savings: fewer frames within
one permitted drawing call save no calls. Allocate enough changing poses for the event
and follow-through. Do not crowd the event into two frames and spend the rest standing.
A moving boundary must continue through the join, not restart a wind-up or add a hold.
Actual end-target images are separate checked inputs. Planning cannot fabricate one,
choose an unrelated historical pose, or silently pay to create it. When none is bound,
the endpoint is TEXT ONLY, not a visual anchor. Preserve supplied/checked image conditions;
coordinate descriptions and structure observations never substitute for an actual PNG.
'''
    if policy_version == 2:
        import json
        text=text.replace('DRAWING CONDITIONS policy 1','DRAWING CONDITIONS policy 2')
        text+='\nDRAWING TEXT RESERVATIONS (hard character ceilings, repeated in the JSON schema):\n'+json.dumps(TEXT_LIMITS)
        text+='''
Write brief concrete phrases within EACH ceiling, not full sentences repeating other
fields. Preserve detailed reasoning in findings, requirements, acceptance and checkpoint
reason; brevity here does not waive those requirements. Keep 3-6 meaningful key poses;
their short labels complement explicit drive/support/path and the segment endpoints.
Hold reasons remain in the review contract; drawing receives their exact frame ranges.
All maximum-length fields, six poses and three hold ranges fit the provider text cap.
Never truncate a returned field or add a paid rewriting call. An invalid response stops.
'''
    return text


def validate_text_limits(plan):
    def check(value, kind):
        if value is None:raise ValidationHarnessError('绘图文字预算缺少 '+kind)
        for name,limit in TEXT_LIMITS[kind].items():
            if len(getattr(value,name))>limit:
                raise ValidationHarnessError(f'绘图文字预算：{kind}.{name} 超过 {limit} 字符；保留失败回执，不截断、不重试')
    check(plan.quality,'MotionQuality')
    for pose in plan.quality.key_poses:check(pose,'KeyPose')
    for stage in plan.stages:
        check(stage,'PlanStage');check(stage.checkpoint,'PoseCheckpoint');check(stage.motion,'MotionConstraints')


def bind_text_budget(schema_type):
    """Same verified transport shape, with explicit executable-field lengths."""
    class BudgetedPlan(schema_type):
        @classmethod
        def model_json_schema(cls,*args,**kwargs):
            schema=copy.deepcopy(schema_type.model_json_schema(*args,**kwargs))
            for kind,fields in TEXT_LIMITS.items():
                for name,limit in fields.items():schema['$defs'][kind]['properties'][name]['maxLength']=limit
            return schema

        @model_validator(mode='after')
        def bounded_text(self):
            plan=getattr(self,'proposal',None) or getattr(self,'plan',None)
            if plan and not plan.questions:
                try:validate_text_limits(plan)
                except ValidationHarnessError as exc:raise ValueError(str(exc)) from None
            return self
    return BudgetedPlan
