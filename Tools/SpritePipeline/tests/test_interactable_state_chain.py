"""Two offline requests replay slices of one archived lamp clip. Decisions are scripted."""
from dataclasses import replace
from hashlib import sha256
import json
import base64

import pytest
from fastapi.testclient import TestClient

from test_interactable_motion import ARCHIVE, PropPlanner, workspace_for
from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.contracts import TaskSpec
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.errors import ConflictError
from sprite_pipeline.providers.fixture import FixtureProvider

A = 'Grey lamp face'
B = 'Partially illuminated lamp face'
C = 'Fully illuminated green lamp face'


class LampPlanner(PropPlanner):
    def __call__(self, role, work, reference, **kwargs):
        result, receipt = super().__call__(role, work, reference, **kwargs)
        if role == 'coordinator':
            plan = result['plan']
            quality = plan['quality']
            quality.update(event_contract=work.spec.description, appearance_contract='Keep the housing fixed.',
                           ending_contract=C, rhythm_contract='Light the lens in two steps.')
            quality['interactable'].update(initial_state=A, target_state=C, endpoint=C)
            stage = plan['stages'][0]
            stage.update(frame_count=4, name='Begin illumination', goal=B, prompt='Begin lighting the grey lens.')
            stage['checkpoint']['endpoint'] = B
            plan['stages'].append({**stage, 'first_frame': 'previous_end', 'name': 'Finish illumination',
                                   'goal': C, 'prompt': 'Finish lighting the lens and settle at green.',
                                   'checkpoint': {**stage['checkpoint'], 'endpoint': C}})
        return result, receipt


class ArchiveProvider(FixtureProvider):
    diagnostic_only = False  # Exercise production review with the scripted registry.

    def __init__(self):
        super().__init__()
        self.inputs = []
        self.outputs = {}
        self.end_targets = []
        self.archive = [p.read_bytes() for p in sorted((ARCHIVE/'lamp/seed-2202').glob('f*.png'))]

    def submit(self, request):
        receipt = super().submit(request)
        frames = [self.archive[:5], self.archive[3:8]][len(self.inputs)]
        self.inputs.append(request.reference_image)
        self.end_targets.append(request.last_frame)
        self.outputs[receipt.provider_job_id] = frames
        return replace(receipt, diagnostic_only=False)

    def wait(self, identity):
        return replace(super().wait(identity), images=self.outputs[identity], diagnostic_only=False)


@pytest.fixture
def chain(tmp_path, monkeypatch, request):
    service, ws = workspace_for(tmp_path, 'lamp', seed=2202)
    ws.model = LampPlanner('lamp')
    provider = ArchiveProvider()
    monkeypatch.setattr('sprite_pipeline.providers.get_provider', lambda *args: provider)
    spec = TaskSpec(object_type='interactable', object_id='lamp', provider='fixture',
                    description='Light the grey lens in two steps, from partly lit to fully green.')
    work = ws.create(spec, 'offline-lamp-chain', planning_authorized=True)
    plan = ws.plan(work.id)
    assert plan.status == 'ready', plan.message
    if getattr(request, 'param', None) == 'catalog':
        # Replay a frozen v3 production plan in an isolated store. The archive
        # provider above supplies every byte. Fixture jobs never enter the catalog.
        plan.spec.provider = 'pixellab'
        ws.save(plan)
    work = ws.start(work.id, plan.revision, plan.plan_sha256)
    engine = PlanGeneration(service)
    engine.advance(work.job_id, provider, wait=True)
    return service, work, engine, provider, TestClient(create_api(service=service), base_url='http://testserver/v1/open-motion/'+work.id+'/')


def decide(client, stage, decision, frame=None):
    evidence = client.get(f'candidates/1/stages/{stage}').json()
    body = dict(expected_revision=1, candidate_index=1, stage_index=stage, token=evidence['token'],
                decision=decision, note='Scripted archive decision', acknowledge_warnings=True,
                anchor_frame=frame, acknowledge_trim=True)
    response = client.post('review-stage', json=body)
    assert response.status_code == 200, response.text
    return response.json()['job']['candidates'][0]['state_chain']


