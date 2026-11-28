"""Formal review integration: cost, history, stale evidence and human decisions."""
import copy
import hashlib
import uuid
from dataclasses import replace
from unittest.mock import patch

import pytest

from test_open_motion import setup, spec
from test_open_motion_checkpoints import CheckpointPlanner, accept
from sprite_pipeline.collaboration.contracts import TaskSpec, PlanBinding, digest
from sprite_pipeline.collaboration.checkpoints import Checkpoints, review_call_count
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.visual_review import Observations, Audit
from sprite_pipeline.collaboration.dispute_review import Resolution
from sprite_pipeline.collaboration.model_config import ModelProfile
from sprite_pipeline.collaboration.repairs import LocalRepairs
from sprite_pipeline.errors import ConflictError, ValidationHarnessError, ExportBlockedError


class ExpertRegistry:
    def __init__(self, fail_at=None, after_send=None):
        self.calls=[];self.fail_at=fail_at;self.after_send=after_send

    def profile(self,*_):return ModelProfile(model='fixture-visual-model')

    def send(self,role,content,schema,count,**kwargs):
        text=content[0]['text'];self.calls.append((schema.__name__,text))
        if len(self.calls)==self.fail_at:raise TimeoutError('fixture unknown request')
        if self.after_send:self.after_send(len(self.calls))
        if schema is Observations:
            value={'reference_equipment':'一件原有物品','frames':[{'frame':i,'pose':'可见姿势逐渐变化','equipment':'同一件物品','change':'前后帧连续'} for i in range(1,count+1)]}
        elif issubclass(schema,Resolution):
            value={'summary':'复核区分明确问题和可选优化','checks':[{
                'dimension':d,'classification':'preference' if d=='rhythm' else 'satisfied',
                'confidence':.95,'frames':[1,2,count],'evidence':'按实际帧核对任务及局部连续性',
                'observation':'实际帧的阶段与运动可辨认','prior_claim_correction':'原有判断偏保守，实际画面需要人工确认'} for d in ('completeness','equipment','rhythm')]}
        else:
            baseline=text.startswith('Audit ACTUAL') or text.startswith('Inspect this segment')
            value={'summary':'INDEPENDENT_PRIVATE_NOTE' if not baseline else '基础检查意见','checks':[{
                'dimension':d,'status':'fail' if baseline and d!='equipment' else 'pass',
                'confidence':.95,'frames':[1,2,count],'evidence':'原序列中可核对的实际首中末姿势与运动'} for d in ('completeness','equipment','rhythm')]}
            if not baseline:assert 'INDEPENDENT_PRIVATE_NOTE' not in text
        if 'change' in schema.model_fields:
            value.update(change={'status':'pass','confidence':.95,'frames':[2],'evidence':'诊断模拟：目标变化单独检查'},
                         preservation={'status':'pass','confidence':.95,'frames':[1,count],'evidence':'诊断模拟：原版与备选保持内容单独检查'})
        return schema.model_validate(value),{'requested_model':'fixture-visual-model','usage':{'total_tokens':10}}


def production(setup, budget=20):
    service, workspace, _, provider, fixture = setup
    service.open_motion_model=CheckpointPlanner();workspace.model=service.open_motion_model
    raw_submit,raw_poll=provider.submit,provider.poll
    provider.submit=lambda request:replace(raw_submit(request),diagnostic_only=False)
    provider.poll=lambda job_id:replace(raw_poll(job_id),diagnostic_only=False)
    provider.diagnostic_only=False
    registry=ExpertRegistry();service.open_motion_review_registry=registry
    work=workspace.create(spec(review_protocol='experts_v1',budget={'max_review_calls':budget}),uuid.uuid4().hex,planning_authorized=True)
    work=workspace.plan(work.id);assert work.status=='ready',work.message
    work=workspace.start(work.id,work.revision,work.plan_sha256)
    return service,workspace,provider,work,registry


def test_default_is_new_only_and_old_request_recovery_is_unchanged(setup):
    service,ws,*_=setup
    raw=TaskSpec(character_id='test_hero',description='摘帽再鞠躬并保持低头',provider='fixture')
    assert 'review_protocol' not in raw.model_dump(mode='json')
    key=uuid.uuid4().hex
    new=ws.create(raw,key,planning_authorized=True)
    assert new.spec.review_protocol=='experts_v1' and new.spec.budget.max_review_calls==25
    assert ws.create(raw,key,planning_authorized=True).id==new.id
    # Simulate a receipt written before the new default. Reads/retries retain it.
    old_key=uuid.uuid4().hex
    with patch('sprite_pipeline.collaboration.workspace.default_new_review',lambda s:s):
        old=ws.create(raw,old_key,planning_authorized=True)
    before=(ws.directory(old.id)/'work.json').read_bytes()
    restored=ws.create(raw,old_key,planning_authorized=True)
    assert restored.spec.review_protocol is None and restored.spec.budget.max_review_calls==10
    assert (ws.directory(old.id)/'work.json').read_bytes()==before
    persisted = TaskSpec.model_validate(raw.model_dump()).model_dump()
    assert digest(TaskSpec.model_validate(persisted).model_dump())==digest(persisted)
    assert 'review_protocol' not in persisted
    bounded=ws.create(raw.model_copy(update={'budget':raw.budget.model_copy(update={'max_review_calls':10})}),uuid.uuid4().hex,planning_authorized=True)
    assert bounded.spec.review_protocol=='baseline' and bounded.spec.budget.max_review_calls==10


