"""Reproduce native recovery write windows and version-bound frame previews."""
import hashlib
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sprite_pipeline import store as job_store
from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.adjustments import Adjustments
from sprite_pipeline.collaboration.checkpoints import Checkpoints
from sprite_pipeline.collaboration.contracts import adjustment_source_token
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration import execution_authorization, stage_media
from sprite_pipeline.collaboration.targets import save_target, target_set_hash
from sprite_pipeline.collaboration.workspace import OpenMotionWorkspace
from sprite_pipeline.errors import ConflictError
from sprite_pipeline.jsonio import atomic_write_json, read_json
from sprite_pipeline.providers.base import PollResult, PollStatus
from sprite_pipeline.recovery import RecoveryWorker
from sprite_pipeline.service import SpritePipelineService
from test_open_motion import ready, setup, spec
from test_open_motion_checkpoints import CheckpointPlanner, prepared


def reopened(fixture, planner):
    service = SpritePipelineService(fixture.root)
    service.open_motion_model = planner
    return service, OpenMotionWorkspace(service)


@pytest.mark.parametrize('legacy_record', [False, True])
def test_automatic_ready_recovers_original_authorization(setup, monkeypatch, legacy_record):
    service, workspace, planner, provider, fixture = setup
    work = workspace.create(spec(), uuid.uuid4().hex, planning_authorized=True, auto_execute=True)
    with monkeypatch.context() as fault:
        def interrupted(*args, **kwargs):
            raise OSError('stopped after ready was saved')

        fault.setattr(workspace, 'start', interrupted)
        with pytest.raises(OSError, match='after ready'):
            workspace.plan(work.id)
    saved = workspace.load(work.id)
    assert saved.status == 'ready' and saved.execution_intent.phase == 'authorized'
    assert not service.list_jobs() and not provider.requests
    if legacy_record:
        saved.execution_intent = None
        workspace.save(saved)

    provider.pending = True
    restarted, recovered = reopened(fixture, planner)
    for _ in range(3):
        assert not recovered.recover_planning()['errors']
        restarted.recover_pending_jobs()
    current = recovered.load(work.id)
    assert current.revision == 1 and current.execution_intent.phase == 'active'
    assert current.execution_intent.authorization == 'automatic'
    assert [row['job_id'] for row in restarted.list_jobs()] == [current.job_id]
    assert len(planner.calls) == 4 and len(provider.requests) == 1


@pytest.mark.parametrize('boundary', ['before_job_pointer', 'before_binding', 'after_binding', 'after_enabling', 'legacy_binding'])
def test_recovery_preserves_job_across_start_writes(setup, monkeypatch, boundary):
    service, workspace, planner, provider, fixture = setup
    work = ready(workspace)
    target = fixture.write_sequence(fixture.root / 'target', shifts=(7,))[0].read_bytes()
    work = save_target(workspace, work.id, 1, 0, target, '核对现有目标姿势')
    original_save = workspace.save

    def crash_on_work_save(value):
        if value.job_id and (boundary == 'before_binding' or value.execution_intent.phase == 'active'):
            raise OSError('interrupted at Work publication')
        original_save(value)

    def crash_before_freeze(*args, **kwargs):
        raise OSError('interrupted before freezing targets')

    write_job = job_store.atomic_write_json

    def crash_after_journal(path, payload):
        if path.name == 'job.json':
            raise OSError('interrupted publishing Job pointer')
        write_job(path, payload)

    with monkeypatch.context() as fault:
        if boundary in {'after_binding', 'legacy_binding'}:
            fault.setattr(execution_authorization, 'freeze_targets', crash_before_freeze)
        elif boundary == 'before_job_pointer':
            fault.setattr(job_store, 'atomic_write_json', crash_after_journal)
        else:
            fault.setattr(workspace, 'save', crash_on_work_save)
        with pytest.raises(OSError, match='interrupted'):
            workspace.start(work.id, 1, work.plan_sha256, expected_targets=target_set_hash(work.end_targets))

    registered, = service.list_jobs()
    job_id = registered['job_id']
    if boundary != 'after_enabling':
        assert service.get_job(job_id).generation_requested_at is None
        service.recover_pending_jobs()
        assert not provider.requests
    if boundary == 'legacy_binding':
        legacy = workspace.load(work.id)
        legacy.execution_intent = None
        workspace.save(legacy)

    provider.pending = True
    restarted, recovered = reopened(fixture, planner)
    for _ in range(3):
        assert not recovered.recover_planning()['errors']
        restarted.recover_pending_jobs()
    current = recovered.load(work.id)
    assert current.job_id == job_id
    assert current.execution_intent.phase == 'active'
    assert (restarted.store.job_dir(job_id) / 'targets' / work.end_targets[0].filename).read_bytes() == target
    assert [row['job_id'] for row in restarted.list_jobs()] == [job_id]
    assert len(provider.requests) == 1
    assert provider.requests[0].last_frame == target


