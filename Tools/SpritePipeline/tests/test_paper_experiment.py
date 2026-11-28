import base64
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
from sprite_pipeline.errors import ProviderConfigurationError, ProviderTemporaryError, ValidationHarnessError
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
    items = json.loads((pack / 'clips.json').read_bytes())
    assert all(item['width'] == 128 and item['height'] == 128 for item in items)
    html = (pack / 'index.html').read_text(encoding='utf8')
    assert 'image-rendering:pixelated' in html and '1x 原尺寸' in html and '最近邻放大' in html and 'data-set-bg=checker' in html


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
    assert run['cost']['attempts'] == run['cost']['priced_calls'] == 0


@pytest.mark.parametrize('identity', [None, 'upstream-charge'])
def test_replay_counts_ambiguous_charged_submit_once_even_without_upstream_id(tmp_path, identity):
    source = (ARCHIVE / 'lamp/A.png').read_bytes()
    stages = [{'prompt': 'Light the lens', 'frames': 4}, {'prompt': 'Hold position', 'frames': 4}]

    class Charged(Recording):
        def submit(self, request):
            if not self.requests:
                return super().submit(request)
            self.requests.append(request)
            raise ProviderTemporaryError('Provider acknowledged charge', details={
                'submission_unknown': True, 'response': {'usage': {'type': 'usd', 'usd': 1.25}},
                **({'provider_job_id': identity} if identity else {}),
            })

        def wait(self, identity):
            return replace(super().wait(identity), usage={'type': 'usd', 'usd': 1})

    out = tmp_path / 'charged'
    provider = Charged()
    with pytest.raises(ProviderTemporaryError):
        run_arm('blind', source, stages, 7, provider, None, out)
    run = json.loads((out / 'run.json').read_bytes())
    assert len(provider.requests) == 2 and run['outcome']['reason'] == 'submission_unknown'
    assert run['calls'][1]['id'] == identity and run['calls'][1]['usage']['usd'] == 1.25
    assert run['cost'] == {'attempts': 2, 'priced_calls': 2, 'unpriced_calls': 0,
                           'known_usd': 2.25, 'known_units': 0, 'total_usd': 2.25}
    clips, excluded = collect_clips([out])
    assert not clips and excluded[0]['status'] == 'interrupted'


@pytest.mark.parametrize('last_poll_error', [False, True])
def test_replay_retains_known_intermediate_poll_usage(tmp_path, last_poll_error):
    source = (ARCHIVE / 'lamp/A.png').read_bytes()
    stages = [{'prompt': 'Light the lens', 'frames': 4}]

    class PendingBill(Recording):
        polls = 0

        def poll(self, identity):
            self.polls += 1
            if self.polls == 1:
                return replace(super().poll(identity), status=PollStatus.pending, provider_status='processing',
                               images=[], usage={'type': 'usd', 'usd': 2.5})
            if last_poll_error:
                raise ProviderTemporaryError('Poll interrupted')
            return replace(super().poll(identity), usage={})

    out, provider = tmp_path / 'observed-usage', PendingBill()
    if last_poll_error:
        with pytest.raises(ProviderTemporaryError):
            run_arm('blind', source, stages, 7, provider, None, out)
    else:
        run_arm('blind', source, stages, 7, provider, None, out)
    run = json.loads((out / 'run.json').read_bytes())
    assert len(provider.requests) == 1 and provider.polls == 2
    assert run['calls'][0]['usage'] == {'type': 'usd', 'usd': 2.5}
    assert run['cost']['attempts'] == run['cost']['priced_calls'] == 1 and run['cost']['known_usd'] == 2.5


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
    src_ctx = client.get('adjustments', params={'revision': 1, 'candidate': 1, 'stage': 0}).json()
    frame_bytes = client.get('edit-source/1', params={'revision': 1, 'candidate': 1, 'stage': 0, 'token': src_ctx['token']}).content
    pixels = list(Image.open(io.BytesIO(frame_bytes)).convert('RGBA').getdata())
    vis_idx, vis_px = next((idx, px) for idx, px in enumerate(pixels) if px[3])
    vis_hex = '#%02x%02x%02x' % vis_px[:3]
    target_hex = '#00ff00' if vis_hex != '#00ff00' else '#ff00ff'
    vis_region = {'frame': 1, 'source_sha256': src_ctx['frames'][1]['sha256'], 'spans': [{'start': vis_idx, 'length': 1}]}
    # Zero-pixel no-op edits (transparent pixel or identical RGB mapping) are rejected.
    assert client.post('local-frame-edits', json={**body, 'token': src_ctx['token'], 'request_key': 'noop-transparent'}).status_code == 422
    assert client.post('local-frame-edits', json={
        **body, 'token': src_ctx['token'], 'request_key': 'noop-same-color',
        'palette': [{'source': vis_hex, 'target': vis_hex}], 'frames': [{'region': vis_region}],
    }).status_code == 422
    assert client.post('local-frame-edits', json={
        **body, 'token': src_ctx['token'], 'request_key': 'unrestricted-real-pixel',
        'palette': [{'source': vis_hex, 'target': target_hex}], 'frames': [{'region': vis_region}],
    }).status_code == 200


