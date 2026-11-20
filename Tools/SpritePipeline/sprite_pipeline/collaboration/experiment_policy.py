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


def require_redraw_scope(service, work_id, body, context, methods):
    """Under ``redraw_only`` a generated alternative must redraw every editable
    frame of one segment. Returns the methods the request may still use."""
    if policy_for(service, work_id) != 'redraw_only':
        return methods
    editable = set(range(len(context['frames']))) - set(context['locked_frames'])
    whole = editable == set(range(body.start, body.end + 1))
    if body.stage_index is None or not whole or 'transition' not in methods or body.preserve_motion:
        raise ValidationHarnessError(REFUSAL)
    return ['transition']
