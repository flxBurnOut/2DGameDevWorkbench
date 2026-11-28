"""Drawing conditions retain mechanics, checked images and frozen old behavior."""
import copy
import hashlib
import json
import uuid
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from test_open_motion import setup, spec
from test_open_motion_checkpoints import CheckpointPlanner, accept
from test_temporal_structures import temporal
from sprite_pipeline.collaboration.contracts import PlanBinding, PlanProposal, digest
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.generation_conditions import compile_conditions, condition_rows
from sprite_pipeline.collaboration.planning import PlanningModel
from sprite_pipeline.collaboration.quality import compiled_prompt
from sprite_pipeline.collaboration.targets import save_target
from sprite_pipeline.errors import ValidationHarnessError
from sprite_pipeline.jsonio import read_json


class ConditionPlanner(CheckpointPlanner):
    def __call__(self, *args, **kwargs):
        response, receipt = super().__call__(*args, **kwargs)
        if response['action'] == 'finalize':
            p = response['plan']; q = p['quality']; q['version'] = 4
            q['appearance_contract'] = 'Same outfit, one soft hat, original grip.'
            q['ending_contract'] = 'Balanced bow, hat held ahead.'
            q['key_poses'] = [{'frame':1,'description':'Hat near head'},
                              {'frame':4,'description':'Hat raised, torso upright'},
                              {'frame':8,'description':'Torso bowed, hat ahead'}]
            for i, s in enumerate(p['stages']):
                s['prompt'] = 'Raise hat, keep torso upright.' if i == 0 else 'Bow once, bring hat ahead.'
                s['checkpoint'].update(endpoint='Hat raised, torso upright.' if i == 0 else 'Balanced bow, hat ahead.',
                                       rhythm='1-3 move; 4 flow onward.' if i == 0 else '1-2 bow; 3-4 ease down.')
                s['motion'] = dict(camera='Fixed side view.', orientation='Body remains side-on.',
                    drive='Arm leads; wrist and hat follow.' if i == 0 else 'Hips fold; torso then arms follow.',
                    support='Feet apart; knees soften.', trajectory='Hand curves up.' if i == 0 else 'Hat curves forward and down.',
                    appearance='Soft hat flexes; stays in the same hand.',
                    entry='Continue actual input pose.', exit='Flow onward.' if i == 0 else 'Settle in a balanced bow.',
                    boundary='pass_through' if i == 0 else 'settle', holds=[],
                    generation_hint='Keep hat touching its original hand.')
        return response, receipt


def work(setup, *, policy=1):
    s, ws, _, p, fixture = setup
    ws.model = ConditionPlanner()
    w = ws.create(spec(), uuid.uuid4().hex, planning_authorized=True)
    w.generation_policy_version = policy; ws.save(w)
    w = ws.plan(w.id)
    assert w.status == 'ready', w.message
    return s, ws, p, fixture, w


@pytest.mark.parametrize('policy',[1,2])
def test_all_mechanics_reach_provider_and_both_real_image_conditions_survive(setup,policy):
    s, ws, provider, fixture, w = work(setup,policy=policy)
    targets = [p.read_bytes() for p in fixture.write_sequence(fixture.root/'checked-targets')][1:3]
    for i, png in enumerate(targets):
        w = save_target(ws,w.id,w.revision,i,png,'已检查同一角色的具体姿势与装备')
    w = ws.start(w.id,w.revision,w.plan_sha256)
    engine = PlanGeneration(s)
    for i in range(2):
        engine.advance(w.job_id,provider,wait=True)
        req = provider.requests[i]
        motion = w.plan.stages[i].motion
        assert req.last_frame == targets[i]
        for field in ['camera','orientation','drive','support','trajectory','appearance','generation_hint']:
            assert getattr(motion,field) in req.prompt
        assert len(req.prompt) <= 1000
        intent = read_json(engine.directory(w.job_id,1,i)/'submit.intent.json')
        trace = intent['drawing_conditions']
        assert trace['target_mode'] == 'image'
        assert trace['last_sha256'] == hashlib.sha256(targets[i]).hexdigest()
        assert trace['prompt_sha256'] == hashlib.sha256(req.prompt.encode()).hexdigest()
        assert trace['rows'] == condition_rows(w.plan,i,policy_version=policy)
        accept(s,w,i)
    assert provider.requests[1].reference_image == engine.saved_frames(w.job_id,1,0)[-1]
    engine.advance(w.job_id,provider,wait=True)
    assert len(s.store.load(w.job_id).candidates[0].frames) == 8
    assert len(provider.requests) == 2
    ws.view(w.id); ws.start(w.id,w.revision,w.plan_sha256)
    assert len(provider.requests) == 2  # Reads/duplicate delivery do not redraw.


