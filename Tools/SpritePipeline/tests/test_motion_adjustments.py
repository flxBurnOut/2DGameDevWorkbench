"""Controlled alternatives: user intent, scope, independent costs and adoption."""
import copy
import json
import uuid
from pathlib import Path
import pytest
from test_open_motion import setup, spec, ready
from test_open_motion_checkpoints import CheckpointPlanner, accept
from test_production_review import ExpertRegistry
from sprite_pipeline.collaboration.adjustments import Adjustments, AdjustmentInput, AdjustmentIntent
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.checkpoints import Checkpoints, review_call_count
from sprite_pipeline.errors import ConflictError, ValidationHarnessError


def test_unlocked_tail_edits_only_selection_and_becomes_next_input_after_acceptance(setup):
    s,ws,p,w=stage_work(setup);m=Adjustments(s)
    before=Checkpoints(s).view(w.job_id,1,0);context=m.context(w.id,1,1,0)
    assert context['editable_stage_end'] and context['locked_frames']==[0]
    t=m.create(w.id,request(m,w,start=2,end=3));assert t['range_policy']=='unlocked_stage_tail_v2'
    t=m.advance(w.id,t['id'],p);assert t['state']=='ready',t
    directory=s.store.job_dir(w.job_id)
    preceding=(directory/before['frames'][1]['path']).read_bytes()
    assert p.requests[-1].edit_frames[-1]==preceding
    assert all(t['source_frames'][i]['sha256']==t['proposed_frames'][i]['sha256'] for i in (0,1))
    assert Checkpoints(s).view(w.job_id,1,0)['token']==before['token']
    m.decide(w.id,t['id'],token=t['preview_token'],decision='accept',note='检查完整片段与前侧接缝后采用末帧修改',acknowledge=True)
    changed=Checkpoints(s).view(w.job_id,1,0)
    assert changed['state']=='awaiting_review' and changed['accepted'] is None
    assert changed['frames'][-1]['sha256']==t['proposed_frames'][-1]['sha256']
    calls=len(p.requests);PlanGeneration(s).advance(w.job_id,p,wait=True);assert len(p.requests)==calls
    accept(s,w,0);PlanGeneration(s).advance(w.job_id,p,wait=True)
    assert p.requests[-1].reference_image==(m.folder(t)/t['proposed_frames'][-1]['file']).read_bytes()


def long_stage_work(setup):
    from sprite_pipeline.providers.base import PollResult,PollStatus
    s,ws,_,p,fixture=setup
    class LongerPlanner(CheckpointPlanner):
        def __call__(self,*args,**kwargs):
            turn,receipt=super().__call__(*args,**kwargs)
            if turn['action']=='finalize':turn['plan']['stages'][0]['frame_count']=16
            return turn,receipt
    ws.model=LongerPlanner()
    def poll(job_id):
        req=p.requests[int(job_id.rsplit('-',1)[1])-1]
        paths=fixture.write_sequence(fixture.root/job_id,shifts=tuple(i%4 for i in range(req.frame_count)))
        images=[x.read_bytes() for x in paths]
        if not req.edit_frames:images=[req.reference_image,*images]
        return PollResult(provider='fixture',provider_job_id=job_id,status=PollStatus.completed,provider_status='completed',images=images,diagnostic_only=True)
    p.poll=poll;p.wait=poll
    w=ready(ws,spec());w=ws.start(w.id,1,w.plan_sha256);PlanGeneration(s).advance(w.job_id,p,wait=True)
    return s,ws,p,w


