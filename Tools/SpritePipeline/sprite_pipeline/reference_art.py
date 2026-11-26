"""Workbench PixelLab reference images, sharing the animation service's credentials.

The Node workbench owns task and output files. The local queue records upstream
receipts and never replays a submission with an uncertain outcome.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import re
import tempfile
import threading
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from fastapi import APIRouter
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from .errors import ProviderConfigurationError, ProviderPermanentError, ValidationHarnessError
from .providers.account import AccountSlotBusy, safe_usage
from .reference_queue import ReferenceQueue, has_charge
from .service import SpritePipelineService
from . import prop_reference
from .pixel_prop_gateway import conversion
from .reference_orientation import check_orientation


class ReferenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=2000)
    facing: Literal["right", "left"] = "right"
    seed: int | None = Field(default=None, ge=0, le=2147483647)
    size: Literal[64, 128] = 128


class PropTransferRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sourceTaskId: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$")
    identityDescription: str = Field(default="", max_length=1000)
    confirmation: 'PropConfirmation | None' = None


class PropConfirmation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    note: str = Field(min_length=4, max_length=1000)


class PropConvertRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    sourceTaskId: str | None = Field(default=None, pattern=r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$')
    sourceImagePath: str | None = Field(default=None, min_length=1, max_length=1000)
    sourceImage: str | None = Field(default=None, max_length=40_000_100)
    recipe: dict = Field(default_factory=dict)


class KeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    apiKey: str = Field(min_length=8, max_length=4096)


class OrientationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    taskId: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$")
    image: str = Field(min_length=1, max_length=2_000_000)
    facing: Literal["right", "left"]
    authorized: Literal[True]


class ImportRequest(ReferenceRequest):
    prompt: str = Field(min_length=1, max_length=1000)
    image: str = Field(min_length=1, max_length=2_000_000)
    reuseIdentity: bool = False
    characterId: str = Field(pattern=r"^reference_[a-f0-9]{24}$")
    name: str = Field(min_length=1, max_length=80)


class GenerateRequest(ReferenceRequest):
    requestId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$")


_JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$")
_UNKNOWN_SUBMISSION = "提交结果无法确认。请核对原 PixelLab 请求，勿重复生成。"


def _provider_request(settings, method: str, route: str, payload=None):
    key = settings.pixellab_api_key
    if not key:
        raise ProviderConfigurationError("请先在原图或序列帧设置中保存 PixelLab API Key。")
    base = settings.pixellab_base_url.rstrip("/")
    parsed = urlparse(base)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or (
        parsed.scheme != "https" and not (
            parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        )
    ):
        raise ProviderConfigurationError("PixelLab 地址必须使用 HTTPS；本机测试可用 HTTP。")
    api_root = base if base.endswith("/v2") else base + "/v2"
    max_bytes = settings.max_download_bytes if route.startswith("/background-jobs/") else 2_000_000
    try:
        with httpx.Client(timeout=settings.http_timeout_seconds, follow_redirects=False) as client:
            with client.stream(method, api_root + route, json=payload,
                               headers={"Authorization": f"Bearer {key}"}) as response:
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise ValueError("oversized response")
                try:
                    data = json.loads(body)
                except ValueError:
                    data = None
                if response.status_code >= 300:
                    details = {"httpStatus": response.status_code}
                    if method == "POST":
                        job_id = data.get("background_job_id") if isinstance(data, dict) else None
                        usage = safe_usage(data.get("usage")) if isinstance(data, dict) else {}
                        if isinstance(job_id, str) and _JOB_ID.fullmatch(job_id):
                            details["jobId"] = job_id
                        if usage:
                            details["usage"] = usage
                        raw_usage = data.get("usage") if isinstance(data, dict) else None
                        charged = has_charge(usage) or (isinstance(raw_usage, dict) and any(
                            isinstance(raw_usage.get(key), (int, float)) and raw_usage[key] > 0 for key in ("usd", "generations")
                        ))
                        details["notSubmitted"] = (response.status_code in {401, 402, 403, 422, 429}
                                                   and not job_id and not charged)
                    messages = {401: "PixelLab Key 无效。", 402: "PixelLab 额度不足。", 403: "PixelLab 拒绝访问。",
                                404: "PixelLab 任务不存在或已过期。", 422: "PixelLab 拒绝原图参数。",
                                429: "PixelLab 当前任务过多，尚未提交。"}
                    message = messages.get(response.status_code, f"PixelLab 返回 HTTP {response.status_code}。")
                    if method == "POST" and not details["notSubmitted"]:
                        message = _UNKNOWN_SUBMISSION
                    raise ProviderPermanentError(message, details=details)
                if not isinstance(data, dict):
                    raise ValueError("expected JSON object")
                if method != "POST":
                    return data
                job_id = data.get("background_job_id")
                usage = safe_usage(data.get("usage"))
                if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
                    raise ProviderPermanentError(_UNKNOWN_SUBMISSION, details={"usage": usage} if usage else {})
                return {"jobId": job_id, **({"usage": usage} if usage else {})}
    except (httpx.HTTPError, ValueError) as exc:
        # Never echo upstream bodies, URLs or exception text: they may contain secrets.
        message = _UNKNOWN_SUBMISSION if method == "POST" else "PixelLab 状态读取失败，可继续查询同一个任务。"
        raise ProviderPermanentError(message) from exc


def validate_reference_image(encoded: str, expected_size: int | None = None) -> bytes:
    if encoded.startswith("data:"):
        if not encoded.startswith("data:image/png;base64,"):
            raise ValidationHarnessError("原图必须是 PNG。")
        encoded = encoded.split(",", 1)[1]
    try:
        data = base64.b64decode(encoded, validate=True)
        if len(data) > 1_000_000:
            raise ValueError("oversize")
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "PNG" or (image.size not in ((64, 64), (128, 128)) or (expected_size is not None and image.size != (expected_size, expected_size))):
                raise ValueError("size or format")
            image.load()
            if "A" not in image.getbands() and "transparency" not in image.info:
                raise ValueError("missing alpha")
            alpha = image.convert("RGBA").getchannel("A")
            if alpha.getbbox() is None or alpha.getextrema()[0] == 255:
                raise ValueError("empty or opaque")
        return data
    except (ValueError, binascii.Error, OSError) as exc:
        raise ValidationHarnessError("原图需要是 64×64 或 128×128、含角色且带透明背景的 PNG；请重新生成或使用其他图片。") from exc


def _poll_reference(settings, job_id, size=None):
    data = _provider_request(settings, "GET", "/background-jobs/" + job_id)
    state = data.get("status")
    if data.get("id") != job_id:
        return {"status": "attention_required", "error": "PixelLab 返回了不匹配的任务。"}
    result = data.get("last_response")
    usage = safe_usage(result.get("usage")) if isinstance(result, dict) else {}
    if not has_charge(usage):
        usage = safe_usage(data.get("usage")) or usage
    receipt = {"usage": usage} if usage else {}
    if state == "failed":
        return {**receipt, "status": "failed", "error": "PixelLab 原图生成失败，已保留上游请求。"}
    if state == "processing":
        return {**receipt, "status": "running"}
    if state != "completed":
        return {**receipt, "status": "attention_required", "error": "PixelLab 返回了未知任务状态。"}
    encoded = result.get("image", {}).get("base64") if isinstance(result, dict) and isinstance(result.get("image"), dict) else None
    if not isinstance(encoded, str):
        return {**receipt, "status": "failed", "error": "PixelLab 已结束任务，但没有返回原图。"}
    try:
        image = validate_reference_image(encoded, size)
    except ValidationHarnessError as exc:
        return {**receipt, "status": "failed", "error": str(exc)}
    return {**receipt, "status": "completed", "image": base64.b64encode(image).decode("ascii")}


def create_reference_router(service: SpritePipelineService, queue: ReferenceQueue) -> APIRouter:
    router = APIRouter(prefix="/v1/reference-art")
    import_lock = threading.Lock()

    @router.get("/settings")
    def settings():
        return {"configured": bool(service.settings.pixellab_api_key), "model": "pixflux", "size": 128}

    @router.post("/settings")
    def save_settings(body: KeyRequest):
        service.configure_pixellab_api_key(body.apiKey)
        return settings()

    @router.post("/jobs", status_code=202)
    def generate(body: GenerateRequest):
        if not body.prompt.strip():
            raise ValidationHarnessError("请输入角色描述。")
        payload = {"description": body.prompt.strip(), "image_size": {"width": body.size, "height": body.size},
                   "no_background": True, "view": "side", "direction": "east" if body.facing == "right" else "west"}
        if body.seed is not None:
            payload["seed"] = body.seed
        if body.requestId is not None:
            return queue.enqueue(body.requestId, payload)
        try:
            receipt = queue.submit_immediate(uuid4().hex, payload)
        except AccountSlotBusy as exc:
            raise ProviderPermanentError("PixelLab 当前任务过多，请稍后再试。", details={"notSubmitted": True}) from exc
        if receipt["status"] in {"not_submitted", "attention_required"}:
            raise ProviderPermanentError(receipt["error"], details={key: value for key, value in receipt.items() if key != "error"})
        return receipt

    @router.get("/requests/{request_id}")
    def request_status(request_id: str):
        if not _JOB_ID.fullmatch(request_id):
            raise ValidationHarnessError("无效的请求 ID。")
        return queue.status(request_id)

    @router.get("/jobs/{job_id}")
    def status(job_id: str):
        if not _JOB_ID.fullmatch(job_id):
            raise ValidationHarnessError("无效的任务 ID。")
        return _poll_reference(service.settings, job_id)

    @router.post("/transfer-prop")
    def transfer_prop(body: PropTransferRequest):
        identity = prop_reference.transfer(service, body.sourceTaskId, body.identityDescription.strip(),
                                           body.confirmation.model_dump() if body.confirmation else None)
        return {"objectId": identity, "objectType": "interactable"}

    @router.post("/orientation")
    def orientation(body: OrientationRequest):
        return check_orientation(service, body.taskId, validate_reference_image(body.image), body.facing)

    def convert_prop(body: PropConvertRequest):
        result, provenance = conversion(service, body.model_dump(exclude_none=True))
        return {'image': base64.b64encode(result.png).decode('ascii'),
                'compare': base64.b64encode(result.compare).decode('ascii'),
                'report': result.report, 'provenance': provenance}

    router.add_api_route('/convert-prop', convert_prop, methods=['POST'])
    router.add_api_route('/convert-prop/preview', convert_prop, methods=['POST'])

    @router.post("/import")
    def import_reference(body: ImportRequest):
        image = validate_reference_image(body.image, body.size)
        with import_lock, service.store.global_lock("reference-preset-" + body.characterId), tempfile.TemporaryDirectory(prefix="reference-import-") as directory:
            identity = body.prompt
            if body.reuseIdentity and service.presets.character_exists(body.characterId):
                existing, _ = service.presets.load_character(body.characterId)
                identity = existing.identity_description
            source = Path(directory) / "reference.png"
            source.write_bytes(image)
            preset = service.create_character_preset(
                display_name=body.name, reference_image=source, facing=body.facing,
                identity_description=identity, character_id=body.characterId, reuse_if_identical=True,
            )
        return {"characterId": preset.character_id}

    return router
