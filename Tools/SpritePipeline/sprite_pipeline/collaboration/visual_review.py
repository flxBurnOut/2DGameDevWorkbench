"""Evidence-first, action-agnostic visual audit. Never regenerates or approves."""
from __future__ import annotations
import hashlib
from typing import Literal
from pydantic import Field
from PIL import Image, ImageDraw
from .contracts import QualityDimension, Contract, digest
from .model_config import ModelRegistry
from ..errors import ValidationHarnessError
from ..vision_evidence import raster, image_part
from .review_inputs import prop_review_context, review_dimensions, observation_content, audit_content, TIMING_NOTE


class FrameObservation(Contract):
    frame: int = Field(ge=1, le=64)
    pose: str = Field(min_length=1, max_length=180)
    equipment: str = Field(min_length=1, max_length=180)
    change: str = Field(min_length=1, max_length=180)


class Observations(Contract):
    reference_equipment: str = Field(min_length=1, max_length=400)
    frames: list[FrameObservation] = Field(min_length=1, max_length=64)


class CriterionResult(Contract):
    dimension: QualityDimension
    status: Literal['pass', 'fail', 'uncertain']
    confidence: float = Field(ge=0, le=1)
    frames: list[int] = Field(min_length=1, max_length=64)
    evidence: str = Field(min_length=4, max_length=500)


class Audit(Contract):
    summary: str = Field(min_length=1, max_length=800)
    checks: list[CriterionResult] = Field(min_length=3, max_length=3)


def frame_digest(candidate):
    return digest([{k: f.model_dump(mode='json')[k] for k in ('index', 'sha256', 'active_path')} for f in candidate.frames])


def review_state(candidate):
    review = candidate.plan_execution.quality_review if candidate.plan_execution else None
    if not review: return {'state': 'unavailable', 'verdict': 'uncertain'}
    if review.get('frame_digest') and review['frame_digest'] != frame_digest(candidate):
        return {**review, 'state': 'stale', 'verdict': 'uncertain', 'summary': '帧已修改；旧视觉报告不适用于当前动画，请人工重新检查。'}
    return review


