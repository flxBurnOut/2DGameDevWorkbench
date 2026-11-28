"""Offline UI fixture for the interactable motion panel. Never used by production launchers.

Builds lamp works in each panel state from the archived real lamp frames, then
serves the SpritePipeline API. Usage: python interactable_panel_server.py <root> <port>
Prints one JSON line with the work IDs per state once ready.
"""
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uvicorn
from fastapi.testclient import TestClient

from test_interactable_motion import workspace_for
from test_interactable_state_chain import ArchiveProvider, LampPlanner
from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.contracts import TaskSpec
from sprite_pipeline.collaboration.execution import PlanGeneration

root, port = Path(sys.argv[1]).resolve(), int(sys.argv[2])
root.mkdir(parents=True, exist_ok=True)
service, ws = workspace_for(root, 'lamp', seed=2202)
ws.model = service.open_motion_model = LampPlanner('lamp')
spec = dict(object_type='interactable', object_id='lamp', provider='fixture',
            description='交互物状态动画，按顺序经过 3 个状态：「灰」 → 「半亮」 → 「全亮」。',
            interactable_skeleton={'states': [{'name': '灰', 'appearance': '灰色灯面'},
                                              {'name': '半亮', 'appearance': '灯面部分点亮'},
                                              {'name': '全亮', 'appearance': '绿色灯面完全点亮'}]})
api = create_api(service=service)
client = TestClient(api)
works = {}


def build(name, steps):
    provider = ArchiveProvider()
    with patch('sprite_pipeline.providers.get_provider', lambda *a, **k: provider):
        work = ws.create(TaskSpec(**spec), f'panel-fixture-{name}', planning_authorized=True)
        work = ws.plan(work.id)
        works[name] = work.id
        if steps == 0:
            return
        work = ws.start(work.id, work.revision, work.plan_sha256)
        engine = PlanGeneration(service)
        engine.advance(work.job_id, provider, wait=True)
        base = f'/v1/open-motion/{work.id}/'
        for stage in range(min(steps - 1, 2)):
            evidence = client.get(base + f'candidates/1/stages/{stage}').json()
            body = dict(expected_revision=1, candidate_index=1, stage_index=stage, token=evidence['token'],
                        decision='accept', note='离线界面夹具确认', acknowledge_warnings=True,
                        anchor_frame=2 if stage == 0 else None, acknowledge_trim=stage == 0)
            assert client.post(base + 'review-stage', json=body).status_code == 200
            engine.advance(work.job_id, provider, wait=True)
        if steps >= 4:
            view = client.get(base).json()
            candidate = view['job']['candidates'][0]
            response = client.post(base + 'review', json=dict(expected_revision=1, candidate_index=1,
                candidate_sha256=candidate['review_token'], note='离线界面夹具采用', acknowledge_warnings=True))
            assert response.status_code == 200, response.text


build('planned', 0)       # plan ready, not started
build('checkpoint', 1)    # first transition awaiting review
build('finished', 3)      # both transitions accepted, candidate awaiting adoption
print(json.dumps(works), flush=True)
uvicorn.run(api, host='127.0.0.1', port=port, log_level='warning')
