"""Open-motion refinements preserve legacy plans and avoid action-name rules."""
from test_open_motion import setup
from test_open_motion_checkpoints import prepared
from sprite_pipeline.collaboration.quality import compiled_prompt
from sprite_pipeline.collaboration.contracts import MotionConstraints,PlanStage
from sprite_pipeline.collaboration.motion_evidence import measurements
from pydantic import ValidationError
import hashlib
import pytest
from sprite_pipeline.collaboration.targets import save_target
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.checkpoints import Checkpoints
from sprite_pipeline.errors import ConflictError
from test_open_motion_checkpoints import CheckpointPlanner, accept
from test_open_motion import spec, ready


def test_v4_only_draws_local_transition_and_preserves_legacy_compilation(setup):
    s, ws, provider, work = prepared(setup)
    plan = work.plan.model_copy(deep=True)
    plan.stages[0].prompt = 'Lift the hat above the head, remaining upright.'
    plan.stages[1].prompt = 'Bow forward with the same raised hat.'
    before = plan.model_dump(mode='json')
    legacy = compiled_prompt(plan, s.store.load(work.job_id).character, 0)
    assert plan.quality.event_contract in legacy
    plan.quality.version = 4
    prompt = compiled_prompt(plan, s.store.load(work.job_id).character, 0)
    assert plan.quality.event_contract not in prompt
    assert plan.stages[0].prompt in prompt
    assert plan.stages[1].prompt not in prompt
    assert plan.quality.ending_contract not in prompt
    assert plan.quality.appearance_contract in prompt
    assert plan.stages[0].checkpoint.rhythm in prompt
    assert len(prompt) <= 1000
    plan.quality.version = 3
    assert plan.model_dump(mode='json') == before


def target_work(setup):
    s,ws,_,provider,fixture=setup
    ws.model=CheckpointPlanner()
    w=ready(ws,spec())
    image=fixture.write_sequence(fixture.root/'targets')[2].read_bytes()
    w=save_target(ws,w.id,w.revision,0,image,'逐帧核对的中间目标姿势，保持同一物品归属')
    return s,ws,provider,w,image


def test_real_target_is_bound_to_request_never_spliced_into_output(setup):
    s,ws,provider,w,image=target_work(setup)
    w=ws.start(w.id,1,w.plan_sha256)
    PlanGeneration(s).advance(w.job_id,provider,wait=True)
    assert provider.requests[0].last_frame == image
    v=Checkpoints(s).view(w.job_id,1,0)
    raw=PlanGeneration(s).saved_frames(w.job_id,1,0)
    assert v['frames'][-1]['sha256']==hashlib.sha256(raw[-1]).hexdigest()
    assert raw[-1]!=image
    with pytest.raises(ConflictError):save_target(ws,w.id,1,0,image,'执行后不可修改绑定')


def test_tampered_target_stops_before_provider_and_original_needs_consent(setup):
    s,ws,provider,w,image=target_work(setup)
    with pytest.raises(ConflictError):save_target(ws,w.id,1,1,ws.reference(w),'不能用上传原图绕过终态意图')
    w=ws.start(w.id,1,w.plan_sha256)
    (s.store.job_dir(w.job_id)/'targets'/w.end_targets[0].filename).write_bytes(b'changed')
    with pytest.raises(ConflictError):PlanGeneration(s).advance(w.job_id,provider,wait=True)
    assert not provider.requests


def motion(**changes):
    value=dict(camera='Fixed side camera',orientation='Turn gradually toward the viewer',trajectory='Hand follows a continuous curved path',
        support='Airborne body has no foot contact',drive='Torso leads; arms follow with a delay',appearance='One flexible cloth with the same physical owner',
        entry='Already moving upward',exit='Continue turning into the next segment',boundary='pass_through',holds=[],
        generation_hint='Turn body smoothly while airborne; preserve cloth ownership and curved path; continue motion at the boundary.')
    return MotionConstraints(**{**value,**changes})


def test_generic_constraints_allow_turns_airborne_motion_and_do_not_force_static_endpoints(setup):
    s,ws,p,w=prepared(setup,description='跳起后在空中转身并甩动披风')
    plan=w.plan.model_copy(deep=True);plan.quality.version=4;plan.stages[0].motion=motion()
    prompt=compiled_prompt(plan,s.store.load(w.job_id).character,0)
    assert motion().generation_hint in prompt
    assert 'face right.' not in prompt and 'feet planted' not in prompt
    value=plan.stages[0].model_dump(mode='json')
    value['motion']['holds']=[{'start':3,'end':4,'reason':'A hold contradicts the moving boundary'}]
    with pytest.raises(ValidationError):PlanStage.model_validate(value)


def test_pixel_stillness_cue_is_not_a_physics_verdict(setup):
    *_,fixture=setup
    images=[p.read_bytes() for p in fixture.write_sequence(fixture.root/'metrics')]
    report=measurements([images[0],images[0],images[1]],12)
    assert [1,2] in report['possible_hold_pairs']
    assert report['adjacent_changes'][0]['seconds']==1/12
    assert 'verdict' not in report and 'Never an automatic pass' in report['interpretation']
