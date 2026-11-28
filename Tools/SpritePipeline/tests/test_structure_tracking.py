"""Temporal evidence integrity and uncertainty, with no model or GPU requests."""
import copy
import hashlib
import importlib
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from sprite_pipeline.collaboration.tracking_observation import select_keyframes
from sprite_pipeline.collaboration.tracking_data import correction_inputs, validate_receipt, tracking_cues
from sprite_pipeline.errors import ConflictError, ValidationHarnessError


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()


def structure():
    return {'summary':'实际像素诊断结构', 'parts':[
        {'id':'body','name':'身体','kind':'body','parent_id':None,'box':[2,2,10,12],
         'points':[{'x':5,'y':5,'label':1}],'visibility':'visible','evidence':'可见块'},
        {'id':'held','name':'装备','kind':'equipment','parent_id':None,'box':[10,6,15,9],
         'points':[{'x':12,'y':7,'label':1}],'visibility':'visible','evidence':'可见条'}],
        'anchors':[{'id':'grip','name':'握点','part_id':'held','state':'unknown','x':None,'y':None,'evidence':'握点不清楚'}],
        'relations':[{'id':'holding','type':'holds','source':'body','target':'grip','state':'unknown','evidence':'无法确认'}],
        'uncertainties':['握点不清楚']}


@pytest.fixture
def data(tmp_path):
    image=Image.new('RGBA',(16,16));draw=ImageDraw.Draw(image)
    draw.rectangle((2,2,9,11),fill=(30,80,190,255));draw.rectangle((10,6,14,8),fill=(190,220,255,255))
    source=tmp_path/'source.png';image.save(source)
    frames=[]
    for i in range(4):
        path=tmp_path/f'frame-{i}.png';image.save(path)
        frames.append({'frame_index':i,'path':str(path),'sha256':sha(path)})
    parts=[];observed=[];folder=tmp_path/'tracked';folder.mkdir()
    for p in structure()['parts']:
        mask=Image.new('L',(16,16));ImageDraw.Draw(mask).rectangle((p['box'][0],p['box'][1],p['box'][2]-1,p['box'][3]-1),fill=255)
        path=tmp_path/(p['id']+'.png');mask.save(path)
        parts.append({'id':p['id'],'mask_path':str(path),'mask_sha256':sha(path)})
    for i,f in enumerate(frames):
        row=[]
        for p in parts:
            target=folder/f'{i}-{p["id"]}.png';target.write_bytes(Path(p['mask_path']).read_bytes())
            with Image.open(target) as im: area=int((np.asarray(im)>0).sum())
            row.append({'id':p['id'],'file':target.name,'sha256':sha(target),'state':'estimated','area':area,
                        'box':None,'centroid':None,'axis_degrees_mod_180':None})
        observed.append({'frame_index':i,'source_sha256':f['sha256'],'time_seconds':i/12,'parts':row})
    reference={'path':str(source),'sha256':sha(source)}
    job={'reference':reference,'frames':frames,'parts':parts,'fps':12}
    receipt={'operation':'track','fps':12,'reference':reference,'source_frames':frames,'reference_parts':parts,
             'corrections':[],'frames':observed,'context_frame_count':1,'context_excluded_from_playback':True,'width':16,'height':16}
    return job,receipt,folder


def test_selection_uses_real_frame_indices_and_keeps_endpoints(data):
    job,_,_=data
    selected=select_keyframes([f['path'] for f in job['frames']],12)
    assert selected==sorted(set(selected)) and selected[0]==0 and selected[-1]==3
    assert len(selected)<=4


def test_receipt_integrity_and_reference_is_not_animation(data):
    job,receipt,folder=data
    validate_receipt(receipt,folder,job)
    original=copy.deepcopy(receipt)
    for mutate in [lambda r:r.update(fps=24),lambda r:r.update(context_excluded_from_playback=False),
                   lambda r:r['frames'].reverse(),lambda r:r['frames'][1].update(time_seconds=0),
                   lambda r:r['frames'][0]['parts'].pop()]:
        receipt=copy.deepcopy(original);mutate(receipt)
        with pytest.raises(ConflictError):validate_receipt(receipt,folder,job)


def test_receipt_requires_the_frozen_initialization_policy(data):
    job,receipt,folder=data
    validate_receipt(receipt,folder,job)  # Saved v1 records retain their meaning.
    job['tracking_policy']='manual_first_frame_v2'
    with pytest.raises(ConflictError,match='初始化'):validate_receipt(receipt,folder,job)
    receipt['tracking_policy']=job['tracking_policy']
    validate_receipt(receipt,folder,job)
    job['tracking_policy']=receipt['tracking_policy']='invented'
    with pytest.raises(ConflictError,match='初始化'):validate_receipt(receipt,folder,job)


