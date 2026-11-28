"""Do not mistake a strategy's analysis for the executable drawing request."""
import copy,uuid
import pytest
from pydantic import ValidationError
from test_open_motion import setup,spec
from test_executable_brief import BRIEF,BriefPlanner
from test_temporal_structures import temporal
from test_structure_control import planned
from sprite_pipeline.collaboration.contracts import PlanProposal,CoordinatorTurn,StrategyTurn
from sprite_pipeline.collaboration.planning_draft import DraftStrategyTurn,DraftInternalTurn,instructions,draft_budget
from sprite_pipeline.collaboration.planning import PlanningModel
from sprite_pipeline.collaboration.structure_control import bind_planning_schema


class DraftPlanner(BriefPlanner):
    def __call__(self,role,work,reference,**kw):
        if role=='strategy':
            final,receipt=super().__call__('coordinator',work,reference,**kw)
            draft=final['plan']
            for stage in draft['stages']:stage['prompt']=BRIEF+'\nDetailed nonexecutable analysis. '*35
            return {'action':'propose','summary':'完整分析草案，由协调专家编写最终指令','proposal':draft},receipt
        return super().__call__(role,work,reference,**kw)


def test_full_four_turn_plan_retains_rich_draft_but_only_binds_bounded_final(setup):
    s,ws,_,provider,_=setup;ws.model=DraftPlanner()
    w=ws.create(spec(),uuid.uuid4().hex,planning_authorized=True)
    w.generation_policy_version=4;ws.save(w);w=ws.plan(w.id)
    assert w.status=='ready',w.message
    assert len(w.planning_calls)==4
    draft=next(m['response']['proposal'] for m in w.messages if m['role']=='strategy')
    assert all(len(s['prompt'])>1000 for s in draft['stages'])
    assert all(s.prompt==BRIEF for s in w.plan.stages)
    assert draft_budget(w.messages)[0]['draft_is_executable'] is False
    assert not w.job_id and not provider.requests
    w=ws.start(w.id,1,w.plan_sha256)
    binding=s.store.load(w.job_id).request.open_plan
    assert binding.compiled_prompts==[BRIEF,BRIEF] and binding.generation_policy_version==4
    assert all(len(s.prompt)<1000 for s in binding.plan.stages)


def test_old_strategy_and_final_coordinator_still_reject_overlong_executable_text(setup):
    _,ws,_,_,_=setup;w=ws.create(spec(),uuid.uuid4().hex,planning_authorized=True)
    response,_=DraftPlanner()('strategy',w,ws.reference(w))
    raw=copy.deepcopy(response)
    assert DraftStrategyTurn.model_validate(raw).proposal
    assert DraftInternalTurn.model_validate(raw).proposal
    with pytest.raises(ValidationError):StrategyTurn.model_validate(raw)
    with pytest.raises(ValidationError):CoordinatorTurn.model_validate({'action':'finalize','summary':'未完成压缩的方案不能执行','plan':raw['proposal']})
    assert raw==response


def test_structure_enums_and_local_validation_also_bind_the_draft(setup,temporal):
    _,_,_,w=planned(setup,temporal)
    schema=bind_planning_schema(DraftStrategyTurn,w.visual_structure,stage_type='StrategyDraftStage')
    wire=schema.model_json_schema()
    assert wire['$defs']['StrategyDraftStage']['properties']['prompt']['maxLength']==4000
    assert wire['$defs']['StrategyDraftStage']['properties']['structure_usage']=={'$ref':'#/$defs/StructureUsage'}
    assert wire['$defs']['StructureUsage']['properties']['part_ids']['items']['enum']==['head']
    raw={'action':'propose','summary':'核对可见结构的策略草案','proposal':w.plan.model_dump(mode='json')}
    raw['proposal']['stages'][0]['prompt']='detailed analysis '*80
    assert schema.model_validate(raw).proposal
    raw['proposal']['stages'][0]['structure_usage']['part_ids']=['unseen']
    with pytest.raises(ValidationError,match='unavailable'):schema.model_validate(raw)


def test_real_planner_uses_draft_schema_only_for_new_strategy_role(setup):
    s,ws,_,_,_=setup;w=ws.create(spec(),uuid.uuid4().hex,planning_authorized=True)
    w.generation_policy_version=4;model=PlanningModel(s.settings);captured=[]
    class Registry:
        def send(self,role,content,schema,*args,**kw):
            captured.append((role,content,schema))
            raw,_=DraftPlanner()(role,w,ws.reference(w))
            return schema.model_validate(raw),{}
    model.registry=Registry();model('strategy',w,ws.reference(w))
    assert captured[-1][2] is DraftStrategyTurn
    assert 'NONEXECUTABLE analysis draft' in captured[-1][1][0]['text']
    model('coordinator',w,ws.reference(w));assert captured[-1][2] is CoordinatorTurn
    assert '60-80 English words' in captured[-1][1][0]['text']


@pytest.mark.parametrize('budget,expected',[ (4,['appearance','motion','strategy','coordinator']),
                                           (6,['appearance','motion','appearance','motion','strategy','coordinator']) ])
def test_optional_consultation_cannot_starve_strategy_and_coordinator(setup,budget,expected):
    _,ws,_,provider,_=setup
    class Consulting(DraftPlanner):
        def __call__(self,role,work,reference,**kw):
            if role=='motion' and not any(m['role']=='motion' for m in work.messages):
                return {'action':'consult','summary':'已提出动作建议，握持归属尚有疑问','target':'appearance',
                    'question':'不要猜测不可见的手部，请确认可观察的归属关系',
                    'findings':[{'text':'保持物品与原有手臂的邻近归属，不指定解剖左右手','source':'reference','evidence':'原图可见部分与未知部分分开'}]},{}
            return super().__call__(role,work,reference,**kw)
    ws.model=Consulting();w=ws.create(spec(budget={'max_planning_calls':budget}),uuid.uuid4().hex,planning_authorized=True)
    w.generation_policy_version=5;ws.save(w);w=ws.plan(w.id)
    assert w.status=='ready',w.message
    assert [c['role'] for c in w.planning_calls]==expected
    first=next(m for m in w.messages if m['role']=='motion')
    assert first['response']['action']=='consult'  # Raw expert request is never rewritten.
    assert ('deferred_request' in first)==(budget==4)
    if budget==4:
        assert first['deferred_request']['resolved'] is False
        assert 'deferred' in w.messages[-1]['question']
    assert not provider.requests and not w.job_id
