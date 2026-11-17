"""Reference structure must reach real provider inputs without changing old plans."""
import copy,uuid
from unittest.mock import patch
import pytest

from test_open_motion import setup,spec
from test_temporal_structures import temporal
from test_open_motion_checkpoints import CheckpointPlanner,accept
from test_open_motion_refinement import motion
from sprite_pipeline.collaboration.contracts import TaskSpec,PlanBinding,digest
from sprite_pipeline.collaboration.workspace import OpenMotionWorkspace
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.planning import PlanningModel
from sprite_pipeline.collaboration.structures import VisualStructures
from sprite_pipeline.collaboration.structure_control import validate_structure_binding
from sprite_pipeline.errors import ConflictError,ValidationHarnessError
from sprite_pipeline.jsonio import read_json,atomic_write_json


class StructurePlanner(CheckpointPlanner):
    def __call__(self,role,work,reference,**kwargs):
        result,receipt=super().__call__(role,work,reference,**kwargs)
        assert work.visual_structure and work.visual_structure['data']['parts'][0]['id']=='head'
        if result['action']=='finalize':
            result['plan']['quality']['version']=4
            for stage in result['plan']['stages']:
                stage['motion']=motion().model_dump(mode='json')
                stage['motion']['generation_hint']='Keep the observed head silhouette continuous while the body follows the intended motion.'
                stage['structure_usage']={'part_ids':['head'],'anchor_ids':['head_center'],'relation_ids':[],
                    'effect':'Use the verified head part and point to distinguish head shape from body movement.'}
        return result,receipt


def planned(setup,temporal):
    s,ws,_,provider,_=setup;static=temporal[2]
    ws.model=StructurePlanner()
    value=spec(visual_structure={'analysis_id':static['id'],'token':static['document']['token']})
    w=ws.create(value,uuid.uuid4().hex,planning_authorized=True);w=ws.plan(w.id)
    assert w.status=='ready',w.message
    return s,ws,provider,w


def test_structure_free_spec_and_stage_hashes_remain_unchanged(setup):
    raw=spec().model_dump(mode='json')
    assert 'visual_structure' not in raw
    assert TaskSpec.model_validate({**raw,'visual_structure':None}).model_dump(mode='json')==raw
    s,ws,_,_,_=setup
    w=ws.create(spec(),uuid.uuid4().hex,planning_authorized=True);w=ws.plan(w.id)
    assert 'visual_structure' not in w.model_dump(mode='json')
    assert all('structure_usage' not in stage.model_dump(mode='json') for stage in w.plan.stages)


def test_source_binding_is_explicit_and_old_request_is_cached(setup,temporal):
    s,ws,provider,w=planned(setup,temporal)
    before=len(ws.model.calls);snapshot=copy.deepcopy(w.visual_structure)
    same=ws.create(w.spec,w.request_key,planning_authorized=True)
    assert same.id==w.id and same.visual_structure==snapshot and len(ws.model.calls)==before
    assert all(c['visual_structure_sha256']==snapshot['sha256'] for c in w.planning_calls)
    assert snapshot['geometry'][0]['visible_area']>0


def test_checked_structure_reaches_independent_planning_input(setup,temporal):
    s,ws,provider,w=planned(setup,temporal);captured=[]
    model=PlanningModel(s.settings)
    class Registry:
        def send(self,role,content,schema,*args,**kwargs):
            captured.append(content)
            return schema.model_validate({'action':'propose','summary':'根据真实结构形成独立观察',
                'findings':[{'text':'可见头部轮廓','source':'reference','evidence':'核对原图与头部区域'}]}),{}
    model.registry=Registry()
    model('appearance',w,ws.reference(w))
    text=captured[0][0]['text']
    assert 'checked_visual_structure' in text and w.visual_structure['sha256'] in text
    assert 'motion.generation_hint MUST' in text
    assert 'OUTPUT FORMAT version 4' in text
    assert 'allowed_structure_usage' in text and 'not_control_evidence' in text
    assert 'leave proposal/plan null.' not in text
    assert captured[0][1]['type']=='input_image'
    historical=w.model_copy(update={'planning_format_version':None})
    assert 'planning_format_version' not in historical.model_dump(mode='json')
    model('appearance',historical,ws.reference(w))
    assert 'OUTPUT FORMAT version 1' not in captured[1][0]['text']
    assert 'OUTPUT FORMAT version 2' not in captured[1][0]['text']
    assert 'OUTPUT FORMAT version 3' not in captured[1][0]['text']
    assert 'OUTPUT FORMAT version 4' not in captured[1][0]['text']
    assert 'leave proposal/plan null.' in captured[1][0]['text']
    prior=w.model_copy(update={'planning_format_version':1})
    model('appearance',prior,ws.reference(w))
    assert 'OUTPUT FORMAT version 1' in captured[2][0]['text']
    assert 'allowed_structure_usage' not in captured[2][0]['text']


