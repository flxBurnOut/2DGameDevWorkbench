from __future__ import annotations

import os
import secrets
import shutil
import tempfile
import base64
import binascii
import hashlib
import io
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from .errors import (
    ConflictError,
    ExportBlockedError,
    HarnessError,
    NotFoundError,
    ProviderError,
    ProviderTemporaryError,
    ValidationHarnessError,
)
from .jsonio import atomic_write_json, read_json, relative_posix, sha256_file
from .credential_store import CredentialStore
from .migration import LegacyLayoutMigrator
from .user_library_import import import_user_library
from .models import (
    ActionPreset,
    Anchor,
    CandidateRecord,
    CandidateStatus,
    CharacterPreset,
    ExportOptions,
    ExportRecord,
    FrameRecord,
    FrameReviewRequest,
    GenerationRequest,
    IssueSeverity,
    JobRecord,
    JobStatus,
    QAChangeSummary,
    QAIssue,
    QAIssueBaseline,
    ReviewStatus,
    utc_now,
)
from .presets import PresetRepository
from .prompts import compose_generation_prompt
from .providers.account import AccountSlotBusy, PixelLabSlot, animation_intent_id
from .settings import HarnessSettings
from .store import JobStore


QA_ALGORITHM_VERSION = "sprite-pipeline-qa-v3"
PIXELLAB_GENERATION_UNIT_PIXELS = 64 * 64 * 16


