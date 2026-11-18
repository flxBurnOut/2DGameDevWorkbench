from __future__ import annotations

import re
import shutil
import threading
import os
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from pydantic import ValidationError

from .errors import ConflictError, NotFoundError, ValidationHarnessError
from .jsonio import atomic_write_json, inside, read_json, relative_posix
from .models import JobRecord
from .settings import HarnessSettings


_JOB_ID = re.compile(r"^[0-9]{8}_[a-z0-9_]+_[0-9]{3}$")
_JOB_SUMMARY_SCHEMA_VERSION = 3
_JOB_SUMMARY_MAX_BYTES = 128 * 1024
_JOB_HISTORY = re.compile(r"^job_([0-9]+)\.json$")


class JobStore:
    """Atomic JSON job store for the single-machine harness."""

    def __init__(self, settings: HarnessSettings) -> None:
        self.settings = settings
        self._lock = threading.RLock()

    @contextmanager
    def global_lock(self, name: str, *, timeout_seconds: float = 30.0) -> Iterator[None]:
        if not re.fullmatch(r"[a-z0-9_.-]+", name):
            raise ValidationHarnessError("invalid global lock name", details={"name": name})
        lock_path = self.settings.jobs_dir / ".locks" / f"{name}.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with self._file_lock(lock_path, timeout_seconds=timeout_seconds, operation=name):
            yield

    @contextmanager
    def creation_lock(self, *, timeout_seconds: float = 30.0) -> Iterator[None]:
        with self.global_lock("job_creation", timeout_seconds=timeout_seconds):
            yield

    @contextmanager
    def submission_lock(self, *, timeout_seconds: float = 180.0) -> Iterator[None]:
        """Serialize every chargeable provider submission across processes."""

        with self.global_lock("chargeable_submission", timeout_seconds=timeout_seconds):
            yield

    @contextmanager
    def _process_lock(self, job_id: str, *, timeout_seconds: float = 30.0) -> Iterator[None]:
        """Use a crash-safe OS byte-range lock to serialize job mutations."""

        lock_path = self.job_dir(job_id) / ".job.lock"
        with self._file_lock(lock_path, timeout_seconds=timeout_seconds, operation="job mutation"):
            yield

    @contextmanager
    def operation_lock(
        self,
        job_id: str,
        operation: str,
        *,
        timeout_seconds: float = 30.0,
    ) -> Iterator[None]:
        """Serialize a named network operation without holding the JSON mutation lock."""

        if not re.fullmatch(r"[a-z0-9_.-]+", operation):
            raise ValidationHarnessError("invalid operation lock name", details={"operation": operation})
        lock_path = self.job_dir(job_id) / f".{operation}.lock"
        with self._file_lock(lock_path, timeout_seconds=timeout_seconds, operation=operation):
            yield

    @contextmanager
    def _file_lock(self, lock_path: Path, *, timeout_seconds: float, operation: str) -> Iterator[None]:
        """Lock one persistent byte; the OS releases it automatically after a crash."""

        descriptor = os.open(str(lock_path), os.O_CREAT | os.O_RDWR)
        handle = os.fdopen(descriptor, "r+b", buffering=0)
        acquired = False
        try:
            if os.fstat(descriptor).st_size == 0:
                try:
                    os.write(descriptor, b"\0")
                except PermissionError:
                    # Another process may have initialized and locked the byte
                    # between fstat and write. Join normal lock acquisition;
                    # genuine initialization/permission failures still surface.
                    if os.fstat(descriptor).st_size == 0:
                        raise
            deadline = time.monotonic() + timeout_seconds
            while not acquired:
                try:
                    handle.seek(0)
                    if os.name == "nt":
                        import msvcrt

                        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                except (OSError, BlockingIOError):
                    if time.monotonic() >= deadline:
                        raise ConflictError(
                            "job is busy in another process",
                            details={"job_id": lock_path.parent.name, "operation": operation},
                        )
                    time.sleep(0.05)
            yield
        finally:
            if acquired:
                try:
                    handle.seek(0)
                    if os.name == "nt":
                        import msvcrt

                        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(descriptor, fcntl.LOCK_UN)
                except OSError:
                    pass
            handle.close()

    def _validate_job_id(self, job_id: str) -> str:
        if not _JOB_ID.fullmatch(job_id):
            raise ValidationHarnessError("invalid job_id", details={"job_id": job_id})
        return job_id

    def job_dir(self, job_id: str) -> Path:
        return inside(self.settings.work_dir, self.settings.work_dir / self._validate_job_id(job_id))

    def create_layout(self, character_id: str, action_id: str) -> tuple[str, Path]:
        base = f"{datetime.now().strftime('%Y%m%d')}_{character_id}_{action_id}"
        with self._lock:
            for number in range(1, 1000):
                job_id = f"{base}_{number:03d}"
                directory = self.settings.work_dir / job_id
                try:
                    directory.mkdir(parents=True, exist_ok=False)
                except FileExistsError:
                    continue
                for name in ("input", "raw", "repaired", "previews", "export", "provider"):
                    (directory / name).mkdir()
                return job_id, directory
        raise ValidationHarnessError("daily job id space exhausted")

    @staticmethod
    def _summary_from_job(job: JobRecord) -> dict[str, Any]:
        from .collaboration.state_assets import catalog_rows
        terminal_candidates = {"approved", "rejected", "failed"}
        status_counts: dict[str, int] = {}
        for candidate in job.candidates:
            value = candidate.status.value
            status_counts[value] = status_counts.get(value, 0) + 1

        repair_candidates = [
            candidate
            for candidate in job.candidates
            if candidate.status.value not in terminal_candidates
            and not (job.export and job.export.candidate_index == candidate.candidate_index)
            and any(frame.review_status.value == "repair_requested" for frame in candidate.frames)
        ]
        active_provider_states = {
            "submitting",
            "submission_unknown",
            "provider_pending",
            "saving",
        }
        needs_recovery = bool(
            job.request.provider == "pixellab"
            and job.generation_requested_at is not None
            and any(
                candidate.status.value in active_provider_states
                or (candidate.error or {}).get("code") in {"insufficient_quota", "pixellab_account_queued"}
                or (
                    candidate.provider_status == "completed"
                    and bool(candidate.provider_job_id)
                    and not candidate.frames
                )
                for candidate in job.candidates
            )
        )
        from .motion_correction import active as motion_active
        needs_recovery = needs_recovery or (motion_active(job) and job.generation_requested_at is not None)
        if job.request.open_plan and job.plan_control and job.generation_requested_at is not None:
            needs_recovery = any(
                c.plan_execution and not c.frames and c.status.value not in terminal_candidates and (
                    any(r.state in {"submitting", "pending", "reviewing", "repairing", "complete"} for r in c.plan_execution.stages)
                    or (job.plan_control.enabled and all(r.state not in {"failed", "unknown", "awaiting_review", "rejected"} for r in c.plan_execution.stages))
                ) for c in job.candidates
            )
            needs_recovery = needs_recovery or any(c.frames and c.plan_execution and
                (c.plan_execution.quality_review or {}).get('state') in {'pending','running'} for c in job.candidates)
        return {
            "summary_schema_version": _JOB_SUMMARY_SCHEMA_VERSION,
            "job_revision": job.revision,
            "job_id": job.job_id,
            "open_work_id": job.request.open_plan.work_id if job.request.open_plan else None,
            "status": job.status.value,
            "updated_at": job.updated_at.isoformat(),
            "created_at": job.created_at.isoformat(),
            "provider": job.request.provider,
            "object_id": job.character.object_id,
            "object_type": job.character.object_type,
            "object_name": job.character.display_name,
            "character_id": job.character.character_id,
            "character_name": job.character.display_name,
            "action_id": job.action.action_id,
            "action_name": job.action.display_name or job.action.action_id,
            "generation_requested": job.generation_requested_at is not None,
            "candidate_count": len(job.candidates),
            "saved_candidate_count": sum(bool(candidate.frames) for candidate in job.candidates),
            "total_frame_count": sum(len(candidate.frames) for candidate in job.candidates),
            "approved_candidate_count": sum(
                candidate.status.value == "approved" for candidate in job.candidates
            ),
            "rejected_candidate_count": sum(
                candidate.status.value == "rejected" for candidate in job.candidates
            ),
            "repair_candidate_count": len(repair_candidates),
            "repair_frame_count": sum(
                frame.review_status.value == "repair_requested"
                for candidate in repair_candidates
                for frame in candidate.frames
            ),
            "candidate_status_counts": status_counts,
            "exported": job.export is not None,
            "export_candidate_index": job.export.candidate_index if job.export else None,
            "needs_recovery": needs_recovery,
            "motion_state": (job.motion_control or {}).get("state"),
            "motion_message": (job.motion_control or {}).get("message"),
            "execution_only": job.request.motion_repair is not None,
            # Materials only: execution-only candidates stay in task history.
            **({"state_assets": catalog_rows(job)} if job.character.object_type == "interactable" and job.request.open_plan else {}),
            "artworks": [
                {
                    "candidate_index": candidate.candidate_index,
                    "status": candidate.status.value,
                    "frame_count": len(candidate.frames),
                    "first_frame": candidate.frames[0].active_path,
                    "preview": f"previews/{candidate.candidate_id}.preview.gif",
                    "qa_algorithm_version": candidate.qa_algorithm_version,
                    "qa_ready": bool(candidate.qa_completed_at and candidate.qa_input_sha256 and not candidate.error),
                    "hard_failure_count": len(candidate.hard_failures),
                    "repair_frame_count": sum(f.review_status.value == "repair_requested" for f in candidate.frames),
                    "modified": any(f.manual_edit_versions or f.repair_attempts for f in candidate.frames),
                    "exported": bool(job.export and job.export.candidate_index == candidate.candidate_index),
                    "diagnostic_only": candidate.diagnostic_only,
                }
                for candidate in job.candidates if candidate.frames and job.request.attack_segment is None
            ],
        }

    def _write_summary(self, job: JobRecord) -> None:
        atomic_write_json(
            self.job_dir(job.job_id) / "summary.json",
            self._summary_from_job(job),
        )

    def _read_summary(self, directory: Path) -> dict[str, Any]:
        path = directory / "summary.json"
        info = path.stat()
        if info.st_size > _JOB_SUMMARY_MAX_BYTES:
            raise ValueError("job summary is missing or too large")
        summary = read_json(path)
        if (
            not isinstance(summary, dict)
            or summary.get("summary_schema_version") != _JOB_SUMMARY_SCHEMA_VERSION
            or (summary.get("object_type") == "interactable" and summary.get("open_work_id") and "state_assets" not in summary)
            or summary.get("job_id") != directory.name
            or type(summary.get("job_revision")) is not int
            or summary["job_revision"] < 0
            or not isinstance(summary.get("status"), str)
            or not isinstance(summary.get("updated_at"), str)
        ):
            raise ValueError("job summary is invalid")
        # A writer publishes its journal before job.json and its catalog row
        # last. Check the durable revision names without opening the records.
        revisions = (_JOB_HISTORY.fullmatch(entry.name) for entry in (directory / "history").glob("job_*.json"))
        if any(match and int(match[1]) > summary["job_revision"] for match in revisions):
            raise ValueError("job summary predates the recovery journal")
        try:
            if (directory / "job.json").stat().st_mtime_ns > info.st_mtime_ns:
                raise ValueError("job summary predates the current record")
        except FileNotFoundError:
            if not (directory / "history" / f"job_{summary['job_revision']:08d}.json").is_file():
                raise
        return summary

    def save(self, job: JobRecord) -> Path:
        with self._lock, self._process_lock(job.job_id):
            return self._save(job)

    def _save(self, job: JobRecord) -> Path:
        directory = self.job_dir(job.job_id)
        path = directory / "job.json"
        # Publish the complete recovery revision before the current pointer.
        history = directory / "history" / f"job_{job.revision:08d}.json"
        record = job.model_dump(mode="json")
        atomic_write_json(history, record)
        atomic_write_json(path, record)
        # Catalog failures cannot make a durable provider result appear to fail.
        try:
            self._write_summary(job)
        except OSError:
            pass
        return path

    def load(self, job_id: str) -> JobRecord:
        path = self.job_dir(job_id) / "job.json"
        primary_error: Exception | None = None
        primary: JobRecord | None = None
        if path.is_file():
            try:
                primary = JobRecord.model_validate(read_json(path))
                if primary.job_id != job_id:
                    raise ValueError("current job record belongs to a different job")
            except (ValidationError, ValueError, OSError) as exc:
                primary_error = exc
        history_dir = self.job_dir(job_id) / "history"
        latest_history: JobRecord | None = None
        for recovery_path in sorted(history_dir.glob("job_*.json"), reverse=True):
            try:
                recovered = JobRecord.model_validate(read_json(recovery_path))
                filename_revision = int(recovery_path.stem.rsplit("_", 1)[1])
                if recovered.job_id != job_id or recovered.revision != filename_revision:
                    continue
                latest_history = recovered
                break
            except (ValidationError, ValueError, OSError, IndexError):
                continue
        selected: JobRecord | None = None
        if primary is not None and latest_history is not None:
            # save() publishes the journal before job.json. A crash between
            # those writes leaves a valid but stale current pointer. Selecting
            # the highest durable revision preserves a just-returned provider
            # job ID and prevents an unsafe second POST.
            selected = latest_history if latest_history.revision > primary.revision else primary
        elif primary is not None:
            selected = primary
        elif latest_history is not None:
            selected = latest_history
        elif not path.is_file() and not history_dir.is_dir():
            raise NotFoundError("job not found", details={"job_id": job_id})
        else:
            raise ValidationHarnessError(
                "job record and its recovery journal are invalid",
                details={"job_id": job_id, "error": str(primary_error) if primary_error else "no valid revision"},
            )

        return selected

    def _repair_summary(self, directory: Path) -> dict[str, Any]:
        # Re-read under the same process lock as writers. A deep read may
        # legitimately return an older snapshot while a save is in flight.
        try:
            with self._process_lock(directory.name, timeout_seconds=0):
                try:
                    return self._read_summary(directory)
                except (OSError, ValueError):
                    job = self.load(directory.name)
                    summary = self._summary_from_job(job)
                    try:
                        atomic_write_json(directory / "summary.json", summary)
                    except OSError:
                        pass
                    return summary
        except (ConflictError, OSError):
            return self._summary_from_job(self.load(directory.name))

    def find_by_request_key(self, request_key: str) -> JobRecord | None:
        if not request_key:
            return None
        directories = [
            path
            for path in self.settings.jobs_dir.iterdir()
            if path.is_dir() and _JOB_ID.fullmatch(path.name)
        ]
        for directory in sorted(directories, key=lambda item: item.name, reverse=True):
            try:
                job = self.load(directory.name)
            except Exception:
                continue
            if job.request.request_key == request_key:
                return job
        return None

    def snapshot_file(self, job_id: str, source: Path, filename: str) -> str:
        if not filename or Path(filename).name != filename or filename in {".", ".."}:
            raise ValidationHarnessError("snapshot filename must be a plain filename")
        destination = inside(self.job_dir(job_id) / "input", self.job_dir(job_id) / "input" / filename)
        source_resolved = source.resolve()
        if not source_resolved.is_file():
            raise NotFoundError("snapshot source not found", details={"path": str(source)})
        shutil.copy2(source_resolved, destination)
        return relative_posix(destination, self.job_dir(job_id))

    def resolve_job_path(self, job_id: str, relative: str) -> Path:
        return inside(self.job_dir(job_id), self.job_dir(job_id) / Path(relative))

    def list_jobs(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        if not self.settings.work_dir.exists():
            return result
        directories = [
            path
            for path in self.settings.work_dir.iterdir()
            if path.is_dir() and _JOB_ID.fullmatch(path.name)
        ]
        for directory in sorted(directories, key=lambda item: item.name, reverse=True):
            try:
                result.append(self._read_summary(directory))
            except Exception:
                try:
                    result.append(self._repair_summary(directory))
                except Exception:
                    result.append({"job_id": directory.name, "status": "invalid", "updated_at": ""})
        return sorted(
            result,
            key=lambda row: (str(row.get("updated_at", "")), str(row.get("job_id", ""))),
            reverse=True,
        )

    @contextmanager
    def locked_job(self, job_id: str) -> Iterator[JobRecord]:
        """Serialize mutations in this process and persist on successful exit."""

        with self._lock:
            with self._process_lock(job_id):
                job = self.load(job_id)
                before = job.model_dump(mode="json")
                yield job
                # Read/verify paths also use this context manager. Do not create
                # an append-only history revision when their observable state
                # did not change (notably repeated recovery of one bad result).
                if job.model_dump(mode="json") != before:
                    job.revision += 1
                    self._save(job)
