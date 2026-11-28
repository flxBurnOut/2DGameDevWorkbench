"""Offline N2 regression. Scripted opinions exercise gates, never measure model quality."""
from dataclasses import replace
import json
import io
from PIL import Image
from pathlib import Path
from unittest.mock import patch

import pytest

from object_test_fixtures import write_interactable
from test_harness_integration import TemporaryHarness
from test_open_motion import Planner
from test_open_motion_quality import quality
from test_production_review import ExpertRegistry
from sprite_pipeline.collaboration.checkpoints import Checkpoints
from sprite_pipeline.collaboration.contracts import PROP_DIMENSIONS, TaskSpec
from sprite_pipeline.collaboration.dispute_review import Resolution
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.workspace import OpenMotionWorkspace
from sprite_pipeline.errors import ConflictError, ValidationHarnessError
from sprite_pipeline.providers.fixture import FixtureProvider
from sprite_pipeline.service import SpritePipelineService

from prop_test_art import ARCHIVE, archived, prop_action, reference_bytes


TYPES = dict(lamp='appearance_change', lever='hinge_rotation', chest='hinge_rotation', gate='occluded_rigid_translation')
REGIONS = dict(lamp=[48,35,80,62], lever=[52,92,78,103], chest=[50,86,80,98], gate=[16,60,25,90])


class PropPlanner(Planner):
    def __init__(self, item, *, blockers=False):
        super().__init__(stages=1)
        self.item, self.blockers = item, blockers

    def __call__(self, role, work, reference, **kwargs):
        response, receipt = super().__call__(role, work, reference, **kwargs)
        if role == 'coordinator':
            item = self.item
            check = dict(status='satisfied', evidence='Scripted premise evidence for the regression.')
            checks = {key: dict(check) for key in ('viewpoint', 'initial_state', 'part_ownership')}
            if self.blockers:
                checks['part_ownership' if item == 'chest' else 'viewpoint']['status'] = 'ambiguous'
            prop = dict(initial_state='Reference state', target_state='Required final state',
                        moving_parts=['working component'], fixed_parts=['mount'], motion_type=TYPES[item],
                        endpoint='Visible target reached', hold='Repeat confirmed state', hold_frames=2,
                        opaque_regions=[dict(name='protected surface', box=REGIONS[item])], reference_check=checks)
            q = quality().model_dump(mode='json')
            q.update(version=3, interactable=prop, criteria=[dict(dimension=d, criterion=d+' test') for d in PROP_DIMENSIONS])
            plan = response['plan']
            plan['requirements'][0]['evidence'] = work.spec.description[:250]
            plan['stages'][0]['acceptance'] = ['Inspect the actual endpoint and transition.']
            plan['quality'] = q
            plan['stages'][0].update(frame_count=16, prompt='Animate the working component from the reference.',
                checkpoint=dict(endpoint=prop['endpoint'], rhythm='Move to the target', reason='Inspect actual endpoint'))
            if work.visual_structure:
                from test_open_motion_refinement import motion
                prop.update(moving_parts=['tip'], fixed_parts=['support'],
                            hinge={'pivot_anchor_id':'pivot', 'endpoint_part_id':'tip'})
                q['version'] = 4
                plan['stages'][0].update(motion=motion().model_dump(mode='json'), structure_usage={
                    'part_ids':['tip', 'support'], 'anchor_ids':['pivot'], 'effect':'Use checked pivot and moving tip.'})
        return response, receipt


class ScriptedOpinions(ExpertRegistry):
    def __init__(self, item, seed):
        super().__init__()
        self.item = item
        self.clean = item == 'lamp' and seed == 2202

    def send(self, role, content, schema, count, **kwargs):
        if 'checks' not in schema.model_fields:
            return super().send(role, content, schema, count, **kwargs)
        text = content[0]['text']
        assert 'state_frame' in text and 'transition' in text and 'fixed_parts' in text
        self.calls.append((schema.__name__, text))
        rows = []
        for dimension in PROP_DIMENSIONS:
            defect = (dimension == 'transition' and not self.clean) or (dimension == 'state_frame' and self.item == 'gate')
            state_frame = 2 if self.item == 'lever' else count
            row = dict(dimension=dimension, confidence=.95, frames=[state_frame] if dimension=='state_frame' else [1,min(count,6),count],
                       evidence='Scripted frame references for a split decision.')
            if issubclass(schema, Resolution):
                row.update(classification='material_defect' if defect else 'satisfied',
                           observation='Scripted observation.', prior_claim_correction='Scripted reconciliation.')
            else:
                row['status'] = 'fail' if defect else 'pass'
            rows.append(row)
        value = dict(summary='Scripted archive review only', checks=rows)
        if 'equipment_visibility' in schema.model_fields:
            value['equipment_visibility'] = dict(items=[], summary='No disputed fixed-part visibility in this fixture.')
        return schema.model_validate(value), {'requested_model':'offline-regression'}