def test_review_ablation_is_recomputed_from_the_stored_report():
    from sprite_pipeline.collaboration.adjustment_comparison import bind_report
    from sprite_pipeline.collaboration.prop_measurements import guard_measurements

    def check(dimension, status, confidence=.95, frames=None):
        return {'dimension': dimension, 'status': status, 'confidence': confidence,
                'frames': [1, 2] if frames is None else frames, 'evidence': 'e'}
    held = check('transition', 'uncertain', 0)
    report = {'verdict': 'uncertain', 'checks': [check('state_frame', 'pass'), held, check('fixed_parts', 'pass')],
              'expert_review': {'state': 'complete', 'baseline': {'verdict': 'fail'}, 'requires_human_adjudication': [
                  {'dimension': 'transition', 'prior': check('transition', 'fail'), 'proposal': check('transition', 'pass')}]}}
    ablation = counterfactual_verdicts(report)
    assert {k: v for k, v in ablation.items() if k != 'checks_by_condition'} == {
        'full': 'uncertain', 'baseline_only': 'fail', 'without_probes': 'uncertain',
        'without_retention': 'pass', 'final_review_wins': 'pass',
        'retained_contradictions': 1, 'probe_overrides': 0, 'probe_override_details': [],
    }
    plain = {'verdict': 'pass', 'checks': [check('state_frame', 'pass'), check('transition', 'pass'), check('fixed_parts', 'pass')]}
    plain_ablation = counterfactual_verdicts(plain)
    assert {k: v for k, v in plain_ablation.items() if k != 'checks_by_condition'} == {
        'full': 'pass', 'baseline_only': None, 'without_probes': 'pass',
        'without_retention': None, 'final_review_wins': None,
        'retained_contradictions': 0, 'probe_overrides': 0, 'probe_override_details': [],
    }
    assert counterfactual_verdicts({}) is None

    # 2x2 decoupling: retained contradiction on transition + probe override on fixed_parts.
    guarded = guard_measurements(report, {'flags': {'fixed_parts': [3, 4]}})
    guarded['expert_review'] = {**report['expert_review'],
                                'requires_human_adjudication': [
                                    *report['expert_review']['requires_human_adjudication'],
                                    *guarded['requires_human_adjudication'],
                                ]}
    ablation = counterfactual_verdicts(guarded)
    assert ablation['full'] == 'uncertain'
    assert ablation['baseline_only'] == 'fail'
    assert ablation['without_probes'] == 'uncertain'
    assert ablation['without_retention'] == 'uncertain'
    assert ablation['final_review_wins'] == 'pass'
    assert ablation['retained_contradictions'] == 1
    assert ablation['probe_overrides'] == 1
    assert ablation['probe_override_details'][0]['dimension'] == 'fixed_parts'
    assert ablation['probe_override_details'][0]['frames'] == [3, 4]

    # Probe-only expert report: without_probes flips to pass while without_retention stays uncertain.
    probe_only = guard_measurements(
        {'verdict': 'pass', 'checks': [check('state_frame', 'pass'), check('transition', 'pass'), check('fixed_parts', 'pass')],
         'expert_review': {'state': 'complete', 'baseline': {'verdict': 'pass'}, 'requires_human_adjudication': []}},
        {'flags': {'transition': [4, 5]}},
    )
    po = counterfactual_verdicts(probe_only)
    assert (po['full'], po['without_probes'], po['without_retention'], po['final_review_wins']) == (
        'uncertain', 'pass', 'uncertain', 'pass')

    # Orthogonal adjustment comparison failure must never be washed out to pass when probe_overrides == 0.
    compared_fail = bind_report(
        {'state': 'complete', 'verdict': 'pass',
         'checks': [check('state_frame', 'pass'), check('transition', 'pass'), check('fixed_parts', 'pass')],
         'expert_review': {'state': 'complete', 'baseline': {'verdict': 'pass'}, 'requires_human_adjudication': []}},
        {'state': 'complete', 'verdict': 'fail', 'findings': {
            'change': {'status': 'pass', 'evidence': 'ok'},
            'preservation': {'status': 'fail', 'evidence': 'regressed'},
        }},
    )
    cf = counterfactual_verdicts(compared_fail)
    assert cf['probe_overrides'] == 0
    assert (cf['full'], cf['without_probes'], cf['without_retention'], cf['final_review_wins']) == (
        'fail', 'fail', 'fail', 'fail')

    # Dispute proposals must still satisfy grounded_audit distinct-frame minimums.
    thin_proposal = {'verdict': 'uncertain',
                     'checks': [check('state_frame', 'pass'), check('transition', 'uncertain', 0), check('fixed_parts', 'pass')],
                     'expert_review': {'state': 'complete', 'baseline': {'verdict': 'fail'},
                                       'requires_human_adjudication': [
                                           {'dimension': 'transition', 'prior': check('transition', 'fail'),
                                            'proposal': check('transition', 'pass', .99, frames=[2])}]}}
    thin = counterfactual_verdicts(thin_proposal, frame_count=4)
    assert thin['without_retention'] == 'uncertain' and thin['final_review_wins'] == 'uncertain'

    # Distinct probe frames on the same dimension are both counted; probe rollback cannot erase a retained contradiction.
    merged_archive = {
        'verdict': 'uncertain',
        'checks': [check('state_frame', 'pass'), check('transition', 'uncertain', 0), check('fixed_parts', 'pass')],
        'requires_human_adjudication': [
            {'source': 'deterministic_probe', 'dimension': 'transition', 'frames': [4, 5],
             'prior': check('transition', 'pass'), 'reason': '测量冲突'},
        ],
        'expert_review': {
            'state': 'complete', 'baseline': {'verdict': 'fail'},
            'requires_human_adjudication': [
                {'dimension': 'transition', 'prior': check('transition', 'fail'), 'proposal': check('transition', 'pass')},
                {'source': 'deterministic_probe', 'dimension': 'transition', 'frames': [2, 3],
                 'prior': check('transition', 'pass'), 'reason': '测量冲突'},
            ],
        },
    }
    ma = counterfactual_verdicts(merged_archive)
    assert ma['probe_overrides'] == 2 and ma['retained_contradictions'] == 1
    assert ma['without_probes'] == 'uncertain'

    # Legacy probe record without explicit source tag on a baseline-only report.
    legacy_probe = {'verdict': 'uncertain',
                    'checks': [check('state_frame', 'pass'), check('transition', 'uncertain', 0), check('fixed_parts', 'pass')],
                    'requires_human_adjudication': [
                        {'dimension': 'transition', 'frames': [4, 5, 6], 'prior': check('transition', 'pass'), 'reason': '测量冲突'}]}
    legacy_ablation = counterfactual_verdicts(legacy_probe)
    assert legacy_ablation['full'] == 'uncertain'
    assert legacy_ablation['without_probes'] == 'pass'
    assert legacy_ablation['probe_overrides'] == 1
    assert legacy_ablation['retained_contradictions'] == 0


