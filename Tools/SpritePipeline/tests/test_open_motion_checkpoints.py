"""Generic pose checkpoints must gate calls and preserve real accepted bytes."""
import hashlib
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient
from test_open_motion import setup, Planner, ready, spec
from test_open_motion_quality import quality, ReviewRegistry
from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.checkpoints import Checkpoints, review_call_count
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.errors import ConflictError, ValidationHarnessError, ExportBlockedError, ProviderTemporaryError


class CheckpointPlanner(Planner):
    def __call__(self,*args,**kwargs):
        response, receipt = super().__call__(*args,**kwargs)
        if response['action'] == 'finalize':
            q = quality().model_dump(mode='json');q['version']=3
            q['key_poses']=[{'frame':1,'description':'Reach toward the held item.'},{'frame':4,'description':'Hold the item above the head.'},{'frame':8,'description':'Bow with the item in the same hand.'}]
            response['plan']['quality']=q
            for i,stage in enumerate(response['plan']['stages']):
                stage['checkpoint']={'endpoint':'Hold the item above the head.' if i==0 else 'Bow with the item in the same hand.',
                    'rhythm':'Move through the first three frames, ease into the final pose.',
                    'reason':'Verify the change of body state before continuing.'}
        return response,receipt


def prepared(setup, **kwargs):
    s,ws,_,p,f=setup;s.open_motion_model=CheckpointPlanner();ws.model=s.open_motion_model
    w=ready(ws,spec(**kwargs));assert w.status=='ready',w.message
    w=ws.start(w.id,1,w.plan_sha256)
    return s,ws,p,w


def accept(s,w,stage,**kwargs):
    gates=Checkpoints(s);v=gates.view(w.job_id,1,stage)
    gates.decide(w.job_id,1,stage,token=v['token'],note='实际逐帧核对姿势和装备衔接',decision='accept',acknowledge=True,**kwargs)
    return v


@pytest.mark.parametrize('description',['摘帽后鞠躬，最后保持低头','下蹲拾起物品，然后站起举高'])
def test_real_pose_snapshots_gate_every_segment_without_action_rules(setup,description):
    s,ws,p,w=prepared(setup,description=description)
    engine=PlanGeneration(s);engine.advance(w.job_id,p,wait=True)
    c=s.store.load(w.job_id).candidates[0]
    assert c.plan_execution.stages[0].state=='awaiting_review' and not c.frames
    assert len(p.requests)==1
    with pytest.raises(ExportBlockedError,match='检查点'):
        s.approve_candidate(w.job_id,1,reviewer='test',acknowledge_warnings=True,review_note='不能跳过尚未确认的片段')
    for _ in range(2):engine.advance(w.job_id,p,wait=True);s.recover_pending_jobs()
    assert len(p.requests)==1
    with pytest.raises(ConflictError):ws.pause(w.id,1,resume=True)
    v=accept(s,w,0)
    frozen=s.store.load(w.job_id).candidates[0].plan_execution.stages[0].accepted
    engine.advance(w.job_id,p,wait=True)
    assert len(p.requests)==2
    assert hashlib.sha256(p.requests[1].reference_image).hexdigest()==frozen['anchor_sha256']==v['frames'][-1]['sha256']
    assert p.requests[1].last_frame is None
    accept(s,w,1);job=engine.advance(w.job_id,p,wait=True)
    assert len(job.candidates[0].frames)==8
    assert all(r.state=='accepted' for r in job.candidates[0].plan_execution.stages)
    assert job.candidates[0].plan_execution.timeline[0]['checkpoint_token']==v['token']
    assert len(p.requests)==2 and job.candidates[0].status.value=='review_ready'


def test_model_pass_never_auto_unlocks_and_failed_report_needs_explicit_adjudication(setup):
    s,ws,p,w=prepared(setup);engine=PlanGeneration(s)
    # Separate technical generation from simulated model review, retaining real fixture files.
    with patch.object(Checkpoints,'inspect'):
        engine.advance(w.job_id,p,wait=True)
    with s.store.locked_job(w.job_id) as j:j.candidates[0].diagnostic_only=False
    registry=ReviewRegistry();s.open_motion_review_registry=registry
    Checkpoints(s).inspect(w.job_id,1,0)
    assert len(registry.calls)==2 and len(p.requests)==1
    assert s.store.load(w.job_id).candidates[0].plan_execution.stages[0].state=='awaiting_review'
    engine.advance(w.job_id,p,wait=True)
    assert len(p.requests)==1
    with s.store.locked_job(w.job_id) as j:j.candidates[0].plan_execution.stages[0].review['verdict']='uncertain'
    v=Checkpoints(s).view(w.job_id,1,0)
    with pytest.raises(ValidationHarnessError):
        Checkpoints(s).decide(w.job_id,1,0,token=v['token'],note='实际画面需要进一步检查',decision='accept')
    accept(s,w,0)
    assert review_call_count(s.store.load(w.job_id))==2