def test_missing_target_is_honest_and_not_synthesized(setup):
    s, ws, p, _, w = work(setup)
    w = ws.start(w.id,1,w.plan_sha256); engine = PlanGeneration(s)
    engine.advance(w.job_id,p,wait=True)
    intent = read_json(engine.directory(w.job_id,1,0)/'submit.intent.json')
    assert p.requests[0].last_frame is None
    assert intent['drawing_conditions']['target_mode'] == 'text_only'
    assert not w.end_targets


def test_field_overflow_stops_without_silent_truncation_or_omission(setup):
    s, ws, p, _, w = work(setup)
    plan = w.plan.model_copy(deep=True)
    plan.stages[0].prompt = 'A changing full-body pose. ' * 30
    with pytest.raises(ValidationHarnessError,match='不截断'):
        compile_conditions(plan,0)
    assert not p.requests and not w.job_id


def test_turn_airborne_flexible_shape_and_explicit_hold_are_not_overridden(setup):
    _, _, _, _, w = work(setup)
    plan = w.plan.model_copy(deep=True); m = plan.stages[0].motion
    m.orientation = 'Turn toward viewer.'
    m.support = 'Airborne; no foot contact.'
    m.appearance = 'Flexible cloth twists around its owner.'
    text = compile_conditions(plan,0)
    assert m.orientation in text and m.support in text and m.appearance in text
    assert 'feet planted' not in text and 'face right' not in text
    m.boundary = 'intentional_hold'
    from sprite_pipeline.collaboration.contracts import PlannedHold
    m.holds = [PlannedHold(start=3,end=4,reason='User requested a pause.')]
    text = compile_conditions(plan,0)
    assert '3-4: User requested a pause.' in text
    assert 'no endpoint hold' not in text


def test_saved_v4_work_and_frozen_prompts_do_not_opt_into_new_policy(setup):
    s, ws, p, _, w = work(setup,policy=None)
    before = copy.deepcopy(w.plan.model_dump(mode='json'))
    old = [compiled_prompt(w.plan,None,i) for i in range(2)]
    assert 'generation_policy_version' not in w.model_dump(mode='json')
    w = ws.start(w.id,1,w.plan_sha256)
    job = s.store.load(w.job_id)
    assert 'generation_policy_version' not in job.request.open_plan.model_dump(mode='json')
    assert job.request.open_plan.compiled_prompts == old
    PlanGeneration(s).advance(w.job_id,p,wait=True)
    assert p.requests[0].prompt == old[0]
    assert w.plan.model_dump(mode='json') == before
    assert digest(before) == w.plan_sha256


def test_changed_frozen_conditions_cannot_be_submitted(setup):
    s, ws, _, _, w = work(setup)
    w = ws.start(w.id,1,w.plan_sha256)
    b = s.store.load(w.job_id).request.open_plan.model_dump(mode='json')
    b['compiled_prompts'][0] = 'Something else entirely'
    with pytest.raises(ValidationError,match='Frozen drawing conditions'):
        PlanBinding.model_validate(b)