def workspace_for(tmp_path, item, *, blockers=False, seed=1101):
    TemporaryHarness(tmp_path)
    write_interactable(tmp_path, item)
    service = SpritePipelineService(tmp_path)
    (service.presets.object_path(item).parent / 'reference.png').write_bytes(reference_bytes(item))
    service.open_motion_model = PropPlanner(item, blockers=blockers)
    service.open_motion_review_registry = ScriptedOpinions(item, seed)
    return service, OpenMotionWorkspace(service)


def checked_fixture_structure(service, item):
    # Synthetic one-pixel labels isolate planning and source binding from SAM accuracy.
    from sprite_pipeline.collaboration.structures import VisualStructures
    from sprite_pipeline.jsonio import atomic_write_json, sha256_file
    def parser(registry, data, models, **kwargs):
        with Image.open(io.BytesIO(data)) as image:
            alpha = image.convert('RGBA').getchannel('A')
            points = [(x, y) for y in range(image.height) for x in range(image.width) if alpha.getpixel((x,y)) == 255]
        parts = [dict(id=name, name=name, kind='other', points=[dict(x=x, y=y, label=1)])
                 for name,(x,y) in zip(['tip','support'], [points[0], points[-1]])]
        x,y = points[-1]
        return dict(summary='Fixture structure', parts=parts, anchors=[dict(id='pivot', name='pivot',
                    part_id='support', x=x, y=y, state='visible')]), {}
    def segment(source, parts, output):
        output.mkdir()
        masks = []
        for part in parts:
            im = Image.new('L', (128,128))
            im.putpixel(tuple(map(int, part['points'][0])), 255)
            path = output / (part['id'] + '.png')
            im.save(path)
            masks.append(dict(id=part['id'], file=path.name, sha256=sha256_file(path), area=1))
        return dict(source_sha256=sha256_file(source), parts=masks)
    def track(job):
        output = Path(job['output'])
        output.mkdir()
        frames = []
        for index, frame in enumerate(job['frames']):
            parts = []
            for region in job['parts']:
                src = Path(region['mask_path'])
                path = output / f"{index}-{region['id']}.png"
                path.write_bytes(src.read_bytes())
                parts.append(dict(id=region['id'], file=path.name, sha256=sha256_file(path), area=1,
                                  state='estimated', centroid=None, box=None, axis_degrees_mod_180=None))
            frames.append(dict(frame_index=index, source_sha256=frame['sha256'], time_seconds=index/job['fps'], parts=parts))
        receipt = dict(operation='track', fps=job['fps'], reference=job['reference'], source_frames=job['frames'],
                       reference_parts=job['parts'], corrections=[], frames=frames, width=128, height=128,
                       tracking_policy=job['tracking_policy'], context_frame_count=1, context_excluded_from_playback=True)
        atomic_write_json(output/'receipt.json', receipt)
        return receipt
    service.structure_parser, service.structure_segmenter, service.structure_tracker = parser, segment, track
    structures = VisualStructures(service)
    pending = structures.create(item, 'fixture-structure-'+item, authorized=True)
    structures.run(pending['id'])
    v = structures.view(pending['id'])
    v = structures.correct(v['id'], v['revision'], v['document']['token'], 'confirm-fixture',
                           note='Confirm scripted fixture regions', confirm=True)
    return dict(analysis_id=v['id'], token=v['document']['token'])


def plan(ws, item, auto=False, selection=None):
    spec = TaskSpec(object_type='interactable', object_id=item, provider='fixture',
        description=prop_action(item), review_protocol='experts_v1', visual_structure=selection)
    w = ws.create(spec,'archive-plan-'+item,planning_authorized=True,auto_execute=auto)
    return ws.plan(w.id)


