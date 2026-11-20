import json
import shutil
import io
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.checkpoints import Checkpoints, review_call_count
from sprite_pipeline.collaboration.contracts import digest
from sprite_pipeline.collaboration.experiment import (
    ARMS, MODEL_ONLY_REVIEWER, blind_pack, clone_for_arm, collect_clips, counterfactual_verdicts,
    drive_model_only, freeze_protocol, inventory, legacy_export, load_protocol, main, repair_window,
    retrospective, run_arm, sha)
from sprite_pipeline.collaboration.execution import stage_seed
from sprite_pipeline.collaboration.experiment_policy import REFUSAL
from sprite_pipeline.collaboration.experiment_requests import freeze_drawing
from sprite_pipeline.collaboration.repairs import LocalRepairs, generation_calls
from sprite_pipeline.collaboration.workspace import OpenMotionWorkspace
from sprite_pipeline.errors import ProviderConfigurationError, ValidationHarnessError
from sprite_pipeline.providers.base import PollStatus
from sprite_pipeline.providers.fixture import FixtureProvider
from test_interactable_state_chain import ARCHIVE, ArchiveProvider, chain, decide  # noqa: F401


class Recording(FixtureProvider):
    def __init__(self):
        super().__init__()
        self.requests = []

    def submit(self, request):
        self.requests.append(request)
        return super().submit(request)


class ReturnedFrames(Recording):
    def __init__(self, shape):
        super().__init__()
        self.shape = shape

    def wait(self, identity):
        result = super().wait(identity)
        usage = {'type': 'generations', 'generations': 2}
        if self.shape == 'provider_failed':
            return replace(result, status=PollStatus.failed, images=[], usage=usage,
                           error={'code': 'provider_job_failed', 'message': 'fixture failure'})
        images = result.images
        if self.shape == 'extra_context':
            images = [self.requests[-1].reference_image, *images]
        if self.shape == 'extra_pose':
            with Image.open(io.BytesIO(images[0])) as frame:
                extra = Image.new('RGBA', frame.size, '#ff00ff')
            encoded = io.BytesIO()
            extra.save(encoded, format='PNG')
            images = [encoded.getvalue(), *images]
        return replace(result, images=images, usage=usage)


class UntrimmedArchive(ArchiveProvider):
    """The policy keeps each whole segment, so the next slice starts at its last frame."""

    def submit(self, request):
        receipt = super().submit(request)
        if len(self.inputs) == 2:
            self.outputs[receipt.provider_job_id] = self.archive[4:9]
        return receipt


def finish(chain):
    service, work, engine, provider, client = chain
    decide(client, 0, 'accept', 2)
    engine.advance(work.job_id, provider, wait=True)
    decide(client, 1, 'accept')
    return engine.advance(work.job_id, provider, wait=True)


