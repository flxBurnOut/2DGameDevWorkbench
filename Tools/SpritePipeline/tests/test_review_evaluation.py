"""Shadow review must never mutate production or hide errors as abstentions."""
import hashlib
import json
from pathlib import Path

import pytest
from PIL import Image

from sprite_pipeline.collaboration.review_evaluation import (
    ReviewEvidence, ReviewExperiment, score_reviews, comparison_gate, DIMENSIONS,
)
from sprite_pipeline.collaboration.review_inputs import observation_content, audit_content
from sprite_pipeline.collaboration.model_config import ModelProfile
from sprite_pipeline.collaboration.visual_review import Observations
from sprite_pipeline.errors import ConflictError, ValidationHarnessError


@pytest.fixture
def evidence(tmp_path):
    source = tmp_path/'production'
    source.mkdir()
    paths=[]
    for i in range(4):
        p=source/f'{i}.png'
        Image.new('RGBA',(64,64),(30+i*10,40,50,255)).save(p)
        paths.append(p)
    return ReviewEvidence.create(tmp_path/'evidence',paths=paths,reference=paths[0],fps=12,
        context={'user_request':'摘帽后鞠躬，结束保持低头'},source={'kind':'test'})


class Registry:
    def __init__(self, fail=False):self.calls=[];self.fail=fail
    def profile(self,*_):return ModelProfile()
    def send(self,role,content,schema,count,**kwargs):
        self.calls.append(content)
        if self.fail:raise TimeoutError('unknown; never retry')
        value=({'reference_equipment':'一顶帽子','frames':[{'frame':i,'pose':'逐渐鞠躬','equipment':'一顶帽子','change':'连续变化'} for i in range(1,count+1)]} if schema is Observations else
               {'summary':'检查真实图片','checks':[{'dimension':d,'status':'pass','confidence':.9,'frames':[1,2,count],'evidence':'实际首中末连续画面'} for d in DIMENSIONS]})
        return schema.model_validate(value),{'usage':{'total_tokens':10},'response_id':'fixture'}


def hashes(root):
    return {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}


def test_authorization_and_readonly_repeat(evidence,tmp_path):
    registry=Registry();before=hashes(tmp_path/'production')
    runner=ReviewExperiment(registry,evidence,tmp_path/'baseline',snapshot={})
    with pytest.raises(ValidationHarnessError):runner.run()
    assert not registry.calls
    result=runner.run(authorized=True)
    assert result['state']=='complete' and result['advisory_only']
    assert len(registry.calls)==2
    assert runner.run(authorized=True)==result and len(registry.calls)==2
    assert before==hashes(tmp_path/'production')


def test_no_label_leak_or_unknown_retry(evidence,tmp_path):
    registry=Registry(fail=True)
    runner=ReviewExperiment(registry,evidence,tmp_path/'unknown',snapshot={})
    result=runner.run(authorized=True)
    assert result['state']=='failed' and result['requests'][0]['state']=='failed_or_unknown'
    runner.run(authorized=True)
    assert len(registry.calls)==1
    assert '"labels":' not in json.dumps(registry.calls)
    with pytest.raises(ValidationHarnessError):
        ReviewEvidence.create(tmp_path/'leak',paths=evidence.paths,reference=evidence.paths[0],fps=12,
            context={'labels':{'equipment':'fail'}},source={})


def test_modified_pixels_and_contract_rejected(evidence,tmp_path):
    evidence.paths[0].write_bytes(b'changed')
    with pytest.raises(ConflictError):evidence.pictures()
    manifest=evidence.manifest.copy();manifest['context']={'user_request':'changed'}
    (evidence.folder/'evidence.json').write_text(json.dumps(manifest),encoding='utf-8')
    with pytest.raises(ConflictError):ReviewEvidence(evidence.folder)


def test_in_memory_input_mutation_is_also_rejected(evidence):
    evidence.manifest['context']['user_request']='Changed after freezing'
    with pytest.raises(ConflictError):evidence.verify()


