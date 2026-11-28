"""Read the named states of a prop directly from its frozen plan and checkpoints."""
from .contracts import prop_contract


def transition(plan, stage):
    prop = prop_contract(plan)
    if not prop:
        return None
    # An intermediate state is already named by its required visible checkpoint.
    # Derive both sides from one boundary, including for historical frozen plans.
    names = [prop.initial_state, *(s.checkpoint.endpoint for s in plan.stages[:-1]), prop.target_state]
    return {'from_state': names[stage], 'to_state': names[stage + 1]}


def confirmed_state(plan, stage, run):
    if run.state == 'accepted' and run.accepted:
        # The final playback hold and any excluded tail are never state sources.
        source = run.accepted['frames'][-1]
        frame = len(run.accepted['frames']) - 1
        token = run.accepted['token']
    elif run.state_checkpoint:
        source = run.state_checkpoint
        frame, token = source['frame'], source['token']
    else:
        return None
    return {**source, 'name': transition(plan, stage)['to_state'], 'stage': stage,
            'frame': frame, 'token': token, 'transition_status': run.state}


def state_images(job, candidate):
    plan = job.request.open_plan.plan
    prop = prop_contract(plan)
    if not prop or not candidate.plan_execution:
        return []
    states = [{'name': prop.initial_state, 'path': 'input/reference.png',
               'sha256': job.reference_sha256, 'stage': None}]
    for stage, run in enumerate(candidate.plan_execution.stages):
        state = confirmed_state(plan, stage, run)
        if state is None:
            break
        states.append(state)
    return states


def confirmed_playback_hold(job, candidate):
    binding, execution = job.request.open_plan, candidate.plan_execution
    if not binding or not execution or not execution.stages:
        return 0
    prop = prop_contract(binding.plan)
    count = prop.hold_frames if prop else 0
    frames, mapping = candidate.frames, execution.frame_mapping
    if not 0 < count < len(frames) or len(mapping) != len(frames):
        return 0
    end = confirmed_state(binding.plan, len(execution.stages) - 1, execution.stages[-1])
    if not end or end['transition_status'] != 'accepted':
        return 0
    if any(frame.sha256 != end['sha256'] for frame in frames[-count - 1:]):
        return 0
    return count if all(row.get('playback_hold') for row in mapping[-count:]) else 0