def test_recovery_respects_pause_and_keeps_unapproved_ready(setup, monkeypatch):
    service, workspace, planner, provider, fixture = setup
    waiting = ready(workspace)
    work = ready(workspace)
    with monkeypatch.context() as fault:
        def crash(*args, **kwargs):
            raise OSError('stopped before targets were frozen')

        fault.setattr(execution_authorization, 'freeze_targets', crash)
        with pytest.raises(OSError):
            workspace.start(work.id, 1, work.plan_sha256)
    paused = workspace.pause(work.id, 1)
    assert paused.execution_intent.phase == 'paused'

    restarted, recovered = reopened(fixture, planner)
    assert not recovered.recover_planning()['errors']
    restarted.recover_pending_jobs()
    assert recovered.start(work.id, 1, work.plan_sha256).execution_intent.phase == 'paused'
    assert not restarted.get_job(paused.job_id).generation_requested_at
    assert recovered.load(waiting.id).job_id is None
    assert not provider.requests

    resumed = recovered.pause(work.id, 1, resume=True)
    assert resumed.job_id == paused.job_id and resumed.execution_intent.phase == 'active'
    provider.pending = True
    restarted.recover_pending_jobs()
    assert len(provider.requests) == 1


def test_changed_target_blocks_recovery_until_original_is_restored(setup, monkeypatch):
    service, workspace, planner, provider, fixture = setup
    work = ready(workspace)
    target = fixture.write_sequence(fixture.root / 'target', shifts=(7,))[0].read_bytes()
    work = save_target(workspace, work.id, 1, 0, target, '核对现有目标姿势')
    with monkeypatch.context() as fault:
        def crash(*args, **kwargs):
            raise OSError('stopped before target freeze')

        fault.setattr(execution_authorization, 'freeze_targets', crash)
        with pytest.raises(OSError):
            workspace.start(work.id, 1, work.plan_sha256)
    job_id = workspace.load(work.id).job_id

    target_path = workspace.directory(work.id) / work.end_targets[0].filename
    target_path.write_bytes(workspace.reference(work))
    restarted, recovered = reopened(fixture, planner)
    scan = recovered.recover_planning()
    assert scan['errors'][0]['work_id'] == work.id and scan['errors'][0]['phase'] == 'execution'
    blocked = recovered.load(work.id)
    assert '图片发生变化' in blocked.execution_intent.activation_error['message']
    restarted.recover_pending_jobs()
    assert not provider.requests and restarted.get_job(job_id).generation_requested_at is None

    target_path.write_bytes(target)
    assert not recovered.recover_planning()['errors']
    resumed = recovered.load(work.id)
    assert resumed.execution_intent.phase == 'active' and resumed.execution_intent.activation_error is None
    assert resumed.job_id == job_id


def test_bad_records_do_not_block_healthy_recovery(setup):
    service, workspace, planner, _, _ = setup
    invalid = workspace.create(spec(), uuid.uuid4().hex, planning_authorized=True)
    good = workspace.create(spec(), uuid.uuid4().hex, planning_authorized=True)
    bad_work_path = workspace.directory(invalid.id) / 'work.json'
    bad_work = read_json(bad_work_path)
    bad_work['visual_structure'] = {'version': 1, 'sha256': 'f' * 64}
    atomic_write_json(bad_work_path, bad_work)

    adjustments = Adjustments(service)
    bad_task_id, good_task_id = uuid.uuid4().hex, uuid.uuid4().hex
    bad_task_path = adjustments.root(invalid.id) / bad_task_id / 'task.json'
    atomic_write_json(bad_task_path, {'state': 'queued'})
    adjustments.save({'id': good_task_id, 'work_id': good.id, 'state': 'planning', 'revision': 1,
                      'candidate': 1, 'stage': None, 'created_at': good.created_at,
                      'planning_calls': [], 'generation_calls': [], 'review_calls': []})

    worker = RecoveryWorker(service)
    worker._scan_motion('planning', workspace.recover_planning)
    worker._scan_motion('adjustments', adjustments.recover)
    state = worker.snapshot()
    assert state['planning']['last_scan']['errors'][0]['work_id'] == invalid.id
    assert state['adjustments']['last_scan']['errors'][0]['adjustment_id'] == bad_task_id
    assert state['planning']['last_success_at'] and state['adjustments']['last_success_at']
    assert workspace.load(good.id).status == 'ready' and len(planner.calls) == 4
    assert adjustments.load(good.id, good_task_id)['state'] == 'unknown'
    assert read_json(bad_work_path) == bad_work and read_json(bad_task_path) == {'state': 'queued'}

    client = TestClient(create_api(service=service))
    listing = client.get('/v1/open-motion').json()
    assert [entry['id'] for entry in listing['works']] == [good.id]
    assert listing['invalid_works'][0]['work_id'] == invalid.id


