"""Exercise the planning transport and ledgers with synthetic provider responses."""
import copy
import json
import uuid
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from test_open_motion import setup, spec
from test_open_motion_checkpoints import CheckpointPlanner
from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.model_config import ModelConfiguration, ModelProfile, ModelRegistry
from sprite_pipeline.collaboration.planning import PlanningModel


def observation():
    return {'action': 'propose', 'summary': '保留参考图中的可见证据',
            'findings': [{'text': '同一只手握住帽子', 'source': 'reference', 'evidence': '轮廓连续可见'}]}


class ChatFixture:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.requests = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def post(self, _url, *, headers, json):
        self.requests.append(json)
        content, finish_reason = next(self.replies)
        return httpx.Response(200, json={'id': f'simulated-{len(self.requests)}', 'model': json['model'],
                                       'choices': [{'finish_reason': finish_reason, 'message': {'content': content}}],
                                       'usage': {'output_tokens': 25}})


@pytest.fixture
def wire_planner(setup, monkeypatch):
    service, workspace, _, provider, _ = setup
    monkeypatch.setenv('TOKENHUB_API_KEY', 'isolated-no-network-token')
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    workspace.model = service.open_motion_model = PlanningModel(service.settings)
    return service, workspace, provider


@pytest.mark.parametrize('model,format_type', [('glm-5.3-flash', 'json_object'), ('kimi-k3.1-pro', 'json_schema')])
def test_structured_error_is_corrected_only_by_its_role(wire_planner, model, format_type):
    _, workspace, provider = wire_planner
    workspace.model.registry.save(ModelConfiguration(default=ModelProfile(model=model)))
    work = workspace.create(spec(), uuid.uuid4().hex, planning_authorized=True)
    final, _ = CheckpointPlanner()('coordinator', work, workspace.reference(work))
    strategy = {'action': 'propose', 'summary': '可执行的策略提案', 'proposal': final['plan']}

    bad_observation = copy.deepcopy(observation())
    bad_observation['question'] = ['invalid question']
    bad_observation['findings'][0]['text'] = '超' * 301
    odd_strategy = copy.deepcopy(strategy)
    odd_strategy['proposal']['stages'][0]['frame_count'] = 5
    bad_plan = copy.deepcopy(final)
    bad_plan['plan']['quality']['appearance_contract'] = '超' * 181
    stage = bad_plan['plan']['stages'][0]
    stage['checkpoint']['reason'] = '超' * 181
    stage['structure_usage'] = {'part_ids': [], 'effect': '无有效结构引用'}
    stage['prompt'] = '长' * 1001
    chat = ChatFixture((json.dumps(reply, ensure_ascii=False), 'stop') for reply in
                       [bad_observation, observation(), observation(), odd_strategy, strategy, bad_plan, final])
    with patch('sprite_pipeline.vision_review.httpx.Client', return_value=chat):
        work = workspace.plan(work.id)

    assert work.status == 'ready', work.message
    assert not provider.requests
    assert [call['role'] for call in work.planning_calls] == [
        'appearance', 'appearance', 'motion', 'strategy', 'strategy', 'coordinator', 'coordinator']
    assert [call.get('corrects_call') for call in work.planning_calls] == [None, 1, None, None, 4, None, 6]
    failures = [call for call in work.planning_calls if call['state'] == 'invalid_response']
    assert [call['response_id'] for call in failures] == ['simulated-1', 'simulated-4', 'simulated-6']
    assert all(call['usage']['output_tokens'] == 25 and call['output_sha256'] for call in failures)
    assert all(body['response_format']['type'] == format_type for body in chat.requests)

    inputs = [json.loads(body['messages'][0]['content'][0]['text'].split('TASK DATA:\n', 1)[1]) for body in chat.requests]
    assert 'description' not in inputs[0]['original_request']
    assert inputs[2]['original_request']['description'] == work.spec.description
    assert 'findings.0.text' in inputs[1]['validation_feedback']
    assert 'question' in inputs[1]['validation_feedback']
    assert 'Provider frame counts must be even' in inputs[4]['validation_feedback']
    assert all(field in inputs[6]['validation_feedback'] for field in ['appearance_contract', 'checkpoint.reason', 'structure_usage.part_ids', 'stages.0.prompt'])
    assert inputs[6]['previous_invalid_draft'] == bad_plan
    assert inputs[1]['previous_invalid_draft'] == bad_observation
    assert all('validation_feedback' not in inputs[index] for index in [0, 2, 3, 5])
    assert all('previous_invalid_draft' not in inputs[index] for index in [0, 2, 3, 5])
    assert all(peer['role'] != 'validator' for task in inputs for peer in task['peer_messages'])
    saved = workspace.load(work.id).model_dump_json()
    assert 'previous_invalid_draft' not in saved and 'invalid question' not in saved and '长' * 1001 not in saved


@pytest.mark.parametrize('budget,finish_reason,attempts', [(4, 'stop', 1), (8, 'stop', 2), (8, 'length', 1)])
def test_correction_cannot_overrun_budget_or_repeat_an_incomplete_response(wire_planner, budget, finish_reason, attempts):
    _, workspace, _ = wire_planner
    workspace.model.registry.save(ModelConfiguration())
    invalid = json.dumps({**observation(), 'question': []})
    chat = ChatFixture([(invalid, finish_reason)] * 3)
    work = workspace.create(spec(budget={'max_planning_calls': budget}), uuid.uuid4().hex, planning_authorized=True)
    with patch('sprite_pipeline.vision_review.httpx.Client', return_value=chat):
        work = workspace.plan(work.id)
        workspace.recover_planning()
    assert work.status == 'planning_failed'
    assert work.job_id is None and len(chat.requests) == attempts
    assert all(call['role'] == 'appearance' for call in work.planning_calls)


