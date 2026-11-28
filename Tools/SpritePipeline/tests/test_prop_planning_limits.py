"""N2 planning/review gates at the workspace boundary and archived plan identities."""
import json
from types import SimpleNamespace

import pytest

from test_interactable_motion import ARCHIVE, PropPlanner, checked_fixture_structure, workspace_for
from sprite_pipeline.collaboration.contracts import PlanProposal, TaskSpec, digest
from sprite_pipeline.collaboration.frame_budget import planning_limits, plan_cost
from sprite_pipeline.collaboration.prop_measurements import guard_measurements
from sprite_pipeline.errors import ConflictError, ProviderTemporaryError, ValidationHarnessError


def modified_planner(ws, item, change):
    planner = PropPlanner(item)
    class Modified:
        configured = True
        configuration = planner.configuration
        def __call__(self, role, work, reference, **kwargs):
            turn, receipt = planner(role, work, reference, **kwargs)
            if turn['action'] == 'finalize':
                change(turn['plan'], work, kwargs.get('question', ''))
            return turn, receipt
    ws.model = Modified()


def create(ws, item, **kwargs):
    spec = TaskSpec(object_type='interactable', object_id=item, description='Check actual parts and motion.',
                    provider=kwargs.pop('provider','fixture'), review_protocol='experts_v1', **kwargs)
    return ws.create(spec, 'check-new-prop-work', planning_authorized=True)


@pytest.mark.parametrize('impact,handling,ready', [
    ('impedes_motion','use_reference',False), ('changes_fixed_parts','use_reference',False),
    ('appearance_only','needs_decision',False), ('appearance_only','use_reference',True)])
def test_typed_difference_controls_release(tmp_path, impact, handling, ready):
    _,ws = workspace_for(tmp_path,'lamp')
    archive = json.loads((ARCHIVE.parent/'n2-pilot-round2-20261111/run-summary.json').read_text())
    observed = next(s for s in archive['samples'] if s['item']=='lamp' and s['seed']==1101)
    def change(plan, work, question):
        prop = plan['quality']['interactable']
        prop.update(reference_check=observed['reference_check'], fixed_parts=['所有可见紧固件'],
                    differences=[dict(description='两颗螺钉', observed='参考图可见多颗紧固件', impact=impact, handling=handling)])
    modified_planner(ws,'lamp',change)
    work = ws.plan(create(ws,'lamp').id)
    assert work.status == ('ready' if ready else 'needs_input')
    assert ws.view(work.id)['plan']['quality']['interactable']['differences'][0]['impact'] == impact
    if not ready:
        with pytest.raises(ConflictError):
            ws.start(work.id,1,work.plan_sha256)


@pytest.mark.parametrize('motion_type', ['hinge_rotation','deformation'])
def test_moving_geometry_requires_structure(tmp_path, motion_type):
    _,ws=workspace_for(tmp_path,'lever')
    modified_planner(ws,'lever',lambda plan,*_:plan['quality']['interactable'].update(motion_type=motion_type))
    work=ws.plan(create(ws,'lever').id)
    assert work.status=='needs_input' and '结构' in work.message


def test_omitted_part_returns_to_coordinator(tmp_path):
    service,ws = workspace_for(tmp_path,'lever')
    selection = checked_fixture_structure(service,'lever')
    def change(plan, work, question):
        if not question:
            plan['quality']['interactable']['fixed_parts'] = []
        else:
            assert 'support' in question
    modified_planner(ws,'lever',change)
    work = ws.plan(create(ws,'lever',visual_structure=selection).id)
    assert work.status == 'ready' and len(work.planning_calls)==5,work.message


def test_quota_rejects_12_then_accepts_8_without_extra_balance_read(tmp_path, monkeypatch):
    service,ws=workspace_for(tmp_path,'lamp')
    from sprite_pipeline.collaboration import frame_budget
    read = []
    def balance():
        read.append(True)
        return {'balance':{'subscription':{'generations':2}},'checked_at':'test'}
    monkeypatch.setattr(service,'refresh_pixellab_balance',balance)
    # Fixture transport with a real PixelLab balance snapshot; all drawing remains local.
    def fixture_limits(service, work):
        shadow = work.model_copy(update={'spec':work.spec.model_copy(update={'provider':'pixellab'})})
        return planning_limits(service, shadow)
    monkeypatch.setattr(frame_budget,'planning_limits',fixture_limits)
    def change(plan, work, question):
        assert work.frame_budget['max_frames_per_request']==8
        plan['stages'][0]['frame_count'] = 8 if question else 12
    modified_planner(ws,'lamp',change)
    work = ws.plan(create(ws,'lamp').id)
    assert work.status=='ready' and work.frame_budget['estimated_units']==2 and len(read)==1
    assert any('8 帧' in m['response'].get('summary','') for m in work.messages if m['role']=='validator')