def test_new_planning_policy_reaches_all_experts_without_changing_old_transport(setup):
    s, ws, _, _, w = work(setup)
    model = PlanningModel(s.settings); captured = []
    class Registry:
        def send(self,role,content,schema,*args,**kwargs):
            captured.append((role,content,kwargs))
            value = {'action':'propose','summary':'可见部位与运动依据',
                     'findings':[{'text':'按原图保持归属','source':'reference','evidence':'原图可见内容'}]}
            if role=='strategy': value['proposal']=w.plan.model_dump(mode='json')
            if role=='coordinator': value={'action':'finalize','summary':'协调完成','plan':w.plan.model_dump(mode='json')}
            return schema.model_validate(value),{}
    model.registry = Registry()
    for role in ['appearance','motion','strategy','coordinator']:
        model(role,w,ws.reference(w))
        text = captured[-1][1][0]['text']
        assert 'DRAWING CONDITIONS policy 1' in text
        assert 'They will ALL be compiled' not in text
        assert 'fewer frames within' in text
        data = json.loads(text.split('TASK DATA:\n',1)[1])
        assert data['drawing_condition_policy']['motion_fields_sent_directly'] == ['camera','orientation','drive','support','trajectory','appearance']
    model('appearance',w.model_copy(update={'generation_policy_version':None}),ws.reference(w))
    text = captured[-1][1][0]['text']
    assert 'DRAWING CONDITIONS policy 1' not in text and 'They will ALL be compiled' in text


def test_validated_defaults_are_new_only_and_reads_never_upgrade_old_records(setup):
    s, ws, _, _, _ = setup
    from sprite_pipeline.collaboration.contracts import TaskSpec
    raw=spec().model_dump(mode='json'); raw['provider']='pixellab'
    with patch('sprite_pipeline.collaboration.workspace.DEFAULT_GENERATION_POLICY',None),patch('sprite_pipeline.collaboration.workspace.DEFAULT_VISIBILITY_REVIEW',None):
        w=ws.create(TaskSpec.model_validate(raw),uuid.uuid4().hex,planning_authorized=True)
    assert w.generation_policy_version is None and not w.planning_calls
    assert ws.load(w.id).generation_policy_version is None
    assert ws.create(w.spec,w.request_key,planning_authorized=True).generation_policy_version is None
    raw['review_protocol']='experts_v1'
    new=ws.create(TaskSpec.model_validate(raw),uuid.uuid4().hex,planning_authorized=True)
    assert new.generation_policy_version==6 and new.visibility_review_version==4
    assert not new.planning_calls and not new.job_id


def test_policy_2_maximum_field_lengths_six_poses_and_three_holds_fit(setup):
    from sprite_pipeline.collaboration.contracts import PlanProposal
    from sprite_pipeline.collaboration.generation_conditions import TEXT_LIMITS
    _,_,_,_,w=work(setup,policy=2)
    raw=w.plan.model_dump(mode='json');raw['stages']=raw['stages'][:1]
    stage=raw['stages'][0];stage['frame_count']=16
    for kind,target in [('MotionQuality',raw['quality']),('PlanStage',stage),
                         ('PoseCheckpoint',stage['checkpoint']),('MotionConstraints',stage['motion'])]:
        for field,limit in TEXT_LIMITS[kind].items():target[field]='x'*limit
    raw['quality']['key_poses']=[{'frame':n,'description':'x'*26} for n in range(10,16)]
    stage['motion']['boundary']='intentional_hold'
    stage['motion']['holds']=[{'start':n,'end':n+1,'reason':'r'*100} for n in [10,12,14]]
    plan=PlanProposal.model_validate(raw);before=plan.model_dump(mode='json')
    prompt=compile_conditions(plan,0,policy_version=2)
    assert len(prompt)<=1000
    assert all(f'{n}-{n+1}' in prompt for n in [10,12,14])
    assert 'r'*100 not in prompt  # Reasons remain in review, exact ranges reach drawing.
    assert plan.model_dump(mode='json')==before


def test_text_budget_is_in_wire_schema_and_local_validation_without_rewriting(setup):
    from sprite_pipeline.collaboration.contracts import CoordinatorTurn
    from sprite_pipeline.collaboration.generation_conditions import bind_text_budget,TEXT_LIMITS
    _,_,_,_,w=work(setup,policy=2)
    schema=bind_text_budget(CoordinatorTurn);wire=schema.model_json_schema()
    assert wire['$defs']['MotionConstraints']['properties']['drive']['maxLength']==60
    assert CoordinatorTurn.model_json_schema()['$defs']['MotionConstraints']['properties']['drive']['maxLength']==140
    raw={'action':'finalize','summary':'预算化完整方案','plan':w.plan.model_dump(mode='json')}
    raw['plan']['quality']['appearance_contract']='x'*46
    before=copy.deepcopy(raw)
    with pytest.raises(ValidationError,match='45'):
        schema.model_validate(raw)
    assert raw==before
    raw['plan']['questions']=['需要确认关键目标']
    assert schema.model_validate(raw).plan.questions  # Do not block genuine clarification.