def test_enhanced_calls_finish_before_human_gate_and_never_generate_on_their_own(setup):
    s,ws,p,w,registry=production(setup)
    engine=PlanGeneration(s)
    for stage in range(2):
        engine.advance(w.job_id,p,wait=True)
        j=s.store.load(w.job_id);r=j.candidates[0].plan_execution.stages[stage]
        assert r.state=='awaiting_review' and r.review['protocol']=='experts_v1'
        assert r.review['expert_review']['state']=='complete'
        assert r.review['expert_review']['calls_used']==5
        assert r.review['verdict']=='uncertain' and r.review['requires_human_adjudication']
        assert r.review['resolution']['checks'][2]['classification']=='preference'
        assert review_call_count(j)==5*(stage+1)
        assert len(p.requests)==stage+1
        engine.advance(w.job_id,p,wait=True)
        assert len(p.requests)==stage+1 and len(registry.calls)==5*(stage+1)
        with pytest.raises(ConflictError):ws.pause(w.id,1,resume=True)
        accept(s,w,stage)
    job=engine.advance(w.job_id,p,wait=True)
    report=job.candidates[0].plan_execution.quality_review
    assert report['state']=='complete' and report['expert_review']['calls_used']==5
    assert review_call_count(job)==15 and len(p.requests)==2
    before=[f.sha256 for f in job.candidates[0].frames]
    with pytest.raises(ExportBlockedError):s.approve_candidate(w.job_id,1,reviewer='test')
    s.approve_candidate(w.job_id,1,reviewer='test',acknowledge_warnings=True,review_note='完整播放后确认动作与节奏可接受，保留可选优化')
    engine.advance(w.job_id,p,wait=True)
    assert len(registry.calls)==15 and len(p.requests)==2
    assert [f.sha256 for f in s.store.load(w.job_id).candidates[0].frames]==before


def test_unknown_extra_request_is_preserved_without_retry(setup):
    s,ws,p,w,registry=production(setup);registry.fail_at=4
    engine=PlanGeneration(s);engine.advance(w.job_id,p,wait=True)
    report=s.store.load(w.job_id).candidates[0].plan_execution.stages[0].review
    assert report['state']=='failed' and report['verdict']=='uncertain'
    assert report['expert_review']['baseline']['state']=='complete'
    assert report['requests'][-1]['state']=='failed_or_unknown'
    for _ in range(2):engine.advance(w.job_id,p,wait=True)
    assert len(registry.calls)==4 and len(p.requests)==1


def test_agreement_skips_dispute_but_still_waits_for_actual_frame_acceptance(setup):
    s,ws,p,w,_=production(setup)
    class Agreed(ExpertRegistry):
        def send(self,*args,**kwargs):
            result,receipt=super().send(*args,**kwargs)
            if isinstance(result,Audit):
                for check in result.checks:check.status='pass'
            assert not isinstance(result,Resolution),'No dispute call is needed'
            return result,receipt
    registry=Agreed();s.open_motion_review_registry=registry
    engine=PlanGeneration(s);engine.advance(w.job_id,p,wait=True)
    stage=s.store.load(w.job_id).candidates[0].plan_execution.stages[0]
    assert stage.state=='awaiting_review' and stage.review['verdict']=='pass'
    assert stage.review['expert_review']['calls_used']==4
    engine.advance(w.job_id,p,wait=True)
    assert len(p.requests)==1 and len(registry.calls)==4


def test_changed_real_frame_stops_extra_calls(setup):
    s,ws,p,w,registry=production(setup)
    def tamper(count):
        if count==3:
            path=PlanGeneration(s).directory(w.job_id,1,0)/'frame_001.png'
            path.write_bytes(b'changed during review')
    registry.after_send=tamper
    PlanGeneration(s).advance(w.job_id,p,wait=True)
    report=s.store.load(w.job_id).candidates[0].plan_execution.stages[0].review
    assert report['state']=='failed' and len(registry.calls)==3
    assert len(p.requests)==1