def test_generate_receipt_uses_effective_snapshots_during_revise(setup, monkeypatch):
    service, workspace, _, _, _ = setup
    workspace.model = service.open_motion_model = CheckpointPlanner()
    work = ready(workspace)
    start = execution_authorization.ExecutionAuthorization.start

    def publish_new_version(execution, *args, **kwargs):
        effective_work, effective_job = start(execution, *args, **kwargs)
        with service.store.locked_job(effective_job.job_id) as later:
            later.candidates[0].plan_execution.quality_review['state'] = 'running'
        workspace.revise(work.id, 1, spec('修订要求并保存为第二版'), uuid.uuid4().hex, planning_authorized=True)
        return effective_work, effective_job

    monkeypatch.setattr(execution_authorization.ExecutionAuthorization, 'start', publish_new_version)
    client = TestClient(create_api(service=service))
    response = client.post(f'/v1/open-motion/{work.id}/generate', json={
        'expected_revision': 1, 'plan_sha256': work.plan_sha256,
    })
    assert response.status_code == 200, response.text
    result = response.json()
    receipt = result['command_receipt']
    assert result['revision'] == receipt['work_revision'] == 1
    assert result['latest_revision'] == receipt['current_revision'] == 2
    assert result['job']['job_id'] == receipt['job_id']
    assert result['job']['revision'] == receipt['job_revision'] < service.get_job(receipt['job_id']).revision
    assert result['job']['candidates'][0]['quality_review']['state'] == 'pending'
    assert client.get(f'/v1/open-motion/{work.id}').json()['job'] is None


def test_request_lookup_keeps_original_revision_after_further_changes(setup):
    service, workspace, _, _, _ = setup
    work = ready(workspace)
    key = uuid.uuid4().hex
    prior_spec = spec('明确要求继续试验第二版')
    workspace.revise(work.id, 1, prior_spec, key, planning_authorized=True)
    work = workspace.plan(work.id)
    work = workspace.start(work.id, 2, work.plan_sha256)
    workspace.revise(work.id, 2, spec('明确要求保留第三版规划'), uuid.uuid4().hex, planning_authorized=True)

    client = TestClient(create_api(service=service))
    route = f'/v1/open-motion/{work.id}'
    result = client.get(f'{route}/requests/{key}').json()
    assert result['revision'] == 2 and result['current_revision'] == 3
    assert result['job']['job_id'] == work.job_id
    job_key = service.get_job(work.job_id).request.request_key
    assert client.get(f'/v1/jobs/requests/{job_key}').json()['data']['job']['job_id'] == work.job_id
    assert client.get('/v1/jobs/requests/unknown-key').status_code == 404
    request = {'expected_revision': 1, 'spec': prior_spec.model_dump(mode='json'),
               'request_key': key, 'planning_authorized': True}
    assert client.post(f'{route}/revise', json=request).json()['revision'] == 2
    assert client.post(f'{route}/revise', json={**request, 'expected_revision': 2}).status_code == 409


