import json
import pytest
from sprite_pipeline.providers.fixture import FixtureProvider
from sprite_pipeline.collaboration.experiment import ARMS, run_arm, blind_pack, retrospective
from test_interactable_state_chain import ARCHIVE, chain, decide
from sprite_pipeline.collaboration.checkpoints import review_call_count
from sprite_pipeline.collaboration.repairs import generation_calls

def test_four_offline_arms_and_anonymous_playback(tmp_path):
    src=(ARCHIVE/'lamp/A.png').read_bytes()
    stages=[{'prompt':'light begins','frames':4},{'prompt':'hold steady','frames':4}];clips=[]
    for arm in ARMS:
        verdicts=iter(['fail','pass','pass']);out=tmp_path/arm
        run=run_arm(arm,src,stages,42,FixtureProvider(),lambda *_:next(verdicts),out)
        assert len(run['frames'])==8 and run['diagnostic_only']
        assert len(run['calls'])=={'single':1,'blind':2,'keyframe_first':4,'model_only':3}[arm]
        if arm=='keyframe_first':assert all(x['last'] for x in run['calls'][2:])
        if arm=='blind':assert run['calls'][1]['first']==run['frames'][3]['sha256'] and not run['reviews']
        if arm=='model_only':assert run['calls'][1]['kind']=='repair' and len(run['reviews'])==3
        clips.append((out,run['frames'],8))
    stopped=run_arm('model_only',src,stages,42,FixtureProvider(),lambda *_:'uncertain',tmp_path/'stopped')
    assert stopped['status']=='stopped_by_review' and len(stopped['calls'])==2 and not stopped['frames']
    pack=tmp_path/'blind-public';blind_pack(clips,pack)
    assert len(list(pack.glob('*/*.png')))==32
    assert len(json.loads((tmp_path/'blind-public-private-key.json').read_bytes()))==4
    public=(pack/'clips.json').read_bytes()+(pack/'index.html').read_bytes()
    assert not any(arm.encode() in public for arm in ARMS) and str(tmp_path).encode() not in public

def test_retrospective_budget_and_human_time(chain,tmp_path):
    service,work,engine,provider,client=chain
    evidence=client.get('candidates/1/stages/0').json()
    decision={'expected_revision':1,'stage_index':0,'candidate_index':1,'token':evidence['token'],'note':'Scripted recorded review','decision':'accept','acknowledge_warnings':True,'human_seconds':12,'anchor_frame':2,'acknowledge_trim':True}
    assert client.post('review-stage',json=decision).status_code==200
    engine.advance(work.job_id,provider,wait=True);decide(client,1,'accept')
    job=engine.advance(work.job_id,provider,wait=True)
    from sprite_pipeline.collaboration.workspace import OpenMotionWorkspace
    ws=OpenMotionWorkspace(service)
    cost=retrospective(service.store.job_dir(job.job_id),ws.load(work.id).model_dump(mode='json'),ws.directory(work.id)/'adjustments',tmp_path/'export')
    assert cost['calls']=={'planning':len(ws.load(work.id).planning_calls),'generation':generation_calls(job),'review':review_call_count(job)}
    assert cost['known_human_seconds']==12 and cost['human_seconds'] is None and cost['unmeasured_decisions']==1
    result=json.loads((tmp_path/'export'/'retrospective.json').read_bytes())
    assert len(result['stages'])==2 and len(result['clips'])==1 and all(st['raw'] and st['accepted'] for st in result['stages'])
