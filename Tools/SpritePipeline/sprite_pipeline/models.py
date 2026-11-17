from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator
from .collaboration.contracts import PlanBinding, PlanControl, PlanExecution
from .object_identity import ObjectIdentity


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class Anchor(StrictModel):
    x: int = Field(ge=0)
    ground_y: int = Field(ge=0)


class QAThresholds(StrictModel):
    """Per-character QA policy; values live in the preset, not processing code."""

    duplicate_run_length: int = Field(default=3, ge=2, le=16)
    area_change_ratio: float = Field(default=0.35, ge=0, le=5)
    centroid_shift_px: float = Field(default=20.0, ge=0)
    palette_mismatch_ratio: float = Field(default=0.35, ge=0, le=1)
    palette_distance: float = Field(default=48.0, ge=0, le=442)
    loop_difference_ratio: float = Field(default=0.35, ge=0, le=1)
    ground_y_tolerance_px: int = Field(default=4, ge=0)
    rigid_translation_tolerance_px: int = Field(default=6, ge=0, le=32)
    alpha_visible_threshold: int = Field(default=1, ge=1, le=255)


class ObjectPresetBase(ObjectIdentity, StrictModel):
    schema_version: Literal[1] = 1
    display_name: str = Field(min_length=1, max_length=200)
    cell_width: int
    cell_height: int
    reference_frame: str = Field(min_length=1, max_length=260)
    master: str | None = Field(default=None, max_length=260)
    palette: str | None = Field(default=None, max_length=260)
    silhouette: str | None = Field(default=None, max_length=260)
    identity_description: str = Field(default="", max_length=1000)
    anchor: Anchor
    safe_margin: int = Field(default=4, ge=0)
    sheet_columns: int = Field(default=8, ge=1, le=64)
    transparent_background: bool = True
    qa: QAThresholds = Field(default_factory=QAThresholds)

    @field_validator("object_id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not value or not all(ch.islower() or ch.isdigit() or ch == "_" for ch in value):
            raise ValueError("character_id must contain only lowercase letters, digits, and underscores")
        return value

    @model_validator(mode="after")
    def validate_cell(self) -> "ObjectPresetBase":
        if self.cell_width != self.cell_height or self.cell_width not in (64, 128):
            raise ValueError("cell size must be exactly 64x64 or 128x128")
        if self.anchor.x >= self.cell_width or self.anchor.ground_y >= self.cell_height:
            raise ValueError("anchor must be inside the frame")
        if self.safe_margin * 2 >= self.cell_width:
            raise ValueError("safe_margin leaves no usable canvas")
        return self


class CharacterPreset(ObjectPresetBase):
    object_type: Literal["character"] = "character"
    facing: Literal["left", "right"] = "right"
    weapon_hand: Literal["reference", "left", "right", "both"] = "reference"


class InteractablePreset(ObjectPresetBase):
    object_type: Literal["interactable"] = "interactable"

    @model_validator(mode="after")
    def validate_interactable_canvas(self):
        if self.cell_width != 128:
            raise ValueError("interactable references must use a 128x128 canvas")
        return self


ObjectPreset = CharacterPreset | InteractablePreset
_OBJECT_PRESET_ADAPTER = TypeAdapter(ObjectPreset)


def validate_object_preset(data) -> ObjectPreset:
    return _OBJECT_PRESET_ADAPTER.validate_python(data)


class ActionPreset(StrictModel):
    schema_version: Literal[1] = 1
    generation_strategy: Literal["single", "two_stage_attack", "three_stage_attack", "reference_anchored_attack"] = "single"
    action_id: str
    display_name: str | None = Field(default=None, max_length=200)
    # Project playback frame count. This can be odd even when a model provider
    # only accepts an even source count (see provider_frame_count below).
    frame_count: int = Field(ge=1, le=64)
    provider_frame_count: int | None = Field(default=None, ge=4, le=16)
    provider_frame_selection: list[int] = Field(default_factory=list, max_length=64)
    fps: float = Field(default=12, gt=0, le=60)
    scene_fps: float | None = Field(default=None, gt=0, le=60)
    loop: bool = False
    grounded: bool = True
    manifest_action_name: str | None = Field(default=None, max_length=100)
    sheet_columns: int | None = Field(default=None, ge=1, le=64)
    sheet_rows: int | None = Field(default=None, ge=1, le=64)
    sheet_frame_cells: list[tuple[int, int]] = Field(default_factory=list, max_length=64)
    critical_frame_indices: list[int] = Field(default_factory=list, max_length=16)
    centroid_shift_px: float | None = Field(default=None, ge=0)
    action_description: str = Field(min_length=8, max_length=1000)
    locked_constraints: list[str] = Field(default_factory=list, max_length=32)
    loop_constraint: str | None = Field(default=None, max_length=500)

    @field_validator("action_id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not value or not all(ch.islower() or ch.isdigit() or ch == "_" for ch in value):
            raise ValueError("action_id must contain only lowercase letters, digits, and underscores")
        return value

    @field_validator("provider_frame_count")
    @classmethod
    def validate_provider_frame_count(cls, value: int | None) -> int | None:
        if value is not None and value % 2:
            raise ValueError("provider_frame_count must be even")
        return value

    @model_validator(mode="after")
    def validate_contract(self) -> "ActionPreset":
        if self.loop and not self.loop_constraint:
            raise ValueError("looping actions require loop_constraint")
        provider_count = self.provider_frame_count or self.frame_count
        if self.provider_frame_selection:
            if len(self.provider_frame_selection) != self.frame_count:
                raise ValueError("provider_frame_selection must contain one source index per project frame")
            if len(set(self.provider_frame_selection)) != len(self.provider_frame_selection):
                raise ValueError("provider_frame_selection indices must be unique")
            if any(index < 0 or index >= provider_count for index in self.provider_frame_selection):
                raise ValueError("provider_frame_selection index is outside provider_frame_count")
        elif provider_count != self.frame_count:
            raise ValueError("provider_frame_selection is required when provider and project frame counts differ")

        has_sheet_shape = self.sheet_columns is not None or self.sheet_rows is not None
        if has_sheet_shape and (self.sheet_columns is None or self.sheet_rows is None):
            raise ValueError("sheet_columns and sheet_rows must be provided together")
        if self.sheet_frame_cells:
            if not has_sheet_shape:
                raise ValueError("sheet_frame_cells requires sheet_columns and sheet_rows")
            if len(self.sheet_frame_cells) != self.frame_count:
                raise ValueError("sheet_frame_cells must contain one cell per project frame")
            if len(set(self.sheet_frame_cells)) != len(self.sheet_frame_cells):
                raise ValueError("sheet_frame_cells must be unique")
            assert self.sheet_columns is not None and self.sheet_rows is not None
            if any(
                column < 0 or row < 0 or column >= self.sheet_columns or row >= self.sheet_rows
                for column, row in self.sheet_frame_cells
            ):
                raise ValueError("sheet_frame_cells contains a cell outside the sheet")
        elif has_sheet_shape:
            assert self.sheet_columns is not None and self.sheet_rows is not None
            if self.frame_count > self.sheet_columns * self.sheet_rows:
                raise ValueError("sheet shape does not contain enough cells for frame_count")

        if len(set(self.critical_frame_indices)) != len(self.critical_frame_indices):
            raise ValueError("critical_frame_indices must be unique")
        if any(index < 0 or index >= self.frame_count for index in self.critical_frame_indices):
            raise ValueError("critical_frame_indices contains an invalid project frame")
        return self

    @property
    def generation_frame_count(self) -> int:
        return self.provider_frame_count or self.frame_count

    @property
    def generation_frame_selection(self) -> list[int]:
        return self.provider_frame_selection or list(range(self.frame_count))

    @property
    def frame_cells(self) -> list[tuple[int, int]]:
        if self.sheet_frame_cells:
            return list(self.sheet_frame_cells)
        if self.sheet_columns is None:
            return []
        return [
            (index % self.sheet_columns, index // self.sheet_columns)
            for index in range(self.frame_count)
        ]


class AttackSegmentBinding(StrictModel):
    plan_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    segment_index: int = Field(ge=0, le=4)
    attempt: int = Field(ge=1, le=2)


class MotionRepairBinding(StrictModel):
    parent_job_id: str = Field(min_length=1, max_length=200)
    attempt_id: str = Field(pattern=r"^[0-9a-f]{32}$")


class GenerationRequest(ObjectIdentity, StrictModel):
    schema_version: Literal[1] = 1
    action_id: str
    open_plan: PlanBinding | None = None
    attack_segment: AttackSegmentBinding | None = None
    motion_repair: MotionRepairBinding | None = None
    provider: Literal["pixellab", "fixture", "import"] = "pixellab"
    candidate_count: int = Field(default=1, ge=1, le=8)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    frame_count: int | None = Field(default=None, ge=1, le=64)
    action_description: str | None = Field(default=None, max_length=1000)
    loop: bool | None = None
    request_key: str | None = Field(
        default=None,
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )

    @model_validator(mode="after")
    def validate_open_plan(self):
        if self.open_plan is not None:
            spec = self.open_plan.spec
            if (self.action_id != "motion_" + self.open_plan.work_id[:12]
                    or self.object_id != spec.object_id or self.object_type != spec.object_type
                    or self.provider != spec.provider
                    or self.candidate_count != spec.candidate_count or self.seed != spec.seed
                    or self.frame_count is not None or self.action_description is not None
                    or self.loop is not None or self.attack_segment or self.motion_repair):
                raise ValueError("Open-plan requests must match the frozen task without preset overrides")
        return self

class IssueSeverity(str, Enum):
    hard_failure = "hard_failure"
    warning = "warning"


class QAIssue(StrictModel):
    code: str
    severity: IssueSeverity
    message: str
    frame_index: int | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)


class QAIssueBaseline(StrictModel):
    """Last successful QA snapshot retained while a repaired frame is rechecked."""

    qa_input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    qa_algorithm_version: str | None = None
    qa_completed_at: datetime
    issues: list[QAIssue] = Field(default_factory=list)


class QAChangeSummary(StrictModel):
    """Stable issue-level delta between the pre-repair and post-repair QA runs."""

    compared_at: datetime
    baseline_qa_input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    current_qa_input_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    baseline_qa_algorithm_version: str | None = None
    current_qa_algorithm_version: str
    resolved: list[QAIssue] = Field(default_factory=list)
    new: list[QAIssue] = Field(default_factory=list)
    persisting: list[QAIssue] = Field(default_factory=list)


class ReviewStatus(str, Enum):
    pending = "pending"
    approved = "approved"
    repair_requested = "repair_requested"
    rejected = "rejected"


class IssueType(str, Enum):
    identity_drift = "identity_drift"
    clothing_error = "clothing_error"
    weapon_error = "weapon_error"
    limb_error = "limb_error"
    pose_error = "pose_error"
    alpha_background_error = "alpha_background_error"
    scale_baseline_error = "scale_baseline_error"
    other = "other"


class FrameRecord(StrictModel):
    index: int = Field(ge=0)
    raw_path: str
    active_path: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    hard_failures: list[QAIssue] = Field(default_factory=list)
    warnings: list[QAIssue] = Field(default_factory=list)
    review_status: ReviewStatus = ReviewStatus.pending
    issue_type: IssueType | None = None
    review_note: str = ""
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    repair_attempts: int = Field(default=0, ge=0, le=2)
    # Manual pixel-editor saves are lossless local versions and do not consume
    # provider credits. Keep their counter separate from the deliberately
    # bounded external/AI replacement attempts above.
    manual_edit_versions: int = Field(default=0, ge=0)
    motion_tags: list[dict[str, Any]] = Field(default_factory=list)


class CandidateStatus(str, Enum):
    created = "created"
    submitting = "submitting"
    submission_unknown = "submission_unknown"
    provider_pending = "provider_pending"
    saving = "saving"
    received = "received"
    check_failed = "check_failed"
    review_ready = "review_ready"
    approved = "approved"
    rejected = "rejected"
    failed = "failed"


class CandidateRecord(StrictModel):
    candidate_index: int = Field(ge=1)
    candidate_id: str = Field(pattern=r"^candidate_[0-9]{2}$")
    seed: int | None = None
    status: CandidateStatus = CandidateStatus.created
    provider_name: str | None = None
    provider_model: str | None = None
    diagnostic_only: bool = False
    provider_job_id: str | None = None
    provider_status: str | None = None
    submission_started_at: datetime | None = None
    submitted_at: datetime | None = None
    last_polled_at: datetime | None = None
    provider_completed_at: datetime | None = None
    result_saved_at: datetime | None = None
    submission_attempts: int = Field(default=0, ge=0, le=32)
    raw_request_path: str | None = None
    raw_response_path: str | None = None
    result_manifest_path: str | None = None
    result_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    frames: list[FrameRecord] = Field(default_factory=list)
    hard_failures: list[QAIssue] = Field(default_factory=list)
    warnings: list[QAIssue] = Field(default_factory=list)
    qa_completed_at: datetime | None = None
    qa_input_sha256: str | None = None
    qa_algorithm_version: str | None = None
    motion_review: dict[str, Any] | None = None
    attack_sequence: dict[str, Any] | None = None
    plan_execution: PlanExecution | None = None
    # Defaults keep job.json files written by earlier harness versions readable.
    qa_issue_baseline: QAIssueBaseline | None = None
    qa_change_summary: QAChangeSummary | None = None
    usage: dict[str, Any] = Field(default_factory=dict)
    error: dict[str, Any] | None = None


class JobStatus(str, Enum):
    created = "created"
    queued = "queued"
    not_submitted = "not_submitted"
    submitting = "submitting"
    provider_pending = "provider_pending"
    saving = "saving"
    attention_required = "attention_required"
    review_required = "review_required"
    approved = "approved"
    exported = "exported"
    failed = "failed"


class ExportRecord(StrictModel):
    exported_at: datetime
    candidate_index: int
    sheet_path: str
    preview_path: str
    recipe_path: str
    qa_path: str
    godot_package_path: str | None = None
    godot_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class JobRecord(StrictModel):
    schema_version: Literal[1] = 1
    harness_version: str = "0.1.0"
    revision: int = Field(default=0, ge=0)
    job_id: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    status: JobStatus = JobStatus.created
    request: GenerationRequest
    request_fingerprint: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    generation_requested_at: datetime | None = None
    queued_candidate_index: int | None = Field(default=None, ge=1)
    generation_account: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    quota_before: dict[str, Any] | None = None
    quota_after: dict[str, Any] | None = None
    character: ObjectPreset
    action: ActionPreset
    character_preset_path: str
    action_preset_path: str
    reference_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    input_sha256: dict[str, str] = Field(default_factory=dict)
    full_prompt: str
    candidates: list[CandidateRecord]
    motion_control: dict[str, Any] | None = None
    plan_control: PlanControl | None = None
    export: ExportRecord | None = None
    events: list[dict[str, Any]] = Field(default_factory=list)

    def touch(self, event: str | None = None, **data: Any) -> None:
        self.updated_at = utc_now()
        if event:
            self.events.append({"at": self.updated_at.isoformat(), "event": event, **data})

    @model_validator(mode="after")
    def validate_indices(self) -> "JobRecord":
        for filename, digest in self.input_sha256.items():
            if not filename or Path(filename).name != filename:
                raise ValueError("input_sha256 keys must be plain filenames")
            if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
                raise ValueError("input_sha256 values must be lowercase SHA-256 digests")
        candidate_indices = [candidate.candidate_index for candidate in self.candidates]
        if candidate_indices != list(range(1, len(self.candidates) + 1)):
            raise ValueError("candidate indices must be unique and contiguous from 1")
        for candidate in self.candidates:
            frame_indices = [frame.index for frame in candidate.frames]
            if frame_indices != list(range(len(frame_indices))):
                raise ValueError(f"{candidate.candidate_id} frame indices must be unique and contiguous from 0")
        return self


class FrameReviewRequest(StrictModel):
    frame_index: int = Field(ge=0)
    status: ReviewStatus
    issue_type: IssueType | None = None
    note: str = Field(default="", max_length=2000)
    reviewer: str = Field(default="operator", min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_issue(self) -> "FrameReviewRequest":
        if self.status == ReviewStatus.repair_requested and self.issue_type is None:
            raise ValueError("repair_requested requires issue_type")
        return self


class ExportOptions(StrictModel):
    columns: int | None = Field(default=None, ge=1, le=64)
    overwrite: bool = False
    filename: str | None = Field(default=None, min_length=5, max_length=200)

    @field_validator("filename")
    @classmethod
    def validate_filename(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if cleaned != value:
            raise ValueError("filename cannot begin or end with whitespace")
        if Path(cleaned).name != cleaned or not cleaned.casefold().endswith(".png"):
            raise ValueError("filename must be a plain .png filename")
        if any(ord(character) < 32 or ord(character) == 127 for character in cleaned):
            raise ValueError("filename cannot contain control characters")
        if any(character in '<>:"/\\|?*' for character in cleaned):
            raise ValueError("filename contains characters that are invalid on Windows")
        device_name = cleaned.split(".", 1)[0].casefold()
        reserved_names = {"con", "prn", "aux", "nul"}
        reserved_names.update(f"com{index}" for index in range(1, 10))
        reserved_names.update(f"lpt{index}" for index in range(1, 10))
        if device_name in reserved_names:
            raise ValueError("filename uses a reserved Windows device name")
        return cleaned


class CommandResult(StrictModel):
    schema_version: Literal[1] = 1
    ok: bool = True
    operation: str
    data: dict[str, Any] = Field(default_factory=dict)
