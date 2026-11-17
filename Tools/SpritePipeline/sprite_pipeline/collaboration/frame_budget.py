"""Planning-time estimate. PixelLab rounds each submission independently."""
from ..errors import HarnessError
from ..service import SpritePipelineService


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