def test_four_offline_arms_and_anonymous_playback(tmp_path):
    src = (ARCHIVE / 'lamp/A.png').read_bytes()
    stages = [{'prompt': 'light begins', 'frames': 4}, {'prompt': 'hold steady', 'frames': 4}]
    roots = []
    for arm in ARMS:
        verdicts = iter(['fail', 'pass', 'pass'])
        out = tmp_path / arm
        run = run_arm(arm, src, stages, 42, FixtureProvider(), lambda *_: next(verdicts), out)
        assert len(run['frames']) == 8 and run['diagnostic_only'] and run['origin'] == {'kind': 'manual'}
        assert len(run['calls']) == {'single': 1, 'blind': 2, 'keyframe_first': 4, 'model_only': 3}[arm]
        if arm == 'keyframe_first':
            assert all(x['last'] for x in run['calls'][2:])
        if arm == 'blind':
            assert run['calls'][1]['first'] == run['frames'][3]['sha256'] and not run['reviews']
            assert [c['seed'] for c in run['calls']] == [stage_seed(42, 0), stage_seed(42, 1)]
        if arm == 'model_only':
            assert run['calls'][1]['kind'] == 'repair' and len(run['reviews']) == 3
        roots.append(out)
    stopped = run_arm('model_only', src, stages, 42, FixtureProvider(), lambda *_: 'uncertain', tmp_path / 'stopped')
    assert stopped['status'] == 'stopped_by_review' and len(stopped['calls']) == 2 and not stopped['frames']

    # A run the reviewer stopped has no clip, yet stays in the denominator.
    clips, excluded = collect_clips([*roots, tmp_path / 'stopped'])
    assert len(clips) == 4 and excluded == [{'source': str(tmp_path / 'stopped'), 'arm': 'model_only',
                                             'status': 'stopped_by_review', 'protocol': 3, 'outcome': stopped['outcome']}]
    pack = tmp_path / 'blind-public'
    blind_pack(clips, pack, excluded=excluded)
    assert len(list(pack.glob('*/*.png'))) == 32
    key = json.loads((tmp_path / 'blind-public-private-key.json').read_bytes())
    assert len(key['clips']) == 4 and key['runs'] == 5 and key['excluded'] == excluded
    assert sorted(v['arm'] for v in key['clips'].values()) == sorted(ARMS)
    public = (pack / 'clips.json').read_bytes() + (pack / 'index.html').read_bytes()
    assert not any(arm.encode() in public for arm in ARMS) and str(tmp_path).encode() not in public


def test_control_arms_send_the_pipeline_requests(chain, tmp_path):
    service, work, engine, provider, client = chain
    protocol = freeze_protocol(service, work.id, None, tmp_path / 'protocol')
    job = service.store.load(work.job_id)
    assert protocol['seed'] == job.candidates[0].seed and protocol['source']['job_id'] == job.job_id
    frozen, reference, last_frames = load_protocol(tmp_path / 'protocol')
    recorder = Recording()
    run = run_arm('blind', reference, frozen['stages'], frozen['seed'], recorder, None, tmp_path / 'blind',
                  frozen['fps'], last_frames=last_frames, protocol=frozen)
    assert run['fps'] == job.action.fps and run['origin']['plan_sha256'] == work.plan_sha256
    assert run['protocol_sha256'] == frozen['protocol_sha256'] and run['protocol'] == 3
    assert run['requests'] == frozen['drawing']['arms']['blind']['requests']
    drawing = frozen['drawing']['arms']
    assert drawing['single']['requests'][0]['prompt'] == ' '.join(stage['prompt'] for stage in frozen['stages'])
    assert drawing['keyframe_first']['requests'][0]['prompt'] == 'Hold ending pose: ' + frozen['stages'][0]['prompt']
    for arm in ('model_only', 'human_verified'):
        assert drawing[arm]['requests'][1]['first']['kind'] == 'accepted_endpoint'

    finish(chain)
    for stage, request in enumerate(recorder.requests):
        intent = json.loads((engine.directory(work.job_id, 1, stage) / 'submit.intent.json').read_text())
        assert (request.prompt, request.frame_count, request.seed) == (intent['prompt'], intent['frame_count'], intent['seed'])
        assert (sha(request.last_frame) if request.last_frame else None) == intent['last_sha256']
    # Only the continuation input differs: the pipeline continues from the frame a person confirmed.
    first = json.loads((engine.directory(work.job_id, 1, 0) / 'submit.intent.json').read_text())
    assert sha(recorder.requests[0].reference_image) == first['first_sha256']
    assert sha(recorder.requests[1].reference_image) == run['frames'][3]['sha256']

    frozen['drawing']['arms']['blind']['requests'][0]['prompt'] = 'Changed after freezing'
    (tmp_path / 'protocol/protocol.json').write_text(json.dumps(frozen), encoding='utf8')
    with pytest.raises(ValueError, match='drawing requests changed'):
        load_protocol(tmp_path / 'protocol')
    (tmp_path / 'protocol/protocol.json').write_text(json.dumps(protocol), encoding='utf8')
    (tmp_path / 'protocol/reference.png').write_bytes(b'changed')
    with pytest.raises(ValueError):
        load_protocol(tmp_path / 'protocol')


