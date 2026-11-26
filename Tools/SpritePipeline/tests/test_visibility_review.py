"""Occlusion is not loss, uncertainty is not a pass, direct defects stay defects."""
import copy
from unittest.mock import patch

import pytest
from test_open_motion import setup
from test_production_review import production, ExpertRegistry
from sprite_pipeline.collaboration.visibility_review import schema,guard
from sprite_pipeline.collaboration.visual_review import Audit
from sprite_pipeline.collaboration.dispute_review import Resolution
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.errors import ValidationHarnessError


def finding(**updates):
    return dict(subject='原图中的手持物',frames=[2,3],before_frames=[1],after_frames=[4],
        observation='not_visible',explanation='occlusion',expected_visibility='unknown',finding='uncertain',
        contradiction_frames=[],facts='中间两帧物品与身体重叠，边界看不清楚',
        alternatives='前后物品可辨认，遮挡合理但不能证明隐藏部分形状',**updates)


def opinion(status='fail',item=None,*,resolution=False):
    checks=[dict(dimension=d,confidence=.97,frames=[1,2,3,4],evidence='已根据实际顺序图片与前后可见边界核对') for d in ('equipment','completeness','rhythm')]
    for c in checks:
        if resolution:c.update(classification=status if c['dimension']=='equipment' else 'satisfied',observation='实际图片可辨认的证据',prior_claim_correction='原有推测须以实际图片核对')
        else:c['status']=status if c['dimension']=='equipment' else 'pass'
    return schema(Resolution if resolution else Audit).model_validate(dict(summary='按实际可见证据检查',checks=checks,
        equipment_visibility={'items':[item or finding()],'summary':'区分可见矛盾、投影变化和遮挡'}))


def test_unsupported_loss_and_unsupported_pass_remain_uncertain():
    for state in ('fail','pass'):
        raw=opinion(state);original=raw.model_dump()
        result,trace=guard(raw,4)
        assert result.checks[0].status=='uncertain' and result.checks[0].confidence==0
        assert trace['raw_opinion']==original and raw.model_dump()==original
        assert trace['verified_geometry'] is False


@pytest.mark.parametrize('kind',['visible_shape_break','visible_duplicate','identity_change'])
def test_positive_visible_contradictions_are_not_excused_as_occlusion(kind):
    item=finding();item.update(observation='visible',finding=kind,explanation='none',contradiction_frames=[2],
        facts='一帧中清晰可见分离的第二条轮廓且连接点断开',alternatives='前后视角连续，遮挡和投影都不能解释当前分离的轮廓')
    result,trace=guard(opinion(item=item),4)
    assert result.checks[0].status=='fail' and trace['guard_reason'] is None
    assert guard(opinion('pass',item=item),4)[0].checks[0].status=='uncertain'


def test_supported_absence_requires_expected_visibility_and_no_plausible_explanation():
    item=finding();item.update(finding='unexplained_absence',expected_visibility='supported',explanation='none',contradiction_frames=[2])
    assert guard(opinion(item=item),4)[0].checks[0].status=='fail'
    item['explanation']='foreshortening'
    assert guard(opinion(item=item),4)[0].checks[0].status=='uncertain'


def test_projection_evidence_can_support_consistency_but_never_automatically_adopts():
    item=finding();item.update(observation='partly_visible',finding='consistent',explanation='foreshortening',
        facts='刀尖随转向逐渐缩短，握持点和根部轮廓连续，后续恢复长度')
    result,trace=guard(opinion('pass',item=item),4)
    assert result.checks[0].status=='pass' and not trace['verified_geometry']
    assert guard(opinion('material_defect',item=item,resolution=True),4,resolution=True)[0].checks[0].classification=='insufficient_evidence'


@pytest.mark.parametrize('updates',[{'frames':[2,5]},{'before_frames':[2]},{'after_frames':[3]},{'contradiction_frames':[4]}])
def test_bad_frame_evidence_stops_without_rewriting(updates):
    item=finding();item.update(updates)
    raw=opinion(item=item)
    with pytest.raises(ValidationHarnessError):guard(raw,4)


