"""Isolated contract tests; diagnostic masks do not prove segmentation quality."""
import copy
import hashlib
import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import ValidationError

from test_harness_integration import TemporaryHarness
from sprite_pipeline.api_app import create_api
from sprite_pipeline.service import SpritePipelineService
from sprite_pipeline.errors import ConflictError, ValidationHarnessError
from sprite_pipeline.jsonio import atomic_write_json, read_json
from sprite_pipeline.collaboration.structures import VisualStructures
from sprite_pipeline.collaboration.structure_contracts import StructureProposal


def proposal():
    return {'summary':'诊断形状，无真实模型质量含义',
            'parts':[{'id':'head','name':'头部','kind':'head','parent_id':None,'box':[27,18,37,28],
                      'points':[{'x':31,'y':22,'label':1}],'visibility':'visible','evidence':'实际可见区域'}],
            'anchors':[{'id':'head_center','part_id':'head','name':'头部中心','x':31,'y':22,'state':'visible','evidence':'可见像素'}],
            'relations':[],'uncertainties':[]}


@pytest.fixture
def setup(tmp_path):
    fixture=TemporaryHarness(tmp_path)
    service=SpritePipelineService(tmp_path)
    counts={'semantic':0,'local':0}
    def parser(registry,data,models,*,on_request,on_response):
        counts['semantic']+=1;on_request();on_response({'response_id':'fixture-response'})
        return StructureProposal.model_validate(proposal()),{'usage':{'fixture':True}}
    def segmenter(source,parts,output):
        counts['local']+=1;output.mkdir()
        with Image.open(source) as im: size=im.size
        masks=[]
        for part in parts:
            mask=Image.new('L',size,0);ImageDraw.Draw(mask).rectangle(part['box'],fill=255)
            path=output/(part['id']+'.png');mask.save(path)
            masks.append({'id':part['id'],'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'area':sum(v>0 for v in mask.getdata()),'model_score':None})
        return {'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'parts':masks}
    service.structure_parser=parser;service.structure_segmenter=segmenter
    return service,VisualStructures(service),fixture,counts


def ready(structures):
    result=structures.create('test_hero','structure-'+uuid.uuid4().hex,authorized=True)
    structures.run(result['id'])
    return structures.view(result['id'])


def edit(structures,view,**kwargs):
    return structures.correct(view['id'],view['revision'],view['document']['token'],'correct-'+uuid.uuid4().hex,note='实际查看诊断像素并核对',**kwargs)


def test_reads_never_analyze_and_creation_is_cached(setup):
    service,structures,fixture,counts=setup
    assert structures.latest('test_hero')['analysis'] is None
    assert not structures.root.exists()
    with pytest.raises(ValidationHarnessError): structures.create('test_hero','not-authorized')
    result=ready(structures)
    before=fixture.reference_path.read_bytes()
    assert result['state']=='ready' and not result['document']['issues']
    assert result['document']['confirmation'] is None
    assert structures.create('test_hero','another-request',authorized=True)['id']==result['id']
    for _ in range(3):
        structures.latest('test_hero');structures.view(result['id']);structures.image(result['id'],'head')
    assert counts=={'semantic':1,'local':1}
    assert before==fixture.reference_path.read_bytes()
    assert service.store.list_jobs()==[]


def test_device_change_preserves_paid_identity_history_and_cached_masks(setup, monkeypatch):
    _,structures,_,counts=setup
    first=ready(structures)
    runtime=structures.runtime()
    for device in ['mps','cpu']:
        monkeypatch.setattr(structures,'runtime',lambda: {**runtime,
            'compute':{'available':True,'device':device,'requested_device':device}})
        assert structures.create('test_hero','device-'+uuid.uuid4().hex,authorized=True)['id']==first['id']
        assert structures.view(first['id'])['document']==first['document']
    assert counts=={'semantic':1,'local':1}


def test_correction_restore_confirmation_preserve_versions(setup):
    _,structures,fixture,counts=setup
    first=ready(structures);data=copy.deepcopy(first['document']['data'])
    data['anchors'][0]['x']=32
    second=edit(structures,first,data=data)
    assert second['pending']
    structures.run(first['id']);second=structures.view(first['id'])
    assert second['revision']==2 and counts=={'semantic':1,'local':1}
    assert structures.view(first['id'],1)['document']==first['document']
    confirmed=edit(structures,second,confirm=True)
    assert confirmed['document']['confirmation']
    restored=edit(structures,confirmed,restore_revision=1)
    assert restored['revision']==4 and restored['document']['confirmation'] is None
    assert restored['document']['data']==first['document']['data']
    assert counts=={'semantic':1,'local':1}


def test_renaming_reference_reuses_paid_analysis(setup):
    _,structures,fixture,counts=setup
    first=ready(structures)
    path=fixture.character_dir/'character.json';character=read_json(path)
    character['display_name']='Renamed diagnostic character';atomic_write_json(path,character)
    assert structures.create('test_hero','name-only-change',authorized=True)['id']==first['id']
    assert counts['semantic']==1


def test_stale_token_and_source_changes_block_mutations(setup):
    _,structures,fixture,counts=setup
    first=ready(structures);second=edit(structures,first,confirm=True)
    with pytest.raises(ConflictError):edit(structures,first,confirm=True)
    TemporaryHarness.write_frame(fixture.reference_path,shift_x=1)
    assert not structures.view(first['id'])['source_current']
    with pytest.raises(ConflictError):edit(structures,second,confirm=True)
    assert counts['semantic']==1


def test_bad_coordinates_are_not_silently_snapped(setup):
    _,structures,fixture,counts=setup
    first=ready(structures);data=copy.deepcopy(first['document']['data'])
    data['parts'][0]['points'][0].update(x=0,y=0)
    changed=edit(structures,first,data=data);structures.run(first['id'])
    changed=structures.view(first['id'])
    assert changed['document']['issues'] and not changed['document']['masks']
    assert changed['document']['data']['parts'][0]['points'][0]['x']==0
    with pytest.raises(ValidationHarnessError):edit(structures,changed,confirm=True)
    assert counts['local']==1


def test_unknown_and_occluded_coordinates_and_dangling_relations_rejected():
    data=proposal();data['anchors'][0]['state']='unknown'
    with pytest.raises(ValidationError):StructureProposal.model_validate(data)
    data['anchors'][0].update(x=None,y=None)
    assert StructureProposal.model_validate(data).anchors[0].x is None
    data['relations']=[{'id':'invented','source':'head','target':'missing','type':'connected','state':'visible','evidence':''}]
    with pytest.raises(ValidationError):StructureProposal.model_validate(data)


def test_nonfinite_boxes_and_cyclic_parts_are_rejected():
    data=proposal();data['parts'][0]['box'][0]=float('nan')
    with pytest.raises(ValidationError):StructureProposal.model_validate(data)
    data=proposal();data['parts'][0]['parent_id']='head'
    with pytest.raises(ValidationError):StructureProposal.model_validate(data)


def test_unknown_paid_submission_is_not_replayed(setup):
    service,structures,fixture,counts=setup
    def interrupted(*args,**kwargs):
        counts['semantic']+=1;kwargs['on_request']();raise TimeoutError('fixture timeout')
    service.structure_parser=interrupted;structures=VisualStructures(service)
    result=ready(structures)
    assert result['state']=='failed' and result['calls'][0]['state']=='failed_or_unknown'
    structures.recover();structures.run(result['id'])
    assert structures.create('test_hero','do-not-reroll',authorized=True)['id']==result['id']
    assert counts=={'semantic':1,'local':0}


def test_abandoned_parsing_becomes_unknown_without_network(setup):
    service,structures,fixture,counts=setup
    view=structures.create('test_hero','interrupted-create',authorized=True)
    record=structures.load(view['id']);record['state']='parsing';record['calls']=[{'state':'submitted'}];structures.save_record(record)
    structures.recover()
    assert structures.view(view['id'])['state']=='unknown'
    assert counts['semantic']==0


def test_mask_tampering_invalidates_read_and_confirmation(setup):
    _,structures,fixture,counts=setup
    view=ready(structures);mask=view['document']['masks'][0]
    (structures.folder(view['id'])/mask['file']).write_bytes(b'changed')
    with pytest.raises(ConflictError):structures.view(view['id'])
    with pytest.raises(ConflictError):edit(structures,view,confirm=True)


def test_local_failure_keeps_paid_proposal_editable(setup):
    service,structures,fixture,counts=setup
    original=service.structure_segmenter
    service.structure_segmenter=lambda *args:(_ for _ in ()).throw(RuntimeError('fixture segmentation failure'))
    structures=VisualStructures(service);first=ready(structures)
    assert first['state']=='ready' and first['error'] and first['document']['issues']
    assert counts['semantic']==1
    service.structure_segmenter=original;structures=VisualStructures(service)
    edit(structures,first,data=first['document']['data']);structures.run(first['id'])
    assert not structures.view(first['id'])['document']['issues']
    assert counts['semantic']==1


def test_http_contract_and_exact_version_images(setup):
    service,structures,fixture,counts=setup
    client=TestClient(create_api(service=service))
    assert client.get('/v1/open-motion/references/test_hero/structure').json()['analysis'] is None
    assert client.post('/v1/open-motion/structures',json={'character_id':'test_hero','request_key':'api-first-request','authorized':False}).status_code>=400
    reply=client.post('/v1/open-motion/structures',json={'character_id':'test_hero','request_key':'api-first-request','authorized':True})
    assert reply.status_code==201
    identity=reply.json()['id'];structures.run(identity)
    saved=client.get('/v1/open-motion/structures/'+identity).json()
    image=client.get(f'/v1/open-motion/structures/{identity}/masks/head?revision=1')
    assert image.status_code==200 and image.headers['content-type']=='image/png'
    assert client.get(f'/v1/open-motion/structures/{identity}/masks/not_a_part').status_code==404
    payload={'expected_revision':1,'token':saved['document']['token'],'request_key':'confirm-api-once','confirm':True,'note':'实际核对诊断素材'}
    assert client.post(f'/v1/open-motion/structures/{identity}/corrections',json=payload).status_code==200
    assert client.post(f'/v1/open-motion/structures/{identity}/corrections',json=payload).json()['revision']==2
    assert counts['semantic']==1