def test_timing_changed_during_baseline_is_not_silently_reused(setup):
    s,ws,p,w,registry=production(setup)
    def change(count):
        if count==2:
            with s.store.locked_job(w.job_id) as job:job.action.fps=24
    registry.after_send=change
    PlanGeneration(s).advance(w.job_id,p,wait=True)
    report=s.store.load(w.job_id).candidates[0].plan_execution.stages[0].review
    assert report['state']=='failed' and len(registry.calls)==2


def test_repair_reserves_enhanced_checks_and_retains_old_review_cost(setup):
    s,ws,p,w,registry=production(setup,budget=19)
    engine=PlanGeneration(s);engine.advance(w.job_id,p,wait=True)
    token=Checkpoints(s).view(w.job_id,1,0)['token']
    args=dict(token=token,start=1,end=2,note='仅修复物品轮廓且保留外部帧',mode='appearance',request_key='repair-expert-budget',authorized=True,provider=p)
    with pytest.raises(ValidationHarnessError,match='视觉预算不足'):
        LocalRepairs(s).create(w.job_id,1,0,**args)
    assert len(p.requests)==1
    with s.store.locked_job(w.job_id) as j:j.request.open_plan.spec.budget.max_review_calls=20
    LocalRepairs(s).create(w.job_id,1,0,**args)
    for _ in range(3):engine.advance(w.job_id,p,wait=True)
    attempt=s.store.load(w.job_id).candidates[0].plan_execution.stages[0].repairs[0]
    LocalRepairs(s).decide(w.job_id,1,0,0,attempt['token'],'已看完整预览并核对两侧接缝','accept')
    engine.advance(w.job_id,p,wait=True)
    job=s.store.load(w.job_id);stage=job.candidates[0].plan_execution.stages[0]
    assert len(stage.review_history[0]['requests'])==5 and len(stage.review['requests'])==5
    assert review_call_count(job)==10 and len(p.requests)==2


def test_character_probes_guard_checkpoints_and_populate_2x2_counterfactual(setup, tmp_path):
    import io
    from PIL import Image, ImageDraw
    from sprite_pipeline.collaboration.experiment import counterfactual_verdicts

    s, ws, p, w, _ = production(setup)
    # Mark job grounded so ground_baseline_drift is evaluated alongside centroid/area/palette probes.
    with s.store.locked_job(w.job_id) as job:
        job.action.grounded = True
    raw_poll = p.poll

    def drifted_poll(job_id):
        result = raw_poll(job_id)
        images = []
        for idx, raw_bytes in enumerate(result.images):
            if idx != 2:
                images.append(raw_bytes)
                continue
            # Shift character upward by 10px (ground_y drift > 4px) and add out-of-palette magenta block (area + palette drift).
            im = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
            with Image.open(io.BytesIO(raw_bytes)).convert('RGBA') as src:
                im.paste(src, (0, -10))
            ImageDraw.Draw(im).rectangle((6, 6, 30, 32), fill=(255, 0, 255, 255))
            buf = io.BytesIO()
            im.save(buf, format='PNG')
            images.append(buf.getvalue())
        return replace(result, images=images)

    class AllPassExperts(ExpertRegistry):
        def send(self, role, content, schema, count, **kwargs):
            text = content[0]['text']
            self.calls.append((schema.__name__, text))
            if schema is Observations:
                value = {'reference_equipment': '一件原有物品', 'frames': [{'frame': i, 'pose': '连续姿势', 'equipment': '同一件物品', 'change': '连续'} for i in range(1, count + 1)]}
            else:
                value = {'summary': '模型误放通过', 'checks': [{'dimension': d, 'status': 'pass', 'confidence': .96, 'frames': [1, 2, count], 'evidence': '模型忽略了偏移与色偏'} for d in ('completeness', 'equipment', 'rhythm')]}
            return schema.model_validate(value), {'requested_model': 'fixture-visual-model', 'usage': {'total_tokens': 10}}

    p.poll = drifted_poll
    registry = AllPassExperts()
    s.open_motion_review_registry = registry
    engine = PlanGeneration(s)
    engine.advance(w.job_id, p, wait=True)
    stage = s.store.load(w.job_id).candidates[0].plan_execution.stages[0]
    review = stage.review
    assert review['verdict'] == 'uncertain'
    probes = review['motion_evidence']['character_probes']
    assert 3 in probes['flags']['rhythm'] and 3 in probes['flags']['equipment']
    sources = {item['dimension']: item for item in review['requires_human_adjudication']}
    assert sources['rhythm']['source'] == 'deterministic_probe' and sources['equipment']['source'] == 'deterministic_probe'
    # Character probes never inject into blind expert follow-up prompts.
    assert all('character_probes' not in call_text for _, call_text in registry.calls[2:])
    ablation = counterfactual_verdicts(review)
    assert ablation['full'] == 'uncertain'
    assert ablation['without_probes'] == 'pass'
    assert ablation['probe_overrides'] == 2
