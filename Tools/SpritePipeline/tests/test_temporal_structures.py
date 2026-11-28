"""Durable temporal observation lifecycle; all model/mask providers are fixtures."""
import copy
import hashlib
import uuid
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from fastapi.testclient import TestClient

from test_open_motion import setup
from test_open_motion_checkpoints import prepared, accept
from test_visual_structures import proposal
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.structures import VisualStructures
from sprite_pipeline.collaboration.tracking import TemporalStructures
from sprite_pipeline.collaboration.structure_contracts import StructureProposal
from sprite_pipeline.collaboration.tracking_observation import StructureObservations
from sprite_pipeline.errors import ConflictError,ValidationHarnessError
from sprite_pipeline.jsonio import atomic_write_json
from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.temporal_review_service import start_review,run_review
from sprite_pipeline.collaboration.contracts import digest
from test_production_review import ExpertRegistry


def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()


@pytest.fixture
def temporal(setup):
    service,ws,provider,work=prepared(setup)
    engine=PlanGeneration(service)
    for stage in range(2):
        engine.advance(work.job_id,provider,wait=True);accept(service,work,stage)
    engine.advance(work.job_id,provider,wait=True)
    counts={'semantic':0,'tracking':0}
    def parser(registry,data,models,*,on_request,on_response):
        on_request();return StructureProposal.model_validate(proposal()),{'fixture':True}
    def segmenter(source,parts,output):
        output.mkdir();masks=[]
        for part in parts:
            image=Image.new('L',(64,64));ImageDraw.Draw(image).rectangle((27,18,36,27),fill=255)
            path=output/(part['id']+'.png');image.save(path)
            masks.append({'id':part['id'],'file':path.name,'sha256':sha(path),'area':100})
        return {'source_sha256':sha(source),'parts':masks}
    def observer(registry,reference,reference_data,paths,selected,models,*,on_request,on_response):
        counts['semantic']+=1;on_request()
        return StructureObservations.model_validate({'summary':'模拟关键帧，不能证明准确率',
            'frames':[{'frame_index':i,'structure':reference_data} for i in selected]}),{'fixture':True}
    def tracker(job):
        counts['tracking']+=1;output=Path(job['output']);output.mkdir();frames=[]
        for frame in job['frames']:
            parts=[]
            for part in job['parts']:
                path=output/f'{frame["frame_index"]}-{part["id"]}.png'
                path.write_bytes(Path(part['mask_path']).read_bytes())
                parts.append({'id':part['id'],'file':path.name,'sha256':sha(path),'state':'estimated',
                    'area':100,'box':[27,18,37,28],'centroid':[31.5,22.5],'axis_degrees_mod_180':None})
            frames.append({'frame_index':frame['frame_index'],'source_sha256':frame['sha256'],
                           'time_seconds':frame['frame_index']/job['fps'],'parts':parts})
        result={'operation':'track','fps':job['fps'],'reference':job['reference'],'source_frames':job['frames'],
            'reference_parts':job['parts'],'corrections':job['corrections'],'frames':frames,
            'context_frame_count':1,'context_excluded_from_playback':True,'width':64,'height':64}
        if 'tracking_policy' in job:result['tracking_policy']=job['tracking_policy']
        atomic_write_json(output/'receipt.json',result);return result
    service.structure_parser=parser;service.structure_segmenter=segmenter
    service.structure_observer=observer;service.structure_tracker=tracker
    structures=VisualStructures(service)
    static=structures.create('test_hero','static-'+uuid.uuid4().hex,authorized=True)
    structures.run(static['id']);static=structures.view(static['id'])
    static=structures.correct(static['id'],static['revision'],static['document']['token'],'confirm-'+uuid.uuid4().hex,
                              confirm=True,note='核对实际诊断素材中的位置')
    return service,work,static,TemporalStructures(service),counts


def create(context):
    service,work,static,tracks,counts=context
    return tracks.create(work.job_id,1,static['id'],static['document']['token'],'track-'+uuid.uuid4().hex,authorized=True)


def ready(context):
    view=create(context);tracks=context[3];tracks.run(view['id']);return tracks.view(view['id'])