class StructuredConditionsPlanner(ConditionPlanner):
    def __call__(self, *args, **kwargs):
        response, receipt = super().__call__(*args, **kwargs)
        if response['action'] != 'finalize':
            return response, receipt

        plan = response['plan']
        plan['quality'].update(
            event_contract='Jump once, turn toward the viewer in midair, then land low with the clasp still attached.',
            ending_contract='Keep the visibly low landing for the requested final two frames.',
            key_poses=[
                {'frame': 1, 'description': 'Bent knees initiate a single jump under the same flexible blue cape.'},
                {'frame': 4, 'description': 'The figure is still rising, without yet facing the viewer.'},
                {'frame': 5, 'description': 'The torso begins the turn toward the viewer while both feet are airborne.'},
                {'frame': 8, 'description': 'Facing the viewer in a low landing, with the silver clasp still visible.'},
            ],
        )
        transitions = [
            {
                'action': 'Jump once from the supplied pose, with the cape attached.',
                'orientation': 'Remain side-on during rise.',
                'drive': 'Hips lead; the cape trails.',
                'support': 'Push off, then airborne.',
                'trajectory': 'Rise; cape arcs back.',
                'rhythm': '1-3 rise; 4 still moving.',
                'endpoint': 'Upright in the air.',
                'exit': 'Carry upward momentum through the join.',
                'boundary': 'pass_through',
                'holds': [],
            },
            {
                'action': 'Continue the airborne rise, turn once toward the viewer, then land low.',
                'orientation': 'Turn toward viewer.',
                'drive': 'Torso leads; cape follows.',
                'support': 'Airborne, then land low.',
                'trajectory': 'Turn midair; descend softly.',
                'rhythm': '1 turn, 2 land.',
                'endpoint': 'Land low, face viewer, hold.',
                'exit': 'Hold only the low landing.',
                'boundary': 'intentional_hold',
                'holds': [{'start': 3, 'end': 4, 'reason': 'The user wants two still frames after landing.'}],
            },
        ]
        for stage, transition in zip(plan['stages'], transitions, strict=True):
            stage.pop('prompt')
            stage.update(goal=transition['action'],
                         structure_usage={'part_ids': ['head'], 'anchor_ids': ['head_center'],
                                          'relation_ids': [], 'effect': 'Preserve the observed head silhouette.'})
            stage['checkpoint'].update(endpoint=transition['endpoint'], rhythm=transition['rhythm'])
            stage['motion'].update({field: transition[field] for field in (
                'orientation', 'drive', 'support', 'trajectory', 'exit', 'boundary', 'holds')})
            stage['motion'].update(camera='Fixed side framing.', appearance='One blue cape, silver clasp.',
                                   generation_hint='Keep the visible head contour.')
        return response, receipt


