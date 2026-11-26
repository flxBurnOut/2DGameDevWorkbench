"""Bind a keyed generation command to its own native mutations and result revision."""
from contextvars import ContextVar

from .errors import ConflictError, HarnessError, NotFoundError, ValidationHarnessError


_active = ContextVar('native_generation_command', default=None)
_events = {f'generation_command_{state}' for state in ('received', 'preflight', 'progress', 'returned', 'interrupted', 'unknown', 'rejected')}


def _event(job, key):
    return next((row for row in reversed(job.events) if row.get('event') in _events and row.get('request_key') == key), None)


def _provider_rows(record, selected):
    rows = {}
    for candidate in record['candidates']:
        index = candidate['candidate_index']
        if selected is not None and index != selected:
            continue
        stages = (candidate.get('plan_execution') or candidate.get('attack_sequence') or {}).get('stages')
        sources = enumerate(stages) if stages else [(None, candidate)]
        for stage, source in sources:
            rows[index, stage] = {
                'candidate_index': index, 'stage_index': stage,
                'submission_attempts': source.get('submission_attempts', 0),
                'provider_job_id': source.get('provider_job_id'), 'usage': source.get('usage') or {},
            }
    return rows


def record_progress(job, before, after):
    """Called inside the owning writer's lock before publishing this exact revision."""
    active = _active.get()
    if active is None or job.job_id != active[0]:
        return
    identity = active[1]
    previous = _provider_rows(before, identity['candidate_index'])
    current = _provider_rows(after, identity['candidate_index'])
    changed = [row for key, row in current.items() if row != previous.get(key)]
    if changed:
        job.touch('generation_command_progress', **identity, result_revision=job.revision, evidence=changed)
    elif any(row.get('event') in {'generation_blocked_by_quota', 'generation_balance_unavailable'}
             and (identity['candidate_index'] is None or row.get('candidate_index') == identity['candidate_index'])
             for row in after['events'][len(before['events']):]):
        if _event(job, identity['request_key'])['event'] != 'generation_command_progress':
            job.touch('generation_command_preflight', **identity, result_revision=job.revision)


def _response(store, job, event):
    receipt = {key: event[key] for key in ('request_key', 'candidate_index', 'wait')}
    state = event['event'].removeprefix('generation_command_')
    # Older rejected records carried no proof that execution stopped before submission.
    if state == 'rejected' and event.get('submission_created') is not False:
        state = 'unknown'
    receipt.update(job_id=job.job_id, state=state)
    if 'error' in event:
        receipt['error'] = event['error']
    if state == 'rejected':
        receipt['submission_created'] = False
    data = {'generation_receipt': receipt}
    if 'result_revision' in event:
        receipt['revision'] = event['result_revision']
        snapshot = store.load_revision(job.job_id, receipt['revision'])
        data['job'] = snapshot.model_dump(mode='json')
        # Use only observations published by this command, even on a shared Job.
        observed = {}
        for row in snapshot.events:
            if row.get('event') == 'generation_command_progress' and row.get('request_key') == receipt['request_key']:
                for item in row['evidence']:
                    observed[item['candidate_index'], item['stage_index']] = item
        if observed:
            receipt['evidence'] = list(observed.values())
    return {'schema_version': 1, 'ok': True, 'data': data}


def lookup_generation(store, job_id, key):
    job = store.load(job_id)
    event = _event(job, key)
    if event is None:
        raise NotFoundError('generation command not found')
    return _response(store, job, event)


def run_keyed_generation(service, job_id, body):
    store = service.store
    store.load(job_id)
    identity = body.model_dump()
    with store.locked_job(job_id) as job:
        previous = _event(job, body.request_key)
        if previous:
            if any(previous.get(key) != value for key, value in identity.items()):
                raise ConflictError('generation command already used for different parameters')
        else:
            job.touch('generation_command_received', **identity)
    if previous:
        return _response(store, job, previous)

    scope = _active.set((job_id, identity))
    try:
        if body.candidate_index is not None and not any(c.candidate_index == body.candidate_index for c in job.candidates):
            raise ValidationHarnessError('candidate does not exist', details={'submission_created': False})
        result = service.generate_job(job_id, wait=body.wait, candidate_index=body.candidate_index)
    except Exception as exc:
        error = exc.message if isinstance(exc, HarnessError) else f'Native generation interrupted ({type(exc).__name__}).'
        with store.locked_job(job_id) as job:
            progress = next((row for row in reversed(job.events) if row.get('event') == 'generation_command_progress'
                             and row.get('request_key') == body.request_key), None)
            if progress:
                job.touch('generation_command_interrupted', **identity, result_revision=progress['result_revision'], error=error)
            elif isinstance(exc, HarnessError) and exc.details.get('submission_created') is False:
                last = _event(job, body.request_key)
                version = {'result_revision': last['result_revision']} if last['event'] == 'generation_command_preflight' else {}
                job.touch('generation_command_rejected', **identity, **version, submission_created=False, error=error)
            else:
                job.touch('generation_command_unknown', **identity, error=error)
    else:
        with store.locked_job(job_id) as job:
            job.touch('generation_command_returned', **identity, result_revision=result.revision)
    finally:
        _active.reset(scope)
    return _response(store, job, job.events[-1])