def test_v2_accepts_explicit_join_comparison_without_relaxing_frame_identity():
    item=finding();item.update(observation='visible',finding='visible_shape_break',contradiction_frames=[1,2])
    raw=opinion(item=item);before=raw.model_dump(mode='json')
    with pytest.raises(ValidationHarnessError):guard(raw,4,version=1)
    result,trace=guard(raw,4,version=2)
    assert result.checks[0].status=='fail' and trace['version']==2
    assert raw.model_dump(mode='json')==before
    item['contradiction_frames']=[1]  # Context alone cannot identify a bad observed frame.
    with pytest.raises(ValidationHarnessError):guard(opinion(item=item),4,version=2)
    item['contradiction_frames']=[2,5]
    with pytest.raises(ValidationHarnessError):guard(opinion(item=item),5,version=2)


def test_v3_shared_context_is_not_mistaken_for_a_disjoint_interval():
    item=finding();item.update(frames=[1,2,3,4],before_frames=[1,2],after_frames=[4],
        observation='visible',finding='visible_shape_break',contradiction_frames=[2,3])
    raw=opinion(item=item);before=raw.model_dump(mode='json')
    with pytest.raises(ValidationHarnessError):guard(raw,4,version=2)
    result,trace=guard(raw,4,version=3)
    assert result.checks[0].status=='fail' and trace['frame_lists_are_evidence_sets_not_intervals']
    assert raw.model_dump(mode='json')==before
    item['after_frames']=[5]
    with pytest.raises(ValidationHarnessError):guard(opinion(item=item),4,version=3)


class VisibilityRegistry(ExpertRegistry):
    def send(self,role,content,result_type,count,**kwargs):
        if 'equipment_visibility' not in result_type.model_fields:
            return super().send(role,content,result_type,count,**kwargs)
        base=Resolution if issubclass(result_type,Resolution) else Audit
        value,receipt=super().send(role,content,base,count,**kwargs)
        item=finding();item.update(frames=[2],before_frames=[1],after_frames=[count])
        raw=value.model_dump(mode='json');raw['equipment_visibility']={'items':[item],'summary':'遮挡不能确认为消失，也不能直接证明外观合格'}
        for field in ('change','preservation'):
            if field in result_type.model_fields:raw[field]={'status':'pass','confidence':.95,'frames':[2],'evidence':'修改前后分别检查目标和保护项'}
        return result_type.model_validate(raw),receipt


def test_formal_review_keeps_baseline_costs_and_human_gate(setup):
    s,ws,p,w,old=production(setup)
    with s.store.locked_job(w.job_id) as job:job.request.open_plan.visibility_review_version=1
    registry=VisibilityRegistry();s.open_motion_review_registry=registry
    engine=PlanGeneration(s);engine.advance(w.job_id,p,wait=True)
    stage=s.store.load(w.job_id).candidates[0].plan_execution.stages[0]
    details=stage.review['expert_review']
    assert stage.state=='awaiting_review' and details['state']=='complete'
    assert len(registry.calls)==5 and len(p.requests)==1
    assert details['visibility_review_version']==1 and len(details['visibility_evidence'])==3
    assert 'VISIBILITY EVIDENCE' not in registry.calls[0][1] and 'VISIBILITY EVIDENCE' not in registry.calls[1][1]
    assert all('VISIBILITY EVIDENCE' in c[1] for c in registry.calls[2:])
    assert stage.review['verdict']=='uncertain'
    engine.advance(w.job_id,p,wait=True)
    assert len(registry.calls)==5 and len(p.requests)==1


def test_changed_policy_stops_inflight_review_without_new_calls(setup):
    s,ws,p,w,_=production(setup)
    with s.store.locked_job(w.job_id) as job:job.request.open_plan.visibility_review_version=1
    def mutate(n):
        if n==3:
            with s.store.locked_job(w.job_id) as job:job.request.open_plan.visibility_review_version=None
    registry=VisibilityRegistry(after_send=mutate);s.open_motion_review_registry=registry
    PlanGeneration(s).advance(w.job_id,p,wait=True)
    report=s.store.load(w.job_id).candidates[0].plan_execution.stages[0].review
    assert report['state']=='failed' and len(registry.calls)==3 and len(p.requests)==1


def test_legacy_formal_reviews_do_not_request_new_fields(setup):
    s,ws,p,w,registry=production(setup)
    PlanGeneration(s).advance(w.job_id,p,wait=True)
    details=s.store.load(w.job_id).candidates[0].plan_execution.stages[0].review['expert_review']
    assert 'visibility_review_version' not in details
    assert all('VISIBILITY EVIDENCE' not in c[1] for c in registry.calls)