def test_tampered_snapshot_or_stale_token_never_submits_next_segment(setup):
    s,ws,p,w=prepared(setup);engine=PlanGeneration(s);engine.advance(w.job_id,p,wait=True)
    gates=Checkpoints(s);v=gates.view(w.job_id,1,0)
    with pytest.raises(ConflictError):gates.decide(w.job_id,1,0,token='0'*64,note='检查结果仅适用于实际当前帧',decision='accept',acknowledge=True)
    accept(s,w,0);job=s.store.load(w.job_id)
    anchor=job.candidates[0].plan_execution.stages[0].accepted['frames'][-1]
    s.store.resolve_job_path(w.job_id,anchor['path']).write_bytes(b'changed')
    with pytest.raises(ConflictError):engine.advance(w.job_id,p,wait=True)
    engine.advance(w.job_id,p,wait=True)
    assert s.store.load(w.job_id).candidates[0].status.value=='failed'
    assert len(p.requests)==1


def test_rejected_checkpoint_and_duplicate_accept_cannot_resume(setup):
    s,ws,p,w=prepared(setup);engine=PlanGeneration(s);engine.advance(w.job_id,p,wait=True)
    v=accept(s,w,0);ws.pause(w.id,1)
    Checkpoints(s).decide(w.job_id,1,0,token=v['token'],note='重复网络响应恢复不应自动继续',decision='accept',acknowledge=True)
    assert not s.store.load(w.job_id).plan_control.enabled
    ws.pause(w.id,1,resume=True);engine.advance(w.job_id,p,wait=True)
    v=Checkpoints(s).view(w.job_id,1,1)
    Checkpoints(s).decide(w.job_id,1,1,token=v['token'],note='末姿势未达到要求，保留原始帧',decision='reject')
    with pytest.raises(ConflictError):ws.pause(w.id,1,resume=True)
    engine.advance(w.job_id,p,wait=True);assert len(p.requests)==2
    assert s.store.load(w.job_id).candidates[0].plan_execution.stages[0].accepted


@pytest.mark.parametrize('checkpoints',[False,True],ids=['legacy-complete','checkpoint-accepted'])
def test_manual_recovery_skips_finished_segments_and_only_polls_original_id(setup,checkpoints):
    s,ws,_,p,_=setup
    if checkpoints:ws.model=CheckpointPlanner()
    w=ready(ws);w=ws.start(w.id,1,w.plan_sha256);engine=PlanGeneration(s)
    engine.advance(w.job_id,p)
    if checkpoints:accept(s,w,0)
    p.unknown=True
    with pytest.raises(ProviderTemporaryError):engine.advance(w.job_id,p)
    # Exercise PixelLab's manual-ID gate with only the fixture submit/poll implementation.
    with s.store.locked_job(w.job_id) as job:
        job.request.open_plan.spec.provider='pixellab';job.request.provider='pixellab'
    before=s.store.load(w.job_id);finished='accepted' if checkpoints else 'complete'
    assert [r.state for r in before.candidates[0].plan_execution.stages]==[finished,'unknown']
    remote='remote-000002'
    bound=s.attach_provider_job_id(w.job_id,1,remote)
    assert [r.state for r in bound.candidates[0].plan_execution.stages]==[finished,'pending']
    assert bound.candidates[0].plan_execution.stages[0]==before.candidates[0].plan_execution.stages[0]
    assert bound.candidates[0].plan_execution.stages[1].provider_job_id==remote
    with pytest.raises(ConflictError,match='不同的远端编号'):
        s.attach_provider_job_id(w.job_id,1,'different-remote-000002')
    assert s.store.load(w.job_id).model_dump()==bound.model_dump()
    polls=[];original=p.poll
    def poll(identity):
        polls.append(identity);return original(identity)
    p.poll=poll
    recovered=s.recover_completed_candidate(w.job_id,1)
    assert polls==[remote] and len(p.requests)==2
    if checkpoints:
        assert recovered.candidates[0].plan_execution.stages[1].state=='awaiting_review'
        assert not recovered.plan_control.enabled
        accept(s,w,1);recovered=engine.advance(w.job_id,p,wait=True)
    assert len(recovered.candidates[0].frames)==8
    assert recovered.request.request_key==before.request.request_key
    assert recovered.request.open_plan.plan_sha256==before.request.open_plan.plan_sha256
    s.recover_completed_candidate(w.job_id,1)
    assert polls==[remote] and len(p.requests)==2