def test_insufficient_before_first_model_and_unknown_quota(tmp_path, monkeypatch):
    service,ws=workspace_for(tmp_path,'lamp')
    work = create(ws,'lamp',provider='pixellab',budget={'max_frames_per_request':6,'max_total_frames':10})
    monkeypatch.setattr(service,'refresh_pixellab_balance',lambda:{'balance':{'subscription':{'remaining':0}}})
    stopped=ws.plan(work.id)
    assert stopped.status=='budget_exhausted' and not stopped.planning_calls
    def unavailable():
        raise ProviderTemporaryError('offline')
    monkeypatch.setattr(service,'refresh_pixellab_balance',unavailable)
    limits=planning_limits(service,work)
    assert limits['remaining_units'] is None and limits['max_frames_per_request']==6 and limits['max_total_frames']==10
    monkeypatch.setattr(service,'refresh_pixellab_balance',lambda:{'balance':{'subscription':{'generations':0},'credits':{'usd':1.25}}})
    limits=planning_limits(service,work)
    assert limits['remaining_units'] is None and limits['max_frames_per_request']==6 and limits['max_total_frames']==10


SKELETON = {'states': [{'name': name, 'appearance': name} for name in ('Off', 'Partly lit', 'On')]}


@pytest.mark.parametrize('budget,message', [({'max_total_frames': 4}, '至少需要 8 帧'),
    ({'max_generation_calls': 1}, '至少需要 2 次生成'), ({'max_review_calls': 10}, '至少需要 15 次视觉额度')])
def test_known_skeleton_fails_before_any_model_or_new_revision(tmp_path, budget, message):
    _, ws = workspace_for(tmp_path, 'lamp')
    with pytest.raises(ValidationHarnessError, match=message):
        create(ws, 'lamp', provider='pixellab', budget=budget, interactable_skeleton=SKELETON)
    assert not ws.listing() and not ws.model.calls

    original = ws.plan(create(ws, 'lamp').id)
    next_spec = TaskSpec(object_type='interactable', object_id='lamp', provider='pixellab',
                         description='Go through both lighting states', review_protocol='experts_v1',
                         budget=budget, interactable_skeleton=SKELETON)
    original_calls = len(ws.model.calls)
    with pytest.raises(ValidationHarnessError, match=message):
        ws.revise(original.id, original.revision, next_spec, 'revision-budget', planning_authorized=True)
    assert ws.load(original.id).revision == original.revision and len(ws.model.calls) == original_calls


def test_account_balance_must_cover_all_known_stages(tmp_path, monkeypatch):
    service, ws = workspace_for(tmp_path, 'lamp')
    work = create(ws, 'lamp', provider='pixellab', interactable_skeleton=SKELETON)
    enough_for_one_stage = service._pixellab_generation_units(128, 128, 4)
    monkeypatch.setattr(service, 'refresh_pixellab_balance',
                        lambda: {'balance': {'subscription': {'generations': enough_for_one_stage}}})
    result = ws.plan(work.id)
    assert result.status == 'budget_exhausted' and not result.planning_calls and not ws.model.calls


def test_total_frames_and_per_call_rounding(tmp_path):
    _,ws=workspace_for(tmp_path,'lamp')
    work=create(ws,'lamp',candidate_count=2)
    work.frame_budget={'remaining_units':5,'max_frames_per_request':8,'max_total_frames':24}
    plan=SimpleNamespace(stages=[SimpleNamespace(frame_count=6),SimpleNamespace(frame_count=6)])
    units,problem=plan_cost(work,plan)
    assert units==8 and '分别计费' in problem
    work.frame_budget['max_total_frames']=22
    assert '合计' in plan_cost(work,plan)[1]


def test_archived_plan_hash_and_clashing_review_preserved():
    folder=ARCHIVE.parent/'n2-pilot-round2-20261111'/'lever-2202'
    archived=json.loads((folder/'plan.json').read_text())
    plan=PlanProposal.model_validate(archived['plan'])
    assert digest(plan.model_dump(mode='json'))==archived['plan_sha256']
    prior={'dimension':'transition','status':'pass','confidence':.98,'frames':[1,8],'evidence':'Model pass'}
    report={'verdict':'pass','checks':[prior],'summary':'Model summary'}
    guarded=guard_measurements(report,{'flags':{'transition':[4,5,6,7,8]}})
    assert guarded['checks'][0]['status']=='uncertain' and guarded['verdict']=='uncertain'
    assert guarded['requires_human_adjudication'][0]['prior']==prior and prior['status']=='pass'
    assert '4、5、6、7、8' in guarded['summary']


@pytest.mark.parametrize('item, parts, expected', [
    ('lever', ['red_knob', 'lever_arm', 'diagonal_brace'], [4,5,6,7,8]),
    ('lamp', ['lens', 'housing'], [])])
