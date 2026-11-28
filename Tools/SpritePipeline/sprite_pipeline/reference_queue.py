"""Durable Pixflux submission and polling for a local SpritePipeline installation."""
from __future__ import annotations

import json
import math
import sqlite3
import time
from contextlib import closing, contextmanager
from urllib.parse import quote

from .errors import ConflictError, NotFoundError, ProviderError
from .providers.account import AccountSlotBusy, PixelLabSlot, account_key


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 2**53:
        return None
    return value if math.isfinite(value) else None


def has_charge(usage):
    return bool(usage and usage.get(usage["type"], 0) > 0)


class ReferenceQueue:
    def __init__(self, service):
        self.service = service

    @property
    def path(self):
        return self.service.settings.recovery_dir / "reference-requests.sqlite3"

    @contextmanager
    def _db(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("""
                CREATE TABLE IF NOT EXISTS requests (
                    id TEXT PRIMARY KEY, account TEXT NOT NULL, payload TEXT NOT NULL,
                    state TEXT NOT NULL, receipt TEXT NOT NULL DEFAULT '{}', busy_since REAL
                )
            """)
            db.execute("CREATE INDEX IF NOT EXISTS pending ON requests (account, state)")
            yield db

    def enqueue(self, request_id, payload):
        account = account_key(self.service.settings)
        with self._db() as db:
            db.execute("INSERT OR IGNORE INTO requests (id, account, payload, state) VALUES (?, ?, ?, 'queued')",
                       (request_id, account, json.dumps(payload)))
            row = db.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
            if account != row["account"] or payload != json.loads(row["payload"]):
                raise ConflictError("该原图请求编号已用于其他输入或 PixelLab 凭据。")
        return self._public(row)

    def status(self, request_id):
        with self._db() as db:
            row = db.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
        if row is None:
            raise NotFoundError("没有找到原图请求记录。")
        return self._public(row)

    def submit_immediate(self, request_id, payload):
        """Keep the legacy API's 202 contract for callers without a request ID."""
        settings = self.service.settings
        slot = PixelLabSlot(settings, self.service.store)
        with slot.lock():
            with self._db() as db:
                db.execute("BEGIN IMMEDIATE")
                if self._next(slot.key, db):
                    raise AccountSlotBusy("PixelLab 当前任务过多，请稍后再试。")
                db.execute("INSERT INTO requests (id, account, payload, state) VALUES (?, ?, ?, 'queued')",
                           (request_id, slot.key, json.dumps(payload)))
                row = db.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
            self._submit(row, settings, slot)
            receipt = self.status(request_id)
            if receipt["stage"] == "queued":
                self._save(row, "not_submitted", {"error": "PixelLab 当前任务过多，请稍后再试。"})
                return self.status(request_id)
            return receipt

    def _public(self, row):
        state = row["state"]
        receipt = json.loads(row["receipt"])
        if state in {"queued", "running"}:
            settings = self.service.settings
            if not settings.pixellab_api_key or row["account"] != account_key(settings):
                receipt["error"] = ("此请求在等待原 PixelLab 凭据，尚未提交。" if state == "queued"
                                    else "请恢复提交时使用的 PixelLab 凭据，以继续读取上游任务。")
        return {"requestId": row["id"], "stage": state, **receipt,
                "status": "running" if state in {"queued", "submitting"} else state}

    def _save(self, row, state, receipt, *, busy_since=None):
        with self._db() as db:
            db.execute("UPDATE requests SET state = ?, receipt = ?, busy_since = ? WHERE id = ?",
                       (state, json.dumps(receipt), busy_since, row["id"]))

    @staticmethod
    def _next(account, db):
        return db.execute("""
            SELECT * FROM requests WHERE account = ? AND state IN ('queued', 'submitting', 'running')
            ORDER BY state = 'queued', rowid LIMIT 1
        """, (account,)).fetchone()

    def advance(self):
        """One worker advances a credential's oldest job across local processes."""
        settings = self.service.settings
        if not self.path.exists() or not settings.pixellab_api_key:
            return
        slot = PixelLabSlot(settings, self.service.store)
        with slot.lock():
            with self._db() as db:
                row = self._next(slot.key, db)
            if row is None:
                return
            if row["state"] == "submitting":
                # The process stopped before it recorded the result of its POST.
                accepted = slot.accepted_receipt(f"reference:{row['id']}")
                receipt = json.loads(row["receipt"])
                if accepted:
                    self._save(row, "running", {**receipt, "jobId": accepted["jobId"], "usage": accepted["usage"]})
                else:
                    self._save(row, "attention_required", {**receipt, "error":
                               "提交结果无法确认。请核对原 PixelLab 请求，勿重复生成。"})
            elif row["state"] == "queued":
                self._submit(row, settings, slot)
            else:
                self._poll(row, settings, slot)

    def _submit(self, row, settings, slot):
        from .reference_art import _provider_request

        def check_status(job_id):
            data = _provider_request(settings, "GET", "/background-jobs/" + quote(job_id, safe=''))
            return data.get("status") if data.get("id") == job_id else None
        try:
            slot.require_available(check_status)
        except AccountSlotBusy:
            return
        try:
            data = _provider_request(settings, "GET", "/balance")
        except ProviderError as exc:
            self._save(row, "not_submitted", {"error": f"无法读取 PixelLab 余额，未提交原图。{exc.message}"})
            return
        subscription, credits = data.get("subscription"), data.get("credits")
        generations = _number(subscription.get("generations")) if isinstance(subscription, dict) else None
        usd = _number(credits.get("usd")) if isinstance(credits, dict) else None
        if generations is None or usd is None:
            self._save(row, "not_submitted", {"error": "PixelLab 未返回可核实的余额，未提交原图。"})
            return
        receipt = {"balance": {"generations": generations, "usd": usd}}
        if generations < 1 and usd == 0:
            self._save(row, "not_submitted", {**receipt, "error": "PixelLab 额度不足，未提交原图。"})
            return
        self._save(row, "submitting", receipt)
        intent_id = f"reference:{row['id']}"
        slot.reserve(intent_id)
        try:
            accepted = _provider_request(settings, "POST", "/create-image-pixflux-background", json.loads(row["payload"]))
        except ProviderError as exc:
            info = exc.details
            receipt.update({key: info[key] for key in ("jobId", "httpStatus", "usage") if key in info})
            if receipt.get("jobId"):
                slot.accept(receipt["jobId"], intent_id, usage=receipt.get("usage"))
                self._save(row, "running", {**receipt, "error": "已取得 PixelLab 任务标识，正在核对原请求。"})
                return
            if info.get("notSubmitted"):
                slot.reject()
            if info.get("httpStatus") == 429 and info.get("notSubmitted"):
                busy_since = row["busy_since"] if row["busy_since"] is not None else time.time()
                if time.time() - busy_since < settings.max_wait_seconds:
                    self._save(row, "queued", receipt, busy_since=busy_since)
                    return
            state = "not_submitted" if info.get("notSubmitted") else "attention_required"
            self._save(row, state, {**receipt, "error": exc.message})
            return
        slot.accept(accepted["jobId"], intent_id, usage=accepted.get("usage"))
        self._save(row, "running", {**receipt, **accepted})

    def _poll(self, row, settings, slot):
        from .reference_art import _poll_reference

        receipt = json.loads(row["receipt"])
        try:
            result = _poll_reference(settings, receipt["jobId"], json.loads(row["payload"])["image_size"]["width"])
        except ProviderError as exc:
            busy_since = row["busy_since"] if row["busy_since"] is not None else time.time()
            if exc.details.get("httpStatus") in {401, 403, 404} or time.time() - busy_since >= settings.max_wait_seconds:
                self._save(row, "attention_required", {**receipt, "error": exc.message})
                if exc.details.get("httpStatus") == 404:
                    slot.release(receipt["jobId"])
            else:
                self._save(row, "running", {**receipt, "error": exc.message}, busy_since=busy_since)
            return
        receipt.pop("error", None)
        status = result.pop("status")
        if has_charge(receipt.get("usage")) and not has_charge(result.get("usage")):
            result.pop("usage", None)
        self._save(row, status, {**receipt, **result})
        if status in {"completed", "failed"}:
            slot.release(receipt["jobId"])