def test_archive_chain_from_selected_pixels_to_next_request(chain):
    service, work, engine, provider, client = chain
    source = (ARCHIVE/'lamp/A.png').read_bytes()
    assert provider.inputs == [source]
    stages = 'candidates/1/stages/'
    view = client.get(stages+'0').json()
    assert view['transition'] == {'from_state': A, 'to_state': B}
    assert view['review']['state'] == 'complete'
    assert client.get(stages+'0/state-image').status_code == 409
    states = decide(client, 0, 'accept_state', 2)
    assert [s['name'] for s in states] == [A, B]
    assert states[0]['sha256'] == sha256(source).hexdigest()
    assert states[1]['transition_status'] == 'awaiting_review'
    assert states[1]['frame'] == 2 and states[1]['raw_index'] == 3
    endpoint = provider.archive[3]  # f04, before the excluded f05.
    assert states[1]['sha256'] == sha256(endpoint).hexdigest() != sha256(provider.archive[4]).hexdigest()
    assert client.get(stages+'0/state-image').content == client.get('progress-image').content == endpoint
    assert client.post('resume', json={'expected_revision': 1}).status_code == 409
    engine.advance(work.job_id, provider, wait=True)
    assert provider.inputs == [source]
    states = decide(client, 0, 'accept', 2)
    assert client.get('progress-image').content == endpoint
    assert states[1]['transition_status'] == 'accepted'
    engine.advance(work.job_id, provider, wait=True)
    assert provider.inputs == [source, endpoint]
    intent = json.loads((engine.directory(work.job_id, 1, 1)/'submit.intent.json').read_text())
    assert intent['first_sha256'] == states[1]['sha256']
    second = client.get(stages+'1').json()
    assert second['input_sha256'] == states[1]['sha256'] and second['context_removed']
    assert second['transition'] == {'from_state': B, 'to_state': C}
    assert second['review']['state'] == 'complete'
    states = decide(client, 1, 'accept')  # Full transition acceptance also registers C.
    assert [s['name'] for s in states] == [A, B, C]
    assert states[2]['frame'] == 3 and states[2]['raw_index'] == 4
    assert client.get(stages+'1').json()['state_image'] == states[2]
    assert client.get(stages+'1/state-image').content == provider.archive[7]
    assert sha256(provider.archive[7]).hexdigest() == states[2]['sha256']
    job = engine.advance(work.job_id, provider, wait=True)
    execution = job.candidates[0].plan_execution
    assert execution.quality_review['state'] == 'complete'
    assert [(row['from_state'], row['to_state'], row['input_sha256'], row['anchor_sha256'])
            for row in execution.timeline] == [(s['name'], t['name'], s['sha256'], t['sha256'])
                                               for s, t in zip(states, states[1:])]
    assert execution.timeline[0]['excluded_tail_count'] == 1
    assert execution.actual_frame_count == 9 and execution.timeline[1]['hold_frames'] == 2
    assert engine.saved_frames(work.job_id, 1, 0) == provider.archive[:5]
    assert len(provider.inputs) == 2
    for stage, (start, end) in enumerate([(A, B), (B, C)]):
        folder = service.store.job_dir(job.job_id)/'review-evidence/c1'
        manifest = json.loads(next(folder.glob(f's{stage}-*/evidence.json')).read_text())
        prop = manifest['context']['interactable']
        assert (prop['initial_state'], prop['target_state']) == (start, end)


@pytest.mark.parametrize('pin', [False, True])
def test_reject_stops_chain_and_preserves_only_confirmed_state(chain, pin):
    service, work, engine, provider, client = chain
    if pin:
        decide(client, 0, 'accept_state', 2)
    states = decide(client, 0, 'reject')
    assert [state['name'] for state in states] == ([A, B] if pin else [A])
    if pin:
        assert states[1]['transition_status'] == 'rejected'
        assert client.get('candidates/1/stages/0/state-image').content == provider.archive[3]
    assert client.post('resume', json={'expected_revision': 1}).status_code == 409
    service.recover_pending_jobs()
    job = engine.advance(work.job_id, provider, wait=True)
    assert len(provider.inputs) == 1
    first, second = job.candidates[0].plan_execution.stages
    assert first.state == 'rejected' and first.accepted is None
    assert second.state == 'created' and second.submission_attempts == 0
    assert not job.plan_control.enabled and not job.candidates[0].frames


