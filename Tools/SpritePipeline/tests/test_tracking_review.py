"""Structural evidence never changes frozen baseline input or native artwork."""
import copy
from pathlib import Path
import pytest

from test_structure_tracking import data,structure
from test_production_review import ExpertRegistry
from sprite_pipeline.collaboration.contracts import digest
from sprite_pipeline.collaboration.review_evaluation import ReviewEvidence,ReviewExperiment
from sprite_pipeline.collaboration.tracking_review import StructuredReviewEvidence
from sprite_pipeline.collaboration.independent_review import expert_content,attach_opinions
from sprite_pipeline.errors import ConflictError,ValidationHarnessError
from sprite_pipeline.jsonio import atomic_write_json


@pytest.fixture
def evidence(data,tmp_path):
    job,receipt,folder=data
    atomic_write_json(tmp_path/'job.json',job);atomic_write_json(folder/'receipt.json',receipt)
    atomic_write_json(tmp_path/'structure.json',structure())
    base=ReviewEvidence.create(tmp_path/'review-input',paths=[f['path'] for f in job['frames']],
        reference=job['reference']['path'],fps=12,context={'user_request':'诊断序列，仅测试证据绑定'},source={'fixture':True})
    enhanced=StructuredReviewEvidence(base,job_path=tmp_path/'job.json',receipt_path=folder/'receipt.json',
        reference_structure_path=tmp_path/'structure.json')
    return base,enhanced,tmp_path


def test_baseline_images_and_context_are_byte_equivalent(evidence):
    base,enhanced,folder=evidence
    assert base.token==enhanced.token
    assert base.context()==enhanced.context()
    assert base.pictures()==enhanced.pictures()
    original=expert_content(base,'appearance');supplemented=expert_content(enhanced,'appearance')
    assert original[1:]==supplemented[1:]
    assert 'visual_structure' not in original[0]['text'] and 'visual_structure' in supplemented[0]['text']
    registry=ExpertRegistry()
    with pytest.raises(ValidationHarnessError):ReviewExperiment(registry,enhanced,folder/'baseline',snapshot={}).run(mode='baseline',authorized=True)
    assert not registry.calls


def test_structural_version_cannot_reuse_an_old_opinion(evidence):
    base,enhanced,folder=evidence;registry=ExpertRegistry();snapshot={'fixture':'same model'}
    baseline=ReviewExperiment(registry,base,folder/'baseline',snapshot=snapshot).run(mode='baseline',authorized=True)
    original=digest(baseline)
    report=ReviewExperiment(registry,enhanced,folder/'independent',snapshot=snapshot).run(mode='independent',authorized=True)
    assert report['structure_binding']==enhanced.structure_binding
    assert digest(baseline)==original
    combined=attach_opinions(baseline,report)
    assert combined['structure_binding']==enhanced.structure_binding
    changed=structure();changed['parts'][0]['name']='另一观察名称'
    atomic_write_json(folder/'other-structure.json',changed)
    other=StructuredReviewEvidence(base,job_path=folder/'job.json',receipt_path=enhanced.receipt_path,
        reference_structure_path=folder/'other-structure.json')
    count=len(registry.calls)
    with pytest.raises(ConflictError):ReviewExperiment(registry,other,folder/'independent',snapshot=snapshot).run(mode='independent',authorized=True)
    with pytest.raises(ConflictError):ReviewExperiment(registry,other,folder/'dispute',snapshot=snapshot,max_calls=1).resolve(combined,authorized=True)
    assert len(registry.calls)==count


def test_current_guard_and_mask_change_invalidate_evidence(evidence):
    base,enhanced,folder=evidence
    with pytest.raises(ConflictError):StructuredReviewEvidence(base,job_path=folder/'job.json',receipt_path=enhanced.receipt_path,
        reference_structure_path=folder/'structure.json',current_guard=lambda:False)
    (folder/'tracked/0-body.png').write_bytes(b'changed mask')
    with pytest.raises(ConflictError):enhanced.verify()


def test_unknown_geometry_is_withheld_from_model_but_raw_prediction_is_kept(evidence):
    base,enhanced,folder=evidence
    from sprite_pipeline.jsonio import read_json
    receipt=read_json(enhanced.receipt_path)
    receipt['frames'][0]['parts'][0].update(state='unknown',area=256,box=[0,0,16,16],centroid=[8,8],axis_degrees_mod_180=90)
    atomic_write_json(enhanced.receipt_path,receipt)
    current=StructuredReviewEvidence(base,job_path=enhanced.job_path,receipt_path=enhanced.receipt_path,
        reference_structure_path=enhanced.reference_structure_path)
    observed=current.structure_context()['material_region_estimates'][0]['parts'][0]
    assert observed['state']=='unknown'
    assert observed['box'] is None and observed['area'] is None and observed['axis_degrees_mod_180'] is None
    assert read_json(enhanced.receipt_path)['frames'][0]['parts'][0]['box']==[0,0,16,16]
    assert current.structure_binding['version']==3
    assert current.context()==base.context() and current.pictures()==base.pictures()


@pytest.mark.parametrize('basis,quote,expected',[
    ('explicit_user_requirement','诊断序列','fail'),
    ('explicit_user_requirement','禁止一切停顿','uncertain'),
    ('planner_preference','','uncertain'),
    ('reference_continuity','','fail'),
    ('visible_event_discontinuity','','fail'),
])
def test_structural_judgment_preserves_source_requirements_and_real_defects(evidence,basis,quote,expected):
    from sprite_pipeline.collaboration.structure_judgment import StructureResolution,apply_structure_resolution
    base,enhanced,folder=evidence
    prior={'mode':'augmented','checks':[{'dimension':d,'status':'pass','confidence':.95,'frames':[1,2,4],'evidence':'诊断中的旧结论'} for d in ('completeness','equipment','rhythm')],
        'disputes':[{'dimension':'rhythm'}]}
    result=StructureResolution.model_validate({'summary':'依据来源核对，不凭规划偏好判错','checks':[
        {'dimension':d,'classification':'material_defect' if d=='rhythm' else 'satisfied','confidence':.95,
         'frames':[1,2,4],'evidence':'诊断中的可见变化与依据','observation':'引用诊断帧连续顺序','prior_claim_correction':'对比旧说法并保留不确定性',
         'basis':basis,'requirement_quote':quote} for d in ('completeness','equipment','rhythm')]})
    reviewed=apply_structure_resolution(prior,result,enhanced)
    assert reviewed['checks'][2]['status']==expected
    assert reviewed['source_resolution']['checks'][2]['classification']=='material_defect'
    assert prior['checks'][2]['status']=='pass'
