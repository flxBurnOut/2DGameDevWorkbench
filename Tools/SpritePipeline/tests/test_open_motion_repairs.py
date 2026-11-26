"""Window isolation, budget and recovery guarantees; no live provider calls."""
import hashlib
import io
import json
from dataclasses import replace

import pytest
from PIL import Image
from test_open_motion import setup,ready,spec
from test_open_motion_checkpoints import CheckpointPlanner,accept
from sprite_pipeline.collaboration.contracts import digest
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.checkpoints import Checkpoints,review_call_count
from sprite_pipeline.collaboration.experiment import retrospective
from sprite_pipeline.collaboration.workspace import OpenMotionWorkspace
from sprite_pipeline.collaboration.repairs import LocalRepairs,generation_calls,edit_window_limit,repair_request
from sprite_pipeline.errors import ConflictError,ValidationHarnessError,ProviderTemporaryError
from sprite_pipeline.providers.base import PollStatus
from sprite_pipeline.service import SpritePipelineService


def repair_work(setup, *, initial_usage=None):
    s,ws,_,p,fixture=setup;ws.model=CheckpointPlanner()
    w=ready(ws,spec(budget={'max_generation_calls':4,'max_review_calls':10}))
    w.plan.stages[0].frame_count=8;w.plan_sha256=digest(w.plan.model_dump(mode='json'));ws.save(w)
    w=ws.start(w.id,1,w.plan_sha256)
    original=p.poll
    def poll(remote):
        result=original(remote);request=p.requests[int(remote.split('-')[-1])-1]
        if result.images:result.images=[result.images[(i+(1 if request.edit_frames else 0))%4] for i in range(request.frame_count)]
        if initial_usage and len(p.requests) == 1:
            result.usage = initial_usage
        return result
    p.poll=poll
    PlanGeneration(s).advance(w.job_id,p,wait=True)
    return s,ws,p,w


def create(s,p,w,**kw):
    token=Checkpoints(s).view(w.job_id,1,0)['token']
    args=dict(token=token,start=2,end=5,note='保持动作姿势，仅修正同一物品的轮廓和握持',mode='appearance',request_key='repair-test-0001',authorized=True,provider=p)
    args.update(kw)
    return LocalRepairs(s).create(w.job_id,1,0,**args)


def test_repair_preserves_outside_bytes_sources_and_requires_fresh_full_review(setup):
    s,ws,p,w=repair_work(setup);engine=PlanGeneration(s);gates=Checkpoints(s);repairs=LocalRepairs(s)
    original=gates.view(w.job_id,1,0);raw=engine.saved_frames(w.job_id,1,0)
    a=create(s,p,w)
    assert len(p.requests)==2 and p.requests[-1].edit_frames and len(p.requests[-1].edit_frames)==6
    create(s,p,w);assert len(p.requests)==2  # Response recovery is idempotent.
    engine.advance(w.job_id,p,wait=True)
    v=gates.view(w.job_id,1,0);a=v['repairs'][0]
    assert a['state']=='awaiting_review' and v['token']==original['token']
    assert [a['proposed_frames'][i] for i in [0,1,6,7]]==[original['frames'][i] for i in [0,1,6,7]]
    with pytest.raises(ConflictError):accept(s,w,0)
    with pytest.raises(ConflictError):repairs.decide(w.job_id,1,0,0,'0'*64,'不能使用旧结论','accept')
    repairs.decide(w.job_id,1,0,0,a['token'],'已核对完整片段及修复窗口两侧接缝','accept')
    assert s.store.load(w.job_id).candidates[0].plan_execution.stages[0].state=='complete'
    engine.advance(w.job_id,p,wait=True)
    updated=gates.view(w.job_id,1,0);assert updated['token']!=original['token']
    assert engine.saved_frames(w.job_id,1,0)==raw and len(p.requests)==2
    assert s.store.load(w.job_id).candidates[0].plan_execution.stages[0].review_history
    accept(s,w,0);engine.advance(w.job_id,p,wait=True);accept(s,w,1)
    job=engine.advance(w.job_id,p,wait=True)
    assert len(job.candidates[0].frames)==12
    assert any('repair_attempt' in item for item in job.candidates[0].plan_execution.frame_mapping)
    assert generation_calls(job)==3


def test_repair_checks_bounds_budget_and_authorization_before_submission(setup):
    s,ws,p,w=repair_work(setup)
    for changes in [{'authorized':False},{'start':0},{'end':7},{'end':4}]:
        with pytest.raises(ValidationHarnessError):create(s,p,w,**changes)
    assert len(p.requests)==1
    with s.store.locked_job(w.job_id) as j:
        j.candidates[0].plan_execution.stages[0].review['requests']=[{}, {}, {}, {}, {}, {}, {}]
    with pytest.raises(ValidationHarnessError,match='视觉预算'):create(s,p,w)
    assert len(p.requests)==1


def test_unknown_repair_never_resubmits_and_can_explicitly_keep_original(setup):
    s,ws,p,w=repair_work(setup);p.unknown=True
    with pytest.raises(ProviderTemporaryError):create(s,p,w)
    create(s,p,w);assert len(p.requests)==2
    for _ in range(2):PlanGeneration(s).advance(w.job_id,p,wait=True)
    with pytest.raises(ConflictError):create(s,p,w,request_key='different-request')
    v=Checkpoints(s).view(w.job_id,1,0)
    LocalRepairs(s).decide(w.job_id,1,0,0,v['token'],'保留未知请求记录，本次保留原片段不继续修复','reject')
    accept(s,w,0);assert len(p.requests)==2


