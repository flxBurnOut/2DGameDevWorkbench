"""Versioned integration of the validated reviewers into native review gates.

Uses the caller's persisted request ledger and task budget. It never generates,
repairs, accepts a checkpoint, approves a candidate, or changes original pixels.
"""
from __future__ import annotations

import copy
import hashlib
import json

from ..errors import ConflictError, ValidationHarnessError
from .contracts import digest
from .review_inputs import review_dimensions
from .review_evaluation import ReviewEvidence, validated_audit
from .review_sources import snapshot_review
from .visual_review import Audit, frame_digest
from .independent_review import EXPERTS, expert_content, consensus, attach_opinions
from .dispute_review import Resolution, resolution_content, apply_resolution


def enabled(job):
    return bool(job.request.open_plan and job.request.open_plan.spec.review_protocol == 'experts_v1')


def diagnostic_report():
    return {'protocol': 'experts_v1', 'expert_review': {'state': 'diagnostic', 'calls_used': 0,
        'max_calls': 5, 'summary': '诊断素材未调用真实视觉模型，不能证明专家判断准确。'}}


def independent_followup(evidence, original, call, persist, requests, *, additional_disputes=None, visibility_version=None):
    """Shared formal review algorithm; callers own authorization and receipts."""
    opinions = {}
    visibility = {}
    def opinion(phase, content, result_type):
        if visibility_version not in (1,2,3,4):
            return call(phase, content, result_type)
        from .visibility_review import add_content, schema, guard
        value = call(phase, add_content(content,version=visibility_version, interactable=bool(evidence.manifest['context'].get('interactable'))), schema(result_type))
        value, trace = guard(value, len(evidence.paths), resolution=phase=='dispute',version=visibility_version)
        visibility[phase] = trace
        persist(visibility_review_version=visibility_version, visibility_evidence=copy.deepcopy(visibility))
        return value
    for expert in EXPERTS:
        persist(phase=expert)
        value = opinion('expert_'+expert, expert_content(evidence, expert), Audit)
        opinions[expert] = validated_audit(value, len(evidence.paths), review_dimensions(evidence.manifest['context']))
        persist(experts=copy.deepcopy(opinions))
    independent = {'mode': 'independent', 'state': 'complete', 'evidence_token': evidence.token,
        'model_snapshot': original['model_snapshot'], 'experts': opinions,
        'requests': copy.deepcopy(requests()[2:]), **consensus(opinions, len(evidence.paths))}
    augmented = attach_opinions(original, independent)
    persist(disputes=augmented['disputes'], expert_proposal=augmented['expert_proposal'])
    selected = {k: augmented[k] for k in ('verdict', 'checks', 'summary')}
    extra=additional_disputes() if additional_disputes else []
    if extra:persist(comparison_disputes=extra)
    if augmented['disputes'] or extra:
        persist(phase='dispute')
        content, focus = resolution_content(evidence, {**augmented,'disputes':[*augmented['disputes'],*extra]} if extra else augmented)
        if visibility_version in (1,2,3,4):
            content[0]['text']+='\nPRIOR VISIBILITY OBSERVATIONS (untrusted claims to verify against actual images, not geometry truth):\n'+json.dumps(
                {k:{'equipment_visibility':v['equipment_visibility'],'guard_reason':v['guard_reason']} for k,v in visibility.items()},ensure_ascii=False)
        persist(focus=focus)
        result = opinion('dispute', content, Resolution)
        selected = apply_resolution(augmented, result, len(evidence.paths))
        if visibility_version==4:
            from .visibility_review import retain_visible_disagreement
            selected=retain_visible_disagreement(selected,visibility,len(evidence.paths))
            if selected.get('visibility_conflict'):persist(visibility_conflict=selected['visibility_conflict'])
        persist(resolution=selected['resolution'],
                requires_human_adjudication=selected['requires_human_adjudication'])
    persist(state='complete', phase='done', summary='独立专家与争议复核已保存，等待实际画面确认。')
    return selected