@pytest.mark.parametrize('item', ['chest','gate'])
def test_reference_mismatch_blocks_even_auto_execution(tmp_path, item):
    service, ws = workspace_for(tmp_path, item, blockers=True)
    work = plan(ws, item, auto=True)
    assert work.status == 'needs_input' and not work.job_id and not service.list_jobs()
    with pytest.raises(ConflictError):
        ws.start(work.id, 1, work.plan_sha256, allow_unsupported_motion=True)


@pytest.mark.parametrize('item', list(TYPES))
@pytest.mark.parametrize('seed', [1101,2202])
@archived
def test_saved_sequences_replay_through_checkpoint_and_review(tmp_path, item, seed):
    service, ws = workspace_for(tmp_path, item, seed=seed)
    selection = checked_fixture_structure(service,item) if TYPES[item] == 'hinge_rotation' else None
    work = plan(ws, item, auto=item=='gate', selection=selection)
    assert work.status == 'ready' and not work.job_id, work.message
    work.visibility_review_version = 4
    ws.save(work)
    if item == 'gate':
        with pytest.raises(ValidationHarnessError,match='不适合'):
            ws.start(work.id,1,work.plan_sha256)
    frames = [p.read_bytes() for p in sorted((ARCHIVE/item/f'seed-{seed}').glob('f*.png'))]
    assert len(frames) == 17
    provider = FixtureProvider()
    provider.diagnostic_only = False
    original_submit = provider.submit
    edits = {}
    def submit(request):
        receipt = original_submit(request)
        if request.edit_frames:
            edits[receipt.provider_job_id] = list(request.edit_frames)
        return replace(receipt, diagnostic_only=False)
    provider.submit = submit
    original_wait = provider.wait
    def archive_wait(identity):
        return replace(original_wait(identity), images=edits.get(identity, frames), diagnostic_only=False)
    provider.wait = archive_wait
    with patch('sprite_pipeline.providers.get_provider', return_value=provider):
        work = ws.start(work.id,1,work.plan_sha256,allow_unsupported_motion=item=='gate')
    engine = PlanGeneration(service)
    engine.advance(work.job_id, provider, wait=True)
    checkpoints = Checkpoints(service)
    view = checkpoints.view(work.job_id,1,0)
    assert view['context_removed'] and len(view['frames']) == 16
    report = view['review']
    assert report['state'] == 'complete', report.get('summary')
    if selection:
        assert len(report['motion_evidence']['tracked_parts']['frames']) == 16
        assert report['motion_evidence']['tracked_parts']['revision'] == 1
    clean = item == 'lamp' and seed == 2202
    assert [c['status'] for c in report['checks']] == [
        'fail' if item == 'gate' else 'pass', 'pass' if clean else 'fail', 'pass']
    assert len(report['requests']) == (4 if clean else 5)
    if item in ('gate', 'chest'):
        checkpoints.decide(work.job_id,1,0,decision='reject',token=view['token'],note='Regression rejection retained.')
        assert not service.store.load(work.job_id).plan_control.enabled
        return
    if item == 'lamp':
        losses = [c for c in report['motion_evidence']['alpha_changes'] if c['lost_pixels'] > 300]
        if seed == 1101:
            assert [c['frame'] for c in losses] == [6]  # f07.png includes the extra input at f01.
        else:
            assert not losses
    end = 1 if item == 'lever' else 15
    args = dict(token=view['token'], note='Scripted decision on these exact bytes.',anchor_frame=end)
    for _ in range(2):
        checkpoints.decide(work.job_id,1,0,decision='accept_state',**args)
    view = checkpoints.view(work.job_id,1,0)
    assert view['state']=='awaiting_review' and view['state_checkpoint']['sha256']==view['frames'][end]['sha256']
    assert not service.store.load(work.job_id).plan_control.enabled
    with pytest.raises(ConflictError, match='锚点'):
        checkpoints.decide(work.job_id,1,0,decision='accept',**{**args,'anchor_frame':2},acknowledge=True,acknowledge_trim=True)
    if item == 'lamp' and not clean:
        from sprite_pipeline.collaboration.repairs import LocalRepairs
        repairs = LocalRepairs(service)
        repair = dict(token=view['token'], note='Fixture echo of the interior editing slots.',
                      mode='appearance',request_key='lamp-window',authorized=True,provider=provider)
        with pytest.raises(ValidationHarnessError,match='状态帧'):
            repairs.create(work.job_id,1,0,start=14,end=15,**repair)
        repairs.create(work.job_id,1,0,start=4,end=5,**repair)
        engine.advance(work.job_id,provider,wait=True)
        preview = checkpoints.view(work.job_id,1,0)['repairs'][0]
        repairs.decide(work.job_id,1,0,0,preview['token'],'Exercise adoption in temporary workspace.','accept')
        engine.advance(work.job_id,provider,wait=True)
        updated = checkpoints.view(work.job_id,1,0)
        assert updated['state_checkpoint'] == view['state_checkpoint']
        assert updated['token'] != view['token'] and updated['state'] == 'awaiting_review'
        assert updated['review']['verdict'] == 'fail' and not updated['accepted']
        assert engine.saved_frames(work.job_id,1,0) == frames
        return
    checkpoints.decide(work.job_id,1,0,decision='accept',**args,acknowledge=True,acknowledge_trim=True)
    job = engine.advance(work.job_id,provider,wait=True)
    execution = job.candidates[0].plan_execution
    assert execution.timeline[0]['hold_frames'] == 2 and execution.actual_frame_count == end + 3
    assert [m['raw_frame'] for m in execution.frame_mapping] == list(range(1,end+2)) + [end+1,end+1]
    assert execution.quality_review['state'] == 'complete', execution.quality_review


