"""Planning-time estimate. PixelLab rounds each submission independently."""
from ..errors import HarnessError, ValidationHarnessError
from ..service import SpritePipelineService
from .contracts import review_calls_per_check


def minimum_stage_count(spec):
    return spec.interactable_skeleton.transitions() if spec.interactable_skeleton else 1


def require_minimum_budget(spec):
    budget = spec.budget
    stages = minimum_stage_count(spec)
    draws = stages * spec.candidate_count
    reviews = (stages + 1) * spec.candidate_count * review_calls_per_check(spec)
    missing = []
    if budget.max_generation_calls < draws:
        missing.append(f'至少需要 {draws} 次生成')
    if budget.max_total_frames is not None and budget.max_total_frames < 4 * draws:
        missing.append(f'至少需要 {4 * draws} 帧')
    if spec.provider != 'fixture' and budget.max_review_calls < reviews:
        missing.append(f'至少需要 {reviews} 次视觉额度（逐段检查和整段复核）')
    if missing:
        raise ValidationHarnessError('；'.join(missing) + '。尚未调用规划模型，请先调整预算')


def minimum_drawing_problem(work):
    limits = work.frame_budget
    draws = minimum_stage_count(work.spec) * work.spec.candidate_count
    if limits['max_frames_per_request'] < 4 or limits['max_total_frames'] < 4 * draws:
        return f'绘图额度或帧数上限不足，当前需求至少需要 {draws} 次生成、合计 {4 * draws} 帧；尚未调用规划模型'
    remaining = limits['remaining_units']
    if remaining is not None:
        units = SpritePipelineService._pixellab_generation_units(
            work.character['cell_width'], work.character['cell_height'], 4) * draws
        if remaining < units:
            return f'逐次计费至少需要 {units} 单位，余额 {remaining}；尚未调用规划模型'
    return None


def planning_limits(service, work):
    budget = work.spec.budget
    count = work.spec.candidate_count
    remaining = checked_at = None
    if work.spec.provider == 'pixellab':
        try:
            snapshot = service.refresh_pixellab_balance()
            # The subscription only bounds the plan when there is no credit fallback.
            if not service._available_credit(snapshot):
                remaining = service._remaining_generations(snapshot)
            checked_at = snapshot.get('checked_at')
        except (HarnessError, OSError):
            pass  # A failed read does not grant units or cancel the user's frame limits.
    per_request = budget.max_frames_per_request or 16
    total = budget.max_total_frames or 64 * count
    if remaining is not None:
        width, height = work.character['cell_width'], work.character['cell_height']
        affordable = [n for n in range(4, per_request + 1, 2)
                      if service._pixellab_generation_units(width, height, n) * count <= remaining]
        per_request = max(affordable, default=0)
        # Upper bound only. Final validation includes per-request rounding.
        total = max((n for n in range(1, total + 1)
                     if service._pixellab_generation_units(width, height, n) <= remaining), default=0)
    return dict(remaining_units=remaining, checked_at=checked_at, max_frames_per_request=per_request,
                max_total_frames=total, estimated_units=None)


def plan_cost(work, plan):
    limits = work.frame_budget
    counts = [s.frame_count for s in plan.stages]
    candidates = work.spec.candidate_count
    units = sum(SpritePipelineService._pixellab_generation_units(
        work.character['cell_width'], work.character['cell_height'], n) for n in counts) * candidates
    problem = None
    if max(counts) > limits['max_frames_per_request'] or sum(counts) * candidates > limits['max_total_frames']:
        problem = f"方案超出绘图帧数上限：每次最多 {limits['max_frames_per_request']} 帧，所有候选合计最多 {limits['max_total_frames']} 帧。"
    elif limits['remaining_units'] is not None and units > limits['remaining_units']:
        problem = f"按每次提交分别计费，方案预计 {units} 单位，余额 {limits['remaining_units']}。"
    return units, problem
