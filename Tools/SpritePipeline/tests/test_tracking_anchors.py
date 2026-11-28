"""Semantic corrections are V2 data; V4 and reviewers reuse the same version."""
import copy
import uuid

import pytest
from fastapi.testclient import TestClient

from test_temporal_structures import temporal, setup, ready  # noqa: F401
from test_interaction_previews import context as joint_context
from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.interactions import InteractionPreviews
from sprite_pipeline.collaboration.interaction_contracts import SaveInteraction
from sprite_pipeline.collaboration.tracking_anchors import effective_observations
from sprite_pipeline.errors import ConflictError, ValidationHarnessError
from sprite_pipeline.jsonio import read_json


def correction(view, **changes):
    return {'frame_index':0,'source_sha256':view['document']['frames'][0]['source_sha256'],
            'anchor_id':'head_center','state':'visible','point':{'x':31,'y':22},**changes}


def update(tracks,view,**kwargs):
    return tracks.correct(view['id'],view['revision'],view['document']['token'],uuid.uuid4().hex,
                          note='核对实际图像后纠正语义点，保持原始动画和其他帧',**kwargs)


def test_correct_points_without_model_or_tracking_and_reuse_in_v4(temporal):
    service,work,static,tracks,counts=temporal
    first=ready(temporal);before=copy.deepcopy(counts)
    native=(service.store.job_dir(work.job_id)/'job.json').read_bytes()
    observations=copy.deepcopy(first['document']['observations'])
    revised=update(tracks,first,anchor_correction=correction(first))
    assert revised['state']=='ready' and revised['revision']==first['revision']+1
    assert revised['document']['confirmation'] is None
    assert revised['document']['observations']==observations
    current=revised['document']['effective_observations']['frames'][0]['structure']['anchors'][0]
    assert (current['x'],current['y'],current['origin'])==(31,22,'manual_anchor_correction')
    assert counts==before
    previews=InteractionPreviews(service)
    assert previews.read(work.id)['structure']['state']=='unconfirmed'
    confirmed=update(tracks,revised,confirm=True)
    view=previews.read(work.id);exchange=view['structure']
    assert exchange['state']=='available'
    assert 'manual point corrections' in exchange['anchors'][0]['evidence']
    payload=joint_context(service,work)
    payload.update(structure_binding=exchange['binding'],actor_anchors=exchange['anchors'])
    payload['relations'][0]['actor_anchor']='head_center'
    saved=previews.save(work.id,SaveInteraction.model_validate({'expected_revision':work.revision,'candidate_index':1,
        'source_token':view['source']['token'],'expected_context_version':0,'request_key':uuid.uuid4().hex,'context':payload}))
    assert saved['source_current']
    unknown=update(tracks,confirmed,anchor_correction=correction(confirmed,state='occluded',point=None))
    assert not previews.read(work.id)['source_current']
    assert unknown['document']['effective_observations']['frames'][0]['structure']['anchors'][0]['x'] is None
    assert counts==before and (service.store.job_dir(work.job_id)/'job.json').read_bytes()==native


def test_anchor_rejects_wrong_frame_and_transparent_observations(temporal):
    _,_,_,tracks,counts=temporal;view=ready(temporal);before=copy.deepcopy(counts)
    with pytest.raises(ConflictError):update(tracks,view,anchor_correction=correction(view,source_sha256='f'*64))
    with pytest.raises(ValidationHarnessError):update(tracks,view,anchor_correction=correction(view,point={'x':0,'y':0}))
    with pytest.raises(ValidationHarnessError):update(tracks,view,anchor_correction=correction(view,anchor_id='invented_joint'))
    result=update(tracks,view,anchor_correction=correction(view,state='inferred',point={'x':0,'y':0}))
    assert result['document']['effective_observations']['frames'][0]['structure']['anchors'][0]['state']=='inferred'
    assert counts==before


def test_later_region_change_invalidates_old_point_and_restore_preserves_history(temporal):
    _,_,_,tracks,counts=temporal;first=ready(temporal)
    point=update(tracks,first,anchor_correction=correction(first))
    original=(tracks.folder(first['id'])/f'revision-{point["revision"]}.json').read_bytes()
    changed=update(tracks,point,correction={'frame_index':0,'part_id':'head','state':'unknown'})
    tracks.run(changed['id']);changed=tracks.view(changed['id'])
    value=changed['document']['effective_observations']['frames'][0]['structure']['anchors'][0]
    assert value['state']=='unknown' and value['origin']=='stale_manual_anchor'
    restored=update(tracks,changed,restore_revision=point['revision'])
    value=restored['document']['effective_observations']['frames'][0]['structure']['anchors'][0]
    assert value['state']=='visible' and value['x']==31
    assert (tracks.folder(first['id'])/f'revision-{point["revision"]}.json').read_bytes()==original


def test_new_manual_keyframe_does_not_copy_reference_pose_to_other_points(temporal):
    _,_,_,tracks,_=temporal;view=ready(temporal)
    document=tracks.document(tracks.load(view['id']))
    reference=read_json(tracks.folder(view['id'])/'structure.json')['data']
    frames=view['document']['frames']
    # Isolate the overlay behavior when a prior observation has no semantic points.
    document['observations']={'summary':'local tracking only','frames':[],'issues':[],'corrections':[]}
    from sprite_pipeline.collaboration.tracking_anchors import part_correction_token
    document['manual_anchor_corrections']=[{**correction(view),'part_id':'head','origin':'manual_anchor_correction',
        'part_correction_token':part_correction_token(document,0,'head')}]
    result=effective_observations(document,reference,frames)
    assert [f['frame_index'] for f in result['frames']]==[0]
    assert result['frames'][0]['structure']['parts'][0]['visibility']=='unknown'
    assert result['frames'][0]['structure']['anchors'][0]['x']==31


def test_native_api_persists_manual_anchor_without_new_tracking(temporal):
    service,_,_,tracks,counts=temporal;view=ready(temporal);before=copy.deepcopy(counts)
    client=TestClient(create_api(service=service))
    result=client.post(f'/v1/open-motion/temporal-structures/{view["id"]}/corrections',json={
        'expected_revision':view['revision'],'token':view['document']['token'],'request_key':uuid.uuid4().hex,
        'anchor_correction':correction(view),'note':'实际图像核对后的语义位置修订'})
    assert result.status_code==200,result.text
    assert result.json()['document']['manual_anchor_corrections'][0]['anchor_id']=='head_center'
    assert counts==before
