"""Single-writer generation with explicit checkpoint acceptance; never auto-reroll."""
from __future__ import annotations

import hashlib
import io
import shutil

from PIL import Image

from ..errors import ConflictError, HarnessError, ProviderError, ValidationHarnessError
from ..jsonio import atomic_write_json, read_json
from ..models import CandidateStatus, utc_now
from ..providers.base import PollStatus, ProviderRequest
from ..providers.account import AccountSlotBusy, animation_intent_id
from .checkpoints import Checkpoints, checked_plan
from .state_chain import transition


def stage_seed(seed, stage):
    """Per-segment drawing seed. Experiment arms reuse this exact rule."""
    return (seed + stage * 104729) % (2**31 - 1) if seed is not None else None


class PlanGeneration:
    def __init__(self, service):
        self.s = service
        self.store = service.store

    def candidate(self, job, index):
        return self.s._candidate(job, index)

    def directory(self, job_id, index, stage):
        return self.store.job_dir(job_id) / "provider" / f"candidate_{index:02d}.plan" / str(stage)

    def validate(self, job, candidate):
        binding = job.request.open_plan
        if binding is None or candidate.plan_execution is None or job.plan_control is None:
            raise ConflictError("缺少已确认的生成方案")
        if binding.reference_sha256 != job.reference_sha256 or len(candidate.plan_execution.stages) != len(binding.plan.stages):
            raise ConflictError("执行记录与已确认方案不一致")
        from .repairs import generation_calls
        spent = generation_calls(job)
        if spent > binding.spec.budget.max_generation_calls:
            raise ConflictError("调用记录超过预算，停止执行")
        return candidate.plan_execution.stages

    def saved_frames(self, job_id, index, stage):
        folder = self.directory(job_id, index, stage)
        manifest = read_json(folder / "frames.json")
        frames = []
        for i, item in enumerate(manifest["frames"]):
            if item["filename"] != f"frame_{i:03d}.png":
                raise ConflictError("片段帧路径无效")
            data = (folder / item["filename"]).read_bytes()
            if hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise ConflictError("片段原始帧已改变，已停止衔接")
            frames.append(data)
        if not 1 <= len(frames) <= 64:
            raise ValidationHarnessError("片段没有有效的帧序列")
        return frames

    def submit(self, job_id, index, stage, provider):
        with self.store.submission_lock(timeout_seconds=max(180, self.s.settings.http_timeout_seconds + 60)):
            job = self.store.load(job_id); candidate = self.candidate(job, index)
            run = self.validate(job, candidate)[stage]
            if not job.plan_control.enabled:
                return False
            if run.state != "created" or run.submission_attempts:
                raise ConflictError("此片段已提交，禁止重复生成")
            from .repairs import generation_calls
            spent = generation_calls(job)
            if spent >= job.request.open_plan.spec.budget.max_generation_calls:
                raise ConflictError("本次生成调用已到上限")
            if shutil.disk_usage(self.s.settings.jobs_dir).free < 64 * 1024 * 1024:
                raise ValidationHarnessError("本机空间不足，尚未提交生成")
            definition = job.request.open_plan.plan.stages[stage]
            from .structure_control import require_current_structure
            require_current_structure(self.s,job.request.open_plan.visual_structure,job.reference_sha256)
            from .quality import compiled_prompt
            prompt = job.request.open_plan.compiled_prompts[stage] if job.request.open_plan.compiled_prompts else compiled_prompt(
                job.request.open_plan.plan, job.character, stage, policy_version=job.request.open_plan.generation_policy_version)
            reference = (self.store.job_dir(job_id) / "input/reference.png").read_bytes()
            if hashlib.sha256(reference).hexdigest() != job.reference_sha256:
                raise ConflictError("角色参考图已改变")
            first = reference if stage == 0 else self.saved_frames(job_id, index, stage - 1)[-1]
            if checked_plan(job):
                first = Checkpoints(self.s).input_frame(job,index,stage)
            from .targets import target_bytes
            last = target_bytes(self.s,job,stage)
            if last is None: last = reference if definition.last_frame == "original" else None
            request = ProviderRequest(reference_image=first, last_frame=last, prompt=prompt,
                                      frame_count=definition.frame_count,
                                      seed=stage_seed(candidate.seed, stage),
                                      transparent_background=True,
                                      local_submission_id=animation_intent_id(job_id, index, stage))
            from .generation_conditions import submission_conditions
            conditions = submission_conditions(job.request.open_plan,stage,prompt,hashlib.sha256(first).hexdigest(),
                                               hashlib.sha256(last).hexdigest() if last else None)
            self.s._check_submission_quota(job_id, index, provider, phase_frame_count=definition.frame_count)
            folder = self.directory(job_id, index, stage); folder.mkdir(parents=True, exist_ok=True)
            atomic_write_json(folder / "submit.intent.json", {"maximum_submission_attempts": 1,
                              "plan_sha256": job.request.open_plan.plan_sha256, "stage": stage,
                              "first_sha256": hashlib.sha256(first).hexdigest(),
                              "last_sha256": hashlib.sha256(last).hexdigest() if last else None,
                              "prompt": request.prompt, "frame_count": request.frame_count, "seed": request.seed,
                               **({'drawing_conditions':conditions} if conditions else {}),
                              **({'visual_structure_sha256':job.request.open_plan.visual_structure['sha256'],
                                  'structure_usage':definition.structure_usage.model_dump(mode='json'),
                                  'structure_drawing_hint':definition.motion.generation_hint}
                                 if job.request.open_plan.visual_structure else {})})
            with self.store.locked_job(job_id) as current:
                c = self.candidate(current, index); r = self.validate(current, c)[stage]
                if not current.plan_control.enabled:
                    return False
                if r.state != "created" or r.submission_attempts:
                    raise ConflictError("其他进程已提交此片段")
                r.state = "submitting"; r.submission_attempts = 1
                current.generation_account = current.generation_account or getattr(provider, 'account_fingerprint', None)
                c.status = CandidateStatus.submitting; c.provider_job_id = None
                c.submission_attempts = sum(v.submission_attempts+len(v.repairs) for v in c.plan_execution.stages)
                c.submission_started_at = utc_now(); c.provider_name = provider.name
                c.raw_request_path = (folder / "submit.intent.json").relative_to(self.store.job_dir(job_id)).as_posix()
                current.plan_control.message = f"正在提交：{definition.name}"
                self.s._refresh_job_status(current); current.touch("plan_stage_submitting", candidate_index=index, stage=stage)
            try:
                submission = provider.submit(request)
            except AccountSlotBusy:
                raise
            except Exception as exc:
                unknown = not isinstance(exc, ProviderError) or bool(exc.details.get("submission_unknown"))
                with self.store.locked_job(job_id) as current:
                    c = self.candidate(current, index); r = self.validate(current, c)[stage]
                    r.state = "unknown" if unknown else "failed"
                    c.status = CandidateStatus.submission_unknown if unknown else CandidateStatus.failed
                    if isinstance(exc, ProviderError):
                        c.provider_job_id = r.provider_job_id = exc.details.get("provider_job_id")
                        c.usage = r.usage = (exc.details.get("response") or {}).get("usage") or {}
                    c.error = exc.as_dict() if isinstance(exc, ProviderError) else {"code": "submission_unknown", "message": "提交结果未知，不能自动重发"}
                    r.error = c.error; current.plan_control.enabled = False
                    current.plan_control.message = "请核对原请求" if unknown else "生成请求失败，原记录已保留"
                    self.s._refresh_job_status(current); current.touch("plan_submission_stopped", stage=stage)
                if isinstance(exc, ProviderError) and exc.details.get("submission_rejected"):
                    return False
                raise
            # This receipt is durable before optional diagnostic files are saved.
            with self.store.locked_job(job_id) as current:
                c = self.candidate(current, index); r = self.validate(current, c)[stage]
                r.provider_job_id = submission.provider_job_id; r.state = "pending"
                c.usage = r.usage = submission.raw_response.get("usage") or {}
                c.provider_job_id = submission.provider_job_id; c.provider_status = submission.status
                c.status = CandidateStatus.provider_pending; c.submitted_at = utc_now()
                c.diagnostic_only = submission.diagnostic_only; c.error = None
                current.plan_control.message = f"正在生成：{definition.name}"
                self.s._refresh_job_status(current); current.touch("plan_stage_submitted", stage=stage, provider_job_id=submission.provider_job_id)
            atomic_write_json(folder / "submit.request.json", submission.request_record)
            atomic_write_json(folder / "submit.response.json", submission.raw_response)
            return True

    def poll(self, job_id, index, stage, provider, wait):
        job = self.store.load(job_id); c = self.candidate(job, index)
        run = self.validate(job, c)[stage]; folder = self.directory(job_id, index, stage)
        if not run.provider_job_id:
            raise ConflictError("缺少原请求编号，不能自动生成替代结果")
        if not (folder / "frames.json").exists():
            result = provider.wait(run.provider_job_id) if wait else provider.poll(run.provider_job_id)
            if result.status == PollStatus.pending:
                return False
            if result.status == PollStatus.failed:
                with self.store.locked_job(job_id) as current:
                    c = self.candidate(current, index); r = self.validate(current, c)[stage]
                    r.state = "failed"; r.error = result.error; c.error = result.error
                    c.usage = r.usage = result.usage or r.usage
                    c.status = CandidateStatus.failed; current.plan_control.enabled = False
                    current.plan_control.message = "此片段生成失败，已保留原请求"
                    self.s._refresh_job_status(current)
                return False
            if not 1 <= len(result.images) <= 64:
                raise ValidationHarnessError("片段返回的帧数无效")
            manifest = []
            for i, data in enumerate(result.images):
                with Image.open(io.BytesIO(data)) as image:
                    image.load()
                    if image.format != "PNG" or image.size != (job.character.cell_width, job.character.cell_height) or "A" not in image.getbands():
                        raise ValidationHarnessError("片段格式、尺寸或透明通道无效，不会用它继续生成")
                path = folder / f"frame_{i:03d}.png"
                if path.exists() and path.read_bytes() != data:
                    raise ConflictError("远端返回的片段发生变化，已有原始帧保留")
                self.s._atomic_write_bytes(path, data)
                manifest.append({"filename": path.name, "sha256": hashlib.sha256(data).hexdigest()})
            atomic_write_json(folder / "frames.json", {"provider_job_id": run.provider_job_id, "frames": manifest, "usage": result.usage})
        frames = self.saved_frames(job_id, index, stage)
        saved = read_json(folder / "frames.json")
        if saved["provider_job_id"] != run.provider_job_id:
            raise ConflictError("片段文件与远端请求不匹配")
        with self.store.locked_job(job_id) as current:
            c = self.candidate(current, index); r = self.validate(current, c)[stage]
            r.state = "complete"; r.actual_frame_count = len(frames); c.usage = r.usage = saved.get("usage") or r.usage
            c.status = CandidateStatus.saving if stage == len(c.plan_execution.stages) - 1 else CandidateStatus.created
            c.provider_completed_at = utc_now(); c.error = None
            current.plan_control.message = "片段已保存，准备检查实际姿势" if checked_plan(job) else "片段已保存，完整动作需人工确认"
            self.s._refresh_job_status(current); current.touch("plan_stage_saved", stage=stage, candidate_index=index)
        return True

    def assemble(self, job_id, index):
        job = self.store.load(job_id); c = self.candidate(job, index)
        runs = self.validate(job, c)
        if c.frames:
            return
        if not all(r.state == ('accepted' if checked_plan(job) else 'complete') for r in runs):
            raise ConflictError("片段尚未全部保存")
        combined, timeline = [], []
        mapping = []
        if checked_plan(job):
            checkpoints = Checkpoints(self.s)
            for stage, definition in enumerate(job.request.open_plan.plan.stages):
                frames = checkpoints.accepted_frames(job,index,stage)
                accepted = runs[stage].accepted
                timeline.append({'name':definition.name,'start':len(combined),'count':len(frames),
                                 'checkpoint_token':accepted['token'],'anchor_sha256':accepted['anchor_sha256'],
                                 'selected_anchor_frame':accepted.get('selected_anchor_frame'),
                                 'excluded_tail_count':len(accepted.get('excluded_tail',[])),
                                 'context_removed':accepted['context_removed'],'technical_only':False})
                edge = transition(job.request.open_plan.plan, stage)
                if edge:
                    timeline[-1].update(edge, input_sha256=accepted['input_sha256'])
                for item, data in zip(accepted['frames'],frames):
                    mapping.append({'frame':len(combined),'stage':stage,'raw_frame':item['raw_index'],
                                    **{k:item[k] for k in ('repair_attempt','repair_index') if k in item}})
                    combined.append(data)
                prop = job.request.open_plan.plan.quality.interactable
                if prop and stage == len(runs) - 1 and prop.hold_frames:
                    # Playback entries point to the already confirmed real endpoint.
                    timeline[-1].update(count=len(frames) + prop.hold_frames, hold_frames=prop.hold_frames)
                    source = mapping[-1].copy()
                    for _ in range(prop.hold_frames):
                        mapping.append({**source, 'frame': len(combined), 'playback_hold': True})
                        combined.append(frames[-1])
        elif job.request.open_plan.plan.quality:
            from .quality import assemble_quality_frames
            raw = [self.saved_frames(job_id,index,i) for i in range(len(runs))]
            combined, timeline, mapping = assemble_quality_frames(raw,job.request.open_plan.plan.stages,
                (self.store.job_dir(job_id)/'input/reference.png').read_bytes())
        else:
            for stage, definition in enumerate(job.request.open_plan.plan.stages):
                frames = self.saved_frames(job_id, index, stage)
                timeline.append({"name": definition.name, "start": len(combined), "count": len(frames), "technical_only": True})
                combined.extend(frames)
        if len(combined) > 64:
            raise ValidationHarnessError("实际动画超过 64 帧；原始片段已保留，未自动丢弃帧")
        with self.store.locked_job(job_id) as current:
            c = self.candidate(current, index); c.plan_execution.timeline = timeline
            c.plan_execution.actual_frame_count = len(combined)
            c.plan_execution.frame_mapping = mapping
            c.status = CandidateStatus.saving; c.provider_job_id = runs[-1].provider_job_id
        if self.s._store_provider_frames(job_id, index, combined, diagnostic_only=c.diagnostic_only,
                                         expected_provider_job_id=runs[-1].provider_job_id):
            self.s.check_candidate(job_id, index)

    def finish(self, job_id, index):
        try:
            self.assemble(job_id, index)
            from .visual_review import QualityReviewer
            QualityReviewer(self.s).run(job_id,index)
        except (HarnessError, OSError) as exc:
            with self.store.locked_job(job_id) as job:
                candidate = self.candidate(job, index)
                candidate.error = exc.as_dict() if isinstance(exc, HarnessError) else {"code": "frame_storage_error", "message": "无法保存完整动画，原始片段已保留", "details": {"type":type(exc).__name__,"errno":exc.errno,"winerror":getattr(exc,"winerror",None)}}
                candidate.status = CandidateStatus.failed
                candidate.provider_status = "completed"
                job.plan_control.enabled = False
                job.plan_control.message = "完整动画校验未通过，已停止；请检查原始片段"
                self.s._refresh_job_status(job)
                job.touch("plan_assembly_stopped")
            raise

    def stop_stage(self, job_id, index, stage, exc):
        with self.store.locked_job(job_id) as job:
            c = self.candidate(job,index)
            c.error = exc.as_dict()
            c.plan_execution.stages[stage].error = c.error
            c.plan_execution.stages[stage].state = 'failed'
            c.status = CandidateStatus.failed
            job.plan_control.enabled = False
            job.plan_control.message = '实际片段或姿势快照校验未通过，已停止后续请求'
            self.s._refresh_job_status(job)
            job.touch('open_motion_checkpoint_integrity_stopped',stage=stage,candidate_index=index)

    def inspect_stage(self, job_id, index, stage):
        try:
            Checkpoints(self.s).inspect(job_id,index,stage)
        except (ValidationHarnessError,ConflictError) as exc:
            self.stop_stage(job_id,index,stage,exc)
            raise

    def advance(self, job_id, provider, *, wait=False, candidate_index=None, allow_submit=True):
        with self.store.operation_lock(job_id, "open_plan", timeout_seconds=0.2):
            job = self.store.load(job_id)
            if not self.s._same_generation_account(job, provider):
                return job
            selected_index = candidate_index if candidate_index is not None else job.queued_candidate_index
            targets = [selected_index] if selected_index is not None else [c.candidate_index for c in job.candidates]
            for index in targets:
                existing = self.candidate(self.store.load(job_id), index)
                if existing.frames and job.request.open_plan.plan.quality:
                    from .visual_review import QualityReviewer
                    QualityReviewer(self.s).run(job_id,index)
                if existing.frames or existing.status in {CandidateStatus.failed, CandidateStatus.approved, CandidateStatus.rejected}:
                    continue
                for _ in range(5 if wait else 1):
                    job = self.store.load(job_id); c = self.candidate(job, index); runs = self.validate(job, c)
                    if c.frames or c.status in {CandidateStatus.failed, CandidateStatus.approved, CandidateStatus.rejected}:
                        break
                    finished_state = 'accepted' if checked_plan(job) else 'complete'
                    if all(r.state == finished_state for r in runs):
                        self.finish(job_id, index); break
                    stage = next(i for i, r in enumerate(runs) if r.state != finished_state)
                    run = runs[stage]
                    if run.state == 'repairing':
                        from .repairs import LocalRepairs
                        LocalRepairs(self.s).poll(job_id,index,stage,provider)
                        break
                    if checked_plan(job) and run.state in {'complete','reviewing','awaiting_review','rejected'}:
                        self.inspect_stage(job_id,index,stage)
                        break
                    if run.state in {"submitting", "unknown", "failed"}:
                        # The operation lock is free after a crashed submitting call.
                        if run.state == "submitting":
                            with self.store.locked_job(job_id) as current:
                                current_candidate = self.candidate(current, index)
                                current_run = current_candidate.plan_execution.stages[stage]
                                receipt = self.s._recover_submission_receipt(current, current_candidate, stage=stage)
                                if receipt:
                                    current_run.provider_job_id = receipt['jobId']
                                    current_run.usage = receipt['usage']
                                    current_run.state = 'pending'
                                    current.plan_control.message = "已恢复上游任务回执，继续读取原片段"
                                else:
                                    current_run.state = "unknown"
                                    current_candidate.status = CandidateStatus.submission_unknown
                                    current.plan_control.enabled = False
                                    current.plan_control.message = "提交曾被中断，请核对原请求；不会重发"
                                self.s._refresh_job_status(current)
                        break
                    if run.state == "created":
                        if not allow_submit or not job.plan_control.enabled:
                            break
                        try:
                            if not self.submit(job_id, index, stage, provider): break
                        except AccountSlotBusy as exc:
                            self.s._queue_candidate(job_id, index, exc, provider, stage=stage, selected_index=selected_index)
                            return self.store.load(job_id)
                        except (ValidationHarnessError,ConflictError) as exc:
                            self.stop_stage(job_id,index,stage,exc)
                            raise
                    try:
                        if not self.poll(job_id, index, stage, provider, wait):
                            break
                    except (ValidationHarnessError, ConflictError) as exc:
                        with self.store.locked_job(job_id) as current:
                            candidate = self.candidate(current, index)
                            candidate.error = exc.as_dict()
                            candidate.status = CandidateStatus.failed
                            candidate.provider_status = "completed"
                            candidate.plan_execution.stages[stage].error = exc.as_dict()
                            current.plan_control.enabled = False
                            current.plan_control.message = "片段校验未通过，已停止衔接；可查询原请求取回结果"
                            self.s._refresh_job_status(current)
                            current.touch("plan_stage_validation_failed", stage=stage)
                        raise
                    if stage == len(runs) - 1:
                        if checked_plan(job):
                            self.inspect_stage(job_id,index,stage); break
                        self.finish(job_id, index); break
                    if checked_plan(job):
                        self.inspect_stage(job_id,index,stage); break
                current = self.store.load(job_id); candidate = self.candidate(current, index)
                if not wait or not candidate.frames:
                    break
        return self.store.load(job_id)