@pytest.fixture
def tracker_policy(monkeypatch):
    import importlib.util
    root=Path(__file__).resolve().parents[3]/'Tools/VisualStructure'
    monkeypatch.syspath_prepend(str(root))
    spec=importlib.util.spec_from_file_location('forge_tracking_seed_policy',root/'tracking.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def test_first_actual_frame_manual_seed_supersedes_reference_without_reordering(tracker_policy):
    calls=[]
    class Predictor:
        def add_new_mask(self,state,**kw):calls.append(('mask',kw))
        def add_new_points_or_box(self,state,**kw):calls.append(('points',kw))
    parts=[{'id':x} for x in ['body','cape','equipment']]
    masks={p['id']:p['id']+'-mask' for p in parts}
    corrections=[{'part_id':'cape','frame_index':0,'state':'visible','origin':'user_correction',
                  'box':[1,2,5,6],'points':[[2,3]],'labels':[1]}]
    untouched=copy.deepcopy(corrections)
    start=tracker_policy.seed_predictor(Predictor(),{},parts,masks,corrections,tracker_policy.CORRECTION_SEED_POLICY)
    assert start==1  # No prediction before this object's first valid conditioning frame.
    assert [item[1]['obj_id'] for item in calls]==['body','cape','equipment']
    assert [(kind,kw['frame_idx']) for kind,kw in calls]==[('mask',0),('points',1),('mask',0)]
    assert corrections==untouched and calls[1][1]['points']==[[2,3]]


@pytest.mark.parametrize('variant',['legacy','semantic','unknown','later'])
def test_unrequested_or_legacy_seeds_keep_reference_initialization(tracker_policy,variant):
    calls=[]
    class Predictor:
        def add_new_mask(self,state,**kw):calls.append(('mask',kw))
        def add_new_points_or_box(self,state,**kw):calls.append(('points',kw))
    correction={'part_id':'held','frame_index':0,'state':'visible','origin':'user_correction',
                'points':[[3,4]],'labels':[1]}
    policy=tracker_policy.CORRECTION_SEED_POLICY
    if variant=='legacy':policy=tracker_policy.LEGACY_SEED_POLICY
    if variant=='semantic':correction['origin']='semantic_keyframe'
    if variant=='unknown':correction.update(state='unknown',points=[],labels=[])
    if variant=='later':correction['frame_index']=3
    start=tracker_policy.seed_predictor(Predictor(),{},[{'id':'held'}],{'held':'original-mask'},[correction],policy)
    assert start is None and calls[0]==('mask',{'frame_idx':0,'obj_id':'held','mask':'original-mask'})
    assert len(calls)==(1 if variant=='unknown' else 2)
    if variant=='later':assert calls[1][1]['frame_idx']==4


@pytest.mark.parametrize('mode',['legacy','new_uncorrected','new_corrected'])
def test_worker_receipt_uses_elapsed_time_independently_of_frame_start(data,tracker_policy,monkeypatch,mode):
    """Exercise the whole worker orchestration with a fake predictor, not only seeding."""
    import contextlib
    import sys
    import types
    job,_,folder=data
    weights=folder.parent/'diagnostic.weights';weights.write_bytes(b'fixture weights; no inference')
    job.update(weights=str(weights),weights_sha256=sha(weights),output=str(folder.parent/('output-'+mode)))
    if mode!='legacy':job['tracking_policy']='manual_first_frame_v2'
    if mode=='new_corrected':job['corrections']=[{'frame_index':0,'part_id':'body','state':'visible',
        'origin':'user_correction','points':[[5,5]],'labels':[1]}]
    masks={p['id']:np.asarray(Image.open(p['mask_path']))>0 for p in job['parts']}
    class Logit:
        def __init__(self,mask):self.mask=mask
        def __getitem__(self,_):return self
        def detach(self):return self
        def float(self):return self
        def cpu(self):return self
        def numpy(self):return self.mask.astype(float)
    class Predictor:
        def init_state(self,**kw):return {}
        def add_new_mask(self,*args,**kw):pass
        def add_new_points_or_box(self,*args,**kw):pass
        def propagate_in_video(self,state,**kw):
            for i in range(kw.get('start_frame_idx',0),len(job['frames'])+1):
                yield i,list(masks),[Logit(mask) for mask in masks.values()]
    fake_torch=types.ModuleType('torch')
    fake_torch.cuda=types.SimpleNamespace(is_available=lambda:False)
    fake_torch.inference_mode=contextlib.nullcontext
    package=types.ModuleType('sam2');package.__path__=[]
    builder=types.ModuleType('sam2.build_sam');builder.build_sam2_video_predictor=lambda *a,**kw:Predictor()
    video=types.ModuleType('sam2.sam2_video_predictor');video.load_video_frames=object()
    package.sam2_video_predictor=video
    for name,value in [('torch',fake_torch),('sam2',package),('sam2.build_sam',builder),('sam2.sam2_video_predictor',video)]:
        monkeypatch.setitem(sys.modules,name,value)
    ticks=iter([10.0,12.5])
    monkeypatch.setattr(tracker_policy,'time',types.SimpleNamespace(monotonic=lambda:next(ticks)))
    receipt=tracker_policy.track(job)
    assert receipt['seconds']==2.5
    assert len(receipt['frames'])==len(job['frames'])
    assert receipt['paid_calls']==0 and receipt['context_excluded_from_playback']
    validate_receipt(receipt,Path(job['output']),job)


def test_changed_mask_and_changed_source_are_rejected(data):
    job,receipt,folder=data
    mask=folder/receipt['frames'][0]['parts'][0]['file'];before=mask.read_bytes();mask.write_bytes(b'wrong')
    with pytest.raises(ConflictError):validate_receipt(receipt,folder,job)
    mask.write_bytes(before)
    Path(job['frames'][0]['path']).write_bytes(b'changed source')
    with pytest.raises(ConflictError):validate_receipt(receipt,folder,job)


def test_visibility_unknown_is_not_anatomy_or_contact(data):
    job,_,_=data
    value={'summary':'观察关键帧', 'frames':[{'frame_index':0,'structure':structure()}]}
    result=correction_inputs(structure(),value,[f['path'] for f in job['frames']],[0])
    anchor=result['frames'][0]['structure']['anchors'][0]
    assert anchor['state']=='unknown' and anchor['x'] is None
    assert result['frames'][0]['structure']['relations'][0]['state']=='unknown'
    assert not result['issues']


def test_bad_keyframe_point_becomes_unusable_without_snapping(data):
    job,_,_=data
    value={'summary':'观察关键帧', 'frames':[{'frame_index':0,'structure':structure()}]}
    value['frames'][0]['structure']['parts'][1]['points'][0].update(x=0,y=0)
    result=correction_inputs(structure(),value,[f['path'] for f in job['frames']],[0])
    assert result['issues'] and result['corrections'][1]['state']=='unknown'
    assert value['frames'][0]['structure']['parts'][1]['points'][0]['x']==0
    assert 'points' not in result['corrections'][1]
    assert result['frames'][0]['structure']['parts'][1]['visibility']=='unknown'


def test_unresolved_region_cannot_supply_geometry_or_overlap_evidence(data):
    _,receipt,folder=data
    part=receipt['frames'][0]['parts'][1]
    part.update(state='unknown',area=256,box=[0,0,16,16],centroid=[8,8],axis_degrees_mod_180=45)
    Image.new('L',(16,16),255).save(folder/part['file'])
    result=tracking_cues(receipt,folder,structure())
    value=result['series'][0]['parts'][1]
    assert all(value[k] is None for k in ('area','box','centroid','axis_degrees_mod_180'))
    issues=[c for c in result['cues'] if c['frame_index']==0 and 'held' in c['parts']]
    assert [c['reason'] for c in issues]==['visibility_or_identity_unresolved']
    assert receipt['frames'][0]['parts'][1]['box']==[0,0,16,16]


def test_unknown_part_cannot_supply_visible_grip_or_holding_relation(data):
    job,_,_=data
    current=structure()
    current['parts'][1].update(visibility='unknown',box=None,points=[])
    current['anchors'][0].update(state='visible',x=12,y=7)
    current['relations'][0].update(state='visible')
    value={'summary':'未知部件不能提供可见握点', 'frames':[{'frame_index':0,'structure':current}]}
    result=correction_inputs(structure(),value,[f['path'] for f in job['frames']],[0])
    assert result['frames'][0]['structure']['anchors'][0]['state']=='unknown'
    assert result['frames'][0]['structure']['anchors'][0]['x'] is None
    assert result['frames'][0]['structure']['relations'][0]['state']=='unknown'


@pytest.mark.parametrize('mutation', ['part','anchor','topology','frame'])
def test_keyframe_cannot_rebind_identities(data,mutation):
    job,_,_=data
    value={'summary':'观察关键帧', 'frames':[{'frame_index':0,'structure':structure()}]}
    frame=value['frames'][0]
    if mutation=='part':frame['structure']['parts'][0]['id']='somebody_else';frame['structure']['relations']=[]
    if mutation=='anchor':frame['structure']['anchors'][0]['part_id']='body'
    if mutation=='topology':frame['structure']['parts'][1]['parent_id']='body'
    if mutation=='frame':frame['frame_index']=1
    with pytest.raises(ValidationHarnessError):correction_inputs(structure(),value,[f['path'] for f in job['frames']],[0])


def test_large_overlap_is_a_cue_not_a_defect_or_adoption(data):
    _,receipt,folder=data
    part=receipt['frames'][0]['parts'][1]
    image=Image.new('L',(16,16),255);image.save(folder/part['file']);part['area']=256
    result=tracking_cues(receipt,folder,structure())
    assert result['cues'] and 'verdict' not in result and 'decision' not in result
    assert any(c['reason']=='region_expansion_requires_visual_check' for c in result['cues'])


def test_region_axis_is_undirected_and_empty_is_unknown(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]/'VisualStructure'))
    measure=importlib.import_module('tracking').measure
    empty=measure(np.zeros((16,16),dtype=bool))
    assert empty['state']=='unknown' and empty['centroid'] is None
    mask=np.zeros((16,16),dtype=bool);mask[6:9,2:14]=True
    result=measure(mask)
    assert result['axis_degrees_mod_180']==0 and result['state']=='estimated'
    assert 'facing' not in result and 'joint' not in result