@pytest.mark.parametrize('damage', ['changed_pin', 'missing_snapshot'])
def test_integrity_failure_stops_before_second_submission(chain, damage):
    service, work, engine, provider, client = chain
    pinned = decide(client, 0, 'accept_state', 2)[1]
    accepted = decide(client, 0, 'accept', 2)[1]
    if damage == 'changed_pin':
        service.store.resolve_job_path(work.job_id, pinned['path']).write_bytes(provider.archive[4])
    else:
        service.store.resolve_job_path(work.job_id, accepted['path']).unlink()
    assert client.get('candidates/1/stages/0/state-image').status_code == 409
    with pytest.raises(ConflictError, match='快照'):
        engine.advance(work.job_id, provider, wait=True)
    job = engine.advance(work.job_id, provider, wait=True)
    assert not job.plan_control.enabled and len(provider.inputs) == 1
    assert job.candidates[0].plan_execution.stages[1].submission_attempts == 0


def test_reject_second_transition_keeps_b_and_does_not_publish_c(chain):
    _, work, engine, provider, client = chain
    states = decide(client, 0, 'accept', 2)
    engine.advance(work.job_id, provider, wait=True)
    assert decide(client, 1, 'reject') == states
    assert client.get('candidates/1/stages/0/state-image').content == provider.archive[3]
    assert client.get('candidates/1/stages/1/state-image').status_code == 409
    job = engine.advance(work.job_id, provider, wait=True)
    assert not job.candidates[0].frames and len(provider.inputs) == 2


@pytest.mark.parametrize('chain', ['catalog'], indirect=True)
def test_archive_asset_catalog_exposes_only_confirmed_material(chain):
    service, work, engine, provider, client = chain
    catalog = TestClient(create_api(service=service))

    def assets():
        rows = catalog.get('/v1/artworks').json()['data']['assets']
        return {(r['motionSource'], r['stageIndex']): r for r in rows if r.get('motionSource')}

    assert not assets()
    decide(client, 0, 'accept_state', 2)
    pinned = assets()
    assert set(pinned) == {('state', None), ('state', 0)}
    state = pinned['state', 0]
    assert state['workId'] == work.id and state['workRevision'] == work.revision
    assert state['rawIndex'] == 3 and state['stateSha256'] == sha256(provider.archive[3]).hexdigest()
    decide(client, 0, 'accept', 2)
    engine.advance(work.job_id, provider, wait=True)
    decide(client, 1, 'accept')
    rows = assets()
    assert len(rows) == 5
    for stage, indexes in [(0, [1, 2, 3]), (1, [4, 5, 6, 7, 7, 7])]:
        edge = rows['transition', stage]
        detail = catalog.get('/v1/artworks/' + edge['id']).json()['data']['asset']
        expected = [provider.archive[i] for i in indexes]
        assert detail['frameCount'] == len(expected) and detail['loop'] is False
        assert detail['checkpointToken'] == rows['state', stage]['checkpointToken']
        for i, frame in enumerate(expected):
            params = {'asset_id': edge['id'], 'key': f'frame-{i}'}
            assert catalog.get('/v1/artworks/file', params=params).content == frame
    endpoint = service.get_job(work.job_id).candidates[0].plan_execution.stages[0].state_checkpoint
    service.store.resolve_job_path(work.job_id, endpoint['path']).write_bytes(provider.archive[4])
    assert catalog.get('/v1/artworks/' + state['id']).status_code == 409
    assert catalog.get('/v1/artworks/' + rows['transition', 0]['id']).status_code == 409