def test_new_adjudication_guard_keeps_exact_prior_model_inputs():
    from sprite_pipeline.collaboration.visibility_review import add_content
    content=[{'type':'input_text','text':'Inspect ordered actual frames.'}]
    assert add_content(content,version=4)==add_content(content,version=3)


def test_independent_visible_defect_cannot_be_silently_cleared_over_a_passing_baseline(setup):
    s,ws,p,w,_=production(setup)
    with s.store.locked_job(w.job_id) as job:job.request.open_plan.visibility_review_version=4
    class Contradicting(VisibilityRegistry):
        def send(self,role,content,result_type,count,**kw):
            result,meta=super().send(role,content,result_type,count,**kw)
            if hasattr(result,'equipment_visibility'):
                item=result.equipment_visibility.items[0]
                item.observation='visible';item.finding='consistent'
                if not isinstance(result,Resolution):
                    next(c for c in result.checks if c.dimension=='equipment').status='fail'
                    item.finding='visible_shape_break';item.contradiction_frames=[2]
            return result,meta
    registry=Contradicting();s.open_motion_review_registry=registry
    PlanGeneration(s).advance(w.job_id,p,wait=True)
    stage=s.store.load(w.job_id).candidates[0].plan_execution.stages[0];report=stage.review
    assert report['state']=='complete' and len(registry.calls)==5 and len(p.requests)==1
    assert next(c for c in report['checks'] if c['dimension']=='equipment')['status']=='uncertain'
    assert any(p['dimension']=='equipment' for p in report['requires_human_adjudication'])
    assert report['expert_review']['visibility_conflict']['state']=='needs_human_adjudication'
    assert next(c for c in report['resolution']['checks'] if c['dimension']=='equipment')['classification']=='satisfied'
    assert stage.state=='awaiting_review'  # Original resolution is retained, not fabricated as a failure.


def test_adjustment_comparison_and_visibility_share_the_existing_five_calls(setup):
    from test_motion_adjustments import stage_work,request,IntentRegistry
    from sprite_pipeline.collaboration.adjustments import Adjustments,AdjustmentIntent,frozen_inputs
    from sprite_pipeline.collaboration.contracts import digest
    s,ws,p,w=stage_work(setup,True);s.adjustment_test_reviews=True
    class Registry(VisibilityRegistry,IntentRegistry):
        def send(self,role,content,result_type,count,**kw):
            if issubclass(result_type,AdjustmentIntent):
                return IntentRegistry.send(self,role,content,result_type,count,**kw)
            return VisibilityRegistry.send(self,role,content,result_type,count,**kw)
    registry=Registry();s.open_motion_review_registry=registry;m=Adjustments(s)
    before=(s.store.job_dir(w.job_id)/'job.json').read_bytes()
    t=m.create(w.id,request(m,w));t['visibility_review_version']=1
    t['frozen_digest']=digest(frozen_inputs(t));m.save(t)
    t=m.advance(w.id,t['id'],p)
    assert t['state']=='ready',t
    assert len(t['planning_calls'])==1 and len(t['generation_calls'])==1 and len(t['review_calls'])==5
    assert t['review']['comparison']['state']=='complete'
    assert len(t['review']['expert_review']['visibility_evidence'])==3
    assert (s.store.job_dir(w.job_id)/'job.json').read_bytes()==before
    assert not t.get('edit_regions')
    assert all(t['proposed_frames'][i]['sha256']==t['source_frames'][i]['sha256'] for i in (0,3))


def test_not_visible_occlusion_requires_external_context_frames():
    # Repeating observed frames inside before_frames/after_frames cannot satisfy occlusion context.
    item = finding()
    item.update(frames=[2, 3], before_frames=[2], after_frames=[3],
                observation='not_visible', explanation='occlusion', finding='consistent')
    result, trace = guard(opinion('pass', item=item), 4, version=4)
    assert result.checks[0].status == 'uncertain' and trace['unresolved_visibility'] is True


