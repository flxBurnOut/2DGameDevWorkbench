"""Compile shared motion contracts and preserve auditable playback mappings."""
from __future__ import annotations
from ..errors import ValidationHarnessError
from ..attack_timeline import is_context_frame


def compiled_prompt(plan, character, stage_index, *, policy_version=None):
    if policy_version in (1,2,3,4,5,6):
        from .generation_conditions import compile_conditions
        return compile_conditions(plan, stage_index, policy_version=policy_version)
    stage = plan.stages[stage_index]
    if not plan.quality:
        return stage.prompt  # Immutable v1 tasks retain their original execution.
    q = plan.quality
    if q.version >= 4:
        # Global narrative belongs to planning/review, never to every drawing call.
        # In particular, a preparatory segment must not execute later events.
        parts = [f'Appearance: {q.appearance_contract}',
                 f'Current transition only: {stage.prompt}',
                 f'Timing: {stage.checkpoint.rhythm}',
                 f'End pose: {stage.checkpoint.endpoint}',
                 'Continue the supplied input pose. Transparent background.']
    else:
        parts = [f'Context (not repeated): {q.event_contract}',
             f'Always: {q.appearance_contract}' + (f' Side camera, face {character.facing}.' if character.object_type == 'character' else ''),
             f'ONLY segment {stage_index + 1}/{len(plan.stages)}: {stage.prompt}',
             f'Timing: {stage.checkpoint.rhythm if stage.checkpoint else q.rhythm_contract}',
             'Continue input; no repeated events. Transparent.']
    if stage.checkpoint and q.version < 4:
        parts.append(f'End this segment at: {stage.checkpoint.endpoint}')
    if stage_index == len(plan.stages) - 1:
        parts.append(f'Final settling: {q.ending_contract}')
    start=sum(s.frame_count for s in plan.stages[:stage_index])
    poses=[f'{p.frame-start}: {p.description}' for p in q.key_poses if start<p.frame<=start+stage.frame_count]
    if poses:parts.append('Key poses (approx.): '+'; '.join(poses))
    if q.version >= 4 and stage.motion:
        parts.append('Motion: '+stage.motion.generation_hint)
    result = '\n'.join(parts)
    if len(result) > 1000:
        raise ValidationHarnessError(f'第 {stage_index+1} 段完整提示词为 {len(result)} 字符，超过 1000；缩短表达但保留动作和装备约束，尚未调用 PixelLab')
    return result


def validate_quality_plan(plan, spec, character, *, require_checkpoints=False, policy_version=None):
    if plan.quality is None:
        raise ValidationHarnessError('方案缺少通用动作质量合同：事件次数/方向、装备连续性、结束状态、节奏及三项验收标准')
    if len(plan.quality.key_poses)<3:
        raise ValidationHarnessError('请给出至少三个具体可见的关键姿势和大致帧位置，覆盖准备、关键事件与结束；不能只重复动作动词')
    if require_checkpoints and plan.quality.version < 3:
        raise ValidationHarnessError('新方案须使用带实际姿势检查点的质量版本，为每段提供末姿势与局部节奏')
    if require_checkpoints and plan.quality.version >= 4 and any(s.motion is None for s in plan.stages):
        raise ValidationHarnessError('新方案须补充通用运动与外观约束，包括朝向、支撑、发力、轨迹与边界节奏')
    for i in range(len(plan.stages)):
        compiled_prompt(plan, character, i, policy_version=policy_version)
    if spec.timing_mode == 'fixed' and plan.quality.playback_fps != spec.fps:
        raise ValidationHarnessError('用户固定了播放 FPS，方案不得更改')


def assemble_quality_frames(raw, stages, reference):
    """Remove only a verified extra input frame. Never delete an actual pose."""
    combined, timeline, mapping = [], [], []
    for i, (frames, stage) in enumerate(zip(raw, stages)):
        context = reference if i == 0 else raw[i-1][-1]
        remove = len(frames) == stage.frame_count + 1 and is_context_frame(frames[0], context)
        indices = list(range(1 if remove else 0, len(frames)))
        timeline.append({'name': stage.name, 'start': len(combined), 'count': len(indices),
                         'raw_count': len(frames), 'context_removed': remove, 'technical_only': True})
        for n in indices:
            mapping.append({'frame': len(combined), 'stage': i, 'raw_frame': n})
            combined.append(frames[n])
    return combined, timeline, mapping