def test_structured_drawing_reaches_provider_with_local_intent_and_real_anchors(setup, temporal, monkeypatch):
    service, workspace, _, provider, fixture = setup
    static = temporal[2]
    monkeypatch.setenv('TOKENHUB_API_KEY', 'isolated-test-planning-key')
    workspace.model = model = PlanningModel(service.settings)
    spec_with_structure = spec('跳起后在空中向观众转身一次，保持蓝披风和银搭扣，落地压低身体并保持末两帧。',
                               visual_structure={'analysis_id': static['id'], 'token': static['document']['token']})
    work = workspace.create(spec_with_structure, uuid.uuid4().hex, planning_authorized=True)
    work.generation_policy_version = 6
    workspace.save(work)
    reference = workspace.reference(work)
    final, _ = StructuredConditionsPlanner()('coordinator', work, reference)
    for stage, action_length in zip(final['plan']['stages'], [188, 182], strict=True):
        stage['goal'] = stage['goal'].ljust(action_length, '势')
    draft = copy.deepcopy(final['plan'])
    for stage in draft['stages']:
        stage['prompt'] = stage['goal'] + ' Nonexecutable movement rationale.' * 35

    def send(role, _content, schema, *_args, **_kwargs):
        if role == 'coordinator':
            reply = final
        elif role == 'strategy':
            reply = {'action': 'propose', 'summary': '按原要求分两段推进', 'proposal': draft}
        else:
            reply = {'action': 'propose', 'summary': '离线参考观察', 'findings': [
                {'text': '核对可见头部轮廓', 'source': 'reference', 'evidence': '隔离诊断图中的可见头部'},
            ]}
        return schema.model_validate(reply), {'response_id': f'fixture-{role}'}

    monkeypatch.setattr(model.registry, 'send', send)
    before = len(provider.requests)
    work = workspace.plan(work.id)
    assert work.status == 'ready', work.message
    assert [call['role'] for call in work.planning_calls] == ['appearance', 'motion', 'strategy', 'coordinator']
    proposal = next(message['response']['proposal'] for message in work.messages if message['role'] == 'strategy')
    assert all(len(stage['prompt']) > 1000 for stage in proposal['stages'])
    assert len(provider.requests) == before and not work.job_id

    target = fixture.write_sequence(fixture.root / 'checked-drawing-target')[1].read_bytes()
    work = save_target(workspace, work.id, work.revision, 0, target, '已检查诊断图中的目标端点')
    work = workspace.start(work.id, work.revision, work.plan_sha256)
    binding = service.store.load(work.job_id).request.open_plan
    stale = binding.model_dump(mode='json')
    stale['compiled_prompts'][0] = stale['compiled_prompts'][0].replace('Hips lead', 'Shoulders lead')
    with pytest.raises(ValidationError, match='Frozen drawing conditions'):
        PlanBinding.model_validate(stale)
    assert len(provider.requests) == before
    engine = PlanGeneration(service)
    accepted = None
    poses = final['plan']['quality']['key_poses']
    for index, stage in enumerate(work.plan.stages):
        engine.advance(work.job_id, provider, wait=True)
        request = provider.requests[before + index]
        assert request.prompt == binding.compiled_prompts[index] == stage.prompt
        assert 'drawing_poses' not in stage.model_dump(mode='json')
        assert 0 < len(request.prompt) <= 1000
        assert request.frame_count == stage.frame_count == 4
        audit = read_json(engine.directory(work.job_id, 1, index) / 'submit.intent.json')['drawing_conditions']
        rows = {row['label']: row['text'] for row in audit['rows']}
        wire_stage = final['plan']['stages'][index]
        assert len(rows) == 12
        assert rows['Appearance'] == stage.motion.appearance
        assert rows['Action'] == wire_stage['goal'] == stage.goal
        assert rows['Camera'] == stage.motion.camera
        assert rows['Facing'] == stage.motion.orientation
        assert rows['Drive'] == stage.motion.drive
        assert rows['Support'] == stage.motion.support
        assert rows['Path'] == stage.motion.trajectory
        early_pose, late_pose = poses[index * 2:index * 2 + 2]
        assert rows['Poses'] == f"f1: {early_pose['description']}; f4: {late_pose['description']}"
        assert all(pose['description'] not in request.prompt for pose in poses if pose not in (early_pose, late_pose))
        assert [pose.model_dump(mode='json') for pose in work.plan.quality.key_poses] == poses
        assert rows['Relations'] == 'Keep the visible head contour.'
        assert rows['End'] == stage.checkpoint.endpoint
        assert stage.checkpoint.rhythm in rows['Timing']
        assert stage.motion.exit in rows['Boundary']
        assert all(f'{label}: {value}' in request.prompt for label, value in rows.items())
        assert audit['version'] == 6 and audit['prompt_characters'] == len(request.prompt)
        assert audit['prompt_sha256'] == hashlib.sha256(request.prompt.encode()).hexdigest()
        assert audit['structure_sha256'] == binding.visual_structure['sha256']
        assert audit['structure_usage']['part_ids'] == ['head']
        assert audit['first_sha256'] == hashlib.sha256(request.reference_image).hexdigest()
        if index == 0:
            assert request.reference_image == reference and request.last_frame == target
            assert audit['target_mode'] == 'image'
            assert audit['last_sha256'] == hashlib.sha256(target).hexdigest()
            assert 'land low' not in request.prompt and 'Turn toward viewer.' not in request.prompt
            assert 'carry' in rows['Boundary'].lower()
            engine.advance(work.job_id, provider, wait=True)
            assert len(provider.requests) == before + 1
            accept(service, work, index, anchor_frame=2, acknowledge_trim=True)
            accepted = engine.saved_frames(work.job_id, 1, index)[2]
            assert accepted != target
        else:
            assert request.reference_image == accepted and request.last_frame is None
            assert audit['target_mode'] == 'text_only' and audit['last_sha256'] is None
            assert 'Airborne, then land low.' in request.prompt and rows['Timing'].count('3-4') == 1
            accept(service, work, index)

    finished = engine.advance(work.job_id, provider, wait=True)
    assert len(finished.candidates[0].frames) == 7
    assert len(provider.requests) == before + 2
    assert workspace.load(work.id).plan.model_dump(mode='json') == binding.plan.model_dump(mode='json')


