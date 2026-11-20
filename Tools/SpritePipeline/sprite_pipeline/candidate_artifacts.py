"""Publish candidate results and verify the exact artifacts used for QA and export."""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import secrets
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from .errors import ConflictError, ExportBlockedError, HarnessError, ValidationHarnessError
from .jsonio import atomic_write_json, read_json, relative_posix, replace_with_retry, sha256_file
from .models import CandidateRecord, CandidateStatus, FrameRecord, JobRecord, utc_now

QA_ALGORITHM_VERSION = 'sprite-pipeline-qa-v3'


class CandidateArtifacts:
    def __init__(self, service):
        self.service = service
        self.store = service.store

    def _store_provider_frames(
        self,
        job_id: str,
        candidate_index: int,
        images: list[bytes],
        *,
        diagnostic_only: bool,
        expected_provider_job_id: str,
    ) -> bool:
        with self.store.locked_job(job_id) as job:
            candidate = self.service._candidate(job, candidate_index)
            if not self.service._is_current_poll_target(candidate, expected_provider_job_id):
                return False
            requested_provider_frame_count = job.action.generation_frame_count
            returned_provider_frame_count = len(images)
            count_matches_preset = returned_provider_frame_count == requested_provider_frame_count
            selection = (
                job.action.generation_frame_selection
                if count_matches_preset
                else list(range(returned_provider_frame_count))
            )
            if count_matches_preset and len(selection) != job.action.frame_count:
                raise ValidationHarnessError(
                    "provider frame selection does not match the project action",
                    details={"selection": selection, "project_frame_count": job.action.frame_count},
                )
            output_dir = self.store.job_dir(job_id) / "raw" / candidate.candidate_id
            raw_root = output_dir.parent
            raw_root.mkdir(parents=True, exist_ok=True)
            staging_dir = Path(tempfile.mkdtemp(prefix=f".{candidate.candidate_id}.", dir=raw_root))
            frames: list[FrameRecord] = []
            manifest_frames: list[dict[str, Any]] = []
            source_manifest_frames: list[dict[str, Any]] = []
            staged_records: list[tuple[int, str, str]] = []
            try:
                source_dir = staging_dir / "provider_source"
                source_dir.mkdir(parents=True, exist_ok=True)
                source_alpha: dict[int, bool] = {}
                for source_index, payload in enumerate(images):
                    path = source_dir / f"source_frame_{source_index:03d}.png"
                    self.service._atomic_write_bytes(path, payload)
                    with Image.open(path) as opened:
                        opened.load()
                        if opened.format != "PNG":
                            raise ValidationHarnessError(
                                "provider source frame is not PNG",
                                details={"source_index": source_index, "format": opened.format},
                            )
                        has_alpha = "A" in opened.getbands() or "transparency" in opened.info
                    source_alpha[source_index] = has_alpha
                    source_manifest_frames.append(
                        {
                            "source_index": source_index,
                            "output_name": f"provider_source/{path.name}",
                            "source_has_alpha": has_alpha,
                            "sha256": sha256_file(path),
                        }
                    )

                for index, source_index in enumerate(selection):
                    path = staging_dir / f"frame_{index:03d}.png"
                    self.service._atomic_write_bytes(path, images[source_index])
                    digest = sha256_file(path)
                    staged_records.append((index, path.name, digest))
                    manifest_frames.append(
                        {
                            "index": index,
                            "output_name": path.name,
                            "provider_source_index": source_index,
                            "source_has_alpha": source_alpha[source_index],
                            "sha256": digest,
                        }
                    )
                atomic_write_json(
                    staging_dir / "frames_manifest.json",
                    {
                        "schema_version": 1,
                        "source_kind": "provider",
                        "provider_job_id": expected_provider_job_id,
                        "diagnostic_only": diagnostic_only,
                        "provider_frame_count": returned_provider_frame_count,
                        "requested_provider_frame_count": requested_provider_frame_count,
                        "project_frame_count": len(selection),
                        "expected_project_frame_count": job.action.frame_count,
                        "frame_count_policy": (
                            "preset_selection" if count_matches_preset else "preserve_all_returned"
                        ),
                        "provider_frame_selection": selection,
                        "provider_source_frames": source_manifest_frames,
                        "frames": manifest_frames,
                    },
                )
                manifest_sha256 = sha256_file(staging_dir / "frames_manifest.json")
                atomic_write_json(
                    staging_dir / "result.commit.json",
                    {
                        "schema_version": 1,
                        "job_id": job_id,
                        "candidate_index": candidate_index,
                        "provider_job_id": expected_provider_job_id,
                        "frames_manifest_sha256": manifest_sha256,
                        "frame_count": len(staged_records),
                        "frames": [
                            {"index": index, "filename": filename, "sha256": digest}
                            for index, filename, digest in staged_records
                        ],
                    },
                )
                if output_dir.exists() and any(output_dir.iterdir()):
                    existing_fingerprints = [
                        (path.relative_to(output_dir).as_posix(), sha256_file(path))
                        for path in sorted(output_dir.rglob("*"))
                        if path.is_file()
                    ]
                    staged_fingerprints = [
                        (path.relative_to(staging_dir).as_posix(), sha256_file(path))
                        for path in sorted(staging_dir.rglob("*"))
                        if path.is_file()
                    ]
                    if existing_fingerprints != staged_fingerprints:
                        raise ConflictError(
                            "provider raw frame directory contains different immutable files",
                            details={"candidate_index": candidate_index},
                        )
                    shutil.rmtree(staging_dir)
                else:
                    if output_dir.exists():
                        output_dir.rmdir()
                    replace_with_retry(staging_dir, output_dir)
            except Exception as exc:
                if staging_dir.exists():
                    recovery_root = (
                        self.service.settings.recovery_dir
                        / "incomplete_provider_results"
                        / job_id
                    )
                    try:
                        recovery_root.mkdir(parents=True, exist_ok=True)
                        preserved = recovery_root / (
                            f"{candidate.candidate_id}_{utc_now().strftime('%Y%m%dT%H%M%S%fZ')}"
                            f"_{secrets.token_hex(4)}"
                        )
                        replace_with_retry(staging_dir, preserved)
                    except Exception:
                        # Leaving the hidden staging directory in place is safer
                        # than deleting paid bytes when even recovery storage is
                        # unavailable.
                        pass
                if isinstance(exc, HarnessError):
                    raise
                raise ValidationHarnessError(
                    "provider frames could not be validated and stored",
                    details={"error": str(exc), "type": type(exc).__name__},
                ) from exc
            for index, filename, digest in staged_records:
                path = output_dir / filename
                relative = relative_posix(path, self.store.job_dir(job_id))
                frames.append(FrameRecord(index=index, raw_path=relative, active_path=relative, sha256=digest))
            candidate.frames = frames
            candidate.diagnostic_only = diagnostic_only
            candidate.status = CandidateStatus.received
            candidate.result_manifest_path = relative_posix(
                output_dir / "frames_manifest.json",
                self.store.job_dir(job_id),
            )
            candidate.result_sha256 = sha256_file(output_dir / "result.commit.json")
            candidate.result_saved_at = utc_now()
            candidate.qa_completed_at = None
            candidate.qa_input_sha256 = None
            candidate.qa_algorithm_version = None
            candidate.error = None
            self.service._refresh_job_status(job)
            job.touch(
                "provider_frames_saved",
                candidate_index=candidate_index,
                frame_count=len(frames),
                provider_frame_count=returned_provider_frame_count,
                requested_provider_frame_count=requested_provider_frame_count,
                provider_frame_selection=selection,
                frame_count_policy=(
                    "preset_selection" if count_matches_preset else "preserve_all_returned"
                ),
                diagnostic_only=diagnostic_only,
            )
            return True

    def reconcile_saved_results(self, job_id: str) -> JobRecord:
        """Adopt a fully written raw result that predates its job.json update.

        The provider result directory is published atomically. A crash in the
        small interval before the job record save therefore leaves recoverable
        files on disk; this method verifies and attaches them without calling
        the provider or consuming another generation.
        """

        snapshot = self.store.load(job_id)
        if snapshot.request.provider not in {"pixellab", "fixture"}:
            return snapshot
        recoverable_indices: set[int] = set()
        for candidate in snapshot.candidates:
            output_dir = self.store.job_dir(job_id) / "raw" / candidate.candidate_id
            manifest_path = output_dir / "frames_manifest.json"
            commit_path = output_dir / "result.commit.json"
            raw_root = output_dir.parent
            completed_staging_exists = any(
                path.is_dir() and (path / "result.commit.json").is_file()
                for path in raw_root.glob(f".{candidate.candidate_id}.*")
            )
            if (manifest_path.is_file() or completed_staging_exists) and (
                not candidate.frames
                or candidate.result_manifest_path is None
                or candidate.result_sha256 is None
                or candidate.result_saved_at is None
                or not commit_path.is_file()
                or (
                    candidate.provider_job_id is not None
                    and candidate.submission_attempts == 0
                )
                or snapshot.generation_requested_at is None
            ):
                recoverable_indices.add(candidate.candidate_index)
        if not recoverable_indices:
            return snapshot
        adopted: list[int] = []
        with self.store.locked_job(job_id) as job:
            for candidate in job.candidates:
                if candidate.candidate_index not in recoverable_indices:
                    continue
                had_frames = bool(candidate.frames)
                output_dir = self.store.job_dir(job_id) / "raw" / candidate.candidate_id
                self._publish_completed_result_staging(job_id, candidate, output_dir)
                manifest_path = output_dir / "frames_manifest.json"
                if not manifest_path.is_file():
                    continue
                try:
                    manifest = read_json(manifest_path)
                    if not isinstance(manifest, dict) or manifest.get("source_kind") != "provider":
                        continue
                    manifest_provider_job_id = manifest.get("provider_job_id")
                    if (
                        manifest_provider_job_id
                        and candidate.provider_job_id
                        and manifest_provider_job_id != candidate.provider_job_id
                    ):
                        continue
                    records = manifest.get("frames")
                    if not isinstance(records, list) or not records:
                        continue
                    frames: list[FrameRecord] = []
                    commit_frames: list[dict[str, Any]] = []
                    for expected_index, record in enumerate(records):
                        if not isinstance(record, dict) or record.get("index") != expected_index:
                            raise ValidationHarnessError("stored provider frame manifest has invalid indices")
                        filename = record.get("output_name")
                        expected_sha = record.get("sha256")
                        if (
                            not isinstance(filename, str)
                            or Path(filename).name != filename
                            or not isinstance(expected_sha, str)
                        ):
                            raise ValidationHarnessError("stored provider frame manifest is invalid")
                        path = output_dir / filename
                        actual_sha = sha256_file(path)
                        if actual_sha != expected_sha:
                            raise ValidationHarnessError(
                                "stored provider frame checksum mismatch",
                                details={"frame_index": expected_index},
                            )
                        with Image.open(path) as image:
                            image.load()
                            if image.format != "PNG":
                                raise ValidationHarnessError("stored provider result is not PNG")
                        relative = relative_posix(path, self.store.job_dir(job_id))
                        frames.append(
                            FrameRecord(
                                index=expected_index,
                                raw_path=relative,
                                active_path=relative,
                                sha256=actual_sha,
                            )
                        )
                        commit_frames.append(
                            {"index": expected_index, "filename": filename, "sha256": actual_sha}
                        )
                    if had_frames:
                        if len(candidate.frames) != len(frames):
                            raise ValidationHarnessError(
                                "stored job frame count does not match its provider manifest"
                            )
                        for existing, verified in zip(candidate.frames, frames, strict=True):
                            if (
                                existing.index != verified.index
                                or existing.raw_path != verified.raw_path
                                or (
                                    existing.active_path == existing.raw_path
                                    and existing.sha256 != verified.sha256
                                )
                            ):
                                raise ValidationHarnessError(
                                    "stored job frame record does not match its provider result",
                                    details={"frame_index": verified.index},
                                )
                    commit_path = output_dir / "result.commit.json"
                    expected_commit = {
                        "schema_version": 1,
                        "job_id": job_id,
                        "candidate_index": candidate.candidate_index,
                        "provider_job_id": candidate.provider_job_id or manifest_provider_job_id,
                        "frames_manifest_sha256": sha256_file(manifest_path),
                        "frame_count": len(frames),
                        "frames": commit_frames,
                    }
                    if commit_path.is_file():
                        if read_json(commit_path) != expected_commit:
                            raise ValidationHarnessError("stored provider result commit marker is invalid")
                    else:
                        atomic_write_json(commit_path, expected_commit)
                    result_file_mtimes = [manifest_path.stat().st_mtime]
                    result_file_mtimes.extend(
                        (output_dir / item["filename"]).stat().st_mtime
                        for item in commit_frames
                    )
                    verified_saved_at = datetime.fromtimestamp(
                        max(result_file_mtimes),
                        tz=timezone.utc,
                    )
                    if not had_frames:
                        candidate.frames = frames
                    candidate.provider_job_id = candidate.provider_job_id or manifest_provider_job_id
                    if candidate.provider_job_id:
                        candidate.submission_attempts = max(
                            1,
                            candidate.submission_attempts,
                        )
                    candidate.submission_started_at = (
                        candidate.submission_started_at
                        or self._job_event_time(
                            job,
                            "candidate_submitting",
                            candidate.candidate_index,
                        )
                    )
                    candidate.submitted_at = (
                        candidate.submitted_at
                        or self._job_event_time(
                            job,
                            "candidate_submitted",
                            candidate.candidate_index,
                        )
                    )
                    candidate.provider_status = "completed"
                    candidate.provider_completed_at = (
                        candidate.provider_completed_at or verified_saved_at
                    )
                    candidate.result_manifest_path = relative_posix(manifest_path, self.store.job_dir(job_id))
                    candidate.result_sha256 = sha256_file(commit_path)
                    candidate.result_saved_at = candidate.result_saved_at or verified_saved_at
                    if job.generation_requested_at is None:
                        job.generation_requested_at = (
                            candidate.submission_started_at
                            or candidate.submitted_at
                            or candidate.provider_completed_at
                        )
                    candidate.diagnostic_only = bool(manifest.get("diagnostic_only", candidate.diagnostic_only))
                    if not had_frames:
                        candidate.status = CandidateStatus.received
                        candidate.error = None
                        candidate.qa_completed_at = None
                        candidate.qa_input_sha256 = None
                        candidate.qa_algorithm_version = None
                        job.touch(
                            "provider_frames_recovered_from_disk",
                            candidate_index=candidate.candidate_index,
                            frame_count=len(frames),
                            submission_created=False,
                        )
                        adopted.append(candidate.candidate_index)
                    else:
                        if (candidate.error or {}).get("code") == "stored_result_reconciliation_failed":
                            candidate.error = None
                        recovered_from_saving = candidate.status == CandidateStatus.saving
                        if recovered_from_saving:
                            candidate.status = CandidateStatus.received
                            candidate.qa_completed_at = None
                            candidate.qa_input_sha256 = None
                            candidate.qa_algorithm_version = None
                            adopted.append(candidate.candidate_index)
                        job.touch(
                            "provider_result_safety_metadata_upgraded",
                            candidate_index=candidate.candidate_index,
                            frame_count=len(frames),
                            timestamp_source="latest_result_file_mtime",
                            recovered_from_saving=recovered_from_saving,
                            submission_created=False,
                        )
                except Exception as exc:
                    next_error = {
                        "code": "stored_result_reconciliation_failed",
                        "message": str(exc),
                        "details": {"type": type(exc).__name__},
                    }
                    error_changed = candidate.error != next_error
                    status_changed = not had_frames and candidate.status != CandidateStatus.saving
                    if error_changed:
                        candidate.error = next_error
                    if status_changed:
                        candidate.status = CandidateStatus.saving
                    if error_changed or status_changed:
                        job.touch(
                            "stored_result_reconciliation_failed",
                            candidate_index=candidate.candidate_index,
                            error=candidate.error,
                        )
            self.service._refresh_job_status(job)

        for candidate_index in adopted:
            try:
                self.service.check_candidate(job_id, candidate_index)
            except Exception:
                # check_candidate persists its own recoverable QA error. One
                # broken candidate must not prevent later recovered candidates
                # in the same task from being checked.
                continue
        return self.store.load(job_id)

    @staticmethod
    def _job_event_time(
        job: JobRecord,
        event_name: str,
        candidate_index: int,
    ) -> datetime | None:
        for event in reversed(job.events):
            if (
                event.get("event") != event_name
                or event.get("candidate_index") != candidate_index
            ):
                continue
            value = event.get("at")
            if isinstance(value, datetime):
                return value
            if isinstance(value, str):
                try:
                    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    return (
                        parsed.replace(tzinfo=timezone.utc)
                        if parsed.tzinfo is None
                        else parsed
                    )
                except ValueError:
                    return None
        return None

    def _publish_completed_result_staging(
        self,
        job_id: str,
        candidate: CandidateRecord,
        output_dir: Path,
    ) -> bool:
        """Publish a fully committed pre-rename result left by a hard crash."""

        if output_dir.is_dir() and any(output_dir.iterdir()):
            return False
        raw_root = output_dir.parent
        for staging in sorted(
            raw_root.glob(f".{candidate.candidate_id}.*"),
            key=lambda path: path.name,
        ):
            if not staging.is_dir():
                continue
            try:
                commit = read_json(staging / "result.commit.json")
                manifest_path = staging / "frames_manifest.json"
                manifest = read_json(manifest_path)
                if (
                    not isinstance(commit, dict)
                    or not isinstance(manifest, dict)
                    or manifest.get("source_kind") != "provider"
                    or commit.get("job_id") != job_id
                    or commit.get("candidate_index") != candidate.candidate_index
                    or commit.get("frames_manifest_sha256") != sha256_file(manifest_path)
                ):
                    continue
                staged_provider_id = commit.get("provider_job_id")
                if (
                    candidate.provider_job_id
                    and staged_provider_id
                    and candidate.provider_job_id != staged_provider_id
                ):
                    continue
                commit_frames = commit.get("frames")
                manifest_frames = manifest.get("frames")
                if (
                    not isinstance(commit_frames, list)
                    or not commit_frames
                    or not isinstance(manifest_frames, list)
                    or len(commit_frames) != len(manifest_frames)
                    or commit.get("frame_count") != len(commit_frames)
                ):
                    continue
                valid = True
                for expected_index, (commit_frame, manifest_frame) in enumerate(
                    zip(commit_frames, manifest_frames, strict=True)
                ):
                    if not isinstance(commit_frame, dict) or not isinstance(manifest_frame, dict):
                        valid = False
                        break
                    filename = commit_frame.get("filename")
                    digest = commit_frame.get("sha256")
                    if (
                        commit_frame.get("index") != expected_index
                        or manifest_frame.get("index") != expected_index
                        or manifest_frame.get("output_name") != filename
                        or manifest_frame.get("sha256") != digest
                        or not isinstance(filename, str)
                        or Path(filename).name != filename
                        or not isinstance(digest, str)
                        or not re.fullmatch(r"[0-9a-f]{64}", digest)
                        or sha256_file(staging / filename) != digest
                    ):
                        valid = False
                        break
                if not valid:
                    continue
                if output_dir.exists():
                    output_dir.rmdir()
                os.replace(staging, output_dir)
                return True
            except Exception:
                continue
        return False

    def _committed_result_integrity(
        self,
        job_id: str,
        candidate: CandidateRecord,
    ) -> bool:
        if not candidate.result_manifest_path or not candidate.frames:
            return False
        job_dir = self.store.job_dir(job_id)
        manifest_path = self.store.resolve_job_path(job_id, candidate.result_manifest_path)
        commit_path = manifest_path.parent / "result.commit.json"
        if not manifest_path.is_file() or not commit_path.is_file():
            return False
        manifest_record = read_json(manifest_path)
        commit_record = read_json(commit_path)
        if (
            not isinstance(manifest_record, dict)
            or manifest_record.get("source_kind") != "provider"
            or not isinstance(commit_record, dict)
            or commit_record.get("job_id") != job_id
            or commit_record.get("candidate_index") != candidate.candidate_index
            or candidate.result_sha256 != sha256_file(commit_path)
            or commit_record.get("frames_manifest_sha256") != sha256_file(manifest_path)
        ):
            return False
        manifest_frames = manifest_record.get("frames")
        commit_frames = commit_record.get("frames")
        if (
            not isinstance(manifest_frames, list)
            or not isinstance(commit_frames, list)
            or len(manifest_frames) != len(commit_frames)
            or len(commit_frames) != len(candidate.frames)
            or commit_record.get("frame_count") != len(commit_frames)
        ):
            return False
        current_frames = {frame.index: frame for frame in candidate.frames}
        if len(current_frames) != len(candidate.frames):
            return False
        for expected_index, (manifest_frame, commit_frame) in enumerate(
            zip(manifest_frames, commit_frames, strict=True)
        ):
            if not isinstance(manifest_frame, dict) or not isinstance(commit_frame, dict):
                return False
            filename = commit_frame.get("filename")
            expected_sha = commit_frame.get("sha256")
            if (
                commit_frame.get("index") != expected_index
                or manifest_frame.get("index") != expected_index
                or manifest_frame.get("output_name") != filename
                or manifest_frame.get("sha256") != expected_sha
                or not isinstance(filename, str)
                or Path(filename).name != filename
                or not isinstance(expected_sha, str)
            ):
                return False
            raw_path = manifest_path.parent / filename
            current_frame = current_frames.get(expected_index)
            if (
                current_frame is None
                or current_frame.raw_path != relative_posix(raw_path, job_dir)
                or sha256_file(raw_path) != expected_sha
            ):
                return False
        return True

    def _assert_committed_result_integrity(
        self,
        job_id: str,
        job: JobRecord,
        candidate: CandidateRecord,
        *,
        error_class: type[HarnessError],
    ) -> None:
        """Require the immutable provider result before QA, approval or export.

        A repaired active frame may intentionally differ from its raw frame.
        This gate verifies only the original provider manifest, commit marker,
        and raw PNG bytes, so local edits remain usable without hiding loss of
        the paid source result.
        """

        if job.request.provider == "import":
            return
        verification_error: Exception | None = None
        try:
            intact = self._committed_result_integrity(job_id, candidate)
        except Exception as exc:
            intact = False
            verification_error = exc
        if intact:
            return
        details: dict[str, Any] = {
            "candidate_index": candidate.candidate_index,
            "provider": job.request.provider,
            "result_integrity": False,
        }
        if candidate.error:
            details["candidate_error"] = candidate.error
        if verification_error is not None:
            details["verification_error"] = str(verification_error)
        raise error_class(
            "stored provider result failed integrity verification; QA, approval and export are blocked",
            details=details,
        )

    def _snapshot_verified_frames(
        self,
        job_id: str,
        job: JobRecord,
        candidate: CandidateRecord,
        destination: Path,
    ) -> list[Path]:
        destination.mkdir(parents=False, exist_ok=False)
        snapshots: list[Path] = []
        try:
            for frame in candidate.frames:
                source = self.store.resolve_job_path(job_id, frame.active_path)
                payload = source.read_bytes()
                actual_sha = hashlib.sha256(payload).hexdigest()
                if actual_sha != frame.sha256:
                    raise ExportBlockedError(
                        "candidate frame changed while preparing the export snapshot",
                        details={
                            "frame_index": frame.index,
                            "expected_sha256": frame.sha256,
                            "actual_sha256": actual_sha,
                        },
                    )
                with Image.open(io.BytesIO(payload)) as image:
                    image.load()
                    valid_contract = (
                        image.format == "PNG"
                        and image.size == (job.character.cell_width, job.character.cell_height)
                        and ("A" in image.getbands() or "transparency" in image.info)
                    )
                if not valid_contract:
                    raise ExportBlockedError(
                        "candidate frame does not match the export PNG contract",
                        details={"frame_index": frame.index},
                    )
                snapshot = destination / f"frame_{frame.index:03d}.png"
                self.service._atomic_write_bytes(snapshot, payload)
                if sha256_file(snapshot) != frame.sha256:
                    raise ExportBlockedError(
                        "verified export snapshot checksum mismatch",
                        details={"frame_index": frame.index},
                    )
                snapshots.append(snapshot)
            return snapshots
        except Exception:
            shutil.rmtree(destination, ignore_errors=True)
            raise

    def _verified_frame_digest(
        self,
        job_id: str,
        job: JobRecord,
        candidate: CandidateRecord,
        *,
        error_class: type[HarnessError],
        require_png_contract: bool = True,
        require_expected_indices: bool = True,
    ) -> str:
        expected_frame_count = self.service._candidate_expected_frame_count(job, candidate)
        expected_indices = list(range(expected_frame_count))
        actual_indices = [frame.index for frame in candidate.frames]
        if require_expected_indices and actual_indices != expected_indices:
            raise error_class(
                "candidate frame order/count is not valid",
                details={"actual_indices": actual_indices, "expected_indices": expected_indices},
            )
        policy = {
            "qa_algorithm_version": QA_ALGORITHM_VERSION,
            "frame_count": expected_frame_count,
            "cell_width": job.character.cell_width,
            "cell_height": job.character.cell_height,
            "safe_margin": job.character.safe_margin,
            "anchor_ground_y": job.character.anchor.ground_y,
            "loop": job.action.loop,
            "grounded": job.action.grounded,
            "qa": job.character.qa.model_dump(mode="json"),
        }
        digest = hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        input_dir = self.store.job_dir(job_id) / "input"
        expected_inputs = dict(job.input_sha256)
        if "reference.png" in expected_inputs and expected_inputs["reference.png"] != job.reference_sha256:
            raise error_class("job reference checksums disagree")
        expected_inputs["reference.png"] = job.reference_sha256
        if job.input_sha256:
            actual_names = {path.name for path in input_dir.iterdir() if path.is_file()}
            expected_names = set(expected_inputs)
            if actual_names != expected_names:
                raise error_class(
                    "job input snapshot files changed after creation",
                    details={
                        "missing": sorted(expected_names - actual_names),
                        "unexpected": sorted(actual_names - expected_names),
                    },
                )
        else:
            for palette_path in sorted(input_dir.glob("palette.*"), key=lambda item: item.name):
                if palette_path.is_file():
                    expected_inputs[palette_path.name] = sha256_file(palette_path)
        for filename, expected_sha in sorted(expected_inputs.items()):
            path = input_dir / filename
            try:
                actual_sha = sha256_file(path)
            except Exception as exc:
                raise error_class(
                    "job QA input cannot be verified",
                    details={"filename": filename, "error": str(exc)},
                ) from exc
            if actual_sha != expected_sha:
                raise error_class(
                    "job QA input changed after creation",
                    details={"filename": filename, "expected_sha256": expected_sha, "actual_sha256": actual_sha},
                )
            digest.update(f"\ninput:{filename}:{actual_sha}".encode("utf-8"))

        manifest_paths: set[Path] = set()
        for frame in candidate.frames:
            try:
                path = self.store.resolve_job_path(job_id, frame.active_path)
                actual_sha = sha256_file(path)
                with Image.open(path) as image:
                    image.load()
                    image_format = image.format
                    image_size = image.size
                    has_alpha = "A" in image.getbands() or "transparency" in image.info
            except Exception as exc:
                raise error_class(
                    "candidate frame cannot be verified",
                    details={"frame_index": frame.index, "path": frame.active_path, "error": str(exc)},
                ) from exc
            if actual_sha != frame.sha256:
                raise error_class(
                    "candidate frame bytes changed after ingestion or repair",
                    details={"frame_index": frame.index, "expected_sha256": frame.sha256, "actual_sha256": actual_sha},
                )
            if require_png_contract and (
                image_format != "PNG"
                or image_size != (job.character.cell_width, job.character.cell_height)
                or not has_alpha
            ):
                raise error_class(
                    "candidate frame no longer matches the approved PNG contract",
                    details={
                        "frame_index": frame.index,
                        "format": image_format,
                        "size": list(image_size),
                        "has_alpha": has_alpha,
                    },
                )
            digest.update(f"\nframe:{frame.index}:{frame.active_path}:{actual_sha}".encode("utf-8"))
            manifest_paths.add(path.parent / "frames_manifest.json")
        for manifest_path in sorted(manifest_paths, key=lambda item: str(item)):
            relative_manifest = relative_posix(manifest_path, self.store.job_dir(job_id))
            manifest_sha = sha256_file(manifest_path) if manifest_path.is_file() else "missing"
            digest.update(f"\nmanifest:{relative_manifest}:{manifest_sha}".encode("utf-8"))
        return digest.hexdigest()

    def _assert_qa_current(self, job_id: str, job: JobRecord, candidate: CandidateRecord) -> None:
        self._assert_committed_result_integrity(
            job_id,
            job,
            candidate,
            error_class=ExportBlockedError,
        )
        if (
            candidate.qa_completed_at is None
            or not candidate.qa_input_sha256
            or candidate.qa_algorithm_version != QA_ALGORITHM_VERSION
        ):
            raise ExportBlockedError("candidate has no completed QA record")
        current_digest = self._verified_frame_digest(
            job_id,
            job,
            candidate,
            error_class=ExportBlockedError,
        )
        if current_digest != candidate.qa_input_sha256:
            raise ExportBlockedError(
                "candidate QA inputs changed after the last successful check",
                details={"expected_digest": candidate.qa_input_sha256, "actual_digest": current_digest},
            )