def test_strategy_contract_has_only_one_proposal_slot_and_preserves_legacy_schema(setup,temporal):
    from sprite_pipeline.collaboration.contracts import StrategyTurn,ExpertTurn
    from pydantic import ValidationError
    s,ws,provider,w=planned(setup,temporal);model=PlanningModel(s.settings);schemas=[];contents=[]
    class Registry:
        def send(self,role,content,schema,*args,**kwargs):
            schemas.append(schema)
            contents.append(content)
            return schema.model_validate({'action':'propose','summary':'形成可核对的策略提案','proposal':w.plan.model_dump(mode='json')}),{}
    model.registry=Registry();model('strategy',w,ws.reference(w))
    model('strategy',w.model_copy(update={'planning_format_version':1}),ws.reference(w))
    assert issubclass(schemas[0],StrategyTurn) and schemas[1] is ExpertTurn
    import json
    current=json.loads(contents[0][0]['text'].split('TASK DATA:\n',1)[1])
    previous=json.loads(contents[1][0]['text'].split('TASK DATA:\n',1)[1])
    assert all('plan' not in m['response'] and 'proposal' not in m['response'] for m in current['peer_messages'] if m['role'] in {'appearance','motion'})
    assert all(m['response']['plan'] is None and m['response']['proposal'] is None for m in previous['peer_messages'] if m['role'] in {'appearance','motion'})
    assert all('plan' in m['response'] for m in w.messages if m['role'] in {'appearance','motion'})
    assert 'plan' not in StrategyTurn.model_json_schema()['properties']
    valid={'action':'propose','summary':'完整的策略提案','proposal':w.plan.model_dump(mode='json')}
    assert StrategyTurn.model_validate(valid).proposal.stages
    with pytest.raises(ValidationError):StrategyTurn.model_validate({**valid,'plan':None})
    invalid=copy.deepcopy(valid);invalid['proposal']['plan']=None
    with pytest.raises(ValidationError):StrategyTurn.model_validate(invalid)


def test_structure_view_separates_unknowns_and_never_promotes_their_relations(setup,temporal):
    from sprite_pipeline.collaboration.structure_control import planning_structure
    s,ws,provider,w=planned(setup,temporal);snapshot=copy.deepcopy(w.visual_structure)
    snapshot['data']['anchors'].append({'id':'hidden_joint','part_id':'head','name':'不可见连接点',
        'x':None,'y':None,'state':'unknown','evidence':'原图未显示'})
    snapshot['data']['relations'].append({'id':'hidden_contact','type':'contact','source':'head_center',
        'target':'hidden_joint','state':'visible','evidence':'即使关系误标可见，也不能把未知端点当成控制事实'})
    snapshot['sha256']=digest({k:v for k,v in snapshot.items() if k!='sha256'});before=copy.deepcopy(snapshot)
    view=planning_structure(snapshot,version=2)
    assert view['allowed_structure_usage']=={'part_ids':['head'],'anchor_ids':['head_center'],'relation_ids':[]}
    assert all(a['id']!='hidden_joint' for a in view['usable_structure']['anchors'])
    assert view['not_control_evidence']['unavailable_observations'][0]['state']=='unknown'
    assert snapshot==before and planning_structure(snapshot)['data']==snapshot['data']
    plan=w.plan.model_copy(deep=True);plan.stages[0].structure_usage.relation_ids=['hidden_contact']
    with pytest.raises(ValidationHarnessError):validate_structure_binding(w.spec,snapshot,w.reference_sha256,plan)