class SpritePipelineService:
    """The only application layer used by CLI, REST API, and Gradio."""

    def __init__(self, root: str | Path | None = None) -> None:
        self._root_argument = root
        self.settings = HarnessSettings.load(root)
        self.settings.ensure_directories()
        migration_store = JobStore(self.settings)
        with migration_store.global_lock(
            "legacy_migration",
            timeout_seconds=300.0,
        ):
            self.migration_report = LegacyLayoutMigrator(self.settings).run()
            self.user_library_import_report = import_user_library(self.settings)
        # Migration may have moved a legacy plaintext key into protected
        # storage, so resolve settings once more before creating providers.
        self.settings = HarnessSettings.load(root)
        self.settings.ensure_directories()
        self.presets = PresetRepository(self.settings)
        self.store = JobStore(self.settings)

    def list_presets(self) -> dict[str, Any]:
        return {
            "characters": self.presets.list_characters(),
            "objects": self.presets.list_objects(),
            "actions": self.presets.list_actions(),
        }

    def list_jobs(self, *, include_archived: bool = False) -> list[dict[str, Any]]:
        # Archiving hides execution history, never the durable artwork inventory.
        if include_archived:
            return self.store.list_jobs()
        path = self.settings.config_dir / "archived_jobs.json"
        archived = set(read_json(path)) if path.exists() else set()
        return [job for job in self.store.list_jobs() if job["job_id"] not in archived]

    def archive_history(self, *, check_only=False):
        # Never discard provider IDs, submission allowances or recovery evidence.
        with self.store.creation_lock(), self.store.submission_lock():
            jobs = self.store.list_jobs()
            busy = {"submitting", "submission_unknown", "provider_pending", "saving"}
            # The production catalog hides offline examples. Their interrupted
            # local saves are not live provider jobs and must not block clearing.
            blocked = [job["job_id"] for job in jobs
                       if job.get("provider") != "fixture" and job.get("character_id") != "diagnostic_dummy"
                       and (job.get("needs_recovery") or busy.intersection(job.get("candidate_status_counts", {})))]
            if blocked:
                raise ConflictError("序列帧仍在生成或需要恢复，请处理完成后再清空：" + "、".join(blocked),
                                    details={"job_ids": blocked})
            archive_path = self.settings.config_dir / "archived_jobs.json"
            archived = set(read_json(archive_path)) if archive_path.exists() else set()
            count = sum(job["job_id"] not in archived for job in jobs)
            if not check_only:
                atomic_write_json(self.settings.config_dir / "archived_jobs.json", [job["job_id"] for job in jobs])
            return {"count": count}

    def create_character_preset(
        self,
        *,
        display_name: str,
        reference_image: str | Path,
        facing: str = "right",
        identity_description: str = "",
        character_id: str | None = None,
        sheet_columns: int = 4,
        anchor_x: int | None = None,
        anchor_ground_y: int | None = None,
        reuse_if_identical: bool = False,
    ) -> CharacterPreset:
        """Create a minimal reusable character package from one approved idle PNG."""

        name = display_name.strip()
        if not name:
            raise ValidationHarnessError("character display name is required")
        source = Path(reference_image).resolve()
        if not source.is_file():
            raise NotFoundError("character reference image not found", details={"path": str(source)})
        try:
            with Image.open(source) as image:
                image.load()
                if image.format != "PNG":
                    raise ValidationHarnessError("character reference must be a PNG")
                if image.size not in ((64, 64), (128, 128)):
                    raise ValidationHarnessError(
                        "character reference must be exactly 64x64 or 128x128",
                        details={"actual": list(image.size)},
                    )
                if "A" not in image.getbands() and "transparency" not in image.info:
                    raise ValidationHarnessError("character reference must contain an alpha channel")
                alpha_box = image.convert("RGBA").getchannel("A").getbbox()
                if alpha_box is None:
                    raise ValidationHarnessError("character reference cannot be completely transparent")
                width, height = image.size
        except ValidationHarnessError:
            raise
        except Exception as exc:
            raise ValidationHarnessError(
                "character reference cannot be decoded",
                details={"path": str(source), "error": str(exc)},
            ) from exc

        if character_id:
            base_id = character_id.strip().lower()
        else:
            base_id = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "character"
        if not base_id or not all(ch.islower() or ch.isdigit() or ch == "_" for ch in base_id):
            raise ValidationHarnessError(
                "character ID may contain only lowercase letters, digits, and underscores",
                details={"character_id": base_id},
            )
        if base_id == "diagnostic_dummy":
            raise ConflictError("the diagnostic character ID is reserved")

        characters_dir = self.settings.user_characters_dir
        characters_dir.mkdir(parents=True, exist_ok=True)
        selected_id = base_id
        if reuse_if_identical and self.presets.object_path(base_id).is_file():
            raise ConflictError(
                "idempotent character ID is reserved by an object preset",
                details={"character_id": base_id},
            )
        if reuse_if_identical and self.presets.character_exists(base_id):
            existing, existing_path = self.presets.load_character(base_id)
            existing_reference = existing_path.parent / existing.reference_frame
            same_contract = (
                existing.display_name == name
                and existing.facing == facing
                and existing.identity_description
                == (
                    identity_description.strip()
                    or "Preserve the exact identity, outfit, proportions, equipment, silhouette, and colors from the approved reference image."
                )
                and existing.sheet_columns == sheet_columns
                and (anchor_x is None or existing.anchor.x == anchor_x)
                and (anchor_ground_y is None or existing.anchor.ground_y == anchor_ground_y)
                and sha256_file(existing_reference) == sha256_file(source)
            )
            if same_contract:
                return existing
            raise ConflictError(
                "idempotent character ID already contains different source data",
                details={"character_id": base_id},
            )
        for suffix in range(1, 1000):
            candidate_id = base_id if suffix == 1 else f"{base_id}_{suffix:03d}"
            if not self.presets.object_exists(candidate_id):
                selected_id = candidate_id
                break
        else:
            raise ConflictError("character ID space is exhausted", details={"base_id": base_id})

        if (anchor_x is None) != (anchor_ground_y is None):
            raise ValidationHarnessError("anchor_x and anchor_ground_y must be provided together")
        left, _top, right, bottom = alpha_box
        resolved_anchor_x = (
            max(0, min(width - 1, (left + right - 1) // 2))
            if anchor_x is None
            else anchor_x
        )
        resolved_ground_y = (
            max(0, min(height - 1, bottom - 1))
            if anchor_ground_y is None
            else anchor_ground_y
        )
        if not 0 <= resolved_anchor_x < width or not 0 <= resolved_ground_y < height:
            raise ValidationHarnessError(
                "character anchor must be inside the reference frame",
                details={
                    "anchor": [resolved_anchor_x, resolved_ground_y],
                    "frame_size": [width, height],
                },
            )
        description = identity_description.strip() or (
            "Preserve the exact identity, outfit, proportions, equipment, silhouette, and colors from the approved reference image."
        )
        preset = CharacterPreset(
            character_id=selected_id,
            display_name=name,
            cell_width=width,
            cell_height=height,
            facing=facing,
            reference_frame="idle_reference.png",
            identity_description=description,
            anchor=Anchor(x=resolved_anchor_x, ground_y=resolved_ground_y),
            safe_margin=4,
            sheet_columns=sheet_columns,
            transparent_background=True,
        )

        staging_dir = Path(tempfile.mkdtemp(prefix=f".{selected_id}.", dir=characters_dir))
        destination = characters_dir / selected_id
        try:
            shutil.copy2(source, staging_dir / "idle_reference.png")
            atomic_write_json(staging_dir / "character.json", preset.model_dump(mode="json"))
            os.replace(staging_dir, destination)
        except Exception:
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise
        return preset

    def create_character_preset_from_sheet(
        self,
        *,
        display_name: str,
        sprite_sheet: str | Path,
        cell_size: int = 128,
        reference_frame_index: int = 0,
        facing: str = "right",
        identity_description: str = "",
        character_id: str | None = None,
        sheet_columns: int = 4,
        anchor_x: int | None = None,
        anchor_ground_y: int | None = None,
        reuse_if_identical: bool = False,
    ) -> CharacterPreset:
        """Create a reusable character package from one cell of a regular PNG sheet."""

        if cell_size not in (64, 128):
            raise ValidationHarnessError("sheet cell size must be 64 or 128")
        if reference_frame_index < 0:
            raise ValidationHarnessError("reference frame index cannot be negative")
        source = Path(sprite_sheet).resolve()
        if not source.is_file():
            raise NotFoundError("character sprite sheet not found", details={"path": str(source)})
        try:
            with Image.open(source) as image:
                image.load()
                if image.format != "PNG":
                    raise ValidationHarnessError("character sprite sheet must be a PNG")
                if "A" not in image.getbands() and "transparency" not in image.info:
                    raise ValidationHarnessError("character sprite sheet must contain an alpha channel")
                if image.width % cell_size or image.height % cell_size:
                    raise ValidationHarnessError(
                        "sprite sheet dimensions must be exact multiples of the cell size",
                        details={"actual": [image.width, image.height], "cell_size": cell_size},
                    )
                columns = image.width // cell_size
                rows = image.height // cell_size
                if columns != sheet_columns:
                    raise ValidationHarnessError(
                        "sprite sheet column count differs from the requested project grid",
                        details={"actual": columns, "expected": sheet_columns},
                    )
                if reference_frame_index >= columns * rows:
                    raise ValidationHarnessError(
                        "reference frame index is outside the sprite sheet",
                        details={"frame_index": reference_frame_index, "frame_count": columns * rows},
                    )
                left = (reference_frame_index % columns) * cell_size
                top = (reference_frame_index // columns) * cell_size
                reference = image.convert("RGBA").crop((left, top, left + cell_size, top + cell_size))
                if reference.getchannel("A").getbbox() is None:
                    raise ValidationHarnessError("selected reference frame is completely transparent")
        except ValidationHarnessError:
            raise
        except Exception as exc:
            raise ValidationHarnessError(
                "character sprite sheet cannot be decoded",
                details={"path": str(source), "error": str(exc)},
            ) from exc

        with tempfile.TemporaryDirectory(prefix="sprite_reference_") as temp_name:
            reference_path = Path(temp_name) / "reference.png"
            reference.save(reference_path, format="PNG", optimize=False)
            return self.create_character_preset(
                display_name=display_name,
                reference_image=reference_path,
                facing=facing,
                identity_description=identity_description,
                character_id=character_id,
                sheet_columns=sheet_columns,
                anchor_x=anchor_x,
                anchor_ground_y=anchor_ground_y,
                reuse_if_identical=reuse_if_identical,
            )

    def configure_pixellab_api_key(self, api_key: str | None) -> bool:
        """Persist the PixelLab key in the OS-bound credential store."""

        key = (api_key or "").strip()
        if key and (len(key) < 8 or any(char.isspace() for char in key)):
            raise ValidationHarnessError("PixelLab API key format is invalid")
        if os.environ.get("PIXELLAB_API_KEY", "").strip():
            raise ConflictError(
                "PIXELLAB_API_KEY is controlled by the process environment and cannot be changed in the UI"
            )
        CredentialStore(self.settings.config_dir).set("pixellab_api_key", key or None)
        loaded = HarnessSettings.load(self._root_argument)
        self.settings = loaded
        self.presets.settings = loaded
        self.store.settings = loaded
        return bool(key)

    def storage_status(self) -> dict[str, Any]:
        credential_status = CredentialStore(self.settings.config_dir).public_status()
        credential_status["active_source"] = (
            "environment"
            if os.environ.get("PIXELLAB_API_KEY", "").strip()
            else "protected_store"
            if self.settings.pixellab_api_key
            else "none"
        )
        return {
            "paths": self.settings.public_paths(),
            "credentials": credential_status,
            "migration": self.migration_report,
        }

    def get_cached_balance(self) -> dict[str, Any] | None:
        path = self.settings.config_dir / "pixellab_balance.json"
        if not path.is_file():
            return None
        try:
            from .jsonio import read_json

            payload = read_json(path)
            return payload if isinstance(payload, dict) else None
        except Exception:
            return None

    def refresh_pixellab_balance(self) -> dict[str, Any]:
        from .providers import get_provider

        provider = get_provider("pixellab", self.settings)
        return self._refresh_balance_with_provider(provider)

    def _refresh_balance_with_provider(self, provider: Any) -> dict[str, Any]:
        get_balance = getattr(provider, "get_balance", None)
        if get_balance is None:
            raise ValidationHarnessError("configured provider does not expose account balance")
        balance = get_balance()
        snapshot = {
            "schema_version": 1,
            "provider": "pixellab",
            "checked_at": utc_now().isoformat(),
            "balance": balance,
        }
        atomic_write_json(self.settings.config_dir / "pixellab_balance.json", snapshot)
        return snapshot

    @staticmethod
    def _remaining_generations(snapshot: dict[str, Any]) -> float | None:
        balance = snapshot.get("balance")
        subscription = balance.get("subscription") if isinstance(balance, dict) else None
        if not isinstance(subscription, dict):
            return None
        for name in ("generations", "remaining", "remaining_generations", "generations_remaining"):
            value = subscription.get(name)
            if (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
            ):
                return max(0.0, float(value))
        return None

    @staticmethod
    def _available_credit(snapshot: dict[str, Any]) -> float:
        balance = snapshot.get('balance')
        credits = balance.get('credits') if isinstance(balance, dict) else None
        usd = credits.get('usd') if isinstance(credits, dict) else None
        if isinstance(usd, (int, float)) and not isinstance(usd, bool) and 0 < usd <= 2**53 and math.isfinite(usd):
            return float(usd)
        return 0.0

    @staticmethod
    def _pixellab_generation_units(
        width: int,
        height: int,
        frame_count: int,
    ) -> int:
        """Estimate documented v3 subscription units from total pixel budget."""

        if width <= 0 or height <= 0 or frame_count <= 0:
            raise ValidationHarnessError("generation dimensions and frame count must be positive")
        return max(
            1,
            math.ceil(
                width
                * height
                * frame_count
                / PIXELLAB_GENERATION_UNIT_PIXELS
            ),
        )

    def estimate_pixellab_generation_units(
        self,
        character_id: str,
        action_id: str,
        *,
        candidate_count: int = 1,
    ) -> dict[str, Any]:
        if candidate_count < 1 or candidate_count > 8:
            raise ValidationHarnessError("candidate_count must be between 1 and 8")
        character, _character_path = self.presets.load_character(character_id)
        action, _action_path = self.presets.load_action(action_id)
        per_candidate = self._pixellab_generation_units(
            character.cell_width,
            character.cell_height,
            action.generation_frame_count,
        )
        controlled = action.action_id in {"attack", "attack_in_air"} and not action.loop
        from .attack_sequence import segment_counts
        counts=segment_counts(action)
        if counts:
            per_candidate=sum(self._pixellab_generation_units(character.cell_width,character.cell_height,n) for n in counts)
        return {
            "planned_generation_submissions_per_candidate":len(counts) or 1,
            "planned_generation_submissions":(len(counts) or 1)*candidate_count,
            "segment_frame_counts":counts,
            "provider": "pixellab",
            "maximum_extra_generations": 0,
            "maximum_visual_reviews": 2*candidate_count if controlled else 0,
            "visual_review_billed_separately": controlled,
            "cell_width": character.cell_width,
            "cell_height": character.cell_height,
            "provider_frame_count": action.generation_frame_count,
            "candidate_count": candidate_count,
            "generation_units_per_candidate": per_candidate,
            "maximum_generation_units": per_candidate * candidate_count,
            "formula": "sum(ceil(width * height * segment_frame_count / 65536))" if counts else "ceil(width * height * frame_count / 65536)",
        }

    def get_job(self, job_id: str) -> JobRecord:
        return self.store.load(job_id)

    def create_job(self, request: GenerationRequest | dict[str, Any]) -> JobRecord:
        if not isinstance(request, GenerationRequest):
            request = GenerationRequest.model_validate(request)
        fingerprint_payload = request.model_dump(mode="json", exclude={"request_key"})
        if request.attack_segment is None:
            fingerprint_payload.pop("attack_segment", None)  # Preserve pre-existing idempotency keys.
        if request.motion_repair is None:
            fingerprint_payload.pop("motion_repair", None)
        fingerprint = hashlib.sha256(
            json.dumps(fingerprint_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        if request.request_key:
            with self.store.creation_lock():
                existing = self.store.find_by_request_key(request.request_key)
                if existing is not None:
                    if existing.request_fingerprint != fingerprint:
                        raise ConflictError(
                            "request key was already used for different generation settings",
                            details={"request_key": request.request_key, "job_id": existing.job_id},
                        )
                    return existing
                return self._create_job_unlocked(request, fingerprint)
        return self._create_job_unlocked(request, fingerprint)

    def _create_job_unlocked(self, request: GenerationRequest, fingerprint: str) -> JobRecord:
        character, character_path = self.presets.load_object(request.object_id, object_type=request.object_type)
        if character.object_type == "interactable" and request.open_plan is None:
            raise ValidationHarnessError("interactable jobs require the open-motion workflow")
        if request.open_plan:
            from .collaboration.workspace import OpenMotionWorkspace
            binding = request.open_plan
            work = OpenMotionWorkspace(self).load(binding.work_id)
            if (work.revision != binding.revision or work.plan_sha256 != binding.plan_sha256
                    or work.spec != binding.spec or work.plan != binding.plan
                    or work.generation_policy_version != binding.generation_policy_version
                    or work.visibility_review_version != binding.visibility_review_version
                    or (binding.plan.quality is not None and work.planning_config != binding.model_snapshot)
                    or work.character != (self.presets.object_snapshot(character) if 'provenance' in work.character else character.model_dump(mode="json"))):
                raise ConflictError("任务、角色或方案已改变，请查看最新版本")
            if binding.compiled_prompts:
                from .collaboration.quality import compiled_prompt
                if binding.compiled_prompts != [compiled_prompt(binding.plan,character,i,policy_version=binding.generation_policy_version) for i in range(len(binding.plan.stages))]:
                    raise ConflictError('实际生成提示词与方案合同不一致')
            from .collaboration.contracts import prop_contract
            prop = prop_contract(binding.plan)
            playback_count = sum(stage.frame_count for stage in binding.plan.stages) + (prop.hold_frames if prop else 0)
            base_action = ActionPreset(action_id=request.action_id, display_name=binding.plan.title,
                frame_count=playback_count,
                fps=binding.plan.quality.playback_fps if binding.plan.quality else binding.spec.fps,
                loop=binding.spec.loop, grounded=binding.plan.grounded, manifest_action_name=binding.plan.animation_name,
                action_description=binding.spec.description[:1000].ljust(8),
                loop_constraint="The final motion must connect to the first frame." if binding.spec.loop else None)
            action_path = None
        else:
            base_action, action_path = self.presets.load_action(request.action_id)
        updates: dict[str, Any] = {}
        if request.frame_count is not None:
            updates["frame_count"] = request.frame_count
            if request.frame_count != base_action.frame_count:
                # A caller override describes a custom regular sequence. Do not
                # silently reuse a project-specific provider reduction or sparse
                # sheet layout that was authored for a different frame count.
                updates.update(
                    {
                        "provider_frame_count": None,
                        "provider_frame_selection": [],
                        "sheet_columns": None,
                        "sheet_rows": None,
                        "sheet_frame_cells": [],
                        "critical_frame_indices": [],
                    }
                )
        if request.action_description is not None:
            updates["action_description"] = request.action_description
        if request.loop is not None:
            updates["loop"] = request.loop
            if request.loop and not base_action.loop_constraint:
                updates["loop_constraint"] = "The last frame must transition smoothly back to the unchanged first frame."
            if not request.loop:
                updates["loop_constraint"] = None
        action = ActionPreset.model_validate({**base_action.model_dump(), **updates})
        if request.provider != "import" and request.open_plan is None:
            provider_count = action.generation_frame_count
            if provider_count < 4 or provider_count > 16 or provider_count % 2:
                raise ValidationHarnessError(
                    "model generation requires an even source frame count between 4 and 16",
                    details={
                        "project_frame_count": action.frame_count,
                        "provider_frame_count": provider_count,
                        "action_id": action.action_id,
                    },
                )
        segment_inputs = None
        if request.attack_segment is not None:
            from .attack_plans import AttackPlans
            segment_inputs = AttackPlans(self).generation_inputs(request)
        motion_inputs = None
        if request.motion_repair is not None:
            from .motion_correction import MotionCorrection
            motion_inputs = MotionCorrection(self).generation_inputs(request)
        full_prompt = ("\n\n".join(stage.prompt for stage in request.open_plan.plan.stages) if request.open_plan else
                       motion_inputs[1] if motion_inputs else segment_inputs[2] if segment_inputs else compose_generation_prompt(character, action))
        if request.open_plan and request.open_plan.plan.quality:
            from .collaboration.quality import compiled_prompt
            full_prompt = '\n\n'.join(request.open_plan.compiled_prompts or [compiled_prompt(request.open_plan.plan,character,i,
                policy_version=request.open_plan.generation_policy_version) for i in range(len(request.open_plan.plan.stages))])
        if request.provider == "pixellab" and request.open_plan is None and len(full_prompt) > 1000:
            raise ValidationHarnessError(
                "composed PixelLab action prompt exceeds the 1000 character API limit",
                details={"length": len(full_prompt), "limit": 1000},
            )

        reference_source = (character_path.parent / character.reference_frame).resolve()
        self._validate_reference_image(reference_source, character.cell_width, character.cell_height)
        if request.open_plan and sha256_file(reference_source) != request.open_plan.reference_sha256:
            raise ConflictError("角色原图已改变，请重新制定方案")
        job_id, job_dir = self.store.create_layout(character.character_id, action.action_id)
        try:
            reference_dest = job_dir / "input" / "reference.png"
            if motion_inputs:
                self._atomic_write_bytes(reference_dest, motion_inputs[0][0])
            elif segment_inputs:
                self._atomic_write_bytes(reference_dest, segment_inputs[0])
                self._atomic_write_bytes(job_dir / "input" / "last_frame.png", segment_inputs[1])
            else:
                shutil.copy2(reference_source, reference_dest)
            if request.open_plan and sha256_file(reference_dest) != request.open_plan.reference_sha256:
                raise ConflictError("复制参考图期间原文件发生变化")
            for field, filename in (
                ("master", character.master),
                ("palette", character.palette),
                ("silhouette", character.silhouette),
            ):
                if filename:
                    shutil.copy2(character_path.parent / filename, job_dir / "input" / f"{field}{Path(filename).suffix.lower()}")
            atomic_write_json(job_dir / "input" / "character.json", character.model_dump(mode="json"))
            atomic_write_json(job_dir / "input" / "action.json", action.model_dump(mode="json"))
            input_sha256 = {
                path.name: sha256_file(path)
                for path in sorted((job_dir / "input").iterdir(), key=lambda item: item.name)
                if path.is_file()
            }

            base_seed = request.seed if request.seed is not None else secrets.randbelow(2**31 - request.candidate_count - 1) + 1
            candidates = [
                CandidateRecord(
                    candidate_index=index,
                    candidate_id=f"candidate_{index:02d}",
                    seed=(
                        index - 1
                        if base_seed == 0
                        else ((base_seed - 1 + index - 1) % (2**31 - 1)) + 1
                    ),
                )
                for index in range(1, request.candidate_count + 1)
            ]
            job = JobRecord(
                job_id=job_id,
                request=request,
                request_fingerprint=fingerprint,
                character=character,
                action=action,
                character_preset_path=self.settings.record_path(character_path),
                action_preset_path=self.settings.record_path(action_path or job_dir / "input" / "action.json"),
                reference_sha256=sha256_file(reference_dest),
                input_sha256=input_sha256,
                full_prompt=full_prompt,
                candidates=candidates,
            )
            from .motion_correction import default_policy
            job.motion_control = default_policy(request, action)
            if request.open_plan:
                from .collaboration.contracts import PlanControl, PlanExecution, StageRun
                job.plan_control = PlanControl()
                for candidate in job.candidates:
                    candidate.plan_execution = PlanExecution(stages=[StageRun() for _ in request.open_plan.plan.stages])
                    if request.open_plan.plan.quality:
                        candidate.plan_execution.quality_review = {'state': 'pending', 'requests': []}
            from .attack_sequence import initialize
            initialize(job)
            job.touch("job_created", provider=request.provider, candidate_count=request.candidate_count)
            self.store.save(job)
            return job
        except Exception:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise

    @staticmethod
    def _validate_reference_image(path: Path, width: int, height: int) -> None:
        try:
            with Image.open(path) as image:
                image.load()
                if image.format != "PNG":
                    raise ValidationHarnessError("reference frame must be PNG", details={"path": str(path)})
                if image.size != (width, height):
                    raise ValidationHarnessError(
                        "reference frame size differs from character preset",
                        details={"path": str(path), "actual": list(image.size), "expected": [width, height]},
                    )
                if "A" not in image.getbands() and "transparency" not in image.info:
                    raise ValidationHarnessError("reference frame has no alpha channel", details={"path": str(path)})
                alpha = image.convert("RGBA").getchannel("A")
                if alpha.getbbox() is None:
                    raise ValidationHarnessError("reference frame is completely transparent", details={"path": str(path)})
        except ValidationHarnessError:
            raise
        except Exception as exc:
            raise ValidationHarnessError("reference frame cannot be decoded", details={"path": str(path), "error": str(exc)}) from exc

    def ingest_candidate(
        self,
        job_id: str,
        candidate_index: int,
        source: str | Path,
        *,
        source_kind: str = "auto",
        columns: int | None = None,
        frame_cells: list[tuple[int, int]] | None = None,
    ) -> JobRecord:
        source_path = Path(source).resolve()
        if not source_path.exists():
            raise NotFoundError("candidate source not found", details={"path": str(source_path)})
        normalized_kind = source_kind.strip().casefold()
        sheet_kind = normalized_kind in {"sheet", "spritesheet", "sprite_sheet"} or (
            normalized_kind == "auto"
            and source_path.is_file()
            and source_path.suffix.casefold() != ".gif"
        )
        if frame_cells is not None and not sheet_kind:
            raise ValidationHarnessError("frame_cells can only be used with a sprite sheet")
        try:
            frame_cells_override = (
                [(int(column), int(row)) for column, row in frame_cells]
                if frame_cells is not None
                else None
            )
        except (TypeError, ValueError) as exc:
            raise ValidationHarnessError("frame_cells must contain column/row pairs") from exc
        if frame_cells_override == []:
            raise ValidationHarnessError("frame_cells cannot be empty")
        with self.store.locked_job(job_id) as job:
            candidate = self._candidate(job, candidate_index)
            if job.request.provider != "import":
                raise ConflictError(
                    "manual candidate ingestion is only allowed for import jobs",
                    details={"provider": job.request.provider},
                )
            if candidate.status != CandidateStatus.created:
                raise ConflictError(
                    "candidate is not in the created state",
                    details={"candidate_index": candidate_index, "status": candidate.status.value},
                )
            output_dir = self.store.job_dir(job_id) / "raw" / candidate.candidate_id
            if output_dir.exists() and any(output_dir.iterdir()):
                raise ConflictError(
                    "candidate raw directory already contains immutable files",
                    details={"candidate_index": candidate_index},
                )
            from .processing import ingest_frames

            raw_root = output_dir.parent
            raw_root.mkdir(parents=True, exist_ok=True)
            if output_dir.exists():
                output_dir.rmdir()
            staging_dir = Path(tempfile.mkdtemp(prefix=f".{candidate.candidate_id}.", dir=raw_root))
            try:
                locked_columns = job.action.sheet_columns if sheet_kind else None
                if locked_columns is not None and columns is not None and columns != locked_columns:
                    raise ValidationHarnessError(
                        "sheet columns differ from the selected action contract",
                        details={"actual": columns, "expected": locked_columns},
                    )
                effective_columns = (
                    locked_columns or columns or job.character.sheet_columns
                ) if sheet_kind else columns
                contract_frame_cells = (
                    job.action.frame_cells
                    if sheet_kind and job.action.sheet_columns
                    else []
                )
                selected_frame_cells = (
                    frame_cells_override
                    if frame_cells_override is not None
                    else contract_frame_cells
                )
                if (
                    sheet_kind
                    and frame_cells_override is None
                    and job.action.sheet_rows is not None
                ):
                    expected_size = (
                        job.character.cell_width * int(effective_columns),
                        job.character.cell_height * job.action.sheet_rows,
                    )
                    with Image.open(source_path) as opened:
                        opened.load()
                        if opened.size != expected_size:
                            raise ValidationHarnessError(
                                "sheet dimensions differ from the selected action contract",
                                details={"actual": list(opened.size), "expected": list(expected_size)},
                            )
                staged_paths = ingest_frames(
                    source_path,
                    staging_dir,
                    job.character.cell_width,
                    job.character.cell_height,
                    len(selected_frame_cells) if selected_frame_cells else None,
                    source_kind=source_kind,
                    columns=effective_columns,
                    frame_cells=selected_frame_cells or None,
                    auto_detect_sheet_count=sheet_kind and not selected_frame_cells,
                )
                staged_records = [
                    (index, path.name, sha256_file(path)) for index, path in enumerate(staged_paths)
                ]
                os.replace(staging_dir, output_dir)
            except Exception:
                if staging_dir.exists():
                    shutil.rmtree(staging_dir, ignore_errors=True)
                raise
            candidate.frames = [
                FrameRecord(
                    index=index,
                    raw_path=relative_posix(output_dir / filename, self.store.job_dir(job_id)),
                    active_path=relative_posix(output_dir / filename, self.store.job_dir(job_id)),
                    sha256=digest,
                )
                for index, filename, digest in staged_records
            ]
            candidate.status = CandidateStatus.received
            candidate.qa_completed_at = None
            candidate.qa_input_sha256 = None
            candidate.qa_algorithm_version = None
            candidate.error = None
            job.touch(
                "candidate_ingested",
                candidate_index=candidate_index,
                source_kind=source_kind,
                frame_count=len(candidate.frames),
            )
        return self.check_candidate(job_id, candidate_index)

    def ingest_candidate_base64(
        self,
        job_id: str,
        candidate_index: int,
        frames: list[str],
    ) -> JobRecord:
        """Ingest API-friendly base64 PNG frames through the same immutable path."""

        job = self.store.load(job_id)
        if not frames or len(frames) > 64:
            raise ValidationHarnessError("frames must contain between 1 and 64 images")
        total_encoded = sum(len(value) for value in frames if isinstance(value, str))
        max_encoded = ((self.settings.max_download_bytes + 2) // 3) * 4 + 16
        if total_encoded > max_encoded:
            raise ValidationHarnessError(
                "combined base64 frame payload exceeds configured request limit",
                details={"encoded_length": total_encoded, "maximum": max_encoded},
            )
        incoming_root = self.store.job_dir(job_id) / "input"
        with tempfile.TemporaryDirectory(prefix="api_frames_", dir=incoming_root) as temp_name:
            temp_dir = Path(temp_name)
            for index, value in enumerate(frames):
                if not isinstance(value, str):
                    raise ValidationHarnessError("each API frame must be a base64 string", details={"index": index})
                encoded = value.split(",", 1)[1] if value.startswith("data:") and "," in value else value
                if len(encoded) > max_encoded:
                    raise ValidationHarnessError("base64 frame exceeds configured size limit", details={"index": index})
                try:
                    decoded = base64.b64decode(encoded, validate=True)
                except (binascii.Error, ValueError) as exc:
                    raise ValidationHarnessError("invalid base64 frame", details={"index": index}) from exc
                if not decoded.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise ValidationHarnessError("API frame must decode to PNG", details={"index": index})
                (temp_dir / f"frame_{index:03d}.png").write_bytes(decoded)
            return self.ingest_candidate(job.job_id, candidate_index, temp_dir, source_kind="png_dir")

    def generate_job(
        self,
        job_id: str,
        *,
        wait: bool = True,
        candidate_index: int | None = None,
    ) -> JobRecord:
        """Generate candidates serially, or advance one async unit when ``wait`` is false."""

        from .providers import get_provider

        job = self.store.load(job_id)
        if job.request.provider == "import":
            raise ValidationHarnessError("import jobs accept frames through ingest, not generate")
        if job.motion_control and job.generation_requested_at is None and not any(c.submission_attempts for c in job.candidates):
            from .vision_review import VisionReviewer
            if not VisionReviewer(self.settings).configured:
                raise ValidationHarnessError("请先在设置中保存 视觉检查 API Key；尚未提交生成")
        provider = get_provider(job.request.provider, self.settings)
        self.reconcile_saved_results(job_id)
        job = self.store.load(job_id)
        if not self._same_generation_account(job, provider):
            return job
        if any(c.attack_sequence for c in job.candidates):
            from .attack_sequence import FixedAttackGeneration
            return FixedAttackGeneration(self).advance(job_id,provider,wait=wait,candidate_index=candidate_index)
        if job.request.open_plan:
            from .collaboration.execution import PlanGeneration
            return PlanGeneration(self).advance(job_id, provider, wait=wait, candidate_index=candidate_index)
        if candidate_index is not None:
            targets = [self._candidate(job, candidate_index).candidate_index]
        else:
            targets = [candidate.candidate_index for candidate in job.candidates]

        pending_other = [
            candidate.candidate_index
            for candidate in job.candidates
            if candidate.status
            in (
                CandidateStatus.submitting,
                CandidateStatus.submission_unknown,
                CandidateStatus.provider_pending,
                CandidateStatus.saving,
            )
            and candidate.candidate_index not in targets
        ]
        if pending_other:
            raise ConflictError("another candidate is already pending", details={"candidate_indices": pending_other})

        for index in targets:
            current = self.store.load(job_id)
            candidate = self._candidate(current, index)
            if candidate.status in (
                CandidateStatus.received,
                CandidateStatus.check_failed,
                CandidateStatus.review_ready,
                CandidateStatus.approved,
                CandidateStatus.rejected,
            ):
                continue
            if candidate.status == CandidateStatus.failed:
                continue
            if candidate.status in (CandidateStatus.submitting, CandidateStatus.submission_unknown):
                raise ConflictError(
                    "submission outcome is unknown; automatic resubmission is disabled",
                    details={
                        "candidate_index": index,
                        "provider_job_id": candidate.provider_job_id,
                        "safe_to_retry": False,
                    },
                )
            if candidate.status == CandidateStatus.created:
                # The browser, REST API, and CLI all share this OS-backed lock.
                # A live balance check and the only chargeable POST therefore
                # cannot race one another in separate local processes.
                with self.store.submission_lock(
                    timeout_seconds=max(180.0, self.settings.http_timeout_seconds + 60.0)
                ):
                    locked_snapshot = self.store.load(job_id)
                    if not self._same_generation_account(locked_snapshot, provider):
                        return locked_snapshot
                    locked_candidate = self._candidate(locked_snapshot, index)
                    if locked_candidate.status == CandidateStatus.created:
                        try:
                            self._check_submission_quota(job_id, index, provider)
                            self._submit_candidate(job_id, index, provider)
                        except AccountSlotBusy as exc:
                            self._queue_candidate(job_id, index, exc, provider, selected_index=candidate_index)
                            break
                current = self.store.load(job_id)
                candidate = self._candidate(current, index)
                if current.status == JobStatus.not_submitted:
                    break
            if candidate.status not in (CandidateStatus.provider_pending, CandidateStatus.saving) or not candidate.provider_job_id:
                continue
            if current.generation_requested_at is None:
                with self.store.locked_job(job_id) as requested_job:
                    requested_job.generation_requested_at = utc_now()
                    requested_job.touch("generation_requested")
            should_wait = wait or provider.diagnostic_only
            self._poll_candidate(job_id, index, provider, wait=should_wait)
            advanced = self._candidate(self.store.load(job_id), index)
            if advanced.status == CandidateStatus.provider_pending:
                break
            if not wait:
                break
        from .motion_correction import MotionCorrection
        return MotionCorrection(self).advance(job_id, wait=wait)

    def _check_submission_quota(
        self,
        job_id: str,
        candidate_index: int,
        provider: Any,
        *, phase_frame_count: int | None = None,
    ) -> None:
        """Check and durably record quota immediately before each planned paid POST."""

        if provider.name != "pixellab" or getattr(provider, "get_balance", None) is None:
            return
        check_slot = getattr(provider, "check_account_slot", None)
        if check_slot is not None:
            check_slot()
        try:
            snapshot = self._refresh_balance_with_provider(provider)
        except ProviderError as exc:
            error = ValidationHarnessError('无法读取 PixelLab 余额，未提交动画。', details={'submission_created': False})
            with self.store.locked_job(job_id) as job:
                self._candidate(job, candidate_index).error = error.as_dict()
                self._refresh_job_status(job)
                job.touch('generation_balance_unavailable', candidate_index=candidate_index)
            raise error from exc
        remaining = self._remaining_generations(snapshot)
        job = self.store.load(job_id)
        first_submission = job.generation_requested_at is None or (
            job.status == JobStatus.queued and not job.request.open_plan and not any(c.submitted_at for c in job.candidates)
        )
        created_candidates = sum(
            candidate.status == CandidateStatus.created
            for candidate in job.candidates
        )
        candidates_to_reserve = (
            created_candidates
            if first_submission
            else 1
        )
        units_per_candidate = self._pixellab_generation_units(
            job.character.cell_width,
            job.character.cell_height,
            job.action.generation_frame_count,
        )
        if phase_frame_count is not None:
            units_per_candidate = self._pixellab_generation_units(job.character.cell_width,job.character.cell_height,phase_frame_count)
            if first_submission:
                # Existing jobs retain their reserved stage counts after rhythm defaults change.
                stages=self._candidate(job,candidate_index).attack_sequence['stages']
                units_per_candidate = sum(self._pixellab_generation_units(job.character.cell_width,job.character.cell_height,r['frame_count']) for r in stages)
        required_units = units_per_candidate * candidates_to_reserve
        shortfall = remaining is not None and required_units > remaining and self._available_credit(snapshot) == 0
        with self.store.locked_job(job_id) as quota_job:
            if quota_job.quota_before is None:
                quota_job.quota_before = snapshot
            quota_candidate = self._candidate(quota_job, candidate_index)
            quota_job.touch(
                "generation_quota_checked",
                candidate_index=candidate_index,
                remaining=remaining,
                requested_candidates=candidates_to_reserve,
                generation_units_per_candidate=units_per_candidate,
                requested_generation_units=required_units,
                chargeable_submission_created=False,
            )
            if shortfall:
                quota_candidate.error = {
                    "code": "insufficient_quota",
                    "message": "not enough PixelLab generations remain",
                    "details": {
                        "remaining": remaining,
                        "requested_candidates": candidates_to_reserve,
                        "generation_units_per_candidate": units_per_candidate,
                        "requested_generation_units": required_units,
                        "submission_created": False,
                    },
                }
                self._refresh_job_status(quota_job)
                quota_job.touch(
                    "generation_blocked_by_quota",
                    candidate_index=candidate_index,
                    remaining=remaining,
                    requested_candidates=candidates_to_reserve,
                    generation_units_per_candidate=units_per_candidate,
                    requested_generation_units=required_units,
                    chargeable_submission_created=False,
                )
            elif (quota_candidate.error or {}).get("code") == "insufficient_quota":
                quota_candidate.error = None
                self._refresh_job_status(quota_job)
                quota_job.touch(
                    "generation_quota_available",
                    candidate_index=candidate_index,
                    remaining=remaining,
                    chargeable_submission_created=False,
                )
        if shortfall:
            raise ValidationHarnessError(
                "not enough PixelLab generation units remain for every requested candidate",
                details={
                    "remaining": remaining,
                    "requested_candidates": candidates_to_reserve,
                    "generation_units_per_candidate": units_per_candidate,
                    "requested_generation_units": required_units,
                    "candidate_index": candidate_index,
                    "submission_created": False,
                },
            )

    @staticmethod
    def _same_generation_account(job, provider):
        return not job.generation_account or job.generation_account == getattr(provider, 'account_fingerprint', None)

    def _queue_candidate(self, job_id, index, error, provider, *, stage=None, selected_index=None):
        with self.store.locked_job(job_id) as job:
            candidate = self._candidate(job, index)
            if candidate.status == CandidateStatus.created and (candidate.error or {}).get('code') == error.code:
                return
            if candidate.status == CandidateStatus.submitting:
                candidate.status = CandidateStatus.created
                candidate.submission_started_at = None
                candidate.submission_attempts -= 1
                if stage is not None and candidate.plan_execution:
                    run = candidate.plan_execution.stages[stage]
                    run.state = 'created'; run.submission_attempts = 0
                elif stage is not None and candidate.attack_sequence:
                    candidate.attack_sequence['stages'][stage].update(state='created', submission_attempts=0)
            candidate.error = error.as_dict()
            job.generation_requested_at = job.generation_requested_at or utc_now()
            job.queued_candidate_index = selected_index
            job.generation_account = job.generation_account or getattr(provider, 'account_fingerprint', None)
            if job.plan_control:
                job.plan_control.message = error.message
            self._refresh_job_status(job)
            job.touch('generation_waiting_for_account', candidate_index=index, stage=stage)

    def _recover_submission_receipt(self, job, candidate, *, stage=None):
        if job.request.provider != 'pixellab' or not self.settings.pixellab_api_key:
            return None
        slot = PixelLabSlot(self.settings, self.store)
        if job.generation_account and job.generation_account != slot.key:
            return None
        receipt = slot.accepted_receipt(animation_intent_id(job.job_id, candidate.candidate_index, stage))
        if receipt:
            candidate.status = CandidateStatus.provider_pending
            candidate.provider_job_id = receipt['jobId']
            candidate.provider_status = receipt['status']
            candidate.usage = receipt['usage']
            candidate.submitted_at = candidate.submission_started_at or utc_now()
            candidate.error = None
            job.touch('provider_receipt_recovered', candidate_index=candidate.candidate_index, stage=stage)
        return receipt

    def recover_completed_candidate(
        self,
        job_id: str,
        candidate_index: int,
    ) -> JobRecord:
        """Poll an existing PixelLab job again without submitting a new generation."""

        from .providers import get_provider

        snapshot = self.store.load(job_id)
        if snapshot.request.open_plan:
            from .collaboration.execution import PlanGeneration
            with self.store.locked_job(job_id) as current:
                candidate = self._candidate(current, candidate_index)
                if candidate.frames:
                    return current
                if not any(r.state in {"pending", "complete"} for r in candidate.plan_execution.stages):
                    raise ConflictError("没有可查询的原请求，请先核对远端编号")
                if candidate.status == CandidateStatus.failed and candidate.provider_status == "completed":
                    candidate.status = CandidateStatus.provider_pending
                    candidate.error = None
            return PlanGeneration(self).advance(job_id, get_provider(snapshot.request.provider, self.settings),
                                                candidate_index=candidate_index, allow_submit=False)
        if snapshot.request.provider != "pixellab":
            raise ValidationHarnessError(
                "only PixelLab candidates can be recovered from an existing provider job"
            )
        candidate = self._candidate(snapshot, candidate_index)
        if not candidate.provider_job_id:
            raise ConflictError(
                "candidate has no existing provider job to recover",
                details={"candidate_index": candidate_index},
            )
        if candidate.frames:
            raise ConflictError(
                "candidate already contains usable frames",
                details={"candidate_index": candidate_index},
            )
        recoverable_failure = (
            candidate.status == CandidateStatus.failed
            and candidate.provider_status == "completed"
            and (candidate.error or {}).get("code")
            in {"provider_contract_error", "provider_frame_storage_error", "validation_error"}
        )
        if candidate.status not in (CandidateStatus.provider_pending, CandidateStatus.saving) and not recoverable_failure:
            raise ConflictError(
                "candidate is not a recoverable completed or pending provider job",
                details={
                    "candidate_index": candidate_index,
                    "status": candidate.status.value,
                    "provider_status": candidate.provider_status,
                    "error_code": (candidate.error or {}).get("code"),
                },
            )

        provider = get_provider("pixellab", self.settings)
        if candidate.attack_sequence:
            from .attack_sequence import FixedAttackGeneration
            return FixedAttackGeneration(self).recover(job_id,candidate_index,provider)
        provider_job_id = candidate.provider_job_id
        with self.store.locked_job(job_id) as job:
            current = self._candidate(job, candidate_index)
            if current.frames:
                return job
            if current.provider_job_id != provider_job_id:
                raise ConflictError(
                    "candidate provider job changed before recovery",
                    details={"candidate_index": candidate_index},
                )
            current.status = CandidateStatus.provider_pending
            current.error = None
            self._refresh_job_status(job)
            job.touch(
                "candidate_recovery_started",
                candidate_index=candidate_index,
                provider_job_id=provider_job_id,
                submission_created=False,
            )

        # This path deliberately calls only poll/GET. It never invokes
        # provider.submit, so recovering paid output cannot create another job.
        self._poll_candidate(job_id, candidate_index, provider, wait=False)
        return self.store.load(job_id)

    def _submit_candidate(self, job_id: str, candidate_index: int, provider: Any) -> None:
        from .providers import ProviderRequest

        snapshot = self.store.load(job_id)
        snapshot_candidate = self._candidate(snapshot, candidate_index)
        reference_bytes = (self.store.job_dir(job_id) / "input" / "reference.png").read_bytes()
        actual_reference_sha = hashlib.sha256(reference_bytes).hexdigest()
        if actual_reference_sha != snapshot.reference_sha256:
            raise ValidationHarnessError(
                "reference snapshot changed after job creation",
                details={
                    "expected_sha256": snapshot.reference_sha256,
                    "actual_sha256": actual_reference_sha,
                },
            )
        edit_frames = None
        if snapshot.request.motion_repair is not None:
            from .motion_correction import MotionCorrection
            edit_frames, edit_prompt = MotionCorrection(self).generation_inputs(snapshot.request)
            if reference_bytes != edit_frames[0] or snapshot.full_prompt != edit_prompt:
                raise ValidationHarnessError("locked motion correction inputs changed")
        last_frame = None
        if snapshot.request.attack_segment is not None:
            from .attack_plans import AttackPlans
            first, last_frame, prompt = AttackPlans(self).generation_inputs(snapshot.request)
            last_path = self.store.job_dir(job_id) / "input" / "last_frame.png"
            if (reference_bytes != first or last_path.read_bytes() != last_frame
                    or snapshot.full_prompt != prompt or len(snapshot.candidates) != 1):
                raise ValidationHarnessError("locked attack segment inputs changed")
        estimated_result_bytes = max(
            64 * 1024 * 1024,
            snapshot.character.cell_width
            * snapshot.character.cell_height
            * 4
            * snapshot.action.generation_frame_count
            * 12,
        )
        free_bytes = shutil.disk_usage(self.settings.jobs_dir).free
        if free_bytes < estimated_result_bytes:
            raise ValidationHarnessError(
                "not enough free disk space to safely preserve the provider result",
                details={
                    "free_bytes": free_bytes,
                    "required_headroom_bytes": estimated_result_bytes,
                },
            )
        request = ProviderRequest(
            reference_image=reference_bytes,
            prompt=snapshot.full_prompt,
            frame_count=snapshot.action.generation_frame_count,
            seed=snapshot_candidate.seed,
            transparent_background=snapshot.character.transparent_background,
            last_frame=last_frame,
            edit_frames=edit_frames,
            local_submission_id=animation_intent_id(job_id, candidate_index),
        )
        provider_dir = self.store.job_dir(job_id) / "provider"
        intent_path = provider_dir / f"{snapshot_candidate.candidate_id}.submit.intent.json"
        atomic_write_json(
            intent_path,
            {
                "schema_version": 1,
                "job_id": job_id,
                "candidate_index": candidate_index,
                "provider": provider.name,
                "request_key": snapshot.request.request_key,
                "request_fingerprint": snapshot.request_fingerprint,
                "reference_sha256": snapshot.reference_sha256,
                "prompt_sha256": hashlib.sha256(snapshot.full_prompt.encode("utf-8")).hexdigest(),
                "frame_count": request.frame_count,
                "seed": request.seed,
                "transparent_background": request.transparent_background,
                "created_at": utc_now().isoformat(),
                "maximum_submission_attempts": 1,
                "storage_headroom_bytes": free_bytes,
                "required_storage_headroom_bytes": estimated_result_bytes,
            },
        )
        with self.store.locked_job(job_id) as job:
            candidate = self._candidate(job, candidate_index)
            if candidate.status != CandidateStatus.created:
                raise ConflictError("candidate is not ready for submission", details={"status": candidate.status.value})
            pending_other = [
                item.candidate_index
                for item in job.candidates
                if item.candidate_index != candidate_index
                and item.status
                in (
                    CandidateStatus.submitting,
                    CandidateStatus.submission_unknown,
                    CandidateStatus.provider_pending,
                    CandidateStatus.saving,
                )
            ]
            if pending_other:
                raise ConflictError(
                    "another candidate is already pending",
                    details={"candidate_indices": pending_other},
                )
            candidate.status = CandidateStatus.submitting
            job.generation_account = job.generation_account or getattr(provider, 'account_fingerprint', None)
            if job.generation_requested_at is None:
                job.generation_requested_at = utc_now()
                job.touch("generation_requested")
            candidate.submission_started_at = utc_now()
            candidate.submission_attempts = 1
            candidate.provider_name = provider.name
            candidate.provider_model = ("edit-animation-v2" if snapshot.request.motion_repair else "animate-with-text-v3") if provider.name == "pixellab" else "diagnostic-continuity-v2"
            candidate.raw_request_path = relative_posix(intent_path, self.store.job_dir(job_id))
            job.status = JobStatus.submitting
            job.touch("candidate_submitting", candidate_index=candidate_index, provider=provider.name)
        try:
            submission = provider.submit(request)
        except AccountSlotBusy:
            raise
        except ProviderError as exc:
            with self.store.locked_job(job_id) as failed_job:
                failed = self._candidate(failed_job, candidate_index)
                submission_unknown = bool(exc.details.get("submission_unknown"))
                failed.status = CandidateStatus.submission_unknown if submission_unknown else CandidateStatus.failed
                failed.provider_job_id = exc.details.get("provider_job_id")
                failed.usage = (exc.details.get("response") or {}).get("usage") or {}
                failed.error = exc.as_dict()
                self._refresh_job_status(failed_job)
                failed_job.touch(
                    "candidate_submission_unknown" if submission_unknown else "candidate_submission_failed",
                    candidate_index=candidate_index,
                    error=exc.as_dict(),
                )
            if exc.details.get("submission_rejected"):
                return
            raise

        # Persist the provider ID before optional audit records. Once this save
        # succeeds, a process crash or page refresh can always resume with GET
        # and will never need to repeat the chargeable POST.
        with self.store.locked_job(job_id) as submitted_job:
            submitted = self._candidate(submitted_job, candidate_index)
            if submitted.status != CandidateStatus.submitting:
                raise ConflictError(
                    "candidate changed while provider submission was in flight",
                    details={"status": submitted.status.value},
                )
            submitted.provider_job_id = submission.provider_job_id
            submitted.provider_status = submission.status
            submitted.diagnostic_only = submission.diagnostic_only
            submitted.submitted_at = utc_now()
            submitted.status = CandidateStatus.provider_pending
            submitted.usage = submission.raw_response.get("usage") or {}
            submitted.error = None
            submitted_job.status = JobStatus.provider_pending
            submitted_job.touch(
                "candidate_submitted",
                candidate_index=candidate_index,
                provider_job_id=submission.provider_job_id,
                diagnostic_only=submission.diagnostic_only,
            )

        request_path = provider_dir / f"{snapshot_candidate.candidate_id}.submit.request.json"
        response_path = provider_dir / f"{snapshot_candidate.candidate_id}.submit.response.json"
        try:
            atomic_write_json(request_path, submission.request_record)
            atomic_write_json(response_path, submission.raw_response)
        except Exception as exc:
            with self.store.locked_job(job_id) as audit_job:
                submitted = self._candidate(audit_job, candidate_index)
                if submitted.provider_job_id == submission.provider_job_id:
                    submitted.error = {
                        "code": "submission_audit_write_failed",
                        "message": "provider job ID is safe, but local audit metadata could not be written",
                        "details": {"type": type(exc).__name__},
                    }
                    audit_job.touch(
                        "submission_audit_write_failed",
                        candidate_index=candidate_index,
                        provider_job_id=submission.provider_job_id,
                    )
            return

        with self.store.locked_job(job_id) as audit_job:
            submitted = self._candidate(audit_job, candidate_index)
            if submitted.provider_job_id != submission.provider_job_id:
                return
            submitted.raw_request_path = relative_posix(request_path, self.store.job_dir(job_id))
            submitted.raw_response_path = relative_posix(response_path, self.store.job_dir(job_id))
            audit_job.touch(
                "candidate_submission_audit_saved",
                candidate_index=candidate_index,
                provider_job_id=submission.provider_job_id,
            )

    def _poll_candidate(self, job_id: str, candidate_index: int, provider: Any, *, wait: bool) -> None:
        from .providers import PollStatus

        operation = f"candidate_{candidate_index:02d}.poll"
        with self.store.operation_lock(job_id, operation):
            job = self.store.load(job_id)
            candidate = self._candidate(job, candidate_index)
            if candidate.status not in (CandidateStatus.provider_pending, CandidateStatus.saving) or not candidate.provider_job_id:
                return
            provider_job_id = candidate.provider_job_id
            candidate_id = candidate.candidate_id
            try:
                result = provider.wait(provider_job_id) if wait else provider.poll(provider_job_id)
            except ProviderTemporaryError as exc:
                updated = False
                with self.store.locked_job(job_id) as pending_job:
                    pending = self._candidate(pending_job, candidate_index)
                    if self._is_current_poll_target(pending, provider_job_id):
                        pending.error = exc.as_dict()
                        pending.last_polled_at = utc_now()
                        self._refresh_job_status(pending_job)
                        pending_job.touch("candidate_poll_deferred", candidate_index=candidate_index, error=exc.as_dict())
                        updated = True
                if wait and updated:
                    raise
                return
            except ProviderError as exc:
                updated = False
                with self.store.locked_job(job_id) as failed_job:
                    failed = self._candidate(failed_job, candidate_index)
                    if self._is_current_poll_target(failed, provider_job_id):
                        failed.error = exc.as_dict()
                        failed.last_polled_at = utc_now()
                        failed.status = CandidateStatus.failed
                        self._refresh_job_status(failed_job)
                        failed_job.touch("candidate_poll_failed", candidate_index=candidate_index, error=exc.as_dict())
                        updated = True
                if updated:
                    raise
                return

            response_path = self.store.job_dir(job_id) / "provider" / f"{candidate_id}.poll.response.json"
            response_audit_saved = False
            response_audit_error: dict[str, Any] | None = None
            try:
                atomic_write_json(response_path, result.raw_response)
                response_audit_saved = True
            except Exception as exc:
                # The bounded provider response is useful audit metadata, but a
                # write failure here must never discard completed paid images
                # already present in memory.
                response_audit_error = {
                    "type": type(exc).__name__,
                    "message": str(exc),
                }
            with self.store.locked_job(job_id) as polled_job:
                polled = self._candidate(polled_job, candidate_index)
                if not self._is_current_poll_target(polled, provider_job_id):
                    return
                if response_audit_saved:
                    polled.raw_response_path = relative_posix(
                        response_path,
                        self.store.job_dir(job_id),
                    )
                elif response_audit_error is not None:
                    polled_job.touch(
                        "poll_audit_write_failed",
                        candidate_index=candidate_index,
                        provider_job_id=provider_job_id,
                        error=response_audit_error,
                    )
                polled.provider_status = result.provider_status
                polled.last_polled_at = utc_now()
                polled.usage = result.usage or polled.usage
                polled.error = result.error
                if result.status == PollStatus.pending:
                    polled.status = CandidateStatus.provider_pending
                    self._refresh_job_status(polled_job)
                    polled_job.touch("candidate_provider_pending", candidate_index=candidate_index)
                    return
                if result.status == PollStatus.failed:
                    retryable = bool((result.error or {}).get("details", {}).get("retryable"))
                    polled.status = CandidateStatus.provider_pending if retryable else CandidateStatus.failed
                    self._refresh_job_status(polled_job)
                    polled_job.touch(
                        "candidate_provider_wait_incomplete" if retryable else "candidate_provider_failed",
                        candidate_index=candidate_index,
                        error=result.error,
                    )
                    return
                polled.status = CandidateStatus.saving
                polled.provider_completed_at = utc_now()
                polled.error = None
                self._refresh_job_status(polled_job)
                polled_job.touch(
                    "candidate_provider_completed",
                    candidate_index=candidate_index,
                    provider_job_id=provider_job_id,
                )

            try:
                stored = self._store_provider_frames(
                    job_id,
                    candidate_index,
                    result.images,
                    diagnostic_only=result.diagnostic_only,
                    expected_provider_job_id=provider_job_id,
                )
            except Exception as exc:
                error = (
                    exc.as_dict()
                    if isinstance(exc, HarnessError)
                    else {
                        "code": "provider_frame_storage_error",
                        "message": str(exc),
                        "details": {"type": type(exc).__name__},
                    }
                )
                with self.store.locked_job(job_id) as failed_job:
                    failed = self._candidate(failed_job, candidate_index)
                    if self._is_current_poll_target(failed, provider_job_id):
                        # The paid provider result may still be downloadable.
                        # Keep the candidate recoverable and let the background
                        # worker retry safe GET/storage operations only.
                        failed.status = CandidateStatus.saving
                        failed.error = error
                        self._refresh_job_status(failed_job)
                        failed_job.touch("provider_frame_storage_failed", candidate_index=candidate_index, error=error)
                raise
            if stored:
                self.check_candidate(job_id, candidate_index)
                if getattr(provider, "get_balance", None) is not None:
                    try:
                        quota_after = self._refresh_balance_with_provider(provider)
                        with self.store.locked_job(job_id) as quota_job:
                            quota_job.quota_after = quota_after
                            quota_job.touch(
                                "generation_quota_refreshed_after_save",
                                candidate_index=candidate_index,
                                remaining=self._remaining_generations(quota_after),
                            )
                    except Exception as exc:
                        with self.store.locked_job(job_id) as quota_job:
                            quota_job.touch(
                                "generation_quota_refresh_failed_after_save",
                                candidate_index=candidate_index,
                                error={"type": type(exc).__name__, "message": str(exc)},
                            )

    @staticmethod
    def _is_current_poll_target(candidate: CandidateRecord, provider_job_id: str) -> bool:
        return (
            candidate.status in (CandidateStatus.provider_pending, CandidateStatus.saving)
            and candidate.provider_job_id == provider_job_id
        )

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
            candidate = self._candidate(job, candidate_index)
            if not self._is_current_poll_target(candidate, expected_provider_job_id):
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
                    self._atomic_write_bytes(path, payload)
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
                    self._atomic_write_bytes(path, images[source_index])
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
                    os.replace(staging_dir, output_dir)
            except Exception as exc:
                if staging_dir.exists():
                    recovery_root = (
                        self.settings.recovery_dir
                        / "incomplete_provider_results"
                        / job_id
                    )
                    try:
                        recovery_root.mkdir(parents=True, exist_ok=True)
                        preserved = recovery_root / (
                            f"{candidate.candidate_id}_{utc_now().strftime('%Y%m%dT%H%M%S%fZ')}"
                            f"_{secrets.token_hex(4)}"
                        )
                        os.replace(staging_dir, preserved)
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
            self._refresh_job_status(job)
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
            self._refresh_job_status(job)

        for candidate_index in adopted:
            try:
                self.check_candidate(job_id, candidate_index)
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

    def attach_provider_job_id(
        self,
        job_id: str,
        candidate_index: int,
        provider_job_id: str,
    ) -> JobRecord:
        """Attach a known remote ID after an ambiguous POST; never submit."""

        remote_id = provider_job_id.strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{5,199}", remote_id):
            raise ValidationHarnessError("provider job ID format is invalid")
        with self.store.locked_job(job_id) as job:
            if job.request.provider != "pixellab":
                raise ValidationHarnessError("manual provider recovery is only available for PixelLab")
            candidate = self._candidate(job, candidate_index)
            if candidate.frames:
                return job
            if job.request.open_plan:
                from .collaboration.checkpoints import checked_plan
                finished_state = "accepted" if checked_plan(job) else "complete"
                run = next((r for r in candidate.plan_execution.stages if r.state != finished_state), None)
                if run is None or run.state not in {"submitting", "unknown", "pending"}:
                    raise ConflictError("当前片段没有待核对的提交")
                if run.provider_job_id and run.provider_job_id != remote_id:
                    raise ConflictError("片段已有不同的远端编号")
                run.provider_job_id = remote_id
                run.state = "pending"
            if candidate.provider_job_id and candidate.provider_job_id != remote_id:
                raise ConflictError("candidate already has a different provider job ID")
            if candidate.status not in (
                CandidateStatus.submitting,
                CandidateStatus.submission_unknown,
                CandidateStatus.provider_pending,
                CandidateStatus.saving,
            ):
                raise ConflictError(
                    "candidate is not waiting for a recoverable provider job",
                    details={"status": candidate.status.value},
                )
            candidate.provider_job_id = remote_id
            candidate.provider_status = candidate.provider_status or "processing"
            candidate.submitted_at = candidate.submitted_at or utc_now()
            candidate.status = CandidateStatus.provider_pending
            candidate.error = None
            job.generation_requested_at = job.generation_requested_at or utc_now()
            self._refresh_job_status(job)
            job.touch(
                "provider_job_id_attached",
                candidate_index=candidate_index,
                provider_job_id=remote_id,
                submission_created=False,
            )
        return self.store.load(job_id)

    def recover_pending_jobs(self) -> dict[str, Any]:
        """Advance every durable live generation using only safe operations."""

        summary: dict[str, Any] = {
            "checked_at": utc_now().isoformat(),
            "advanced": [],
            "attention_required": [],
            "errors": [],
        }
        for row in self.store.list_jobs():
            # Completed assets are represented by summary.json and are opened
            # lazily by the UI. Only unfinished/attention tasks need a deep
            # reconciliation pass in the background worker.
            if not bool(row.get("needs_recovery")):
                continue
            job_id = str(row["job_id"])
            try:
                job = self.reconcile_saved_results(job_id)
                if job.request.open_plan and job.generation_requested_at is not None:
                    from .providers import get_provider
                    from .collaboration.execution import PlanGeneration
                    provider = get_provider(job.request.provider, self.settings)
                    before_revision = job.revision
                    advanced = PlanGeneration(self).advance(job_id, provider)
                    if advanced.revision != before_revision:
                        summary["advanced"].append({"job_id": job_id, "status": advanced.status.value})
                    continue
                if job.request.provider != "pixellab" or job.generation_requested_at is None:
                    continue
                if job.generation_account and (not self.settings.pixellab_api_key or job.generation_account != PixelLabSlot(self.settings, self.store).key):
                    continue
                stale_before = utc_now() - timedelta(
                    seconds=max(120.0, self.settings.http_timeout_seconds * 2)
                )
                stale_indices = [
                    candidate.candidate_index
                    for candidate in job.candidates
                    if candidate.status == CandidateStatus.submitting
                    and candidate.provider_job_id is None
                    and candidate.submission_started_at is not None
                    and candidate.submission_started_at < stale_before
                ]
                if stale_indices:
                    with self.store.locked_job(job_id) as stale_job:
                        for index in stale_indices:
                            candidate = self._candidate(stale_job, index)
                            if candidate.status != CandidateStatus.submitting or candidate.provider_job_id:
                                continue
                            stages = (candidate.attack_sequence or {}).get('stages', [])
                            stage = next((i for i, run in enumerate(stages) if run['state'] == 'submitting'), None)
                            receipt = self._recover_submission_receipt(stale_job, candidate, stage=stage)
                            if receipt:
                                if stage is not None:
                                    stages[stage].update(state='pending', provider_job_id=receipt['jobId'], usage=receipt['usage'])
                                continue
                            candidate.status = CandidateStatus.submission_unknown
                            candidate.error = {
                                "code": "submission_interrupted",
                                "message": "the process stopped before the provider job ID was saved",
                                "details": {
                                    "safe_to_retry": False,
                                    "manual_provider_job_id_can_recover": True,
                                },
                            }
                            stale_job.touch(
                                "candidate_submission_marked_unknown",
                                candidate_index=index,
                            )
                        self._refresh_job_status(stale_job)
                    job = self.store.load(job_id)
                unknown = [
                    candidate.candidate_index
                    for candidate in job.candidates
                    if candidate.status == CandidateStatus.submission_unknown
                ]
                if unknown:
                    summary["attention_required"].append(
                        {"job_id": job_id, "candidate_indices": unknown}
                    )
                    continue
                quota_blocked = [
                    candidate.candidate_index
                    for candidate in job.candidates
                    if candidate.status == CandidateStatus.created
                    and (candidate.error or {}).get("code") == "insufficient_quota"
                ]
                if quota_blocked:
                    summary["attention_required"].append(
                        {
                            "job_id": job_id,
                            "candidate_indices": quota_blocked,
                            "reason": "insufficient_quota",
                        }
                    )
                active = any(
                    candidate.status
                    in (CandidateStatus.provider_pending, CandidateStatus.saving)
                    for candidate in job.candidates
                )
                if not quota_blocked:
                    active = active or any(
                        candidate.status == CandidateStatus.created
                        for candidate in job.candidates
                    )
                from .motion_correction import active as motion_active
                active = active or motion_active(job)
                if active and self.settings.pixellab_api_key:
                    before_revision = job.revision
                    advanced = self.generate_job(job_id, wait=False, candidate_index=job.queued_candidate_index)
                    if advanced.revision != before_revision:
                        summary["advanced"].append(
                            {"job_id": job_id, "status": advanced.status.value}
                        )
            except Exception as exc:
                summary["errors"].append(
                    {"job_id": job_id, "message": str(exc), "type": type(exc).__name__}
                )
        atomic_write_json(self.settings.config_dir / "last_recovery_scan.json", summary)
        return summary

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

    def candidate_safety(self, job_id: str, candidate_index: int) -> dict[str, Any]:
        # This performs disk-only reconciliation. It may attach an already
        # committed result after a crash, but it never contacts the provider.
        job = self.reconcile_saved_results(job_id)
        candidate = self._candidate(job, candidate_index)
        result_integrity: bool | None = None
        if candidate.result_manifest_path and candidate.frames:
            try:
                result_integrity = self._committed_result_integrity(job_id, candidate)
            except Exception:
                result_integrity = False
        if candidate.result_saved_at is not None:
            stage = "saved"
        elif candidate.status == CandidateStatus.submission_unknown:
            stage = "submission_unknown"
        elif candidate.status == CandidateStatus.submitting:
            stage = "submitting"
        elif candidate.status == CandidateStatus.provider_pending:
            stage = "processing"
        elif candidate.status == CandidateStatus.saving:
            stage = "saving"
        elif candidate.status == CandidateStatus.failed:
            stage = "failed"
        else:
            stage = candidate.status.value
        return {
            "job_id": job_id,
            "candidate_index": candidate_index,
            "stage": stage,
            "local_task_saved": True,
            "automatic_resubmission_allowed": False,
            "submission_attempts": candidate.submission_attempts,
            "provider_job_id": candidate.provider_job_id,
            "submission_started_at": candidate.submission_started_at.isoformat() if candidate.submission_started_at else None,
            "submitted_at": candidate.submitted_at.isoformat() if candidate.submitted_at else None,
            "last_polled_at": candidate.last_polled_at.isoformat() if candidate.last_polled_at else None,
            "provider_completed_at": candidate.provider_completed_at.isoformat() if candidate.provider_completed_at else None,
            "result_saved_at": candidate.result_saved_at.isoformat() if candidate.result_saved_at else None,
            "result_integrity": result_integrity,
            "error": candidate.error,
        }

    @staticmethod
    def _atomic_write_bytes(path: Path, payload: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
        except Exception:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            raise

    def check_candidate(self, job_id: str, candidate_index: int) -> JobRecord:
        failure: Exception | None = None
        with self.store.locked_job(job_id) as job:
            candidate = self._candidate(job, candidate_index)
            self._assert_committed_result_integrity(
                job_id,
                job,
                candidate,
                error_class=ValidationHarnessError,
            )
            allowed = {
                CandidateStatus.received,
                CandidateStatus.check_failed,
                CandidateStatus.review_ready,
            }
            if not candidate.frames:
                raise ValidationHarnessError("candidate has no frames", details={"candidate_index": candidate_index})
            stale_approved = (
                candidate.status == CandidateStatus.approved
                and candidate.qa_algorithm_version != QA_ALGORITHM_VERSION
                and not (job.export and job.export.candidate_index == candidate.candidate_index)
            )
            if candidate.status not in allowed and not stale_approved:
                raise ConflictError(
                    "candidate is not ready for QA",
                    details={"candidate_index": candidate_index, "status": candidate.status.value},
                )
            if stale_approved:
                job.touch(
                    "candidate_approval_invalidated_by_qa_upgrade",
                    candidate_index=candidate_index,
                    previous_qa_algorithm_version=candidate.qa_algorithm_version,
                    current_qa_algorithm_version=QA_ALGORITHM_VERSION,
                )
            try:
                self._run_candidate_qa(job_id, job, candidate)
            except Exception as exc:
                failure = exc
                error = (
                    exc.as_dict()
                    if isinstance(exc, HarnessError)
                    else {
                        "code": "qa_execution_error",
                        "message": str(exc),
                        "details": {"type": type(exc).__name__},
                    }
                )
                candidate.status = CandidateStatus.check_failed
                candidate.qa_completed_at = None
                candidate.qa_input_sha256 = None
                candidate.qa_algorithm_version = None
                candidate.error = error
                self._refresh_job_status(job)
                job.touch("candidate_check_failed", candidate_index=candidate_index, error=error)
        if failure is not None:
            raise failure
        return self.store.load(job_id)

    def _run_candidate_qa(self, job_id: str, job: JobRecord, candidate: CandidateRecord) -> None:
        candidate.qa_completed_at = None
        candidate.qa_input_sha256 = None
        candidate.qa_algorithm_version = None
        input_digest_before = self._verified_frame_digest(
            job_id,
            job,
            candidate,
            error_class=ValidationHarnessError,
            require_png_contract=False,
            require_expected_indices=False,
        )
        frame_paths = [self.store.resolve_job_path(job_id, frame.active_path) for frame in candidate.frames]
        reference_path = self.store.job_dir(job_id) / "input" / "reference.png"
        palette_candidates = sorted((self.store.job_dir(job_id) / "input").glob("palette.*"))
        palette_path = palette_candidates[0] if palette_candidates else None
        from .processing import build_baseline_grid, build_gif, build_overlay, build_review_grid, build_sprite_sheet, run_qa

        report = run_qa(
            frame_paths,
            self._candidate_expected_frame_count(job, candidate),
            job.character.cell_width,
            job.character.cell_height,
            reference_path=reference_path,
            palette_path=palette_path,
            safe_margin=job.character.safe_margin,
            grounded=job.action.grounded,
            anchor_ground_y=job.character.anchor.ground_y,
            loop=job.action.loop,
            thresholds=self._qa_thresholds(job),
        )
        if job.request.attack_segment or (job.request.request_key or "").startswith("attack-assembly-"):
            from .attack_plans import AttackPlans
            AttackPlans(self).apply_hold_policy(job, report)
        from .motion_correction import apply_charge_hold
        apply_charge_hold(job, report)
        self._apply_qa_report(candidate, report)
        if len(candidate.frames) != job.action.frame_count:
            imported = job.request.provider == "import"
            candidate.warnings.insert(
                0,
                QAIssue(
                    code="frame_count_mismatch" if imported else "provider_frame_count_adjusted",
                    severity=IssueSeverity.warning,
                    message=(
                        f"The {'imported sheet contains' if imported else 'provider returned'} "
                        f"{len(candidate.frames)} usable frames; the action preset expects "
                        f"{job.action.frame_count}. All usable frames were preserved for review."
                    ),
                    metrics={
                        "expected": job.action.frame_count,
                        "actual": len(candidate.frames),
                        "policy": "preserve_all_imported" if imported else "preserve_all_returned",
                    },
                ),
            )
        preview_dir = self.store.job_dir(job_id) / "previews"
        prefix = preview_dir / candidate.candidate_id
        preview_suffixes = {
            "sheet": ".sheet.png",
            "gif": ".preview.gif",
            "zoom_gif": ".zoom.gif",
            "grid": ".grid.png",
            "baseline": ".baseline.png",
            "overlay": ".overlay.png",
        }
        # Derived previews are disposable. Remove the previous QA generation
        # before rebuilding so a failed builder can never leave an old image
        # masquerading as the current frame set.
        for suffix in preview_suffixes.values():
            prefix.with_suffix(suffix).unlink(missing_ok=True)
        sheet_columns, sheet_rows, sheet_cells = self._candidate_sheet_layout(job, candidate)
        preview_builders = (
            (
                "sheet",
                lambda: build_sprite_sheet(
                    frame_paths,
                    prefix.with_suffix(".sheet.png"),
                    sheet_columns,
                    rows=sheet_rows,
                    frame_cells=sheet_cells,
                ),
            ),
            (
                "gif",
                lambda: build_gif(
                    frame_paths,
                    prefix.with_suffix(".preview.gif"),
                    job.action.fps,
                    scale=1,
                    loop=job.action.loop,
                ),
            ),
            (
                "zoom_gif",
                lambda: build_gif(
                    frame_paths,
                    prefix.with_suffix(".zoom.gif"),
                    job.action.fps,
                    scale=4,
                    loop=job.action.loop,
                ),
            ),
            ("grid", lambda: build_review_grid(frame_paths, prefix.with_suffix(".grid.png"), scale=4)),
            (
                "baseline",
                lambda: build_baseline_grid(
                    frame_paths,
                    prefix.with_suffix(".baseline.png"),
                    anchor_x=job.character.anchor.x,
                    ground_y=job.character.anchor.ground_y,
                    scale=4,
                ),
            ),
            (
                "overlay",
                lambda: build_overlay(
                    frame_paths,
                    prefix.with_suffix(".overlay.png"),
                    scale=4,
                    loop=job.action.loop,
                ),
            ),
        )
        for artifact, builder in preview_builders:
            try:
                builder()
            except (OSError, ValueError, SyntaxError) as exc:
                prefix.with_suffix(preview_suffixes[artifact]).unlink(missing_ok=True)
                candidate.warnings.append(
                    QAIssue(
                        code="preview_generation_failed",
                        severity=IssueSeverity.warning,
                        message=f"Could not build {artifact} preview: {exc}",
                        metrics={"artifact": artifact, "error_type": type(exc).__name__},
                    )
                )
        input_digest_after = self._verified_frame_digest(
            job_id,
            job,
            candidate,
            error_class=ValidationHarnessError,
            require_png_contract=False,
            require_expected_indices=False,
        )
        if input_digest_after != input_digest_before:
            raise ValidationHarnessError(
                "QA inputs changed while the candidate was being checked",
                details={"before": input_digest_before, "after": input_digest_after},
            )
        candidate.qa_input_sha256 = input_digest_after
        candidate.qa_completed_at = utc_now()
        candidate.qa_algorithm_version = QA_ALGORITHM_VERSION
        self._finalize_qa_change_summary(candidate)
        candidate.error = None
        candidate.status = CandidateStatus.check_failed if candidate.hard_failures else CandidateStatus.review_ready
        self._refresh_job_status(job)
        job.touch(
            "candidate_checked",
            candidate_index=candidate.candidate_index,
            hard_failure_count=len(candidate.hard_failures),
            warning_count=len(candidate.warnings),
        )

    @staticmethod
    def _qa_thresholds(job: JobRecord) -> dict[str, int | float | None]:
        qa = job.character.qa
        return {
            "duplicate_min_run": qa.duplicate_run_length,
            "area_change_ratio": qa.area_change_ratio,
            "centroid_jump_pixels": (
                job.action.centroid_shift_px
                if job.action.centroid_shift_px is not None
                else qa.centroid_shift_px
            ),
            "palette_deviation_ratio": qa.palette_mismatch_ratio,
            "palette_color_distance": qa.palette_distance,
            "loop_difference_ratio": qa.loop_difference_ratio,
            "ground_baseline_tolerance": qa.ground_y_tolerance_px,
            "rigid_translation_tolerance_px": qa.rigid_translation_tolerance_px,
            # Processing treats alpha > threshold as visible.
            "alpha_threshold": max(0, qa.alpha_visible_threshold - 1),
        }

    @staticmethod
    def _issue(raw: dict[str, Any] | str, default_severity: IssueSeverity) -> QAIssue:
        if isinstance(raw, str):
            return QAIssue(code=raw, severity=default_severity, message=raw)
        known = {"code", "message", "frame_index", "severity", "metrics"}
        metrics = dict(raw.get("metrics") or {})
        metrics.update({key: value for key, value in raw.items() if key not in known})
        return QAIssue(
            code=str(raw.get("code", "qa_issue")),
            severity=raw.get("severity", default_severity.value),
            message=str(raw.get("message", raw.get("code", "QA issue"))),
            frame_index=raw.get("frame_index"),
            metrics=metrics,
        )

    def _apply_qa_report(self, candidate: CandidateRecord, report: dict[str, Any]) -> None:
        old_reviews = {frame.index: frame for frame in candidate.frames}
        candidate.hard_failures = [self._issue(item, IssueSeverity.hard_failure) for item in report.get("hard_failures", [])]
        candidate.warnings = [self._issue(item, IssueSeverity.warning) for item in report.get("warnings", [])]
        by_frame = {int(item.get("index", item.get("frame_index", -1))): item for item in report.get("frames", [])}
        for frame in candidate.frames:
            raw = by_frame.get(frame.index, {})
            frame.hard_failures = [
                item
                for item in candidate.hard_failures
                if item.frame_index == frame.index or frame.index in item.metrics.get("frame_indices", [])
            ]
            frame.warnings = [item for item in candidate.warnings if item.frame_index == frame.index]
            previous = old_reviews.get(frame.index)
            if previous and previous.sha256 == frame.sha256:
                frame.review_status = previous.review_status
                frame.issue_type = previous.issue_type
                frame.review_note = previous.review_note
                frame.reviewed_by = previous.reviewed_by
                frame.reviewed_at = previous.reviewed_at
                frame.repair_attempts = previous.repair_attempts
            elif previous:
                frame.repair_attempts = previous.repair_attempts

    @staticmethod
    def _qa_issue_identity(issue: QAIssue) -> tuple[Any, ...]:
        """Match issue type and frame scope, not fluctuating measurements."""

        raw_indices = issue.metrics.get("frame_indices")
        frame_indices: tuple[int, ...] = ()
        if isinstance(raw_indices, (list, tuple, set)):
            normalized: set[int] = set()
            for value in raw_indices:
                if isinstance(value, bool):
                    continue
                try:
                    normalized.add(int(value))
                except (TypeError, ValueError):
                    continue
            frame_indices = tuple(sorted(normalized))

        def endpoint(name: str) -> int | str | None:
            value = issue.metrics.get(name)
            if value is None or isinstance(value, bool):
                return None
            try:
                return int(value)
            except (TypeError, ValueError):
                return str(value)

        return (
            issue.severity.value,
            issue.code,
            issue.frame_index,
            frame_indices,
            endpoint("from"),
            endpoint("to"),
        )

    @staticmethod
    def _successful_qa_baseline(candidate: CandidateRecord) -> QAIssueBaseline | None:
        if (
            candidate.qa_completed_at is None
            or not candidate.qa_input_sha256
            or candidate.error is not None
        ):
            return None
        issues = [
            issue.model_copy(deep=True)
            for issue in (*candidate.hard_failures, *candidate.warnings)
        ]
        return QAIssueBaseline(
            qa_input_sha256=candidate.qa_input_sha256,
            qa_algorithm_version=candidate.qa_algorithm_version,
            qa_completed_at=candidate.qa_completed_at,
            issues=issues,
        )

    def _finalize_qa_change_summary(self, candidate: CandidateRecord) -> None:
        baseline = candidate.qa_issue_baseline
        if baseline is None or not candidate.qa_input_sha256:
            # Initial QA has no honest comparison. Keep a previous repair summary
            # visible across an ordinary recheck until another edit supersedes it.
            return

        current = [
            issue.model_copy(deep=True)
            for issue in (*candidate.hard_failures, *candidate.warnings)
        ]
        available: dict[tuple[Any, ...], list[tuple[int, QAIssue]]] = {}
        for index, issue in enumerate(current):
            available.setdefault(self._qa_issue_identity(issue), []).append((index, issue))

        resolved: list[QAIssue] = []
        persisting: list[QAIssue] = []
        matched_current: set[int] = set()
        for old_issue in baseline.issues:
            matches = available.get(self._qa_issue_identity(old_issue), [])
            if matches:
                current_index, current_issue = matches.pop(0)
                matched_current.add(current_index)
                persisting.append(current_issue)
            else:
                resolved.append(old_issue.model_copy(deep=True))
        new = [issue for index, issue in enumerate(current) if index not in matched_current]

        candidate.qa_change_summary = QAChangeSummary(
            compared_at=utc_now(),
            baseline_qa_input_sha256=baseline.qa_input_sha256,
            current_qa_input_sha256=candidate.qa_input_sha256,
            baseline_qa_algorithm_version=baseline.qa_algorithm_version,
            current_qa_algorithm_version=QA_ALGORITHM_VERSION,
            resolved=resolved,
            new=new,
            persisting=persisting,
        )
        candidate.qa_issue_baseline = None

    def review_frame(self, job_id: str, candidate_index: int, review: FrameReviewRequest | dict[str, Any]) -> JobRecord:
        if not isinstance(review, FrameReviewRequest):
            review = FrameReviewRequest.model_validate(review)
        if review.status == ReviewStatus.rejected:
            raise ValidationHarnessError(
                "reject the whole candidate instead of rejecting one frame",
                details={"reason": "candidate_rejection_required"},
            )
        with self.store.locked_job(job_id) as job:
            candidate = self._candidate(job, candidate_index)
            self._assert_candidate_editable(job, candidate, operation="review frame")
            frame = self._frame(candidate, review.frame_index)
            if review.status in (ReviewStatus.approved, ReviewStatus.repair_requested):
                self._assert_qa_current(job_id, job, candidate)
            if review.status == ReviewStatus.approved:
                if candidate.status != CandidateStatus.review_ready:
                    raise ExportBlockedError(
                        "only a review_ready candidate can approve frames",
                        details={"candidate_status": candidate.status.value},
                    )
                if frame.hard_failures:
                    raise ExportBlockedError("a frame with hard failures cannot be approved", details={"frame_index": frame.index})
            frame.review_status = review.status
            frame.issue_type = review.issue_type
            frame.review_note = review.note
            frame.reviewed_by = review.reviewer
            frame.reviewed_at = utc_now()
            self._refresh_approval(job, candidate)
            job.touch(
                "frame_reviewed",
                candidate_index=candidate_index,
                frame_index=frame.index,
                status=review.status.value,
                issue_type=review.issue_type.value if review.issue_type else None,
                note=review.note,
                reviewer=review.reviewer,
            )
        return self.store.load(job_id)

    def approve_candidate(
        self,
        job_id: str,
        candidate_index: int,
        *,
        reviewer: str,
        acknowledge_warnings: bool = False,
        expected_frames: str | None = None,
        review_note: str = "",
        human_seconds: int | None = None,
    ) -> JobRecord:
        if human_seconds is not None and (type(human_seconds) is not int or not 0<=human_seconds<=86400):
            raise ValidationHarnessError("人工检查用时无效")
        with self.store.locked_job(job_id) as job:
            candidate = self._candidate(job, candidate_index)
            if expected_frames is not None:
                from .collaboration.api import candidate_digest
                if candidate_digest(candidate) != expected_frames:
                    raise ConflictError("动画帧已改变，请重新播放检查")
            if job.request.open_plan and job.request.open_plan.plan.quality:
                if job.request.open_plan.plan.quality.version >= 3 and (
                    not candidate.plan_execution or any(r.state != 'accepted' for r in candidate.plan_execution.stages)
                ):
                    raise ExportBlockedError('实际姿势检查点尚未全部确认，不能直接采用完整动画')
                from .collaboration.visual_review import review_state
                visual = review_state(candidate)
                if visual['state'] in {'pending', 'running'}:
                    raise ExportBlockedError('视觉验收尚未结束，请等待结果')
                if visual.get('verdict') != 'pass' and (not acknowledge_warnings or not review_note.strip()):
                    raise ExportBlockedError('视觉验收尚未通过；请先人工检查实际帧，记录结论并明确接受提醒')
            from .motion_correction import active as motion_active
            if motion_active(job):
                raise ExportBlockedError("自动视觉检查和补做尚未完成")
            if job.request.motion_repair is not None:
                raise ExportBlockedError("修补片段需回到逐帧修补采用")
            if job.request.attack_segment is not None:
                raise ExportBlockedError("攻击片段需回到受约束攻击方案检查并采用，再合成完整动画")
            if candidate.status != CandidateStatus.review_ready:
                raise ExportBlockedError(
                    "only a review_ready candidate can be approved",
                    details={"candidate_index": candidate_index, "status": candidate.status.value},
                )
            self._assert_qa_current(job_id, job, candidate)
            if candidate.hard_failures or any(frame.hard_failures for frame in candidate.frames):
                raise ExportBlockedError("candidate has hard failures", details={"candidate_index": candidate_index})
            unresolved = [
                frame.index
                for frame in candidate.frames
                if frame.review_status in (ReviewStatus.repair_requested, ReviewStatus.rejected)
            ]
            if unresolved:
                raise ExportBlockedError(
                    "candidate contains rejected or repair-requested frames",
                    details={"frame_indices": unresolved},
                )
            # The candidate list is the canonical sequence-wide list and already
            # includes frame-indexed warnings; do not count those twice.
            warning_count = len(candidate.warnings)
            if warning_count and not acknowledge_warnings:
                raise ExportBlockedError(
                    "candidate has warnings; explicit acknowledgement is required",
                    details={"candidate_index": candidate_index, "warning_count": warning_count},
                )
            if not candidate.frames:
                raise ExportBlockedError("candidate has no checked frames")
            now = utc_now()
            for frame in candidate.frames:
                frame.review_status = ReviewStatus.approved
                frame.reviewed_by = reviewer
                frame.reviewed_at = now
                frame.issue_type = None
                frame.review_note = "warnings acknowledged" if warning_count else ""
            candidate.status = CandidateStatus.approved
            self._refresh_job_status(job)
            job.touch("candidate_approved", candidate_index=candidate_index, reviewer=reviewer, warnings_acknowledged=bool(warning_count), **({"human_seconds":human_seconds} if human_seconds is not None else {}))
            if review_note:
                job.touch("manual_review_note", candidate_index=candidate_index, note=review_note)
        return self.store.load(job_id)

    def reject_candidate(self, job_id: str, candidate_index: int, *, reviewer: str, note: str = "") -> JobRecord:
        with self.store.locked_job(job_id) as job:
            candidate = self._candidate(job, candidate_index)
            rejectable = {
                CandidateStatus.received,
                CandidateStatus.check_failed,
                CandidateStatus.review_ready,
            }
            if candidate.status not in rejectable:
                raise ConflictError(
                    "candidate can only be rejected after provider receipt and before approval",
                    details={"candidate_index": candidate_index, "status": candidate.status.value},
                )
            candidate.status = CandidateStatus.rejected
            now = utc_now()
            for frame in candidate.frames:
                frame.review_status = ReviewStatus.rejected
                frame.reviewed_by = reviewer
                frame.reviewed_at = now
                frame.review_note = note
            self._refresh_job_status(job)
            job.touch("candidate_rejected", candidate_index=candidate_index, reviewer=reviewer, note=note)
        return self.store.load(job_id)

    def get_frame_edit_session(
        self,
        job_id: str,
        candidate_index: int,
        frame_index: int,
    ) -> dict[str, Any]:
        """Return the exact active RGBA pixels used by the browser editor."""

        job = self.store.load(job_id)
        candidate = self._candidate(job, candidate_index)
        frame = self._frame(candidate, frame_index)
        expected_size = (job.character.cell_width, job.character.cell_height)

        def read_frame_rgba(target: Any) -> bytes:
            source = self.store.resolve_job_path(job_id, target.active_path)
            actual_sha256 = sha256_file(source)
            if actual_sha256 != target.sha256:
                raise ConflictError(
                    "active frame changed outside the recorded job state",
                    details={
                        "reason": "active_frame_integrity_mismatch",
                        "frame_index": target.index,
                        "recorded_sha256": target.sha256,
                        "actual_sha256": actual_sha256,
                    },
                )
            try:
                with Image.open(source) as opened:
                    opened.load()
                    image = opened.convert("RGBA")
            except Exception as exc:
                raise ValidationHarnessError(
                    "active frame cannot be decoded for pixel editing",
                    details={"frame_index": target.index, "error": str(exc)},
                ) from exc
            if image.size != expected_size:
                raise ValidationHarnessError(
                    "active frame has the wrong size for pixel editing",
                    details={
                        "frame_index": target.index,
                        "actual": list(image.size),
                        "expected": list(expected_size),
                    },
                )
            return image.tobytes()

        current_position = next(
            index for index, item in enumerate(candidate.frames) if item.index == frame.index
        )

        neighbor_warnings: dict[str, dict[str, Any]] = {}

        def neighbour(label: str, offset: int) -> dict[str, Any] | None:
            if len(candidate.frames) <= 1:
                return None
            position = current_position + offset
            if position < 0 or position >= len(candidate.frames):
                if not job.action.loop:
                    return None
                position %= len(candidate.frames)
            target = candidate.frames[position]
            try:
                rgba = read_frame_rgba(target)
            except Exception as exc:
                details = getattr(exc, "details", {}) or {}
                neighbor_warnings[label] = {
                    "frame_index": target.index,
                    "reason": details.get("reason", "neighbor_unavailable"),
                    "message": str(exc),
                }
                return None
            return {"frame_index": target.index, "sha256": target.sha256, "rgba": rgba}

        return {
            "job_id": job_id,
            "candidate_index": candidate_index,
            "frame_index": frame_index,
            "frame_count": len(candidate.frames),
            "loop": job.action.loop,
            "width": expected_size[0],
            "height": expected_size[1],
            "alpha_visible_threshold": job.character.qa.alpha_visible_threshold,
            "rgba": read_frame_rgba(frame),
            "neighbors": {
                "previous": neighbour("previous", -1),
                "next": neighbour("next", 1),
            },
            "neighbor_warnings": neighbor_warnings,
            "base_sha256": frame.sha256,
            "review_status": frame.review_status.value,
            "candidate_status": candidate.status.value,
            "can_edit": (
                candidate.status not in {
                    CandidateStatus.approved,
                    CandidateStatus.rejected,
                    CandidateStatus.failed,
                }
                and not (job.export and job.export.candidate_index == candidate.candidate_index)
            ),
            "manual_edit_versions": frame.manual_edit_versions,
            "external_repair_attempts": frame.repair_attempts,
        }

    def edit_frame_pixels(
        self,
        job_id: str,
        candidate_index: int,
        frame_index: int,
        *,
        rgba: bytes,
        width: int,
        height: int,
        base_sha256: str,
        reviewer: str = "pixel_editor",
    ) -> JobRecord:
        """Commit one lossless manual pixel-edit version and re-run QA.

        Manual versions are intentionally separate from the two bounded
        external/AI replacement attempts. The immutable raw frame is never
        overwritten.
        """

        if not isinstance(rgba, bytes):
            raise ValidationHarnessError("pixel edit payload must be raw RGBA bytes")
        editor_name = reviewer.strip()
        if not editor_name or len(editor_name) > 100:
            raise ValidationHarnessError("pixel editor reviewer must be 1 to 100 characters")

        with self.store.locked_job(job_id) as job:
            candidate = self._candidate(job, candidate_index)
            self._assert_candidate_editable(job, candidate, operation="edit frame pixels")
            frame = self._frame(candidate, frame_index)
            expected_size = (job.character.cell_width, job.character.cell_height)
            actual_size = (int(width), int(height))
            if actual_size != expected_size:
                raise ValidationHarnessError(
                    "pixel edit has the wrong size",
                    details={"actual": list(actual_size), "expected": list(expected_size)},
                )
            expected_bytes = expected_size[0] * expected_size[1] * 4
            if len(rgba) != expected_bytes:
                raise ValidationHarnessError(
                    "pixel edit RGBA byte count is invalid",
                    details={"actual": len(rgba), "expected": expected_bytes},
                )
            if frame.sha256 != base_sha256:
                raise ConflictError(
                    "pixel edit is based on a stale frame version",
                    details={
                        "reason": "stale_frame_version",
                        "frame_index": frame_index,
                        "expected_sha256": frame.sha256,
                        "received_sha256": base_sha256,
                    },
                )
            active_source = self.store.resolve_job_path(job_id, frame.active_path)
            if sha256_file(active_source) != frame.sha256:
                raise ConflictError(
                    "active frame changed outside the recorded job state",
                    details={"reason": "active_frame_integrity_mismatch", "frame_index": frame_index},
                )
            try:
                with Image.open(active_source) as opened:
                    opened.load()
                    before = opened.convert("RGBA").tobytes()
            except Exception as exc:
                raise ValidationHarnessError(
                    "active frame cannot be decoded for pixel editing",
                    details={"frame_index": frame_index, "error": str(exc)},
                ) from exc
            if before == rgba:
                raise ValidationHarnessError(
                    "pixel edit does not change any pixels",
                    details={"reason": "no_pixel_changes", "frame_index": frame_index},
                )

            qa_issue_baseline = self._successful_qa_baseline(candidate)

            changed_pixels: list[int] = []
            for offset in range(0, expected_bytes, 4):
                if before[offset : offset + 4] != rgba[offset : offset + 4]:
                    changed_pixels.append(offset // 4)
            xs = [index % width for index in changed_pixels]
            ys = [index // width for index in changed_pixels]
            changed_bbox = [min(xs), min(ys), max(xs) + 1, max(ys) + 1]

            from .processing._common import atomic_save_png

            version = frame.manual_edit_versions + 1
            repair_dir = self.store.job_dir(job_id) / "repaired" / candidate.candidate_id
            destination = repair_dir / f"frame_{frame_index:03d}_manual_v{version:03d}.png"
            while destination.exists():
                version += 1
                destination = repair_dir / f"frame_{frame_index:03d}_manual_v{version:03d}.png"
            atomic_save_png(Image.frombytes("RGBA", expected_size, rgba), destination)
            try:
                with Image.open(destination) as saved:
                    saved.load()
                    round_trip = saved.convert("RGBA").tobytes()
            except Exception:
                destination.unlink(missing_ok=True)
                raise
            if round_trip != rgba:
                destination.unlink(missing_ok=True)
                raise ConflictError(
                    "saved PNG failed exact RGBA round-trip verification",
                    details={"frame_index": frame_index},
                )

            saved_sha256 = sha256_file(destination)
            metadata_path = destination.with_suffix(".meta.json")
            atomic_write_json(
                metadata_path,
                {
                    "schema_version": 1,
                    "job_id": job_id,
                    "candidate_index": candidate_index,
                    "frame_index": frame_index,
                    "manual_edit_version": version,
                    "base_sha256": base_sha256,
                    "saved_sha256": saved_sha256,
                    "width": width,
                    "height": height,
                    "changed_pixel_count": len(changed_pixels),
                    "changed_bbox": changed_bbox,
                    "issue_type": frame.issue_type.value if frame.issue_type else None,
                    "review_note": frame.review_note,
                    "reviewer": editor_name,
                    "created_at": utc_now().isoformat(),
                },
            )

            frame.active_path = relative_posix(destination, self.store.job_dir(job_id))
            frame.sha256 = saved_sha256
            frame.manual_edit_versions = version
            frame.review_status = ReviewStatus.pending
            frame.reviewed_by = None
            frame.reviewed_at = None
            frame.review_note = ""
            candidate.status = CandidateStatus.received
            candidate.hard_failures = []
            candidate.warnings = []
            candidate.error = None
            candidate.qa_completed_at = None
            candidate.qa_input_sha256 = None
            candidate.qa_algorithm_version = None
            candidate.qa_issue_baseline = qa_issue_baseline
            candidate.qa_change_summary = None
            for candidate_frame in candidate.frames:
                candidate_frame.hard_failures = []
                candidate_frame.warnings = []
            job.status = JobStatus.review_required
            job.touch(
                "frame_pixels_edited",
                candidate_index=candidate_index,
                frame_index=frame_index,
                manual_edit_version=version,
                changed_pixel_count=len(changed_pixels),
                changed_bbox=changed_bbox,
                reviewer=editor_name,
            )
        # The version above is already durable. A preview/QA failure must not
        # turn the response into a misleading "save failed" error. The check
        # records its own failure on the candidate; return that recoverable
        # state so callers can distinguish saved data from a failed recheck.
        try:
            return self.check_candidate(job_id, candidate_index)
        except Exception:
            return self.store.load(job_id)

    def edit_frame_png(
        self,
        job_id: str,
        candidate_index: int,
        frame_index: int,
        source: str | Path,
        *,
        base_sha256: str,
        reviewer: str = "codex",
    ) -> JobRecord:
        """Commit a local PNG through the unlimited manual-edit version path."""

        source_path = Path(source).resolve()
        if not source_path.is_file():
            raise NotFoundError("pixel edit frame not found", details={"path": str(source_path)})
        try:
            with Image.open(source_path) as opened:
                opened.load()
                if opened.format != "PNG":
                    raise ValidationHarnessError("pixel edit frame must be PNG")
                if "A" not in opened.getbands() and "transparency" not in opened.info:
                    raise ValidationHarnessError("pixel edit frame must retain source alpha")
                image = opened.convert("RGBA")
        except ValidationHarnessError:
            raise
        except Exception as exc:
            raise ValidationHarnessError(
                "pixel edit frame cannot be decoded",
                details={"path": str(source_path), "error": str(exc)},
            ) from exc
        if not isinstance(base_sha256, str) or not base_sha256.strip():
            raise ValidationHarnessError(
                "pixel edit requires the base frame sha256",
                details={"reason": "missing_base_sha256", "frame_index": frame_index},
            )
        return self.edit_frame_pixels(
            job_id,
            candidate_index,
            frame_index,
            rgba=image.tobytes(),
            width=image.width,
            height=image.height,
            base_sha256=base_sha256,
            reviewer=reviewer,
        )

    def replace_frame(
        self,
        job_id: str,
        candidate_index: int,
        frame_index: int,
        source: str | Path,
        *,
        base_sha256: str,
    ) -> JobRecord:
        source_path = Path(source).resolve()
        if not source_path.is_file():
            raise NotFoundError("replacement frame not found", details={"path": str(source_path)})
        with self.store.locked_job(job_id) as job:
            candidate = self._candidate(job, candidate_index)
            self._assert_candidate_editable(job, candidate, operation="replace frame")
            frame = self._frame(candidate, frame_index)
            if not isinstance(base_sha256, str) or not base_sha256.strip():
                raise ValidationHarnessError(
                    "frame replacement requires the base frame sha256",
                    details={"reason": "missing_base_sha256", "frame_index": frame_index},
                )
            if frame.sha256 != base_sha256:
                raise ConflictError(
                    "frame replacement is based on a stale frame version",
                    details={
                        "reason": "stale_frame_version",
                        "frame_index": frame_index,
                        "expected_sha256": frame.sha256,
                        "received_sha256": base_sha256,
                    },
                )
            if frame.repair_attempts >= 2:
                raise ConflictError("frame repair limit reached", details={"frame_index": frame_index, "limit": 2})
            if frame.review_status != ReviewStatus.repair_requested:
                raise ConflictError(
                    "frame must be explicitly marked repair_requested before replacement",
                    details={"frame_index": frame_index, "review_status": frame.review_status.value},
                )
            active_source = self.store.resolve_job_path(job_id, frame.active_path)
            if sha256_file(active_source) != frame.sha256:
                raise ConflictError(
                    "active frame changed outside the recorded job state",
                    details={"reason": "active_frame_integrity_mismatch", "frame_index": frame_index},
                )
            qa_issue_baseline = self._successful_qa_baseline(candidate)
            version = frame.repair_attempts + 1
            destination = (
                self.store.job_dir(job_id)
                / "repaired"
                / candidate.candidate_id
                / f"frame_{frame_index:03d}_v{version}.png"
            )
            destination.parent.mkdir(parents=True, exist_ok=True)
            from .processing import clean_rgba_file

            try:
                with Image.open(source_path) as replacement:
                    replacement.load()
                    if replacement.format != "PNG":
                        raise ValidationHarnessError("replacement frame must be PNG")
                    if "A" not in replacement.getbands() and "transparency" not in replacement.info:
                        raise ValidationHarnessError("replacement frame must retain source alpha")
            except ValidationHarnessError:
                raise
            except Exception as exc:
                raise ValidationHarnessError(
                    "replacement frame cannot be decoded",
                    details={"path": str(source_path), "error": str(exc)},
                ) from exc
            clean_meta = clean_rgba_file(source_path, destination)
            actual_size = (int(clean_meta["width"]), int(clean_meta["height"]))
            expected_size = (job.character.cell_width, job.character.cell_height)
            if actual_size != expected_size:
                destination.unlink(missing_ok=True)
                raise ValidationHarnessError(
                    "replacement frame has the wrong size",
                    details={"actual": list(actual_size), "expected": list(expected_size)},
                )
            frame.active_path = relative_posix(destination, self.store.job_dir(job_id))
            frame.sha256 = sha256_file(destination)
            frame.repair_attempts = version
            frame.review_status = ReviewStatus.pending
            frame.reviewed_by = None
            frame.reviewed_at = None
            frame.review_note = ""
            candidate.status = CandidateStatus.received
            candidate.hard_failures = []
            candidate.warnings = []
            candidate.error = None
            candidate.qa_completed_at = None
            candidate.qa_input_sha256 = None
            candidate.qa_algorithm_version = None
            candidate.qa_issue_baseline = qa_issue_baseline
            candidate.qa_change_summary = None
            for candidate_frame in candidate.frames:
                candidate_frame.hard_failures = []
                candidate_frame.warnings = []
            job.status = JobStatus.review_required
            job.touch("frame_replaced", candidate_index=candidate_index, frame_index=frame_index, repair_attempt=version)
        # The replacement is already durable at this point. Preserve and
        # return it even if preview generation or QA fails afterwards.
        try:
            return self.check_candidate(job_id, candidate_index)
        except Exception:
            return self.store.load(job_id)

    def export_candidate(
        self,
        job_id: str,
        candidate_index: int,
        options: ExportOptions | dict[str, Any] | None = None,
    ) -> JobRecord:
        if options is None:
            options = ExportOptions()
        elif not isinstance(options, ExportOptions):
            options = ExportOptions.model_validate(options)
        with self.store.locked_job(job_id) as job:
            candidate = self._candidate(job, candidate_index)
            self._assert_exportable(job_id, job, candidate)
            locked_columns = job.action.sheet_columns
            if locked_columns is not None and options.columns is not None and options.columns != locked_columns:
                raise ConflictError(
                    "export columns are locked by the selected project action",
                    details={"actual": options.columns, "expected": locked_columns},
                )
            columns = locked_columns or options.columns or job.character.sheet_columns
            _layout_columns, rows, frame_cells = self._candidate_sheet_layout(
                job,
                candidate,
                columns=columns,
            )
            export_dir = self.settings.exports_dir / job.character.character_id / job.action.action_id
            export_dir.mkdir(parents=True, exist_ok=True)
            stem = Path(options.filename).stem if options.filename else f"{job.character.character_id}_{job.action.action_id}"
            if job.request.open_plan and not options.filename:
                stem += f"_v{job.request.open_plan.revision}_candidate_{candidate_index:02d}"
            destinations = {
                "sheet": export_dir / f"{stem}.png",
                "preview": export_dir / f"{stem}.preview.gif",
                "recipe": export_dir / f"{stem}.recipe.json",
                "qa": export_dir / f"{stem}.qa.json",
                "godot": export_dir / f"{stem}.godot.zip",
            }
            existing = [str(path) for path in destinations.values() if path.exists()]
            if existing and not options.overwrite:
                raise ConflictError("export files already exist", details={"paths": existing, "hint": "pass overwrite=true explicitly"})

            staging = self.store.job_dir(job_id) / "export" / candidate.candidate_id
            staging.mkdir(parents=True, exist_ok=True)
            staged_sheet = staging / destinations["sheet"].name
            staged_preview = staging / destinations["preview"].name
            snapshot_dir = staging / ".verified_frames"
            if snapshot_dir.exists():
                shutil.rmtree(snapshot_dir)
            frame_paths = self._snapshot_verified_frames(job_id, job, candidate, snapshot_dir)
            from .processing import build_gif, build_sprite_sheet

            sheet_meta = build_sprite_sheet(
                frame_paths,
                staged_sheet,
                columns,
                rows=rows,
                frame_cells=frame_cells,
            )
            build_gif(frame_paths, staged_preview, job.action.fps, scale=1, loop=job.action.loop)
            recipe = {
                "schema_version": 1,
                "job_id": job.job_id,
                "candidate_index": candidate_index,
                "provider": candidate.provider_name,
                "provider_model": candidate.provider_model,
                "diagnostic_only": candidate.diagnostic_only,
                "character_id": job.character.character_id,
                **({"object_id": job.character.object_id, "object_type": job.character.object_type}
                   if not job.character._legacy_identity else {}),
                "action_id": job.action.action_id,
                "manifest_action_name": job.action.manifest_action_name,
                "cell_width": job.character.cell_width,
                "cell_height": job.character.cell_height,
                "columns": columns,
                "rows": sheet_meta["rows"],
                "sheet_width": sheet_meta["sheet_width"],
                "sheet_height": sheet_meta["sheet_height"],
                "frame_count": len(frame_paths),
                "frame_order": [frame.index for frame in candidate.frames],
                "frame_cells": sheet_meta["frame_cells"],
                "unused_cells": sheet_meta["unused_cells"],
                "source_region_px": [
                    [
                        int(column) * job.character.cell_width,
                        int(row) * job.character.cell_height,
                        job.character.cell_width,
                        job.character.cell_height,
                    ]
                    for column, row in sheet_meta["frame_cells"]
                ],
                "fps": job.action.fps,
                "runtime_fps": job.action.fps,
                "scene_fps": job.action.scene_fps or job.action.fps,
                "loop": job.action.loop,
                "critical_frame_indices": job.action.critical_frame_indices,
                "alpha": True,
                "qa_input_sha256": candidate.qa_input_sha256,
                "qa_algorithm_version": candidate.qa_algorithm_version,
                "source_frames": [
                    {"index": frame.index, "path": frame.active_path, "sha256": frame.sha256}
                    for frame in candidate.frames
                ],
                "sheet_sha256": sha256_file(staged_sheet),
            }
            qa_report = {
                "schema_version": 1,
                "job_id": job.job_id,
                "candidate_index": candidate_index,
                "diagnostic_only": candidate.diagnostic_only,
                "qa_completed_at": candidate.qa_completed_at.isoformat() if candidate.qa_completed_at else None,
                "qa_input_sha256": candidate.qa_input_sha256,
                "qa_algorithm_version": candidate.qa_algorithm_version,
                "hard_failures": [item.model_dump(mode="json") for item in candidate.hard_failures],
                "warnings": [item.model_dump(mode="json") for item in candidate.warnings],
                "frames": [
                    {
                        "index": frame.index,
                        "sha256": frame.sha256,
                        "review_status": frame.review_status.value,
                        "reviewed_by": frame.reviewed_by,
                        "reviewed_at": frame.reviewed_at.isoformat() if frame.reviewed_at else None,
                        "repair_attempts": frame.repair_attempts,
                        "manual_edit_versions": frame.manual_edit_versions,
                        "hard_failures": [item.model_dump(mode="json") for item in frame.hard_failures],
                        "warnings": [item.model_dump(mode="json") for item in frame.warnings],
                    }
                    for frame in candidate.frames
                ],
            }
            from .processing.godot_export import build_godot_package

            staged_godot = staging / destinations["godot"].name
            recipe["godot"] = build_godot_package(
                staged_sheet, staged_godot, recipe,
                anchor_x=job.character.anchor.x,
                ground_y=job.character.anchor.ground_y,
                facing=getattr(job.character, "facing", None),
            )
            staged_recipe = staging / destinations["recipe"].name
            staged_qa = staging / destinations["qa"].name
            atomic_write_json(staged_recipe, recipe)
            atomic_write_json(staged_qa, qa_report)
            # Recheck the immutable QA sources before publishing. The rendered
            # files above use only the verified snapshots, never live frames.
            self._assert_qa_current(job_id, job, candidate)
            # Recipe is the commit marker and is published last. If any copy
            # fails, restore the previous complete bundle (when present).
            self._publish_export_bundle(
                (
                    (staged_sheet, destinations["sheet"]),
                    (staged_preview, destinations["preview"]),
                    (staged_qa, destinations["qa"]),
                    (staged_godot, destinations["godot"]),
                    (staged_recipe, destinations["recipe"]),
                )
            )
            shutil.rmtree(snapshot_dir, ignore_errors=True)
            job.export = ExportRecord(
                exported_at=utc_now(),
                candidate_index=candidate_index,
                sheet_path=self.settings.record_path(destinations["sheet"]),
                preview_path=self.settings.record_path(destinations["preview"]),
                recipe_path=self.settings.record_path(destinations["recipe"]),
                qa_path=self.settings.record_path(destinations["qa"]),
                godot_package_path=self.settings.record_path(destinations["godot"]),
                godot_sha256=recipe["godot"]["package_sha256"],
                sha256=sha256_file(destinations["sheet"]),
            )
            job.status = JobStatus.exported
            job.touch("candidate_exported", candidate_index=candidate_index, columns=columns)
        return self.store.load(job_id)

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
                self._atomic_write_bytes(snapshot, payload)
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

    @staticmethod
    def _atomic_copy(source: Path, destination: Path) -> None:
        descriptor, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
        os.close(descriptor)
        try:
            shutil.copyfile(source, temp_name)
            os.replace(temp_name, destination)
        except Exception:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            raise

    def _publish_export_bundle(self, files: tuple[tuple[Path, Path], ...]) -> None:
        parent = files[0][1].parent
        backup_dir = Path(tempfile.mkdtemp(prefix=".export_backup.", dir=parent))
        backups: dict[Path, Path] = {}
        try:
            for _source, destination in files:
                if destination.is_file():
                    backup = backup_dir / destination.name
                    shutil.copyfile(destination, backup)
                    backups[destination] = backup
            try:
                for source, destination in files:
                    self._atomic_copy(source, destination)
            except Exception:
                for _source, destination in files:
                    backup = backups.get(destination)
                    if backup and backup.is_file():
                        self._atomic_copy(backup, destination)
                    elif destination.exists():
                        destination.unlink()
                raise
        finally:
            shutil.rmtree(backup_dir, ignore_errors=True)

    @staticmethod
    def _candidate(job: JobRecord, candidate_index: int) -> CandidateRecord:
        for candidate in job.candidates:
            if candidate.candidate_index == candidate_index:
                return candidate
        raise NotFoundError("candidate not found", details={"candidate_index": candidate_index})

    @staticmethod
    def _assert_candidate_editable(
        job: JobRecord,
        candidate: CandidateRecord,
        *,
        operation: str,
    ) -> None:
        from .motion_correction import active as motion_active
        if motion_active(job) and operation not in {"motion reservation", "motion adoption"}:
            raise ConflictError("视觉检查正在进行，请等待完成再修改")
        if candidate.status in {
            CandidateStatus.approved,
            CandidateStatus.rejected,
            CandidateStatus.failed,
        }:
            raise ConflictError(
                "terminal candidate cannot be changed",
                details={
                    "reason": "terminal_candidate",
                    "operation": operation,
                    "candidate_index": candidate.candidate_index,
                    "candidate_status": candidate.status.value,
                },
            )
        if job.export and job.export.candidate_index == candidate.candidate_index:
            raise ConflictError(
                "exported candidate cannot be changed",
                details={
                    "reason": "exported_candidate_immutable",
                    "operation": operation,
                    "candidate_index": candidate.candidate_index,
                },
            )

    @staticmethod
    def _candidate_expected_frame_count(job: JobRecord, candidate: CandidateRecord) -> int:
        """Check the usable sequence that was actually received."""

        return len(candidate.frames)

    @staticmethod
    def _candidate_sheet_layout(
        job: JobRecord,
        candidate: CandidateRecord,
        *,
        columns: int | None = None,
    ) -> tuple[int, int | None, list[tuple[int, int]] | None]:
        """Keep the project grid when possible and pad variable results safely."""

        columns = columns or job.action.sheet_columns or job.character.sheet_columns
        if len(candidate.frames) == job.action.frame_count:
            return columns, job.action.sheet_rows, job.action.frame_cells or None

        required_rows = math.ceil(len(candidate.frames) / columns)
        rows = max(job.action.sheet_rows or 0, required_rows)
        return columns, rows, None

    @staticmethod
    def _frame(candidate: CandidateRecord, frame_index: int) -> FrameRecord:
        for frame in candidate.frames:
            if frame.index == frame_index:
                return frame
        raise NotFoundError("frame not found", details={"frame_index": frame_index})

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
        expected_frame_count = self._candidate_expected_frame_count(job, candidate)
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

    def _assert_exportable(self, job_id: str, job: JobRecord, candidate: CandidateRecord) -> None:
        from .motion_correction import active as motion_active
        if motion_active(job) or job.request.motion_repair is not None:
            raise ExportBlockedError("请等待自动检查完成，或回到逐帧修补采用结果")
        if job.request.attack_segment is not None:
            raise ExportBlockedError("攻击片段不能单独导出，请回到方案合成完整动画")
        if candidate.status != CandidateStatus.approved:
            raise ExportBlockedError("candidate is not approved", details={"status": candidate.status.value})
        self._assert_qa_current(job_id, job, candidate)
        if candidate.hard_failures or not candidate.frames:
            raise ExportBlockedError("candidate has hard failures or no frames")
        unapproved = [frame.index for frame in candidate.frames if frame.review_status != ReviewStatus.approved]
        if unapproved:
            raise ExportBlockedError("all frames must be approved", details={"unapproved_frames": unapproved})

    def _refresh_approval(self, job: JobRecord, candidate: CandidateRecord) -> None:
        if candidate.frames and not candidate.hard_failures and not candidate.warnings and all(
            frame.review_status == ReviewStatus.approved and not frame.hard_failures for frame in candidate.frames
        ):
            candidate.status = CandidateStatus.approved
            self._refresh_job_status(job)
        elif any(frame.review_status == ReviewStatus.rejected for frame in candidate.frames):
            candidate.status = CandidateStatus.rejected
            self._refresh_job_status(job)
        elif candidate.hard_failures:
            candidate.status = CandidateStatus.check_failed
            self._refresh_job_status(job)
        else:
            candidate.status = CandidateStatus.review_ready
            self._refresh_job_status(job)

    @staticmethod
    def _refresh_job_status(job: JobRecord) -> None:
        statuses = {candidate.status for candidate in job.candidates}
        def rejected_before_submit(candidate):
            error = candidate.error or {}
            details = error.get('details') or {}
            return error.get('code') == 'insufficient_quota' or details.get('submission_rejected') or details.get('submission_created') is False

        blocked_before_submit = any(rejected_before_submit(c) for c in job.candidates)
        no_art_or_receipt = all(
            not (c.frames or c.provider_job_id or c.submitted_at or any(
                isinstance(c.usage.get(unit), (int, float)) and c.usage[unit] > 0 for unit in ('usd', 'generations')
            )) and
            (c.status == CandidateStatus.created or (c.status == CandidateStatus.failed and rejected_before_submit(c)))
            for c in job.candidates
        )
        if job.export is not None:
            job.status = JobStatus.exported
        elif CandidateStatus.approved in statuses:
            job.status = JobStatus.approved
        elif CandidateStatus.submission_unknown in statuses:
            job.status = JobStatus.attention_required
        elif CandidateStatus.submitting in statuses:
            job.status = JobStatus.submitting
        elif CandidateStatus.saving in statuses:
            job.status = JobStatus.saving
        elif CandidateStatus.provider_pending in statuses:
            job.status = JobStatus.provider_pending
        elif blocked_before_submit and no_art_or_receipt:
            job.status = JobStatus.not_submitted
        elif any(c.status == CandidateStatus.created and (c.error or {}).get('code') == AccountSlotBusy.code for c in job.candidates):
            job.status = JobStatus.queued
        elif blocked_before_submit:
            job.status = JobStatus.attention_required
        elif all(candidate.status in (CandidateStatus.rejected, CandidateStatus.failed) for candidate in job.candidates):
            job.status = JobStatus.failed
        elif statuses & {
            CandidateStatus.received,
            CandidateStatus.check_failed,
            CandidateStatus.review_ready,
            CandidateStatus.rejected,
        }:
            job.status = JobStatus.review_required
        elif CandidateStatus.created in statuses:
            job.status = JobStatus.created
        else:
            job.status = JobStatus.review_required
