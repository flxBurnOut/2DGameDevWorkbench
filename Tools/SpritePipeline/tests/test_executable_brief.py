"""Complete planning, exact provider payload and frozen legacy behavior."""
import copy
import json
import uuid
from unittest.mock import patch

import pytest
from pydantic import ValidationError
from test_open_motion import setup, spec
from test_generation_conditions import ConditionPlanner
from test_open_motion_checkpoints import accept
from sprite_pipeline.collaboration.planning import PlanningModel
from sprite_pipeline.collaboration.contracts import CoordinatorTurn, PlanProposal, PlanBinding
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.executable_brief import compile_brief
from sprite_pipeline.collaboration.quality import compiled_prompt
from sprite_pipeline.collaboration.targets import save_target
from sprite_pipeline.errors import ValidationHarnessError
from sprite_pipeline.jsonio import read_json


BRIEF='''Appearance: Same outfit, one soft hat in its original hand; transparent.
Action: Raise the hat from the actual input, without bowing yet.
Camera: Fixed side view.
Facing: Body stays side-on; hat tilts with the wrist.
Drive: Shoulder leads; forearm, wrist and hat follow smoothly.
Support: Feet support the body, knees soften naturally.
Path: Hand and hat arc upward.
Timing: Frames 1-3 rise; 4 carries motion through the join.
Poses: 1 hat near head; 3 hand rising; 4 hat above forehead.
Relations: Hand remains in contact with hat; flexible brim may bend.
End: Torso upright with hat raised.
Boundary: Continue through this pose, without an extra pause.'''


class BriefPlanner(ConditionPlanner):
    def __call__(self,*args,**kwargs):
        value,receipt=super().__call__(*args,**kwargs)
        if value['action']=='finalize':
            for stage in value['plan']['stages']:stage['prompt']=BRIEF
            value['plan']['quality']['key_poses'][0]['description']='Actual hat remains near the head while the shoulder initiates the lift.'
        return value,receipt


def prepared(setup):
    s,ws,_,provider,fixture=setup
    ws.model=BriefPlanner()
    w=ws.create(spec(),uuid.uuid4().hex,planning_authorized=True)
    w.generation_policy_version=3;ws.save(w)
    w=ws.plan(w.id)
    assert w.status=='ready',w.message
    return s,ws,provider,fixture,w


def test_complete_plan_executes_exact_brief_with_targets_and_checkpoint_gates(setup):
    s,ws,provider,fixture,w=prepared(setup)
    targets=[p.read_bytes() for p in fixture.write_sequence(fixture.root/'targets')][1:3]
    original=copy.deepcopy(w.plan.model_dump(mode='json'))
    for i,data in enumerate(targets):w=save_target(ws,w.id,1,i,data,'已逐张检查实际目标图片')
    w=ws.start(w.id,1,w.plan_sha256);engine=PlanGeneration(s)
    for i in range(2):
        engine.advance(w.job_id,provider,wait=True)
        assert provider.requests[i].prompt==BRIEF
        assert provider.requests[i].last_frame==targets[i]
        trace=read_json(engine.directory(w.job_id,1,i)/'submit.intent.json')['drawing_conditions']
        assert trace['version']==3 and trace['target_mode']=='image'
        assert len(trace['rows'])==12 and 'not verbatim' in trace['coverage_kind']
        engine.advance(w.job_id,provider,wait=True)
        assert len(provider.requests)==i+1
        accept(s,w,i)
    engine.advance(w.job_id,provider,wait=True)
    assert w.plan.model_dump(mode='json')==original
    assert len(s.store.load(w.job_id).candidates[0].frames)==8
    assert provider.requests[1].reference_image==engine.saved_frames(w.job_id,1,0)[-1]


@pytest.mark.parametrize('bad',[BRIEF.replace('Drive:','Reason:'),BRIEF+'\nDrive: duplicate',BRIEF.replace('Path: Hand and hat arc upward.','Path: '),BRIEF+'x'*1000])
def test_invalid_brief_is_not_shortened_or_retried(setup,bad):
    _,_,provider,_,w=prepared(setup)
    p=w.plan.model_copy(deep=True)
    with pytest.raises((ValidationHarnessError,ValidationError)):
        p.stages[0].prompt=bad
        compile_brief(p,0)
    assert not provider.requests


def test_rich_analysis_does_not_overflow_the_drawing_text(setup):
    _,_,_,_,w=prepared(setup)
    p=w.plan.model_dump(mode='json')
    p['stages'][0]['motion']['drive']='Leading shoulder initiates; wrist and attached material follow. '*2
    p=PlanProposal.model_validate(p)
    assert compiled_prompt(p,None,0,policy_version=3)==BRIEF
    assert len(p.quality.key_poses[0].description)>26
    assert len(p.stages[0].motion.drive)>60


def test_all_roles_get_new_budget_and_original_schema_limits(setup):
    s,ws,_,_,w=prepared(setup);model=PlanningModel(s.settings);captured=[]
    class Registry:
        def send(self,role,content,schema,*args,**kwargs):
            captured.append((content,schema))
            v={'action':'propose','summary':'保留完整分析与阶段约束',
               'findings':[{'text':'帽子与手保持接触','source':'reference','evidence':'参考图可见握持位置'}]}
            if role=='strategy':v['proposal']=w.plan.model_dump(mode='json')
            if role=='coordinator':v={'action':'finalize','summary':'完整方案可以执行','plan':w.plan.model_dump(mode='json')}
            return schema.model_validate(v),{}
    model.registry=Registry()
    for role in ('appearance','motion','strategy','coordinator'):
        model(role,w,ws.reference(w))
        content,schema=captured[-1];text=content[0]['text']
        assert 'EXECUTABLE DRAWING BRIEF policy 3' in text
        assert 'They will ALL be compiled' not in text
        data=json.loads(text.split('TASK DATA:\n',1)[1])
        assert data['drawing_condition_policy']['provider_text']=='stage.prompt unchanged'
        if role=='coordinator':
            wire=schema.model_json_schema()
            assert wire['$defs']['MotionConstraints']['properties']['drive']['maxLength']==140
            assert wire['$defs']['KeyPose']['properties']['description']['maxLength']>26
    model('coordinator',w.model_copy(update={'generation_policy_version':None}),ws.reference(w))
    content,schema=captured[-1]
    assert 'EXECUTABLE DRAWING BRIEF policy 3' not in content[0]['text']
    assert schema.model_json_schema()==CoordinatorTurn.model_json_schema()


def test_new_policy_default_does_not_upgrade_receipts_or_old_bindings(setup):
    _,ws,_,_,_=setup
    old=ws.create(spec(),uuid.uuid4().hex,planning_authorized=True)
    before=(ws.directory(old.id)/'work.json').read_bytes()
    with patch('sprite_pipeline.collaboration.workspace.DEFAULT_GENERATION_POLICY',3),patch('sprite_pipeline.collaboration.workspace.DEFAULT_VISIBILITY_REVIEW',1):
        assert ws.create(old.spec,old.request_key,planning_authorized=True).generation_policy_version is None
        assert ws.load(old.id).visibility_review_version is None
    assert (ws.directory(old.id)/'work.json').read_bytes()==before