def test_structured_brief_arms_deduplicate_single_and_extract_pose_without_truncation(tmp_path):
    source = (ARCHIVE / 'lamp/A.png').read_bytes()

    def brief(action, drive, path, poses, end, boundary, pad=''):
        return '\n'.join([
            'Appearance: Pixel-art bronze knight holding a straight silver sword in right hand with blue cape' + pad,
            f'Action: {action}',
            'Camera: Fixed side-view 2D pixel art camera centered on knight',
            'Facing: Body faces screen right while blade angle tracks swing arc',
            f'Drive: {drive}',
            'Support: Both boots planted firmly on ground shifting weight forward',
            f'Path: {path}',
            'Timing: Smooth acceleration across all segment frames without extra holds',
            f'Poses: {poses}',
            'Relations: Sword hilt stays gripped in right gauntlet while cape trails torso',
            f'End: {end}',
            f'Boundary: {boundary}',
        ])

    s0 = brief('Wind up overhead and draw sword back',
               'Shoulders coil back cleanly', 'Blade arcs upward behind head',
               'f2: knees bend; f6: sword raised behind shoulder',
               'Coiled overhead windup pose ready to strike', 'Continue. Momentum builds into strike')
    s1 = brief('Slash downward across torso and follow through low',
               'Hips drive right arm downward', 'Blade sweeps diagonally down in front',
               'f2: blade passes eye level; f6: low follow-through stance',
               'Low forward-leaning follow-through stance with sword down-right',
               'Settle. Weight stabilizes on front foot')
    assert len(s0) > 600 and len(s1) > 600 and len(s0) + len(s1) + 1 > 1000
    stages = [{'prompt': s0, 'frames': 8}, {'prompt': s1, 'frames': 8}]
    recorder = Recording()
    run = run_arm('single', source, stages, 42, recorder, None, tmp_path / 'single-structured')
    assert run['status'] == 'complete' and len(recorder.requests) == 1
    merged_prompt = recorder.requests[0].prompt
    assert len(merged_prompt) <= 1000 and merged_prompt.count('Appearance:') == 1
    assert 'f10: blade passes eye level' in merged_prompt and 'f14: low follow-through stance' in merged_prompt

    # If even deduplicated 12-line brief exceeds 1000 chars, never truncate silently.
    oversized = [
        {'prompt': brief('Wind up overhead and draw long sword back over shoulder with wide coil',
                         'Shoulders and waist coil back sharply before torso unwinds',
                         'Blade arcs smoothly upward and behind helmet in wide curve',
                         'f2: knees bend low; f6: sword raised high behind shoulder',
                         'Coiled overhead windup pose ready to strike', 'Continue. Momentum builds',
                         pad=' wearing weathered iron shoulder plates and embroidered sash'), 'frames': 8},
        {'prompt': brief('Slash diagonally downward across torso and follow through low to right',
                         'Hips, chest and shoulder drive right arm forcefully downward',
                         'Blade sweeps diagonally down in front of body toward ground',
                         'f2: blade passes eye level; f6: low follow-through stance',
                         'Low forward-leaning follow-through stance with sword extended down-right',
                         'Settle. Weight stabilizes cleanly on front foot',
                         pad=' wearing weathered iron shoulder plates and embroidered sash'), 'frames': 8},
    ]
    blocked_rec = Recording()
    blocked_run = run_arm('single', source, oversized, 42, blocked_rec, None, tmp_path / 'single-oversized')
    assert blocked_run['status'] == 'blocked_preflight' and blocked_run['outcome']['reason'] == 'prompt_length'
    assert blocked_rec.requests == []

    # Near-limit single stage (983..1000 chars) must not fail keyframe_first due to 18-char prefix.
    base_stage = s0
    pad_len = 990 - len(base_stage)
    long_stage = brief('Wind up overhead and draw sword back',
                       'Shoulders coil back cleanly', 'Blade arcs upward behind head',
                       'f2: knees bend; f6: sword raised behind shoulder',
                       'Coiled overhead windup pose ready to strike', 'Continue. Momentum builds into strike',
                       pad=' ' + ('x' * (pad_len - 1)))
    assert len(long_stage) == 990
    kf_rec = Recording()
    kf_run = run_arm('keyframe_first', source, [{'prompt': long_stage, 'frames': 8}], 42, kf_rec, None, tmp_path / 'kf-structured')
    assert kf_run['status'] == 'complete' and len(kf_rec.requests) == 2
    assert len(kf_rec.requests[0].prompt) <= 1000 and 'End: Coiled overhead windup pose ready to strike' in kf_rec.requests[0].prompt


def test_redraw_only_allows_maximal_even_stage_redraw_on_unlocked_even_segment(tmp_path, monkeypatch):
    from sprite_pipeline.collaboration.adjustments import Adjustments
    from sprite_pipeline.collaboration.contracts import TaskSpec
    from test_interactable_motion import workspace_for
    from test_interactable_state_chain import LampPlanner

    class EightFrameFirstStage(LampPlanner):
        def __call__(self, role, work, reference, **kwargs):
            result, receipt = super().__call__(role, work, reference, **kwargs)
            if role == 'coordinator':
                result['plan']['stages'][0]['frame_count'] = 8
            return result, receipt

    service, ws = workspace_for(tmp_path, 'lamp', seed=2202)
    ws.model = EightFrameFirstStage('lamp')
    spec = TaskSpec(object_type='interactable', object_id='lamp', provider='fixture', seed=42,
                    description='Light the grey lens in two steps, from partly lit to fully green.')
    plan = ws.plan(ws.create(spec, 'redraw-only-8f', planning_authorized=True).id)
    assert plan.status == 'ready', plan.message
    copy = clone_for_arm(service, plan.id, None, 'human_verified', 'paper-redraw-only-8f', repair_policy='redraw_only')
    started = ws.start(copy.id, 1, copy.plan_sha256)
    provider = FixtureProvider()
    from sprite_pipeline.collaboration.execution import PlanGeneration
    PlanGeneration(service).advance(started.job_id, provider, wait=True)

    api = TestClient(create_api(service=service), base_url='http://testserver/v1/open-motion/' + copy.id + '/')
    context = api.get('adjustments', params={'revision': 1, 'candidate': 1, 'stage': 0}).json()
    assert context['locked_frames'] == [0] and len(context['frames']) == 8

    # Interior partial 4-frame window is still refused under redraw_only.
    partial = {'expected_revision': 1, 'candidate_index': 1, 'stage_index': 0, 'token': context['token'],
               'start': 1, 'end': 4, 'user_request': 'Fix glow', 'request_key': 'redraw-partial-refused',
               'authorized': True, 'max_planning_calls': 1, 'max_generation_calls': 1, 'max_review_calls': 5}
    assert api.post('adjustments', json=partial).status_code >= 400

    # Maximal legal even window (6 editable frames [1..6], or unlocked tail [2..7]) succeeds and records stage_redraw.
    whole = {**partial, 'start': 1, 'end': 6, 'request_key': 'redraw-whole-allowed'}
    created = api.post('adjustments', json=whole)
    assert created.status_code == 200, created.text
    task = created.json()['adjustment']
    manager = Adjustments(service)
    finished = manager.advance(copy.id, task['id'], provider)
    assert finished['state'] == 'ready' and finished['repair_level'] == 'stage_redraw'
    # Reject first attempt and confirm tail-anchored maximal even window [2..7] also qualifies.
    rejected = api.post(f"adjustments/{task['id']}/decision", json={
        'token': finished['preview_token'], 'decision': 'reject', 'note': 'Try tail redraw'})
    assert rejected.status_code == 200, rejected.text
    tail_ctx = api.get('adjustments', params={'revision': 1, 'candidate': 1, 'stage': 0}).json()
    tail_whole = {**partial, 'token': tail_ctx['token'], 'start': 2, 'end': 7, 'request_key': 'redraw-tail-allowed'}
    tail_created = api.post('adjustments', json=tail_whole)
    assert tail_created.status_code == 200, tail_created.text
    tail_done = manager.advance(copy.id, tail_created.json()['adjustment']['id'], provider)
    assert tail_done['state'] == 'ready' and tail_done['repair_level'] == 'stage_redraw'
    export = tmp_path / 'redraw-only-export'
    retrospective(service.store.job_dir(started.job_id), ws.load(copy.id).model_dump(mode='json'),
                  ws.directory(copy.id) / 'adjustments', export)
    summary = json.loads((export / 'retrospective.json').read_bytes())
    assert summary['tool_usage'] == {'stage_redraw': 2}


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