def test_uncertainty_cannot_disguise_misses_and_false_alarms():
    labels={'case':{d:{'status':s} for d,s in zip(DIMENSIONS,['pass','fail','uncertain'])}}
    def report(states):return {'case':{'state':'complete','checks':[{'dimension':d,'status':s,'confidence':.95} for d,s in zip(DIMENSIONS,states)]}}
    baseline=score_reviews(labels,report(['pass','fail','uncertain']))
    uncertain=score_reviews(labels,report(['uncertain']*3))
    assert uncertain['totals']['false_positive']==uncertain['totals']['false_negative']==0
    assert uncertain['totals']['missed_defects']==uncertain['totals']['unnecessary_blocks']==1
    gate=comparison_gate(baseline,uncertain,sources_unchanged=True)
    assert not gate['can_advance'] and 'missed_defects' in gate['regressions']
    assert not comparison_gate(baseline,baseline,sources_unchanged=False)['can_advance']


def test_fixed_baseline_prompts_are_shared():
    assert observation_content([],segment=True)[0]['text'].startswith('Describe EVERY labelled actual frame')
    assert observation_content([])[0]['text'].startswith('Record EVERY actual frame')
    assert 'Inspect this segment ONLY' in audit_content([],{},12,segment=True)[0]['text']
    assert '0.08333333333333333 seconds' in audit_content([],{},12)[0]['text']
    assert 'Do not impose attack phases' in audit_content([],{},12)[0]['text']


def test_experts_are_blind_and_same_cost(evidence,tmp_path):
    class IndependentRegistry(Registry):
        def send(self,*args,**kwargs):
            result,receipt=super().send(*args,**kwargs)
            result.summary='PRIVATE_FIRST_OPINION'
            result.checks[0].evidence='PRIVATE_FIRST_EVIDENCE'
            return result,receipt
    registry=IndependentRegistry();before=hashes(tmp_path/'production')
    result=ReviewExperiment(registry,evidence,tmp_path/'experts',snapshot={}).run(mode='independent',authorized=True)
    assert len(registry.calls)==2 and result['state']=='complete'
    assert 'PRIVATE_FIRST_' not in json.dumps(registry.calls[1])
    assert set(result['experts'])=={'appearance','motion'}
    assert not result['disputes'] and result['verdict']=='pass'
    assert before==hashes(tmp_path/'production')


def test_disagreement_is_not_majority_or_one_expert_veto():
    from sprite_pipeline.collaboration.independent_review import consensus
    def opinion(status):return {'checks':[{'dimension':d,'status':status,'confidence':.95,'frames':[1,2,3],'evidence':'实际有序帧证据'} for d in DIMENSIONS]}
    result=consensus({'appearance':opinion('fail'),'motion':opinion('pass')},4)
    assert result['verdict']=='uncertain' and len(result['disputes'])==3
    assert all(c['status']=='uncertain' for c in result['checks'])


def test_native_snapshot_never_changes_decisions_or_generation_budget(tmp_path):
    from test_harness_integration import TemporaryHarness
    from sprite_pipeline.service import SpritePipelineService
    from sprite_pipeline.collaboration.workspace import OpenMotionWorkspace
    from test_open_motion import Planner, Provider
    from test_open_motion_quality import generated
    from sprite_pipeline.collaboration.review_sources import snapshot_review
    from sprite_pipeline.collaboration.visual_review import frame_digest
    fixture=TemporaryHarness(tmp_path/'native')
    service=SpritePipelineService(fixture.root)
    planner=Planner();service.open_motion_model=planner
    provider=Provider(fixture)
    from unittest.mock import patch
    with patch('sprite_pipeline.providers.get_provider',return_value=provider):
        _,job_id,_=generated((service,OpenMotionWorkspace(service),planner,provider,fixture))
    record=service.store.job_dir(job_id)/'job.json'
    before=record.read_bytes();calls=len(provider.requests)
    token=frame_digest(service.store.load(job_id).candidates[0])
    copied=snapshot_review(service,job_id,1,tmp_path/'copied',expected_token=token)
    ReviewExperiment(Registry(),copied,tmp_path/'native-report',snapshot={}).run(mode='independent',authorized=True)
    assert record.read_bytes()==before and len(provider.requests)==calls
    with pytest.raises(ConflictError):
        snapshot_review(service,job_id,1,tmp_path/'stale',expected_token='0'*64)