def test_read_create_cached_and_sources_stay_unchanged(temporal):
    s,w,static,tracks,counts=temporal
    before=(s.store.job_dir(w.job_id)/'job.json').read_bytes()
    assert tracks.latest(w.job_id,1)=={'analysis':None} and not tracks.root.exists()
    with pytest.raises(ValidationHarnessError):tracks.create(w.job_id,1,static['id'],static['document']['token'],'not-authorized')
    value=ready(temporal)
    assert value['state']=='ready',value['error']
    assert value['source_current'] and value['document']['confirmation'] is None
    assert create(temporal)['id']==value['id']
    for _ in range(2):tracks.latest(w.job_id,1);tracks.view(value['id']);tracks.image(value['id'],0,'head')
    assert counts=={'semantic':1,'tracking':1}
    assert (s.store.job_dir(w.job_id)/'job.json').read_bytes()==before


def test_unknown_submission_never_repeats(temporal):
    s,w,static,tracks,counts=temporal
    def unknown(*args,**kwargs):
        counts['semantic']+=1;kwargs['on_request']();raise TimeoutError('fixture result unknown')
    tracks.observer=unknown
    value=create(temporal);tracks.run(value['id'])
    saved=tracks.view(value['id']);assert saved['calls'][0]['state']=='failed_or_unknown'
    tracks.run(value['id']);tracks.recover();create(temporal)
    assert counts=={'semantic':1,'tracking':0}


def test_new_explicit_correction_versions_policy_without_rewriting_legacy(temporal,monkeypatch):
    import sprite_pipeline.collaboration.tracking as tracking
    from sprite_pipeline.jsonio import read_json
    s,w,static,tracks,counts=temporal
    monkeypatch.setattr(tracking,'TRACKING_POLICY',None)
    first=ready(temporal)
    folder=tracks.folder(first['id'])
    old_revision=(folder/'revision-1.json').read_bytes()
    old_job=read_json(folder/first['document']['job'])
    assert 'tracking_policy' not in old_job
    record=tracks.load(first['id']);record.pop('tracking_policy',None);tracks.save(record)
    monkeypatch.setattr(tracking,'TRACKING_POLICY','manual_first_frame_v2')
    tracks.view(first['id']);tracks.run(first['id'])
    assert counts=={'semantic':1,'tracking':1}
    changed=tracks.correct(first['id'],1,first['document']['token'],'new-policy-'+uuid.uuid4().hex,
        correction={'frame_index':0,'part_id':'head','state':'visible','box':[27,18,37,28],
                    'points':[{'x':31,'y':22,'label':1}]},note='核对当前首帧，纠正头部区域而不改美术')
    tracks.run(changed['id']);changed=tracks.view(changed['id'])
    assert changed['state']=='ready' and changed['revision']==2
    assert read_json(folder/changed['document']['job'])['tracking_policy']=='manual_first_frame_v2'
    assert (folder/'revision-1.json').read_bytes()==old_revision
    restored=tracks.correct(first['id'],2,changed['document']['token'],'restore-policy-'+uuid.uuid4().hex,
                           restore_revision=1,note='恢复原观察，保留其初始化规则')
    assert 'tracking_policy' not in read_json(folder/restored['document']['job'])
    assert counts=={'semantic':1,'tracking':2}


def test_saved_pending_local_correction_keeps_its_original_policy(temporal,monkeypatch):
    import sprite_pipeline.collaboration.tracking as tracking
    from sprite_pipeline.jsonio import read_json
    s,w,static,tracks,counts=temporal
    monkeypatch.setattr(tracking,'TRACKING_POLICY',None)
    first=ready(temporal)
    tracks.correct(first['id'],1,first['document']['token'],'pending-policy-'+uuid.uuid4().hex,
        correction={'frame_index':0,'part_id':'head','state':'unknown'},note='未知状态保持原规则恢复')
    record=tracks.load(first['id']);record.pop('tracking_policy',None);record['pending'].pop('tracking_policy',None);tracks.save(record)
    monkeypatch.setattr(tracking,'TRACKING_POLICY','manual_first_frame_v2')
    tracks.run(first['id']);done=tracks.view(first['id'])
    assert done['state']=='ready'
    assert 'tracking_policy' not in read_json(tracks.folder(first['id'])/done['document']['job'])
    assert counts=={'semantic':1,'tracking':2}