def test_new_format_selects_verified_strict_transport_without_upgrading_saved_tasks(setup,temporal):
    from sprite_pipeline.collaboration.model_config import ModelConfiguration,ModelProfile
    s,ws,provider,w=planned(setup,temporal);calls=[];model=PlanningModel(s.settings)
    class Registry:
        def send(self,role,content,schema,count,**kwargs):
            calls.append(kwargs)
            return schema.model_validate({'action':'propose','summary':'离线检查传输选择',
                'findings':[{'text':'原图证据','source':'reference','evidence':'诊断素材'}]}),{}
    model.registry=Registry();config=ModelConfiguration(default=ModelProfile(model='kimi-k3.1-pro')).model_dump(mode='json')
    current=w.model_copy(update={'planning_config':config})
    _,receipt=model('appearance',current,ws.reference(w))
    assert calls[-1]['output_format']=='json_schema' and receipt['requested_output_format']=='json_schema'
    for version in (None,1,2):
        model('appearance',current.model_copy(update={'planning_format_version':version}),ws.reference(w))
        assert 'output_format' not in calls[-1]
    custom=ModelConfiguration(default=ModelProfile(model='unverified-custom-model')).model_dump(mode='json')
    model('appearance',current.model_copy(update={'planning_config':custom}),ws.reference(w))
    assert 'output_format' not in calls[-1]


def test_task_bound_schema_enforces_visible_identifiers_and_explicit_stage_usage(setup,temporal):
    from sprite_pipeline.collaboration.structure_control import bind_planning_schema
    from sprite_pipeline.collaboration.contracts import StrategyTurn,CoordinatorTurn
    from pydantic import ValidationError
    s,ws,provider,w=planned(setup,temporal)
    for base,field,action in ((StrategyTurn,'proposal','propose'),(CoordinatorTurn,'plan','finalize')):
        schema=bind_planning_schema(base,w.visual_structure);wire=schema.model_json_schema()
        fields=wire['$defs']['StructureUsage']['properties']
        assert fields['part_ids']['items']['enum']==['head']
        assert fields['anchor_ids']['items']['enum']==['head_center']
        assert fields['relation_ids']['maxItems']==0
        assert wire['$defs']['PlanStage']['properties']['structure_usage']=={'$ref':'#/$defs/StructureUsage'}
        valid={'action':action,'summary':'诊断方案',''+field:w.plan.model_dump(mode='json')}
        schema.model_validate(valid)
        invalid=copy.deepcopy(valid);invalid[field]['stages'][0]['structure_usage']['relation_ids']=['invented_hidden_relation']
        with pytest.raises(ValidationError,match='unavailable relation_ids'):schema.model_validate(invalid)
        invalid=copy.deepcopy(valid);invalid[field]['stages'][0]['structure_usage']=None
        with pytest.raises(ValidationError,match='explicit stage'):schema.model_validate(invalid)


def test_actual_provider_hint_and_source_receipt_are_bound(setup,temporal):
    s,ws,provider,w=planned(setup,temporal);before=len(provider.requests)
    w=ws.start(w.id,w.revision,w.plan_sha256)
    PlanGeneration(s).advance(w.job_id,provider,wait=True)
    assert len(provider.requests)==before+1
    assert w.plan.stages[0].motion.generation_hint in provider.requests[-1].prompt
    intent=read_json(s.store.job_dir(w.job_id)/'provider/candidate_01.plan/0/submit.intent.json')
    assert intent['visual_structure_sha256']==w.visual_structure['sha256']
    assert intent['structure_usage']['part_ids']==['head']
    assert intent['structure_drawing_hint'] in intent['prompt']
    assert not s.store.load(w.job_id).candidates[0].frames


def test_wrong_or_unconfirmed_structure_does_not_create_paid_work(setup,temporal):
    s,ws,_,provider,_=setup;static=temporal[2];ws.model=StructurePlanner()
    before=len(ws.listing())
    with pytest.raises(ConflictError):ws.create(spec(visual_structure={'analysis_id':static['id'],'token':'0'*64}),uuid.uuid4().hex,planning_authorized=True)
    changed=VisualStructures(s).correct(static['id'],static['revision'],static['document']['token'],uuid.uuid4().hex,
        restore_revision=1,note='恢复未确认的诊断结构')
    with pytest.raises(ValidationHarnessError):ws.create(spec(visual_structure={'analysis_id':changed['id'],'token':changed['document']['token']}),uuid.uuid4().hex,planning_authorized=True)
    assert len(ws.listing())==before and not ws.model.calls


def test_correction_after_plan_stops_before_generation(setup,temporal):
    s,ws,provider,w=planned(setup,temporal);static=temporal[2];before=len(provider.requests)
    VisualStructures(s).correct(static['id'],static['revision'],static['document']['token'],uuid.uuid4().hex,
        restore_revision=1,note='改变观察版本，不能继续旧结构条件')
    with pytest.raises(ConflictError):ws.start(w.id,w.revision,w.plan_sha256)
    assert len(provider.requests)==before and ws.load(w.id).plan_sha256==w.plan_sha256