@pytest.mark.parametrize('scenario', ['accepted', 'second_non_pass', 'failed', 'unknown_submission',
                                      'budget_10', 'first_review_failed'])
def test_model_only_redraw_preserves_actual_review_and_drawing_outcome(tmp_path, monkeypatch, scenario):
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
            self.attempts = 0
            self.repair_id = None

        def submit(self, request):
            self.attempts += 1
            receipt = super().submit(request)
            # Segment one (input frame + 6), its interior redraw, then segment two from the kept last frame.
            slices = [self.archive[:7], self.archive[1:5], self.archive[6:11]]
            self.outputs[receipt.provider_job_id] = slices[self.attempts - 1]
            if self.attempts == 2:
                self.repair_id = receipt.provider_job_id
                if scenario == 'unknown_submission':
                    raise ProviderTemporaryError('fixture charged without a confirmed repair result', details={
                        'submission_unknown': True, 'provider_job_id': self.repair_id,
                        'response': {'usage': {'type': 'usd', 'usd': 2.5}},
                    })
                service.open_motion_review_registry.clean = scenario == 'accepted'
            return replace(receipt, diagnostic_only=False)

        def poll(self, identity):
            result = super().poll(identity)
            if identity == self.repair_id and scenario == 'failed':
                return replace(result, status=PollStatus.failed, provider_status='failed', images=[],
                               error={'code': 'provider_job_failed'}, usage={'type': 'usd', 'usd': 2.5})
            return replace(result, images=self.outputs[identity], diagnostic_only=False)

    service, ws = workspace_for(tmp_path, 'lamp', seed=2202)
    ws.model = LongFirstSegment('lamp')
    provider = Redrawn()
    monkeypatch.setattr('sprite_pipeline.providers.get_provider', lambda *args: provider)
    spec = TaskSpec(object_type='interactable', object_id='lamp', provider='fixture', seed=77,
                    budget={'max_total_frames': 10 if scenario == 'budget_10' else 14},
                    description='Light the grey lens in two steps, from partly lit to fully green.')
    plan = ws.plan(ws.create(spec, 'offline-lamp-redraw', planning_authorized=True).id)
    assert plan.status == 'ready', plan.message
    copy = clone_for_arm(service, plan.id, None, 'model_only', 'paper-model-only-redraw')
    service.open_motion_review_registry.clean = False
    if scenario == 'first_review_failed':
        def unavailable(*args, **kwargs):
            raise ProviderTemporaryError('offline reviewer unavailable')
        monkeypatch.setattr(service.open_motion_review_registry, 'send', unavailable)
    summary = drive_model_only(service, copy.id, provider, authorized=True)
    job = service.store.load(summary['job_id'])
    run = job.candidates[0].plan_execution.stages[0]
    actions = [(d['stage'], d['action']) for d in summary['decisions']]
    if scenario in ('first_review_failed', 'budget_10'):
        assert not run.repairs and provider.attempts == generation_calls(job) == 1
        if scenario == 'budget_10':
            assert run.review['state'] == 'complete' and run.review['verdict'] == 'fail'
            assert actions == [(0, 'reject')] and summary['status'] == 'stopped_by_review'
            assert 'max_total_frames' in summary['decisions'][0]['reason']
        else:
            assert run.state == 'awaiting_review' and run.review['state'] == 'failed'
            assert not actions and 'human_decision' not in run.review and summary['status'] == 'interrupted'
            assert summary['outcome'] == {'kind': 'provider_failure', 'reason': 'initial_review_unavailable',
                                          'stage': 0, 'review_state': 'failed', 'last_review_verdict': None}
        assert drive_model_only(service, copy.id, provider, authorized=True)['outcome'] == summary['outcome']
        assert provider.attempts == 1
    else:
        [attempt] = run.repairs
        assert attempt['repair_level'] == 'window_redraw' and summary['decisions'][0]['window'] == [1, 4]
        assert attempt['seed'] == stage_seed(77, 0) and job.candidates[0].seed == 77
    if scenario == 'accepted':
        assert actions == [(0, 'redraw'), (0, 'adopt_repair'), (0, 'accept'), (1, 'accept')]
        assert summary['status'] == 'complete' and attempt['state'] == 'accepted' and provider.attempts == 3
    elif scenario == 'second_non_pass':
        assert actions == [(0, 'redraw'), (0, 'adopt_repair'), (0, 'reject')]
        assert summary['status'] == 'stopped_by_review' and provider.attempts == 2
        assert attempt['state'] == 'accepted' and run.state == 'rejected'
        assert run.review['state'] == run.review_history[0]['state'] == 'complete'
        assert run.review['token'] != run.review_history[0]['token']
        assert summary['decisions'][-1]['reason'] == 'second non-pass verdict'
        assert summary['decisions'][-1]['verdict'] == run.review['verdict'] == 'fail'
    elif scenario in ('failed', 'unknown_submission'):
        state = 'unknown' if scenario == 'unknown_submission' else 'failed'
        assert actions == [(0, 'redraw')] and summary['status'] == 'interrupted'
        assert provider.attempts == generation_calls(job) == 2
        assert run.state == 'awaiting_review' and attempt['state'] == state
        assert not run.review_history and 'human_decision' not in run.review
        assert run.review['state'] == 'complete' and run.review['verdict'] == 'fail'
        assert attempt['provider_job_id'] == provider.repair_id
        assert attempt['usage']['usd'] == 2.5
        assert summary['outcome'] == {'kind': 'provider_failure', 'stage': 0,
                                      'reason': 'repair_submission_unknown' if state == 'unknown' else 'provider_job_failed',
                                      'repair_state': state, 'repair_request_key': 'model-only-s0',
                                      'provider_job_id': provider.repair_id, 'last_review_verdict': 'fail'}
        repeated = drive_model_only(service, copy.id, provider, authorized=True)
        assert repeated['outcome'] == summary['outcome'] and provider.attempts == 2
        assert service.store.load(job.job_id).candidates[0].plan_execution.stages[0] == run
    export = tmp_path / 'export'
    retrospective(service.store.job_dir(job.job_id), ws.load(copy.id).model_dump(mode='json'), tmp_path / 'none', export)
    result = json.loads((export / 'retrospective.json').read_bytes())
    assert result['tool_usage'] == ({'window_redraw': 1} if run.repairs else {})
    assert result['experiment']['arm'] == 'model_only'
    assert result['escalation']['human_interventions'] == 0 and result['escalation']['measured_wall_decisions'] == 0
    if scenario == 'first_review_failed':
        assert result['stages'][0]['review_ablation'] == [None]
    assert result['outcome'] == summary['outcome']
    if scenario != 'accepted':
        clips, excluded = collect_clips([export])
        assert not clips and excluded[0]['outcome'] == summary['outcome']
        blind_pack(clips, tmp_path / 'blind', excluded=excluded)
        key = json.loads((tmp_path / 'blind-private-key.json').read_bytes())
        assert key['runs'] == 1 and key['excluded'] == excluded
    else:
        assert result['drawing_frame_budget'] == {'max_total_frames': 14, 'requested_frames': 14,
                                                  'reserved_baseline_frames': 0, 'over_limit': False}
        check_historical_completed_run(service, ws, copy, job, provider, tmp_path)