def test_timeout_is_archived_as_unknown_without_a_correction(wire_planner):
    _, workspace, _ = wire_planner
    workspace.model.registry.save(ModelConfiguration())
    work = workspace.create(spec(), uuid.uuid4().hex, planning_authorized=True)
    chat = ChatFixture([])
    with patch('sprite_pipeline.vision_review.httpx.Client', return_value=chat), \
            patch.object(chat, 'post', side_effect=httpx.ReadTimeout('isolated timeout')) as call:
        work = workspace.plan(work.id)
        workspace.recover_planning()
    assert work.status == 'planning_failed' and call.call_count == 1
    assert work.planning_calls[0]['state'] == 'outcome_unknown'
    assert work.planning_calls[0]['error_type'] == 'ReadTimeout'
    assert not work.messages


@pytest.mark.parametrize('inspect_motion', [False, True])
def test_revision_reuses_observations_when_their_inputs_match(setup, inspect_motion):
    _, workspace, planner, _, fixture = setup
    initial_spec = spec()
    initial = workspace.create(initial_spec, uuid.uuid4().hex, planning_authorized=True)
    original = planner.__call__

    def with_findings(role, work, *args, **kwargs):
        result, receipt = original(role, work, *args, **kwargs)
        if role in {'appearance', 'motion'}:
            result.update(observation())
        if inspect_motion and role == 'motion' and work.revision == 1 and kwargs['crop'] is None:
            result.update(action='inspect_reference', crop=[20, 10, 48, 58])
        return result, receipt

    def revise(previous, next_spec):
        revision = workspace.revise(previous.id, previous.revision, next_spec, uuid.uuid4().hex, planning_authorized=True)
        return workspace.plan(revision.id)

    with patch.object(type(planner), '__call__', side_effect=with_findings):
        initial = workspace.plan(initial.id)
        retry = revise(initial, initial_spec)
        changed = revise(retry, spec('角色摘帽后侧身鞠躬，最后保持低头'))
        fixture.write_frame(fixture.reference_path, shift_x=1)
        changed_reference = revise(changed, changed.spec)

    assert all(work.status == 'ready' for work in [initial, retry, changed, changed_reference])
    assert [call['role'] for call in retry.planning_calls] == ['strategy', 'coordinator']
    assert [call['role'] for call in changed.planning_calls] == ['motion', 'strategy', 'coordinator']
    assert [call['role'] for call in changed_reference.planning_calls] == ['appearance', 'motion', 'strategy', 'coordinator']
    assert changed.messages[0]['reused_from'] == {
        'revision': 1, 'call': 1, 'request_id': initial.planning_calls[0]['request_id']}
    motion_origin = retry.messages[1]['reused_from']
    assert motion_origin['call'] == (3 if inspect_motion else 2)
    assert initial.planning_calls[motion_origin['call'] - 1]['crop'] == ([20, 10, 48, 58] if inspect_motion else None)
    assert workspace.load(initial.id, 1).planning_calls == initial.planning_calls


def test_task_role_models_use_the_frozen_snapshot_without_changing_settings(wire_planner):
    service, workspace, _ = wire_planner
    registry = ModelRegistry(service.settings)
    original = registry.save(ModelConfiguration(default=ModelProfile(model='glm-5.3-flash')))
    client = TestClient(create_api(service=service))
    request = {'spec': spec().model_dump(mode='json'), 'request_key': uuid.uuid4().hex,
               'planning_authorized': True, 'planning_models': {'strategy': {'model': 'kimi-k3.1-pro', 'timeout_seconds': 350}}}
    rejected = client.post('/v1/open-motion', json={**request, 'planning_models': {'strategy': {'model': 'test-model', 'provider': 'openai'}}})
    assert rejected.status_code == 422
    assert workspace.listing() == []
    created = client.post('/v1/open-motion', json=request)
    assert created.status_code == 201, created.text
    work = created.json()
    assert registry.load() == original
    assert work['planning_config']['roles']['strategy'] == ModelProfile(model='kimi-k3.1-pro', timeout_seconds=350).model_dump()
    assert registry.profile('motion', work['planning_config']).model == 'glm-5.3-flash'
    registry.save(ModelConfiguration(default=ModelProfile(provider='openai', model='custom-model')))
    assert client.get('/v1/open-motion/settings').json()['planning_configured'] is False
    assert client.post('/v1/open-motion', json=request).json()['id'] == work['id']
    assert client.post('/v1/open-motion', json={**request, 'planning_models': {'strategy': {'model': 'other-model'}}}).status_code == 409

    original_work = workspace.load(work['id'])
    original_work.status = 'planning_failed'
    workspace.save(original_work)
    url = f"/v1/open-motion/{work['id']}/revise"
    revision = {**request, 'expected_revision': 1, 'request_key': uuid.uuid4().hex}
    assert client.post(url, json=revision).status_code == 422
    revision.pop('planning_models')
    response = client.post(url, json=revision)
    assert response.status_code == 200, response.text
    assert response.json()['planning_config'] == work['planning_config']
    assert registry.load().default.model == 'custom-model'
