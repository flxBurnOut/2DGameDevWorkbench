"""Provider-neutral contracts and safe image handling for sprite generation.

The service layer talks to every generator through the small contract in this
module.  Providers submit one asynchronous job, poll it by provider job ID, and
return decoded PNG frames only after the response has passed structural and
image validation.

No provider secret or image body belongs in a persisted request/response log.
Use :func:`redact_provider_payload` before exposing provider JSON to callers.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import time
import warnings
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, Callable, Mapping, Sequence

from PIL import Image, UnidentifiedImageError

from ..errors import ProviderError


DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
"""Default upper bound for one encoded or decoded provider image."""


class ImagePayloadError(ValueError):
    """Raised when a provider image is malformed, unsafe, or out of bounds."""


@dataclass(frozen=True, slots=True)
class NormalizedPNG:
    """A validated image normalized to deterministic PNG bytes.

    Attributes:
        data: Re-encoded PNG bytes suitable for the processing pipeline.
        width: Pixel width read by Pillow from the decoded image.
        height: Pixel height read by Pillow from the decoded image.
        source_format: Magic-byte and Pillow-verified source format.
        sha256: SHA-256 digest of ``data`` for logging and provenance.
    """

    data: bytes
    width: int
    height: int
    source_format: str
    sha256: str


@dataclass(frozen=True, slots=True)
class ProviderRequest:
    """Provider-neutral request for one animation candidate.

    ``reference_image`` may contain PNG or JPEG bytes.  Concrete providers
    validate and normalize it before submission.  ``frame_count`` follows the
    PixelLab v3 public contract: 4 through 16 frames and an even number.
    ``seed=None`` means that the provider's documented random/default behavior
    should be used rather than inventing a seed in the harness.
    """

    reference_image: bytes
    prompt: str
    frame_count: int
    seed: int | None = None
    transparent_background: bool = True
    last_frame: bytes | None = None
    edit_frames: tuple[bytes, ...] | None = None
    local_submission_id: str | None = None

    def __post_init__(self) -> None:
        """Normalize simple values and reject invalid provider-independent input."""

        if not isinstance(self.reference_image, (bytes, bytearray, memoryview)):
            raise TypeError("reference_image must contain bytes")
        reference = bytes(self.reference_image)
        if not reference:
            raise ValueError("reference_image must not be empty")
        object.__setattr__(self, "reference_image", reference)

        if self.last_frame is not None:
            if not isinstance(self.last_frame, (bytes, bytearray, memoryview)) or not self.last_frame:
                raise ValueError("last_frame must contain nonempty image bytes")
            object.__setattr__(self, "last_frame", bytes(self.last_frame))

        if self.edit_frames is not None:
            if self.last_frame is not None or len(self.edit_frames) != self.frame_count:
                raise ValueError("edit_frames must match frame_count and cannot use last_frame")
            if any(not isinstance(v, (bytes, bytearray, memoryview)) or not v for v in self.edit_frames):
                raise ValueError("edit_frames must contain nonempty image bytes")
            object.__setattr__(self, "edit_frames", tuple(bytes(v) for v in self.edit_frames))

        if not isinstance(self.prompt, str) or not self.prompt.strip():
            raise ValueError("prompt must not be empty")
        object.__setattr__(self, "prompt", self.prompt.strip())

        if not 4 <= self.frame_count <= 16 or self.frame_count % 2:
            raise ValueError("frame_count must be an even integer from 4 through 16")
        if self.seed is not None and self.seed < 0:
            raise ValueError("seed must be non-negative when provided")
        if not isinstance(self.transparent_background, bool):
            raise TypeError("transparent_background must be a boolean")


@dataclass(frozen=True, slots=True)
class Submission:
    """Accepted provider job plus safe records for service persistence.

    ``request_record`` and ``raw_response`` must already be redacted.  They are
    deliberately JSON-compatible and never contain the API key or image bytes.
    Expected frame metadata lets the originating provider enforce the request
    contract when polling in the same process; polling remains possible after a
    restart even when that in-memory metadata is unavailable.
    """

    provider: str
    provider_job_id: str
    status: str
    expected_frame_count: int
    expected_size: tuple[int, int]
    request_record: dict[str, Any] = field(default_factory=dict)
    raw_response: dict[str, Any] = field(default_factory=dict)
    diagnostic_only: bool = False

    @property
    def job_id(self) -> str:
        """Return the provider job ID under a concise compatibility alias."""

        return self.provider_job_id


class PollStatus(str, Enum):
    """Canonical state returned to the service independent of provider wording."""

    pending = "pending"
    completed = "completed"
    failed = "failed"


@dataclass(slots=True)
class PollResult:
    """One provider poll result.

    Completed results contain normalized PNG files in ``images``.  Failed
    results contain a stable structured ``error`` and no images.  The original
    provider status is retained separately because it is useful when diagnosing
    an upstream API change.
    """

    provider: str
    provider_job_id: str
    status: PollStatus
    provider_status: str
    images: list[bytes] = field(default_factory=list)
    raw_response: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, Any] = field(default_factory=dict)
    error: dict[str, Any] | None = None
    diagnostic_only: bool = False

    def __post_init__(self) -> None:
        """Prevent contradictory poll states from escaping a provider."""

        if self.status is PollStatus.completed and not self.images:
            raise ValueError("completed provider results must contain images")
        if self.status is not PollStatus.completed and self.images:
            raise ValueError("pending or failed provider results cannot contain images")
        if self.status is PollStatus.failed and self.error is None:
            raise ValueError("failed provider results must include a structured error")

    @property
    def frames(self) -> list[bytes]:
        """Return ``images`` using the animation-oriented compatibility name."""

        return self.images

    @property
    def done(self) -> bool:
        """Return whether polling has reached a terminal local result."""

        return self.status is not PollStatus.pending

    @property
    def completed(self) -> bool:
        """Return whether validated PNG frames are available."""

        return self.status is PollStatus.completed


class SpriteProvider(ABC):
    """Synchronous provider interface used by the orchestration service.

    ``submit`` performs one logical submission; a provider may retry only an
    explicit rate-limit rejection. Ambiguous transport outcomes are never
    retried. ``poll`` performs one logical status check. ``wait`` uses a bounded
    scheduling deadline; an in-flight poll remains bounded by the concrete
    provider's separate per-request timeout.
    """

    name = "provider"
    diagnostic_only = False

    def __init__(
        self,
        *,
        poll_interval_seconds: float = 5.0,
        max_wait_seconds: float = 300.0,
        sleep_fn: Callable[[float], None] = time.sleep,
        monotonic_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        """Configure the bounded wait helper shared by all providers."""

        if poll_interval_seconds <= 0:
            raise ValueError("poll_interval_seconds must be positive")
        if max_wait_seconds <= 0:
            raise ValueError("max_wait_seconds must be positive")
        self.poll_interval_seconds = float(poll_interval_seconds)
        self.max_wait_seconds = float(max_wait_seconds)
        self._sleep = sleep_fn
        self._monotonic = monotonic_fn

    @abstractmethod
    def submit(self, request: ProviderRequest) -> Submission:
        """Submit one animation job without automatically retrying the POST."""

    @abstractmethod
    def poll(self, provider_job_id: str) -> PollResult:
        """Fetch and normalize one job state by provider job ID."""

    def wait(self, provider_job_id: str) -> PollResult:
        """Poll until completion/failure or return a structured timeout result.

        A timeout does not claim that the remote job itself failed.  The error
        payload marks the condition as retryable and retains the job ID so a
        caller can resume polling later.  One in-flight ``poll`` may finish just
        after the scheduling deadline, but must have its own provider timeout.
        """

        deadline = self._monotonic() + self.max_wait_seconds
        observed_usage: dict[str, Any] = {}
        while True:
            try:
                last_result = self.poll(provider_job_id)
            except ProviderError as exc:
                if observed_usage:
                    exc.details.setdefault("last_poll_usage", observed_usage)
                raise
            if last_result.provider_job_id == provider_job_id:
                usage = last_result.usage or last_result.raw_response.get("usage")
                if isinstance(usage, Mapping) and usage:
                    observed_usage = redact_provider_payload(usage)
            if last_result.done:
                if not last_result.usage and observed_usage and last_result.provider_job_id == provider_job_id:
                    return replace(last_result, usage=observed_usage)
                return last_result
            remaining = deadline - self._monotonic()
            if remaining <= 0:
                return PollResult(
                    provider=self.name,
                    provider_job_id=provider_job_id,
                    status=PollStatus.failed,
                    provider_status=last_result.provider_status,
                    raw_response=last_result.raw_response,
                    usage=observed_usage,
                    error={
                        "code": "provider_wait_timeout",
                        "message": "provider job did not finish before the harness wait deadline",
                        "details": {
                            "max_wait_seconds": self.max_wait_seconds,
                            "retryable": True,
                            "remote_job_may_still_be_running": True,
                        },
                    },
                    diagnostic_only=self.diagnostic_only,
                )
            self._sleep(min(self.poll_interval_seconds, remaining))


def decode_base64_image(
    value: str | Mapping[str, Any],
    *,
    max_decoded_bytes: int = DEFAULT_MAX_IMAGE_BYTES,
) -> tuple[bytes, str | None]:
    """Decode raw base64 or a ``data:*;base64,`` URI safely.

    PixelLab's OpenAPI examples use data URIs while its official Python SDK
    emits raw base64.  This decoder intentionally supports both forms.  It
    rejects non-base64 data URIs, malformed alphabet/padding, and payloads over
    ``max_decoded_bytes`` before Pillow sees the bytes.

    Returns:
        A ``(decoded_bytes, declared_format)`` tuple.  The declared format is a
        hint only; :func:`normalize_image_bytes` verifies actual magic bytes.
    """

    declared_format: str | None = None
    encoded: Any = value
    if isinstance(value, Mapping):
        encoded = value.get("base64")
        format_value = value.get("format")
        if isinstance(format_value, str) and format_value.strip():
            declared_format = format_value.strip().lower()

    if not isinstance(encoded, str) or not encoded.strip():
        raise ImagePayloadError("provider image must contain a non-empty base64 string")

    encoded = encoded.strip()
    if encoded[:5].lower() == "data:":
        header, separator, body = encoded.partition(",")
        if not separator or ";base64" not in header.lower():
            raise ImagePayloadError("provider image data URI is not base64 encoded")
        mime = header[5:].split(";", 1)[0].strip().lower()
        if mime == "image/png":
            declared_format = declared_format or "png"
        elif mime in {"image/jpeg", "image/jpg"}:
            declared_format = declared_format or "jpeg"
        encoded = body

    compact = "".join(encoded.split())
    if len(compact) > ((max_decoded_bytes + 2) // 3) * 4 + 4:
        raise ImagePayloadError("provider image exceeds the encoded size limit")
    try:
        decoded = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImagePayloadError("provider image contains invalid base64") from exc
    if not decoded:
        raise ImagePayloadError("provider image decoded to an empty payload")
    if len(decoded) > max_decoded_bytes:
        raise ImagePayloadError("provider image exceeds the decoded size limit")
    return decoded, declared_format


def normalize_image_bytes(
    data: bytes,
    *,
    max_bytes: int = DEFAULT_MAX_IMAGE_BYTES,
    max_width: int | None = 256,
    max_height: int | None = 256,
    max_pixels: int | None = 256 * 256,
) -> NormalizedPNG:
    """Verify a PNG/JPEG with magic bytes and Pillow, then re-encode as PNG.

    The function performs a strict magic-byte check before Pillow parsing,
    verifies that Pillow agrees with the detected format, bounds dimensions and
    pixel count before decoding the raster, and reopens after ``verify()``.
    Palette and grayscale images with transparency are converted to RGBA;
    opaque images are converted to RGB.  No resizing or resampling occurs.
    """

    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise ImagePayloadError("image payload must contain bytes")
    raw = bytes(data)
    if not raw or len(raw) > max_bytes:
        raise ImagePayloadError("image payload is empty or exceeds the byte limit")

    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        source_format = "png"
        pillow_formats = {"PNG"}
    elif raw.startswith(b"\xff\xd8\xff"):
        source_format = "jpeg"
        pillow_formats = {"JPEG", "JPG"}
    else:
        raise ImagePayloadError("image payload is neither PNG nor JPEG by magic bytes")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as probe:
                width, height = probe.size
                pillow_format = (probe.format or "").upper()
                if pillow_format not in pillow_formats:
                    raise ImagePayloadError("image magic bytes and Pillow format disagree")
                if width <= 0 or height <= 0:
                    raise ImagePayloadError("image dimensions must be positive")
                if max_width is not None and width > max_width:
                    raise ImagePayloadError(f"image width {width} exceeds limit {max_width}")
                if max_height is not None and height > max_height:
                    raise ImagePayloadError(f"image height {height} exceeds limit {max_height}")
                if max_pixels is not None and width * height > max_pixels:
                    raise ImagePayloadError("image pixel count exceeds the configured limit")
                probe.verify()

            with Image.open(io.BytesIO(raw)) as opened:
                opened.load()
                has_alpha = opened.mode in {"RGBA", "LA"} or "transparency" in opened.info
                normalized = opened.convert("RGBA" if has_alpha else "RGB")
                output = io.BytesIO()
                normalized.save(output, format="PNG", optimize=False, compress_level=9)
    except ImagePayloadError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ImagePayloadError("image dimensions trigger Pillow's decompression guard") from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise ImagePayloadError("Pillow could not verify or decode the image") from exc

    png = output.getvalue()
    return NormalizedPNG(
        data=png,
        width=width,
        height=height,
        source_format=source_format,
        sha256=hashlib.sha256(png).hexdigest(),
    )


def normalize_base64_image(
    value: str | Mapping[str, Any],
    *,
    max_bytes: int = DEFAULT_MAX_IMAGE_BYTES,
    max_width: int | None = 256,
    max_height: int | None = 256,
    max_pixels: int | None = 256 * 256,
) -> NormalizedPNG:
    """Decode either supported base64 representation and return verified PNG."""

    decoded, _declared_format = decode_base64_image(value, max_decoded_bytes=max_bytes)
    return normalize_image_bytes(
        decoded,
        max_bytes=max_bytes,
        max_width=max_width,
        max_height=max_height,
        max_pixels=max_pixels,
    )


_SECRET_KEYS = {
    "authorization",
    "api_key",
    "apikey",
    "access_token",
    "token",
    "secret",
    "password",
}
_IMAGE_BODY_KEYS = {
    "base64",
    "image_base64",
    "first_frame_base64",
    "last_frame_base64",
    "ttf_base64",
    "image",
    "images",
    "frame",
    "frames",
    "output",
    "outputs",
}


def redact_provider_payload(
    value: Any,
    *,
    max_depth: int = 12,
    max_collection_items: int = 256,
    max_string_length: int = 4096,
) -> Any:
    """Return a JSON-compatible provider payload with secrets and blobs removed.

    Image/base64 fields are replaced with stable length and SHA-256 metadata so
    logs remain useful without duplicating large assets.  Secret-looking fields
    are removed entirely.  Collection and string bounds prevent a malicious or
    unexpectedly large provider response from bloating the job record.
    """

    def visit(item: Any, key: str | None, depth: int) -> Any:
        normalized_key = (key or "").lower().replace("-", "_")
        if normalized_key in _SECRET_KEYS or any(
            marker in normalized_key for marker in ("authorization", "api_key", "secret")
        ):
            return "[REDACTED]"

        if isinstance(item, (bytes, bytearray, memoryview)):
            binary = bytes(item)
            return {
                "redacted_binary": True,
                "byte_length": len(binary),
                "sha256": hashlib.sha256(binary).hexdigest(),
            }

        if normalized_key in _IMAGE_BODY_KEYS and isinstance(item, str):
            encoded = item.encode("utf-8", errors="replace")
            return {
                "redacted_base64": True,
                "encoded_length": len(item),
                "sha256": hashlib.sha256(encoded).hexdigest(),
            }

        if depth >= max_depth:
            return {"truncated": True, "reason": "maximum redaction depth reached"}

        if isinstance(item, Mapping):
            result: dict[str, Any] = {}
            entries = list(item.items())
            for child_key, child in entries[:max_collection_items]:
                string_key = str(child_key)
                result[string_key] = visit(child, string_key, depth + 1)
            if len(entries) > max_collection_items:
                result["_truncated_items"] = len(entries) - max_collection_items
            return result

        if isinstance(item, Sequence) and not isinstance(item, (str, bytes, bytearray)):
            sequence = list(item)
            result = [visit(child, key, depth + 1) for child in sequence[:max_collection_items]]
            if len(sequence) > max_collection_items:
                result.append({"truncated_items": len(sequence) - max_collection_items})
            return result

        if isinstance(item, str):
            if len(item) <= max_string_length:
                return item
            return {
                "truncated_string": item[:max_string_length],
                "original_length": len(item),
                "sha256": hashlib.sha256(item.encode("utf-8", errors="replace")).hexdigest(),
            }

        if item is None or isinstance(item, (bool, int, float)):
            return item
        return str(item)[:max_string_length]

    return visit(value, None, 0)


def structured_error(code: str, message: str, **details: Any) -> dict[str, Any]:
    """Build the stable error shape used inside :class:`PollResult`."""

    return {
        "code": code,
        "message": message,
        "details": redact_provider_payload(details),
    }
