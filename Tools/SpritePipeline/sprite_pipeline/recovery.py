from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Any

from .providers.account import AccountSlotBusy
from .reference_queue import ReferenceQueue
from .service import SpritePipelineService


class RecoveryWorker:
    """Daemon that resumes durable provider jobs while API/UI is running."""

    def __init__(self, service: SpritePipelineService, *, interval_seconds: float | None = None) -> None:
        self.service = service
        self.interval_seconds = float(interval_seconds or service.settings.poll_interval_seconds)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._planning_thread: threading.Thread | None = None
        self._structure_thread: threading.Thread | None = None
        self._reference_thread: threading.Thread | None = None
        self.reference_queue = ReferenceQueue(service)
        self._state_lock = threading.Lock()
        self._last_scan: dict[str, Any] | None = None
        self._last_error: dict[str, Any] | None = None
        self._reference_error: dict[str, str] | None = None
        self._motion_scans = {phase: {'last_scan': None, 'last_error': None, 'last_success_at': None}
                              for phase in ('planning', 'adjustments')}

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="sprite-pipeline-recovery",
            daemon=True,
        )
        self._thread.start()
        self._planning_thread = threading.Thread(target=self._run_planning, name="sprite-open-motion-planning", daemon=True)
        self._planning_thread.start()
        self._structure_thread = threading.Thread(target=self._run_structures, name="sprite-visual-structure", daemon=True)
        self._structure_thread.start()
        self._reference_thread = threading.Thread(target=self._run_references, name="sprite-reference-generation", daemon=True)
        self._reference_thread.start()

    def stop(self, timeout_seconds: float = 5.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=max(0.0, timeout_seconds))

    def _run_references(self) -> None:
        while not self._stop.is_set():
            try:
                self.reference_queue.advance()
                error = None
            except AccountSlotBusy:
                error = None  # Another local process owns the next operation.
            except Exception as exc:
                error = {"at": datetime.now(timezone.utc).isoformat(), "type": type(exc).__name__}
            with self._state_lock:
                self._reference_error = error
            if self._stop.wait(self.interval_seconds):
                break

    def _run_planning(self) -> None:
        from .collaboration.adjustments import Adjustments
        from .collaboration.workspace import OpenMotionWorkspace
        workspace = OpenMotionWorkspace(self.service)
        adjustments = Adjustments(self.service)
        while not self._stop.is_set():
            self._scan_motion('planning', workspace.recover_planning)
            if not self._stop.is_set():
                self._scan_motion('adjustments', adjustments.recover)
            if self._stop.wait(self.interval_seconds):
                break

    def _scan_motion(self, phase, scan) -> None:
        from .collaboration.workspace import now, record_error
        try:
            result = scan(stopping=self._stop.is_set)
        except Exception as exc:
            with self._state_lock:
                self._motion_scans[phase]['last_error'] = record_error(exc, at=now())
        else:
            with self._state_lock:
                state = self._motion_scans[phase]
                state.update(last_scan=result, last_error=None)
                if not self._stop.is_set():
                    state['last_success_at'] = now()

    def _run_structures(self) -> None:
        from .collaboration.structures import VisualStructures
        structures = VisualStructures(self.service)
        while not self._stop.is_set():
            try:
                structures.recover(stopping=self._stop.is_set)
                if not self._stop.is_set():
                    from .collaboration.tracking import TemporalStructures
                    TemporalStructures(self.service).recover(stopping=self._stop.is_set)
            except Exception:
                # Durable request state prevents a paid call from being replayed.
                pass
            if self._stop.wait(self.interval_seconds):
                break

    def snapshot(self) -> dict[str, Any]:
        with self._state_lock:
            return {
                "running": bool(self._thread and self._thread.is_alive()),
                "interval_seconds": self.interval_seconds,
                "last_scan": self._last_scan,
                "last_error": self._last_error,
                "reference_error": self._reference_error,
                **{phase: dict(scan) for phase, scan in self._motion_scans.items()},
            }

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                scan = self.service.recover_pending_jobs()
                with self._state_lock:
                    self._last_scan = scan
                    self._last_error = None
            except Exception as exc:
                with self._state_lock:
                    self._last_error = {
                        "at": datetime.now(timezone.utc).isoformat(),
                        "message": str(exc),
                        "type": type(exc).__name__,
                    }
            if self._stop.wait(self.interval_seconds):
                break