def check_historical_completed_run(service, ws, copy, job, provider, tmp_path):
    # Reconstruct two historical faults on the same fully playable fixture.
    old = ws.load(copy.id)
    frozen = old.experiment['frozen_drawing']
    frozen['limits']['max_total_frames'] = 10
    old.experiment['frozen_drawing_sha256'] = digest(frozen)
    ws.save(old)
    for issue in ('max_total_frames', 'initial_review_unavailable'):
        if issue == 'initial_review_unavailable':
            with service.store.locked_job(job.job_id) as previous:
                report = previous.candidates[0].plan_execution.stages[0].review_history[0]
                report.update(state='failed', verdict='uncertain')
        output = tmp_path / ('historical-' + issue)
        retrospective(service.store.job_dir(job.job_id), old.model_dump(mode='json'), tmp_path / 'none', output)
        exported = json.loads((output / 'retrospective.json').read_bytes())
        assert exported['drawing_frame_budget'] == {'max_total_frames': 10, 'requested_frames': 14,
                                                   'reserved_baseline_frames': 0, 'over_limit': True}
        assert exported['outcome']['reason'] == issue and exported['clips']
        summary = drive_model_only(service, old.id, provider, authorized=True)
        assert summary['outcome'] == exported['outcome'] and not summary['decisions'] and provider.attempts == 3
        clips, excluded = collect_clips([output])
        assert not clips and len(excluded) == 1 and excluded[0]['status'] == 'interrupted'
        assert excluded[0]['outcome'] == exported['outcome']


@pytest.mark.parametrize('state', ['unknown', 'diagnostic'])
def test_unavailable_first_review_on_short_stage_is_not_a_visual_rejection(chain, tmp_path, state):
    service, source, engine, _, _ = chain
    ws = OpenMotionWorkspace(service)
    work = clone_for_arm(service, source.id, None, 'model_only', 'short-review-' + state)
    work = ws.start(work.id, 1, work.plan_sha256)
    provider = Recording()
    engine.advance(work.job_id, provider, wait=True)
    if state == 'unknown':
        # Recover the same pending visual call after a simulated interruption.
        with service.store.locked_job(work.job_id) as job:
            run = job.candidates[0].plan_execution.stages[0]
            run.state = 'reviewing'
            run.review['state'] = 'running'
    summary = drive_model_only(service, work.id, provider, authorized=True)
    run = service.store.load(work.job_id).candidates[0].plan_execution.stages[0]
    assert run.review['verdict'] == 'uncertain' and run.review['state'] == state
    assert run.state == 'awaiting_review' and 'human_decision' not in run.review
    assert len(provider.requests) == 1 and not run.repairs and summary['decisions'] == []
    assert summary['status'] == 'interrupted' and summary['outcome']['review_state'] == state
    # Older model runs may have already persisted the incorrect rejection.
    with service.store.locked_job(work.job_id) as job:
        job.candidates[0].plan_execution.stages[0].state = 'rejected'
    export = tmp_path / 'historical-export'
    retrospective(service.store.job_dir(work.job_id), work.model_dump(mode='json'), tmp_path / 'none', export)
    result = json.loads((export / 'retrospective.json').read_bytes())
    assert not result['clips'] and result['outcome'] == summary['outcome']
    _, excluded = collect_clips([export])
    assert excluded[0]['outcome'] == summary['outcome']


@pytest.mark.parametrize('source', ['stage', 'pixellab'])
def test_failed_mixed_stage_preserves_independent_raw_evidence(chain, tmp_path, source):
    from sprite_pipeline.providers.base import normalize_image_bytes
    from sprite_pipeline.providers.pixellab import PixelLabProvider
    from test_harness_integration import FakePixelLabClient, FakeResponse

    service, original, engine, _, _ = chain
    ws = OpenMotionWorkspace(service)
    copy = clone_for_arm(service, original.id, None, 'model_only', 'partial-stage-' + source)
    work = ws.start(copy.id, 1, copy.plan_sha256)
    fixture = ArchiveProvider()
    engine.submit(work.job_id, 1, 0, fixture)
    [identity] = fixture.outputs
    valid = [fixture.archive[0], fixture.archive[2]]
    rgb = io.BytesIO()
    Image.new('RGB', (128, 128)).save(rgb, 'PNG')
    batch = [b'invalid', valid[0], rgb.getvalue(), valid[1]]
    usage = {'type': 'usd', 'usd': 1.5}
    if source == 'pixellab':
        client = FakePixelLabClient(None, FakeResponse({'id': identity, 'status': 'completed', 'usage': usage,
            'last_response': {'images': [base64.b64encode(data).decode() for data in batch]}}))
        provider = PixelLabProvider(api_key='offline', http_client=client)
        valid = [normalize_image_bytes(data).data for data in valid]
    else:
        class Mixed(ArchiveProvider):
            def wait(self, job_id):
                return replace(fixture.wait(job_id), images=batch, usage=usage)
        provider = Mixed()
    summary = drive_model_only(service, work.id, provider, authorized=True)
    assert summary['status'] == 'interrupted' and not summary['decisions']
    assert summary['outcome'] == {'kind': 'provider_failure', 'reason': 'invalid_drawing_frame', 'stage': 0}
    folder = engine.directory(work.job_id, 1, 0)
    result = json.loads((folder / 'provider-result.json').read_bytes())
    assert result['provider_job_id'] == identity and result['usage'] == usage and result['raw_count'] == 4
    assert result['invalid_frames'] == [0, 2] and not (folder / 'frames.json').exists()
    assert [f['raw_index'] for f in result['frames']] == [1, 3]
    assert [(folder / f['file']).read_bytes() for f in result['frames']] == valid
    run = service.store.load(work.job_id).candidates[0].plan_execution.stages[0]
    assert run.state == 'failed' and not run.review and not run.accepted and not run.repairs
    # The committed terminal receipt is enough to replay the validation after a restart.
    class NoPoll:
        def wait(self, job_id):
            pytest.fail('unexpected provider poll')
    if source == 'stage':
        with pytest.raises(ValidationHarnessError, match='已保存其余原始帧'):
            engine.poll(work.job_id, 1, 0, NoPoll(), True)
    else:
        assert not engine.poll(work.job_id, 1, 0, NoPoll(), True) and len(client.get_calls) == 1
    export = tmp_path / 'failed-stage-export'
    cost = retrospective(service.store.job_dir(work.job_id), work.model_dump(mode='json'), tmp_path / 'none', export)
    assert cost['calls']['generation'] == 1 and cost['known_drawing_usd'] == 1.5
    result = json.loads((export / 'retrospective.json').read_bytes())
    row = result['stages'][0]
    assert row['provider_job_id'] == identity and row['raw_count'] == 4 and row['invalid_raw_indices'] == [0, 2]
    assert [f['raw_index'] for f in row['raw']] == [1, 3]
    assert [(export / f['file']).read_bytes() for f in row['raw']] == valid
    assert [f['sha256'] for f in row['raw']] == [sha(data) for data in valid]
    assert not row['accepted'] and not result['clips']
    assert result['outcome'] == collect_clips([export])[1][0]['outcome'] == summary['outcome']