def test_tail_transition_uses_unchanged_preceding_frame_and_no_bad_end_target(setup):
    s,ws,p,w=long_stage_work(setup)
    class TransitionRegistry(IntentRegistry):
        def send(self,*args,**kwargs):
            result,receipt=super().send(*args,**kwargs)
            if isinstance(result,AdjustmentIntent):result.method='transition'
            return result,receipt
    s.open_motion_review_registry=TransitionRegistry();s.adjustment_test_reviews=True;m=Adjustments(s)
    t=m.create(w.id,request(m,w,start=12,end=15,preserve_motion=False));t=m.advance(w.id,t['id'],p)
    assert t['state']=='ready',t
    assert p.requests[-1].reference_image==(m.folder(t)/'source/011.png').read_bytes()
    assert p.requests[-1].last_frame is None and p.requests[-1].frame_count==4
    assert len(t['proposed_frames'])==16
    assert all(t['proposed_frames'][i]['sha256']==t['source_frames'][i]['sha256'] for i in range(12))
    text=s.open_motion_review_registry.inputs[0][1][0]['text']
    data=json.loads(text.split('boundary:\n',1)[1])
    assert data['preserved_join_frames_1based']==[12]
    assert data['selected_source_frames_1based']==[13,14,15,16]
    assert 'editable_unlocked_stage_ending' not in data and 'source_goal' not in data
    assert 'NEVER substitute transition for an appearance-only request' in text


def test_appearance_scope_rejects_four_frame_tail_before_any_paid_call(setup,monkeypatch):
    # Reuse small fixture art while imposing the real 128px edit capacity.
    monkeypatch.setattr('sprite_pipeline.collaboration.adjustments.edit_window_limit',lambda *_:2)
    s,ws,p,w=long_stage_work(setup);m=Adjustments(s)
    assert m.context(w.id,1,1,0)['appearance_max']==2
    with pytest.raises(ValidationHarnessError,match='不会改用动作重生成'):
        m.create(w.id,request(m,w,start=12,end=15,preserve_motion=True,user='保持物品轮廓，只移除碎片'))
    assert m.listing(w.id)==[] and len(p.requests)==1


def test_appearance_intent_never_falls_back_to_transition_for_a_larger_range(setup,monkeypatch):
    monkeypatch.setattr('sprite_pipeline.collaboration.adjustments.edit_window_limit',lambda *_:2)
    s,ws,p,w=long_stage_work(setup);s.adjustment_test_reviews=True
    class AppearanceRegistry(IntentRegistry):
        def send(self,*args,**kwargs):
            result,receipt=super().send(*args,**kwargs)
            if isinstance(result,AdjustmentIntent):result.method='appearance'
            return result,receipt
    s.open_motion_review_registry=AppearanceRegistry();m=Adjustments(s)
    t=m.create(w.id,request(m,w,start=12,end=15));t=m.advance(w.id,t['id'],p)
    assert t['state']=='failed' and '建议方法不支持' in t['message']
    assert len(t['planning_calls'])==1 and not t['generation_calls'] and len(p.requests)==1
    m.advance(w.id,t['id'],p);assert len(s.open_motion_review_registry.calls)==1


def test_appearance_preserves_source_poses_in_intent_drawing_and_review_context(setup):
    from sprite_pipeline.collaboration.adjustment_review import context_for
    s,ws,p,w=stage_work(setup);s.adjustment_test_reviews=True
    registry=IntentRegistry();s.open_motion_review_registry=registry;m=Adjustments(s)
    t=m.create(w.id,request(m,w,start=2,end=3,preserve_motion=True,user='保持物品轮廓，只移除碎片'))
    t=m.advance(w.id,t['id'],p);assert t['state']=='ready',t
    assert t['methods']==['appearance'] and t['preserve_motion'] is True
    text=registry.inputs[0][1][0]['text'];data=json.loads(text.split('boundary:\n',1)[1])
    assert data['preserve_motion'] is True
    assert 'source_goal' not in data and 'editable_unlocked_stage_ending' not in data
    assert 'Do not complete or improve an old planned checkpoint' in text
    assert p.requests[-1].edit_frames[1:3]==tuple((m.folder(t)/'source'/f'{i:03d}.png').read_bytes() for i in (2,3))
    assert 'Keep each middle-slot original pose' in p.requests[-1].prompt
    context=context_for(t)
    assert 'definition' not in context['segment'] and 'APPEARANCE ONLY' in context['user_request']
    assert 'NOT an ideal planner endpoint' in context['user_request']
    assert all(t['source_frames'][i]['sha256']==t['proposed_frames'][i]['sha256'] for i in (0,1))


