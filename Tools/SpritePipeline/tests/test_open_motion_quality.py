"""Quality contracts and model routing must work for motions without preset IDs."""
import hashlib
import json
from unittest.mock import patch
import pytest
from pydantic import ValidationError
from test_open_motion import setup, Planner, spec, ready
from sprite_pipeline.collaboration.contracts import MotionQuality, PlanProposal, digest
from sprite_pipeline.collaboration.quality import compiled_prompt, assemble_quality_frames
from sprite_pipeline.collaboration.model_config import ModelRegistry, ModelConfiguration, ModelProfile
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.visual_review import QualityReviewer, Observations, Audit, review_state
from sprite_pipeline.errors import ExportBlockedError, ValidationHarnessError


def quality():
    return MotionQuality(event_contract='Lift the hat once, then bow once; no repeated cycle.',
        appearance_contract='Keep reference outfit and one hat in the same physical hand.',
        ending_contract='Stay bowed with the hat held; do not stand back up.',
        rhythm_contract='Anticipate briefly, move decisively, slow into the final pose.',playback_fps=18,
        criteria=[{'dimension':d,'criterion':text} for d,text in [
            ('completeness','One hat lift followed by one bow, ending bowed.'),
            ('equipment','One hat throughout, unchanged physical ownership.'),
            ('rhythm','Continuous transition with a clear deceleration, no redundant holds.')]])


def quality_work(workspace):
    original=Planner.__call__
    def planned(self,role,*args,**kwargs):
        value,receipt=original(self,role,*args,**kwargs)
        if role=='coordinator': value['plan']['quality']=quality().model_dump(mode='json')
        return value,receipt
    with patch.object(Planner,'__call__',planned):return ready(workspace)