def test_additional_experts_cannot_mask_baseline_findings(evidence,tmp_path):
    from sprite_pipeline.collaboration.independent_review import attach_opinions
    baseline=ReviewExperiment(Registry(),evidence,tmp_path/'b',snapshot={}).run(authorized=True)
    independent=ReviewExperiment(Registry(),evidence,tmp_path/'i',snapshot={}).run(mode='independent',authorized=True)
    baseline['checks'][0].update(status='fail',confidence=.9)
    independent['experts']['appearance']['checks'][1].update(status='fail',confidence=.99)
    merged=attach_opinions(baseline,independent)
    assert merged['checks']==baseline['checks']  # Neither mask nor veto.
    assert merged['baseline_preserved'] and len(merged['disputes'])==2
    assert len(merged['requests'])==4 and merged['extra_calls']==2
    independent['evidence_token']='changed'
    with pytest.raises(ConflictError):attach_opinions(baseline,independent)


def test_bounded_dispute_and_no_changes_outside_disputed_dimensions(evidence,tmp_path):
    from sprite_pipeline.collaboration.independent_review import attach_opinions
    from sprite_pipeline.collaboration.dispute_review import Resolution,focus_frames
    baseline=ReviewExperiment(Registry(),evidence,tmp_path/'b',snapshot={}).run(authorized=True)
    independent=ReviewExperiment(Registry(),evidence,tmp_path/'i',snapshot={}).run(mode='independent',authorized=True)
    baseline['checks'][0].update(status='fail',confidence=.9)
    merged=attach_opinions(baseline,independent)
    class Resolver(Registry):
        def send(self,role,content,schema,count,**kwargs):
            self.calls.append(content)
            assert schema is Resolution
            return schema.model_validate({'summary':'通过实际帧核对争议','checks':[{
                'dimension':d,'confidence':.95,
                'frames':[1,2,count],'evidence':'实际首中末姿势支持本次结论',
                'classification':'satisfied' if d=='completeness' else 'material_defect',
                'observation':'逐帧检查实际画面','prior_claim_correction':'原报告错误；说明实际区别'} for d in DIMENSIONS]}),{}
    resolver=Resolver();runner=ReviewExperiment(resolver,evidence,tmp_path/'resolved',snapshot={},max_calls=1)
    result=runner.resolve(merged,authorized=True)
    assert result['state']=='complete' and len(resolver.calls)==1
    assert [c['status'] for c in result['checks']]==['uncertain','pass','pass']
    assert result['requires_human_adjudication'][0]['proposal']['status']=='pass'
    assert result['requires_human_adjudication'][0]['prior']['status']=='fail'
    assert result['focus']['frames']==[1,2,3,4]
    assert runner.resolve(merged,authorized=True)==result and len(resolver.calls)==1
    assert len(focus_frames([{'frames':list(range(1,65))}],64))<=12
    merged['checks'][0]['confidence']=.8
    with pytest.raises(ConflictError):runner.resolve(merged,authorized=True)


def test_no_dispute_means_no_extra_paid_request(evidence,tmp_path):
    from sprite_pipeline.collaboration.independent_review import attach_opinions
    baseline=ReviewExperiment(Registry(),evidence,tmp_path/'b',snapshot={}).run(authorized=True)
    independent=ReviewExperiment(Registry(),evidence,tmp_path/'i',snapshot={}).run(mode='independent',authorized=True)
    registry=Registry(fail=True)
    result=ReviewExperiment(registry,evidence,tmp_path/'r',snapshot={},max_calls=1).resolve(attach_opinions(baseline,independent),authorized=True)
    assert result['state']=='complete' and not registry.calls


