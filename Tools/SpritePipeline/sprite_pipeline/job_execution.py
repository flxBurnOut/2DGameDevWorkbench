"""Provider submission, polling and recovery for durable animation Jobs."""
from __future__ import annotations

import hashlib
import re
import shutil
from datetime import timedelta
from typing import Any

from .errors import ConflictError, HarnessError, ProviderError, ProviderTemporaryError, ValidationHarnessError
from .jsonio import atomic_write_json, relative_posix
from .models import CandidateStatus, JobRecord, JobStatus, utc_now
from .providers.account import AccountSlotBusy, PixelLabSlot, animation_intent_id


class NativeJobExecution:
    def __init__(self, service):
        self.service = service
        self.store = service.store

    def generate_job(
        self,
        job_id: str,
        *,
        wait: bool = True,
        candidate_index: int | None = None,
    ) -> JobRecord:
        """Generate candidates serially, or advance one async unit when ``wait`` is false."""

        from .providers import get_provider

        job = self.store.load(job_id)
        if job.request.provider == "import":
            raise ValidationHarnessError("import jobs accept frames through ingest, not generate")
        if job.motion_control and job.generation_requested_at is None and not any(c.submission_attempts for c in job.candidates):
            from .vision_review import VisionReviewer
            if not VisionReviewer(self.service.settings).configured:
                raise ValidationHarnessError("请先在设置中保存 视觉检查 API Key；尚未提交生成")
        provider = get_provider(job.request.provider, self.service.settings)
        self.service.reconcile_saved_results(job_id)
        job = self.store.load(job_id)
        if not self.service._same_generation_account(job, provider):
            return job
        if any(c.attack_sequence for c in job.candidates):
            from .attack_sequence import FixedAttackGeneration
            return FixedAttackGeneration(self.service).advance(job_id,provider,wait=wait,candidate_index=candidate_index)
        if job.request.open_plan:
            from .collaboration.execution import PlanGeneration
            return PlanGeneration(self.service).advance(job_id, provider, wait=wait, candidate_index=candidate_index)
        if candidate_index is not None:
            targets = [self.service._candidate(job, candidate_index).candidate_index]
        else:
            targets = [candidate.candidate_index for candidate in job.candidates]

        pending_other = [
            candidate.candidate_index
            for candidate in job.candidates
            if candidate.status
            in (
                CandidateStatus.submitting,
                CandidateStatus.submission_unknown,
                CandidateStatus.provider_pending,
                CandidateStatus.saving,
            )
            and candidate.candidate_index not in targets
        ]
        if pending_other:
            raise ConflictError("another candidate is already pending", details={"candidate_indices": pending_other})

        for index in targets:
            current = self.store.load(job_id)
            candidate = self.service._candidate(current, index)
            if candidate.status in (
                CandidateStatus.received,
                CandidateStatus.check_failed,
                CandidateStatus.review_ready,
                CandidateStatus.approved,
                CandidateStatus.rejected,
            ):
                continue
            if candidate.status == CandidateStatus.failed:
                continue
            if candidate.status in (CandidateStatus.submitting, CandidateStatus.submission_unknown):
                raise ConflictError(
                    "submission outcome is unknown; automatic resubmission is disabled",
                    details={
                        "candidate_index": index,
                        "provider_job_id": candidate.provider_job_id,
                        "safe_to_retry": False,
                    },
                )
            if candidate.status == CandidateStatus.created:
                # The browser, REST API, and CLI all share this OS-backed lock.
                # A live balance check and the only chargeable POST therefore
                # cannot race one another in separate local processes.
                with self.store.submission_lock(
                    timeout_seconds=max(180.0, self.service.settings.http_timeout_seconds + 60.0)
                ):
                    locked_snapshot = self.store.load(job_id)
                    if not self.service._same_generation_account(locked_snapshot, provider):
                        return locked_snapshot
                    locked_candidate = self.service._candidate(locked_snapshot, index)
                    if locked_candidate.status == CandidateStatus.created:
                        try:
                            self._check_submission_quota(job_id, index, provider)
                            self._submit_candidate(job_id, index, provider)
                        except AccountSlotBusy as exc:
                            self._queue_candidate(job_id, index, exc, provider, selected_index=candidate_index)
                            break
                current = self.store.load(job_id)
                candidate = self.service._candidate(current, index)
                if current.status == JobStatus.not_submitted:
                    break
            if candidate.status not in (CandidateStatus.provider_pending, CandidateStatus.saving) or not candidate.provider_job_id:
                continue
            if current.generation_requested_at is None:
                with self.store.locked_job(job_id) as requested_job:
                    requested_job.generation_requested_at = utc_now()
                    requested_job.touch("generation_requested")
            should_wait = wait or provider.diagnostic_only
            self._poll_candidate(job_id, index, provider, wait=should_wait)
            advanced = self.service._candidate(self.store.load(job_id), index)
            if advanced.status == CandidateStatus.provider_pending:
                break
            if not wait:
                break
        from .motion_correction import MotionCorrection
        return MotionCorrection(self.service).advance(job_id, wait=wait)

    def _check_submission_quota(
        self,
        job_id: str,
        candidate_index: int,
        provider: Any,
        *, phase_frame_count: int | None = None,
    ) -> None:
        """Check and durably record quota immediately before each planned paid POST."""

        if provider.name != "pixellab" or getattr(provider, "get_balance", None) is None:
            return
        check_slot = getattr(provider, "check_account_slot", None)
        if check_slot is not None:
            check_slot()
        try:
            snapshot = self.service._refresh_balance_with_provider(provider)
        except ProviderError as exc:
            error = ValidationHarnessError('无法读取 PixelLab 余额，未提交动画。', details={'submission_created': False})
            with self.store.locked_job(job_id) as job:
                self.service._candidate(job, candidate_index).error = error.as_dict()
                self.service._refresh_job_status(job)
                job.touch('generation_balance_unavailable', candidate_index=candidate_index)
            raise error from exc
        remaining = self.service._remaining_generations(snapshot)
        job = self.store.load(job_id)
        first_submission = job.generation_requested_at is None or (
            job.status == JobStatus.queued and not job.request.open_plan and not any(c.submitted_at for c in job.candidates)
        )
        created_candidates = sum(
            candidate.status == CandidateStatus.created
            for candidate in job.candidates
        )
        candidates_to_reserve = (
            created_candidates
            if first_submission
            else 1
        )
        units_per_candidate = self.service._pixellab_generation_units(
            job.character.cell_width,
            job.character.cell_height,
            job.action.generation_frame_count,
        )
        if phase_frame_count is not None:
            units_per_candidate = self.service._pixellab_generation_units(job.character.cell_width,job.character.cell_height,phase_frame_count)
            if first_submission:
                # Existing jobs retain their reserved stage counts after rhythm defaults change.
                stages=self.service._candidate(job,candidate_index).attack_sequence['stages']
                units_per_candidate = sum(self.service._pixellab_generation_units(job.character.cell_width,job.character.cell_height,r['frame_count']) for r in stages)
        required_units = units_per_candidate * candidates_to_reserve
        shortfall = remaining is not None and required_units > remaining and self.service._available_credit(snapshot) == 0
        with self.store.locked_job(job_id) as quota_job:
            if quota_job.quota_before is None:
                quota_job.quota_before = snapshot
            quota_candidate = self.service._candidate(quota_job, candidate_index)
            quota_job.touch(
                "generation_quota_checked",
                candidate_index=candidate_index,
                remaining=remaining,
                requested_candidates=candidates_to_reserve,
                generation_units_per_candidate=units_per_candidate,
                requested_generation_units=required_units,
                chargeable_submission_created=False,
            )
            if shortfall:
                quota_candidate.error = {
                    "code": "insufficient_quota",
                    "message": "not enough PixelLab generations remain",
                    "details": {
                        "remaining": remaining,
                        "requested_candidates": candidates_to_reserve,
                        "generation_units_per_candidate": units_per_candidate,
                        "requested_generation_units": required_units,
                        "submission_created": False,
                    },
                }
                self.service._refresh_job_status(quota_job)
                quota_job.touch(
                    "generation_blocked_by_quota",
                    candidate_index=candidate_index,
                    remaining=remaining,
                    requested_candidates=candidates_to_reserve,
                    generation_units_per_candidate=units_per_candidate,
                    requested_generation_units=required_units,
                    chargeable_submission_created=False,
                )
            elif (quota_candidate.error or {}).get("code") == "insufficient_quota":
                quota_candidate.error = None
                self.service._refresh_job_status(quota_job)
                quota_job.touch(
                    "generation_quota_available",
                    candidate_index=candidate_index,
                    remaining=remaining,
                    chargeable_submission_created=False,
                )
        if shortfall:
            raise ValidationHarnessError(
                "not enough PixelLab generation units remain for every requested candidate",
                details={
                    "remaining": remaining,
                    "requested_candidates": candidates_to_reserve,
                    "generation_units_per_candidate": units_per_candidate,
                    "requested_generation_units": required_units,
                    "candidate_index": candidate_index,
                    "submission_created": False,
                },
            )

    def _queue_candidate(self, job_id, index, error, provider, *, stage=None, selected_index=None):
        with self.store.locked_job(job_id) as job:
            candidate = self.service._candidate(job, index)
            if candidate.status == CandidateStatus.created and (candidate.error or {}).get('code') == error.code:
                return
            if candidate.status == CandidateStatus.submitting:
                candidate.status = CandidateStatus.created
                candidate.submission_started_at = None
                candidate.submission_attempts -= 1
                if stage is not None and candidate.plan_execution:
                    run = candidate.plan_execution.stages[stage]
                    run.state = 'created'; run.submission_attempts = 0
                elif stage is not None and candidate.attack_sequence:
                    candidate.attack_sequence['stages'][stage].update(state='created', submission_attempts=0)
            candidate.error = error.as_dict()
            job.generation_requested_at = job.generation_requested_at or utc_now()
            job.queued_candidate_index = selected_index
            job.generation_account = job.generation_account or getattr(provider, 'account_fingerprint', None)
            if job.plan_control:
                job.plan_control.message = error.message
            self.service._refresh_job_status(job)
            job.touch('generation_waiting_for_account', candidate_index=index, stage=stage)

    def _recover_submission_receipt(self, job, candidate, *, stage=None):
        if job.request.provider != 'pixellab' or not self.service.settings.pixellab_api_key:
            return None
        slot = PixelLabSlot(self.service.settings, self.store)
        if job.generation_account and job.generation_account != slot.key:
            return None
        receipt = slot.accepted_receipt(animation_intent_id(job.job_id, candidate.candidate_index, stage))
        if receipt:
            candidate.status = CandidateStatus.provider_pending
            candidate.provider_job_id = receipt['jobId']
            candidate.provider_status = receipt['status']
            candidate.usage = receipt['usage']
            candidate.submitted_at = candidate.submission_started_at or utc_now()
            candidate.error = None
            job.touch('provider_receipt_recovered', candidate_index=candidate.candidate_index, stage=stage)
        return receipt

    def recover_completed_candidate(
        self,
        job_id: str,
        candidate_index: int,
    ) -> JobRecord:
        """Poll an existing PixelLab job again without submitting a new generation."""

        from .providers import get_provider

        snapshot = self.store.load(job_id)
        if snapshot.request.open_plan:
            from .collaboration.execution import PlanGeneration
            with self.store.locked_job(job_id) as current:
                candidate = self.service._candidate(current, candidate_index)
                if candidate.frames:
                    return current
                if not any(r.state in {"pending", "complete"} for r in candidate.plan_execution.stages):
                    raise ConflictError("没有可查询的原请求，请先核对远端编号")
                if candidate.status == CandidateStatus.failed and candidate.provider_status == "completed":
                    candidate.status = CandidateStatus.provider_pending
                    candidate.error = None
            return PlanGeneration(self.service).advance(job_id, get_provider(snapshot.request.provider, self.service.settings),
                                                candidate_index=candidate_index, allow_submit=False)
        if snapshot.request.provider != "pixellab":
            raise ValidationHarnessError(
                "only PixelLab candidates can be recovered from an existing provider job"
            )
        candidate = self.service._candidate(snapshot, candidate_index)
        if not candidate.provider_job_id:
            raise ConflictError(
                "candidate has no existing provider job to recover",
                details={"candidate_index": candidate_index},
            )
        if candidate.frames:
            raise ConflictError(
                "candidate already contains usable frames",
                details={"candidate_index": candidate_index},
            )
        recoverable_failure = (
            candidate.status == CandidateStatus.failed
            and candidate.provider_status == "completed"
            and (candidate.error or {}).get("code")
            in {"provider_contract_error", "provider_frame_storage_error", "validation_error"}
        )
        if candidate.status not in (CandidateStatus.provider_pending, CandidateStatus.saving) and not recoverable_failure:
            raise ConflictError(
                "candidate is not a recoverable completed or pending provider job",
                details={
                    "candidate_index": candidate_index,
                    "status": candidate.status.value,
                    "provider_status": candidate.provider_status,
                    "error_code": (candidate.error or {}).get("code"),
                },
            )

        provider = get_provider("pixellab", self.service.settings)
        if candidate.attack_sequence:
            from .attack_sequence import FixedAttackGeneration
            return FixedAttackGeneration(self.service).recover(job_id,candidate_index,provider)
        provider_job_id = candidate.provider_job_id
        with self.store.locked_job(job_id) as job:
            current = self.service._candidate(job, candidate_index)
            if current.frames:
                return job
            if current.provider_job_id != provider_job_id:
                raise ConflictError(
                    "candidate provider job changed before recovery",
                    details={"candidate_index": candidate_index},
                )
            current.status = CandidateStatus.provider_pending
            current.error = None
            self.service._refresh_job_status(job)
            job.touch(
                "candidate_recovery_started",
                candidate_index=candidate_index,
                provider_job_id=provider_job_id,
                submission_created=False,
            )

        # This path deliberately calls only poll/GET. It never invokes
        # provider.submit, so recovering paid output cannot create another job.
        self._poll_candidate(job_id, candidate_index, provider, wait=False)
        return self.store.load(job_id)

    def _submit_candidate(self, job_id: str, candidate_index: int, provider: Any) -> None:
        from .providers import ProviderRequest

        snapshot = self.store.load(job_id)
        snapshot_candidate = self.service._candidate(snapshot, candidate_index)
        reference_bytes = (self.store.job_dir(job_id) / "input" / "reference.png").read_bytes()
        actual_reference_sha = hashlib.sha256(reference_bytes).hexdigest()
        if actual_reference_sha != snapshot.reference_sha256:
            raise ValidationHarnessError(
                "reference snapshot changed after job creation",
                details={
                    "expected_sha256": snapshot.reference_sha256,
                    "actual_sha256": actual_reference_sha,
                },
            )
        edit_frames = None
        if snapshot.request.motion_repair is not None:
            from .motion_correction import MotionCorrection
            edit_frames, edit_prompt = MotionCorrection(self.service).generation_inputs(snapshot.request)
            if reference_bytes != edit_frames[0] or snapshot.full_prompt != edit_prompt:
                raise ValidationHarnessError("locked motion correction inputs changed")
        last_frame = None
        if snapshot.request.attack_segment is not None:
            from .attack_plans import AttackPlans
            first, last_frame, prompt = AttackPlans(self.service).generation_inputs(snapshot.request)
            last_path = self.store.job_dir(job_id) / "input" / "last_frame.png"
            if (reference_bytes != first or last_path.read_bytes() != last_frame
                    or snapshot.full_prompt != prompt or len(snapshot.candidates) != 1):
                raise ValidationHarnessError("locked attack segment inputs changed")
        estimated_result_bytes = max(
            64 * 1024 * 1024,
            snapshot.character.cell_width
            * snapshot.character.cell_height
            * 4
            * snapshot.action.generation_frame_count
            * 12,
        )
        free_bytes = shutil.disk_usage(self.service.settings.jobs_dir).free
        if free_bytes < estimated_result_bytes:
            raise ValidationHarnessError(
                "not enough free disk space to safely preserve the provider result",
                details={
                    "free_bytes": free_bytes,
                    "required_headroom_bytes": estimated_result_bytes,
                },
            )
        request = ProviderRequest(
            reference_image=reference_bytes,
            prompt=snapshot.full_prompt,
            frame_count=snapshot.action.generation_frame_count,
            seed=snapshot_candidate.seed,
            transparent_background=snapshot.character.transparent_background,
            last_frame=last_frame,
            edit_frames=edit_frames,
            local_submission_id=animation_intent_id(job_id, candidate_index),
        )
        provider_dir = self.store.job_dir(job_id) / "provider"
        intent_path = provider_dir / f"{snapshot_candidate.candidate_id}.submit.intent.json"
        atomic_write_json(
            intent_path,
            {
                "schema_version": 1,
                "job_id": job_id,
                "candidate_index": candidate_index,
                "provider": provider.name,
                "request_key": snapshot.request.request_key,
                "request_fingerprint": snapshot.request_fingerprint,
                "reference_sha256": snapshot.reference_sha256,
                "prompt_sha256": hashlib.sha256(snapshot.full_prompt.encode("utf-8")).hexdigest(),
                "frame_count": request.frame_count,
                "seed": request.seed,
                "transparent_background": request.transparent_background,
                "created_at": utc_now().isoformat(),
                "maximum_submission_attempts": 1,
                "storage_headroom_bytes": free_bytes,
                "required_storage_headroom_bytes": estimated_result_bytes,
            },
        )
        with self.store.locked_job(job_id) as job:
            candidate = self.service._candidate(job, candidate_index)
            if candidate.status != CandidateStatus.created:
                raise ConflictError("candidate is not ready for submission", details={"status": candidate.status.value})
            pending_other = [
                item.candidate_index
                for item in job.candidates
                if item.candidate_index != candidate_index
                and item.status
                in (
                    CandidateStatus.submitting,
                    CandidateStatus.submission_unknown,
                    CandidateStatus.provider_pending,
                    CandidateStatus.saving,
                )
            ]
            if pending_other:
                raise ConflictError(
                    "another candidate is already pending",
                    details={"candidate_indices": pending_other},
                )
            candidate.status = CandidateStatus.submitting
            job.generation_account = job.generation_account or getattr(provider, 'account_fingerprint', None)
            if job.generation_requested_at is None:
                job.generation_requested_at = utc_now()
                job.touch("generation_requested")
            candidate.submission_started_at = utc_now()
            candidate.submission_attempts = 1
            candidate.provider_name = provider.name
            candidate.provider_model = ("edit-animation-v2" if snapshot.request.motion_repair else "animate-with-text-v3") if provider.name == "pixellab" else "diagnostic-continuity-v2"
            candidate.raw_request_path = relative_posix(intent_path, self.store.job_dir(job_id))
            job.status = JobStatus.submitting
            job.touch("candidate_submitting", candidate_index=candidate_index, provider=provider.name)
        try:
            submission = provider.submit(request)
        except AccountSlotBusy:
            raise
        except ProviderError as exc:
            with self.store.locked_job(job_id) as failed_job:
                failed = self.service._candidate(failed_job, candidate_index)
                submission_unknown = bool(exc.details.get("submission_unknown"))
                failed.status = CandidateStatus.submission_unknown if submission_unknown else CandidateStatus.failed
                failed.provider_job_id = exc.details.get("provider_job_id")
                failed.usage = (exc.details.get("response") or {}).get("usage") or {}
                failed.error = exc.as_dict()
                self.service._refresh_job_status(failed_job)
                failed_job.touch(
                    "candidate_submission_unknown" if submission_unknown else "candidate_submission_failed",
                    candidate_index=candidate_index,
                    error=exc.as_dict(),
                )
            if exc.details.get("submission_rejected"):
                return
            raise

        # Persist the provider ID before optional audit records. Once this save
        # succeeds, a process crash or page refresh can always resume with GET
        # and will never need to repeat the chargeable POST.
        with self.store.locked_job(job_id) as submitted_job:
            submitted = self.service._candidate(submitted_job, candidate_index)
            if submitted.status != CandidateStatus.submitting:
                raise ConflictError(
                    "candidate changed while provider submission was in flight",
                    details={"status": submitted.status.value},
                )
            submitted.provider_job_id = submission.provider_job_id
            submitted.provider_status = submission.status
            submitted.diagnostic_only = submission.diagnostic_only
            submitted.submitted_at = utc_now()
            submitted.status = CandidateStatus.provider_pending
            submitted.usage = submission.raw_response.get("usage") or {}
            submitted.error = None
            submitted_job.status = JobStatus.provider_pending
            submitted_job.touch(
                "candidate_submitted",
                candidate_index=candidate_index,
                provider_job_id=submission.provider_job_id,
                diagnostic_only=submission.diagnostic_only,
            )

        request_path = provider_dir / f"{snapshot_candidate.candidate_id}.submit.request.json"
        response_path = provider_dir / f"{snapshot_candidate.candidate_id}.submit.response.json"
        try:
            atomic_write_json(request_path, submission.request_record)
            atomic_write_json(response_path, submission.raw_response)
        except Exception as exc:
            with self.store.locked_job(job_id) as audit_job:
                submitted = self.service._candidate(audit_job, candidate_index)
                if submitted.provider_job_id == submission.provider_job_id:
                    submitted.error = {
                        "code": "submission_audit_write_failed",
                        "message": "provider job ID is safe, but local audit metadata could not be written",
                        "details": {"type": type(exc).__name__},
                    }
                    audit_job.touch(
                        "submission_audit_write_failed",
                        candidate_index=candidate_index,
                        provider_job_id=submission.provider_job_id,
                    )
            return

        with self.store.locked_job(job_id) as audit_job:
            submitted = self.service._candidate(audit_job, candidate_index)
            if submitted.provider_job_id != submission.provider_job_id:
                return
            submitted.raw_request_path = relative_posix(request_path, self.store.job_dir(job_id))
            submitted.raw_response_path = relative_posix(response_path, self.store.job_dir(job_id))
            audit_job.touch(
                "candidate_submission_audit_saved",
                candidate_index=candidate_index,
                provider_job_id=submission.provider_job_id,
            )

    def _poll_candidate(self, job_id: str, candidate_index: int, provider: Any, *, wait: bool) -> None:
        from .providers import PollStatus

        operation = f"candidate_{candidate_index:02d}.poll"
        with self.store.operation_lock(job_id, operation):
            job = self.store.load(job_id)
            candidate = self.service._candidate(job, candidate_index)
            if candidate.status not in (CandidateStatus.provider_pending, CandidateStatus.saving) or not candidate.provider_job_id:
                return
            provider_job_id = candidate.provider_job_id
            candidate_id = candidate.candidate_id
            try:
                result = provider.wait(provider_job_id) if wait else provider.poll(provider_job_id)
            except ProviderTemporaryError as exc:
                updated = False
                with self.store.locked_job(job_id) as pending_job:
                    pending = self.service._candidate(pending_job, candidate_index)
                    if self.service._is_current_poll_target(pending, provider_job_id):
                        pending.error = exc.as_dict()
                        pending.last_polled_at = utc_now()
                        self.service._refresh_job_status(pending_job)
                        pending_job.touch("candidate_poll_deferred", candidate_index=candidate_index, error=exc.as_dict())
                        updated = True
                if wait and updated:
                    raise
                return
            except ProviderError as exc:
                updated = False
                with self.store.locked_job(job_id) as failed_job:
                    failed = self.service._candidate(failed_job, candidate_index)
                    if self.service._is_current_poll_target(failed, provider_job_id):
                        failed.error = exc.as_dict()
                        failed.last_polled_at = utc_now()
                        failed.status = CandidateStatus.failed
                        self.service._refresh_job_status(failed_job)
                        failed_job.touch("candidate_poll_failed", candidate_index=candidate_index, error=exc.as_dict())
                        updated = True
                if updated:
                    raise
                return

            response_path = self.store.job_dir(job_id) / "provider" / f"{candidate_id}.poll.response.json"
            response_audit_saved = False
            response_audit_error: dict[str, Any] | None = None
            try:
                atomic_write_json(response_path, result.raw_response)
                response_audit_saved = True
            except Exception as exc:
                # The bounded provider response is useful audit metadata, but a
                # write failure here must never discard completed paid images
                # already present in memory.
                response_audit_error = {
                    "type": type(exc).__name__,
                    "message": str(exc),
                }
            with self.store.locked_job(job_id) as polled_job:
                polled = self.service._candidate(polled_job, candidate_index)
                if not self.service._is_current_poll_target(polled, provider_job_id):
                    return
                if response_audit_saved:
                    polled.raw_response_path = relative_posix(
                        response_path,
                        self.store.job_dir(job_id),
                    )
                elif response_audit_error is not None:
                    polled_job.touch(
                        "poll_audit_write_failed",
                        candidate_index=candidate_index,
                        provider_job_id=provider_job_id,
                        error=response_audit_error,
                    )
                polled.provider_status = result.provider_status
                polled.last_polled_at = utc_now()
                polled.usage = result.usage or polled.usage
                polled.error = result.error
                if result.status == PollStatus.pending:
                    polled.status = CandidateStatus.provider_pending
                    self.service._refresh_job_status(polled_job)
                    polled_job.touch("candidate_provider_pending", candidate_index=candidate_index)
                    return
                if result.status == PollStatus.failed:
                    retryable = bool((result.error or {}).get("details", {}).get("retryable"))
                    polled.status = CandidateStatus.provider_pending if retryable else CandidateStatus.failed
                    self.service._refresh_job_status(polled_job)
                    polled_job.touch(
                        "candidate_provider_wait_incomplete" if retryable else "candidate_provider_failed",
                        candidate_index=candidate_index,
                        error=result.error,
                    )
                    return
                polled.status = CandidateStatus.saving
                polled.provider_completed_at = utc_now()
                polled.error = None
                self.service._refresh_job_status(polled_job)
                polled_job.touch(
                    "candidate_provider_completed",
                    candidate_index=candidate_index,
                    provider_job_id=provider_job_id,
                )

            try:
                stored = self.service._store_provider_frames(
                    job_id,
                    candidate_index,
                    result.images,
                    diagnostic_only=result.diagnostic_only,
                    expected_provider_job_id=provider_job_id,
                )
            except Exception as exc:
                error = (
                    exc.as_dict()
                    if isinstance(exc, HarnessError)
                    else {
                        "code": "provider_frame_storage_error",
                        "message": str(exc),
                        "details": {"type": type(exc).__name__},
                    }
                )
                with self.store.locked_job(job_id) as failed_job:
                    failed = self.service._candidate(failed_job, candidate_index)
                    if self.service._is_current_poll_target(failed, provider_job_id):
                        # The paid provider result may still be downloadable.
                        # Keep the candidate recoverable and let the background
                        # worker retry safe GET/storage operations only.
                        failed.status = CandidateStatus.saving
                        failed.error = error
                        self.service._refresh_job_status(failed_job)
                        failed_job.touch("provider_frame_storage_failed", candidate_index=candidate_index, error=error)
                raise
            if stored:
                self.service.check_candidate(job_id, candidate_index)
                if getattr(provider, "get_balance", None) is not None:
                    try:
                        quota_after = self.service._refresh_balance_with_provider(provider)
                        with self.store.locked_job(job_id) as quota_job:
                            quota_job.quota_after = quota_after
                            quota_job.touch(
                                "generation_quota_refreshed_after_save",
                                candidate_index=candidate_index,
                                remaining=self.service._remaining_generations(quota_after),
                            )
                    except Exception as exc:
                        with self.store.locked_job(job_id) as quota_job:
                            quota_job.touch(
                                "generation_quota_refresh_failed_after_save",
                                candidate_index=candidate_index,
                                error={"type": type(exc).__name__, "message": str(exc)},
                            )

    def attach_provider_job_id(
        self,
        job_id: str,
        candidate_index: int,
        provider_job_id: str,
    ) -> JobRecord:
        """Attach a known remote ID after an ambiguous POST; never submit."""

        remote_id = provider_job_id.strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{5,199}", remote_id):
            raise ValidationHarnessError("provider job ID format is invalid")
        with self.store.locked_job(job_id) as job:
            if job.request.provider != "pixellab":
                raise ValidationHarnessError("manual provider recovery is only available for PixelLab")
            candidate = self.service._candidate(job, candidate_index)
            if candidate.frames:
                return job
            if job.request.open_plan:
                from .collaboration.checkpoints import checked_plan
                finished_state = "accepted" if checked_plan(job) else "complete"
                run = next((r for r in candidate.plan_execution.stages if r.state != finished_state), None)
                if run is None or run.state not in {"submitting", "unknown", "pending"}:
                    raise ConflictError("当前片段没有待核对的提交")
                if run.provider_job_id and run.provider_job_id != remote_id:
                    raise ConflictError("片段已有不同的远端编号")
                run.provider_job_id = remote_id
                run.state = "pending"
            if candidate.provider_job_id and candidate.provider_job_id != remote_id:
                raise ConflictError("candidate already has a different provider job ID")
            if candidate.status not in (
                CandidateStatus.submitting,
                CandidateStatus.submission_unknown,
                CandidateStatus.provider_pending,
                CandidateStatus.saving,
            ):
                raise ConflictError(
                    "candidate is not waiting for a recoverable provider job",
                    details={"status": candidate.status.value},
                )
            candidate.provider_job_id = remote_id
            candidate.provider_status = candidate.provider_status or "processing"
            candidate.submitted_at = candidate.submitted_at or utc_now()
            candidate.status = CandidateStatus.provider_pending
            candidate.error = None
            job.generation_requested_at = job.generation_requested_at or utc_now()
            self.service._refresh_job_status(job)
            job.touch(
                "provider_job_id_attached",
                candidate_index=candidate_index,
                provider_job_id=remote_id,
                submission_created=False,
            )
        return self.store.load(job_id)

    def recover_pending_jobs(self) -> dict[str, Any]:
        """Advance every durable live generation using only safe operations."""

        summary: dict[str, Any] = {
            "checked_at": utc_now().isoformat(),
            "advanced": [],
            "attention_required": [],
            "errors": [],
        }
        for row in self.store.list_jobs():
            # Completed assets are represented by summary.json and are opened
            # lazily by the UI. Only unfinished/attention tasks need a deep
            # reconciliation pass in the background worker.
            if not bool(row.get("needs_recovery")):
                continue
            job_id = str(row["job_id"])
            try:
                job = self.service.reconcile_saved_results(job_id)
                if job.request.open_plan and job.generation_requested_at is not None:
                    from .providers import get_provider
                    from .collaboration.execution import PlanGeneration
                    provider = get_provider(job.request.provider, self.service.settings)
                    before_revision = job.revision
                    advanced = PlanGeneration(self.service).advance(job_id, provider)
                    if advanced.revision != before_revision:
                        summary["advanced"].append({"job_id": job_id, "status": advanced.status.value})
                    continue
                if job.request.provider != "pixellab" or job.generation_requested_at is None:
                    continue
                if job.generation_account and (not self.service.settings.pixellab_api_key or job.generation_account != PixelLabSlot(self.service.settings, self.store).key):
                    continue
                stale_before = utc_now() - timedelta(
                    seconds=max(120.0, self.service.settings.http_timeout_seconds * 2)
                )
                stale_indices = [
                    candidate.candidate_index
                    for candidate in job.candidates
                    if candidate.status == CandidateStatus.submitting
                    and candidate.provider_job_id is None
                    and candidate.submission_started_at is not None
                    and candidate.submission_started_at < stale_before
                ]
                if stale_indices:
                    with self.store.locked_job(job_id) as stale_job:
                        for index in stale_indices:
                            candidate = self.service._candidate(stale_job, index)
                            if candidate.status != CandidateStatus.submitting or candidate.provider_job_id:
                                continue
                            stages = (candidate.attack_sequence or {}).get('stages', [])
                            stage = next((i for i, run in enumerate(stages) if run['state'] == 'submitting'), None)
                            receipt = self._recover_submission_receipt(stale_job, candidate, stage=stage)
                            if receipt:
                                if stage is not None:
                                    stages[stage].update(state='pending', provider_job_id=receipt['jobId'], usage=receipt['usage'])
                                continue
                            candidate.status = CandidateStatus.submission_unknown
                            candidate.error = {
                                "code": "submission_interrupted",
                                "message": "the process stopped before the provider job ID was saved",
                                "details": {
                                    "safe_to_retry": False,
                                    "manual_provider_job_id_can_recover": True,
                                },
                            }
                            stale_job.touch(
                                "candidate_submission_marked_unknown",
                                candidate_index=index,
                            )
                        self.service._refresh_job_status(stale_job)
                    job = self.store.load(job_id)
                unknown = [
                    candidate.candidate_index
                    for candidate in job.candidates
                    if candidate.status == CandidateStatus.submission_unknown
                ]
                if unknown:
                    summary["attention_required"].append(
                        {"job_id": job_id, "candidate_indices": unknown}
                    )
                    continue
                quota_blocked = [
                    candidate.candidate_index
                    for candidate in job.candidates
                    if candidate.status == CandidateStatus.created
                    and (candidate.error or {}).get("code") == "insufficient_quota"
                ]
                if quota_blocked:
                    summary["attention_required"].append(
                        {
                            "job_id": job_id,
                            "candidate_indices": quota_blocked,
                            "reason": "insufficient_quota",
                        }
                    )
                active = any(
                    candidate.status
                    in (CandidateStatus.provider_pending, CandidateStatus.saving)
                    for candidate in job.candidates
                )
                if not quota_blocked:
                    active = active or any(
                        candidate.status == CandidateStatus.created
                        for candidate in job.candidates
                    )
                from .motion_correction import active as motion_active
                active = active or motion_active(job)
                if active and self.service.settings.pixellab_api_key:
                    before_revision = job.revision
                    advanced = self.generate_job(job_id, wait=False, candidate_index=job.queued_candidate_index)
                    if advanced.revision != before_revision:
                        summary["advanced"].append(
                            {"job_id": job_id, "status": advanced.status.value}
                        )
            except Exception as exc:
                summary["errors"].append(
                    {"job_id": job_id, "message": str(exc), "type": type(exc).__name__}
                )
        atomic_write_json(self.service.settings.config_dir / "last_recovery_scan.json", summary)
        return summary