class ReviewRegistry:
    def __init__(self,status='pass',invalid=False):self.calls=[];self.status=status;self.invalid=invalid
    def profile(self,*_):return ModelProfile()
    def send(self,role,content,schema,count,**kwargs):
        self.calls.append((role,schema.__name__))
        if schema is Observations:
            value={'reference_equipment':'One hat','frames':[{'frame':i,'pose':'弯腰姿态','equipment':'同一只帽子','change':'连续向下，末端减速'} for i in range(1,count+1)]}
            if self.invalid:value['frames'].pop()
        else:
            value={'summary':'已检查全部帧','checks':[{'dimension':d,'status':self.status,'confidence':.95,'frames':[1,max(1,count//2),count],'evidence':'依据首末帧及中间连续变化记录'} for d in ['completeness','equipment','rhythm']]}
        return schema.model_validate(value),{'requested_model':'hy-vision-2.0-instruct','usage':{'total_tokens':12}}


def generated(setup):
    s,ws,_,provider,_=setup
    w=quality_work(ws);w=ws.start(w.id,w.revision,w.plan_sha256)
    job=PlanGeneration(s).advance(w.job_id,provider,wait=True)
    # Fixture rendering never claims a model-quality pass; the audit is mocked explicitly below.
    assert job.candidates[0].plan_execution.quality_review['state']=='diagnostic'
    with s.store.locked_job(job.job_id) as current:
        c=current.candidates[0];c.diagnostic_only=False
        c.plan_execution.quality_review={'state':'pending','requests':[]}
    return s,job.job_id,provider


def test_shared_contract_reaches_every_request_without_action_branches(setup):
    s,job_id,provider=generated(setup)
    job=s.store.load(job_id)
    assert job.action.fps==18 and job.action.action_id.startswith('motion_')
    for request in provider.requests:
        assert quality().appearance_contract in request.prompt
        assert quality().event_contract in request.prompt
        assert len(request.prompt)<=1000
    assert quality().ending_contract not in provider.requests[0].prompt
    assert quality().ending_contract in provider.requests[-1].prompt
    assert job.candidates[0].plan_execution.frame_mapping
    assert job.request.open_plan.compiled_prompts == [r.prompt for r in provider.requests]


def test_old_plan_hash_unchanged_and_only_extra_context_is_removed(setup):
    _,ws,planner,_,fixture=setup
    work=ready(ws)
    plan=work.plan.model_dump(mode='json')
    assert 'quality' not in plan and digest(plan)==work.plan_sha256
    assert PlanProposal.model_validate(plan).quality is None
    images=[p.read_bytes() for p in fixture.write_sequence(fixture.root/'timeline')]
    raw=[[images[0],*images],[images[-1],*images]]
    combined,timeline,mapping=assemble_quality_frames(raw,work.plan.stages,images[0])
    assert len(combined)==8 and all(t['context_removed'] for t in timeline)
    assert raw[0][0]==images[0] and len(raw[0])==5  # Originals untouched.
    held=[images[0]]*4
    result,_,_=assemble_quality_frames([held],[work.plan.stages[0]],images[0])
    assert len(result)==4  # Intentional holds are not deleted.


@pytest.mark.parametrize('status',['pass','fail','uncertain'])
def test_review_evidence_gate_and_no_repeat_calls(setup,status):
    s,job_id,provider=generated(setup);registry=ReviewRegistry(status)
    s.open_motion_review_registry=registry
    QualityReviewer(s).run(job_id,1)
    c=s.store.load(job_id).candidates[0]
    assert c.plan_execution.quality_review['verdict']==status
    assert len(registry.calls)==2
    QualityReviewer(s).run(job_id,1);PlanGeneration(s).advance(job_id,provider,wait=True)
    assert len(registry.calls)==2 and len(provider.requests)==2
    if status!='pass':
        with pytest.raises(ExportBlockedError):s.approve_candidate(job_id,1,reviewer='test',acknowledge_warnings=True)
    # Explicit human adjudication stays possible; automatic review never approves.
    assert c.status.value=='review_ready'
    s.approve_candidate(job_id,1,reviewer='test',acknowledge_warnings=True,review_note='人工完整检查后的结论')


def test_incomplete_observations_never_pass_and_interrupted_review_not_retried(setup):
    s,job_id,_=generated(setup);registry=ReviewRegistry(invalid=True);s.open_motion_review_registry=registry
    QualityReviewer(s).run(job_id,1)
    c=s.store.load(job_id).candidates[0]
    assert review_state(c)['state']=='failed' and len(registry.calls)==1
    QualityReviewer(s).run(job_id,1);assert len(registry.calls)==1
    with s.store.locked_job(job_id) as job:
        job.candidates[0].plan_execution.quality_review.update(state='running')
    QualityReviewer(s).run(job_id,1)
    assert review_state(s.store.load(job_id).candidates[0])['state']=='unknown'
    assert len(registry.calls)==1


def test_frame_edits_invalidate_visual_evidence(setup):
    s,job_id,_=generated(setup);s.open_motion_review_registry=ReviewRegistry()
    QualityReviewer(s).run(job_id,1)
    with s.store.locked_job(job_id) as job:
        job.candidates[0].frames[0].sha256='a'*64
    assert review_state(s.store.load(job_id).candidates[0])['state']=='stale'


def test_one_pose_cannot_prove_a_timing_failure():
    from sprite_pipeline.collaboration.visual_review import grounded_audit
    report=Audit(summary='模型自行编写的整体通过总结',checks=[{'dimension':d,'status':'fail' if d=='rhythm' else 'pass','confidence':1,'frames':[7] if d=='rhythm' else [1,6,12],'evidence':'仅单帧不能证明停顿'} for d in ['completeness','equipment','rhythm']])
    verdict,checks,summary=grounded_audit(report,12)
    assert verdict=='uncertain' and checks[-1]['status']=='uncertain' and '证据不足' in summary


def test_approved_prompt_bytes_survive_later_compiler_changes(setup):
    s,ws,_,provider,_=setup
    work=quality_work(ws);work=ws.start(work.id,work.revision,work.plan_sha256)
    frozen=s.store.load(work.job_id).request.open_plan.compiled_prompts
    with patch('sprite_pipeline.collaboration.quality.compiled_prompt',side_effect=AssertionError('must use frozen prompt')):
        PlanGeneration(s).advance(work.job_id,provider,wait=True)
    assert [r.prompt for r in provider.requests]==frozen


def test_key_pose_contract_is_generic_bounded_and_preserves_v2_hash(setup):
    from sprite_pipeline.collaboration.contracts import KeyPose
    _,ws,_,_,_=setup;work=quality_work(ws)
    encoded=work.plan.model_dump(mode='json')
    assert 'key_poses' not in encoded['quality']
    assert digest(PlanProposal.model_validate(encoded).model_dump(mode='json'))==work.plan_sha256
    q=work.plan.quality.model_copy(update={'key_poses':[KeyPose(frame=1,description='Hand at the hat brim.'),KeyPose(frame=3,description='Hat raised above head.'),KeyPose(frame=8,description='Torso bowed; hat held in front.')]})
    value={**encoded,'quality':q.model_dump(mode='json')};plan=PlanProposal.model_validate(value)
    from sprite_pipeline.models import CharacterPreset
    prompt=compiled_prompt(plan,CharacterPreset.model_validate(work.character),0)
    assert 'Hand at the hat brim.' in prompt and 'Torso bowed' not in prompt
    value['quality']['key_poses'][2]['frame']=9
    with pytest.raises(ValidationError):PlanProposal.model_validate(value)


def test_manual_model_profiles_persist_and_snapshots_do_not_follow_settings(setup):
    s,_,_,_,_=setup;registry=ModelRegistry(s.settings)
    custom=ModelProfile(model='custom-multimodal-model',max_output_tokens=12000)
    config=ModelConfiguration(default=ModelProfile(model='kimi-k3.1-pro',max_output_tokens=16000),roles={'reviewer':ModelProfile()},saved_models=[custom])
    registry.save(config);snapshot=registry.load().model_dump(mode='json')
    registry.save(ModelConfiguration(default=custom))
    assert registry.profile('motion',snapshot).model=='kimi-k3.1-pro'
    assert registry.profile('reviewer',snapshot).model=='hy-vision-2.0-instruct'
    assert registry.profile('motion').model=='custom-multimodal-model'
    assert 'key' not in json.dumps(snapshot)
    with pytest.raises(ValidationError):ModelProfile(model='kimi-k3.1-pro',token_parameter='max_tokens')
    with pytest.raises(ValidationError):ModelProfile(supports_images=False)


def test_kimi_transport_uses_its_parameter_contract(setup):
    s,_,_,_,_=setup;registry=ModelRegistry(s.settings)
    config=ModelConfiguration(default=ModelProfile(model='kimi-k3.1-pro',max_output_tokens=16000,reasoning_effort='high'))
    registry.save(config)
    response={'summary':'检查记录','checks':[{'dimension':d,'status':'pass','confidence':.95,'frames':[1],'evidence':'单元测试结构化证据'} for d in ['completeness','equipment','rhythm']]}
    with patch.object(ModelRegistry,'key',return_value='isolated-test-key'),patch('sprite_pipeline.vision_review.httpx.Client') as factory:
        client=factory.return_value.__enter__.return_value
        client.post.return_value.status_code=200
        client.post.return_value.json.return_value={'model':'kimi-k3.1-pro','choices':[{'finish_reason':'stop','message':{'content':json.dumps(response)}}]}
        registry.send('motion',[],Audit,1)
        body=client.post.call_args.kwargs['json']
        assert body['max_completion_tokens']==16000 and body['reasoning_effort']=='high'
        assert 'max_tokens' not in body and 'temperature' not in body and 'thinking' not in body
        assert body['response_format']=={'type':'json_object'}


def test_explicit_strict_tokenhub_contract_uses_native_schema_and_never_falls_back(setup):
    s,_,_,_,_=setup;registry=ModelRegistry(s.settings)
    registry.save(ModelConfiguration(default=ModelProfile(model='kimi-k3.1-pro')))
    response={'summary':'模拟符合合同的响应','checks':[{'dimension':d,'status':'pass','confidence':.95,'frames':[1],'evidence':'离线合同验证，不代表模型质量'} for d in ['completeness','equipment','rhythm']]}
    with patch.object(ModelRegistry,'key',return_value='isolated-test-key'),patch('sprite_pipeline.vision_review.httpx.Client') as factory:
        client=factory.return_value.__enter__.return_value;client.post.return_value.status_code=200
        client.post.return_value.json.return_value={'model':'kimi-k3.1-pro','choices':[{'finish_reason':'stop','message':{'content':json.dumps(response)}}]}
        registry.send('strategy',[],Audit,1,output_format='json_schema')
        body=client.post.call_args.kwargs['json'];fmt=body['response_format']
        assert fmt['type']=='json_schema' and fmt['json_schema']['strict'] is True
        assert fmt['json_schema']['schema']['additionalProperties'] is False
        assert fmt['json_schema']['name']=='open_motion_plan'
        client.post.reset_mock();client.post.return_value.status_code=400
        with pytest.raises(ValidationHarnessError,match='HTTP 400'):
            registry.send('strategy',[],Audit,1,output_format='json_schema')
        assert client.post.call_count==1
        assert client.post.call_args.kwargs['json']['response_format']['type']=='json_schema'


@pytest.mark.parametrize('model', ['glm-5.3-flash', 'glm-5.3-flashx'])
def test_glm_multimodal_transport_and_profile_validation(setup, model):
    s,_,_,_,_=setup;registry=ModelRegistry(s.settings)
    profile=ModelProfile(model=model,max_output_tokens=16384,reasoning_effort='low',timeout_seconds=300)
    registry.save(ModelConfiguration(default=ModelProfile(model='kimi-k3.1-pro'),roles={'reviewer':profile}))
    result={'reference_equipment':'One sword','frames':[{'frame':1,'pose':'standing','equipment':'one sword','change':'first frame'}]}
    with patch.object(ModelRegistry,'key',return_value='isolated-test-key'),patch('sprite_pipeline.vision_review.httpx.Client') as factory:
        client=factory.return_value.__enter__.return_value
        client.post.return_value.status_code=200
        client.post.return_value.json.return_value={'model':model,'choices':[{'finish_reason':'stop','message':{'content':json.dumps(result)}}]}
        registry.send('reviewer',[{'type':'input_image','image_url':'data:image/png;base64,test'}],Observations,1)
        body=client.post.call_args.kwargs['json']
        assert body['model']==model and body['max_tokens']==16384 and body['reasoning_effort']=='low'
        assert 'max_completion_tokens' not in body and 'thinking' not in body and 'temperature' not in body
        assert body['messages'][0]['content'][0]['image_url']['url']=='data:image/png;base64,test'
        assert factory.call_args.kwargs['timeout']==300
        assert body['response_format']=={'type':'json_object'}
    with pytest.raises(ValidationError):ModelProfile(model=model,token_parameter='max_completion_tokens')
    with pytest.raises(ValidationError):ModelProfile(model=model,reasoning_effort='medium')


def test_http_failure_preserves_safe_diagnostics_without_echoing_body_or_retry(setup):
    s,_,_,_,_=setup;registry=ModelRegistry(s.settings)
    registry.save(ModelConfiguration(default=ModelProfile(model='kimi-k3.1-pro')))
    receipts=[]
    with patch.object(ModelRegistry,'key',return_value='test-private-key'),patch('sprite_pipeline.vision_review.httpx.Client') as factory:
        client=factory.return_value.__enter__.return_value;response=client.post.return_value
        response.status_code=400;response.headers={'x-request-id':'test-request-0001'}
        response.json.return_value={'error':{'code':'InvalidParameterValue','message':'max_tokens invalid; echoed secret test-private-key and private prompt'}}
        with pytest.raises(ValidationHarnessError) as caught:
            registry.send('reviewer',[],Audit,16,on_response=receipts.append)
        assert client.post.call_count==1
        assert receipts==[{'http_status':400,'provider_error_code':'InvalidParameterValue','provider_error_parameter':'max_tokens','provider_request_id':'test-request-0001'}]
        assert caught.value.details==receipts[0]
        assert 'test-private-key' not in str(caught.value) and 'private prompt' not in str(caught.value.details)


@pytest.mark.parametrize('model', ['glm-5.2', 'glm-5.3'])
def test_known_text_only_glm_cannot_be_assigned_to_image_experts(model):
    with pytest.raises(ValidationError,match='不支持图片'):ModelProfile(model=model)


def test_invalid_key_does_not_publish_new_model_configuration(setup, monkeypatch):
    from fastapi.testclient import TestClient
    from sprite_pipeline.api_app import create_api
    s,_,_,_,_=setup;registry=ModelRegistry(s.settings);before=registry.load()
    monkeypatch.setenv('TOKENHUB_API_KEY','isolated-env-key')
    client=TestClient(create_api(service=s))
    result=client.post('/v1/open-motion/settings',json={'configuration':ModelConfiguration(default=ModelProfile(model='new-custom-model')).model_dump(mode='json'),'tokenhub_key':'another-isolated-key'})
    assert result.status_code==422 and '启动环境' in result.text
    assert registry.load()==before
    assert 'another-isolated-key' not in result.text
