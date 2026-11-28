"""Joint preview never mutates native images, gates, budgets or request identity."""
import base64
import copy
import hashlib
import uuid

import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient

from test_open_motion import setup, ready  # noqa: F401
from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.interactions import InteractionPreviews
from sprite_pipeline.collaboration.interaction_contracts import InteractionContext, SaveInteraction
from sprite_pipeline.errors import ConflictError, ValidationHarnessError
from sprite_pipeline.collaboration.contracts import digest
from sprite_pipeline.jsonio import read_json, atomic_write_json
from sprite_pipeline.collaboration.interaction_structure import exchange_structure


@pytest.fixture
def joint(setup):
    s,ws,planner,provider,fixture=setup
    w=ready(ws);w=ws.start(w.id,w.revision,w.plan_sha256)
    PlanGeneration(s).advance(w.job_id,provider,wait=True)
    preview=InteractionPreviews(s)
    return s,ws,w,preview,provider,planner


def context(s,w):
    png=(s.store.job_dir(w.job_id)/'input/reference.png').read_bytes()
    frame={'raw_index':0,'sha256':hashlib.sha256(png).hexdigest(),'png_base64':base64.b64encode(png).decode(),
           'duration':1,'width':64,'height':64,'region':None}
    point={'id':'contact','name':'明确可见的部位','part':'部位','provenance':'manual','evidence':'诊断标记，不是自动识别',
           'samples':[{'frame':0,'state':'visible','point':{'x':32,'y':32}}]}
    placement={'position':{'x':0,'y':0},'origin':{'x':32,'y':64},'scale':1,'flip_x':False,'facing':'unknown','depth':0}
    return {'version':1,'title':'隔离联合预览','actor':placement,'actor_anchors':[point],'object':copy.deepcopy(placement),
            'object_source':{'asset_id':'fixture:object','revision':'test1','sha256':'a'*64,'label':'诊断素材','scope':'frozen_import'},
            'object_states':[{'id':'closed','name':'初始','fps':6,'loop':True,'width':64,'height':64,'frames':[frame],'anchors':[point]}],
            'initial_state':'closed','events':[],'relations':[{'id':'contact','name':'触碰','kind':'contact','actor_anchor':'contact','object_anchor':'contact',
                'window':{'start':0,'end':0},'tolerance_px':2,'tolerance_reason':'依据诊断素材尺寸选择偏差范围','response_state':None,'response_window':None}],
            'permissions':'preview_only','interruption':'reset_on_restart'}


def request(joint, **changes):
    s,ws,w,preview,*_=joint
    return SaveInteraction.model_validate({'expected_revision':w.revision,'candidate_index':1,'stage_index':None,
        'source_token':preview.read(w.id)['source']['token'],'expected_context_version':0,'request_key':uuid.uuid4().hex,
        'context':context(s,w),**changes})


def test_save_read_replay_leave_all_production_state_unchanged(joint):
    s,ws,w,preview,provider,planner=joint
    original=(s.store.job_dir(w.job_id)/'job.json').read_bytes()
    work=(ws.directory(w.id)/'work.json').read_bytes()
    assert preview.read(w.id)['document'] is None and not preview.root.exists()
    counts=(len(provider.requests),len(planner.calls))
    req=request(joint);first=preview.save(w.id,req)
    assert first['context_version']==1 and first['source_current'] and first['model_calls']==0
    assert preview.save(w.id,req)['document']==first['document']
    assert InteractionPreviews(s).read(w.id)['document']==first['document']
    assert (s.store.job_dir(w.job_id)/'job.json').read_bytes()==original
    assert (ws.directory(w.id)/'work.json').read_bytes()==work
    assert counts==(len(provider.requests),len(planner.calls))
    with pytest.raises(ConflictError):preview.save(w.id,request(joint))
    altered=req.model_copy(deep=True);altered.context.title='同一个请求不能变成新的操作'
    with pytest.raises(ConflictError):preview.save(w.id,altered)
    next_req=request(joint,expected_context_version=1)
    assert preview.save(w.id,next_req)['context_version']==2
    assert (preview.folder(w,1,None)/'revision-1.json').is_file()