@pytest.mark.parametrize(('field', 'status', 'http'), [
    ('id', 'completed', 200), ('id', 'failed', 200), ('background_job_id', 'processing', 200),
    ('job_id', 'failed', 500), ('id', 'failed', 429),
])
def test_pixellab_foreign_poll_cannot_provide_usage_images_or_release_slot(tmp_path, field, status, http):
    from contextlib import nullcontext
    from sprite_pipeline.providers.pixellab import PixelLabProvider
    from test_harness_integration import FakePixelLabClient, FakeResponse

    class Slot:
        def lock(self):
            return nullcontext()

        def release(self, job_id):
            pytest.fail('foreign job released the requested account slot')

    source = (ARCHIVE / 'lamp/A.png').read_bytes()
    client = FakePixelLabClient(FakeResponse({'background_job_id': 'submitted', 'usage': {'type': 'usd', 'usd': .5}}),
        FakeResponse({field: 'foreign', 'status': status, 'usage': {'type': 'usd', 'usd': 99},
                      'last_response': {'images': [base64.b64encode(source).decode()] * 4}}, http))
    provider = PixelLabProvider(api_key='offline', http_client=client, account_slot=Slot())
    result = provider.wait('submitted')
    assert result.status == PollStatus.failed and result.error['code'] == 'provider_job_mismatch'
    assert result.error['details'] == {'requested_job_id': 'submitted', 'response_job_id': 'foreign',
                                       'response_id_field': field}
    assert not result.usage and not result.images and 'usage' not in result.raw_response
    assert provider._active_job_status('submitted') not in {'completed', 'failed', 'expired'}
    # Normal replay uses the actual adapter and keeps only its own acknowledged charge.
    replay = tmp_path / 'foreign-poll'
    with pytest.raises(ValueError, match='unexpected provider result'):
        run_arm('blind', source, [{'prompt': 'Light the lens', 'frames': 4}], 7,
                PixelLabProvider(api_key='offline', http_client=client), None, replay)
    run = json.loads((replay / 'run.json').read_bytes())
    assert run['status'] == 'interrupted' and run['outcome']['reason'] == 'provider_job_mismatch'
    assert not run['frames'] and run['cost']['attempts'] == 1 and run['cost']['known_usd'] == .5
    assert len(client.post_calls) == 1 and len(client.get_calls) == 3


@pytest.mark.parametrize('http_error', [False, True])
def test_retrospective_refuses_historical_receipt_with_foreign_inner_id(chain, tmp_path, http_error):
    from sprite_pipeline.errors import ConflictError

    service, work, engine, _, _ = chain
    ws = OpenMotionWorkspace(service)
    folder = engine.directory(work.job_id, 1, 0)
    path = folder / 'poll-receipt.json'
    archived = json.loads(path.read_bytes())
    if http_error:
        archived.pop('response')
        archived.update(status='poll_error', usage={'usd': 99}, error={'details': {
            'provider_job_id': archived['provider_job_id'], 'http_status': 503,
            'response': {'id': 'foreign', 'usage': {'usd': 99}},
        }})
    else:
        archived['response'].update(id='foreign', usage={'usd': 99})
    path.write_text(json.dumps(archived))
    with pytest.raises(ConflictError) as failure:
        retrospective(service.store.job_dir(work.job_id), ws.load(work.id).model_dump(mode='json'),
                      tmp_path / 'none', tmp_path / 'refused')
    assert failure.value.details['response_job_id'] == 'foreign'
    assert failure.value.details['requested_job_id'] == archived['provider_job_id']
    assert not (tmp_path / 'refused' / 'retrospective.json').exists()