@pytest.mark.parametrize('empty_stage', [0, 1])
def test_structured_drawing_uses_its_own_checkpoint_without_local_key_poses(setup, empty_stage):
    from sprite_pipeline.collaboration.structured_brief import StructuredCoordinatorTurn, materialize

    _, workspace, _, _, _ = setup
    work = workspace.create(spec(), uuid.uuid4().hex, planning_authorized=True)
    response, _ = StructuredConditionsPlanner()('coordinator', work, workspace.reference(work))
    other_segment_start = 4 if empty_stage == 0 else 0
    poses = response['plan']['quality']['key_poses']
    for local_frame, pose in enumerate(poses, start=1):
        pose['frame'] = other_segment_start + local_frame

    compiled = materialize(StructuredCoordinatorTurn.model_validate(response))
    plan = PlanProposal.model_validate(compiled['plan'])
    fallback_stage = plan.stages[empty_stage]
    rows = {row['label']: row for row in condition_rows(plan, empty_stage, policy_version=6)}
    assert rows['Poses']['text'] == f'f{fallback_stage.frame_count}: use End pose'
    assert 'checkpoint.endpoint' in rows['Poses']['sources']
    assert rows['End']['text'] == fallback_stage.checkpoint.endpoint
    assert all(pose['description'] not in fallback_stage.prompt for pose in poses)
    other_stage_rows = {row['label']: row['text'] for row in condition_rows(plan, 1 - empty_stage, policy_version=6)}
    assert other_stage_rows['Poses'] == '; '.join(
        f"f{local_frame}: {pose['description']}" for local_frame, pose in enumerate(poses, start=1)
    )


@pytest.mark.parametrize(('field', 'line_break', 'label'), [('goal', '\n', 'Action'), ('pose', '\u2028', 'Poses')])
def test_structured_drawing_rejects_headings_embedded_in_a_source_field(setup, field, line_break, label):
    from sprite_pipeline.collaboration.structured_brief import StructuredCoordinatorTurn, materialize

    _, workspace, _, provider, _ = setup
    work = workspace.create(spec(), uuid.uuid4().hex, planning_authorized=True)
    response, _ = StructuredConditionsPlanner()('coordinator', work, workspace.reference(work))
    valid = materialize(StructuredCoordinatorTurn.model_validate(response))
    injected_line = line_break + 'Camera: rotate the camera unexpectedly.'
    if field == 'goal':
        response['plan']['stages'][0]['goal'] += injected_line
        valid['plan']['stages'][0]['goal'] += injected_line
    else:
        response['plan']['quality']['key_poses'][0]['description'] += injected_line
        valid['plan']['quality']['key_poses'][0]['description'] += injected_line

    before = copy.deepcopy(response)
    with pytest.raises(ValidationError, match=label) as error:
        StructuredCoordinatorTurn.model_validate(response)
    assert error.value.errors(include_input=False)[0]['loc'] == ('plan', 'stages', 0)
    with pytest.raises(ValidationHarnessError, match=label):
        compile_conditions(PlanProposal.model_validate(valid['plan']), 0, policy_version=6)
    assert response == before and not provider.requests