def test_frame_changes_invalidate_preview_instead_of_reusing_coordinates(joint):
    s,ws,w,preview,*_=joint
    req=request(joint);preview.save(w.id,req)
    job=s.store.load(w.job_id)
    frame=s.store.resolve_job_path(w.job_id,job.candidates[0].frames[0].active_path)
    frame.write_bytes(frame.read_bytes()+b'changed')
    result=preview.read(w.id)
    assert not result['source_current'] and result['document'] and result['error']
    with pytest.raises(ConflictError):preview.save(w.id,req.model_copy(update={'request_key':uuid.uuid4().hex,'expected_context_version':1}))


def test_native_fps_and_revision_change_are_not_silent_retiming(joint):
    s,ws,w,preview,*_=joint
    req=request(joint);preview.save(w.id,req)
    with s.store.locked_job(w.job_id) as job:job.action.fps+=1
    assert not preview.read(w.id)['source_current']
    with pytest.raises(ConflictError):preview.save(w.id,req.model_copy(update={'request_key':uuid.uuid4().hex,'expected_context_version':1}))


def test_legacy_saved_request_replay_survives_optional_display_fields(joint):
    _,_,w,preview,*_=joint
    req=request(joint);preview.save(w.id,req)
    folder=preview.folder(w,1,None)
    legacy_request=req.model_dump(mode='json');legacy_request['context'].pop('object_rendering')
    for state in legacy_request['context']['object_states']:
        state.pop('visible');state.pop('tint')
    prior=read_json(folder/'revision-1.json');prior['context']=legacy_request['context']
    prior['token']=digest({k:v for k,v in prior.items() if k!='token'})
    atomic_write_json(folder/'revision-1.json',prior)
    head=read_json(folder/'head.json');head['requests'][req.request_key]['fingerprint']=digest(legacy_request)
    atomic_write_json(folder/'head.json',head)
    assert preview.save(w.id,req)['context_version']==1
    assert not (folder/'revision-2.json').exists()
    changed=req.model_copy(deep=True);changed.context.object_states[0].visible=False
    with pytest.raises(ConflictError):preview.save(w.id,changed)
    changed=req.model_copy(deep=True);changed.source_token='c'*64
    with pytest.raises(ConflictError):preview.save(w.id,changed)


def test_imported_visual_fields_are_preserved_and_bounded(joint):
    _,_,w,preview,*_=joint;req=request(joint)
    payload=req.model_dump(mode='json')
    payload['context']['object_rendering']={'width':24,'height':32,'offset':{'x':3,'y':-4},'scale':1.5,'flip_x':True,'flip_y':True}
    payload['context']['object_states'][0].update(visible=False,tint='#ffe9a8')
    saved=preview.save(w.id,SaveInteraction.model_validate(payload))
    assert saved['document']['context']['object_states'][0]['visible'] is False
    assert saved['document']['context']['object_states'][0]['tint']=='#ffe9a8'
    assert saved['document']['context']['object_rendering']==payload['context']['object_rendering']
    broken=copy.deepcopy(payload);broken['context']['object_rendering']['width']=0
    with pytest.raises(ValidationError):SaveInteraction.model_validate(broken)
    broken=copy.deepcopy(payload);broken['context']['object_states'][0]['tint']='url(https://invalid)'
    with pytest.raises(ValidationError):SaveInteraction.model_validate(broken)


@pytest.mark.parametrize('mutation', ['bad_hash','bad_dimension','unknown_point','bad_state','bad_order','bad_relation','bad_region'])
def test_invalid_object_evidence_and_relations_rejected(joint,mutation):
    s,ws,w,*_=joint;c=context(s,w)
    if mutation=='bad_hash':c['object_states'][0]['frames'][0]['sha256']='b'*64
    if mutation=='bad_dimension':c['object_states'][0]['width']=65
    if mutation=='unknown_point':c['actor_anchors'][0]['samples'][0]['state']='occluded'
    if mutation=='bad_state':c['events']=[{'time':0,'from_state':'unknown','to_state':'closed'}]
    if mutation=='bad_order':c['events']=[{'time':1,'from_state':'closed','to_state':'closed'},{'time':.5,'from_state':'closed','to_state':'closed'}]
    if mutation=='bad_relation':c['relations'][0]['actor_anchor']='missing'
    if mutation=='bad_region':c['object_states'][0]['frames'][0]['region']={'x':60,'y':0,'width':10,'height':64}
    with pytest.raises(ValidationError):InteractionContext.model_validate(c)


