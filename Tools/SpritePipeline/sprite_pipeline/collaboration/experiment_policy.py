"""Repair-tool restriction for paper ablations.

Only copies created by ``experiment.clone_for_arm`` carry a policy. Ordinary
works have no ``experiment`` marker and are never restricted.
"""
from ..errors import NotFoundError, ValidationHarnessError

REPAIR_POLICIES = ('toolset', 'redraw_only')
REFUSAL = '此实验副本只允许整段重画；确定性编辑、受限生成和段内重画已停用'


def experiment_for(service, work_id):
    from .workspace import OpenMotionWorkspace
    try:
        return OpenMotionWorkspace(service).load(work_id).experiment or {}
    except NotFoundError:
        return {}


def policy_for(service, work_id):
    return experiment_for(service, work_id).get('repair_policy', 'toolset')


def require_tool(service, job, level):
    """Check the tool policy and return the experiment which owns its budget."""
    plan = job.request.open_plan
    experiment = experiment_for(service, plan.work_id) if plan else {}
    if level != 'stage_redraw' and experiment.get('repair_policy') == 'redraw_only':
        raise ValidationHarnessError(REFUSAL)
    return experiment


def is_stage_redraw_range(context, start, end):
    """True when [start, end] covers the stage's largest legal even redraw window.

    When all editable frames are even (e.g., locked head and tail), every editable
    frame must be selected. When only frame 0 is locked on an even-length stage,
    editable frames are odd (N-1); PixelLab transition redraws require even counts
    (4..16), so the largest legal even span (N-2, anchored at either the first or
    last editable frame) qualifies as a whole-stage redraw.
    """
    editable = sorted(set(range(len(context['frames']))) - set(context['locked_frames']))
    selected = list(range(start, end + 1))
    if len(selected) < 4 or len(selected) % 2 != 0:
        return False
    if not editable:
        return False
    contiguous = editable == list(range(editable[0], editable[-1] + 1))
    if not contiguous:
        return selected == editable
    target_len = len(editable) if len(editable) % 2 == 0 else len(editable) - 1
    if target_len < 4 or len(selected) != target_len:
        return False
    return selected == editable[:target_len] or selected == editable[-target_len:]


def require_redraw_scope(service, work_id, body, context, methods):
    """Under ``redraw_only`` a generated alternative must redraw the stage's
    largest legal even editable window. Returns the methods the request may still use."""
    if policy_for(service, work_id) != 'redraw_only':
        return methods
    whole = is_stage_redraw_range(context, body.start, body.end)
    if body.stage_index is None or not whole or 'transition' not in methods or body.preserve_motion:
        raise ValidationHarnessError(REFUSAL)
    return ['transition']