class ProductionReview:
    def __init__(self, service, job_id, index, *, stage=None):
        self.s, self.job_id, self.index, self.stage = service, job_id, index, stage
        self.details = {}

    def native(self, job):
        execution = self.s._candidate(job, self.index).plan_execution
        return execution.quality_review if self.stage is None else execution.stages[self.stage].review

    def identity(self, job):
        candidate = self.s._candidate(job, self.index)
        if self.stage is None:
            token = frame_digest(candidate)
            frames = [{'path': f.active_path, 'sha256': f.sha256} for f in candidate.frames]
            for frame in frames:
                data = self.s.store.resolve_job_path(self.job_id, frame['path']).read_bytes()
                if hashlib.sha256(data).hexdigest() != frame['sha256']:
                    raise ConflictError('专家复核所依据的动画图片发生变化')
        else:
            from .checkpoints import Checkpoints
            actual = Checkpoints(self.s).evidence(job, self.index, self.stage)
            token, frames = actual['token'], actual['frames']
        if hashlib.sha256((self.s.store.job_dir(self.job_id)/'input/reference.png').read_bytes()).hexdigest() != job.reference_sha256:
            raise ConflictError('专家复核所依据的参考图发生变化')
        policy=job.request.open_plan.visibility_review_version
        return digest({'token': token, 'fps': job.action.fps, 'reference': job.reference_sha256,
                       'plan': job.request.open_plan.plan_sha256,
                       **({'visibility_review_version':policy} if policy is not None else {})}), token, frames

    def persist(self, **updates):
        self.details.update(updates)
        with self.s.store.locked_job(self.job_id) as job:
            report = self.native(job)
            self.details['calls_used'] = len(report['requests'])
            report.update(protocol='experts_v1', expert_review=copy.deepcopy(self.details))
            if self.details.get('state')=='running':
                scope='整段动画' if self.stage is None else f'第 {self.stage+1} 段'
                phase={'appearance':'外观专家独立检查','motion':'运动专家独立检查','dispute':'针对争议复核实际帧'}.get(self.details.get('phase'),'检查')
                job.plan_control.message=f'{scope}：{phase}'

    def finish(self, baseline, call, *, expected_token, expected_fps):
        job = self.s.store.load(self.job_id)
        if not enabled(job):
            return baseline
        identity, token, frames = self.identity(job)
        if token != expected_token or job.action.fps != expected_fps:
            raise ConflictError('基础检查期间动画或播放速度发生变化，不能沿用旧结论')
        if len(self.native(job)['requests']) != 2:
            raise ConflictError('增强复核只能接续本次完整基础检查，不能重发已有请求')
        folder = self.s.store.job_dir(self.job_id)/'review-evidence'/f'c{self.index}'/f'{"clip" if self.stage is None else "s"+str(self.stage)}-{identity[:24]}'
        evidence = ReviewEvidence(folder) if folder.exists() else snapshot_review(
            self.s, self.job_id, self.index, folder, expected_token=token, stage=self.stage)
        if evidence.manifest['source']['token'] != token or [f['sha256'] for f in evidence.manifest['frames']] != [f['sha256'] for f in frames]:
            raise ConflictError('专家证据快照与当前实际帧不同')
        models = copy.deepcopy(job.request.open_plan.model_snapshot)
        original = {**copy.deepcopy(baseline), 'mode': 'baseline', 'state': 'complete',
            'evidence_token': evidence.token, 'model_snapshot': models,
            'requests': copy.deepcopy(self.native(job)['requests'])}
        self.persist(state='running', phase='appearance', max_calls=5, evidence_token=evidence.token,
                     baseline=original, experts={}, requires_human_adjudication=[])

        tracked = self.native(job).get('motion_evidence', {}).get('tracked_parts')
        def request(phase, content, schema):
            if self.identity(self.s.store.load(self.job_id))[0] != identity:
                raise ConflictError('复核期间实际帧或播放合同发生变化')
            evidence.verify()
            if tracked:
                content = [*content, {'type': 'input_text', 'text':
                    'Native tracked part measurements on these exact frames. Inspect the cited regions; '
                    'these are localization cues, not automatic verdicts.\n' + json.dumps(tracked, ensure_ascii=False)}]
            result = call(phase, content, schema, len(frames))
            if self.identity(self.s.store.load(self.job_id))[0] != identity:
                raise ConflictError('复核期间实际帧或播放合同发生变化')
            return result

        try:
            selected = independent_followup(evidence, original, request, self.persist,
                lambda: self.native(self.s.store.load(self.job_id))['requests'],
                visibility_version=job.request.open_plan.visibility_review_version)
            from .prop_measurements import guard_measurements
            selected = guard_measurements(selected, tracked)
            if selected.get('requires_human_adjudication'):
                self.persist(requires_human_adjudication=selected['requires_human_adjudication'])
            # Keep the flat native request ledger untouched for budgets/history.
            return {**baseline, **selected, 'protocol': 'experts_v1', 'protocol_version': 3,
                    'expert_review': copy.deepcopy(self.details)}
        except Exception as exc:
            self.persist(state='failed', summary=str(exc) if isinstance(exc, (ConflictError, ValidationHarnessError))
                         else '增强复核未完成；请求和基线已保留，不自动重试。')
            raise