def test_actor_bounds_and_timing_guard(joint):
    s,ws,w,preview,*_=joint
    req=request(joint);req.context.actor_anchors[0].samples[0].point.x=999
    with pytest.raises(ValidationHarnessError):preview.save(w.id,req)
    req=request(joint);req.context.relations[0].window.end=100
    with pytest.raises(ValidationHarnessError):preview.save(w.id,req)
    source=preview.read(w.id)['source'];duration=len(source['frames'])/source['fps']
    from sprite_pipeline.collaboration.interaction_contracts import Window
    req=request(joint);req.context.relations[0].window=Window(start=duration,end=duration)
    with pytest.raises(ValidationHarnessError):preview.save(w.id,req)
    from sprite_pipeline.collaboration.interaction_contracts import Relation
    req=request(joint);req.context.relations[0]=Relation.model_validate({**req.context.relations[0].model_dump(),
        'response_state':'closed','response_window':{'start':duration,'end':duration}})
    with pytest.raises(ValidationHarnessError):preview.save(w.id,req)
    assert preview.read(w.id)['document'] is None


def test_contact_surface_requires_bounded_geometry_and_explicit_surface_identity(joint):
    s,_,w,*_=joint
    payload=context(s,w)
    payload['object_states'][0]['surfaces']=[{'id':'platform','name':'原场景边缘',
        'start':{'x':0,'y':60},'end':{'x':64,'y':60},'provenance':'scene_geometry','evidence':'场景版本内已保存的有限边缘'}]
    payload['relations'][0].update(kind='surface_contact',object_anchor='platform')
    assert InteractionContext.model_validate(payload).object_states[0].surfaces[0].end.x==64
    invalid=copy.deepcopy(payload);invalid['object_states'][0]['surfaces'][0]['end']['x']=65
    with pytest.raises(ValidationError):InteractionContext.model_validate(invalid)
    invalid=copy.deepcopy(payload);invalid['object_states'][0]['surfaces'][0]['end']={'x':0,'y':60}
    with pytest.raises(ValidationError):InteractionContext.model_validate(invalid)
    invalid=copy.deepcopy(payload);invalid['relations'][0]['kind']='contact'
    with pytest.raises(ValidationError):InteractionContext.model_validate(invalid)
    invalid=copy.deepcopy(payload);invalid['object_states'][0]['surfaces']*=2
    with pytest.raises(ValidationError):InteractionContext.model_validate(invalid)


def test_api_current_context_and_frozen_identity(joint):
    s,ws,w,preview,*_=joint
    client=TestClient(create_api(service=s));path=f'/v1/open-motion/{w.id}/interaction'
    assert client.get(path).json()['context_version']==0
    assert client.get(path+'?candidate=99').status_code==422
    r=client.post(path,json=request(joint).model_dump(mode='json'))
    assert r.status_code==200,r.text
    token=r.json()['source']['token']
    assert client.get(path+'/frames/0',params={'token':token}).status_code==200
    assert client.get(path+'/frames/0',params={'token':'a'*64}).status_code==409
    invalid=request(joint,expected_context_version=1).model_dump(mode='json')
    invalid['context']['actor']['position']['x']=float('inf')
    # JSON clients cannot submit non-finite values; direct schema rejects them too.
    with pytest.raises(ValidationError):SaveInteraction.model_validate(invalid)


def observed(source):
    return {'id':'a'*32,'state':'ready','source_current':True,'source':{k:source[k] for k in ('job_id','candidate','stage','fps')},'document':{
        'revision':2,'token':'b'*64,'confirmation':{'note':'核对实际语义点'},
        'frames':[{'source_sha256':f['sha256'],'parts':[{'id':'hand','state':'estimated','centroid':[2,3]}]} for f in source['frames']],
        'observations':{'frames':[{'frame_index':0,'structure':{'anchors':[{'id':'grip','name':'握持点','part_id':'hand','state':'visible','x':30,'y':32}],
            'relations':[{'id':'holds','state':'visible','source':'hand','target':'equipment','evidence':'可见持握'}]}}]}}}