@pytest.mark.parametrize('chain', ['catalog'], indirect=True)
def test_rejected_transition_keeps_pinned_state_importable(chain):
    service, _, _, provider, client = chain
    decide(client, 0, 'accept_state', 2)
    decide(client, 0, 'reject')
    catalog = TestClient(create_api(service=service))
    rows = [r for r in catalog.get('/v1/artworks').json()['data']['assets'] if r.get('motionSource')]
    assert [(r['motionSource'], r['stageIndex']) for r in rows] == [('state', None), ('state', 0)]
    assert catalog.get('/v1/artworks/file', params={'asset_id': rows[1]['id'], 'key': 'source'}).content == provider.archive[3]
    transition_id = rows[1]['id'].replace('motion-state:', 'motion-transition:')
    assert catalog.get('/v1/artworks/' + transition_id).status_code == 404


@pytest.mark.parametrize('chain', ['catalog'], indirect=True)
def test_archive_writeback_to_shared_document(chain):
    import os
    import shutil
    import socket
    import subprocess
    from pathlib import Path
    from threading import Thread
    import uvicorn

    repository = Path(__file__).resolve().parents[3]
    if not shutil.which('node') or not (repository / 'node_modules/zod').is_dir():
        pytest.skip('Requires workbench Node dependencies for the cross-service writeback test')
    service, work, engine, provider, client = chain
    decide(client, 0, 'accept', 2)
    engine.advance(work.job_id, provider, wait=True)
    decide(client, 1, 'accept')
    server = uvicorn.Server(uvicorn.Config(create_api(service=service), lifespan='off', log_level='error'))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        sock.listen()
        thread = Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
        thread.start()
        try:
            subprocess.run(['node', 'tests/asset-import/state-chain.mjs'], check=True, timeout=90, cwd=repository,
                           env={**os.environ, 'SPRITE_PIPELINE_API_URL': f'http://127.0.0.1:{sock.getsockname()[1]}'})
        finally:
            server.should_exit = True
            thread.join(timeout=10)

def test_external_state_target_guards_and_chain_input(tmp_path, monkeypatch):
    service, ws = workspace_for(tmp_path, 'lamp', seed=2202)
    ws.model = LampPlanner('lamp')
    provider = ArchiveProvider()
    monkeypatch.setattr('sprite_pipeline.providers.get_provider', lambda *args: provider)
    spec = TaskSpec(object_type='interactable', object_id='lamp', provider='fixture',
                    description='Light the lens to partial green and finish at full green.')
    work = ws.plan(ws.create(spec, 'target-lamp-chain', planning_authorized=True).id)
    client = TestClient(create_api(service=service), base_url='http://testserver/v1/open-motion/' + work.id + '/')
    initial = ws.view(work.id)['target_set_sha256']
    png = provider.archive[8]  # Distinct from both accepted endpoints.
    bind = dict(expected_revision=work.revision, expected_targets=initial, stage_index=0,
                png_base64=base64.b64encode(png).decode(), note='Check lamp housing and partial green state')
    saved = client.post('target', json=bind)
    assert saved.status_code == 200, saved.text
    guard = saved.json()['target_set_sha256']
    assert guard != initial and client.get('targets/0').content == png
    assert client.post('target', json={**bind, 'png_base64': None}).status_code == 409
    generate = dict(expected_revision=work.revision, plan_sha256=work.plan_sha256)
    assert client.post('generate', json={**generate, 'expected_targets': initial}).status_code == 409
    assert not ws.load(work.id).job_id
    response = client.post('generate', json={**generate, 'expected_targets': guard})
    assert response.status_code == 200, response.text
    job_id = ws.load(work.id).job_id
    engine = PlanGeneration(service)
    engine.advance(job_id, provider, wait=True)
    assert provider.end_targets == [png]
    assert decide(client, 0, 'accept', 2)[-1]['sha256'] == sha256(provider.archive[3]).hexdigest()
    engine.advance(job_id, provider, wait=True)
    assert provider.inputs == [(ARCHIVE/'lamp/A.png').read_bytes(), provider.archive[3]]
    assert provider.end_targets == [png, None]
    assert client.post('target', json={**bind, 'expected_targets': guard}).status_code == 409