def test_completed_clip_keeps_locked_endpoints_and_new_intent_keeps_legacy_digest(setup):
    from sprite_pipeline.collaboration.adjustments import frozen_inputs,FROZEN
    from sprite_pipeline.collaboration.contracts import digest
    s,ws,p,w=completed(setup);m=Adjustments(s);context=m.context(w.id,1,1)
    assert not context['editable_stage_end'] and context['locked_frames']==[0,3,4,7]
    with pytest.raises(ValidationHarnessError):m.create(w.id,request(m,w,stage=None,start=6,end=7))
    t=m.create(w.id,request(m,w,stage=None));assert t['intent_format_version']==4
    old=copy.deepcopy(t);old.pop('intent_format_version');old.pop('comparison_protocol')
    assert digest(frozen_inputs(old))==digest({k:old[k] for k in FROZEN})


def test_omitted_scope_keeps_legacy_receipt_and_v2_prompt(setup):
    from sprite_pipeline.collaboration.contracts import digest
    from sprite_pipeline.collaboration.adjustments import frozen_inputs
    s,ws,p,w=stage_work(setup);s.adjustment_test_reviews=True
    registry=IntentRegistry();s.open_motion_review_registry=registry;m=Adjustments(s)
    body=request(m,w,start=2,end=3);task=m.create(w.id,body)
    raw=body.model_dump(mode='json');raw.pop('preserve_motion');raw.pop('edit_regions');raw.pop('requested_method')
    assert task['request_identity']==digest(raw) and 'preserve_motion' not in task
    task['intent_format_version']=2;task.pop('comparison_protocol');task['frozen_digest']=digest(frozen_inputs(task));m.save(task)
    assert m.create(w.id,body)['id']==task['id']
    m.advance(w.id,task['id'],p)
    text=registry.inputs[0][1][0]['text'];data=json.loads(text.split('boundary:\n',1)[1])
    assert 'Choose an allowed method:' in text and 'NEVER substitute transition' not in text
    assert 'editable_unlocked_stage_ending' in data and 'source_goal' in data


def test_intent_strict_transport_is_new_task_only_and_errors_stop_before_drawing(setup):
    from sprite_pipeline.collaboration.model_config import ModelProfile
    from sprite_pipeline.collaboration.contracts import digest
    from sprite_pipeline.collaboration.adjustments import frozen_inputs
    s,ws,p,w=stage_work(setup);s.adjustment_test_reviews=True
    class Registry(IntentRegistry):
        def profile(self,*_):return ModelProfile(model='kimi-k3.1-pro')
        def send(self,role,content,schema,count,**kwargs):
            if issubclass(schema,AdjustmentIntent):
                self.options=kwargs
                if kwargs.get('on_response'):kwargs['on_response']({'response_id':'fixture-invalid','output_sha256':'a'*64})
                raise ValidationHarnessError('视觉检查未取得有效结论；结构化字段无效（string_too_long, provider_prompt），未自动重试',details={'validation_fields':['provider_prompt']})
            return super().send(role,content,schema,count,**kwargs)
    registry=Registry();s.open_motion_review_registry=registry;m=Adjustments(s)
    task=m.create(w.id,request(m,w));task=m.advance(w.id,task['id'],p)
    assert registry.options['output_format']=='json_schema'
    assert task['state']=='failed' and task['message'].startswith('修改要求理解')
    assert task['planning_calls'][0]['state']=='invalid_response' and task['planning_calls'][0]['validation_fields']==['provider_prompt']
    assert not task['generation_calls'] and len(p.requests)==1
    m.advance(w.id,task['id'],p);assert len(task['planning_calls'])==1
    old=m.create(w.id,request(m,w));old.pop('intent_format_version');old['frozen_digest']=digest(frozen_inputs(old));m.save(old)
    m.advance(w.id,old['id'],p);assert 'output_format' not in registry.options


