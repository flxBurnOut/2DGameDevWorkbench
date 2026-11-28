from __future__ import annotations

import base64
import io
import json
import shutil
from pathlib import Path
from dataclasses import replace
from threading import Event
from time import sleep
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from sprite_pipeline.api_app import create_api
from sprite_pipeline import reference_art
from sprite_pipeline.service import SpritePipelineService


def available_balance(generations=1, usd=0):
    return {'subscription': {'generations': generations}, 'credits': {'usd': usd}}


def image_base64(size=(128, 128), opaque=False):
    image = Image.new('RGBA', size, (0, 0, 0, 255 if opaque else 0))
    ImageDraw.Draw(image).rectangle((40, 30, 80, 110), fill=(40, 150, 80, 255))
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return base64.b64encode(stream.getvalue()).decode()


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.delenv('PIXELLAB_API_KEY', raising=False)
    monkeypatch.setenv('GRADIO_ANALYTICS_ENABLED', 'False')
    shutil.copytree(Path(__file__).resolve().parents[1] / 'presets', tmp_path / 'presets')
    return SpritePipelineService(tmp_path)


def test_settings_share_animation_credentials_without_echo(service, monkeypatch):
    from sprite_pipeline.credential_store import CredentialStore
    protected = {}
    monkeypatch.setattr(CredentialStore, 'set', lambda self, name, value: protected.update({name: value}))
    monkeypatch.setattr(CredentialStore, 'get', lambda self, name: protected.get(name))
    with TestClient(create_api(service=service)) as client:
        assert client.get('/v1/reference-art/settings').json()['configured'] is False
        response = client.post('/v1/reference-art/settings', json={'apiKey': 'test-shared-secret'})
        assert response.status_code == 200
        assert 'test-shared-secret' not in response.text
        assert service.settings.pixellab_api_key == 'test-shared-secret'
        assert client.get('/health').json()['pixellab_configured'] is True
        service.configure_pixellab_api_key('changed-in-animation')
        assert client.get('/v1/reference-art/settings').json()['configured'] is True
        invalid = client.post('/v1/reference-art/settings', json={'apiKey': 'sekret'})
        assert invalid.status_code == 422 and 'sekret' not in invalid.text


def test_animation_page_refreshes_key_saved_after_ui_startup(service, monkeypatch):
    from sprite_pipeline.credential_store import CredentialStore
    from sprite_pipeline.ui import build_ui
    protected = {}
    monkeypatch.setattr(CredentialStore, 'set', lambda self, name, value: protected.update({name: value}))
    monkeypatch.setattr(CredentialStore, 'get', lambda self, name: protected.get(name))
    ui = build_ui(service=service)
    try:
        callback = next(block for block in ui.fns.values() if getattr(block.fn, '__name__', '') == 'refresh_shared_api_state')
        assert callback.fn()[-1]['interactive'] is False
        with TestClient(create_api(service=service)) as client:
            response = client.post('/v1/reference-art/settings', json={'apiKey': 'new-shared-secret'})
            assert response.status_code == 200
        refreshed = callback.fn()
        assert len(refreshed) == len(callback.outputs)
        assert refreshed[-1]['interactive'] is True
        assert 'new-shared-secret' not in str(refreshed)
    finally:
        ui.close()


