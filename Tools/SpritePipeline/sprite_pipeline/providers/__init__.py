"""Public provider API and settings-driven provider construction."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sprite_pipeline.errors import ProviderConfigurationError

from .base import (
    ImagePayloadError,
    NormalizedPNG,
    PollResult,
    PollStatus,
    ProviderRequest,
    SpriteProvider,
    Submission,
    decode_base64_image,
    normalize_base64_image,
    normalize_image_bytes,
    redact_provider_payload,
)
from .fixture import FixtureProvider
from .pixellab import PixelLabProvider

if TYPE_CHECKING:
    from sprite_pipeline.settings import HarnessSettings


# A concise alias is convenient in service annotations while SpriteProvider
# remains the descriptive public class name.
Provider = SpriteProvider


def get_provider(name: str, settings: "HarnessSettings") -> SpriteProvider:
    """Construct a configured provider by stable harness name.

    Args:
        name: ``"pixellab"`` for the live API or ``"fixture"`` for the
            deterministic, diagnostic-only offline provider.
        settings: Loaded :class:`~sprite_pipeline.settings.HarnessSettings`.

    Returns:
        A provider exposing ``submit(request)``, ``poll(provider_job_id)``, and
        bounded ``wait(provider_job_id)`` methods.

    Raises:
        ProviderConfigurationError: If the name is unknown or PixelLab lacks an
            API key.  The fixture provider never requires a credential.
    """

    normalized_name = name.strip().lower() if isinstance(name, str) else ""
    if normalized_name == "pixellab":
        from ..store import JobStore
        from .account import PixelLabSlot

        return PixelLabProvider(
            api_key=settings.pixellab_api_key,
            base_url=settings.pixellab_base_url,
            request_timeout_seconds=settings.http_timeout_seconds,
            poll_interval_seconds=settings.poll_interval_seconds,
            max_wait_seconds=settings.max_wait_seconds,
            max_response_bytes=settings.max_download_bytes,
            account_slot=PixelLabSlot(settings, JobStore(settings)),
        )
    if normalized_name == "fixture":
        return FixtureProvider(
            poll_interval_seconds=settings.poll_interval_seconds,
            max_wait_seconds=settings.max_wait_seconds,
            max_image_bytes=settings.max_download_bytes,
        )
    raise ProviderConfigurationError(
        "unknown sprite generation provider",
        details={"provider": name, "supported": ["pixellab", "fixture"]},
    )


__all__ = [
    "FixtureProvider",
    "ImagePayloadError",
    "NormalizedPNG",
    "PixelLabProvider",
    "PollResult",
    "PollStatus",
    "Provider",
    "ProviderRequest",
    "SpriteProvider",
    "Submission",
    "decode_base64_image",
    "get_provider",
    "normalize_base64_image",
    "normalize_image_bytes",
    "redact_provider_payload",
]