def test_deterministic_palette_edit_on_archive_stage(chain):
    service,work,engine,provider,client=chain
    before=client.get('adjustments',params={'revision':1,'candidate':1,'stage':0}).json()
    assert 'frames' in before,before
    selected=[i for i in range(len(before['frames'])) if i not in before['locked_frames']]
    assert len(selected)>1
    body={'expected_revision':1,'candidate_index':1,'stage_index':0,'token':before['token'],'request_key':'palette-across-stages',
          'description':'Recolor the authorized lamp pixels','palette':[{'source':'#808080','target':'#55ff99'}],
          'frames':[{'region':{'frame':i,'source_sha256':before['frames'][i]['sha256'],'spans':[{'start':0,'length':128*128}]}} for i in selected]}
    # Select a real visible source color so changed-pixel assertions are meaningful.
    from PIL import Image
    from io import BytesIO
    first=client.get(f"edit-source/{selected[0]}",params={'revision':1,'candidate':1,'stage':0,'token':before['token']}).content
    rgb=next(pixel[:3] for pixel in Image.open(BytesIO(first)).convert('RGBA').getdata() if pixel[3])
    body['palette'][0]['source']='#'+bytes(rgb).hex()
    res=client.post('local-frame-edits',json=body);assert res.status_code==200,res.text
    task=res.json()['adjustment']
    assert sum(x['changed_inside_pixels'] for x in task['spatial_protection']['frames'])>0
    assert all(task['proposed_frames'][i]['sha256']==before['frames'][i]['sha256'] for i in before['locked_frames'])
    assert client.post('local-frame-edits',json=body).json()['adjustment']['id']==task['id']
    assert client.post('local-frame-edits',json={**body,'description':'different'}).status_code==409
    adopted=client.post('adjustments/'+task['id']+'/decision',json={'token':task['preview_token'],'decision':'accept','note':'Verify both staged timeline segments','acknowledge_warnings':True})
    assert adopted.status_code==200,adopted.text
    new=adopted.json()['work']
    assert new['revision']==1 and new['adjustment_usage']['generation']==0
    run=new['job']['candidates'][0]['plan_execution']['stages'][0]
    assert run['adjustment_history'][-1]['id']==task['id']
    assert engine.saved_frames(work.job_id,1,0)==provider.archive[:5]


def test_local_frame_edits_refuse_stale_locked_and_outside_pixels(chain):
    service,work,engine,provider,client=chain
    context=client.get('adjustments',params={'revision':1,'candidate':1,'stage':0}).json()
    body={'expected_revision':1,'candidate_index':1,'stage_index':0,'token':context['token'],'request_key':'local-frame-negative',
          'description':'One explicitly selected pixel','palette':[{'source':'#808080','target':'#00ff00'}],
          'frames':[{'region':{'frame':1,'source_sha256':context['frames'][1]['sha256'],'spans':[{'start':0,'length':1}]}}]}
    assert client.post('local-frame-edits',json={**body,'token':'0'*64}).status_code==409
    locked={**body,'frames':[{'region':{**body['frames'][0]['region'],'frame':0,'source_sha256':context['frames'][0]['sha256']}}]}
    assert client.post('local-frame-edits',json=locked).status_code==409
    bad={**body,'frames':[{'region':{**body['frames'][0]['region'],'source_sha256':'0'*64}}]}
    assert client.post('local-frame-edits',json=bad).status_code==409
    from PIL import Image
    from io import BytesIO
    raw=client.get('edit-source/1',params={'revision':1,'candidate':1,'stage':0,'token':context['token']}).content
    im=Image.open(BytesIO(raw)).convert('RGBA');old=im.getpixel((1,0));im.putpixel((1,0),((old[0]+1)%256,*old[1:]));buf=BytesIO();im.save(buf,'PNG')
    outside={**body,'palette':None,'frames':[{'region':body['frames'][0]['region'],'png_base64':base64.b64encode(buf.getvalue()).decode()}]}
    assert client.post('local-frame-edits',json=outside).status_code==409
    assert client.get('adjustments',params={'revision':1,'candidate':1,'stage':0}).json()['tasks']==[]