def test_correct_restore_confirm_are_free_and_versioned(temporal):
    s,w,static,tracks,counts=temporal
    first=ready(temporal)
    second=tracks.correct(first['id'],first['revision'],first['document']['token'],'correct-'+uuid.uuid4().hex,
        correction={'frame_index':0,'part_id':'head','state':'unknown'},note='当前帧身份不确定，保持未知')
    assert second['pending'];tracks.run(first['id']);second=tracks.view(first['id'])
    assert second['state']=='ready' and second['revision']==2
    assert second['document']['manual_corrections'][0]['state']=='unknown'
    assert tracks.view(first['id'],1)['document']==first['document']
    third=tracks.correct(first['id'],2,second['document']['token'],'restore-'+uuid.uuid4().hex,restore_revision=1,note='恢复之前的实际观察版本')
    assert third['revision']==3 and third['document']['confirmation'] is None
    fourth=tracks.correct(first['id'],3,third['document']['token'],'confirm-'+uuid.uuid4().hex,confirm=True,note='已检查完整动画和这些结构提示')
    assert fourth['document']['confirmation'] and counts=={'semantic':1,'tracking':2}
    with pytest.raises(ConflictError):tracks.correct(first['id'],1,first['document']['token'],'stale-'+uuid.uuid4().hex,confirm=True,note='不能确认过期的结构版本')


def test_static_revision_change_marks_temporal_evidence_stale(temporal):
    s,w,static,tracks,counts=temporal
    value=ready(temporal);structures=VisualStructures(s)
    structures.correct(static['id'],static['revision'],static['document']['token'],'restore-'+uuid.uuid4().hex,
                       restore_revision=1,note='恢复参考结构，旧时序证据不能强行复用')
    assert not tracks.view(value['id'])['source_current']
    with pytest.raises(ConflictError):tracks.correct(value['id'],1,value['document']['token'],'confirm-'+uuid.uuid4().hex,confirm=True,note='过期证据禁止继续确认')


def test_mask_tampering_is_rejected_on_read(temporal):
    *_,tracks,counts=temporal
    value=ready(temporal);folder=tracks.folder(value['id'])
    receipt=folder/value['document']['receipt']
    mask=receipt.parent/value['document']['frames'][0]['parts'][0]['file']
    mask.write_bytes(b'not the observed region')
    with pytest.raises(ConflictError):tracks.view(value['id'])


def test_original_requirement_snapshot_cannot_be_rewritten(temporal):
    *_,tracks,counts=temporal
    value=ready(temporal)
    atomic_write_json(tracks.folder(value['id'])/'intent.json',{'explicit_user_text':['不是原来的用户要求']})
    with pytest.raises(ConflictError):tracks.view(value['id'])


def test_local_only_path_needs_no_provider_and_preserves_authorization(temporal):
    s,w,static,tracks,counts=temporal
    value=tracks.create(w.job_id,1,static['id'],static['document']['token'],'local-'+uuid.uuid4().hex,use_semantic=False)
    tracks.run(value['id']);value=tracks.view(value['id'])
    assert value['state']=='ready' and not value['calls']
    assert counts=={'semantic':0,'tracking':1}


def test_legacy_clip_without_quality_can_track_but_cannot_buy_review(temporal):
    s,w,static,tracks,counts=temporal
    with s.store.locked_job(w.job_id) as job:
        job.request.open_plan.plan.quality=None
        job.request.open_plan.plan_sha256=digest(job.request.open_plan.plan.model_dump(mode='json'))
        job.candidates[0].plan_execution.quality_review=None
    before=(s.store.job_dir(w.job_id)/'job.json').read_bytes()
    value=tracks.create(w.job_id,1,static['id'],static['document']['token'],'legacy-'+uuid.uuid4().hex,use_semantic=False)
    tracks.run(value['id']);value=tracks.view(value['id'])
    assert value['state']=='ready',value['error']
    assert not value['supports_review'] and not value['calls']
    checked=tracks.correct(value['id'],1,value['document']['token'],'confirm-'+uuid.uuid4().hex,
                           confirm=True,note='仅核对诊断结构，不补造视觉基线')
    with pytest.raises(ValidationHarnessError):start_review(tracks,value['id'],checked['document']['token'],authorized=True)
    assert counts=={'semantic':0,'tracking':1}
    assert (s.store.job_dir(w.job_id)/'job.json').read_bytes()==before