class IntentRegistry(ExpertRegistry):
    def send(self,role,content,schema,count,**kw):
        if not hasattr(self,'inputs'):self.inputs=[]
        self.inputs.append((schema.__name__,copy.deepcopy(content)))
        if issubclass(schema,AdjustmentIntent):
            self.calls.append(('AdjustmentIntent',content[0]['text']))
            data=json.loads(content[0]['text'].split('boundary:\n',1)[1])
            return schema(goal=data['user_request'] or data['expert_suggestions'][0]['text'],
                preserve='保留未选帧、FPS与原有物品，检查两侧衔接',method=data['methods'][0],
                provider_prompt=data['user_request'] or data['expert_suggestions'][0]['text']),{'usage':{'total_tokens':10}}
        return super().send(role,content,schema,count,**kw)


def stage_work(setup,experts=False):
    s,ws,_,p,_=setup;s.open_motion_model=CheckpointPlanner();ws.model=s.open_motion_model
    w=ready(ws,spec(review_protocol='experts_v1' if experts else 'baseline',budget={'max_review_calls':25}))
    w=ws.start(w.id,1,w.plan_sha256);PlanGeneration(s).advance(w.job_id,p,wait=True)
    return s,ws,p,w


def request(manager,w,stage=0,user='我喜欢更小的抬手幅度，保持其他内容',**kwargs):
    context=manager.context(w.id,w.revision,1,stage)
    return AdjustmentInput(**{**dict(expected_revision=w.revision,candidate_index=1,stage_index=stage,token=context['token'],start=1,end=2,
        user_request=user,request_key=uuid.uuid4().hex,authorized=True),**kwargs})


def completed(setup):
    s,ws,p,w=stage_work(setup)
    for stage in range(2):
        if stage:PlanGeneration(s).advance(w.job_id,p,wait=True)
        accept(s,w,stage)
    PlanGeneration(s).advance(w.job_id,p,wait=True)
    return s,ws,p,w


def test_preference_works_without_expert_defect_and_guards_whole_range(setup):
    s,ws,p,w=stage_work(setup);m=Adjustments(s);body=request(m,w)
    before=Checkpoints(s).view(w.job_id,1,0)
    t=m.create(w.id,body);assert len(p.requests)==1 and not t['planning_calls']
    assert m.create(w.id,body)['id']==t['id']
    for _ in range(2):m.context(w.id,1,1,0);m.load(w.id,t['id'])
    assert len(p.requests)==1
    t=m.advance(w.id,t['id'],p);assert t['state']=='ready',t
    assert t['intent']['goal']==body.user_request
    assert body.user_request in p.requests[-1].prompt
    assert t['intent_source']=='user' and len(p.requests)==2
    for i in (0,3):assert t['proposed_frames'][i]['sha256']==t['source_frames'][i]['sha256']
    assert Checkpoints(s).view(w.job_id,1,0)['token']==before['token']
    with pytest.raises(ConflictError):accept(s,w,0)
    adopted=m.decide(w.id,t['id'],token=t['preview_token'],decision='accept',note='实际播放确认改动与接缝可接受',acknowledge=True)
    assert adopted['state']=='adopted'
    v=Checkpoints(s).view(w.job_id,1,0)
    assert v['review']['adjustment_id']==t['id'] and v['state']=='awaiting_review'
    calls=len(p.requests);m.decide(w.id,t['id'],token=t['preview_token'],decision='accept',note='实际播放确认改动与接缝可接受',acknowledge=True)
    accept(s,w,0);assert len(p.requests)==calls


def test_invalid_selection_no_authorization_no_direction_and_stale_sources_create_nothing(setup):
    s,ws,p,w=stage_work(setup);m=Adjustments(s)
    for kw in ({'start':0},{'end':3},{'end':1},{'authorized':False},{'token':'0'*64},{'user_request':''}):
        with pytest.raises((ValidationHarnessError,ConflictError)):m.create(w.id,request(m,w,**kw))
    assert m.listing(w.id)==[] and len(p.requests)==1