def test_dispute_failure_never_retries_or_erases_parent(evidence,tmp_path):
    from sprite_pipeline.collaboration.independent_review import attach_opinions
    baseline=ReviewExperiment(Registry(),evidence,tmp_path/'b',snapshot={}).run(authorized=True)
    independent=ReviewExperiment(Registry(),evidence,tmp_path/'i',snapshot={}).run(mode='independent',authorized=True)
    baseline['checks'][0]['status']='fail'
    parent=attach_opinions(baseline,independent);frozen=json.dumps(parent,sort_keys=True)
    registry=Registry(fail=True);runner=ReviewExperiment(registry,evidence,tmp_path/'r',snapshot={},max_calls=1)
    result=runner.resolve(parent,authorized=True)
    assert result['state']=='failed' and result['requests'][0]['state']=='failed_or_unknown'
    runner.resolve(parent,authorized=True)
    assert len(registry.calls)==1 and json.dumps(parent,sort_keys=True)==frozen


def test_acceptance_cannot_drop_cases_or_relabel_after_seeing_models():
    labels={'case':{d:{'status':'pass'} for d in DIMENSIONS}}
    before=score_reviews(labels,{})
    changed=score_reviews({'case':{d:{'status':'uncertain'} for d in DIMENSIONS}}, {})
    assert 'changed_labels' in comparison_gate(before,changed,sources_unchanged=True)['regressions']
    assert 'changed_coverage' in comparison_gate(before,score_reviews({},{}),sources_unchanged=True)['regressions']


@pytest.mark.parametrize('index',[-1,0,65])
def test_invalid_frame_evidence_never_becomes_a_pass(index):
    from sprite_pipeline.collaboration.review_evaluation import validated_audit
    from sprite_pipeline.collaboration.visual_review import Audit
    result=Audit.model_validate({'summary':'未经核对的声明','checks':[
        {'dimension':d,'status':'pass','confidence':.99,'frames':[index,1,2],'evidence':'未提供帧不能成为证据'} for d in DIMENSIONS]})
    with pytest.raises(ValidationHarnessError):validated_audit(result,4)


def test_developer_cli_read_is_free_and_paid_commands_require_authorization(evidence,tmp_path):
    from sprite_pipeline.collaboration.review_cli import main
    result=main(['inspect','--evidence',str(evidence.folder)])
    assert result['frames']==4 and not result['provider_called']
    with pytest.raises(ValidationHarnessError):
        main(['independent','--evidence',str(evidence.folder),'--output',str(tmp_path/'paid')])
    assert not (tmp_path/'paid').exists()


def test_score_reviews_supports_interactable_dimensions_and_counterfactual_checks():
    from sprite_pipeline.collaboration.contracts import PROP_DIMENSIONS
    from sprite_pipeline.collaboration.experiment import counterfactual_verdicts
    from sprite_pipeline.collaboration.prop_measurements import guard_measurements

    labels = {'lever': {'state_frame': {'status': 'pass'}, 'transition': {'status': 'fail'}, 'fixed_parts': {'status': 'pass'}}}
    base_checks = [
        {'dimension': 'state_frame', 'status': 'pass', 'confidence': .95, 'frames': [1, 8], 'evidence': 'ok'},
        {'dimension': 'transition', 'status': 'pass', 'confidence': .95, 'frames': [1, 4, 8], 'evidence': 'ok'},
        {'dimension': 'fixed_parts', 'status': 'pass', 'confidence': .95, 'frames': [1, 4, 8], 'evidence': 'ok'},
    ]
    report = {'state': 'complete', 'verdict': 'pass', 'checks': base_checks}
    guarded = guard_measurements(report, {'flags': {'transition': [4, 5, 6]}})
    ablation = counterfactual_verdicts(guarded)

    full_score = score_reviews(labels, {'lever': {'state': 'complete', 'checks': ablation['checks_by_condition']['full']}})
    no_probe_score = score_reviews(labels, {'lever': {'state': 'complete', 'checks': ablation['checks_by_condition']['without_probes']}})
    assert [r['dimension'] for r in full_score['rows']] == list(PROP_DIMENSIONS)
    assert full_score['totals']['false_negative'] == 0 and full_score['totals']['abstentions'] == 1
    assert no_probe_score['totals']['false_negative'] == 1 and no_probe_score['totals']['abstentions'] == 0
