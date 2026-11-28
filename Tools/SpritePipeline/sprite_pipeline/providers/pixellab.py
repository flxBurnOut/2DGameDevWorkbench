"""PixelLab Animate with Text v3 provider.

This module implements only PixelLab's documented public REST contract:

* ``POST /v2/animate-with-text-v3`` submits exactly one animation job.
* ``GET /v2/background-jobs/{job_id}`` polls the asynchronous result.

The POST is never retried after an ambiguous transport outcome because the
caller cannot know whether a credit-bearing job was accepted. Explicit HTTP
429/529 rejections and polling GETs may back off at 5/10/20 seconds, at most
three times. ``httpx`` is imported only when the provider first needs a client, so
offline fixture workflows do not require importing the networking stack.
"""

from __future__ import annotations

import base64
import hashlib
import importlib
from contextlib import suppress
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import quote, urlparse
from uuid import uuid4

from sprite_pipeline.errors import (
    ProviderConfigurationError,
    ProviderPermanentError,
    ProviderTemporaryError,
)

from .base import (
    DEFAULT_MAX_IMAGE_BYTES,
    ImagePayloadError,
    PollResult,
    PollStatus,
    ProviderRequest,
    SpriteProvider,
    Submission,
    normalize_base64_image,
    normalize_image_bytes,
    redact_provider_payload,
    structured_error,
)
from .account import AccountSlotBusy, safe_usage


PIXELLAB_ACTION_MAX_CHARACTERS = 1000
PIXELLAB_TOTAL_PIXEL_BUDGET = 524_288
"""Documented ``width * height * frame_count`` limit for animation v3."""


@dataclass(frozen=True, slots=True)
class _JobContext:
    """In-memory validation context retained after a successful submission."""

    expected_frame_count: int
    expected_width: int
    expected_height: int


class _ResponseShapeError(ValueError):
    """Internal signal for a response that cannot satisfy the public contract."""


def _load_httpx() -> Any:
    """Import and return ``httpx`` only when a live HTTP request is needed."""

    try:
        return importlib.import_module("httpx")
    except ImportError as exc:  # pragma: no cover - exercised only in minimal installs
        raise ProviderConfigurationError(
            "PixelLab provider requires the optional httpx dependency",
            details={"dependency": "httpx"},
        ) from exc


def poll_identity_mismatch(response, job_id):
    """Return bounded diagnostic IDs without retaining the unbound response."""
    if isinstance(response, Mapping):
        for key in ("id", "background_job_id", "job_id"):
            if key in response and response[key] != job_id:
                return {"requested_job_id": job_id, "response_id_field": key,
                        "response_job_id": redact_provider_payload(response[key])}
    return None


