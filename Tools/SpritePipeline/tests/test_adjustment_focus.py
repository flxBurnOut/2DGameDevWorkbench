"""Default source-image editing and exact saved-alternative registration."""
import copy
import json
import pytest
from test_open_motion import setup
from test_motion_adjustments import stage_work, request, IntentRegistry
from sprite_pipeline.collaboration.adjustments import Adjustments, drawing_prompt, frozen_inputs
from sprite_pipeline.collaboration.adjustment_import import register_saved_alternative
from sprite_pipeline.collaboration.contracts import digest
from sprite_pipeline.errors import ConflictError


def test_explicit_request_uses_originals_without_masks_or_old_advice(setup):
    s,ws,p,w=stage_work(setup);s.adjustment_test_reviews=True
    registry=IntentRegistry();s.open_motion_review_registry=registry;m=Adjustments(s)
    original_context=m.context
    def context(*args,**kwargs):
        value=original_context(*args,**kwargs)
        value['suggestions']=[{'text':'无关建议：重做整个收势','frames':[2,3]}]
        return value
    m.context=context
    goal='只把大片白色拖尾减弱为贴近原物品的一条细青色弧光，保持原姿势、朝向、单件物品和时机。'
    t=m.create(w.id,request(m,w,user=goal));t=m.advance(w.id,t['id'],p)
    assert t['state']=='ready' and not t.get('edit_regions')
    assert t['expert_suggestions'][0]['text']=='无关建议：重做整个收势'
    data=json.loads(registry.inputs[0][1][0]['text'].split('boundary:\n',1)[1])
    assert 'expert_suggestions' not in data and 'source_goal' not in data
    assert data['user_request']==goal
    req=p.requests[-1]
    assert req.edit_frames[1:3]==tuple((m.folder(t)/'source'/f'{i:03d}.png').read_bytes() for i in (1,2))
    assert req.prompt.count(goal)==1 and '无关建议' not in req.prompt
    assert len(req.prompt)<=1000 and 'unless the requested edit explicitly changes them' in req.prompt
    assert len(t['planning_calls'])==1 and len(t['generation_calls'])==1
    # Full alternative retains the selected source window mapping, not an animation restart.
    assert t['proposed_frames'][0]['sha256']==t['source_frames'][0]['sha256']
    assert t['proposed_frames'][3]['sha256']==t['source_frames'][3]['sha256']


def test_v3_frozen_prompt_is_not_upgraded(setup):
    s,ws,p,w=stage_work(setup);m=Adjustments(s)
    t=m.create(w.id,request(m,w,preserve_motion=True));t['intent_format_version']=3
    t['frozen_digest']=digest(frozen_inputs(t));m.save(t)
    before=copy.deepcopy(t)
    prompt=drawing_prompt(t,'appearance','Specific local edit.',[])
    assert 'PRIMARY requested change' in prompt and 'Supporting instructions:' in prompt
    assert digest(frozen_inputs(t))==before['frozen_digest']


@pytest.mark.parametrize('mode',['valid','wrong_scope','tampered','unknown'])
def test_register_only_exact_complete_saved_candidate(setup,tmp_path,mode):
    s,ws,p,w=stage_work(setup);m=Adjustments(s)
    t=m.create(w.id,request(m,w));t=m.advance(w.id,t['id'],p)
    assert t['state']=='ready'
    source=m.folder(t);target=tmp_path/'saved-alternative'
    assert source.resolve().is_relative_to(tmp_path.resolve())
    source.rename(target)
    kwargs=dict(work_id=w.id,revision=1,candidate=1,stage=0,source_token=t['source_token'])
    original_job=(s.store.job_dir(w.job_id)/'job.json').read_bytes()
    original_work=(ws.directory(w.id)/'work.json').read_bytes()
    calls=len(p.requests)
    if mode=='wrong_scope':kwargs['stage']=1
    if mode=='tampered':(target/'proposed/001.png').write_bytes(b'tampered')
    if mode=='unknown':
        t['state']='unknown';(target/'task.json').write_text(json.dumps(t),encoding='utf-8')
    if mode!='valid':
        with pytest.raises(ConflictError):register_saved_alternative(m,target,**kwargs)
        assert not source.exists()
    else:
        saved=register_saved_alternative(m,target,**kwargs)
        assert saved['state']=='ready' and saved['linked_source']['new_provider_calls']==0
        assert register_saved_alternative(m,target,**kwargs)['id']==t['id']
        assert len(m.context(w.id,1,1,0)['tasks'])==1
        assert saved['generation_calls']==t['generation_calls']
    assert len(p.requests)==calls
    assert (s.store.job_dir(w.job_id)/'job.json').read_bytes()==original_job
    assert (ws.directory(w.id)/'work.json').read_bytes()==original_work