@pytest.mark.parametrize(('shape', 'indices'), [('exact', [0, 1, 2, 3]), ('extra_context', [1, 2, 3, 4]), ('extra_pose', None)])
def test_same_raw_frames_get_same_interpretation_in_production_and_controls(chain, tmp_path, shape, indices):
    service, work, engine, _, _ = chain
    copy = clone_for_arm(service, work.id, None, 'human_verified', 'paper-shape-' + shape)
    workspace = OpenMotionWorkspace(service)
    started = workspace.start(copy.id, copy.revision, copy.plan_sha256)
    provider = ReturnedFrames(shape)
    reference = workspace.reference(copy)
    stages = [{'prompt': copy.experiment['frozen_drawing']['requests'][0]['prompt'], 'frames': 4}]
    replay = tmp_path / ('replay-' + shape)
    if indices is None:
        with pytest.raises(ValidationHarnessError) as production_error:
            engine.advance(started.job_id, provider, wait=True)
        with pytest.raises(ValidationHarnessError) as control_error:
            run_arm('blind', reference, stages, copy.spec.seed, ReturnedFrames(shape), None, replay)
        assert production_error.value.details == control_error.value.details == {
            'reason': 'unexpected_extra_frame', 'raw_count': 5, 'requested_count': 4, 'normalization': 'input_pose_v1',
        }
    else:
        engine.advance(started.job_id, provider, wait=True)
        run_arm('blind', reference, stages, copy.spec.seed, ReturnedFrames(shape), None, replay)
        view = Checkpoints(service).view(started.job_id, 1, 0)
        assert [frame['raw_index'] for frame in view['frames']] == indices

    run = json.loads((replay / 'run.json').read_bytes())
    call = run['calls'][0]
    assert call['id'] and call['submission_receipt'] and call['poll_receipt']
    assert call['usage'] == {'type': 'generations', 'generations': 2}
    assert call['raw_count'] == len(call['frames']) == (4 if shape == 'exact' else 5)
    assert all(sha((replay / frame['file']).read_bytes()) == frame['sha256'] for frame in call['frames'])
    manifest = json.loads((engine.directory(started.job_id, 1, 0) / 'frames.json').read_bytes())
    assert manifest['usage'] == call['usage']
    assert [f['sha256'] for f in manifest['frames']] == [f['sha256'] for f in call['frames']]
    if indices is None:
        assert run['outcome']['kind'] == 'provider_failure' and not run['frames']
        assert run['outcome']['reason'] == 'unexpected_extra_frame'
    else:
        assert call['playback_raw_indices'] == indices
        assert [f['sha256'] for f in run['frames']] == [call['frames'][i]['sha256'] for i in indices]


@pytest.mark.parametrize(('arm', 'sizes'), [('single', (500, 499)), ('keyframe_first', (982,))])
def test_final_prompt_at_provider_boundary_is_frozen_or_excluded_before_any_draw(tmp_path, arm, sizes):
    source = (ARCHIVE / 'lamp/A.png').read_bytes()
    for delta in (0, 1):
        prompts = ['a' * (size + (delta if i == 0 else 0)) for i, size in enumerate(sizes)]
        stages = [{'prompt': prompt, 'frames': 4} for prompt in prompts]
        recorder = Recording()
        out = tmp_path / str(delta)
        run = run_arm(arm, source, stages, 42, recorder, None, out)
        assert len(run['requests'][0]['prompt']) == 1000 + delta
        if not delta:
            assert run['status'] == 'complete' and recorder.requests[0].prompt == run['requests'][0]['prompt']
        else:
            assert run['status'] == 'blocked_preflight' and run['outcome']['kind'] == 'local_preflight'
            assert run['outcome']['reason'] == 'prompt_length' and recorder.requests == run['calls'] == []
            clips, excluded = collect_clips([out])
            assert not clips and excluded[0]['outcome'] == run['outcome']
            blind_pack(clips, tmp_path / 'excluded-only', excluded=excluded)
            key = json.loads((tmp_path / 'excluded-only-private-key.json').read_bytes())
            assert key['runs'] == 1 and key['excluded'] == excluded


