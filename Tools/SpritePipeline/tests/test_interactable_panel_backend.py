"""Interactable panel backend: state skeleton (B1) and derived assets (B2/B3). Offline only."""
import base64
import io
from hashlib import sha256

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from test_interactable_motion import workspace_for
from test_interactable_state_chain import LampPlanner, chain, decide  # noqa: F401  (pytest fixture)
from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.contracts import TaskSpec, digest, skeleton_problem
from sprite_pipeline.errors import HarnessError

SKELETON = {'states': [{'name': '灰', 'appearance': '灰色灯面'}, {'name': '半亮', 'appearance': '灯面部分点亮'},
                       {'name': '全亮', 'appearance': '绿色灯面完全点亮'}], 'hold': '停留'}


def spec(**extra):
    return TaskSpec(object_type='interactable', object_id='lamp', provider='fixture',
                    description='Light the grey lens in two steps, from partly lit to fully green.', **extra)


def test_skeleton_is_optional_and_keeps_legacy_hash():
    plain = spec()
    assert 'interactable_skeleton' not in plain.model_dump(mode='json')
    assert digest(plain.model_dump(mode='json')) == digest(TaskSpec.model_validate(plain.model_dump(mode='json')).model_dump(mode='json'))
    with_skeleton = spec(interactable_skeleton=SKELETON)
    assert with_skeleton.model_dump(mode='json')['interactable_skeleton']['states'][2]['name'] == '全亮'
    with pytest.raises(ValueError):
        TaskSpec(object_id='hero', description='walk forward slowly', interactable_skeleton=SKELETON)
    with pytest.raises(ValueError):
        spec(interactable_skeleton={'states': [{'name': 'A', 'appearance': 'a'}, {'name': 'A', 'appearance': 'b'}]})
    # A final return to the initial state may repeat its name.
    spec(interactable_skeleton={'states': [{'name': 'A', 'appearance': 'a'}, {'name': 'B', 'appearance': 'b'},
                                           {'name': 'A', 'appearance': 'back'}]})


def test_skeleton_freezes_into_plan_and_matches_segments(tmp_path):
    _, ws = workspace_for(tmp_path, 'lamp', seed=2202)
    ws.model = LampPlanner('lamp')
    work = ws.create(spec(interactable_skeleton=SKELETON), 'skeleton-ok-1', planning_authorized=True)
    planned = ws.plan(work.id)
    assert planned.status == 'ready', planned.message
    frozen = [r for r in planned.plan.requirements if r.text.startswith('用户状态骨架')]
    assert frozen and '灰 → 半亮 → 全亮' in frozen[0].evidence
    assert planned.plan_sha256 == digest(planned.plan.model_dump(mode='json'))


def test_skeleton_stage_count_is_enforced_by_local_validator(tmp_path):
    _, ws = workspace_for(tmp_path, 'lamp', seed=2202)
    ws.model = LampPlanner('lamp')  # Always proposes two stages.
    four = {'states': SKELETON['states'] + [{'name': '闪烁', 'appearance': '灯面闪烁'}]}
    work = ws.create(spec(interactable_skeleton=four), 'skeleton-bad-1', planning_authorized=True)
    try:
        ws.plan(work.id)
    except HarnessError:
        pass
    saved = ws.load(work.id)
    assert saved.plan is None and saved.job_id is None
    feedback = [m for m in saved.messages if m['role'] == 'validator']
    assert feedback and '状态骨架' in feedback[0]['response']['summary']
    assert skeleton_problem(None, saved.spec) is None


def png(image):
    out = io.BytesIO()
    image.save(out, 'PNG')
    return out.getvalue()


def finish_chain(chain):
    service, work, engine, provider, client = chain
    decide(client, 0, 'accept', 2)
    engine.advance(work.job_id, provider, wait=True)
    decide(client, 1, 'accept')
    engine.advance(work.job_id, provider, wait=True)
    return service, work, provider, client


@pytest.mark.parametrize('chain', ['catalog'], indirect=True)
def test_reverse_transition_needs_played_review_before_library(chain):
    service, work, provider, client = finish_chain(chain)
    catalog = TestClient(create_api(service=service))
    created = client.post('derived', json={'expected_revision': 1, 'candidate_index': 1, 'request_key': 'reverse-key-1',
                                           'method': 'reverse', 'stage_index': 0})
    assert created.status_code == 200, created.text
    record = created.json()['derived']
    forward = [provider.archive[i] for i in (1, 2, 3)]
    assert [client.get(f"derived/{record['id']}/frames/{i}").content for i in range(3)] == forward[::-1]
    assert record['kind'] == 'transition' and record['method'] == 'reverse' and record['state'] == 'ready'
    assert record['name'].startswith('Partially illuminated') and record['usage'] == {'planning': 0, 'generation': 0, 'review': 0}
    # Same request key and body replays; a changed body under the same key is refused.
    again = client.post('derived', json={'expected_revision': 1, 'candidate_index': 1, 'request_key': 'reverse-key-1',
                                         'method': 'reverse', 'stage_index': 0}).json()['derived']
    assert again['id'] == record['id']
    assert client.post('derived', json={'expected_revision': 1, 'candidate_index': 1, 'request_key': 'reverse-key-1',
                                        'method': 'reverse', 'stage_index': 1}).status_code == 409
    rows = lambda: [r for r in catalog.get('/v1/artworks').json()['data']['assets'] if r.get('derivation')]  # noqa: E731
    assert not rows()
    decision = {'token': record['token'], 'decision': 'accept', 'note': '播放检查通过'}
    assert client.post(f"derived/{record['id']}/decision", json=decision).status_code == 422
    accepted = client.post(f"derived/{record['id']}/decision", json={**decision, 'played': True}).json()['derived']
    assert accepted['state'] == 'accepted' and accepted['review']['played'] is True
    [row] = rows()
    assert row['id'] == record['asset_id'] and row['motionSource'] == 'transition' and row['statusLabel'] == '派生过渡'
    assert row['stateSha256'] == sha256(provider.archive[1]).hexdigest()
    detail = catalog.get('/v1/artworks/' + row['id']).json()['data']['asset']
    assert detail['frameCount'] == 3 and detail['loop'] is False
    assert catalog.get('/v1/artworks/file', params={'asset_id': row['id'], 'key': 'frame-0'}).content == provider.archive[3]
    # Source frames and exports are untouched; tampering with the derived file is detected.
    (service.settings.data_root / 'open-motion' / work.id / 'derived' / record['id'] / '000.png').write_bytes(provider.archive[0])
    assert catalog.get('/v1/artworks/' + row['id']).status_code == 409