def evidence_panels(paths, reference, fps):
    """Give the reviewer adjacent frames in one labelled image, not isolated poses."""
    content=[]
    for start in range(0,len(paths),6):
        tiles=[('REF - not a frame',reference)]+[(f'FRAME {i+1}/{len(paths)}  {i/fps:.3f}s',paths[i]) for i in range(start,min(start+6,len(paths)))]
        board=Image.new('RGB',(3*256,((len(tiles)+2)//3)*280),(25,30,40));draw=ImageDraw.Draw(board)
        for n,(label,path) in enumerate(tiles):
            x=n%3*256;y=n//3*280;draw.text((x+6,y+6),label,fill='white');board.paste(raster(path,256),(x,y+24))
        content.extend([{'type':'input_text','text':f'Ordered actual frames {start+1}-{min(start+6,len(paths))}; labels are authoritative. REF repeats only for comparison. These panels composite PNGs onto a display matte for visibility. The matte is NOT source background: do not infer missing transparency or a new solid object from it. Alpha is checked separately from original files.'},image_part(board)])
    return content


def audit_verdict(checks):
    """One confident defect fails; only unanimous confident passes pass."""
    if any(c['status']=='fail' and c['confidence']>=.8 for c in checks):return 'fail'
    return 'pass' if all(c['status']=='pass' and c['confidence']>=.85 for c in checks) else 'uncertain'


def grounded_audit(result, count):
    checks=[]
    for item in result.checks:
        c=item.model_dump(mode='json')
        minimum=2 if c['dimension'] in {'rhythm','transition','fixed_parts'} else min(count,3) if c['dimension']=='completeness' else 1
        if len(set(c['frames']))<minimum:
            c.update(status='uncertain',confidence=0,evidence=('帧证据不足以支持这一时序结论；请人工核对。模型原意见：'+c['evidence'])[:500])
        checks.append(c)
    verdict=audit_verdict(checks)
    labels={'state_frame':'状态帧可用','transition':'过渡可用','fixed_parts':'固定内容保持','completeness':'完整性','equipment':'装备一致性','rhythm':'节奏'};states={'pass':'模型判定通过','fail':'模型发现问题','uncertain':'证据不足'}
    summary='；'.join(labels[c['dimension']]+'：'+states[c['status']] for c in checks)+'。仍需结合实际播放人工确认。'
    return verdict,checks,summary


class QualityReviewer:
    def __init__(self, service):
        self.s = service
        self.registry = getattr(service, 'open_motion_review_registry', None) or ModelRegistry(service.settings)

    def run(self, job_id, index):
        job = self.s.store.load(job_id); candidate = self.s._candidate(job, index)
        if not job.request.open_plan.plan.quality: return
        state = review_state(candidate)
        if state['state'] != 'pending':
            if state['state'] == 'running':
                with self.s.store.locked_job(job_id) as current:
                    r = self.s._candidate(current, index).plan_execution.quality_review
                    r.update(state='unknown', verdict='uncertain', summary='视觉请求曾中断；未自动重发，请人工检查。')
            return
        fingerprint = frame_digest(candidate)
        with self.s.store.locked_job(job_id) as current:
            r = self.s._candidate(current, index).plan_execution.quality_review
            r.update(state='running', frame_digest=fingerprint, verdict='uncertain', requests=[])
            if job.request.open_plan.spec.review_protocol == 'experts_v1':
                r['protocol'] = 'experts_v1'
        if candidate.diagnostic_only:
            with self.s.store.locked_job(job_id) as current:
                self.s._candidate(current,index).plan_execution.quality_review.update(state='diagnostic', verdict='uncertain', summary='诊断素材未调用视觉模型，不能证明生成质量。')
                if job.request.open_plan.spec.review_protocol == 'experts_v1':
                    from .production_review import diagnostic_report
                    self.s._candidate(current,index).plan_execution.quality_review.update(diagnostic_report())
            return
        try:
            paths = [self.s.store.resolve_job_path(job_id, f.active_path) for f in candidate.frames]
            for path, frame in zip(paths, candidate.frames):
                if hashlib.sha256(path.read_bytes()).hexdigest() != frame.sha256:
                    raise ValidationHarnessError('帧内容已改变，未提交视觉请求')
            reference = self.s.store.job_dir(job_id) / 'input/reference.png'
            pictures = evidence_panels(paths,reference,job.action.fps)
            from .motion_evidence import measurements
            prop_context = prop_review_context(job.request.open_plan)
            metrics=measurements([p.read_bytes() for p in paths],job.action.fps, prop_context.get('interactable'),
                reference)
            from .prop_measurements import tracked_measurements, guard_measurements
            cues = tracked_measurements(self.s, job, index, None, fingerprint)
            if cues:
                metrics['tracked_parts'] = cues
            with self.s.store.locked_job(job_id) as current:
                self.s._candidate(current,index).plan_execution.quality_review['motion_evidence']=metrics
            observe = observation_content(pictures, interactable=bool(prop_context))
            observations = self.call(job_id,index,'observe',observe,Observations,len(paths))
            if [f.frame for f in observations.frames] != list(range(1,len(paths)+1)):
                raise ValidationHarnessError('逐帧观察不完整或顺序错误')
            with self.s.store.locked_job(job_id) as current:
                self.s._candidate(current,index).plan_execution.quality_review['observations'] = observations.model_dump(mode='json')
            contract = job.request.open_plan.plan.quality.model_dump(mode='json')
            context = {**prop_context, 'user_request':job.request.open_plan.spec.description,'quality_contract':contract,
                    'segment_motion_constraints':[s.motion.model_dump(mode='json') if s.motion else None for s in job.request.open_plan.plan.stages],
                    'pixel_cues_not_verdict':metrics,
                    'actual_stage_boundaries':candidate.plan_execution.timeline,
                    'timing_note':TIMING_NOTE,
                    'observations':observations.model_dump(mode='json')}
            from .adjustment_review import add_accepted_goals
            context=add_accepted_goals(context,candidate)
            result = self.call(job_id,index,'audit',audit_content(pictures,context,job.action.fps),Audit,len(paths))
            if {c.dimension for c in result.checks} != set(review_dimensions(prop_context)) or any(f<1 or f>len(paths) for c in result.checks for f in c.frames):
                raise ValidationHarnessError('视觉验收维度或帧证据无效')
            verdict, checks, summary = grounded_audit(result,len(paths))
            report = dict(state='complete',verdict=verdict,checks=checks,summary=summary,
                          model_audit=result.model_dump(mode='json'),protocol_version=2)
            if job.request.open_plan.spec.review_protocol == 'experts_v1':
                from .production_review import ProductionReview
                report = ProductionReview(self.s,job_id,index).finish(report,
                    lambda phase, content, schema, count: self.call(job_id,index,phase,content,schema,count),
                    expected_token=fingerprint, expected_fps=job.action.fps)
            else:
                report = guard_measurements(report, cues)
            with self.s.store.locked_job(job_id) as current:
                c = self.s._candidate(current,index)
                if frame_digest(c) != fingerprint: raise ValidationHarnessError('验收期间动画已改变')
                c.plan_execution.quality_review.update(report)
                current.plan_control.message = '动画与视觉报告已保存，请人工检查后采用'
                current.touch('open_motion_quality_reviewed', candidate_index=index, verdict=report['verdict'])
        except Exception as exc:
            with self.s.store.locked_job(job_id) as current:
                r = self.s._candidate(current,index).plan_execution.quality_review
                r.update(state='failed', verdict='uncertain', summary=str(exc) if isinstance(exc,ValidationHarnessError) else '视觉验收未完成，未自动重试；请人工检查。')

    def call(self, job_id, index, phase, content, schema, count):
        with self.s.store.locked_job(job_id) as job:
            from .checkpoints import review_call_count
            spent = review_call_count(job)
            if spent >= job.request.open_plan.spec.budget.max_review_calls:
                raise ValidationHarnessError('视觉验收调用已达上限，未继续请求')
            profile = self.registry.profile('reviewer',job.request.open_plan.model_snapshot)
            request = {'phase':phase, 'state':'submitting', 'profile':profile.model_dump(mode='json')}
            if job.request.open_plan.spec.review_protocol == 'experts_v1':
                request['input_sha256'] = digest(content)
            self.s._candidate(job,index).plan_execution.quality_review['requests'].append(request)
        receipt = {}
        try:
            result, metadata = self.registry.send('reviewer',content,schema,count,snapshot=job.request.open_plan.model_snapshot,
                schema_name='open_motion_quality',on_response=receipt.update,
                **({'interactable': True} if job.request.open_plan.plan.quality.interactable else {}))
            request.update(state='complete',**metadata)
            if job.request.open_plan.spec.review_protocol == 'experts_v1':
                request['response'] = result.model_dump(mode='json')
            return result
        finally:
            if request['state']=='submitting': request.update(state='failed_or_unknown',**receipt)
            with self.s.store.locked_job(job_id) as current:
                self.s._candidate(current,index).plan_execution.quality_review['requests'][-1] = request
