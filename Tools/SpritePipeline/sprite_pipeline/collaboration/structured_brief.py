"""Assemble the approved drawing brief from the coordinator's plan fields."""
from __future__ import annotations

from pydantic import Field, ValidationError, model_validator
from pydantic.json_schema import SkipJsonSchema

from ..errors import ValidationHarnessError
from .contracts import CoordinatorTurn, MotionConstraints, PlanProposal, PlanStage, PoseCheckpoint


LIMIT = 1000


class DrawingStage(PlanStage):
    prompt: SkipJsonSchema[None] = Field(default=None, exclude=True)
    checkpoint: PoseCheckpoint
    motion: MotionConstraints


class DrawingPlan(PlanProposal):
    stages: list[DrawingStage] = Field(min_length=1, max_length=4)

    @model_validator(mode='after')
    def validate_drawing_text(self):
        problems = []
        for index in range(len(self.stages)):
            try:
                _compile(_rows(self, index))
            except ValidationHarnessError as exc:
                problems.append({'type': 'value_error', 'loc': ('stages', index),
                                 'input': None, 'ctx': {'error': ValueError(str(exc))}})
        if problems:
            raise ValidationError.from_exception_data(type(self).__name__, problems)
        return self


class StructuredCoordinatorTurn(CoordinatorTurn):
    plan: DrawingPlan | None = None


BOUNDARY = {'pass_through': 'Continue. ', 'settle': 'Settle. ', 'intentional_hold': 'Hold. '}


def _rows(plan, index):
    stage = plan.stages[index]
    motion, checkpoint = stage.motion, stage.checkpoint
    if motion is None or checkpoint is None:
        raise ValidationHarnessError('绘图说明缺少当前段的运动或检查点')
    start = sum(previous.frame_count for previous in plan.stages[:index])
    stop = start + stage.frame_count
    key_poses = plan.quality.key_poses if plan.quality else []
    local_poses = [f'f{pose.frame - start}: {pose.description}' for pose in key_poses if start < pose.frame <= stop]
    poses = '; '.join(local_poses) if local_poses else f'f{stage.frame_count}: use End pose'
    pose_sources = ['quality.key_poses'] if local_poses else ['checkpoint.endpoint']
    timing = checkpoint.rhythm
    if motion.holds:
        timing += '; hold ' + ','.join(f'{hold.start}-{hold.end}' for hold in motion.holds)
    return [
        ('Appearance', motion.appearance, ['motion.appearance']),
        ('Action', stage.goal, ['stage.goal']),
        ('Camera', motion.camera, ['motion.camera']),
        ('Facing', motion.orientation, ['motion.orientation']),
        ('Drive', motion.drive, ['motion.drive']),
        ('Support', motion.support, ['motion.support']),
        ('Path', motion.trajectory, ['motion.trajectory']),
        ('Timing', timing, ['checkpoint.rhythm', 'motion.holds']),
        ('Poses', poses, pose_sources),
        ('Relations', motion.generation_hint, ['motion.generation_hint', 'structure_usage']),
        ('End', checkpoint.endpoint, ['checkpoint.endpoint']),
        ('Boundary', BOUNDARY[motion.boundary] + motion.exit, ['motion.boundary', 'motion.exit']),
    ]


def _compile(rows):
    for label, text, _ in rows:
        if not text.strip() or text.splitlines() != [text]:
            raise ValidationHarnessError(f'{label} must be a single nonempty drawing line')
    prompt = '\n'.join(f'{label}: {text}' for label, text, _ in rows)
    if len(prompt) > LIMIT:
        lengths = ','.join(f'{label}={len(text)}' for label, text, _ in rows)
        raise ValidationHarnessError(f'{len(prompt)}/{LIMIT} total chars; {lengths}')
    return prompt


def materialize(turn):
    """Save the full prompt in the existing PlanStage, exactly as it will be sent."""
    response = turn.model_dump(mode='json')
    if turn.plan:
        for index, target in enumerate(response['plan']['stages']):
            target['prompt'] = _compile(_rows(turn.plan, index))
    return response


def coordinator_context(response):
    """Present a rejected saved plan to its coordinator in the new wire shape."""
    response = {key: value for key, value in response.items() if key in StructuredCoordinatorTurn.model_fields}
    if not response.get('plan'):
        return response
    stages = [{key: value for key, value in stage.items() if key != 'prompt'} for stage in response['plan']['stages']]
    return {**response, 'plan': {**response['plan'], 'stages': stages}}


def checked_rows(plan, stage_index):
    stage = plan.stages[stage_index]
    conditions = _rows(plan, stage_index)
    if _compile(conditions) != stage.prompt:
        raise ValidationHarnessError('冻结绘图说明与方案字段不一致')
    return [{'label': label, 'text': text, 'sources': sources} for label, text, sources in conditions]


INSTRUCTIONS = '''
EXECUTABLE DRAWING BRIEF policy 6. The application builds the provider text from
the approved plan fields. Use concise phrases in drawing inputs. Fields share
the 1000-character per-stage budget, including labels, boundary mode and exact
hold ranges. Brief camera or exit phrases leave room for essential action,
stance, grip and endpoint details. Keep detailed explanations in the evidence,
checkpoint reason and acceptance criteria. Use the user's language for the
stage goal and consistent wording across the fields used for drawing. Write
each drawing field and each pose description as one line.

Supply the concrete waypoints once under plan.quality.key_poses, with whole-clip
frame numbers. The application assigns poses to stages, labels them with local
frame numbers and preserves the original descriptions. If a stage has no
explicit pose, the drawing text references its ending checkpoint on its last
drawn frame.

Within each final stage:
- goal is the authoritative local transition from the actual input pose. Include
  the direction and exact number of this segment's events when specified. A
  short goal names the movement, while the motion fields give its mechanics.
- omit stage.prompt and any separate stage pose field.
- motion.appearance captures material, visible identity, ownership/grip and any
  appearance details that must persist in this segment.
- motion.camera, orientation, drive, support and trajectory describe observable
  mechanics. Keep body facing distinct from object projection and the camera.
- checkpoint.rhythm describes local timing across the actual drawn frame count.
  Enter exact hold ranges in motion.holds for the application to add.
- motion.generation_hint describes the task-relevant spatial relationships.
  When checked structure exists, express the relevant checked relationship here.
- checkpoint.endpoint gives this segment's visible endpoint. The final stage
  incorporates the user's requested finish.
- motion.exit describes how this pose continues through the join or settles.
Keep equipment and physical grip consistent across cues. Preserve specified
event counts, direction, landings, transitions, stable finishes and intentional
holds. Carry the user's complete task in the plan and review contract.
'''


STRATEGY_INSTRUCTIONS = '''
EXECUTABLE DRAWING BRIEF policy 6. Supply the strategy analysis in proposal.
Use stage.prompt for the local reasoning draft (up to 4000 characters). Follow
the strategy schema for both the outer response and each proposal stage.
Record detailed clip-level waypoints in proposal.quality.key_poses. The
coordinator uses these to finalize the original plan fields for drawing.
'''


OBSERVATION_INSTRUCTIONS = '''
EXECUTABLE DRAWING BRIEF policy 6. Follow the observation schema and provide
evidence in findings. The strategy and coordinator use these observations in
their subsequent planning turns.
'''