def drawing_fixture_at_length(response, stage_index, total, *, action_length):
    plan = response['plan']
    stage = plan['stages'][stage_index]
    stage['frame_count'] = 16
    stage['motion']['boundary'] = 'pass_through'
    stage['motion']['holds'] = [
        {'start': start, 'end': start + 1, 'reason': '停' * 100} for start in (10, 12, 14)
    ]
    stage['goal'] = stage['goal'].ljust(action_length, '势')
    stage_offset = sum(previous['frame_count'] for previous in plan['stages'][:stage_index])
    local_poses = [
        {'frame': stage_offset + local_frame, 'description': description} for local_frame, description in (
            (1, 'Continue the input silhouette.'), (6, 'Draw the next motion beat.'),
            (12, 'Maintain visible equipment contact.'), (16, 'Reach the moving checkpoint.'),
        )
    ]
    neighbor_frame = 1 if stage_index else stage['frame_count'] + 4
    plan['quality']['key_poses'] = sorted(
        local_poses + [{'frame': neighbor_frame, 'description': 'Keep this pose in the other segment.'}],
        key=lambda pose: pose['frame'],
    )

    def pose_line():
        return '; '.join(f"f{pose['frame'] - stage_offset}: {pose['description']}" for pose in local_poses)

    motion, checkpoint = stage['motion'], stage['checkpoint']
    strings = {
        'Appearance': motion['appearance'], 'Action': stage['goal'], 'Camera': motion['camera'],
        'Facing': motion['orientation'], 'Drive': motion['drive'], 'Support': motion['support'],
        'Path': motion['trajectory'], 'Timing': checkpoint['rhythm'] + '; hold 10-11,12-13,14-15',
        'Poses': pose_line(), 'Relations': motion['generation_hint'], 'End': checkpoint['endpoint'],
        'Boundary': 'Continue. ' + motion['exit'],
    }
    base = '\n'.join(f'{label}: {value}' for label, value in strings.items())
    remaining = total - len(base)
    assert remaining >= 0
    for pose in local_poses:
        amount = min(remaining, 120 - len(pose['description']))
        pose['description'] += '姿' * amount
        remaining -= amount
    assert remaining == 0
    strings['Poses'] = pose_line()
    return '\n'.join(f'{label}: {value}' for label, value in strings.items())


@pytest.mark.parametrize('action_length', [258, 426])
def test_structured_drawing_shares_its_exact_character_budget(setup, action_length):
    from sprite_pipeline.collaboration.structured_brief import StructuredCoordinatorTurn, materialize

    _, workspace, _, _, _ = setup
    work = workspace.create(spec(), uuid.uuid4().hex, planning_authorized=True)
    response, _ = StructuredConditionsPlanner()('coordinator', work, workspace.reference(work))
    expected = drawing_fixture_at_length(response, 0, 1000, action_length=action_length)
    stage = response['plan']['stages'][0]
    wire_stage_fields = StructuredCoordinatorTurn.model_json_schema()['$defs']['DrawingStage']['properties']
    assert {'prompt', 'drawing_poses'}.isdisjoint(wire_stage_fields)
    assert {'goal', 'motion', 'checkpoint'} <= wire_stage_fields.keys()

    before = copy.deepcopy(response)
    materialized = materialize(StructuredCoordinatorTurn.model_validate(response))
    plan = PlanProposal.model_validate(materialized['plan'])
    prompt = compile_conditions(plan, 0, policy_version=6)
    assert len(prompt) == len(expected) == 1000 and prompt == expected
    assert len(prompt.splitlines()) == 12
    assert '停' * 100 not in prompt
    assert all(hold.reason == '停' * 100 for hold in plan.stages[0].motion.holds)
    assert response == before

    stage['goal'] += '超'
    overflow = copy.deepcopy(response)
    with pytest.raises(ValidationError, match='1001/1000') as error:
        StructuredCoordinatorTurn.model_validate(response)
    assert error.value.errors(include_input=False)[0]['loc'] == ('plan', 'stages', 0)
    assert response == overflow