def test_http_only_routes_exact_saved_source_and_revision(temporal):
    s,w,static,tracks,counts=temporal
    client=TestClient(create_api(service=s))
    base='/v1/open-motion/'
    assert client.get(base+w.id+'/temporal').json()['analysis'] is None
    reply=client.post(base+w.id+'/temporal',json={'expected_revision':w.revision,'candidate_index':1,
        'structure_id':static['id'],'structure_token':static['document']['token'],'request_key':'http-local-tracking','use_semantic':False})
    assert reply.status_code==200,reply.text
    identity=reply.json()['id'];tracks.run(identity)
    view=client.get(base+'temporal-structures/'+identity).json()
    assert view['state']=='ready'
    assert client.get(base+f'temporal-structures/{identity}/frames/0/parts/head?revision=1').headers['content-type']=='image/png'
    assert client.get(base+f'temporal-structures/{identity}/frames/99').status_code>=400
    assert client.get(base+f'temporal-structures/{identity}/frames/0/parts/missing').status_code==404
    assert counts=={'semantic':0,'tracking':1}


def test_advisory_review_reuses_baseline_and_becomes_stale_on_correction(temporal):
    s,w,static,tracks,counts=temporal
    first=ready(temporal)
    checked=tracks.correct(first['id'],1,first['document']['token'],'confirm-'+uuid.uuid4().hex,
                           confirm=True,note='查看诊断结构与完整帧序，保留不确定项')
    record=tracks.load(first['id']);registry=ExpertRegistry();s.open_motion_review_registry=registry
    with s.store.locked_job(w.job_id) as job:
        baseline={'mode':'baseline','state':'complete','evidence_token':record['evidence_token'],
            'model_snapshot':job.request.open_plan.model_snapshot,'requests':[{'state':'fixture'}]*2,
            'checks':[{'dimension':d,'status':'pass','confidence':.95,'frames':[1,2,4],'evidence':'诊断基线，没有真实质量含义'} for d in ('completeness','equipment','rhythm')],
            'verdict':'pass','summary':'诊断基线'}
        job.candidates[0].plan_execution.quality_review={'state':'complete','requests':[{'state':'fixture'}]*2,'expert_review':{'baseline':baseline}}
    before=(s.store.job_dir(w.job_id)/'job.json').read_bytes()
    with pytest.raises(ValidationHarnessError):start_review(tracks,first['id'],checked['document']['token'])
    start_review(tracks,first['id'],checked['document']['token'],authorized=True)
    run_review(tracks,first['id']);shown=tracks.view(first['id'])
    assert shown['structured_review']['state']=='complete',shown['structured_review']
    assert shown['structured_review']['new_calls']==2 and len(registry.calls)==2
    start_review(tracks,first['id'],checked['document']['token'],authorized=True);run_review(tracks,first['id'])
    assert len(registry.calls)==2 and (s.store.job_dir(w.job_id)/'job.json').read_bytes()==before
    restored=tracks.correct(first['id'],checked['revision'],checked['document']['token'],'restore-'+uuid.uuid4().hex,
                            restore_revision=1,note='恢复结构版本，旧专家意见应过期')
    assert restored['structured_review']['state']=='stale' and not restored['structured_review']['current']


def test_protocol_change_does_not_resume_paid_review_with_different_rules(temporal,monkeypatch):
    import sprite_pipeline.collaboration.temporal_review_service as review_service
    s,w,static,tracks,counts=temporal
    first=ready(temporal)
    checked=tracks.correct(first['id'],1,first['document']['token'],'confirm-'+uuid.uuid4().hex,
                           confirm=True,note='仅模拟确认结构以验证协议更新')
    record=tracks.load(first['id']);registry=ExpertRegistry();s.open_motion_review_registry=registry
    with s.store.locked_job(w.job_id) as job:
        baseline={'mode':'baseline','state':'complete','evidence_token':record['evidence_token'],
            'model_snapshot':job.request.open_plan.model_snapshot,'requests':[{'state':'fixture'}]*2,
            'checks':[{'dimension':d,'status':'pass','confidence':.95,'frames':[1,2,4],'evidence':'诊断基线'} for d in ('completeness','equipment','rhythm')],
            'verdict':'pass','summary':'诊断基线'}
        job.candidates[0].plan_execution.quality_review={'state':'complete','requests':[{'state':'fixture'}]*2,'expert_review':{'baseline':baseline}}
    start_review(tracks,first['id'],checked['document']['token'],authorized=True)
    monkeypatch.setattr(review_service,'STRUCTURE_REVIEW_VERSION',review_service.STRUCTURE_REVIEW_VERSION+1)
    assert tracks.view(first['id'])['structured_review']['state']=='stale'
    run_review(tracks,first['id'])
    assert not registry.calls
    assert tracks.view(first['id'])['structured_review']['state']=='stale'