def test_correction_between_stages_cannot_submit_another_request(setup,temporal):
    s,ws,provider,w=planned(setup,temporal);static=temporal[2]
    w=ws.start(w.id,w.revision,w.plan_sha256);engine=PlanGeneration(s)
    engine.advance(w.job_id,provider,wait=True);accept(s,w,0);before=len(provider.requests)
    VisualStructures(s).correct(static['id'],static['revision'],static['document']['token'],uuid.uuid4().hex,
        restore_revision=1,note='实际观察已变，停止依赖旧结构的后段')
    with pytest.raises(ConflictError):engine.advance(w.job_id,provider,wait=True)
    assert len(provider.requests)==before


def test_frozen_structure_tampering_is_not_new_planning_authority(setup,temporal):
    s,ws,provider,w=planned(setup,temporal)
    path=ws.directory(w.id)/'work.json';saved=read_json(path)
    saved['visual_structure']['data']['parts'][0]['name']='different object'
    atomic_write_json(path,saved)
    with pytest.raises(ConflictError):ws.load(w.id)


def test_planner_cannot_invent_structure_or_use_unknown_anchors(setup,temporal):
    s,ws,provider,w=planned(setup,temporal)
    plan=w.plan.model_copy(deep=True);plan.stages[0].structure_usage.part_ids=['nonexistent']
    with pytest.raises(ValidationHarnessError):validate_structure_binding(w.spec,w.visual_structure,w.reference_sha256,plan)
    with pytest.raises(ValidationHarnessError):validate_structure_binding(spec(),None,w.reference_sha256,w.plan)
    snapshot=copy.deepcopy(w.visual_structure);snapshot['data']['anchors'][0].update(state='unknown',x=None,y=None)
    snapshot['sha256']=digest({k:v for k,v in snapshot.items() if k!='sha256'})
    with pytest.raises(ValidationHarnessError):validate_structure_binding(w.spec,snapshot,w.reference_sha256,w.plan)


def test_selected_frame_adjustment_inherits_structure_without_overriding_user(setup,temporal):
    from sprite_pipeline.collaboration.adjustments import Adjustments,AdjustmentInput,AdjustmentIntent
    s,ws,provider,w=planned(setup,temporal);w=ws.start(w.id,w.revision,w.plan_sha256)
    PlanGeneration(s).advance(w.job_id,provider,wait=True)
    manager=Adjustments(s);context=manager.context(w.id,w.revision,1,0)
    task=manager.create(w.id,AdjustmentInput(expected_revision=w.revision,candidate_index=1,stage_index=0,
        token=context['token'],start=1,end=2,user_request='只在选中帧改变头部倾斜，保留其余画面',request_key=uuid.uuid4().hex,authorized=True))
    assert task['visual_structure']==w.visual_structure and task['start']==1 and task['end']==2
    assert task['structure_context_version']==2
    s.adjustment_test_reviews=True;captured=[]
    def call(task,role,phase,content,schema,count):
        captured.append(content)
        return AdjustmentIntent(goal=task['user_request'],preserve='其余画面与两侧衔接保持',method='appearance',provider_prompt='Change only the selected head tilt; preserve other material.')
    manager.model_call=call
    manager.plan(task)
    assert 'checked_reference_structure' in captured[0][0]['text']
    assert 'not_control_evidence' in captured[0][0]['text']
    assert task['user_request'] in captured[0][0]['text'] and 'PRIMARY goal' in captured[0][0]['text']
    assert task['intent']['goal']==task['user_request']
    manager.verify(task)
    task['visual_structure']['data']['parts'][0]['name']='changed after authorization'
    with pytest.raises(ConflictError):manager.verify(task)