def test_v2_frozen_protocol_keeps_legacy_frame_policy_and_exclusion_format(tmp_path):
    folder = tmp_path / 'protocol-v2'
    folder.mkdir()
    source = (ARCHIVE / 'lamp/A.png').read_bytes()
    (folder / 'reference.png').write_bytes(source)
    protocol = {'protocol': 2, 'seed': 7, 'fps': 8, 'stages': [{'prompt': 'Light the lens', 'frames': 4}],
                'reference_sha256': sha(source), 'source': {'work_id': 'legacy', 'revision': 1}}
    (folder / 'protocol.json').write_text(json.dumps(protocol), encoding='utf8')
    loaded, reference, last = load_protocol(folder)
    assert loaded == protocol
    replay = tmp_path / 'legacy'
    with pytest.raises(ValueError, match='unexpected provider result'):
        run_arm('blind', reference, loaded['stages'], 7, ReturnedFrames('extra_context'), None, replay,
                last_frames=last, protocol=loaded)
    run = json.loads((replay / 'run.json').read_bytes())
    assert run['protocol'] == 2 and not run['frames'] and not run['calls'][0]['frames']
    assert collect_clips([replay]) == ([], [{'source': str(replay), 'arm': 'blind', 'status': 'interrupted'}])


def test_experiment_keeps_usage_on_provider_failure_and_classifies_pre_post_rejection(tmp_path):
    source = (ARCHIVE / 'lamp/A.png').read_bytes()
    stages = [{'prompt': 'Light the lens', 'frames': 4}]
    failed = tmp_path / 'provider-failed'
    with pytest.raises(ValueError, match='unexpected provider result'):
        run_arm('blind', source, stages, 7, ReturnedFrames('provider_failed'), None, failed)
    run = json.loads((failed / 'run.json').read_bytes())
    assert run['outcome'] == {'kind': 'provider_failure', 'reason': 'provider_job_failed', 'stage': 0}
    assert run['calls'][0]['id'] and run['calls'][0]['usage']['generations'] == 2

    class Unconfigured(Recording):
        def submit(self, request):
            raise ProviderConfigurationError('Offline configuration gate before POST')

    unsubmitted = tmp_path / 'unsubmitted'
    with pytest.raises(ProviderConfigurationError):
        run_arm('blind', source, stages, 7, Unconfigured(), None, unsubmitted)
    run = json.loads((unsubmitted / 'run.json').read_bytes())
    assert run['outcome']['kind'] == 'not_submitted' and run['calls'][0]['id'] is None


def test_optional_diagnostic_redraw_respects_budget_reserved_for_later_stages(tmp_path):
    source = (ARCHIVE / 'lamp/A.png').read_bytes()
    with Image.open(io.BytesIO(source)) as reference:
        size = reference.size
    stages = [{'prompt': 'Activate the light', 'frames': 4}, {'prompt': 'Hold the light', 'frames': 4}]
    protocol = {'protocol': 3, 'seed': 7, 'fps': 8, 'stages': stages, 'reference_sha256': sha(source), 'source': {},
                'drawing': freeze_drawing(stages, 7, sha(source), size, [None, None], budget={'max_generation_calls': 2})}
    protocol['protocol_sha256'] = digest(protocol)
    provider = Recording()
    run = run_arm('model_only', source, stages, 7, provider, lambda *_: 'uncertain', tmp_path / 'reserved',
                  protocol=protocol)
    assert run['status'] == 'blocked_preflight' and run['outcome']['reason'] == 'max_generation_calls'
    assert len(provider.requests) == 1
    assert run['calls'][1]['kind'] == 'repair' and run['calls'][1]['state'] == 'not_submitted'


