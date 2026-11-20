from __future__ import annotations

import os
import secrets
import shutil
import tempfile
import base64
import binascii
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

from PIL import Image

from .errors import (
    ConflictError,
    ExportBlockedError,
    HarnessError,
    NotFoundError,
    ValidationHarnessError,
)
from .jsonio import atomic_write_json, read_json, relative_posix, sha256_file
from .candidate_artifacts import CandidateArtifacts, QA_ALGORITHM_VERSION
from .credential_store import CredentialStore
from .job_execution import NativeJobExecution
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
from .providers.account import AccountSlotBusy
from .settings import HarnessSettings
from .store import JobStore


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
        self._execution = NativeJobExecution(self)
        self._artifacts = CandidateArtifacts(self)

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
            # Once the initial journal is committed, a failure publishing the
            # current pointer must leave the native request available by key.
            if not (job_dir / 'history' / 'job_00000000.json').is_file():
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

        return self._execution.generate_job(job_id, wait=wait, candidate_index=candidate_index)

    def _check_submission_quota(
        self,
        job_id: str,
        candidate_index: int,
        provider: Any,
        *, phase_frame_count: int | None = None,
    ) -> None:
        return self._execution._check_submission_quota(
            job_id,
            candidate_index,
            provider,
            phase_frame_count=phase_frame_count,
        )

    @staticmethod
    def _same_generation_account(job, provider):
        return not job.generation_account or job.generation_account == getattr(provider, 'account_fingerprint', None)

    def _queue_candidate(self, job_id, index, error, provider, *, stage=None, selected_index=None):
        return self._execution._queue_candidate(
            job_id,
            index,
            error,
            provider,
            stage=stage,
            selected_index=selected_index,
        )

    def _recover_submission_receipt(self, job, candidate, *, stage=None):
        return self._execution._recover_submission_receipt(job, candidate, stage=stage)

    def recover_completed_candidate(
        self,
        job_id: str,
        candidate_index: int,
    ) -> JobRecord:
        """Poll an existing PixelLab job again without submitting a new generation."""

        return self._execution.recover_completed_candidate(job_id, candidate_index)

    def _poll_candidate(self, job_id: str, candidate_index: int, provider: Any, *, wait: bool) -> None:
        return self._execution._poll_candidate(job_id, candidate_index, provider, wait=wait)

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
        return self._artifacts._store_provider_frames(
            job_id,
            candidate_index,
            images,
            diagnostic_only=diagnostic_only,
            expected_provider_job_id=expected_provider_job_id,
        )

    def reconcile_saved_results(self, job_id: str) -> JobRecord:
        """Adopt a fully written raw result that predates its job.json update."""

        return self._artifacts.reconcile_saved_results(job_id)

    def attach_provider_job_id(
        self,
        job_id: str,
        candidate_index: int,
        provider_job_id: str,
    ) -> JobRecord:
        """Attach a known remote ID after an ambiguous POST; never submit."""

        return self._execution.attach_provider_job_id(job_id, candidate_index, provider_job_id)

    def recover_pending_jobs(self) -> dict[str, Any]:
        """Advance every durable live generation using only safe operations."""

        return self._execution.recover_pending_jobs()

    def _committed_result_integrity(
        self,
        job_id: str,
        candidate: CandidateRecord,
    ) -> bool:
        return self._artifacts._committed_result_integrity(job_id, candidate)

    def _assert_committed_result_integrity(
        self,
        job_id: str,
        job: JobRecord,
        candidate: CandidateRecord,
        *,
        error_class: type[HarnessError],
    ) -> None:
        return self._artifacts._assert_committed_result_integrity(job_id, job, candidate, error_class=error_class)

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
                from .collaboration.visual_review import frame_digest
                if frame_digest(candidate) != expected_frames:
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
        return job

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

            staging = self.store.job_dir(job_id) / "export" / candidate.candidate_id / f"v{job.revision + 1}"
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
                preview_sha256=sha256_file(staged_preview),
                immutable_artifacts={
                    kind: relative_posix(staging / destination.name, self.store.job_dir(job_id))
                    for kind, destination in destinations.items()
                },
                sha256=sha256_file(destinations["sheet"]),
            )
            job.status = JobStatus.exported
            job.touch("candidate_exported", candidate_index=candidate_index, columns=columns)
        return job

    def _snapshot_verified_frames(
        self,
        job_id: str,
        job: JobRecord,
        candidate: CandidateRecord,
        destination: Path,
    ) -> list[Path]:
        return self._artifacts._snapshot_verified_frames(job_id, job, candidate, destination)

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
        return self._artifacts._verified_frame_digest(
            job_id,
            job,
            candidate,
            error_class=error_class,
            require_png_contract=require_png_contract,
            require_expected_indices=require_expected_indices,
        )

    def _assert_qa_current(self, job_id: str, job: JobRecord, candidate: CandidateRecord) -> None:
        return self._artifacts._assert_qa_current(job_id, job, candidate)

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