def test_reuses_actual_v2_points_without_interpolating_or_replacing_with_masks(joint,monkeypatch):
    s,ws,w,preview,*_=joint
    source=preview.read(w.id)['source'];analysis=observed(source)
    exchange=exchange_structure(analysis,source)
    assert exchange['state']=='available'
    assert exchange['anchors'][0]['samples']==[{'frame':0,'state':'visible','point':{'x':30,'y':32}}]
    assert len(exchange['anchors'][0]['samples'])==1 # no invented positions for the other seven frames
    assert exchange['relations'][0]['id']=='holds'
    monkeypatch.setattr(preview,'structure',lambda _:exchange)
    req=request(joint);req.context.structure_binding=exchange['binding']
    from sprite_pipeline.collaboration.interaction_contracts import Anchor
    req.context.actor_anchors.append(Anchor.model_validate(exchange['anchors'][0]))
    assert preview.save(w.id,req)['source_current']
    changed=copy.deepcopy(exchange);changed['binding']['token']='c'*64
    monkeypatch.setattr(preview,'structure',lambda _:changed)
    assert not preview.read(w.id)['source_current']
    with pytest.raises(ConflictError):preview.save(w.id,req.model_copy(update={'request_key':uuid.uuid4().hex,'expected_context_version':1}))


def test_unconfirmed_unknown_and_stale_v2_do_not_become_contact_facts(joint):
    s,ws,w,preview,*_=joint;source=preview.read(w.id)['source'];analysis=observed(source)
    analysis['document']['confirmation']=None
    assert exchange_structure(analysis,source)['anchors']==[]
    analysis=observed(source);analysis['document']['frames'][0]['parts'][0]['state']='occluded'
    assert exchange_structure(analysis,source)['anchors'][0]['samples'][0]=={'frame':0,'state':'unknown','point':None}
    analysis=observed(source);analysis['document']['frames'][0]['source_sha256']='changed'
    assert exchange_structure(analysis,source)['state']=='stale'
    c=context(s,w);c['actor_anchors'][0]['provenance']='confirmed_structure'
    with pytest.raises(ValidationError):InteractionContext.model_validate(c)


@pytest.mark.parametrize('key,value',[('job_id','different_job'),('candidate',2),('stage',0),('fps',24)])
def test_identical_pixels_do_not_authorize_cross_source_structure(joint,key,value):
    _,_,w,preview,*_=joint;source=preview.read(w.id)['source'];analysis=observed(source)
    analysis['source'][key]=value
    result=exchange_structure(analysis,source)
    assert result['state']=='stale' and not result['anchors'] and not result['binding']


def test_exchange_keeps_per_frame_manual_model_and_unknown_provenance(joint):
    _,_,w,preview,*_=joint;source=preview.read(w.id)['source'];analysis=observed(source)
    raw=copy.deepcopy(analysis['document']['observations'])
    effective=copy.deepcopy(raw);manual=copy.deepcopy(effective['frames'][0]);manual['frame_index']=1
    manual['structure']['anchors'][0].update(origin='manual_anchor_correction',evidence='在此帧的真实像素上纠正')
    unknown=copy.deepcopy(manual);unknown['frame_index']=2
    unknown['structure']['anchors'][0].update(origin='stale_manual_anchor',state='unknown',x=None,y=None)
    effective['frames'].extend([manual,unknown]);analysis['document']['effective_observations']=effective
    result=exchange_structure(analysis,source)
    assert analysis['document']['observations']==raw
    assert [p['origin'] for p in result['point_evidence']]==['model_observation','manual_anchor_correction','stale_manual_anchor']
    for i,row in enumerate(result['point_evidence']):
        assert row['sha256']==source['frames'][i]['sha256']
        assert row['raw_index']==source['frames'][i]['raw_index']
        assert row['seconds']==i/source['fps']
    assert result['anchors'][0]['samples'][2]['point'] is None
    assert len(result['anchors'][0]['samples'])==3
    # The unknown placeholders created for a manually added frame were never
    # model observations. Keep this fourth provenance distinct in the exchange.
    untouched=copy.deepcopy(unknown);untouched['frame_index']=3
    untouched['structure']['anchors'][0].pop('origin')
    effective['frames'].append(untouched)
    result=exchange_structure(analysis,source)
    assert result['point_evidence'][-1]['origin']=='unobserved'
    assert result['point_evidence'][-1]['state']=='unknown'