def test_production_prop_planning_prompt_and_wire_schema(tmp_path):
    from sprite_pipeline.collaboration.contracts import motion_transport_schema, CoordinatorTurn, CHARACTER_DIMENSIONS
    from sprite_pipeline.collaboration.planning import PlanningModel
    from sprite_pipeline.collaboration.structured_brief import StructuredCoordinatorTurn
    service, ws = workspace_for(tmp_path, 'lamp')
    work = ws.create(TaskSpec(object_id='lamp', object_type='interactable', description='Turn on the green light.'),
                     'production-prop-planning',planning_authorized=True)
    work.frame_budget = dict(max_frames_per_request=8, max_total_frames=8, remaining_units=2, estimated_units=None)
    model = PlanningModel(service.settings)
    def send(role, content, schema, count, **kwargs):
        assert kwargs['interactable'] is True
        prompt = content[0]['text']
        assert '"hard_drawing_limits": {"max_frames_per_request": 8' in prompt
        for fact in ('reference_check', 'part_ownership', 'hold_frames', 'state_frame', 'EXECUTABLE DRAWING BRIEF policy 6'):
            assert fact in prompt
        assert schema is StructuredCoordinatorTurn
        stage_fields = schema.model_json_schema()['$defs']['DrawingStage']['properties']
        assert 'goal' in stage_fields and {'prompt', 'drawing_poses'}.isdisjoint(stage_fields)
        return schema.model_validate({'action':'consult','summary':'Check viewpoint','target':'appearance','question':'Is the lens visible?'}), {}
    model.registry.send = send
    model('coordinator', work, ws.reference(work))
    for coordinator in (CoordinatorTurn, StructuredCoordinatorTurn):
        for typed, dimensions in [(True,PROP_DIMENSIONS),(False,CHARACTER_DIMENSIONS)]:
            wire = motion_transport_schema(coordinator, typed).model_json_schema()['$defs']
            assert wire['QualityCriterion']['properties']['dimension']['enum'] == list(dimensions)
            assert ('interactable' in wire['MotionQuality']['properties']) == typed


def test_uploaded_prop_reference_is_typed_idempotent_and_starts_no_work(tmp_path):
    import base64
    from fastapi.testclient import TestClient
    from sprite_pipeline.api_app import create_api

    service, _ = workspace_for(tmp_path, 'lamp')
    client = TestClient(create_api(service=service))
    source = reference_bytes('lamp')
    body = {
        'object_type': 'interactable', 'display_name': 'Signal lamp', 'identity_description': 'Fixed rim',
        'confirmation': 'Checked the initial state',
        'png_base64': base64.b64encode(source).decode(),
    }
    endpoint = '/v1/open-motion/references'
    assert client.post(endpoint, json={**body, 'confirmation': ''}).status_code == 422
    created = client.post(endpoint, json=body)
    assert created.status_code == 200, created.text
    identity = created.json()['object']['id']
    assert created.json()['object']['object_type'] == 'interactable'
    assert client.post(endpoint, json=body).json() == created.json()
    assert client.get(endpoint + '/' + identity).content == source
    assert service.presets.object_provenance(identity)['providerCalled'] is False
    assert client.get('/v1/open-motion').json()['works'] == []