def test_existing_advice_used_only_when_user_input_empty(setup):
    s,ws,p,w=stage_work(setup);m=Adjustments(s)
    with s.store.locked_job(w.job_id) as j:
        j.candidates[0].plan_execution.stages[0].review['checks']=[{'dimension':'equipment','status':'fail','frames':[2,3],
            'evidence':'保持相同物品，减小轮廓漂移','confidence':.95}]
    t=m.create(w.id,request(m,w,user=''));t=m.advance(w.id,t['id'],p)
    assert t['intent_source']=='expert' and t['intent']['goal']=='保持相同物品，减小轮廓漂移'
    m.decide(w.id,t['id'],token=t['preview_token'],decision='reject',note='保留原版')
    second=m.create(w.id,request(m,w,user='我希望物品轮廓略大一些，符合个人偏好'))
    second=m.advance(w.id,second['id'],p)
    assert second['intent']['goal'].startswith('我希望物品轮廓略大') and second['expert_suggestions']


def test_unknown_submission_never_retries_and_record_is_retained(setup):
    s,ws,p,w=stage_work(setup);m=Adjustments(s);p.unknown=True
    t=m.create(w.id,request(m,w));t=m.advance(w.id,t['id'],p)
    assert t['state']=='unknown' and len(p.requests)==2
    for _ in range(2):m.advance(w.id,t['id'],p);m.recover()
    assert len(p.requests)==2
    with pytest.raises(ConflictError):m.create(w.id,request(m,w))
    m.decide(w.id,t['id'],token=t['source_token'],decision='reject',note='保留原版')
    assert m.load(w.id,t['id'])['generation_calls'][0]['state']=='unknown'


def test_frozen_goal_and_proposed_frame_tampering_block_adoption(setup):
    s,ws,p,w=stage_work(setup);m=Adjustments(s);t=m.create(w.id,request(m,w));t=m.advance(w.id,t['id'],p)
    before=s.store.load(w.job_id).candidates[0].plan_execution.stages[0].active_frames
    (m.folder(t)/'proposed/000.png').write_bytes(b'changed')
    with pytest.raises(ConflictError):m.decide(w.id,t['id'],token=t['preview_token'],decision='accept',note='不能接受过期证据',acknowledge=True)
    assert s.store.load(w.job_id).candidates[0].plan_execution.stages[0].active_frames==before


def test_explicit_new_request_and_full_pre_adoption_review_are_bounded(setup):
    s,ws,p,w=stage_work(setup,True);s.open_motion_review_registry=IntentRegistry();s.adjustment_test_reviews=True
    m=Adjustments(s);t=m.create(w.id,request(m,w));t=m.advance(w.id,t['id'],p)
    assert t['state']=='ready',t
    assert len(t['planning_calls'])==1 and len(t['generation_calls'])==1 and len(t['review_calls'])==5
    assert body_goal(t) in s.open_motion_review_registry.calls[0][1]
    planning_text=s.open_motion_review_registry.calls[0][1]
    planning_data=json.loads(planning_text.split('boundary:\n',1)[1])
    assert planning_data['selected_source_frames_1based']==[2,3]
    assert planning_data['preserved_join_frames_1based']==[1,4]
    assert 'start' not in planning_data and 'end' not in planning_data
    assert 'Never put global source frame numbers in provider_prompt' in planning_text
    for schema,content in s.open_motion_review_registry.inputs:
        if schema in {'Audit','Resolution','AdjustmentAudit','AdjustmentResolution'}:
            comparison=[p for p in content if p.get('type')=='input_text' and p.get('text','').startswith('BEFORE / ORIGINAL')]
            assert len(comparison)==1
            assert 'Only source frames 2 through 3 may change' in comparison[0]['text']
        elif schema=='Observations':
            assert not any(p.get('text','').startswith('BEFORE / ORIGINAL') for p in content)
    assert t['review']['expert_review']['simulated']
    old_count=review_call_count(s.store.load(w.job_id))
    m.decide(w.id,t['id'],token=t['preview_token'],decision='accept',note='已播放原版备选与两侧衔接',acknowledge=True)
    assert len(s.open_motion_review_registry.calls)==6 and review_call_count(s.store.load(w.job_id))==old_count
    assert len(m.load(w.id,t['id'])['review_calls'])==5