def test_documented_pixflux_submit_poll_and_no_secret_response(service, monkeypatch):
    service.settings = replace(service.settings, pixellab_api_key='private-test-key')
    calls = []
    real_client = httpx.Client
    def handler(request):
        calls.append(request)
        assert request.headers['authorization'] == 'Bearer private-test-key'
        if request.url.path == '/v2/balance':
            return httpx.Response(200, json=available_balance())
        if request.method == 'POST':
            assert request.url.path == '/v2/create-image-pixflux-background'
            assert json.loads(request.content) == {'description': 'pixel ranger', 'image_size': {'width': 128, 'height': 128}, 'no_background': True, 'view': 'side', 'direction': 'west', 'seed': 42}
            return httpx.Response(202, json={'background_job_id': 'test-job', 'status': 'processing', 'usage': {'secret': 'private-test-key'}})
        assert request.url.path == '/v2/background-jobs/test-job'
        return httpx.Response(200, json={'id': 'test-job', 'status': 'completed', 'last_response': {'image': {'base64': 'data:image/png;base64,' + image_base64()}}})
    with TestClient(create_api(service=service)) as client:
        monkeypatch.setattr(reference_art.httpx, 'Client', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
        submitted = client.post('/v1/reference-art/jobs', json={'prompt': 'pixel ranger', 'facing': 'left', 'seed': 42})
        assert submitted.status_code == 202 and submitted.json()['jobId'] == 'test-job'
        polled = client.get('/v1/reference-art/jobs/test-job')
        assert polled.json()['status'] == 'completed'
        assert 'private-test-key' not in submitted.text + polled.text
        assert [r.method for r in calls] == ['GET', 'POST', 'GET']


@pytest.mark.parametrize('response,expected', [('timeout', 'attention_required'), (401, 'not_submitted'),
    (402, 'not_submitted'), ('charge', 'attention_required'), ('busy-with-charge', 'attention_required'), (500, 'attention_required')])
def test_rejected_or_ambiguous_submission_never_retries_or_echoes_body(service, monkeypatch, response, expected):
    service.settings = replace(service.settings, pixellab_api_key='secret-never-log')
    real_client = httpx.Client
    calls = []
    def handler(request):
        calls.append(request)
        if request.url.path == '/v2/balance':
            return httpx.Response(200, json=available_balance())
        if response == 'timeout':
            raise httpx.ReadTimeout('secret-never-log', request=request)
        if response == 'charge':
            return httpx.Response(402, json={'usage': {'type': 'generations', 'generations': 1, 'secret': 'secret-never-log'}})
        if response == 'busy-with-charge':
            return httpx.Response(429, json={'background_job_id': 'unexpected.id:1', 'usage': {'generations': 1}})
        return httpx.Response(response, json={'error': 'secret-never-log'})
    app = create_api(service=service)
    queue = app.state.sprite_pipeline_recovery.reference_queue
    with TestClient(app) as client:
        monkeypatch.setattr(reference_art.httpx, 'Client', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
        result = client.post('/v1/reference-art/jobs', json={'prompt': 'ranger', 'requestId': 'test-rejection'})
        assert result.status_code == 202
        queue.advance()
        queue.advance()
        saved = client.get('/v1/reference-art/requests/test-rejection')
        assert saved.json()['status'] == expected and 'secret-never-log' not in saved.text
        if response in {'charge', 'busy-with-charge'}:
            assert saved.json()['usage'] == {'type': 'generations', 'generations': 1}
        assert [r.method for r in calls] == ['GET', 'POST']


def test_preflight_rejects_empty_balance_and_waits_on_conclusive_429(service, monkeypatch):
    service.settings = replace(service.settings, pixellab_api_key='test-key')
    credits = 0
    post_count = 0
    real_client = httpx.Client

    def handler(request):
        nonlocal post_count
        if request.url.path == '/v2/balance':
            return httpx.Response(200, json=available_balance(0, credits))
        post_count += 1
        if post_count == 1:
            return httpx.Response(429, json={'error': 'account slot is busy'})
        return httpx.Response(202, json={'background_job_id': 'accepted-after-wait'})

    app = create_api(service=service)
    queue = app.state.sprite_pipeline_recovery.reference_queue
    with TestClient(app) as client:
        monkeypatch.setattr(reference_art.httpx, 'Client', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
        client.post('/v1/reference-art/jobs', json={'prompt': 'ranger', 'requestId': 'zero-balance'}).raise_for_status()
        queue.advance()
        blocked = client.get('/v1/reference-art/requests/zero-balance').json()
        assert blocked['status'] == 'not_submitted' and 'jobId' not in blocked
        assert blocked['balance'] == {'generations': 0, 'usd': 0}
        assert post_count == 0

        credits = 1
        client.post('/v1/reference-art/jobs', json={'prompt': 'ranger', 'requestId': 'busy-account'}).raise_for_status()
        queue.advance()
        waiting = client.get('/v1/reference-art/requests/busy-account').json()
        assert (waiting['status'], waiting['stage'], waiting['httpStatus']) == ('running', 'queued', 429)
        assert 'jobId' not in waiting and post_count == 1
        queue.advance()
        accepted = client.get('/v1/reference-art/requests/busy-account').json()
        assert accepted['jobId'] == 'accepted-after-wait' and post_count == 2


def test_background_worker_holds_account_slot_until_known_job_finishes_without_client_polls(service, monkeypatch):
    service.settings = replace(service.settings, pixellab_api_key='test-key', poll_interval_seconds=0.025)
    release_first, first_posted, second_posted = Event(), Event(), Event()
    submitted = []
    real_client = httpx.Client

    def handler(request):
        if request.url.path == '/v2/balance':
            return httpx.Response(200, json=available_balance())
        if request.method == 'POST':
            prompt = json.loads(request.content)['description']
            submitted.append(prompt)
            (first_posted if prompt == 'first' else second_posted).set()
            return httpx.Response(202, json={'background_job_id': prompt})
        job_id = request.url.path.rsplit('/', 1)[-1]
        if job_id == 'first' and release_first.is_set():
            return httpx.Response(200, json={'id': job_id, 'status': 'completed', 'usage': {'type': 'generations', 'generations': 1}})
        return httpx.Response(200, json={'id': job_id, 'status': 'processing'})

    with TestClient(create_api(service=service)) as client:
        monkeypatch.setattr(reference_art.httpx, 'Client', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
        first = {'prompt': 'first', 'requestId': 'request-one'}
        client.post('/v1/reference-art/jobs', json=first).raise_for_status()
        assert first_posted.wait(3)
        client.post('/v1/reference-art/jobs', json=first).raise_for_status()
        assert client.post('/v1/reference-art/jobs', json={**first, 'prompt': 'changed'}).status_code == 409
        second = client.post('/v1/reference-art/jobs', json={'prompt': 'second', 'requestId': 'request-two'}).json()
        assert second['status'] == 'running' and second['stage'] == 'queued'
        assert not second_posted.wait(0.15)
        release_first.set()
        assert second_posted.wait(3)
        assert submitted == ['first', 'second']
        first_status = client.get('/v1/reference-art/requests/request-one').json()
        assert first_status['status'] == 'failed' and first_status['jobId'] == 'first'
        assert first_status['usage'] == {'type': 'generations', 'generations': 1}
        assert 'image' not in first_status


@pytest.mark.parametrize('first_path', ['reference', 'animation'])
def test_reference_and_native_animation_share_account_slot(service, monkeypatch, first_path):
    from sprite_pipeline.models import GenerationRequest
    from sprite_pipeline.reference_queue import ReferenceQueue

    initial_settings = replace(service.settings, pixellab_api_key='test-key-A', poll_interval_seconds=0.001)
    service.settings = initial_settings
    real_client = httpx.Client
    finished = set()
    posts = []

    def handler(request):
        assert request.headers['authorization'] == 'Bearer test-key-A'
        route = request.url.path
        if route == '/v2/balance':
            return httpx.Response(200, json=available_balance(0, 1.25))
        if request.method == 'POST':
            kind = 'reference' if route.endswith('pixflux-background') else 'animation'
            assert not (set(posts) - finished), 'same account accepted two concurrent jobs'
            posts.append(kind)
            return httpx.Response(202 if kind == 'reference' else 200, json={'background_job_id': kind})
        job_id = route.rsplit('/', 1)[-1]
        info = {'id': job_id, 'status': 'failed' if job_id in finished else 'processing',
                'usage': {'type': 'generations', 'generations': 1}}
        if job_id == 'animation' and job_id in finished:
            info['last_response'] = {'diagnostics': 'x' * 2_100_000}
        return httpx.Response(200, json=info)

    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    queue = ReferenceQueue(service)
    job = service.create_job(GenerationRequest(character_id='diagnostic_dummy', action_id='idle', candidate_count=2))
    payload = {'description': 'reference', 'image_size': {'width': 128, 'height': 128}}
    if first_path == 'reference':
        queue.enqueue('reference-request', payload)
        queue.advance()
        queued = service.generate_job(job.job_id, wait=False, candidate_index=2)
        assert queued.status == 'queued' and queued.queued_candidate_index == 2
        assert queued.candidates[1].submission_attempts == 0
        service.settings = replace(service.settings, pixellab_api_key='test-key-B')
        assert service.generate_job(job.job_id, wait=False, candidate_index=2).status == 'queued'
        service.recover_pending_jobs()
        service.settings = initial_settings
        assert posts == ['reference']
        finished.add('reference')
        queue.advance()
        service.recover_pending_jobs()
        assert posts == ['reference', 'animation']
        recovered = service.get_job(job.job_id)
        assert recovered.candidates[0].submission_attempts == 0
        assert recovered.candidates[1].provider_job_id == 'animation'
    else:
        service.generate_job(job.job_id, wait=False, candidate_index=2)
        queue.enqueue('reference-request', payload)
        queue.advance()
        assert posts == ['animation'] and queue.status('reference-request')['stage'] == 'queued'
        finished.add('animation')
        sleep(0.01)
        queue.advance()
        assert posts == ['animation', 'reference'] and queue.status('reference-request')['jobId'] == 'reference'


def test_reference_recovers_the_accepted_receipt_after_local_commit_failure(service, monkeypatch):
    from sprite_pipeline.reference_queue import ReferenceQueue

    service.settings = replace(service.settings, pixellab_api_key='test-key')
    queue = ReferenceQueue(service)
    payload = {'description': 'keeper', 'image_size': {'width': 128, 'height': 128}}
    queue.enqueue('original-request', payload)
    save = queue._save

    def interrupt(row, status, receipt, **kwargs):
        if status == 'running':
            raise OSError('simulated crash after durable receipt')
        save(row, status, receipt, **kwargs)

    provider = Mock(side_effect=[available_balance(), {'jobId': 'original-receipt', 'usage': {'type': 'generations', 'generations': 1}}])
    monkeypatch.setattr(reference_art, '_provider_request', provider)
    monkeypatch.setattr(queue, '_save', interrupt)
    with pytest.raises(OSError):
        queue.advance()
    restarted = ReferenceQueue(service)
    assert restarted.status('original-request')['stage'] == 'submitting'
    restarted.advance()
    receipt = restarted.status('original-request')
    assert receipt['jobId'] == 'original-receipt' and receipt['usage']['generations'] == 1
    assert provider.call_count == 2


def test_animation_error_with_a_remote_id_has_a_recoverable_usage_receipt(service, monkeypatch):
    from sprite_pipeline.errors import ProviderTemporaryError
    from sprite_pipeline.providers import ProviderRequest, get_provider
    from sprite_pipeline.providers.account import PixelLabSlot

    service.settings = replace(service.settings, pixellab_api_key='test-key')
    real_client = httpx.Client
    response = httpx.Response(500, json={'background_job_id': 'original-animation',
                                        'usage': {'generations': 2, 'secret': 'never-persist'}})
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: real_client(transport=httpx.MockTransport(lambda _: response), **kwargs))
    provider = get_provider('pixellab', service.settings)
    request = ProviderRequest(reference_image=base64.b64decode(image_base64()), frame_count=4,
                              prompt='idle', local_submission_id='original-intent')
    with pytest.raises(ProviderTemporaryError):
        provider.submit(request)
    slot = PixelLabSlot(service.settings, service.store)
    assert slot.accepted_receipt('original-intent') == {'jobId': 'original-animation', 'status': 'processing',
                                                       'usage': {'type': 'generations', 'generations': 2}}


def test_missing_key_and_invalid_payload_do_not_call_provider(service, monkeypatch):
    provider = Mock(side_effect=AssertionError('must not contact PixelLab'))
    monkeypatch.setattr(reference_art.httpx, 'Client', provider)
    # TestClient is already backed by ASGI and uses the original class.
    with TestClient(create_api(service=service)) as client:
        assert client.post('/v1/reference-art/jobs', json={'prompt': 'ranger'}).status_code == 422
        assert client.post('/v1/reference-art/jobs', json={'prompt': 'ranger', 'apiKey': 'do-not-store'}).status_code == 422
    provider.assert_not_called()


def test_transfer_is_idempotent_and_preselects_reference_without_animation(service, monkeypatch):
    generate = Mock(side_effect=AssertionError('transfer must not generate animation'))
    monkeypatch.setattr(service, 'generate_job', generate)
    body = {'characterId': 'reference_' + 'a' * 24, 'image': image_base64(), 'name': 'Forest ranger', 'prompt': 'green cloak', 'facing': 'left'}
    with TestClient(create_api(service=service)) as client:
        first = client.post('/v1/reference-art/import', json=body)
        second = client.post('/v1/reference-art/import', json=body)
        assert first.status_code == second.status_code == 200
        assert first.json() == second.json() == {'characterId': body['characterId']}
        changed = client.post('/v1/reference-art/import', json={**body, 'prompt': 'changed'})
        assert changed.status_code == 409
    character, preset_path = service.presets.load_character(body['characterId'])
    assert character.identity_description == 'green cloak' and character.facing == 'left'
    assert (preset_path.parent / character.reference_frame).read_bytes() == base64.b64decode(body['image'])
    from sprite_pipeline.ui import build_ui
    ui = build_ui(service=service)
    try:
        callback = next(block for block in ui.fns.values() if getattr(block.fn, '__name__', '') == 'load_workbench_character')
        result = callback.fn(SimpleNamespace(query_params={'workbench_character': body['characterId']}))
        assert len(result) == len(callback.outputs)
        assert result[0]['selected'] == 'generate'
        assert result[1]['value'] == body['characterId']
        assert result[2] is not None and result[5:7] == ('Forest ranger', 'green cloak')
        missing = callback.fn(SimpleNamespace(query_params={'workbench_character': 'missing'}))
        assert '参考角色不存在' in missing[3]
        empty = callback.fn(SimpleNamespace(query_params={}))
        assert len(empty) == len(callback.outputs)
    finally:
        ui.close()
    generate.assert_not_called()
    assert service.list_jobs() == []


@pytest.mark.parametrize('encoded', ['broken', image_base64((64, 64)), image_base64(opaque=True)])
def test_transfer_rejects_invalid_references(service, encoded):
    with TestClient(create_api(service=service)) as client:
        result = client.post('/v1/reference-art/import', json={'characterId': 'reference_' + 'b' * 24, 'image': encoded, 'name': 'ranger', 'prompt': 'ranger'})
        assert result.status_code == 422


@pytest.mark.parametrize("view,facing,verdict", [
    ("side", "right", "matched"), ("back", "left", "mismatch"),
    ("three_quarter", "right", "mismatch"), ("side", "left", "mismatch"),
    ("unknown", "unknown", "unverified"),
])
def test_orientation_observes_png_once_and_binds_observation(service, monkeypatch, view, facing, verdict):
    from sprite_pipeline.collaboration.model_config import ModelRegistry
    from sprite_pipeline.reference_orientation import OrientationObservation
    from sprite_pipeline.errors import ValidationHarnessError
    image = image_base64()
    def observe(self, role, content, schema, count, *, on_request, on_response, **kwargs):
        assert role == "reviewer" and schema is OrientationObservation and count == 1
        assert content[1]["image_url"] == "data:image/png;base64," + image
        on_request()
        on_response({"usage": {"total_tokens": 42}})
        return schema(view=view, facing=facing, evidence="测试观察"), {}
    send = Mock(side_effect=observe)
    monkeypatch.setattr(ModelRegistry, "send", lambda self, *args, **kw: send(self, *args, **kw))
    body = {"taskId": "reference-test", "image": image, "facing": "right", "authorized": True}
    with TestClient(create_api(service=service)) as client:
        endpoint = "/v1/reference-art/orientation"
        assert client.post(endpoint, json={**body, "authorized": False}).status_code == 422
        result = client.post(endpoint, json=body).json()
        assert result["status"] == verdict and result["callsUsed"] == 1
        assert result["receipt"]["usage"]["total_tokens"] == 42
        assert client.post(endpoint, json=body).json() == result
        assert client.post(endpoint, json={**body, "facing": "left"}).status_code == 422
        send.assert_called_once()
        send.side_effect = ValidationHarnessError("核对未完成")
        failed_body = {**body, "taskId": "failed-review"}
        failed = client.post(endpoint, json=failed_body).json()
        assert failed["status"] == "unverified"
        assert client.post(endpoint, json=failed_body).json() == failed
        assert send.call_count == 2


def test_concurrent_orientation_poll_cannot_repeat_a_paid_check(service, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from sprite_pipeline.collaboration.model_config import ModelRegistry
    from sprite_pipeline.reference_orientation import check_orientation, OrientationObservation

    started, release = Event(), Event()

    def observe(*args, on_request, **kwargs):
        on_request()
        started.set()
        assert release.wait(timeout=5)
        return OrientationObservation(view="side", facing="right", evidence="可见侧脸。"), {}

    send = Mock(side_effect=observe)
    monkeypatch.setattr(ModelRegistry, "send", send)
    args = (service, "one-task", base64.b64decode(image_base64()), "right")
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(check_orientation, *args)
        try:
            assert started.wait(timeout=5)
            assert check_orientation(*args)["status"] == "checking"
        finally:
            release.set()
        completed = pending.result()
    assert completed["status"] == "matched"
    assert check_orientation(*args) == completed
    send.assert_called_once()

def test_native_64_reference_preserves_size_through_generation_and_transfer(service, monkeypatch):
    service.settings = replace(service.settings, pixellab_api_key='test-key')
    encoded = image_base64((64, 64))
    calls = []
    def provider(_service, method, route, payload=None):
        calls.append((method, route, payload))
        if route == '/balance':
            return available_balance()
        if method == 'POST':
            assert payload['image_size'] == {'width': 64, 'height': 64}
            return {'jobId': 'coarse-64'}
        return {'id': 'coarse-64', 'status': 'completed', 'last_response': {'image': {'base64': encoded}}}
    monkeypatch.setattr(reference_art, '_provider_request', provider)
    with TestClient(create_api(service=service)) as client:
        assert client.post('/v1/reference-art/jobs', json={'prompt': 'coarse keeper', 'size': 64}).status_code == 202
        polled = client.get('/v1/reference-art/jobs/coarse-64')
        assert polled.json()['status'] == 'completed'
        body = {'characterId': 'reference_' + 'c' * 24, 'image': polled.json()['image'], 'name': 'Coarse keeper', 'prompt': 'coarse keeper', 'size': 64}
        assert client.post('/v1/reference-art/import', json=body).status_code == 200
        assert client.post('/v1/reference-art/import', json={**body, 'prompt': 'default lock', 'reuseIdentity': True}).status_code == 200
        assert client.post('/v1/reference-art/import', json={**body, 'prompt': 'different explicit identity'}).status_code == 409
        assert client.post('/v1/reference-art/import', json={**body, 'size': 128}).status_code == 422
        assert client.post('/v1/reference-art/jobs', json={'prompt': 'keeper', 'size': 96}).status_code == 422
    character, preset_path = service.presets.load_character(body['characterId'])
    with Image.open(preset_path.parent / character.reference_frame) as image:
        assert image.size == (64, 64)
    assert len(calls) == 3


def test_prop_transfer_only_admits_verified_registered_png(service, tmp_path, monkeypatch):
    from sprite_pipeline.jsonio import atomic_write_json, sha256_file
    monkeypatch.delenv('WORKBENCH_TEST_RUN', raising=False)
    repo = tmp_path / 'workbench-repo'
    service.settings = replace(service.settings, install_root=repo/'Tools/SpritePipeline')
    atomic_write_json(repo/'workbench/manifest.json', {'workspace': {'taskDirectory':'work/tasks','outputDirectory':'outputs'}})
    task_id = 'archived-lamp'
    folder = repo/'outputs'/task_id
    folder.mkdir(parents=True)
    png = folder/'reference.png'
    png.write_bytes(base64.b64decode(image_base64()))
    fields = {'operation':'generate', 'subject':'prop', 'prompt':'Indicator lamp', 'size':128}
    task = {'id':task_id, 'input':fields, 'capabilityId':'reference-art', 'status':'completed',
            'adapter':{'referenceJobId':'fixture-pixflux'}, 'outputs':['outputs/archived-lamp/reference.png','outputs/archived-lamp/result.json']}
    task_file = repo/'work/tasks'/f'{task_id}.json'
    atomic_write_json(task_file, task)
    atomic_write_json(folder/'result.json', {'sha256':sha256_file(png),'model':'pixflux','width':128,'height':128})
    with TestClient(create_api(service=service)) as client:
        url = '/v1/reference-art/transfer-prop'
        def transfer(**extra):
            return client.post(url,json={'sourceTaskId':task_id,**extra})
        assert transfer(image=image_base64()).status_code == 422
        for invalid in ({'operation':'import'}, {'subject':'character'}, {'size':64}):
            atomic_write_json(task_file,{**task,'input':{**fields,**invalid}})
            assert transfer().status_code == 422
        atomic_write_json(task_file,task)
        first = transfer(identityDescription='Keep the original lens.')
        assert first.status_code == 200,first.text
        assert first.json() == transfer().json()
        assert first.json()['objectType'] == 'interactable'
        identity = first.json()['objectId']
        preset, path = service.presets.load_object(identity,object_type='interactable')
        assert (path.parent/preset.reference_frame).read_bytes() == png.read_bytes()
        assert 'facing' not in preset.model_dump()
        assert transfer(identityDescription='Change the lens.').status_code == 409
        png.write_bytes(b'tampered pixels')
        assert transfer().status_code == 409
        assert not service.list_jobs()


def local_prop_repo(service, tmp_path, monkeypatch):
    from sprite_pipeline.jsonio import atomic_write_json
    monkeypatch.delenv('WORKBENCH_TEST_RUN', raising=False)
    monkeypatch.setattr(reference_art, '_provider_request', Mock(side_effect=AssertionError('Local props cannot call providers')))
    repo = tmp_path / 'local-prop-repo'
    service.settings = replace(service.settings, install_root=repo/'Tools/SpritePipeline')
    atomic_write_json(repo/'workbench/manifest.json', {'workspace': {'taskDirectory':'work/tasks','outputDirectory':'outputs'}})
    return repo


def register_local_prop(repo, task_id, fields, data, result, extra=None):
    from sprite_pipeline.jsonio import atomic_write_json
    folder = repo/'outputs'/task_id; folder.mkdir(parents=True)
    (folder/'reference.png').write_bytes(data)
    atomic_write_json(folder/'result.json', result)
    for name, value in (extra or {}).items(): atomic_write_json(folder/name, value)
    task = {'id':task_id, 'input':fields, 'capabilityId':'reference-art', 'status':'completed',
            'outputs':[(folder/name).relative_to(repo).as_posix() for name in ['reference.png','result.json',*(extra or {})]]}
    atomic_write_json(repo/'work/tasks'/f'{task_id}.json', task)
    return folder, task


def test_import_confirmation_provenance_and_legacy_snapshot(service, tmp_path, monkeypatch):
    import hashlib
    from sprite_pipeline.jsonio import read_json
    repo = local_prop_repo(service, tmp_path, monkeypatch)
    data = base64.b64decode(image_base64()); sha = hashlib.sha256(data).hexdigest()
    register_local_prop(repo, 'imported-lamp', {'operation':'import','subject':'prop','prompt':'closed lamp'}, data,
        {'subject':'prop','model':None,'width':128,'height':128,'sha256':sha,
         'provenance':{'type':'import','sourceSha256':sha,'providerCalled':False}})
    with TestClient(create_api(service=service)) as client:
        body = {'sourceTaskId':'imported-lamp'}
        assert client.post('/v1/reference-art/transfer-prop', json=body).status_code == 422
        assert client.post('/v1/reference-art/transfer-prop', json={**body,'confirmation':{'note':'    '}}).status_code == 422
        body['confirmation'] = {'note':'已核对侧视、关闭状态、完整灯体和透明背景'}
        first = client.post('/v1/reference-art/transfer-prop', json=body)
        assert first.status_code == 200, first.text
        assert client.post('/v1/reference-art/transfer-prop', json=body).json() == first.json()
        identity = first.json()['objectId']
        preset, path = service.presets.load_object(identity)
        original = read_json(path)
        provenance = read_json(path.parent/'provenance.json')
        assert provenance['type'] == 'import' and provenance['referenceSha256'] == sha
        assert provenance['confirmation']['note'] == body['confirmation']['note']
        assert provenance['confirmation']['confirmedAt'].endswith('+00:00')
        assert 'provenance' not in original
        row = next(o for o in client.get('/v1/open-motion/references').json()['objects'] if o['id'] == identity)
        assert row['provenance'] == provenance
        snapshot = service.presets.object_snapshot(preset)
        assert snapshot['provenance'] == {'type':'import','referenceSha256':sha}
        (path.parent/'provenance.json').unlink()
        assert service.presets.object_provenance(identity) == {'type':'pixellab'}
        assert service.presets.object_snapshot(preset)['provenance']['referenceSha256'] == sha
        assert read_json(path) == original
        palette = client.post('/v1/reference-art/convert-prop', json={
            'sourceImage':'data:image/png;base64,'+image_base64(), 'recipe':{'palette':'object:'+identity}})
        assert palette.status_code == 200, palette.text
        assert palette.json()['report']['recipe']['palette'] == ['#289650']
    reference_art._provider_request.assert_not_called()


def test_conversion_preview_replay_tampering_and_palette(service, tmp_path, monkeypatch):
    import hashlib
    from sprite_pipeline.jsonio import atomic_write_json, read_json
    from sprite_pipeline import pixel_prop_gateway
    repo = local_prop_repo(service, tmp_path, monkeypatch)
    source = repo/'source.png'; source.write_bytes(base64.b64decode(image_base64((512,512))))
    fields = {'operation':'convert-prop','subject':'prop','prompt':'green indicator lamp','sourceImagePath':'source.png'}
    with TestClient(create_api(service=service)) as client:
        payload = {'sourceImagePath':'source.png','recipe':{'colors':8}}
        assert client.post('/v1/reference-art/convert-prop',json={**payload,'recipe':{'size':64}}).status_code == 422
        assert client.post('/v1/reference-art/convert-prop',json={**payload,'sourceImage':'bad'}).status_code == 422
        assert client.post('/v1/reference-art/convert-prop',json={'sourceImagePath':'../outside.png'}).status_code in (400,422)
        preview = client.post('/v1/reference-art/convert-prop/preview', json=payload)
        assert preview.status_code == 200, preview.text
        converted = client.post('/v1/reference-art/convert-prop', json=payload).json()
        assert converted == preview.json()
        assert not (repo/'outputs').exists(), 'Preview and gateway never persist task files'
        fields['recipe'] = payload['recipe']
        png = base64.b64decode(converted['image']); report = converted['report']
        result = {'subject':'prop','model':None,'width':128,'height':128,'sha256':report['sha256'],'provenance':converted['provenance']}
        folder, task = register_local_prop(repo, 'converted-lamp', fields, png, result,
            {'recipe.json':report['recipe'], 'report.json':report})
        body = {'sourceTaskId':task['id'],'confirmation':{'note':'已核对视角、初始状态、完整部件和透明背景'}}
        first = client.post('/v1/reference-art/transfer-prop',json=body)
        assert first.status_code == 200, first.text
        identity = first.json()['objectId']
        assert client.post('/v1/reference-art/transfer-prop',json=body).json() == first.json()
        # Another zlib build compresses the same pixels differently; replay compares pixels, not PNG bytes.
        import io as _io
        from PIL import Image as _Image
        import pixel_prop.pipeline as pipeline
        original_png = pipeline.png_bytes
        def other_compression(image):
            out = _io.BytesIO(); _Image.frombytes('RGBA', image.size, image.convert('RGBA').tobytes()).save(out, format='PNG', compress_level=1)
            return out.getvalue()
        monkeypatch.setattr(pipeline, 'png_bytes', other_compression)
        assert pipeline.convert(source.read_bytes(), pixel_prop_gateway.Recipe(colors=8)).report['sha256'] != report['sha256']
        assert client.post('/v1/reference-art/transfer-prop',json=body).json() == first.json()
        monkeypatch.setattr(pipeline, 'png_bytes', original_png)
        provenance = service.presets.object_provenance(identity)
        assert provenance['conversion']['recipeSha256'] == report['recipeSha256']
        assert client.post('/v1/reference-art/convert-prop',json={**payload,'recipe':{'palette':'object:'+identity}}).status_code == 422
        before = source.read_bytes(); source.write_bytes(base64.b64decode(image_base64((128,128))))
        assert client.post('/v1/reference-art/transfer-prop',json=body).status_code == 409
        source.write_bytes(before)
        atomic_write_json(folder/'recipe.json', {**report['recipe'],'colors':3})
        assert client.post('/v1/reference-art/transfer-prop',json=body).status_code == 409
        atomic_write_json(folder/'recipe.json', report['recipe'])
        monkeypatch.setattr(pixel_prop_gateway,'ALGORITHM_VERSION',999)
        assert client.post('/v1/reference-art/transfer-prop',json=body).status_code == 409
    reference_art._provider_request.assert_not_called()