def test_v2_replay_keeps_legacy_prompts_and_pose_prompt_boundaries(tmp_path):
    from sprite_pipeline.collaboration.experiment_requests import _pose_arm_prompt, _single_arm_prompt

    def brief(action, poses, end, pad=''):
        return '\n'.join([
            'Appearance: Pixel-art bronze knight holding a straight silver sword' + pad,
            f'Action: {action}',
            'Camera: Fixed side-view 2D pixel art camera',
            'Facing: Body faces screen right',
            'Drive: Shoulders coil cleanly',
            'Support: Both boots planted firmly',
            'Path: Blade arcs smoothly forward',
            'Timing: Smooth acceleration across frames',
            f'Poses: {poses}',
            'Relations: Sword hilt stays gripped in right gauntlet',
            f'End: {end}',
            'Boundary: Settle cleanly on front foot',
        ])

    # Trailing space at exact 1000-char boundary must not trigger prompt rewriting.
    b = brief('Wind up overhead', 'f2: bend; f6: raise', 'Coiled overhead pose')
    exact_982 = b + ('x' * (982 - len(b)))
    assert len(exact_982) == 982
    assert _pose_arm_prompt(exact_982 + '   ') == 'Hold ending pose: ' + exact_982

    # Long End field is not duplicated in Action, keeping compact pose prompt <= 1000 chars.
    long_end = 'E' * 260
    long_brief = brief('Wind up overhead', 'f2: bend; f6: raise', long_end, pad=' ' + 'p' * 360)
    assert len('Hold ending pose: ' + long_brief) > 1000
    compact = _pose_arm_prompt(long_brief)
    assert len(compact) <= 1000 and compact.count(long_end) == 1 and 'Action: Hold ending pose\n' in compact

    # _single_arm_prompt shifts pose-entry fN: landmarks without rewriting mid-prose references.
    s0 = brief('Wind up overhead', 'f2: knees bend; f6: sword raised', 'Coiled pose', pad=' ' + 'x' * 220)
    s1 = brief('Slash down', 'f2: compare f4: label stays; f6: low stance', 'Low stance', pad=' ' + 'x' * 220)
    merged = _single_arm_prompt([{'prompt': s0, 'frames': 8}, {'prompt': s1, 'frames': 8}])
    assert 'f10: compare f4: label stays; f14: low stance' in merged

    # Legacy protocol v2 keeps verbatim legacy concatenation instead of v3 deduplication.
    source = (ARCHIVE / 'lamp/A.png').read_bytes()
    v2_protocol = {'protocol': 2, 'seed': 7, 'fps': 8,
                   'stages': [{'prompt': s0, 'frames': 8}, {'prompt': s1, 'frames': 8}],
                   'reference_sha256': sha(source), 'source': {'work_id': 'legacy-v2', 'revision': 1}}
    recorder = Recording()
    run_arm('single', source, v2_protocol['stages'], 7, recorder, None, tmp_path / 'v2-single', protocol=v2_protocol)
    assert recorder.requests[0].prompt == f'{s0} {s1}'


def test_redraw_only_handles_internal_state_checkpoint_and_model_only_blocks_human(chain, tmp_path):
    from sprite_pipeline.collaboration.experiment_policy import is_stage_redraw_range
    from sprite_pipeline.errors import ConflictError

    # Internal state_checkpoint at frame 5 on an 8-frame stage leaves [1..4] as the valid redraw span.
    ctx_pinned = {'frames': [{}] * 8, 'locked_frames': [0, 5], 'state_checkpoint_frame': 5}
    assert is_stage_redraw_range(ctx_pinned, 1, 4)
    assert not is_stage_redraw_range(ctx_pinned, 6, 7)
    assert is_stage_redraw_range({'frames': [{}] * 8, 'locked_frames': [0, 5, 7]}, 1, 4)
    assert not is_stage_redraw_range({'frames': [{}] * 8, 'locked_frames': [0, 4]}, 1, 3)
    assert is_stage_redraw_range({'frames': [{}] * 16, 'locked_frames': [0, 7], 'state_checkpoint_frame': 7}, 1, 6)
    assert not is_stage_redraw_range({'frames': [{}] * 16, 'locked_frames': [0, 7], 'state_checkpoint_frame': 7}, 8, 15)

    # Human intervention on a model_only copy is rejected at both API and Checkpoints layers.
    service, work, engine, _, _ = chain
    copy = clone_for_arm(service, work.id, None, 'model_only', 'model-only-human-guard')
    ws = OpenMotionWorkspace(service)
    started = ws.start(copy.id, 1, copy.plan_sha256)
    engine.advance(started.job_id, ArchiveProvider(), wait=True)
    api = TestClient(create_api(service=service), base_url='http://testserver/v1/open-motion/' + copy.id + '/')
    view = api.get('candidates/1/stages/0').json()
    assert api.post('review-stage', json={
        'expected_revision': 1, 'candidate_index': 1, 'stage_index': 0, 'token': view['token'],
        'decision': 'accept', 'note': 'Attempt human override', 'acknowledge_warnings': True,
    }).status_code == 409
    with pytest.raises(ConflictError, match='model_only'):
        Checkpoints(service).decide(started.job_id, 1, 0, token=view['token'],
                                    note='Direct human override', decision='accept', acknowledge=True)
    ctx = api.get('adjustments', params={'revision': 1, 'candidate': 1, 'stage': 0}).json()
    assert api.post('adjustments', json={
        'expected_revision': 1, 'candidate_index': 1, 'stage_index': 0, 'token': ctx['token'],
        'start': 1, 'end': 2, 'user_request': 'Human tweak', 'request_key': 'mo-adj-blocked',
        'authorized': True, 'max_planning_calls': 1, 'max_generation_calls': 1, 'max_review_calls': 5,
    }).status_code == 409


