"""Snapshot existing native frames without creating tasks or altering decisions."""
import hashlib

from ..errors import ConflictError, ValidationHarnessError
from .review_evaluation import ReviewEvidence
from .review_inputs import TIMING_NOTE, prop_review_context
from .visual_review import frame_digest


def snapshot_review(service, job_id, candidate_index, destination, *, expected_token, stage=None):
    # Read under the normal OS lock, not locked_job (which writes on exit).
    with service.store._process_lock(job_id, timeout_seconds=5):
        job = service.store.load(job_id)
        binding = job.request.open_plan
        if not binding or not binding.plan.quality:
            raise ValidationHarnessError('此动画没有开放动作验收合同')
        candidate = service._candidate(job, candidate_index)
        reference = service.store.job_dir(job_id) / 'input/reference.png'
        if hashlib.sha256(reference.read_bytes()).hexdigest() != job.reference_sha256:
            raise ConflictError('参考图已改变')
        input_pose = target = None
        target_note = ''
        if stage is None:
            token = frame_digest(candidate)
            frames = [{'path': f.active_path, 'sha256': f.sha256} for f in candidate.frames]
            if not frames:
                raise ValidationHarnessError('尚无已保存的完整动画')
            context = {'user_request': binding.spec.description,
                'quality_contract': binding.plan.quality.model_dump(mode='json'),
                'segment_motion_constraints': [s.motion.model_dump(mode='json') if s.motion else None for s in binding.plan.stages],
                'actual_stage_boundaries': candidate.plan_execution.timeline, 'timing_note': TIMING_NOTE}
        else:
            from .checkpoints import Checkpoints
            checkpoints = Checkpoints(service)
            evidence = checkpoints.evidence(job, candidate_index, stage)
            token, frames = evidence['token'], evidence['frames']
            previous = checkpoints.run_record(job, candidate_index, stage-1) if stage else None
            input_pose = reference if not stage else service.store.resolve_job_path(job_id, previous.accepted['frames'][-1]['path'])
            bound = next((t for t in binding.end_targets if t.stage == stage), None)
            if bound:
                target = service.store.job_dir(job_id)/'targets'/bound.filename
                target_note = bound.note
            context = {'segment': binding.plan.stages[stage].model_dump(mode='json'),
                'appearance': binding.plan.quality.appearance_contract,
                'user_request': binding.spec.description, 'seconds_per_frame': 1/job.action.fps}
        context.update(prop_review_context(binding, stage))
        if token != expected_token:
            raise ConflictError('动画版本已改变，请重新读取实际帧后评估')
        paths = [service.store.resolve_job_path(job_id, f['path']) for f in frames]
        for path, frame in zip(paths, frames):
            if hashlib.sha256(path.read_bytes()).hexdigest() != frame['sha256']:
                raise ConflictError('动画帧已改变，不能提交过期证据')
        from .adjustment_review import add_accepted_goals
        context=add_accepted_goals(context,candidate,stage)
        evidence = ReviewEvidence.create(destination, paths=paths, reference=reference, fps=job.action.fps,
            context=context, source={'job_id': job_id, 'candidate': candidate_index, 'stage': stage, 'token': token},
            input_pose=input_pose, target=target, target_note=target_note, segment=stage is not None)
        if [f['sha256'] for f in evidence.manifest['frames']] != [f['sha256'] for f in frames]:
            raise ConflictError('快照期间实际帧发生变化，未调用模型')
        return evidence