def test_size_specific_edit_limits_reserve_context_slots():
    assert edit_window_limit(64,64)==14
    assert edit_window_limit(80,64)==6
    assert edit_window_limit(128,128)==2
    assert edit_window_limit(256,128)==2


@pytest.mark.parametrize('shape', ['exact', 'extra_context', 'extra_pose', 'failed'])
def test_repair_charges_survive_saved_result_restart_and_count_once(setup, tmp_path, monkeypatch, shape):
    s, ws, provider, work = repair_work(setup, initial_usage={'type': 'usd', 'usd': 1})
    submit, poll = provider.submit, provider.poll
    monkeypatch.setattr(provider, 'submit', lambda req: replace(
        submit(req), raw_response={'usage': {'type': 'usd', 'usd': 2.5}}))

    def returned(identity):
        result = poll(identity)
        if shape == 'failed':
            return replace(result, status=PollStatus.failed, provider_status='failed', images=[],
                           usage={'type': 'usd', 'usd': 2.5}, error={'code': 'provider_job_failed'})
        if shape == 'extra_context':
            result.images.insert(0, provider.requests[-1].reference_image)
        elif shape == 'extra_pose':
            extra = io.BytesIO()
            Image.new('RGBA', (64, 64), '#ff00ff').save(extra, format='PNG')
            result.images.insert(0, extra.getvalue())
        # Some terminal provider responses omit the usage from acceptance.
        return result

    attempt = create(s, provider, work, mode='transition')
    assert attempt['usage'] == {'type': 'usd', 'usd': 2.5}
    monkeypatch.setattr(provider, 'poll', returned)
    repair_folder = s.store.resolve_job_path(work.job_id, attempt['folder'])
    from sprite_pipeline.collaboration import repairs as repair_module
    real_write = repair_module.atomic_write_json

    def crash_after_archive(path, data):
        if path == repair_folder / 'result.json':
            raise KeyboardInterrupt('fixture stops after the raw result is durable')
        return real_write(path, data)

    with monkeypatch.context() as interrupted:
        interrupted.setattr(repair_module, 'atomic_write_json', crash_after_archive)
        with pytest.raises(KeyboardInterrupt):
            PlanGeneration(s).advance(work.job_id, provider, wait=True)
    assert LocalRepairs(s).run(s.store.load(work.job_id), 1, 0).repairs[-1]['state'] == 'pending'
    original = json.loads((repair_folder / 'provider-result.json').read_bytes())
    assert original['provider_job_id'] == attempt['provider_job_id'] and original['usage']['usd'] == 2.5
    assert len(original['frames']) == {'failed': 0, 'exact': 4, 'extra_context': 5, 'extra_pose': 5}[shape]
    reopened = SpritePipelineService(s.settings.data_root)
    monkeypatch.setattr(provider, 'poll', lambda *_: pytest.fail('saved terminal result must be reused'))
    job = PlanGeneration(reopened).advance(work.job_id, provider, wait=True)
    repair = LocalRepairs(reopened).run(job, 1, 0).repairs[-1]
    assert len(provider.requests) == 2 and generation_calls(job) == 2
    assert repair['usage'] == {'type': 'usd', 'usd': 2.5}
    assert repair['state'] == ('failed' if shape in ('failed', 'extra_pose') else 'awaiting_review')
    if shape == 'extra_context':
        assert repair['playback_raw_indices'] == [1, 2, 3, 4]
    elif shape == 'extra_pose':
        assert repair['error']['details']['reason'] == 'unexpected_extra_frame' and not repair.get('proposed_frames')
    output = tmp_path / ('repair-export-' + shape)
    current = OpenMotionWorkspace(reopened).load(work.id)
    cost = retrospective(reopened.store.job_dir(job.job_id), current.model_dump(mode='json'), tmp_path / 'none', output)
    assert cost['calls']['generation'] == cost['priced_drawing_calls'] == 2
    assert cost['known_drawing_usd'] == 3.5 and cost['unpriced_calls'] == cost['calls']['planning'] + cost['calls']['review']
    saved = json.loads((output / 'retrospective.json').read_bytes())['stages'][0]['repairs'][0]['original_images']
    assert [hashlib.sha256((output/f['file']).read_bytes()).hexdigest() for f in saved] == [
        f['sha256'] for f in original['frames']]


@pytest.mark.parametrize('identity', [None, 'already-reported-upstream'])
def test_ambiguous_repair_keeps_charge_without_repeating_post(setup, tmp_path, monkeypatch, identity):
    s, ws, provider, work = repair_work(setup)

    def charged_unknown(request):
        provider.requests.append(request)
        raise ProviderTemporaryError('charged but unknown result', details={
            'submission_unknown': True, 'response': {'usage': {'type': 'usd', 'usd': 1.25}},
            **({'provider_job_id': identity} if identity else {}),
        })

    monkeypatch.setattr(provider, 'submit', charged_unknown)
    with pytest.raises(ProviderTemporaryError):
        create(s, provider, work)
    reopened = SpritePipelineService(s.settings.data_root)
    recovered = create(reopened, provider, work)
    assert recovered['state'] == 'unknown' and recovered.get('provider_job_id') == identity
    assert recovered['usage'] == {'type': 'usd', 'usd': 1.25} and len(provider.requests) == 2
    job = PlanGeneration(reopened).advance(work.job_id, provider, wait=True)
    assert generation_calls(job) == 2
    cost = retrospective(reopened.store.job_dir(job.job_id), ws.load(work.id).model_dump(mode='json'),
                         tmp_path / 'none', tmp_path / 'ambiguous-export')
    assert cost['known_drawing_usd'] == 1.25 and cost['priced_drawing_calls'] == 1