@pytest.mark.parametrize('count', [4, 8, 16])
def test_preview_reads_only_selected_frame_after_manifest(setup, monkeypatch, count):
    service, workspace, _, provider, fixture = setup

    class SizedPlanner(CheckpointPlanner):
        def __call__(self, *args, **kwargs):
            response, receipt = super().__call__(*args, **kwargs)
            if response['action'] == 'finalize':
                response['plan']['stages'][0]['frame_count'] = count
            return response, receipt

    service.open_motion_model = workspace.model = SizedPlanner()
    work = ready(workspace)
    work = workspace.start(work.id, 1, work.plan_sha256)
    images = [path.read_bytes() for path in fixture.write_sequence(fixture.root / 'sized', shifts=tuple(range(count)))]

    def poll(job_id):
        return PollResult(provider='fixture', provider_job_id=job_id, status=PollStatus.completed,
                          provider_status='completed', images=images, diagnostic_only=True)

    monkeypatch.setattr(provider, 'poll', poll)
    engine = PlanGeneration(service)
    engine.advance(work.job_id, provider, wait=True)
    folder = engine.directory(work.job_id, 1, 0)
    read = Path.read_bytes
    frame_reads = []

    def counted(path):
        if path.parent == folder and path.name.startswith('frame_'):
            frame_reads.append(path)
        return read(path)

    monkeypatch.setattr(Path, 'read_bytes', counted)
    client = TestClient(create_api(service=service))
    route = f'/v1/open-motion/{work.id}/candidates/1/stages/0'
    evidence = client.get(route).json()
    assert evidence['media_manifest_version'] == 1
    assert len(frame_reads) == count  # Cold cache verifies the original sequence once.
    frame_reads.clear()
    for n, image in enumerate(images):
        result = client.get(f'{route}/frames/{n}', params={
            'revision': 1, 'token': evidence['token'], 'expected_sha256': evidence['frames'][n]['sha256'],
        })
        assert result.status_code == 200 and result.content == image
    assert len(frame_reads) == count


def test_stage_media_detects_stale_tokens_missing_and_changed_bytes(setup, monkeypatch):
    service, _, provider, work = prepared(setup)
    engine = PlanGeneration(service)
    engine.advance(work.job_id, provider, wait=True)
    folder = engine.directory(work.job_id, 1, 0)
    client = TestClient(create_api(service=service))
    route = f'/v1/open-motion/{work.id}/candidates/1/stages/0'
    old = client.get(route).json()
    frame = folder / 'frame_000.png'
    original = frame.read_bytes()
    params = {'revision': 1, 'token': old['token'], 'expected_sha256': old['frames'][0]['sha256']}
    legacy_adjustment = adjustment_source_token(service.get_job(work.job_id), 1, old['token'])
    for token in (old['token'], legacy_adjustment):
        assert client.get(f'{route}/frames/0', params={'revision': 1, 'legacy_token': token}).content == original
    changed = (folder / 'frame_001.png').read_bytes()
    frame.write_bytes(changed)
    assert client.get(f'{route}/frames/0', params=params).status_code == 409
    assert client.get(f'{route}/frames/1', params={'revision': 1, 'token': old['token']}).content == changed
    with pytest.raises(ConflictError, match='原始帧已改变'):
        Checkpoints(service).decide(work.job_id, 1, 0, token=old['token'], note='实际核对后确认', decision='accept', acknowledge=True)
    frame.unlink()
    assert client.get(f'{route}/frames/0', params=params).status_code == 404
    frame.write_bytes(original)

    manifest_path = folder / 'frames.json'
    raw = read_json(manifest_path)
    atomic_write_json(manifest_path, {**raw, 'usage': {'units': 500}})
    assert client.get(f'{route}/frames/0', params=params).status_code == 409
    atomic_write_json(manifest_path, raw)

    cached_path, = (folder / 'media').glob('*.json')
    cached = read_json(cached_path)
    atomic_write_json(cached_path, {**cached, 'work_revision': 2})
    assert client.get(f'{route}/frames/0', params=params).content == original
    assert read_json(cached_path) == cached
    cached_path.write_text('broken cache', encoding='utf-8')
    frame.write_bytes(changed)
    assert client.get(f'{route}/frames/0', params=params).status_code == 409
    assert cached_path.read_text(encoding='utf-8') == 'broken cache'
    frame.write_bytes(original)

    def cache_io(path):
        if path == cached_path:
            raise OSError('unavailable derived index')
        return read_json(path)

    with monkeypatch.context() as io_failure:
        io_failure.setattr(stage_media, 'read_json', cache_io)
        io_failure.setattr(stage_media, 'atomic_write_json', lambda *_: cache_io(cached_path))
        assert client.get(f'{route}/frames/0', params=params).content == original
    assert client.get(f'{route}/frames/0', params=params).content == original
    assert read_json(cached_path) == cached

    path = folder / 'locally-repaired.png'
    path.write_bytes(changed)
    relative = path.relative_to(service.store.job_dir(work.job_id)).as_posix()
    with service.store.locked_job(work.job_id) as job:
        run = job.candidates[0].plan_execution.stages[0]
        run.active_frames = [{**old['frames'][0], 'path': relative, 'sha256': hashlib.sha256(changed).hexdigest()}, *old['frames'][1:]]
        run.review = None
    assert client.get(f'{route}/frames/0', params=params).status_code == 409
    new = client.get(route).json()
    assert new['token'] != old['token']
    assert client.get(f'{route}/frames/0', params={'revision': 1, 'token': new['token']}).content == changed