def test_structured_drawing_corrects_overlong_stage_with_original_draft(setup, monkeypatch):
    from test_planning_correction import ChatFixture, observation
    from sprite_pipeline.collaboration.model_config import ModelConfiguration, ModelProfile

    service, workspace, _, provider, _ = setup
    monkeypatch.setenv('TOKENHUB_API_KEY', 'isolated-aggregate-test-key')
    workspace.model = PlanningModel(service.settings)
    workspace.model.registry.save(ModelConfiguration(default=ModelProfile(model='glm-5.3-flash')))
    work = workspace.create(spec(budget={'max_planning_calls': 5}), uuid.uuid4().hex, planning_authorized=True)
    work.generation_policy_version = 6
    workspace.save(work)
    corrected, _ = StructuredConditionsPlanner()('coordinator', work, workspace.reference(work))
    for stage in corrected['plan']['stages']:
        stage.pop('structure_usage')  # This request has no checked structure selection.
    expected = drawing_fixture_at_length(corrected, 1, 1000, action_length=258)
    rejected = copy.deepcopy(corrected)
    rejected['plan']['stages'][1]['goal'] += '超'
    strategy = copy.deepcopy(corrected['plan'])
    for stage in strategy['stages']:
        stage['prompt'] = stage['goal']
    replies = [observation(), observation(), {'action': 'propose', 'summary': '离线策略草案', 'proposal': strategy},
               rejected, corrected]
    chat = ChatFixture((json.dumps(reply, ensure_ascii=False), 'stop') for reply in replies)
    with patch('sprite_pipeline.vision_review.httpx.Client', return_value=chat):
        work = workspace.plan(work.id)

    assert work.status == 'ready', work.message
    assert work.plan.stages[1].prompt == expected and len(expected) == 1000
    assert not provider.requests and not work.job_id
    assert [call['role'] for call in work.planning_calls] == ['appearance', 'motion', 'strategy', 'coordinator', 'coordinator']
    assert work.planning_calls[-1]['corrects_call'] == 4
    invalid_call = work.planning_calls[-2]
    assert invalid_call['state'] == 'invalid_response' and invalid_call['response_id'] == 'simulated-4'
    assert len(invalid_call['validation_fields']) == 1
    repair_prompt = chat.requests[-1]['messages'][0]['content'][0]['text']
    assert '1000-character per-stage budget' in repair_prompt
    assert all(term in repair_prompt for term in ('essential action', 'stance, grip and endpoint'))
    repair = json.loads(repair_prompt.split('TASK DATA:\n', 1)[1])
    feedback = repair['validation_feedback']
    assert 'plan.stages.1' in feedback and '1001/1000' in feedback
    assert 'Action=259' in feedback and 'Poses=' in feedback and 'Timing=' in feedback
    assert repair['previous_invalid_draft'] == rejected
    assert repair['original_request']['description'] == work.spec.description
    assert '超' not in workspace.load(work.id).plan.stages[1].prompt


def test_saved_policy_five_keeps_its_original_executable_brief(setup):
    from test_executable_brief import BRIEF, BriefPlanner

    service, workspace, _, provider, _ = setup
    workspace.model = BriefPlanner()
    work = workspace.create(spec(), uuid.uuid4().hex, planning_authorized=True)
    work.generation_policy_version = 5
    workspace.save(work)
    work = workspace.plan(work.id)
    assert work.status == 'ready', work.message
    approved_plan = work.plan.model_dump(mode='json')
    approved_sha = work.plan_sha256
    work = workspace.start(work.id, work.revision, approved_sha)
    binding = service.store.load(work.job_id).request.open_plan
    PlanGeneration(service).advance(work.job_id, provider, wait=True)
    assert provider.requests[0].prompt == binding.compiled_prompts[0] == BRIEF
    assert binding.generation_policy_version == workspace.load(work.id).generation_policy_version == 5
    assert binding.plan.model_dump(mode='json') == approved_plan and binding.plan_sha256 == approved_sha