@pytest.mark.parametrize('chain', ['catalog'], indirect=True)
def test_rotation_palette_and_upload_record_provenance(chain):
    service, work, provider, client = finish_chain(chain)
    reference = Image.open(io.BytesIO(provider.archive[0])).convert('RGBA')
    source = client.get('reference').content
    base = Image.open(io.BytesIO(source)).convert('RGBA')
    turned = base.rotate(15)
    good = [base64.b64encode(png(base)).decode(), base64.b64encode(png(turned)).decode()]
    bad = [base64.b64encode(png(turned)).decode(), good[0]]
    body = {'expected_revision': 1, 'candidate_index': 1, 'method': 'rotation', 'stage_index': 0, 'params': {'angle': 15}}
    assert client.post('derived', json={**body, 'request_key': 'rotate-bad-1', 'frames_png': bad}).status_code == 409
    rotated = client.post('derived', json={**body, 'request_key': 'rotate-ok-1', 'frames_png': good}).json()['derived']
    assert rotated['method'] == 'rotation' and len(rotated['frames']) == 2 and rotated['source']['base_sha256'] == sha256(source).hexdigest()
    pixels = list(base.getdata())
    colour = next(p for p in pixels if p[3])
    hex_colour = '#%02x%02x%02x' % colour[:3]
    palette = client.post('derived', json={'expected_revision': 1, 'candidate_index': 1, 'request_key': 'palette-ok-1', 'method': 'palette',
                                           'state_index': 0, 'name': '灯亮', 'palette': [{'source': hex_colour, 'target': '#ff00ff'}]})
    assert palette.status_code == 200, palette.text
    record = palette.json()['derived']
    out = Image.open(io.BytesIO(client.get(f"derived/{record['id']}/frames/0").content)).convert('RGBA')
    assert [p[3] for p in out.getdata()] == [p[3] for p in pixels]
    assert record['params']['changed_pixels'] == sum(1 for p in pixels if p[3] and p[:3] == colour[:3])
    missing = client.post('derived', json={'expected_revision': 1, 'candidate_index': 1, 'request_key': 'palette-none-1', 'method': 'palette',
                                           'state_index': 0, 'name': '无变化', 'palette': [{'source': '#010203', 'target': '#ff00ff'}]})
    assert missing.status_code == 422
    upload = {'expected_revision': 1, 'candidate_index': 1, 'request_key': 'upload-1', 'method': 'upload', 'name': '手绘',
              'png_base64': base64.b64encode(png(reference)).decode()}
    assert client.post('derived', json=upload).status_code == 422
    uploaded = client.post('derived', json={**upload, 'note': '手绘稿，已核对视角与底座'}).json()['derived']
    assert uploaded['kind'] == 'state' and uploaded['source']['upload_sha256'] == sha256(png(reference)).hexdigest()
    assert client.post(f"derived/{uploaded['id']}/decision", json={'token': '0' * 64, 'decision': 'accept', 'note': '已看过实际画面'}).status_code == 409
    decided = client.post(f"derived/{uploaded['id']}/decision", json={'token': uploaded['token'], 'decision': 'accept', 'note': '已看过实际画面'}).json()['derived']
    assert decided['state'] == 'accepted'
    catalog = TestClient(create_api(service=service))
    row = next(r for r in catalog.get('/v1/artworks').json()['data']['assets'] if r['id'] == uploaded['asset_id'])
    assert row['motionSource'] == 'state' and row['statusLabel'] == '派生状态图' and row['derivation'] == 'upload'
    assert {r['method'] for r in client.get('derived').json()['derived']} == {'rotation', 'palette', 'upload'}


def test_fixture_derivations_never_enter_library(chain):
    service, work, provider, client = finish_chain(chain)
    record = client.post('derived', json={'expected_revision': 1, 'candidate_index': 1, 'request_key': 'fixture-rev-1',
                                          'method': 'reverse', 'stage_index': 1}).json()['derived']
    assert record['diagnostic'] is True
    client.post(f"derived/{record['id']}/decision", json={'token': record['token'], 'decision': 'accept', 'note': '诊断任务', 'played': True})
    catalog = TestClient(create_api(service=service))
    assert not [r for r in catalog.get('/v1/artworks').json()['data']['assets'] if r.get('derivation')]
    # The hold of the final stage is part of the accepted transition that is reversed.
    assert len(record['frames']) == 6