def test_model_only_copy_runs_the_same_plan_without_a_person(chain):
    service, work, engine, provider, client = chain
    ws = OpenMotionWorkspace(service)
    with pytest.raises(ValidationHarnessError):
        drive_model_only(service, work.id, ArchiveProvider(), authorized=True)  # an ordinary work
    copy = clone_for_arm(service, work.id, None, 'model_only', 'paper-model-only-1')
    assert clone_for_arm(service, work.id, None, 'model_only', 'paper-model-only-1').id == copy.id
    assert copy.id != work.id and copy.plan_sha256 == work.plan_sha256 and not copy.job_id
    assert copy.spec.seed == service.store.load(work.job_id).candidates[0].seed
    assert copy.experiment['source_work'] == work.id and ws.load(work.id).experiment is None
    with pytest.raises(ValidationHarnessError):
        drive_model_only(service, copy.id, ArchiveProvider(), authorized=False)

    summary = drive_model_only(service, copy.id, UntrimmedArchive(), authorized=True)
    assert summary['status'] == 'complete'
    assert [(d['stage'], d['action']) for d in summary['decisions']] == [(0, 'accept'), (1, 'accept')]
    job = service.store.load(summary['job_id'])
    runs = job.candidates[0].plan_execution.stages
    assert all(r.accepted['reviewer'] == MODEL_ONLY_REVIEWER for r in runs) and job.candidates[0].frames
    for stage in range(2):
        mine, theirs = (json.loads((engine.directory(j, 1, stage) / 'submit.intent.json').read_text())
                        for j in (summary['job_id'], work.job_id))
        if stage == 0 or theirs:
            assert (mine['prompt'], mine['seed'], mine['frame_count']) == (theirs['prompt'], theirs['seed'], theirs['frame_count'])
        if stage == 0:
            break  # the source job has not drawn its second segment in this fixture

    # A non-pass verdict on a segment too short to redraw stops the run.
    service.open_motion_review_registry.clean = False
    refused = clone_for_arm(service, work.id, None, 'model_only', 'paper-model-only-2')
    stopped = drive_model_only(service, refused.id, ArchiveProvider(), authorized=True)
    assert stopped['status'] == 'stopped_by_review'
    assert stopped['decisions'] == [{'stage': 0, 'action': 'reject', 'verdict': 'fail', 'reason': 'segment too short to redraw'}]
    assert not service.store.load(stopped['job_id']).candidates[0].frames
    assert [repair_window(n) for n in (4, 5, 6, 8, 9, 16)] == [None, None, (1, 4), (1, 6), (1, 6), (1, 14)]


def test_redraw_only_copy_refuses_other_repair_tools(chain):
    service, work, engine, provider, client = chain
    copy = clone_for_arm(service, work.id, None, 'human_verified', 'paper-redraw-only', repair_policy='redraw_only')
    ws = OpenMotionWorkspace(service)
    started = ws.start(copy.id, 1, copy.plan_sha256)
    fresh = ArchiveProvider()
    engine.advance(started.job_id, fresh, wait=True)
    api = TestClient(create_api(service=service), base_url='http://testserver/v1/open-motion/' + copy.id + '/')
    context = api.get('adjustments', params={'revision': 1, 'candidate': 1, 'stage': 0}).json()
    region = {'frame': 1, 'source_sha256': context['frames'][1]['sha256'], 'spans': [{'start': 0, 'length': 1}]}
    body = {'expected_revision': 1, 'candidate_index': 1, 'stage_index': 0, 'token': context['token'],
            'request_key': 'redraw-only-local', 'description': 'One pixel',
            'palette': [{'source': '#808080', 'target': '#00ff00'}], 'frames': [{'region': region}]}
    response = api.post('local-frame-edits', json=body)
    assert response.status_code >= 400 and REFUSAL in response.text
    view = api.get('candidates/1/stages/0').json()
    for mode in ('appearance', 'transition'):
        with pytest.raises(ValidationHarnessError, match='只允许整段重画'):
            LocalRepairs(service).create(started.job_id, 1, 0, token=view['token'], start=1, end=2, note='Fix the lens',
                                         mode=mode, request_key='redraw-only-' + mode, authorized=True, provider=fresh)
    generated = {'expected_revision': 1, 'candidate_index': 1, 'stage_index': 0, 'token': context['token'], 'start': 1,
                 'end': 2, 'user_request': 'Brighten the lens', 'request_key': 'redraw-only-window', 'authorized': True,
                 'max_planning_calls': 1, 'max_generation_calls': 1, 'max_review_calls': 5}
    response = api.post('adjustments', json=generated)
    assert response.status_code >= 400 and REFUSAL in response.text
    assert api.get('adjustments', params={'revision': 1, 'candidate': 1, 'stage': 0}).json()['tasks'] == []
    # The unrestricted source work is untouched by the copy's policy.
    assert client.post('local-frame-edits', json={**body, 'token': client.get(
        'adjustments', params={'revision': 1, 'candidate': 1, 'stage': 0}).json()['token']}).status_code == 200