def test_budget_includes_all_segments_and_final_review(setup):
    s,ws,_,_,_=setup;s.open_motion_model=CheckpointPlanner();ws.model=s.open_motion_model
    w=ready(ws,spec(budget={'max_review_calls':2}))
    assert w.status=='planning_failed'
    assert not w.job_id


def test_interrupted_visual_call_does_not_repeat(setup):
    s,ws,p,w=prepared(setup)
    with patch.object(Checkpoints,'inspect'):PlanGeneration(s).advance(w.job_id,p,wait=True)
    with s.store.locked_job(w.job_id) as j:
        r=j.candidates[0].plan_execution.stages[0];r.state='reviewing';r.review={'token':Checkpoints(s).evidence(j,1,0)['token'],'state':'running','requests':[{'phase':'observe','state':'submitting'}]}
    registry=ReviewRegistry();s.open_motion_review_registry=registry
    PlanGeneration(s).advance(w.job_id,p,wait=True)
    job=s.store.load(w.job_id)
    assert job.candidates[0].plan_execution.stages[0].review['state']=='unknown'
    assert review_call_count(job)==1 and not registry.calls and len(p.requests)==1


def test_api_frame_preview_and_revision_bound_review(setup):
    s,ws,p,w=prepared(setup);PlanGeneration(s).advance(w.job_id,p,wait=True)
    client=TestClient(create_api(service=s));base=f'/v1/open-motion/{w.id}'
    view=client.get(base+'/candidates/1/stages/0').json()
    frame=client.get(base+'/candidates/1/stages/0/frames/3')
    assert frame.status_code==200 and hashlib.sha256(frame.content).hexdigest()==view['frames'][-1]['sha256']
    body={'expected_revision':2,'candidate_index':1,'stage_index':0,'token':view['token'],'note':'已检查全段与末姿势，允许继续','decision':'accept','acknowledge_warnings':True}
    assert client.post(base+'/review-stage',json=body).status_code==409
    body['expected_revision']=1
    assert client.post(base+'/review-stage',json=body).status_code==200
    assert len(p.requests)==1  # Endpoint only unlocks the original worker.


def test_explicit_earlier_pose_preserves_tail_and_conditions_next_request(setup):
    s,ws,p,w=prepared(setup);engine=PlanGeneration(s);engine.advance(w.job_id,p,wait=True)
    gates=Checkpoints(s);v=gates.view(w.job_id,1,0)
    original=[s.store.resolve_job_path(w.job_id,f['path']).read_bytes() for f in v['frames']]
    kwargs=dict(token=v['token'],note='第3帧已到达目标，第4帧越界；仅确认前三帧，保留全部原始帧',decision='accept',acknowledge=True,anchor_frame=2)
    with pytest.raises(ValidationHarnessError):gates.decide(w.job_id,1,0,**kwargs)
    gates.decide(w.job_id,1,0,**kwargs,acknowledge_trim=True)
    snapshot=s.store.load(w.job_id).candidates[0].plan_execution.stages[0].accepted
    assert len(snapshot['frames'])==3 and snapshot['excluded_tail']==v['frames'][3:]
    assert [s.store.resolve_job_path(w.job_id,f['path']).read_bytes() for f in v['frames']]==original
    with pytest.raises(ConflictError):gates.decide(w.job_id,1,0,**{**kwargs,'anchor_frame':3},acknowledge_trim=True)
    engine.advance(w.job_id,p,wait=True)
    assert p.requests[1].reference_image==original[2]
    accept(s,w,1);job=engine.advance(w.job_id,p,wait=True)
    assert len(job.candidates[0].frames)==7
    assert job.candidates[0].plan_execution.timeline[0]['excluded_tail_count']==1
    assert job.candidates[0].plan_execution.frame_mapping[3]=={'frame':3,'stage':1,'raw_frame':0}