def test_retrospective_handles_inherited_repairs_rejected_human_seconds_and_blind_pack_guards(chain, tmp_path):
    service, work, engine, provider, client = chain
    ws = OpenMotionWorkspace(service)
    finish(chain)
    job = service.store.load(work.job_id)

    # Simulate an inherited adjustment job whose stage repair folder is absent (not copied to target job)
    # and a rejected adjustment with empty decision_note + recorded human_seconds.
    with service.store.locked_job(job.job_id) as current:
        current.request.request_key = 'adjustment-inherited-test'
        current.candidates[0].plan_execution.stages[0].repairs.append({
            'number': 1, 'mode': 'transition', 'repair_level': 'window_redraw',
            'state': 'rejected', 'folder': 'provider/missing-repair-folder',
            'proposed_frames': [{'path': 'provider/missing-repair-folder/000.png', 'sha256': '0' * 64}],
            'raw_frames': [{'path': 'provider/missing-repair-folder/raw_000.png', 'sha256': '0' * 64}],
        })
    adj_dir = ws.directory(work.id) / 'adjustments' / 'rejected-empty-note'
    adj_dir.mkdir(parents=True)
    (adj_dir / 'task.json').write_text(json.dumps({
        'id': 'rejected-empty-note', 'source_job': job.job_id, 'state': 'rejected',
        'decision_note': '', 'human_seconds': 23, 'repair_level': 'deterministic',
        'proposed_frames': [], 'raw_frames': [],
        'planning_calls': [], 'generation_calls': [], 'review_calls': [],
    }), encoding='utf8')
    export_dir = tmp_path / 'inherited-export'
    cost = retrospective(service.store.job_dir(job.job_id), ws.load(work.id).model_dump(mode='json'),
                         ws.directory(work.id) / 'adjustments', export_dir)
    assert cost['known_human_seconds'] == 23
    exported = json.loads((export_dir / 'retrospective.json').read_bytes())
    assert exported['stages'][0]['repairs'][0]['proposed_archive_unavailable'] is True
    assert exported['stages'][0]['repairs'][0]['original_archive_unavailable'] is True

    # collect_clips rejects duplicates and recognizes no-job model_only blocked_preflight experiment-run.json.
    with pytest.raises(ValueError, match='duplicate run directory'):
        collect_clips([export_dir, export_dir])
    preflight_dir = tmp_path / 'model-only-preflight'
    preflight_dir.mkdir()
    (preflight_dir / 'experiment-run.json').write_text(json.dumps({
        'work_id': 'w1', 'job_id': None, 'arm': 'model_only', 'protocol': 3,
        'status': 'blocked_preflight', 'outcome': {'kind': 'local_preflight', 'reason': 'max_total_frames'},
        'decisions': [],
    }), encoding='utf8')
    clips, excluded = collect_clips([export_dir, preflight_dir])
    assert len(clips) == 1 and len(excluded) == 1
    assert excluded[0]['status'] == 'blocked_preflight' and excluded[0]['arm'] == 'model_only'

    # blind_pack rejects duplicate clip sources and mixed-dimension frames within a single clip.
    with pytest.raises(ValueError, match='duplicate clip source'):
        blind_pack([clips[0], clips[0]], tmp_path / 'dup-pack')
    mixed_root = tmp_path / 'mixed'
    mixed_root.mkdir()
    buf_a, buf_b = io.BytesIO(), io.BytesIO()
    Image.new('RGBA', (64, 64), (10, 20, 30, 255)).save(buf_a, 'PNG')
    Image.new('RGBA', (128, 64), (10, 20, 30, 255)).save(buf_b, 'PNG')
    (mixed_root / '000.png').write_bytes(buf_a.getvalue())
    (mixed_root / '001.png').write_bytes(buf_b.getvalue())
    mixed_frames = [{'file': '000.png', 'sha256': sha(buf_a.getvalue())},
                    {'file': '001.png', 'sha256': sha(buf_b.getvalue())}]
    with pytest.raises(ValueError, match='size mismatch'):
        blind_pack([(mixed_root, mixed_frames, 8, {'arm': 'blind'})], tmp_path / 'mixed-pack')

    # blind_pack emits loop metadata, responsive zoom, non-looping default control, and zero leaked arm names.
    pack = tmp_path / 'clean-pack'
    blind_pack(clips, pack, excluded=excluded)
    public = (pack / 'clips.json').read_bytes() + (pack / 'index.html').read_bytes()
    assert not any(arm.encode() in public for arm in ARMS)
    items = json.loads((pack / 'clips.json').read_bytes())
    assert items[0]['loop'] is False
    html = (pack / 'index.html').read_text(encoding='utf8')
    assert '播完即停' in html and 'resize' in html


def test_retrospective_and_legacy_export_compute_objective_drift_metrics(chain, tmp_path):
    service, work, engine, provider, client = chain
    finish(chain)
    ws = OpenMotionWorkspace(service)
    job_dir = service.store.job_dir(work.job_id)
    export_dir = tmp_path / 'full-drift-export'
    retrospective(job_dir, ws.load(work.id).model_dump(mode='json'), tmp_path / 'none', export_dir)
    exported = json.loads((export_dir / 'retrospective.json').read_bytes())

    assert all(stage['drift_source'] == 'accepted' and stage['drift'] is not None for stage in exported['stages'])
    stage0_drift = exported['stages'][0]['drift']
    # finish(chain) accepts stage 0 at anchor_frame=2, retaining 3 accepted frames in stage 0.
    assert len(stage0_drift['frames']) == len(exported['stages'][0]['accepted']) == 3
    assert all(
        {'frame', 'ground_y_delta_px', 'area_change_ratio', 'silhouette_iou', 'palette_deviation_ratio'} <= set(row)
        for row in stage0_drift['frames']
    )
    assert all(0.0 <= row['silhouette_iou'] <= 1.0 for row in stage0_drift['frames'])
    assert stage0_drift['summary']['min_silhouette_iou'] <= stage0_drift['summary']['mean_silhouette_iou'] <= 1.0

    clip_drift = exported['clips'][0]['drift']
    assert clip_drift['frame_count'] == len(exported['clips'][0]['frames'])
    assert clip_drift['summary']['end_silhouette_iou'] == clip_drift['frames'][-1]['silhouette_iou']

    # Objective checkpoint escalation rate and backend wall-clock timestamps are also recorded & exported.
    job = service.store.load(work.job_id)
    stage0_review = job.candidates[0].plan_execution.stages[0].review
    assert isinstance(stage0_review.get('reviewed_at'), str) and isinstance(stage0_review['human_decision'].get('decided_at'), str)
    escalation = exported['escalation']
    assert escalation['total_checkpoint_reviews'] == 2
    assert escalation['auto_pass_reviews'] == 2 and escalation['escalated_reviews'] == 0 and escalation['escalation_rate'] == 0.0
    assert escalation['human_checkpoint_decisions'] == 2 and escalation['human_interventions'] == 2
    assert escalation['measured_wall_decisions'] == 2 and escalation['known_wall_seconds'] >= 0.0

    # Verify non-zero probe escalation accounting on retrospective export.
    escalated_job_dir = tmp_path / 'escalated-job'
    shutil.copytree(job_dir, escalated_job_dir)
    esc_record = json.loads((escalated_job_dir / 'job.json').read_bytes())
    esc_record['candidates'][0]['plan_execution']['stages'][0]['review'].update(
        verdict='uncertain',
        requires_human_adjudication=[{
            'source': 'deterministic_probe', 'dimension': 'transition', 'frames': [1],
            'prior': {'dimension': 'transition', 'status': 'pass', 'confidence': 0.95, 'frames': [1], 'evidence': 'ok'},
            'reason': 'probe',
        }]
    )
    (escalated_job_dir / 'job.json').write_text(json.dumps(esc_record), encoding='utf8')
    esc_out = tmp_path / 'escalated-export'
    retrospective(escalated_job_dir, ws.load(work.id).model_dump(mode='json'), tmp_path / 'none', esc_out)
    esc_summary = json.loads((esc_out / 'retrospective.json').read_bytes())['escalation']
    assert esc_summary['escalated_reviews'] == 1 and esc_summary['probe_escalated_reviews'] == 1
    assert esc_summary['escalation_rate'] == 0.5

    # Legacy export also attaches clip-level drift relative to input/reference.png.
    legacy_dir = tmp_path / 'legacy-job'
    shutil.copytree(job_dir, legacy_dir)
    record = json.loads((legacy_dir / 'job.json').read_bytes())
    record['request']['open_plan'] = None
    (legacy_dir / 'job.json').write_text(json.dumps(record), encoding='utf8')
    legacy_out = tmp_path / 'legacy-drift-export'
    legacy_result = legacy_export(legacy_dir, legacy_out)
    assert legacy_result['clips'][0]['drift']['frame_count'] == len(legacy_result['clips'][0]['frames'])
    assert legacy_result['clips'][0]['drift']['summary']['mean_silhouette_iou'] is not None