class PixelLabProvider(SpriteProvider):
    """Synchronous adapter for PixelLab's asynchronous animation v3 API.

    Args:
        api_key: PixelLab account token.  It is used only in the Bearer header
            and is never placed in persisted request or response records.
        base_url: PixelLab origin or an API root ending in ``/v2``.  The default
            public origin resolves to ``https://api.pixellab.ai/v2``.
        request_timeout_seconds: Per-HTTP-request timeout enforced by httpx.
        poll_interval_seconds: Delay used by :meth:`wait` between pending polls.
        max_wait_seconds: Total wall-clock budget used by :meth:`wait`.
        max_response_bytes: Maximum response body/image size accepted in memory.
        max_get_retries: Number of retries after a GET receives HTTP 429/529.
            The default three means at most four GET attempts in one ``poll``.
        retry_backoff_seconds: Initial exponential backoff delay.
        max_retry_delay_seconds: Upper bound for one GET retry delay.
        http_client: Optional injected httpx-compatible client for tests.  When
            omitted, a client is constructed lazily and owned by this provider.
    """

    name = "pixellab"
    diagnostic_only = False

    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str = "https://api.pixellab.ai",
        request_timeout_seconds: float = 60.0,
        poll_interval_seconds: float = 5.0,
        max_wait_seconds: float = 300.0,
        max_response_bytes: int = DEFAULT_MAX_IMAGE_BYTES,
        max_get_retries: int = 3,
        retry_backoff_seconds: float = 5.0,
        max_retry_delay_seconds: float = 20.0,
        http_client: Any | None = None,
        sleep_fn: Callable[[float], None] | None = None,
        monotonic_fn: Callable[[], float] | None = None,
        account_slot: Any | None = None,
    ) -> None:
        """Validate configuration without importing httpx or opening a socket."""

        super_kwargs: dict[str, Any] = {
            "poll_interval_seconds": poll_interval_seconds,
            "max_wait_seconds": max_wait_seconds,
        }
        if sleep_fn is not None:
            super_kwargs["sleep_fn"] = sleep_fn
        if monotonic_fn is not None:
            super_kwargs["monotonic_fn"] = monotonic_fn
        super().__init__(**super_kwargs)

        token = (api_key or "").strip()
        if not token:
            raise ProviderConfigurationError(
                "PIXELLAB_API_KEY is required for the PixelLab provider"
            )
        if request_timeout_seconds <= 0:
            raise ValueError("request_timeout_seconds must be positive")
        if max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be positive")
        if not 0 <= max_get_retries <= 3:
            raise ValueError("max_get_retries must be between zero and three")
        if retry_backoff_seconds <= 0 or max_retry_delay_seconds <= 0:
            raise ValueError("retry backoff values must be positive")

        normalized_base = base_url.strip().rstrip("/")
        if not normalized_base.startswith(("https://", "http://")):
            raise ProviderConfigurationError(
                "PixelLab base URL must use http or https",
                details={"base_url": normalized_base},
            )
        parsed_base = urlparse(normalized_base)
        if (
            parsed_base.scheme != "https"
            and parsed_base.hostname not in {"127.0.0.1", "localhost", "::1"}
            and http_client is None
        ):
            raise ProviderConfigurationError(
                "PixelLab base URL must use HTTPS outside loopback",
                details={"base_url": normalized_base},
            )
        self.api_root = normalized_base if normalized_base.endswith("/v2") else f"{normalized_base}/v2"
        self.request_timeout_seconds = float(request_timeout_seconds)
        self.max_response_bytes = int(max_response_bytes)
        self.max_get_retries = int(max_get_retries)
        self.retry_backoff_seconds = float(retry_backoff_seconds)
        self.max_retry_delay_seconds = float(max_retry_delay_seconds)
        self._api_key = token
        self._client = http_client
        self._owns_client = False
        self._jobs: dict[str, _JobContext] = {}
        self._account_slot = account_slot

    def __enter__(self) -> "PixelLabProvider":
        """Return this provider for use as a context manager."""

        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _traceback: Any) -> None:
        """Close a lazily created client when leaving a context manager."""

        self.close()

    def __del__(self) -> None:
        """Best-effort cleanup when a short-lived service provider is released."""

        try:
            self.close()
        except Exception:
            # Destructors must never mask interpreter shutdown or user errors.
            pass

    def close(self) -> None:
        """Close the owned httpx client; injected clients remain caller-owned."""

        if self._owns_client and self._client is not None:
            self._client.close()
            self._client = None
            self._owns_client = False

    def _get_client(self) -> Any:
        """Return the injected client or lazily construct an authenticated one."""

        if self._client is None:
            httpx = _load_httpx()
            self._client = httpx.Client(
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                timeout=httpx.Timeout(self.request_timeout_seconds),
                follow_redirects=False,
            )
            self._owns_client = True
        return self._client

    def check_account_slot(self) -> None:
        if self._account_slot is not None:
            with self._account_slot.lock():
                self._account_slot.require_available(self._active_job_status)

    @property
    def account_fingerprint(self) -> str | None:
        return self._account_slot.key if self._account_slot is not None else None

    def _active_job_status(self, job_id: str) -> str | None:
        try:
            result = self.poll(job_id)
        except ProviderPermanentError as exc:
            if exc.details.get("http_status") == 404:
                return "expired"
            raise
        return result.provider_status if result.raw_response.get("id", job_id) == job_id else None

    def submit(self, request: ProviderRequest) -> Submission:
        if self._account_slot is None:
            return self._submit(request)
        with self._account_slot.lock():
            self._account_slot.require_available(self._active_job_status)
            intent_id = request.local_submission_id or uuid4().hex
            self._account_slot.reserve(intent_id)
            try:
                receipt = self._submit(request)
            except (ProviderPermanentError, ProviderTemporaryError, AccountSlotBusy) as exc:
                if exc.details.get("provider_job_id"):
                    self._account_slot.accept(exc.details["provider_job_id"], intent_id,
                                              usage=safe_usage((exc.details.get("response") or {}).get("usage")))
                elif not exc.details.get("submission_unknown"):
                    self._account_slot.reject()
                raise
            self._account_slot.accept(receipt.provider_job_id, intent_id,
                                      usage=safe_usage(receipt.raw_response.get("usage")), status=receipt.status)
            return receipt

    def _submit(self, request: ProviderRequest) -> Submission:
        """Submit one PixelLab v3 job with only conclusive 429/529 retries.

        Transport failures, timeouts, and malformed 200 responses are reported
        with ``submission_unknown=True`` and ``safe_to_retry=False`` because the
        remote service may already have accepted and charged for the job.
        """

        if len(request.prompt) > PIXELLAB_ACTION_MAX_CHARACTERS:
            raise ProviderPermanentError(
                "PixelLab animation action exceeds 1000 characters",
                details={"action_length": len(request.prompt)},
            )
        try:
            reference = normalize_image_bytes(
                request.reference_image,
                max_bytes=self.max_response_bytes,
                max_width=256,
                max_height=256,
                max_pixels=256 * 256,
            )
        except ImagePayloadError as exc:
            raise ProviderPermanentError(
                "reference image is not a valid PixelLab PNG/JPEG input",
                details={"reason": str(exc)},
            ) from exc

        pixel_budget = reference.width * reference.height * request.frame_count
        if pixel_budget > PIXELLAB_TOTAL_PIXEL_BUDGET:
            raise ProviderPermanentError(
                "PixelLab v3 total pixel budget would be exceeded",
                details={
                    "width": reference.width,
                    "height": reference.height,
                    "frame_count": request.frame_count,
                    "pixel_budget": pixel_budget,
                    "maximum": PIXELLAB_TOTAL_PIXEL_BUDGET,
                },
            )

        payload: dict[str, Any] = {
            "first_frame": {
                "type": "base64",
                "base64": base64.b64encode(reference.data).decode("ascii"),
                "format": "png",
            },
            "action": request.prompt,
            "frame_count": request.frame_count,
            "no_background": request.transparent_background,
        }
        if request.seed is not None:
            payload["seed"] = request.seed

        request_record: dict[str, Any] = {
            "provider": self.name,
            "method": "POST",
            "path": "/v2/animate-with-text-v3",
            "first_frame": {
                "type": "base64",
                "format": "png",
                "width": reference.width,
                "height": reference.height,
                "byte_length": len(reference.data),
                "sha256": reference.sha256,
            },
            "action": request.prompt,
            "frame_count": request.frame_count,
            "no_background": request.transparent_background,
        }
        if request.seed is not None:
            request_record["seed"] = request.seed

        if request.last_frame is not None:
            try:
                last = normalize_image_bytes(
                    request.last_frame, max_bytes=self.max_response_bytes,
                    max_width=256, max_height=256, max_pixels=256 * 256,
                )
            except ImagePayloadError as exc:
                raise ProviderPermanentError("last frame is not a valid image") from exc
            if (last.width, last.height) != (reference.width, reference.height):
                raise ProviderPermanentError("first and last frames must have the same dimensions")
            payload["last_frame"] = {
                "type": "base64", "base64": base64.b64encode(last.data).decode("ascii"), "format": "png",
            }
            request_record["last_frame"] = {
                "type": "base64", "format": "png", "width": last.width,
                "height": last.height, "byte_length": len(last.data), "sha256": last.sha256,
            }

        endpoint = "animate-with-text-v3"
        if request.edit_frames is not None:
            side=max(reference.width,reference.height)
            edit_limit=16 if side<=64 else 9 if side<=80 else 4
            if len(request.edit_frames)>edit_limit:
                raise ProviderPermanentError('PixelLab animation edit frame limit exceeded for this image size',details={'maximum':edit_limit,'frame_count':len(request.edit_frames),'width':reference.width,'height':reference.height})
            normalized = []
            try:
                for content in request.edit_frames:
                    frame = normalize_image_bytes(content, max_bytes=self.max_response_bytes,
                        max_width=256, max_height=256, max_pixels=256*256)
                    if (frame.width, frame.height) != (reference.width, reference.height):
                        raise ProviderPermanentError("animation edit frames must have matching dimensions")
                    normalized.append(frame)
            except ImagePayloadError as exc:
                raise ProviderPermanentError("animation edit frame is invalid") from exc
            endpoint = "edit-animation-v2"
            payload = {"description": request.prompt,
                "frames": [{"image": {"base64": base64.b64encode(frame.data).decode("ascii")},
                    "size": {"width": frame.width, "height": frame.height}} for frame in normalized],
                "image_size": {"width": reference.width, "height": reference.height},
                "no_background": request.transparent_background}
            if request.seed is not None:
                payload["seed"] = request.seed
            request_record = {"provider": self.name, "method": "POST", "path": "/v2/"+endpoint,
                "description": request.prompt, "frame_count": len(normalized), "seed": request.seed,
                "image_size": payload["image_size"], "no_background": request.transparent_background,
                "frames": [{"sha256": frame.sha256, "width": frame.width, "height": frame.height,
                    "byte_length": len(frame.data)} for frame in normalized]}

        httpx = self._httpx_for_errors()
        timeout_errors = (httpx.TimeoutException,) if httpx is not None else ()
        request_errors = (httpx.RequestError,) if httpx is not None else ()
        response: Any | None = None
        for retry_index in range(self.max_get_retries + 1):
            try:
                response = self._get_client().post(
                    f"{self.api_root}/{endpoint}",
                    json=payload,
                )
            except timeout_errors as exc:
                raise ProviderTemporaryError(
                    "PixelLab submission timed out and its remote result is unknown",
                    details={
                        "submission_unknown": True,
                        "safe_to_retry": False,
                        "error_type": type(exc).__name__,
                        "request": request_record,
                    },
                ) from exc
            except request_errors as exc:
                raise ProviderTemporaryError(
                    "PixelLab submission connection failed and its remote result is unknown",
                    details={
                        "submission_unknown": True,
                        "safe_to_retry": False,
                        "error_type": type(exc).__name__,
                        "request": request_record,
                    },
                ) from exc
            if self._account_slot is not None or response.status_code not in {429, 529} or retry_index >= self.max_get_retries:
                break
            self._sleep(self._retry_delay(response, retry_index))

        assert response is not None

        if response.status_code not in ({200, 202} if request.edit_frames is not None else {200}):
            self._raise_submission_status(response, request_record)

        try:
            response_json = self._json_object(response)
        except _ResponseShapeError as exc:
            raise ProviderTemporaryError(
                "PixelLab accepted the HTTP request but returned an unusable submission response",
                details={
                    "submission_unknown": True,
                    "safe_to_retry": False,
                    "reason": str(exc),
                    "request": request_record,
                    "response": self._non_json_response_record(response),
                },
            ) from exc

        job_id = response_json.get("background_job_id")
        status = response_json.get("status", "processing")
        if not isinstance(job_id, str) or not job_id.strip():
            raise ProviderTemporaryError(
                "PixelLab submission response did not contain a background_job_id",
                details={
                    "submission_unknown": True,
                    "safe_to_retry": False,
                    "response": self._response_record(response_json, response.status_code),
                },
            )
        if not isinstance(status, str) or not status:
            status = "processing"

        job_id = job_id.strip()
        self._jobs[job_id] = _JobContext(
            expected_frame_count=request.frame_count,
            expected_width=reference.width,
            expected_height=reference.height,
        )
        return Submission(
            provider=self.name,
            provider_job_id=job_id,
            status=status,
            expected_frame_count=request.frame_count,
            expected_size=(reference.width, reference.height),
            request_record=request_record,
            raw_response=self._response_record(response_json, response.status_code),
            diagnostic_only=False,
        )

    def poll(self, provider_job_id: str) -> PollResult:
        """Poll one PixelLab background job and normalize completed images.

        HTTP 429 and 529 responses are conclusive GET failures and are retried
        with bounded exponential backoff up to ``max_get_retries`` times.  A
        transport exception is surfaced immediately as a temporary provider
        error rather than silently extending the operation.
        """

        job_id = self._validate_job_id(provider_job_id)
        response = self._get_with_backoff(job_id)

        try:
            response_json = self._json_object(response)
        except _ResponseShapeError as exc:
            if response.status_code != 200:
                self._raise_poll_status(response, job_id)
            return PollResult(
                provider=self.name,
                provider_job_id=job_id,
                status=PollStatus.failed,
                provider_status="invalid_response",
                raw_response=self._non_json_response_record(response),
                error=structured_error(
                    "provider_contract_error",
                    "PixelLab poll response was not a bounded JSON object",
                    reason=str(exc),
                ),
            )

        mismatch = poll_identity_mismatch(response_json, job_id)
        if mismatch:
            return PollResult(
                provider=self.name, provider_job_id=job_id, status=PollStatus.failed,
                provider_status="identity_mismatch",
                raw_response={"_http_status": int(response.status_code), **mismatch},
                error=structured_error("provider_job_mismatch", "PixelLab poll returned another job", **mismatch),
            )
        if response.status_code != 200:
            self._raise_poll_status(response, job_id)
        raw_response = self._response_record(response_json, response.status_code)
        provider_status = response_json.get("status")
        usage = self._usage_record(response_json.get("usage"))
        if (self._account_slot is not None
                and isinstance(provider_status, str) and provider_status in {"completed", "failed"}):
            with suppress(AccountSlotBusy), self._account_slot.lock():
                self._account_slot.release(job_id)
        if not isinstance(provider_status, str) or not provider_status:
            return self._contract_failure(
                job_id,
                "invalid_response",
                raw_response,
                usage,
                "PixelLab poll response did not contain a string status",
            )

        if provider_status == "processing":
            return PollResult(
                provider=self.name,
                provider_job_id=job_id,
                status=PollStatus.pending,
                provider_status=provider_status,
                raw_response=raw_response,
                usage=usage,
            )
        if provider_status == "failed":
            return PollResult(
                provider=self.name,
                provider_job_id=job_id,
                status=PollStatus.failed,
                provider_status=provider_status,
                raw_response=raw_response,
                usage=usage,
                error=structured_error(
                    "provider_job_failed",
                    "PixelLab reported that the background job failed",
                    provider_error=response_json.get("last_response"),
                ),
            )
        if provider_status != "completed":
            return self._contract_failure(
                job_id,
                provider_status,
                raw_response,
                usage,
                "PixelLab returned an undocumented background job status",
                unknown_status=provider_status,
            )

        return self._completed_result(job_id, response_json, raw_response, usage)

    def get_balance(self) -> dict[str, Any]:
        """Return a bounded, redacted account balance without exposing the key."""

        httpx = self._httpx_for_errors()
        timeout_errors = (httpx.TimeoutException,) if httpx is not None else ()
        request_errors = (httpx.RequestError,) if httpx is not None else ()
        url = f"{self.api_root}/balance"
        response: Any | None = None
        for retry_index in range(self.max_get_retries + 1):
            try:
                response = self._get_client().get(url)
            except timeout_errors as exc:
                raise ProviderTemporaryError(
                    "PixelLab balance request timed out",
                    details={"safe_to_retry": True, "error_type": type(exc).__name__},
                ) from exc
            except request_errors as exc:
                raise ProviderTemporaryError(
                    "PixelLab balance request connection failed",
                    details={"safe_to_retry": True, "error_type": type(exc).__name__},
                ) from exc
            if response.status_code not in {429, 529} or retry_index >= self.max_get_retries:
                break
            self._sleep(self._retry_delay(response, retry_index))

        assert response is not None
        if response.status_code != 200:
            status_code = int(response.status_code)
            details = {
                "http_status": status_code,
                "safe_to_retry": status_code in {429, 529} or status_code >= 500,
                "response": self._best_effort_response_record(response),
            }
            if details["safe_to_retry"]:
                raise ProviderTemporaryError("PixelLab balance request failed temporarily", details=details)
            raise ProviderPermanentError("PixelLab balance request was rejected", details=details)
        try:
            payload = self._json_object(response)
        except _ResponseShapeError as exc:
            raise ProviderTemporaryError(
                "PixelLab balance response was invalid",
                details={"safe_to_retry": True, "reason": str(exc)},
            ) from exc
        return self._response_record(payload, response.status_code)

    def _completed_result(
        self,
        job_id: str,
        response_json: Mapping[str, Any],
        raw_response: dict[str, Any],
        usage: dict[str, Any],
    ) -> PollResult:
        """Validate ``last_response.images`` and create a completed result."""

        last_response = response_json.get("last_response")
        if not isinstance(last_response, Mapping):
            return self._contract_failure(
                job_id,
                "completed",
                raw_response,
                usage,
                "completed PixelLab job did not contain a last_response object",
            )
        image_values = last_response.get("images")
        if not isinstance(image_values, list) or not image_values:
            return self._contract_failure(
                job_id,
                "completed",
                raw_response,
                usage,
                "completed PixelLab job did not contain last_response.images",
            )

        context = self._jobs.get(job_id)
        declared_count = last_response.get("frame_count")
        returned_count = len(image_values)
        requested_count = context.expected_frame_count if context is not None else None
        if (
            (isinstance(declared_count, int) and declared_count != returned_count)
            or (requested_count is not None and requested_count != returned_count)
        ):
            # The image list is the usable result. Some successful PixelLab
            # responses include an additional frame (commonly the submitted
            # first frame) or omit/contradict frame_count. Preserve every
            # validated image and leave the service layer to surface the count
            # difference as a review warning instead of discarding paid work.
            raw_response = dict(raw_response)
            raw_response["harness_frame_count"] = {
                "requested": requested_count,
                "declared": declared_count if isinstance(declared_count, int) else None,
                "returned": returned_count,
                "policy": "preserve_all_returned_images",
            }

        decoded: list[bytes | None] = []
        errors = []
        expected_size = (context.expected_width, context.expected_height) if context else None
        for index, value in enumerate(image_values):
            try:
                if isinstance(value, Mapping) and value.get("type", "base64") != "base64":
                    raise ImagePayloadError("unsupported image object type")
                image = normalize_base64_image(
                    value, max_bytes=self.max_response_bytes, max_width=256,
                    max_height=256, max_pixels=256 * 256,
                )
            except (ImagePayloadError, TypeError) as exc:
                errors.append({"frame_index": index, "reason": str(exc)})
                decoded.append(None)
                continue
            size = (image.width, image.height)
            if expected_size is None:
                expected_size = size
            elif size != expected_size:
                errors.append({"frame_index": index, "reason": "inconsistent dimensions",
                               "expected_size": expected_size, "actual_size": size})
            # After a restart the adapter may lack the original request size.
            # The stage archives each decoded image against its frozen canvas.
            decoded.append(image.data)

        if errors:
            return PollResult(
                provider=self.name, provider_job_id=job_id, status=PollStatus.failed,
                provider_status="completed", partial_images=decoded, raw_response=raw_response, usage=usage,
                error=structured_error("provider_contract_error", "PixelLab returned invalid animation frames",
                                       reason="invalid_drawing_frame", raw_count=len(decoded), frames=errors),
            )

        return PollResult(
            provider=self.name,
            provider_job_id=job_id,
            status=PollStatus.completed,
            provider_status="completed",
            images=[image for image in decoded if image is not None],
            raw_response=raw_response,
            usage=usage,
        )

    def _get_with_backoff(self, job_id: str) -> Any:
        """GET one job, retrying only HTTP 429/529 with bounded backoff."""

        httpx = self._httpx_for_errors()
        timeout_errors = (httpx.TimeoutException,) if httpx is not None else ()
        request_errors = (httpx.RequestError,) if httpx is not None else ()
        url = f"{self.api_root}/background-jobs/{quote(job_id, safe='')}"
        for retry_index in range(self.max_get_retries + 1):
            try:
                response = self._get_client().get(url)
            except timeout_errors as exc:
                raise ProviderTemporaryError(
                    "PixelLab job poll timed out",
                    details={
                        "provider_job_id": job_id,
                        "safe_to_retry": True,
                        "error_type": type(exc).__name__,
                    },
                ) from exc
            except request_errors as exc:
                raise ProviderTemporaryError(
                    "PixelLab job poll connection failed",
                    details={
                        "provider_job_id": job_id,
                        "safe_to_retry": True,
                        "error_type": type(exc).__name__,
                    },
                ) from exc

            if response.status_code not in {429, 529} or retry_index >= self.max_get_retries:
                return response
            if poll_identity_mismatch(self._best_effort_response_record(response), job_id):
                return response
            self._sleep(self._retry_delay(response, retry_index))
        raise AssertionError("unreachable GET retry state")

    def _retry_delay(self, response: Any, retry_index: int) -> float:
        """Return a bounded delay, honoring numeric Retry-After when available."""

        exponential = self.retry_backoff_seconds * (2**retry_index)
        retry_after: float | None = None
        headers = getattr(response, "headers", {})
        if isinstance(headers, Mapping):
            raw_retry_after = headers.get("Retry-After") or headers.get("retry-after")
            try:
                retry_after = float(raw_retry_after) if raw_retry_after is not None else None
            except (TypeError, ValueError):
                retry_after = None
        delay = retry_after if retry_after is not None and retry_after >= 0 else exponential
        return min(delay, self.max_retry_delay_seconds)

    def _httpx_for_errors(self) -> Any | None:
        """Load httpx exception types, allowing dependency-free injected fakes.

        A caller-supplied client is primarily a test seam.  If httpx is absent,
        such a client can still exercise pure contract logic; unexpected fake
        exceptions propagate normally instead of being misclassified as network
        failures.  A live provider without an injected client still requires
        httpx through :meth:`_get_client`.
        """

        try:
            return _load_httpx()
        except ProviderConfigurationError:
            if self._client is not None and not self._owns_client:
                return None
            raise

    def _raise_submission_status(self, response: Any, request_record: dict[str, Any]) -> None:
        """Classify a non-200 POST response without retrying it."""

        status_code = int(response.status_code)
        record = self._best_effort_response_record(response)
        job_id = record.get("background_job_id")
        usage = record.get("usage")
        charged = isinstance(usage, dict) and any(isinstance(usage.get(key), (int, float)) and usage[key] > 0 for key in ("usd", "generations"))
        known_rejection = status_code in {401, 402, 403, 422, 429, 529} and not job_id and not charged
        details = {
            "http_status": status_code,
            "submission_unknown": not known_rejection,
            "submission_rejected": known_rejection,
            "safe_to_retry": known_rejection and status_code in {429, 529},
            "request": request_record,
            "response": record,
        }
        if isinstance(job_id, str) and job_id.strip():
            details["provider_job_id"] = job_id.strip()
        if self._account_slot is not None and details["safe_to_retry"]:
            raise AccountSlotBusy("PixelLab 账户当前任务过多，等待空位", details=details)
        if status_code in {429, 529} or status_code >= 500:
            raise ProviderTemporaryError("PixelLab rejected or could not process the submission", details=details)
        raise ProviderPermanentError("PixelLab rejected the animation submission", details=details)

    def _raise_poll_status(self, response: Any, job_id: str) -> None:
        """Classify a non-200 poll response after rate-limit retries are exhausted."""

        status_code = int(response.status_code)
        details = {
            "provider_job_id": job_id,
            "http_status": status_code,
            "safe_to_retry": status_code >= 500,
            "response": self._best_effort_response_record(response),
        }
        if status_code in {429, 529}:
            details.update(get_retries=self.max_get_retries, safe_to_retry=True)
            raise ProviderTemporaryError("PixelLab job poll remained rate-limited after bounded retries", details=details)
        if status_code >= 500:
            raise ProviderTemporaryError("PixelLab job poll failed temporarily", details=details)
        raise ProviderPermanentError("PixelLab job poll was rejected", details=details)

    def _json_object(self, response: Any) -> dict[str, Any]:
        """Decode a bounded JSON object from an httpx-compatible response."""

        content = bytes(getattr(response, "content", b""))
        if len(content) > self.max_response_bytes:
            raise _ResponseShapeError("response body exceeds the configured byte limit")
        try:
            value = response.json()
        except (ValueError, TypeError) as exc:
            raise _ResponseShapeError("response body is not valid JSON") from exc
        if not isinstance(value, Mapping):
            raise _ResponseShapeError("response JSON root is not an object")
        return dict(value)

    def _response_record(self, value: Mapping[str, Any], status_code: int) -> dict[str, Any]:
        """Redact provider JSON and attach the HTTP status for persistence."""

        redacted = redact_provider_payload(value)
        record = dict(redacted) if isinstance(redacted, Mapping) else {"payload": redacted}
        record["_http_status"] = int(status_code)
        return record

    def _non_json_response_record(self, response: Any) -> dict[str, Any]:
        """Record only metadata and a digest for a non-JSON or oversized body."""

        content = bytes(getattr(response, "content", b""))
        headers = getattr(response, "headers", {})
        content_type = headers.get("content-type") if isinstance(headers, Mapping) else None
        return {
            "_http_status": int(getattr(response, "status_code", 0)),
            "content_type": content_type,
            "byte_length": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "body_redacted": True,
        }

    def _best_effort_response_record(self, response: Any) -> dict[str, Any]:
        """Return redacted JSON when possible, otherwise safe body metadata."""

        try:
            value = self._json_object(response)
        except _ResponseShapeError:
            return self._non_json_response_record(response)
        return self._response_record(value, int(response.status_code))

    @staticmethod
    def _usage_record(value: Any) -> dict[str, Any]:
        """Keep a redacted JSON-compatible usage mapping or return an empty one."""

        if not isinstance(value, Mapping):
            return {}
        redacted = redact_provider_payload(value)
        return dict(redacted) if isinstance(redacted, Mapping) else {}

    def _contract_failure(
        self,
        job_id: str,
        provider_status: str,
        raw_response: dict[str, Any],
        usage: dict[str, Any],
        message: str,
        **details: Any,
    ) -> PollResult:
        """Return a terminal safe failure for an undocumented response shape."""

        return PollResult(
            provider=self.name,
            provider_job_id=job_id,
            status=PollStatus.failed,
            provider_status=provider_status,
            raw_response=raw_response,
            usage=usage,
            error=structured_error("provider_contract_error", message, **details),
        )

    @staticmethod
    def _validate_job_id(provider_job_id: str) -> str:
        """Validate and normalize a provider job ID before placing it in a URL."""

        if not isinstance(provider_job_id, str) or not provider_job_id.strip():
            raise ProviderPermanentError("provider_job_id must be a non-empty string")
        job_id = provider_job_id.strip()
        if len(job_id) > 256:
            raise ProviderPermanentError("provider_job_id exceeds 256 characters")
        return job_id