def test_review_ablation_is_recomputed_from_the_stored_report():
    def check(dimension, status, confidence=.95):
        return {'dimension': dimension, 'status': status, 'confidence': confidence, 'frames': [1, 2], 'evidence': 'e'}
    held = check('transition', 'uncertain', 0)
    report = {'verdict': 'uncertain', 'checks': [check('state_frame', 'pass'), held, check('fixed_parts', 'pass')],
              'expert_review': {'state': 'complete', 'baseline': {'verdict': 'fail'}, 'requires_human_adjudication': [
                  {'dimension': 'transition', 'prior': check('transition', 'fail'), 'proposal': check('transition', 'pass')}]}}
    assert counterfactual_verdicts(report) == {'full': 'uncertain', 'baseline_only': 'fail',
                                               'final_review_wins': 'pass', 'retained_contradictions': 1}
    plain = {'verdict': 'pass', 'checks': report['checks']}
    assert counterfactual_verdicts(plain) == {'full': 'pass', 'baseline_only': None, 'final_review_wins': None,
                                              'retained_contradictions': 0}
    assert counterfactual_verdicts({}) is None


def test_retrospective_budget_and_human_time(chain, tmp_path):
    service, work, engine, provider, client = chain
    evidence = client.get('candidates/1/stages/0').json()
    decision = {'expected_revision': 1, 'stage_index': 0, 'candidate_index': 1, 'token': evidence['token'],
                'note': 'Scripted recorded review', 'decision': 'accept', 'acknowledge_warnings': True,
                'human_seconds': 12, 'anchor_frame': 2, 'acknowledge_trim': True}
    assert client.post('review-stage', json=decision).status_code == 200
    engine.advance(work.job_id, provider, wait=True)
    decide(client, 1, 'accept')
    job = engine.advance(work.job_id, provider, wait=True)
    ws = OpenMotionWorkspace(service)
    job_dir = service.store.job_dir(job.job_id)
    cost = retrospective(job_dir, ws.load(work.id).model_dump(mode='json'), ws.directory(work.id) / 'adjustments', tmp_path / 'export')
    assert cost['calls'] == {'planning': len(ws.load(work.id).planning_calls), 'generation': generation_calls(job),
                             'review': review_call_count(job)}
    assert cost['known_human_seconds'] == 12 and cost['human_seconds'] is None and cost['unmeasured_decisions'] == 1
    assert cost['total_usd'] is None and cost['unpriced_calls'] > 0
    result = json.loads((tmp_path / 'export' / 'retrospective.json').read_bytes())
    assert len(result['stages']) == 2 and len(result['clips']) == 1 and all(st['raw'] and st['accepted'] for st in result['stages'])
    assert result['kind'] == 'open_plan' and result['experiment'] is None and result['tool_usage'] == {}
    assert all(row['review_ablation'][-1]['full'] == row['review_history'][-1]['verdict'] for row in result['stages'])

    rows = inventory(job_dir.parent)
    assert [(r['job'], r['export'], r['stages'], r['human_decisions']) for r in rows] == [(job.job_id, 'full', 2, 2)]

    # A job from before open plans: whole clips only, and the full export says why it refuses.
    legacy = tmp_path / 'jobs' / job.job_id
    shutil.copytree(job_dir, legacy)
    record = json.loads((legacy / 'job.json').read_bytes())
    record['request']['open_plan'] = None
    (legacy / 'job.json').write_text(json.dumps(record), encoding='utf8')
    assert inventory(tmp_path / 'jobs')[0]['export'] == 'legacy'
    with pytest.raises(ValueError, match='legacy export'):
        retrospective(legacy, ws.load(work.id).model_dump(mode='json'), tmp_path / 'none', tmp_path / 'refused')
    main(['export-legacy', str(legacy), str(tmp_path / 'legacy-export')])
    exported = json.loads((tmp_path / 'legacy-export/retrospective.json').read_bytes())
    assert exported['kind'] == 'legacy' and len(exported['clips'][0]['frames']) == len(job.candidates[0].frames)
    clips, excluded = collect_clips([tmp_path / 'export', tmp_path / 'legacy-export'])
    assert len(clips) == 2 and not excluded


