"""Coordinate PixelLab background-job slots across local workers."""
from __future__ import annotations

import hashlib
import math
import time
from contextlib import ExitStack, contextmanager

from ..errors import ConflictError, ProviderConfigurationError, ProviderError
from ..jsonio import atomic_write_json, read_json


class AccountSlotBusy(ProviderError):
    code = "pixellab_account_queued"


def account_key(settings):
    if not settings.pixellab_api_key:
        raise ProviderConfigurationError("请先在原图或序列帧设置中保存 PixelLab API Key。")
    base = settings.pixellab_base_url.rstrip("/").removesuffix("/v2")
    return hashlib.sha256(f"{base}\0{settings.pixellab_api_key}".encode()).hexdigest()


def safe_usage(value):
    """Keep only the documented numeric usage and unit."""
    if not isinstance(value, dict):
        return {}
    amounts = {key: number for key in ("generations", "usd")
               if isinstance(number := value.get(key), (int, float)) and not isinstance(number, bool)
               and 0 <= number <= 2**53 and math.isfinite(number)}
    unit = value.get("type")
    if unit not in ("generations", "usd") or not amounts.get(unit):
        unit = next((key for key, amount in amounts.items() if amount > 0), unit)
    return {"type": unit, unit: amounts[unit]} if isinstance(unit, str) and unit in amounts else {}


class PixelLabSlot:
    def __init__(self, settings, store):
        self.key = account_key(settings)
        self.directory = settings.recovery_dir / "pixellab-slots" / self.key
        self.path = self.directory / "active.json"
        self.store = store
        self.poll_interval = settings.poll_interval_seconds
        self.max_wait = settings.max_wait_seconds

    @contextmanager
    def lock(self):
        with ExitStack() as held:
            try:
                held.enter_context(self.store.global_lock(f"pixellab-{self.key}", timeout_seconds=0))
            except ConflictError as exc:
                raise AccountSlotBusy("等待 PixelLab 账户空位") from exc
            yield

    def _receipt_path(self, intent_id):
        return self.directory / "receipts" / f"{hashlib.sha256(intent_id.encode()).hexdigest()}.json"

    def accepted_receipt(self, intent_id):
        path = self._receipt_path(intent_id)
        return read_json(path) if path.exists() else None

    def accept(self, job_id, intent_id, *, usage=None, status="processing"):
        if intent_id:
            atomic_write_json(self._receipt_path(intent_id), {"jobId": job_id, "usage": usage or {}, "status": status})
        self.remember(job_id)

    def reserve(self, intent_id):
        atomic_write_json(self.path, {"intent_id": intent_id, "check_after": time.time() + self.max_wait})

    def reject(self):
        self.path.unlink(missing_ok=True)

    def remember(self, job_id):
        atomic_write_json(self.path, {"job_id": job_id, "check_after": time.time() + self.poll_interval})

    def release(self, job_id):
        if self.path.exists() and read_json(self.path).get("job_id") == job_id:
            self.path.unlink(missing_ok=True)

    def require_available(self, check_status):
        if not self.path.exists():
            return
        active = read_json(self.path)
        if not active.get("job_id"):
            receipt = self.accepted_receipt(active["intent_id"])
            if receipt:
                self.remember(receipt["jobId"])
            elif active["check_after"] <= time.time():
                self.reject()
                return
            raise AccountSlotBusy("等待核对 PixelLab 上次提交")
        if active["check_after"] <= time.time():
            try:
                status = check_status(active["job_id"])
            except ProviderError as exc:
                status = "expired" if exc.details.get("http_status", exc.details.get("httpStatus")) == 404 else "unknown"
            if status in {"completed", "failed", "expired"}:
                self.release(active["job_id"])
                return
            self.remember(active["job_id"])
        raise AccountSlotBusy("等待 PixelLab 账户空位")


def animation_intent_id(job_id, candidate_index, stage=None):
    return f"animation:{job_id}:{candidate_index}:{stage if stage is not None else 'whole'}"