def test_v4_empty_dispute_cannot_clear_independent_visibility_uncertainty(setup):
    s, ws, p, w, _ = production(setup)
    with s.store.locked_job(w.job_id) as job:
        job.request.open_plan.visibility_review_version = 4

    class EmptyDisputeClear(VisibilityRegistry):
        def send(self, role, content, result_type, count, **kw):
            result, meta = super().send(role, content, result_type, count, **kw)
            if not hasattr(result, 'equipment_visibility'):
                return result, meta
            if isinstance(result, Resolution):
                for c in result.checks:
                    c.classification = 'satisfied'
                    c.confidence = .95
                result.equipment_visibility.items = []
                result.equipment_visibility.summary = '未见异常'
            else:
                # Expert reports unresolved visibility uncertainty (not a definite fail).
                next(c for c in result.checks if c.dimension == 'equipment').status = 'uncertain'
                next(c for c in result.checks if c.dimension == 'equipment').confidence = 0
            return result, meta

    s.open_motion_review_registry = EmptyDisputeClear()
    PlanGeneration(s).advance(w.job_id, p, wait=True)
    report = s.store.load(w.job_id).candidates[0].plan_execution.stages[0].review
    assert report['state'] == 'complete'
    assert next(c for c in report['checks'] if c['dimension'] == 'equipment')['status'] == 'uncertain'
    assert report['expert_review']['visibility_conflict']['rule'] == 'require_visibility_evidence_to_clear_expert_uncertainty'


def test_500_char_evidence_never_overflows_on_grounded_downgrade_or_v4_retention():
    from sprite_pipeline.collaboration.visibility_review import retain_visible_disagreement
    from sprite_pipeline.collaboration.visual_review import grounded_audit

    long_ev = '实' * 500
    audit = Audit.model_validate({'summary': '长证据边界', 'checks': [
        {'dimension': 'completeness', 'status': 'pass', 'confidence': .95, 'frames': [1, 2, 3], 'evidence': long_ev},
        {'dimension': 'equipment', 'status': 'pass', 'confidence': .95, 'frames': [1, 2], 'evidence': long_ev},
        {'dimension': 'rhythm', 'status': 'pass', 'confidence': .95, 'frames': [1], 'evidence': long_ev},
    ]})
    verdict, checks, summary = grounded_audit(audit, 4)
    assert verdict == 'uncertain' and all(len(c['evidence']) <= 500 for c in checks)
    traces = {'expert_appearance': {
        'definite_contradiction_reported': True,
        'raw_opinion': {'checks': [{'dimension': 'equipment', 'status': 'fail', 'confidence': .95, 'frames': [2], 'evidence': long_ev}]},
    }}
    retained = retain_visible_disagreement({'summary': summary, 'checks': checks, 'verdict': verdict}, traces, 4)
    assert all(len(c['evidence']) <= 500 for c in retained['checks'])
    assert next(c for c in retained['checks'] if c['dimension'] == 'equipment')['status'] == 'uncertain'


def test_checkpoint_rejects_zero_frame_and_vision_preserves_incomplete_usage(setup, monkeypatch):
    from sprite_pipeline.vision_review import VisionReviewer
    from sprite_pipeline.collaboration.checkpoints import Checkpoints

    # 1. vision_review._send must report receipt (id + usage) before raising on incomplete HTTP 200 response.
    class FakeResp:
        status_code = 200
        headers = {}

        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    class FakeClient:
        def __init__(self, payload):
            self._payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, *args, **kwargs):
            return FakeResp(self._payload)

    reviewer = VisionReviewer(setup[0].settings)
    captured = {}
    monkeypatch.setattr('sprite_pipeline.vision_review.httpx.Client', lambda **kw: FakeClient({
        'id': 'resp-incomplete-1', 'model': 'gpt-5.4', 'status': 'incomplete',
        'usage': {'input_tokens': 120, 'output_tokens': 30, 'total_tokens': 150},
    }))
    with pytest.raises(ValidationHarnessError):
        reviewer._send([{'type': 'input_text', 'text': 'test'}], Audit, 'openai', 'sk-test', 4, None,
                       on_response=captured.update)
    assert captured['response_id'] == 'resp-incomplete-1'
    assert captured['usage']['total_tokens'] == 150
    assert captured['response_status'] == 'incomplete'

    # 2. Checkpoints.inspect rejects frame=0 in audit checks.
    s, ws, p, w, _ = production(setup)
    class ZeroFrameRegistry(ExpertRegistry):
        def send(self, role, content, result_type, count, **kw):
            val, meta = super().send(role, content, result_type, count, **kw)
            if isinstance(val, Audit):
                val.checks[0].frames = [0, 1, 2]
            return val, meta
    s.open_motion_review_registry = ZeroFrameRegistry()
    PlanGeneration(s).advance(w.job_id, p, wait=True)
    report = s.store.load(w.job_id).candidates[0].plan_execution.stages[0].review
    assert report['state'] == 'failed' and '证据无效' in report['summary']