def test_model_only_redraws_once_then_accepts(tmp_path, monkeypatch):
    from sprite_pipeline.collaboration.contracts import TaskSpec
    from test_interactable_motion import workspace_for
    from test_interactable_state_chain import LampPlanner

    class LongFirstSegment(LampPlanner):
        def __call__(self, role, work, reference, **kwargs):
            result, receipt = super().__call__(role, work, reference, **kwargs)
            if role == 'coordinator':
                result['plan']['stages'][0]['frame_count'] = 6
            return result, receipt

    class Redrawn(FixtureProvider):
        diagnostic_only = False
        archive = [p.read_bytes() for p in sorted((ARCHIVE / 'lamp/seed-2202').glob('f*.png'))]

        def __init__(self):
            super().__init__()
            self.outputs = {}

        def submit(self, request):
            receipt = super().submit(request)
            # Segment one (input frame + 6), its interior redraw, then segment two from the kept last frame.
            slices = [self.archive[:7], self.archive[1:5], self.archive[6:11]]
            self.outputs[receipt.provider_job_id] = slices[len(self.outputs)]
            if len(self.outputs) == 2:
                service.open_motion_review_registry.clean = True  # the redraw satisfies the scripted reviewer
            return replace(receipt, diagnostic_only=False)

        def poll(self, identity):
            return replace(super().poll(identity), images=self.outputs[identity], diagnostic_only=False)

    service, ws = workspace_for(tmp_path, 'lamp', seed=2202)
    ws.model = LongFirstSegment('lamp')
    provider = Redrawn()
    monkeypatch.setattr('sprite_pipeline.providers.get_provider', lambda *args: provider)
    spec = TaskSpec(object_type='interactable', object_id='lamp', provider='fixture', seed=77,
                    description='Light the grey lens in two steps, from partly lit to fully green.')
    plan = ws.plan(ws.create(spec, 'offline-lamp-redraw', planning_authorized=True).id)
    assert plan.status == 'ready', plan.message
    copy = clone_for_arm(service, plan.id, None, 'model_only', 'paper-model-only-redraw')
    service.open_motion_review_registry.clean = False
    summary = drive_model_only(service, copy.id, provider, authorized=True)
    assert [(d['stage'], d['action']) for d in summary['decisions']] == [
        (0, 'redraw'), (0, 'adopt_repair'), (0, 'accept'), (1, 'accept')], summary
    assert summary['status'] == 'complete' and summary['decisions'][0]['window'] == [1, 4]
    job = service.store.load(summary['job_id'])
    attempt = job.candidates[0].plan_execution.stages[0].repairs[0]
    assert attempt['repair_level'] == 'window_redraw' and attempt['state'] == 'accepted'
    assert attempt['seed'] == stage_seed(77, 0) and job.candidates[0].seed == 77
    export = tmp_path / 'export'
    retrospective(service.store.job_dir(job.job_id), ws.load(copy.id).model_dump(mode='json'), tmp_path / 'none', export)
    result = json.loads((export / 'retrospective.json').read_bytes())
    assert result['tool_usage'] == {'window_redraw': 1} and result['experiment']['arm'] == 'model_only'
