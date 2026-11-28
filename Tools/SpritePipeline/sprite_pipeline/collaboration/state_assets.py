"""Asset-library representations of frozen state images and accepted transitions."""
from ..errors import NotFoundError
from .checkpoints import Checkpoints
from .state_chain import state_images, transition


def chain_assets(job):
    binding = job.request.open_plan
    if not binding or binding.spec.object_type != 'interactable' or job.request.provider == 'fixture':
        return
    for candidate in job.candidates:
        if candidate.diagnostic_only:
            continue
        states = state_images(job, candidate)
        if len(states) < 2:
            continue
        index = candidate.candidate_index
        common = dict(
            jobId=job.job_id, candidateIndex=index, candidateCount=len(job.candidates),
            objectId=binding.spec.object_id, objectType='interactable', workId=binding.work_id,
            workRevision=binding.revision, planSha256=binding.plan_sha256,
            width=job.character.cell_width, height=job.character.cell_height,
        )
        for number, state in enumerate(states):
            stage = state['stage']
            identity = f'{job.job_id}:{index}:{number}'
            row = dict(
                common, id=f'motion-state:{identity}', kind='prop', motionSource='state',
                title=f'{job.character.display_name} · {state["name"]}', stageIndex=stage,
                stateName=state['name'], rawIndex=state.get('raw_index'),
                checkpointToken=state.get('token'), stateSha256=state['sha256'],
            )
            yield row, [state]
            if stage is None or state['transition_status'] != 'accepted':
                continue
            accepted = candidate.plan_execution.stages[stage].accepted
            edge = transition(binding.plan, stage)
            frames = accepted['frames']
            hold = binding.plan.quality.interactable.hold_frames if stage == len(binding.plan.stages) - 1 else 0
            row = dict(
                common, id=f'motion-transition:{identity}', kind='animation', motionSource='transition',
                title=f'{job.character.display_name} · {edge["from_state"]} → {edge["to_state"]}',
                stageIndex=stage, checkpointToken=accepted['token'], fromState=edge['from_state'],
                toState=edge['to_state'], inputSha256=accepted['input_sha256'], stateSha256=state['sha256'],
                rawIndex=state['raw_index'], frameCount=len(frames) + hold, fps=job.action.fps, loop=False,
            )
            yield row, frames + [frames[-1]] * hold


def catalog_rows(job):
    return [dict(row, previewPath=frames[-1]['path']) for row, frames in chain_assets(job)]


def resolve_asset(service, asset_id):
    parts = asset_id.split(':')
    if len(parts) != 4:
        raise NotFoundError('状态链资产编号无效')
    job = service.get_job(parts[1])
    for row, frames in chain_assets(job):
        if row['id'] != asset_id:
            continue
        stage = row['stageIndex']
        if stage is not None:
            Checkpoints(service).state_image(job, row['candidateIndex'], stage)
        paths = {}
        for i, frame in enumerate(frames):
            file = service.store.resolve_job_path(job.job_id, frame['path'])
            key = f'frame-{i}' if row['motionSource'] == 'transition' else 'source'
            paths[key] = (file, frame['sha256'])
        paths['preview'] = next(reversed(paths.values()))
        return row, paths
    raise NotFoundError('此候选没有所选的已确认状态图或过渡')