def body_goal(t):return t['user_request']


def test_complete_candidate_creates_version_preserves_old_export_and_all_other_frames(setup):
    s,ws,p,w=completed(setup);s.approve_candidate(w.job_id,1,reviewer='test',acknowledge_warnings=True,review_note='实际播放完整原动画')
    s.export_candidate(w.job_id,1)
    before=(s.store.job_dir(w.job_id)/'job.json').read_bytes();m=Adjustments(s)
    t=m.create(w.id,request(m,w,stage=None));t=m.advance(w.id,t['id'],p)
    assert t['state']=='ready',t
    count=len(p.requests)
    m.decide(w.id,t['id'],token=t['preview_token'],decision='accept',note='完整对比后采用偏好修改版',acknowledge=True)
    new=ws.load(w.id);assert new.revision==2 and new.job_id!=w.job_id
    assert (s.store.job_dir(w.job_id)/'job.json').read_bytes()==before
    assert ws.load(w.id,1).job_id==w.job_id
    candidate=s.store.load(new.job_id).candidates[0]
    assert candidate.status.value=='approved'
    assert [f.sha256 for f in candidate.frames]==[f['sha256'] for f in t['proposed_frames']]
    s.export_candidate(new.job_id,1);s.export_candidate(new.job_id,1,{'overwrite':True})
    assert len(p.requests)==count
    m.decide(w.id,t['id'],token=t['preview_token'],decision='accept',note='重复响应恢复',acknowledge=True)
    assert ws.load(w.id).revision==2


def test_api_read_routes_have_typed_body_and_do_not_create_tasks(setup):
    from fastapi.testclient import TestClient
    from sprite_pipeline.api_app import create_api
    s,ws,p,w=stage_work(setup);app=create_api(service=s);client=TestClient(app)
    schema=client.get('/openapi.json');assert schema.status_code==200
    result=client.get(f'/v1/open-motion/{w.id}/adjustments?revision=1&candidate=1&stage=0')
    assert result.status_code==200 and result.json()['tasks']==[]
    body=request(Adjustments(s),w).model_dump(mode='json')
    response=client.post(f'/v1/open-motion/{w.id}/adjustments',json=body)
    assert response.status_code==200,response.text
    assert response.json()['adjustment']['state']=='queued' and len(p.requests)==1


def test_intent_conflict_stops_before_drawing_and_keeps_paid_planning_receipt(setup):
    s,ws,p,w=stage_work(setup);s.adjustment_test_reviews=True
    class ConflictRegistry(IntentRegistry):
        def send(self,*args,**kw):
            result,receipt=super().send(*args,**kw)
            if isinstance(result,AdjustmentIntent):result.conflict='此要求需要改变未选帧，当前范围不能完成'
            return result,receipt
    s.open_motion_review_registry=ConflictRegistry();m=Adjustments(s)
    t=m.create(w.id,request(m,w,user='我希望全部动作变慢一倍，但只选这两帧'))
    t=m.advance(w.id,t['id'],p)
    assert t['state']=='needs_input' and len(t['planning_calls'])==1
    assert not t['generation_calls'] and len(p.requests)==1
    m.advance(w.id,t['id'],p);assert len(s.open_motion_review_registry.calls)==1


def test_changed_source_and_expired_budget_cannot_be_bypassed_by_old_preview(setup):
    s,ws,p,w=stage_work(setup,True);m=Adjustments(s)
    with pytest.raises(ValidationHarnessError):m.create(w.id,request(m,w,max_review_calls=2))
    assert m.listing(w.id)==[]
    t=m.create(w.id,request(m,w));t=m.advance(w.id,t['id'],p)
    with s.store.locked_job(w.job_id) as job:job.action.fps=24
    with pytest.raises(ConflictError):m.decide(w.id,t['id'],token=t['preview_token'],decision='accept',note='不能套用旧播放合同',acknowledge=True)
    m.decide(w.id,t['id'],token=t['preview_token'],decision='reject',note='保留原版')
    assert not s.store.load(w.job_id).candidates[0].plan_execution.stages[0].active_frames
