from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TESTS_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(TESTS_ROOT) not in sys.path:
    sys.path.insert(0, str(TESTS_ROOT))

from sprite_pipeline.errors import ConflictError, ExportBlockedError, ProviderTemporaryError, ValidationHarnessError
from sprite_pipeline.credential_store import CredentialStore
from sprite_pipeline.jsonio import atomic_write_json
from sprite_pipeline.migration import LegacyLayoutMigrator
from sprite_pipeline.models import CandidateStatus, GenerationRequest, JobStatus, ReviewStatus, utc_now
from sprite_pipeline.providers.base import PollResult, PollStatus, ProviderRequest, Submission
from sprite_pipeline.providers.pixellab import PixelLabProvider
from sprite_pipeline.service import SpritePipelineService
from sprite_pipeline.settings import HarnessSettings

from test_harness_integration import FakePixelLabClient, FakeResponse, TemporaryHarness


class SequencedProvider:
    name = "pixellab"
    diagnostic_only = False

    def __init__(
        self,
        images: list[bytes],
        *,
        unknown_submission: bool = False,
        remaining_generations: int | float = 40,
    ) -> None:
        self.images = images
        self.unknown_submission = unknown_submission
        self.remaining_generations = remaining_generations
        self.submit_count = 0
        self.poll_count = 0
        self.balance_count = 0

    def get_balance(self) -> dict[str, object]:
        self.balance_count += 1
        return {
            "subscription": {
                "type": "generations",
                "status": "active",
                "generations": self.remaining_generations,
                "total": 40,
            }
        }

    def submit(self, request: ProviderRequest) -> Submission:
        self.submit_count += 1
        if self.unknown_submission:
            raise ProviderTemporaryError(
                "submission response was lost",
                details={"submission_unknown": True, "safe_to_retry": False},
            )
        return Submission(
            provider=self.name,
            provider_job_id="remote-job-123456",
            status="processing",
            expected_frame_count=request.frame_count,
            expected_size=(64, 64),
            request_record={"frame_count": request.frame_count},
            raw_response={"background_job_id": "remote-job-123456", "status": "processing"},
        )

    def poll(self, provider_job_id: str) -> PollResult:
        self.poll_count += 1
        if self.poll_count == 1:
            return PollResult(
                provider=self.name,
                provider_job_id=provider_job_id,
                status=PollStatus.pending,
                provider_status="processing",
                raw_response={"status": "processing"},
            )
        return PollResult(
            provider=self.name,
            provider_job_id=provider_job_id,
            status=PollStatus.completed,
            provider_status="completed",
            images=self.images,
            raw_response={"status": "completed", "last_response": {"images": ["redacted"]}},
        )


class QuotaAndResultSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(os.environ, {}, clear=False)
        self.environment.start()
        for name in (
            "PIXELLAB_API_KEY",
            "SPRITE_PIPELINE_DATA_DIR",
            "SPRITE_PIPELINE_EXPORTS_DIR",
            "SPRITE_PIPELINE_HOME",
            "SPRITE_PIPELINE_INSTALL_ROOT",
        ):
            os.environ.pop(name, None)
        self.temp_dir = tempfile.TemporaryDirectory(prefix="sprite_safety_")
        self.root = Path(self.temp_dir.name) / "portable"
        self.harness = TemporaryHarness(self.root)
        self.service = SpritePipelineService(self.root)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()
        self.environment.stop()

    def _frame_bytes(self) -> list[bytes]:
        paths = self.harness.write_sequence(self.root / "provider_frames")
        return [path.read_bytes() for path in paths]

    def test_request_key_is_cross_process_idempotent(self) -> None:
        request = GenerationRequest(
            **self.harness.create_request("fixture"),
            request_key="ui-request-123456",
        )
        second_service = SpritePipelineService(self.root)
        barrier = threading.Barrier(2)

        def create(service: SpritePipelineService) -> str:
            barrier.wait(timeout=5)
            return service.create_job(request).job_id

        with ThreadPoolExecutor(max_workers=2) as executor:
            job_ids = list(executor.map(create, (self.service, second_service)))

        self.assertEqual(job_ids[0], job_ids[1])
        self.assertEqual(len(self.service.list_jobs()), 1)
        with self.assertRaises(ConflictError):
            self.service.create_job(
                request.model_copy(update={"action_description": "A different valid action description."})
            )

    def test_unknown_submission_is_persisted_and_never_retried(self) -> None:
        self.service.configure_pixellab_api_key("unit_test_key_123456")
        job = self.service.create_job(
            GenerationRequest(
                **self.harness.create_request("pixellab"),
                request_key="unknown-submit-123456",
            )
        )
        provider = SequencedProvider(self._frame_bytes(), unknown_submission=True)
        with patch("sprite_pipeline.providers.get_provider", return_value=provider):
            with self.assertRaises(ProviderTemporaryError):
                self.service.generate_job(job.job_id, wait=False)
            persisted = self.service.get_job(job.job_id)
            candidate = persisted.candidates[0]
            self.assertEqual(candidate.status, CandidateStatus.submission_unknown)
            self.assertEqual(candidate.submission_attempts, 1)
            self.assertEqual(persisted.status, JobStatus.attention_required)
            with self.assertRaises(ConflictError):
                self.service.generate_job(job.job_id, wait=False)
        self.assertEqual(provider.submit_count, 1)

        # The operator found the ID in PixelLab. Binding and polling it performs
        # no POST and safely recovers the existing paid output.
        provider.unknown_submission = False
        provider.poll_count = 1
        self.service.attach_provider_job_id(job.job_id, 1, "recovered-remote-123456")
        with patch("sprite_pipeline.providers.get_provider", return_value=provider):
            recovered = self.service.generate_job(job.job_id, wait=False, candidate_index=1)
        candidate = recovered.candidates[0]
        self.assertIsNotNone(candidate.result_saved_at)
        self.assertTrue(candidate.frames)
        self.assertEqual(provider.submit_count, 1)
        self.assertEqual(self.service.candidate_safety(job.job_id, 1)["stage"], "saved")

    def test_insufficient_quota_is_recorded_before_any_submission(self) -> None:
        with patch.dict(os.environ, {'PIXELLAB_API_KEY': 'unit_test_key_123456'}):
            self.service = SpritePipelineService(self.root)
        request_values = self.harness.create_request("pixellab")
        request_values["candidate_count"] = 2
        job = self.service.create_job(
            GenerationRequest(
                **request_values,
                request_key="quota-block-123456",
            )
        )
        provider = SequencedProvider(
            self._frame_bytes(),
            remaining_generations=1.0,
        )
        with patch("sprite_pipeline.providers.get_provider", return_value=provider):
            with self.assertRaises(ValidationHarnessError):
                self.service.generate_job(job.job_id, wait=False)

        blocked = self.service.get_job(job.job_id)
        self.assertEqual(provider.submit_count, 0)
        self.assertEqual(blocked.candidates[0].submission_attempts, 0)
        self.assertIsNone(blocked.generation_requested_at)
        self.assertIsNotNone(blocked.quota_before)
        self.assertEqual(blocked.events[-1]["event"], "generation_blocked_by_quota")
        self.assertFalse(blocked.events[-1]["chargeable_submission_created"])
        self.assertEqual(blocked.status, JobStatus.not_submitted)
        self.assertEqual(
            blocked.candidates[0].error["code"],
            "insufficient_quota",
        )

        blocked.generation_requested_at = utc_now()
        self.service.store.save(blocked)
        with patch("sprite_pipeline.providers.get_provider", return_value=provider):
            scan = self.service.recover_pending_jobs()
        self.assertEqual(provider.submit_count, 0)
        self.assertEqual(
            scan["attention_required"][0]["reason"],
            "insufficient_quota",
        )

        from fastapi.testclient import TestClient
        from sprite_pipeline.api_app import create_api
        keyed_job = self.service.create_job(GenerationRequest(**request_values, request_key='keyed-quota-job'))
        route = '/v1/jobs/' + keyed_job.job_id
        api = TestClient(create_api(service=self.service))
        with patch('sprite_pipeline.providers.get_provider', return_value=provider):
            result = api.post(route + '/generate', json={'wait': True, 'request_key': 'keyed-quota-rejection'}).json()['data']
        self.assertEqual(result['generation_receipt']['state'], 'rejected')
        self.assertFalse(result['generation_receipt']['submission_created'])
        self.assertEqual(result['job']['revision'], result['generation_receipt']['revision'])
        self.assertEqual(result['job']['status'], 'not_submitted')
        self.assertEqual(result['job']['candidates'][0]['error']['code'], 'insufficient_quota')
        self.assertEqual(api.get(route + '/generation-requests/keyed-quota-rejection').json()['data'], result)
        self.assertEqual(provider.submit_count, 0)

    def test_dynamic_generation_unit_estimate_matches_pixellab_contract(self) -> None:
        self.assertEqual(
            self.service._pixellab_generation_units(64, 64, 16),
            1,
        )
        self.assertEqual(
            self.service._pixellab_generation_units(96, 96, 8),
            2,
        )
        self.assertEqual(
            self.service._pixellab_generation_units(128, 128, 4),
            1,
        )
        self.assertEqual(
            self.service._pixellab_generation_units(128, 128, 8),
            2,
        )
        self.assertEqual(
            self.service._pixellab_generation_units(128, 128, 16),
            4,
        )
        self.assertEqual(
            self.service._pixellab_generation_units(256, 256, 8),
            8,
        )

    def test_recovery_scan_finishes_pending_job_without_duplicate_post(self) -> None:
        self.service.configure_pixellab_api_key("unit_test_key_123456")
        job = self.service.create_job(
            GenerationRequest(
                **self.harness.create_request("pixellab"),
                request_key="background-recovery-123456",
            )
        )
        provider = SequencedProvider(self._frame_bytes())
        with patch("sprite_pipeline.providers.get_provider", return_value=provider):
            first = self.service.generate_job(job.job_id, wait=False)
            self.assertEqual(first.candidates[0].status, CandidateStatus.provider_pending)
            scan = self.service.recover_pending_jobs()
        recovered = self.service.get_job(job.job_id)
        self.assertEqual(provider.submit_count, 1)
        self.assertTrue(recovered.candidates[0].frames)
        self.assertIsNotNone(recovered.candidates[0].result_saved_at)
        self.assertTrue(scan["advanced"])

    def test_atomic_raw_directory_is_adopted_after_stale_job_record(self) -> None:
        job = self.service.create_job(self.harness.create_request("pixellab"))
        with self.service.store.locked_job(job.job_id) as pending_job:
            pending_job.generation_requested_at = utc_now()
            pending_job.status = JobStatus.saving
            candidate = pending_job.candidates[0]
            candidate.status = CandidateStatus.saving
            candidate.provider_job_id = "crash-window-123456"
            candidate.provider_status = "completed"
            candidate.submission_attempts = 1
        stale = self.service.get_job(job.job_id).model_copy(deep=True)
        self.service._store_provider_frames(
            job.job_id,
            1,
            self._frame_bytes(),
            diagnostic_only=False,
            expected_provider_job_id="crash-window-123456",
        )

        # Simulate a crash restoring an older, still valid current pointer after
        # the atomic raw result directory was already published.
        atomic_write_json(
            self.service.store.job_dir(job.job_id) / "job.json",
            stale.model_dump(mode="json"),
        )
        restarted = SpritePipelineService(self.root)
        recovered = restarted.reconcile_saved_results(job.job_id)
        candidate = recovered.candidates[0]
        self.assertEqual(len(candidate.frames), 4)
        self.assertIsNotNone(candidate.result_saved_at)
        self.assertTrue((restarted.store.job_dir(job.job_id) / "raw" / "candidate_01" / "result.commit.json").is_file())
        self.assertTrue(restarted.candidate_safety(job.job_id, 1)["result_integrity"])

    def test_fully_written_pre_rename_staging_is_published_after_restart(self) -> None:
        job = self.service.create_job(self.harness.create_request("pixellab"))
        with self.service.store.locked_job(job.job_id) as pending_job:
            pending_job.generation_requested_at = utc_now()
            pending_job.status = JobStatus.saving
            candidate = pending_job.candidates[0]
            candidate.status = CandidateStatus.saving
            candidate.provider_job_id = "pre-rename-crash-123456"
            candidate.provider_status = "completed"
            candidate.submission_attempts = 1
        stale = self.service.get_job(job.job_id).model_copy(deep=True)
        self.service._store_provider_frames(
            job.job_id,
            1,
            self._frame_bytes(),
            diagnostic_only=False,
            expected_provider_job_id="pre-rename-crash-123456",
        )
        job_dir = self.service.store.job_dir(job.job_id)
        output = job_dir / "raw" / "candidate_01"
        staging = job_dir / "raw" / ".candidate_01.crash-window"
        output.rename(staging)
        for history in (job_dir / "history").glob("job_*.json"):
            revision = int(history.stem.rsplit("_", 1)[1])
            if revision > stale.revision:
                history.unlink()
        atomic_write_json(job_dir / "job.json", stale.model_dump(mode="json"))

        restarted = SpritePipelineService(self.root)
        recovered = restarted.reconcile_saved_results(job.job_id)
        self.assertTrue((output / "result.commit.json").is_file())
        self.assertFalse(staging.exists())
        self.assertEqual(len(recovered.candidates[0].frames), 4)
        self.assertTrue(restarted.candidate_safety(job.job_id, 1)["result_integrity"])

    @unittest.skipUnless(os.name == 'nt', 'Windows sharing errors')
    def test_raw_result_directory_retries_only_the_same_publication(self) -> None:
        job = self.service.create_job(self.harness.create_request('pixellab'))
        provider = SequencedProvider(self._frame_bytes())
        replace = os.replace
        moves = []

        def temporarily_locked(source, target):
            if Path(target).name == 'candidate_01' and Path(source).name.startswith('.candidate_01.'):
                moves.append((source, target))
                if len(moves) == 1:
                    raise PermissionError(13, 'temporary sharing violation', str(target), 5)
            return replace(source, target)

        with patch('sprite_pipeline.providers.get_provider', return_value=provider), patch('os.replace', temporarily_locked):
            for _ in range(3):
                result = self.service.generate_job(job.job_id, wait=False)
                if result.candidates[0].frames:
                    break

        self.assertEqual(provider.submit_count, 1)
        self.assertEqual(len(moves), 2)
        self.assertEqual(moves[0], moves[1])
        self.assertTrue(result.candidates[0].frames)

    def test_poll_audit_write_failure_does_not_discard_completed_images(self) -> None:
        self.service.configure_pixellab_api_key("unit_test_key_123456")
        job = self.service.create_job(
            GenerationRequest(
                **self.harness.create_request("pixellab"),
                request_key="poll-audit-failure-123456",
            )
        )
        provider = SequencedProvider(self._frame_bytes())
        provider.poll_count = 1
        from sprite_pipeline import job_execution

        original_write = job_execution.atomic_write_json

        def fail_only_poll_audit(path: Path, payload: object) -> None:
            if path.name.endswith(".poll.response.json"):
                raise OSError("provider audit directory unavailable")
            original_write(path, payload)

        with (
            patch("sprite_pipeline.providers.get_provider", return_value=provider),
            patch(
                "sprite_pipeline.job_execution.atomic_write_json",
                side_effect=fail_only_poll_audit,
            ),
        ):
            completed = self.service.generate_job(job.job_id, wait=False)

        candidate = completed.candidates[0]
        self.assertTrue(candidate.frames)
        self.assertIsNotNone(candidate.result_saved_at)
        self.assertEqual(provider.submit_count, 1)
        self.assertTrue(
            any(event["event"] == "poll_audit_write_failed" for event in completed.events)
        )
        self.assertTrue(self.service.candidate_safety(job.job_id, 1)["result_integrity"])

    def test_legacy_saved_result_gets_commit_metadata_without_losing_review(self) -> None:
        job = self.service.create_job(self.harness.create_request("pixellab"))
        with self.service.store.locked_job(job.job_id) as pending_job:
            candidate = pending_job.candidates[0]
            candidate.status = CandidateStatus.saving
            candidate.provider_job_id = "legacy-result-123456"
            candidate.provider_status = "completed"
            candidate.submission_attempts = 1
        self.service._store_provider_frames(
            job.job_id,
            1,
            self._frame_bytes(),
            diagnostic_only=False,
            expected_provider_job_id="legacy-result-123456",
        )
        reviewed = self.service.check_candidate(job.job_id, 1)
        before_status = reviewed.candidates[0].status
        before_frames = [
            frame.model_dump(mode="json")
            for frame in reviewed.candidates[0].frames
        ]
        commit = (
            self.service.store.job_dir(job.job_id)
            / "raw"
            / "candidate_01"
            / "result.commit.json"
        )
        commit.unlink()
        with self.service.store.locked_job(job.job_id) as legacy_job:
            candidate = legacy_job.candidates[0]
            candidate.result_manifest_path = None
            candidate.result_sha256 = None
            candidate.result_saved_at = None
            candidate.submission_started_at = None
            candidate.submitted_at = None
            candidate.submission_attempts = 0
            legacy_job.generation_requested_at = None

        safety = self.service.candidate_safety(job.job_id, 1)
        upgraded = self.service.get_job(job.job_id).candidates[0]
        self.assertTrue(safety["result_integrity"])
        self.assertEqual(upgraded.status, before_status)
        self.assertEqual(
            [frame.model_dump(mode="json") for frame in upgraded.frames],
            before_frames,
        )
        self.assertTrue(commit.is_file())
        self.assertIsNotNone(upgraded.result_saved_at)
        self.assertEqual(upgraded.submission_attempts, 1)
        self.assertIsNotNone(
            self.service.get_job(job.job_id).generation_requested_at
        )

    def test_repaired_frame_keeps_original_provider_result_integrity(self) -> None:
        job = self.service.create_job(self.harness.create_request("pixellab"))
        with self.service.store.locked_job(job.job_id) as pending_job:
            candidate = pending_job.candidates[0]
            candidate.status = CandidateStatus.saving
            candidate.provider_job_id = "repair-safety-123456"
            candidate.provider_status = "completed"
            candidate.submission_attempts = 1
        self.service._store_provider_frames(
            job.job_id,
            1,
            self._frame_bytes(),
            diagnostic_only=False,
            expected_provider_job_id="repair-safety-123456",
        )
        checked = self.service.check_candidate(job.job_id, 1)
        original = checked.candidates[0].frames[0]
        original_bytes = self.service.store.resolve_job_path(
            job.job_id,
            original.raw_path,
        ).read_bytes()
        self.service.review_frame(
            job.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": "other",
                "reviewer": "result-safety-test",
            },
        )
        session = self.service.get_frame_edit_session(job.job_id, 1, 0)
        edited = bytearray(session["rgba"])
        offset = (10 * session["width"] + 10) * 4
        edited[offset : offset + 4] = bytes((7, 29, 61, 255))
        saved = self.service.edit_frame_pixels(
            job.job_id,
            1,
            0,
            rgba=bytes(edited),
            width=session["width"],
            height=session["height"],
            base_sha256=session["base_sha256"],
            reviewer="result-safety-test",
        )
        active = saved.candidates[0].frames[0]
        self.assertNotEqual(active.active_path, active.raw_path)
        self.assertNotEqual(active.sha256, original.sha256)
        self.assertEqual(
            self.service.store.resolve_job_path(job.job_id, active.raw_path).read_bytes(),
            original_bytes,
        )
        self.assertTrue(self.service.candidate_safety(job.job_id, 1)["result_integrity"])

    def test_reconciliation_preserves_repaired_active_frame(self) -> None:
        job = self.service.create_job(self.harness.create_request("pixellab"))
        with self.service.store.locked_job(job.job_id) as pending_job:
            candidate = pending_job.candidates[0]
            candidate.status = CandidateStatus.saving
            candidate.provider_job_id = "repair-reconcile-123456"
            candidate.provider_status = "completed"
            candidate.submission_attempts = 1
        self.service._store_provider_frames(
            job.job_id,
            1,
            self._frame_bytes(),
            diagnostic_only=False,
            expected_provider_job_id="repair-reconcile-123456",
        )
        self.service.check_candidate(job.job_id, 1)
        self.service.review_frame(
            job.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": "other",
                "reviewer": "reconcile-test",
            },
        )
        session = self.service.get_frame_edit_session(job.job_id, 1, 0)
        edited = bytearray(session["rgba"])
        edited[(11 * session["width"] + 11) * 4 : (11 * session["width"] + 11) * 4 + 4] = bytes(
            (91, 17, 43, 255)
        )
        repaired = self.service.edit_frame_pixels(
            job.job_id,
            1,
            0,
            rgba=bytes(edited),
            width=session["width"],
            height=session["height"],
            base_sha256=session["base_sha256"],
            reviewer="reconcile-test",
        )
        before_frames = [
            frame.model_dump(mode="json")
            for frame in repaired.candidates[0].frames
        ]
        commit = (
            self.service.store.job_dir(job.job_id)
            / "raw"
            / "candidate_01"
            / "result.commit.json"
        )
        commit.unlink()
        with self.service.store.locked_job(job.job_id) as legacy_job:
            candidate = legacy_job.candidates[0]
            candidate.result_manifest_path = None
            candidate.result_sha256 = None
            candidate.result_saved_at = None

        recovered = self.service.reconcile_saved_results(job.job_id)
        recovered_candidate = recovered.candidates[0]
        self.assertEqual(
            [frame.model_dump(mode="json") for frame in recovered_candidate.frames],
            before_frames,
        )
        self.assertNotEqual(
            recovered_candidate.frames[0].active_path,
            recovered_candidate.frames[0].raw_path,
        )
        self.assertIsNone(recovered_candidate.error)
        self.assertTrue(commit.is_file())
        self.assertTrue(self.service.candidate_safety(job.job_id, 1)["result_integrity"])

    def test_reconciliation_failure_can_recover_without_leaving_candidate_in_saving(self) -> None:
        job = self.service.create_job(self.harness.create_request("pixellab"))
        with self.service.store.locked_job(job.job_id) as pending_job:
            candidate = pending_job.candidates[0]
            candidate.status = CandidateStatus.saving
            candidate.provider_job_id = "retry-reconcile-123456"
            candidate.provider_status = "completed"
            candidate.submission_attempts = 1
        self.service._store_provider_frames(
            job.job_id,
            1,
            self._frame_bytes(),
            diagnostic_only=False,
            expected_provider_job_id="retry-reconcile-123456",
        )
        checked = self.service.check_candidate(job.job_id, 1)
        before_status = checked.candidates[0].status
        raw_path = self.service.store.resolve_job_path(
            job.job_id,
            checked.candidates[0].frames[0].raw_path,
        )
        original_bytes = raw_path.read_bytes()
        commit = raw_path.parent / "result.commit.json"
        commit.unlink()
        with self.service.store.locked_job(job.job_id) as legacy_job:
            candidate = legacy_job.candidates[0]
            candidate.result_manifest_path = None
            candidate.result_sha256 = None
            candidate.result_saved_at = None
        raw_path.write_bytes(b"corrupt provider frame")

        failed_job = self.service.reconcile_saved_results(job.job_id)
        failed = failed_job.candidates[0]
        self.assertEqual(failed.status, before_status)
        self.assertEqual(failed.error["code"], "stored_result_reconciliation_failed")
        failed_history = set(
            (self.service.store.job_dir(job.job_id) / "history").glob("job_*.json")
        )
        repeated_job = self.service.reconcile_saved_results(job.job_id)
        self.assertEqual(repeated_job.revision, failed_job.revision)
        self.assertEqual(
            set((self.service.store.job_dir(job.job_id) / "history").glob("job_*.json")),
            failed_history,
        )

        # Simulate a record already affected by an older build that forced the
        # candidate into saving after the same recoverable integrity error.
        with self.service.store.locked_job(job.job_id) as stale_job:
            stale_job.candidates[0].status = CandidateStatus.saving
        raw_path.write_bytes(original_bytes)
        recovered = self.service.reconcile_saved_results(job.job_id).candidates[0]

        self.assertNotEqual(recovered.status, CandidateStatus.saving)
        self.assertIsNone(recovered.error)
        self.assertTrue(commit.is_file())
        self.assertTrue(self.service.candidate_safety(job.job_id, 1)["result_integrity"])

    def test_corrupt_provider_source_blocks_recheck_approval_and_export_after_repair(self) -> None:
        job = self.service.create_job(self.harness.create_request("pixellab"))
        with self.service.store.locked_job(job.job_id) as pending_job:
            candidate = pending_job.candidates[0]
            candidate.status = CandidateStatus.saving
            candidate.provider_job_id = "integrity-gate-123456"
            candidate.provider_status = "completed"
            candidate.submission_attempts = 1
        self.service._store_provider_frames(
            job.job_id,
            1,
            self._frame_bytes(),
            diagnostic_only=False,
            expected_provider_job_id="integrity-gate-123456",
        )
        self.service.check_candidate(job.job_id, 1)
        self.service.review_frame(
            job.job_id,
            1,
            {
                "frame_index": 0,
                "status": "repair_requested",
                "issue_type": "other",
                "reviewer": "integrity-gate-test",
            },
        )
        session = self.service.get_frame_edit_session(job.job_id, 1, 0)
        edited = bytearray(session["rgba"])
        offset = (12 * session["width"] + 12) * 4
        edited[offset : offset + 4] = bytes((13, 37, 71, 255))
        repaired = self.service.edit_frame_pixels(
            job.job_id,
            1,
            0,
            rgba=bytes(edited),
            width=session["width"],
            height=session["height"],
            base_sha256=session["base_sha256"],
            reviewer="integrity-gate-test",
        )
        self.assertNotEqual(
            repaired.candidates[0].frames[0].active_path,
            repaired.candidates[0].frames[0].raw_path,
        )

        raw_path = self.service.store.resolve_job_path(
            job.job_id,
            repaired.candidates[0].frames[0].raw_path,
        )
        (raw_path.parent / "result.commit.json").unlink()
        with self.service.store.locked_job(job.job_id) as legacy_job:
            candidate = legacy_job.candidates[0]
            candidate.result_manifest_path = None
            candidate.result_sha256 = None
            candidate.result_saved_at = None
        raw_path.write_bytes(b"corrupt provider frame")
        failed = self.service.reconcile_saved_results(job.job_id).candidates[0]
        self.assertEqual(failed.error["code"], "stored_result_reconciliation_failed")

        with self.assertRaises(ValidationHarnessError):
            self.service.check_candidate(job.job_id, 1)
        still_failed = self.service.get_job(job.job_id).candidates[0]
        self.assertEqual(still_failed.error["code"], "stored_result_reconciliation_failed")
        with self.assertRaises(ExportBlockedError):
            self.service.approve_candidate(
                job.job_id,
                1,
                reviewer="integrity-gate-test",
                acknowledge_warnings=True,
            )

        # Simulate a record approved by an older build: export still enforces
        # the immutable provider-source contract at its final service gate.
        with self.service.store.locked_job(job.job_id) as stale_job:
            candidate = stale_job.candidates[0]
            candidate.status = CandidateStatus.approved
            for frame in candidate.frames:
                frame.review_status = ReviewStatus.approved
        with self.assertRaises(ExportBlockedError):
            self.service.export_candidate(job.job_id, 1)

    def test_job_journal_recovers_a_corrupt_current_record(self) -> None:
        job = self.service.create_job(self.harness.create_request("import"))
        current = self.service.store.job_dir(job.job_id) / "job.json"
        current.write_text("{broken", encoding="utf-8")
        recovered = self.service.get_job(job.job_id)
        self.assertEqual(recovered.job_id, job.job_id)
        self.assertEqual(self.service.list_jobs()[0]["job_id"], job.job_id)

    def test_job_catalog_reads_lightweight_summary_without_loading_job(self) -> None:
        request = self.harness.create_request("fixture")
        request["candidate_count"] = 3
        job = self.service.create_job(request)
        job_dir = self.service.store.job_dir(job.job_id)
        summary_path = job_dir / "summary.json"

        self.assertTrue(summary_path.is_file())
        with patch.object(
            self.service.store,
            "load",
            side_effect=AssertionError("catalog must not deep-load job.json"),
        ):
            rows = self.service.list_jobs()

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["job_id"], job.job_id)
        self.assertEqual(rows[0]["candidate_count"], 3)
        self.assertEqual(rows[0]["saved_candidate_count"], 0)
        self.assertFalse(rows[0]["needs_recovery"])

    def test_legacy_job_catalog_summary_is_backfilled_once(self) -> None:
        job = self.service.create_job(self.harness.create_request("import"))
        summary_path = self.service.store.job_dir(job.job_id) / "summary.json"
        summary_path.unlink()

        first = self.service.list_jobs()
        self.assertEqual(first[0]["job_id"], job.job_id)
        self.assertTrue(summary_path.is_file())
        with patch.object(
            self.service.store,
            "load",
            side_effect=AssertionError("backfilled catalog must stay lightweight"),
        ):
            second = self.service.list_jobs()
        self.assertEqual(second, first)

    def test_job_catalog_repairs_a_stale_summary_after_interrupted_save(self) -> None:
        for interruption in ("job.json", "summary.json"):
            with self.subTest(interruption=interruption):
                job = self.service.create_job(self.harness.create_request("pixellab"))
                store = self.service.store

                def fail_selected_write(path, value):
                    if path.name == interruption:
                        raise OSError("interrupted job publication")
                    atomic_write_json(path, value)

                def submit():
                    with store.locked_job(job.job_id) as submitted:
                        submitted.generation_requested_at = submitted.updated_at
                        submitted.candidates[0].status = CandidateStatus.provider_pending
                        submitted.candidates[0].provider_job_id = "durable-provider-id"

                with patch("sprite_pipeline.store.atomic_write_json", side_effect=fail_selected_write):
                    if interruption == "job.json":
                        with self.assertRaisesRegex(OSError, "interrupted job publication"):
                            submit()
                    else:
                        submit()

                reader = type(store)(self.service.settings)
                summary = next(row for row in reader.list_jobs() if row["job_id"] == job.job_id)
                self.assertEqual(summary["job_revision"], job.revision + 1)
                self.assertEqual(summary["candidate_status_counts"], {"provider_pending": 1})
                self.assertTrue(summary["needs_recovery"])
                with patch.object(reader, "load", side_effect=AssertionError("repaired summary must stay lightweight")):
                    self.assertEqual(next(row for row in reader.list_jobs() if row["job_id"] == job.job_id), summary)

    def test_older_job_read_cannot_replace_newer_summary(self) -> None:
        job = self.service.create_job(self.harness.create_request("import"))
        writer = self.service.store
        reader = type(writer)(self.service.settings)
        history = writer.job_dir(job.job_id) / "history" / f"job_{job.revision:08d}.json"
        from sprite_pipeline.jsonio import read_json

        writing = False

        def interleave_write(path):
            nonlocal writing
            value = read_json(path)
            if path == history and not writing:
                writing = True
                with writer.locked_job(job.job_id) as next_job:
                    next_job.candidates[0].status = CandidateStatus.failed
            return value

        with patch("sprite_pipeline.store.read_json", side_effect=interleave_write):
            self.assertEqual(reader.load(job.job_id).revision, job.revision)
        summary = read_json(writer.job_dir(job.job_id) / "summary.json")
        self.assertEqual(summary["job_revision"], job.revision + 1)
        self.assertEqual(summary["candidate_status_counts"], {"failed": 1})

    def test_multiple_candidates_share_one_task_folder(self) -> None:
        request = self.harness.create_request("fixture")
        request["candidate_count"] = 3
        created = self.service.create_job(request)
        completed = self.service.generate_job(created.job_id, wait=True)
        job_dir = self.service.store.job_dir(completed.job_id)

        self.assertEqual(
            {path.name for path in (job_dir / "raw").iterdir() if path.is_dir()},
            {"candidate_01", "candidate_02", "candidate_03"},
        )
        self.assertTrue(
            all(
                frame.active_path.startswith(f"raw/{candidate.candidate_id}/")
                for candidate in completed.candidates
                for frame in candidate.frames
            )
        )
        rows = self.service.list_jobs()
        self.assertEqual(rows[0]["candidate_count"], 3)
        self.assertEqual(rows[0]["saved_candidate_count"], 3)
        self.assertEqual(len([path for path in self.service.settings.work_dir.iterdir() if path.name != ".locks"]), 1)

    def test_recovery_scan_does_not_deep_load_completed_catalog_rows(self) -> None:
        job = self.service.create_job(self.harness.create_request("fixture"))
        self.service.generate_job(job.job_id, wait=True)

        with patch.object(
            self.service,
            "reconcile_saved_results",
            side_effect=AssertionError("completed assets must remain lazy"),
        ):
            scan = self.service.recover_pending_jobs()

        self.assertEqual(scan["advanced"], [])
        self.assertEqual(scan["attention_required"], [])
        self.assertEqual(scan["errors"], [])

    def test_job_journal_wins_over_a_valid_but_stale_current_record(self) -> None:
        job = self.service.create_job(self.harness.create_request("pixellab"))
        stale = job.model_copy(deep=True)
        with self.service.store.locked_job(job.job_id) as submitted:
            candidate = submitted.candidates[0]
            candidate.status = CandidateStatus.provider_pending
            candidate.provider_job_id = "journal-remote-123456"
            candidate.submission_attempts = 1
            submitted.touch(
                "candidate_submitted",
                candidate_index=1,
                provider_job_id=candidate.provider_job_id,
            )
        atomic_write_json(
            self.service.store.job_dir(job.job_id) / "job.json",
            stale.model_dump(mode="json"),
        )

        recovered = self.service.get_job(job.job_id)
        self.assertGreater(recovered.revision, stale.revision)
        self.assertEqual(
            recovered.candidates[0].provider_job_id,
            "journal-remote-123456",
        )
        self.assertEqual(recovered.candidates[0].submission_attempts, 1)

    def test_pixellab_balance_is_bounded_and_redacted(self) -> None:
        response = FakeResponse(
            {
                "credits": {"type": "usd", "usd": 1.25},
                "subscription": {
                    "type": "generations",
                    "status": "active",
                    "generations": 32,
                    "total": 40,
                },
            }
        )
        client = FakePixelLabClient(FakeResponse({}), response)
        provider = PixelLabProvider(api_key="secret-unit-key", http_client=client)
        balance = provider.get_balance()
        self.assertEqual(balance["subscription"]["generations"], 32)
        self.assertEqual(balance["subscription"]["total"], 40)
        self.assertEqual(client.get_calls, ["https://api.pixellab.ai/v2/balance"])
        self.assertNotIn("secret-unit-key", json.dumps(balance))

    def test_protected_credential_survives_data_directory_move(self) -> None:
        first = Path(self.temp_dir.name) / "credential_location_a"
        second = Path(self.temp_dir.name) / "credential_location_b"
        secret = "movable_protected_secret_123456"
        first_store = CredentialStore(first)
        first_store.set("pixellab_api_key", secret)
        second.mkdir(parents=True)
        shutil.copy2(first_store.path, second / "credentials.json")

        second_store = CredentialStore(second)
        self.assertEqual(second_store.get("pixellab_api_key"), secret)
        raw = (second / "credentials.json").read_bytes()
        self.assertNotIn(secret.encode("utf-8"), raw)
        payload = json.loads(raw)
        self.assertEqual(
            payload["secrets"]["pixellab_api_key"]["entropy_version"],
            "stable-v1",
        )

    def test_rest_api_idempotency_header_and_recovery_status(self) -> None:
        from fastapi.testclient import TestClient

        from sprite_pipeline.api_app import create_api

        body = self.harness.create_request("fixture")
        with TestClient(create_api(self.root, service=self.service)) as client:
            first = client.post(
                "/v1/jobs",
                headers={"Idempotency-Key": "rest-request-123456"},
                json=body,
            )
            second = client.post(
                "/v1/jobs",
                headers={"Idempotency-Key": "rest-request-123456"},
                json=body,
            )
            self.assertEqual(first.status_code, 201)
            self.assertEqual(second.status_code, 201)
            first_id = first.json()["data"]["job"]["job_id"]
            self.assertEqual(first_id, second.json()["data"]["job"]["job_id"])

            generate = f'/v1/jobs/{first_id}/generate'
            receipts = f'/v1/jobs/{first_id}/generation-requests/'
            command = {'request_key': 'received-command-B', 'candidate_index': 1, 'wait': False}
            generated = client.post(generate, json=command)
            self.assertEqual(generated.status_code, 200, generated.text)
            data = generated.json()['data']
            self.assertEqual({key: value for key, value in data['generation_receipt'].items() if key != 'evidence'}, {
                **command, 'job_id': first_id, 'state': 'returned', 'revision': data['job']['revision']})
            self.assertEqual(client.get(receipts + 'undelivered-command-A').status_code, 404)
            self.assertEqual(client.get(receipts + command['request_key']).json()['data'], data)
            self.assertEqual(client.post(generate, json=command).json()['data'], data)
            self.assertEqual(client.post(generate, json={**command, 'wait': True}).status_code, 409)

            rejected = client.post(generate, json={**command, 'request_key': 'preflight-invalid', 'candidate_index': 99})
            rejection = rejected.json()['data']['generation_receipt']
            self.assertEqual(rejection['state'], 'rejected')
            self.assertIs(rejection['submission_created'], False)
            self.assertNotIn('revision', rejection)

            def unrelated_then_raise(job_id, **_kwargs):
                from threading import Thread
                def foreign_write():
                    with self.service.store.locked_job(job_id) as job:
                        job.candidates[0].usage = {'usd': 101}
                thread = Thread(target=foreign_write)
                thread.start()
                thread.join()
                raise ValidationHarnessError('unknown fault after another caller updated this candidate')
            with patch.object(self.service, 'generate_job', side_effect=unrelated_then_raise):
                unknown = client.post(generate, json={**command, 'request_key': 'no-own-evidence'}).json()['data']
            self.assertEqual(unknown['generation_receipt']['state'], 'unknown')
            self.assertNotIn('job', unknown)
            self.assertNotIn('evidence', unknown['generation_receipt'])

            safety = client.get(
                f"/v1/jobs/{first_id}/candidates/1/safety"
            )
            recovery = client.get("/v1/recovery/status")
            storage = client.get("/v1/system/storage")
            estimate = client.get(
                "/v1/account/estimate",
                params={
                    "character_id": self.harness.character_id,
                    "action_id": self.harness.action_id,
                    "candidate_count": 2,
                },
            )
            self.assertEqual(safety.status_code, 200)
            self.assertTrue(recovery.json()["data"]["worker"]["running"])
            self.assertTrue(storage.json()["data"]["paths"]["portable_mode"])
            self.assertEqual(
                estimate.json()["data"]["estimate"]["maximum_generation_units"],
                2,
            )

            mismatch_body = {**body, "request_key": "body-request-123456"}
            mismatch = client.post(
                "/v1/jobs",
                headers={"Idempotency-Key": "header-request-123456"},
                json=mismatch_body,
            )
            self.assertEqual(mismatch.status_code, 409)

        self.assertEqual(len(self.service.list_jobs()), 1)

    def test_default_layout_migrates_without_modifying_legacy_source(self) -> None:
        install_root = Path(self.temp_dir.name) / "installed_app"
        data_root = Path(self.temp_dir.name) / "user_data"
        exports_root = Path(self.temp_dir.name) / "user_exports"
        shutil.copytree(PROJECT_ROOT / "presets", install_root / "presets")

        legacy = SpritePipelineService(install_root)
        source_reference = install_root / "presets" / "characters" / "diagnostic_dummy" / "idle_reference.png"
        legacy.create_character_preset(
            display_name="Legacy User Hero",
            reference_image=source_reference,
            character_id="legacy_user_hero",
        )
        legacy_job = legacy.create_job(
            GenerationRequest(
                character_id="diagnostic_dummy",
                action_id="idle",
                provider="fixture",
                candidate_count=1,
            )
        )
        (install_root / "exports").mkdir(exist_ok=True)
        (install_root / "exports" / "legacy_sheet.png").write_bytes(b"legacy-export")
        old_key = "legacy_plaintext_key_123456"
        (install_root / ".env").write_text(
            f"PIXELLAB_API_KEY={old_key}\nPIXELLAB_BASE_URL=https://api.pixellab.ai\n",
            encoding="utf-8",
        )
        source_job_json = (install_root / "work" / legacy_job.job_id / "job.json").read_bytes()

        with patch.dict(
            os.environ,
            {
                "SPRITE_PIPELINE_INSTALL_ROOT": str(install_root),
                "SPRITE_PIPELINE_DATA_DIR": str(data_root),
                "SPRITE_PIPELINE_EXPORTS_DIR": str(exports_root),
            },
            clear=False,
        ):
            migrated = SpritePipelineService()

        self.assertFalse(migrated.settings.portable_mode)
        self.assertEqual(migrated.settings.install_root, install_root.resolve())
        self.assertEqual(migrated.settings.data_root, data_root.resolve())
        self.assertEqual(migrated.settings.jobs_dir, data_root.resolve() / "jobs")
        self.assertTrue((data_root / "characters" / "legacy_user_hero" / "character.json").is_file())
        self.assertEqual(
            (data_root / "jobs" / legacy_job.job_id / "job.json").read_bytes(),
            source_job_json,
        )
        self.assertEqual((exports_root / "legacy_sheet.png").read_bytes(), b"legacy-export")
        self.assertEqual(migrated.settings.pixellab_api_key, old_key)
        credential_bytes = (data_root / "config" / "credentials.json").read_bytes()
        self.assertNotIn(old_key.encode("utf-8"), credential_bytes)
        self.assertTrue((install_root / ".env").is_file())
        self.assertNotIn(old_key, (install_root / ".env").read_text(encoding="utf-8"))
        self.assertFalse(migrated.migration_report["legacy_secret_still_present"])
        self.assertTrue(migrated.migration_report["legacy_plaintext_secret_removed"])
        self.assertTrue((install_root / "work" / legacy_job.job_id / "job.json").is_file())
        self.assertTrue((install_root / "presets" / "characters" / "legacy_user_hero").is_dir())
        self.assertIn(migrated.migration_report["status"], {"complete", "complete_with_conflicts"})
        self.assertTrue(migrated.migration_report["source_left_intact"])

        with migrated.store.locked_job(legacy_job.job_id) as newer_job:
            newer_job.touch("result_safety_metadata_upgraded")
        rerun_report = LegacyLayoutMigrator(migrated.settings).run()
        self.assertEqual(rerun_report["status"], "complete")
        self.assertFalse(rerun_report["conflicts"])
        self.assertEqual(rerun_report["skipped_destination_newer"], 1)

    def test_inaccessible_offline_demo_does_not_block_user_data_migration(self) -> None:
        install_root = Path(self.temp_dir.name) / "diagnostic_install"
        data_root = Path(self.temp_dir.name) / "diagnostic_data"
        exports_root = Path(self.temp_dir.name) / "diagnostic_exports"
        shutil.copytree(PROJECT_ROOT / "presets", install_root / "presets")
        legacy = SpritePipelineService(install_root)
        demo = legacy.create_job(
            GenerationRequest(
                character_id="diagnostic_dummy",
                action_id="idle",
                provider="fixture",
                candidate_count=1,
            )
        )
        legacy.generate_job(demo.job_id)

        with patch.dict(
            os.environ,
            {
                "SPRITE_PIPELINE_INSTALL_ROOT": str(install_root),
                "SPRITE_PIPELINE_DATA_DIR": str(data_root),
                "SPRITE_PIPELINE_EXPORTS_DIR": str(exports_root),
            },
            clear=False,
        ):
            settings = HarnessSettings.load()
            settings.ensure_directories()
            migrator = LegacyLayoutMigrator(settings)
            original_copy_directory = migrator._copy_directory

            def fail_only_diagnostic_job(
                source: Path,
                destination: Path,
                area: str,
                report: dict[str, object],
            ) -> str:
                if area == "jobs":
                    raise PermissionError("diagnostic fixture directory is inaccessible")
                return original_copy_directory(source, destination, area, report)

            with patch.object(
                migrator,
                "_copy_directory",
                side_effect=fail_only_diagnostic_job,
            ):
                report = migrator.run()

        self.assertEqual(report["status"], "complete", report)
        self.assertFalse(report["errors"])
        self.assertEqual(len(report["skipped_recreatable_diagnostic_jobs"]), 1)
        self.assertTrue(
            (install_root / "work" / demo.job_id / "job.json").is_file()
        )


if __name__ == "__main__":
    unittest.main()