def test_archived_native_tracking_masks(tmp_path, item, parts, expected):
    from pathlib import Path
    from PIL import Image
    from sprite_pipeline.collaboration.prop_measurements import measure_parts
    if item=='lever':
        files=sorted((ARCHIVE.parent/'n2-pilot-round2-20261111/lever-2202').glob('frame_*.png'))
        hinge=SimpleNamespace(pivot_anchor_id='pivot_pin',endpoint_part_id='red_knob')
    else:
        files=sorted((ARCHIVE/'lamp/seed-2202').glob('f*.png'))
        hinge=None
    # Consecutive 128px native tiles: reference then playback. RGB stores the
    # independent binary part masks in the order above, including overlaps.
    with Image.open(Path(__file__).parent/'fixtures/n2-tracking'/f'{item}.png') as atlas:
        assert atlas.size==(128,128*len(files))
        reference_parts=[]
        frames=[]
        for i,_ in enumerate(files):
            regions=[]
            tile=atlas.crop((0,128*i,128,128*(i+1)))
            for part,channel in zip(parts,tile.split()):
                path=tmp_path/f'{i}-{part}.png'
                channel.save(path)
                if i==0:
                    reference_parts.append(dict(id=part,mask_path=path))
                else:
                    regions.append(dict(id=part,file=path.name,state='estimated'))
            if i:
                frames.append(dict(frame_index=i-1,parts=regions))
    receipt=dict(reference={'path':files[0]},reference_parts=reference_parts,
                 source_frames=[dict(path=p) for p in files[1:]],frames=frames)
    prop=SimpleNamespace(motion_type='hinge_rotation' if hinge else 'appearance_change',
                         hinge=hinge,fixed_parts=parts[-1:],moving_parts=parts[:-1])
    cues=measure_parts(prop,{'anchors':[dict(id='pivot_pin',x=63,y=41)]},receipt,tmp_path)
    assert cues['flags']['transition']==expected
    if item=='lever':
        assert 6 in cues['flags']['fixed_parts']
        assert cues['frames'][5]['radius_px']==pytest.approx(16.38,abs=.02)
    else:
        assert not cues['flags']['fixed_parts']


def test_hinge_rotation_plane_preserves_legacy_hash_and_skips_out_of_plane_radius(tmp_path):
    from pathlib import Path
    from PIL import Image
    from sprite_pipeline.collaboration.contracts import HingeMeasurement
    from sprite_pipeline.collaboration.prop_measurements import measure_parts

    legacy_hinge = HingeMeasurement(pivot_anchor_id='pivot_pin', endpoint_part_id='red_knob')
    assert legacy_hinge.rotation_plane == 'in_plane'
    assert 'rotation_plane' not in legacy_hinge.model_dump(mode='json')

    out_of_plane_hinge = HingeMeasurement(pivot_anchor_id='pivot_pin', endpoint_part_id='red_knob', rotation_plane='out_of_plane')
    assert out_of_plane_hinge.model_dump(mode='json')['rotation_plane'] == 'out_of_plane'

    parts = ['red_knob', 'lever_arm', 'diagonal_brace']
    files = sorted((ARCHIVE.parent / 'n2-pilot-round2-20261111/lever-2202').glob('frame_*.png'))
    with Image.open(Path(__file__).parent / 'fixtures/n2-tracking/lever.png') as atlas:
        reference_parts, frames = [], []
        for i, _ in enumerate(files):
            regions = []
            tile = atlas.crop((0, 128 * i, 128, 128 * (i + 1)))
            for part, channel in zip(parts, tile.split()):
                path = tmp_path / f'{i}-{part}.png'
                channel.save(path)
                if i == 0:
                    reference_parts.append(dict(id=part, mask_path=path))
                else:
                    regions.append(dict(id=part, file=path.name, state='estimated'))
            if i:
                frames.append(dict(frame_index=i - 1, parts=regions))
    receipt = dict(reference={'path': files[0]}, reference_parts=reference_parts,
                   source_frames=[dict(path=p) for p in files[1:]], frames=frames)
    prop = SimpleNamespace(motion_type='hinge_rotation', hinge=out_of_plane_hinge,
                           fixed_parts=['diagonal_brace'], moving_parts=['red_knob', 'lever_arm'])
    cues = measure_parts(prop, {'anchors': [dict(id='pivot_pin', x=63, y=41)]}, receipt, tmp_path)
    assert cues['rotation_plane'] == 'out_of_plane' and cues['radius_check_skipped'] is True
    assert cues['reference_radius_px'] is None and cues['flags']['transition'] == []
    assert 6 in cues['flags']['fixed_parts']


def test_prop_instructions_document_hinge_rotation_plane():
    from sprite_pipeline.collaboration.planning import PROP_INSTRUCTIONS
    assert 'hinge.rotation_plane' in PROP_INSTRUCTIONS
    assert 'out_of_plane' in PROP_INSTRUCTIONS and 'in_plane' in PROP_INSTRUCTIONS