def test_checked_structure_and_real_end_target_reach_same_request_without_replacing_output(setup,temporal):
    import hashlib
    from sprite_pipeline.collaboration.targets import save_target
    from sprite_pipeline.collaboration.checkpoints import Checkpoints
    s,ws,provider,w=planned(setup,temporal);fixture=setup[4]
    target=fixture.write_sequence(fixture.root/'structured-target')[2].read_bytes()
    w=save_target(ws,w.id,w.revision,0,target,'核对实际目标图片，作为结构辅助段的末姿势条件')
    frozen=copy.deepcopy(w.visual_structure);w=ws.start(w.id,w.revision,w.plan_sha256)
    engine=PlanGeneration(s);engine.advance(w.job_id,provider,wait=True)
    submitted=provider.requests[-1]
    assert submitted.reference_image==ws.reference(w) and submitted.last_frame==target
    assert w.plan.stages[0].motion.generation_hint in submitted.prompt
    raw=engine.saved_frames(w.job_id,1,0);observed=Checkpoints(s).view(w.job_id,1,0)
    assert raw[-1]!=target and observed['frames'][-1]['sha256']==hashlib.sha256(raw[-1]).hexdigest()
    accept(s,w,0);engine.advance(w.job_id,provider,wait=True)
    assert provider.requests[-1].reference_image==raw[-1]
    assert ws.load(w.id).visual_structure==s.store.load(w.job_id).request.open_plan.visual_structure==frozen


def test_derived_clip_retains_structure_history_original_exports_and_scope(setup,temporal):
    from sprite_pipeline.collaboration.adjustments import Adjustments
    from test_motion_adjustments import request
    s,ws,provider,w=planned(setup,temporal);snapshot=copy.deepcopy(w.visual_structure)
    w=ws.start(w.id,w.revision,w.plan_sha256);engine=PlanGeneration(s)
    for stage in range(2):
        engine.advance(w.job_id,provider,wait=True);accept(s,w,stage)
    engine.advance(w.job_id,provider,wait=True)
    s.approve_candidate(w.job_id,1,reviewer='test',acknowledge_warnings=True,review_note='模拟完整序列采用，用于验证结构来源继承')
    s.export_candidate(w.job_id,1)
    original=(s.store.job_dir(w.job_id)/'job.json').read_bytes()
    manager=Adjustments(s);task=manager.create(w.id,request(manager,w,stage=None))
    task=manager.advance(w.id,task['id'],provider)
    assert task['state']=='ready' and task['visual_structure']==snapshot
    for i in range(len(task['source_frames'])):
        if not task['start']<=i<=task['end']:assert task['source_frames'][i]['sha256']==task['proposed_frames'][i]['sha256']
    before=len(provider.requests)
    manager.decide(w.id,task['id'],token=task['preview_token'],decision='accept',note='模拟完整对照后采用，验证原作及结构快照保留',acknowledge=True)
    derived=ws.load(w.id);historical=ws.load(w.id,1)
    assert derived.revision==2 and derived.job_id!=w.job_id
    assert derived.visual_structure==historical.visual_structure==snapshot
    assert s.store.load(derived.job_id).request.open_plan.visual_structure==snapshot
    assert (s.store.job_dir(w.job_id)/'job.json').read_bytes()==original
    s.export_candidate(derived.job_id,1)
    manager.decide(w.id,task['id'],token=task['preview_token'],decision='accept',note='重复响应只返回原结果',acknowledge=True)
    assert len(provider.requests)==before and ws.load(w.id).revision==2
    path=ws.directory(w.id)/'version-1.json';saved=read_json(path)
    saved['visual_structure']['data']['parts'][0]['name']='tampered history';atomic_write_json(path,saved)
    with pytest.raises(ConflictError):ws.load(w.id,1)


@pytest.mark.parametrize('receipt',[{'response_id':'known-invalid-response','output_sha256':'a'*64},{}])
def test_invalid_or_unknown_planning_never_resubmits_through_reads_or_recovery(setup,temporal,receipt):
    s,ws,_,provider,_=setup;static=temporal[2]
    provider_count=len(provider.requests)  # The structure fixture already produced its isolated source clip.
    class StoppedPlanner(StructurePlanner):
        def __call__(self,*args,**kwargs):
            self.calls.append('failed-attempt')
            raise ValidationHarnessError('模拟无效或未知模型返回',details={'model_receipt':receipt})
    ws.model=StoppedPlanner();value=spec(visual_structure={'analysis_id':static['id'],'token':static['document']['token']})
    w=ws.create(value,uuid.uuid4().hex,planning_authorized=True);w=ws.plan(w.id)
    assert w.status=='planning_failed' and w.job_id is None
    assert w.planning_calls[-1]['state']==('invalid_response' if receipt else 'outcome_unknown')
    for _ in range(2):
        ws.load(w.id);ws.view(w.id);ws.create(value,w.request_key,planning_authorized=True)
        ws.plan(w.id);ws.recover_planning()
    assert ws.model.calls==['failed-attempt'] and len(provider.requests)==provider_count
