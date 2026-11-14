"""Versioned contracts for task-specific plans, not a new action preset catalog."""
from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from pydantic import ValidationInfo, BaseModel, ConfigDict, Field, model_validator, model_serializer

from ..object_identity import ObjectIdentity


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class Budget(Contract):
    max_frames_per_request: int | None = Field(default=None, ge=4, le=16)
    max_total_frames: int | None = Field(default=None, ge=4, le=512)

    max_planning_calls: int = Field(default=8, ge=4, le=16)
    max_generation_calls: int = Field(default=4, ge=1, le=32)
    max_review_calls: int = Field(default=10, ge=2, le=200)

    @model_serializer(mode='wrap')
    def preserve_budget_hash(self, handler):
        return {key: value for key, value in handler(self).items() if value is not None}


class VisualStructureSelection(Contract):
    analysis_id: str = Field(pattern=r'^[0-9a-f]{32}$')
    token: str = Field(pattern=r'^[0-9a-f]{64}$')


class TaskSpec(ObjectIdentity, Contract):
    object_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_]*$", max_length=100)
    description: str = Field(min_length=4, max_length=2000)
    ending: str = Field(default="", max_length=300)
    return_to_reference: bool = False
    loop: bool = False
    fps: float = Field(default=12, gt=0, le=60)
    timing_mode: Literal['auto', 'fixed'] = 'auto'
    candidate_count: int = Field(default=1, ge=1, le=8)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    budget: Budget = Field(default_factory=Budget)
    provider: Literal["pixellab", "fixture"] = "pixellab"
    # Missing on historical records: preserve their hash and two-call behavior.
    review_protocol: Literal['baseline', 'experts_v1'] | None = None
    visual_structure: VisualStructureSelection | None = None

    @model_serializer(mode='wrap')
    def preserve_legacy_spec(self, handler):
        data = handler(self)
        if self.review_protocol is None:
            data.pop('review_protocol', None)
        if self.visual_structure is None:data.pop('visual_structure',None)
        return self.preserve_identity_shape(data)


def review_calls_per_check(spec):
    return 5 if spec.review_protocol == 'experts_v1' else 2


def default_new_review(spec):
    """Only for a NEW request after idempotency lookup; never for loading jobs."""
    value = spec.model_copy(deep=True)
    if value.review_protocol is None:
        # Older clients supplied a two-pass budget without a protocol field.
        # Do not silently reinterpret that already bounded request.
        value.review_protocol = 'baseline' if 'max_review_calls' in spec.budget.model_fields_set else 'experts_v1'
    if value.review_protocol == 'experts_v1' and 'max_review_calls' not in spec.budget.model_fields_set:
        value.budget.max_review_calls = 25 * value.candidate_count
    return value


class Requirement(Contract):
    text: str = Field(min_length=1, max_length=300)
    source: Literal["user", "reference", "expert"]
    evidence: str = Field(min_length=1, max_length=300)


CHARACTER_DIMENSIONS = ('completeness', 'equipment', 'rhythm')
PROP_DIMENSIONS = ('state_frame', 'transition', 'fixed_parts')
QualityDimension = Literal['completeness', 'equipment', 'rhythm', 'state_frame', 'transition', 'fixed_parts']


class PremiseCheck(Contract):
    status: Literal['satisfied', 'mismatch', 'ambiguous']
    evidence: str = Field(min_length=4, max_length=300)


class ReferencePremises(Contract):
    viewpoint: PremiseCheck
    initial_state: PremiseCheck
    part_ownership: PremiseCheck

    def blockers(self):
        labels = {'viewpoint': '视角', 'initial_state': '初态', 'part_ownership': '部件归属'}
        return [f'{labels[key]}：{check.evidence}' for key, check in self if check.status != 'satisfied']


class OpaqueRegion(Contract):
    name: str = Field(min_length=1, max_length=80)
    # Native coordinates on a 128px prop, right/bottom exclusive.
    box: list[int] = Field(min_length=4, max_length=4)

    @model_validator(mode='after')
    def within_reference(self):
        left, top, right, bottom = self.box
        if not (0 <= left < right <= 128 and 0 <= top < bottom <= 128):
            raise ValueError('Opaque monitoring region must be within the 128px reference')
        return self


class ReferenceDifference(Contract):
    description: str = Field(min_length=1, max_length=300)
    observed: str = Field(min_length=1, max_length=300)
    impact: Literal['impedes_motion', 'changes_fixed_parts', 'appearance_only']
    handling: Literal['use_reference', 'needs_decision']


class HingeMeasurement(Contract):
    pivot_anchor_id: str
    endpoint_part_id: str


class InteractableMotion(Contract):
    differences: list[ReferenceDifference] = Field(default_factory=list, max_length=24)
    hinge: HingeMeasurement | None = None

    @model_serializer(mode='wrap')
    def preserve_recorded_contract(self, handler):
        data = handler(self)
        if not self.differences:
            data.pop('differences', None)
        if self.hinge is None:
            data.pop('hinge', None)
        return data

    def blockers(self):
        return self.reference_check.blockers() + [
            f'{item.description} → {item.observed}' for item in self.differences
            if item.impact != 'appearance_only' or item.handling == 'needs_decision'
        ]

    initial_state: str = Field(min_length=1, max_length=300)
    target_state: str = Field(min_length=1, max_length=300)
    moving_parts: list[str] = Field(min_length=1, max_length=24)
    fixed_parts: list[str] = Field(max_length=24)
    motion_type: Literal['appearance_change', 'hinge_rotation', 'deformation', 'occluded_rigid_translation']
    endpoint: str = Field(min_length=1, max_length=300)
    hold: str = Field(min_length=1, max_length=300)
    hold_frames: int = Field(default=0, ge=0, le=63, description="Additional playback ticks repeating the confirmed final frame")
    reference_check: ReferencePremises
    opaque_regions: list[OpaqueRegion] = Field(default_factory=list, max_length=24)


class QualityCriterion(Contract):
    dimension: QualityDimension
    criterion: str = Field(min_length=4, max_length=400)


class KeyPose(Contract):
    frame: int = Field(ge=1, le=64)
    description: str = Field(min_length=4, max_length=120)


class MotionQuality(Contract):
    """Intent and observable invariants, independent of action names/presets."""
    version: Literal[2, 3, 4] = 2
    event_contract: str = Field(min_length=4, max_length=180)
    appearance_contract: str = Field(min_length=4, max_length=180)
    ending_contract: str = Field(min_length=4, max_length=180)
    rhythm_contract: str = Field(min_length=4, max_length=180)
    playback_fps: float = Field(gt=0, le=60)
    interactable: InteractableMotion | None = None
    criteria: list[QualityCriterion] = Field(min_length=3, max_length=3)
    key_poses: list[KeyPose] = Field(default_factory=list, max_length=6)

    @model_serializer(mode='wrap')
    def preserve_earlier_quality_hash(self, handler):
        data=handler(self)
        if self.interactable is None: data.pop('interactable', None)
        if not self.key_poses:data.pop('key_poses',None)
        return data

    @model_validator(mode='after')
    def dimensions(self):
        expected = PROP_DIMENSIONS if self.interactable else CHARACTER_DIMENSIONS
        if {c.dimension for c in self.criteria} != set(expected):
            raise ValueError(f'Quality criteria must cover {expected} exactly once')
        return self


class PoseCheckpoint(Contract):
    endpoint: str = Field(min_length=4, max_length=120)
    rhythm: str = Field(min_length=4, max_length=140)
    reason: str = Field(min_length=4, max_length=180)


class PlannedHold(Contract):
    start: int = Field(ge=1,le=16)
    end: int = Field(ge=1,le=16)
    reason: str = Field(min_length=4,max_length=100)


class MotionConstraints(Contract):
    """Task-specific visible relations, not a skeleton or action-name ruleset."""
    camera: str = Field(min_length=4,max_length=80)
    orientation: str = Field(min_length=4,max_length=100)
    trajectory: str = Field(min_length=4,max_length=100)
    support: str = Field(min_length=4,max_length=120)
    drive: str = Field(min_length=4,max_length=140)
    appearance: str = Field(min_length=4,max_length=180)
    entry: str = Field(min_length=4,max_length=100)
    exit: str = Field(min_length=4,max_length=100)
    boundary: Literal['pass_through','settle','intentional_hold']
    holds: list[PlannedHold] = Field(default_factory=list,max_length=3)
    generation_hint: str = Field(min_length=4,max_length=140)


class StructureUsage(Contract):
    part_ids: list[str] = Field(min_length=1,max_length=12)
    anchor_ids: list[str] = Field(default_factory=list,max_length=12)
    relation_ids: list[str] = Field(default_factory=list,max_length=12)
    effect: str = Field(min_length=4,max_length=240)


class PlanStage(Contract):
    name: str = Field(min_length=1, max_length=80)
    goal: str = Field(min_length=1, max_length=500)
    prompt: str = Field(min_length=8, max_length=1000)
    frame_count: int = Field(ge=4, le=16)
    first_frame: Literal["original", "previous_end"]
    last_frame: Literal["none", "original"] = "none"
    acceptance: list[str] = Field(min_length=1, max_length=8)
    checkpoint: PoseCheckpoint | None = None
    motion: MotionConstraints | None = None
    structure_usage: StructureUsage | None = None

    @model_serializer(mode='wrap')
    def preserve_legacy_stage_hash(self, handler):
        data = handler(self)
        if self.checkpoint is None: data.pop('checkpoint', None)
        if self.motion is None: data.pop('motion', None)
        if self.structure_usage is None:data.pop('structure_usage',None)
        return data

    @model_validator(mode="after")
    def validate_frames(self):
        if self.frame_count % 2:
            raise ValueError("Provider frame counts must be even")
        if any(not item.strip() or len(item) > 300 for item in self.acceptance):
            raise ValueError("Acceptance criteria must be short nonempty descriptions")
        if self.motion:
            previous=0
            for hold in self.motion.holds:
                if not previous < hold.start <= hold.end <= self.frame_count:raise ValueError('Holds must be ordered nonoverlapping actual segment frame ranges')
                if self.motion.boundary=='pass_through' and hold.end==self.frame_count:raise ValueError('A moving boundary cannot end with a stationary hold')
                previous=hold.end
            if self.motion.boundary=='intentional_hold' and not self.motion.holds:raise ValueError('An intentional hold must declare its frame range and reason')
        return self


class PlanProposal(Contract):
    title: str = Field(min_length=1, max_length=100)
    animation_name: str = Field(pattern=r"^[a-z][a-z0-9_]{0,59}$")
    summary: str = Field(min_length=1, max_length=800)
    requirements: list[Requirement] = Field(min_length=1, max_length=32)
    stages: list[PlanStage] = Field(min_length=1, max_length=4)
    grounded: bool = True
    questions: list[str] = Field(default_factory=list, max_length=4)
    quality: MotionQuality | None = None

    @model_serializer(mode='wrap')
    def preserve_v1_hash(self, handler):
        data = handler(self)
        if self.quality is None: data.pop('quality', None)
        return data

    @model_validator(mode="after")
    def validate_sequence(self):
        hold = self.quality.interactable.hold_frames if self.quality and self.quality.interactable else 0
        if sum(s.frame_count for s in self.stages) + hold > 64:
            raise ValueError("A complete animation supports at most 64 planned frames")
        if self.stages[0].first_frame != "original":
            raise ValueError("The first stage must use the original reference")
        if any(s.first_frame != "previous_end" for s in self.stages[1:]):
            raise ValueError("Later stages must continue the previous stage's last frame")
        if any(s.last_frame == "original" for s in self.stages[:-1]):
            raise ValueError("Only the final stage may explicitly return to the original pose")
        if any(not q.strip() or len(q) > 500 for q in self.questions):
            raise ValueError("Questions must be short nonempty descriptions")
        if self.quality and self.quality.key_poses:
            frames=[p.frame for p in self.quality.key_poses]
            if frames != sorted(set(frames)) or frames[-1]>sum(s.frame_count for s in self.stages):
                raise ValueError('Key poses must be ordered unique planned frames within the clip')
        if self.quality and self.quality.version >= 3 and any(s.checkpoint is None for s in self.stages):
            raise ValueError('Every checked segment needs a visible endpoint, timing and boundary reason')
        return self


Role = Literal["appearance", "motion", "strategy", "coordinator"]


class ObservationTurn(Contract):
    action: Literal['propose', 'inspect_reference', 'consult']
    summary: str = Field(min_length=1, max_length=1500)
    findings: list[Requirement] = Field(min_length=1, max_length=16)
    target: Role | None = None
    question: str = Field(default='', max_length=800)
    crop: list[int] | None = Field(default=None, min_length=4, max_length=4)


class ExpertTurn(Contract):
    action: Literal["propose", "inspect_reference", "consult", "finalize"]
    summary: str = Field(min_length=1, max_length=1500)
    findings: list[Requirement] = Field(default_factory=list, max_length=16)
    target: Role | None = None
    question: str = Field(default="", max_length=800)
    crop: list[int] | None = Field(default=None, min_length=4, max_length=4)
    proposal: PlanProposal | None = None
    plan: PlanProposal | None = None

    @model_validator(mode="after")
    def validate_action(self):
        if self.action == "consult" and (self.target is None or not self.question.strip()):
            raise ValueError("Consultation requires a target and a concrete question")
        if self.action == "finalize" and self.plan is None:
            raise ValueError("Finalization requires an executable plan")
        if self.action != "finalize" and self.plan is not None:
            raise ValueError("A plan is published only through finalization")
        return self


class StrategyTurn(Contract):
    """One proposal slot; strategy cannot publish the coordinator's final plan."""
    action: Literal['propose', 'inspect_reference', 'consult']
    summary: str = Field(min_length=1, max_length=1500)
    findings: list[Requirement] = Field(default_factory=list, max_length=16)
    target: Role | None = None
    question: str = Field(default='', max_length=800)
    crop: list[int] | None = Field(default=None, min_length=4, max_length=4)
    proposal: PlanProposal | None = None

    @model_validator(mode='after')
    def valid_action(self):
        if self.action == 'propose' and self.proposal is None:
            raise ValueError('strategy propose requires the proposal field')
        if self.action == 'consult' and (self.target is None or not self.question.strip()):
            raise ValueError('consult requires target and question')
        return self


class CoordinatorTurn(Contract):
    action: Literal["inspect_reference", "consult", "finalize"]
    summary: str = Field(min_length=1, max_length=1500)
    target: Role | None = None
    question: str = Field(default="", max_length=800)
    crop: list[int] | None = Field(default=None, min_length=4, max_length=4)
    plan: PlanProposal | None = None

    @model_validator(mode="after")
    def validate_action(self):
        if self.action == "finalize" and self.plan is None:
            raise ValueError("finalize requires the plan field, not a proposal")
        if self.action == "consult" and (self.target is None or not self.question.strip()):
            raise ValueError("consult requires target and question")
        return self


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def bind_original_requirements(plan: PlanProposal, spec: TaskSpec) -> PlanProposal:
    """Never let a model paraphrase masquerade as the user's quoted instruction.

    Keep the model interpretation, label it as such, and attach the actual
    original input in full. This changes provenance, not stages or budgets.
    """
    source = spec.description + "\n" + spec.ending
    requirements = []
    for item in plan.requirements:
        if item.source == "user" and item.evidence not in source:
            item = item.model_copy(update={"source":"expert", "evidence":("专家对需求的解读，非用户逐字原话：" + item.evidence)[:300]})
        requirements.append(item)
    for label, text in (("用户原始动作要求",spec.description),("用户指定结束姿势",spec.ending)):
        for offset in range(0,len(text),300):
            requirements.append(Requirement(text=label + (f"（{offset//300+1}）" if len(text)>300 else ""), source="user", evidence=text[offset:offset+300]))
    # Revalidate the complete object, preserving every proposed requirement.
    return PlanProposal.model_validate({**plan.model_dump(mode="json"),"requirements":[r.model_dump(mode="json") for r in requirements]})


class TargetImage(Contract):
    stage: int = Field(ge=0, le=3)
    filename: str = Field(pattern=r'^target-[0-3]-[0-9a-f]{16}\.png$')
    sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    note: str = Field(min_length=4, max_length=1000)


def motion_transport_schema(schema_type, interactable):
    """Specialize the model-facing schema while persisted records support both types."""
    class MotionTransport(schema_type):
        @classmethod
        def model_json_schema(cls, *args, **kwargs):
            schema = schema_type.model_json_schema(*args, **kwargs)
            definitions = schema.get('$defs', {})
            for definition in definitions.values():
                dimension = definition.get('properties', {}).get('dimension', {})
                if dimension.get('enum') == list(CHARACTER_DIMENSIONS + PROP_DIMENSIONS):
                    dimension['enum'] = list(PROP_DIMENSIONS if interactable else CHARACTER_DIMENSIONS)
            if 'MotionQuality' in definitions:
                fields = definitions['MotionQuality']['properties']
                if interactable:
                    fields['interactable'] = {'$ref': '#/$defs/InteractableMotion'}
                else:
                    fields.pop('interactable', None)
                    for unused in ('InteractableMotion', 'ReferencePremises', 'PremiseCheck', 'OpaqueRegion'):
                        definitions.pop(unused, None)
            return schema
    return MotionTransport


def prop_contract(plan):
    return plan.quality.interactable if plan and plan.quality else None


class PlanBinding(Contract):
    prop_structure_policy: Literal[1] | None = None
    unsupported_motion_acknowledged: Literal[True] | None = None
    version: Literal[1] = 1
    work_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    revision: int = Field(ge=1)
    plan_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    reference_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    spec: TaskSpec
    plan: PlanProposal
    model_snapshot: dict[str, Any] = Field(default_factory=dict)
    compiled_prompts: list[str] = Field(default_factory=list, max_length=4)
    end_targets: list[TargetImage] = Field(default_factory=list, max_length=4)
    visual_structure: dict[str,Any] | None = None
    generation_policy_version: Literal[1, 2, 3, 4, 5] | None = None
    visibility_review_version: Literal[1, 2, 3, 4] | None = None

    @model_serializer(mode='wrap')
    def preserve_binding(self, handler):
        data = handler(self)
        if self.prop_structure_policy is None: data.pop('prop_structure_policy', None)
        if self.unsupported_motion_acknowledged is None: data.pop('unsupported_motion_acknowledged', None)
        if not self.end_targets: data.pop('end_targets', None)
        if self.visual_structure is None:data.pop('visual_structure',None)
        if self.generation_policy_version is None:data.pop('generation_policy_version',None)
        if self.visibility_review_version is None:data.pop('visibility_review_version',None)
        return data

    @model_validator(mode="after")
    def validate_budget_and_identity(self, info: ValidationInfo):
        from .structure_control import validate_structure_binding
        validate_structure_binding(self.spec,self.visual_structure,self.reference_sha256,self.plan)
        prop = prop_contract(self.plan)
        if self.prop_structure_policy:
            from .structure_control import prop_structure_problem
            problem = prop_structure_problem(prop, self.visual_structure)
            if problem:
                raise ValueError(problem)
        if prop and self.plan.quality.version < 3:
            raise ValueError('交互物计划需要真实帧检查点')
        if prop and (self.spec.object_type != 'interactable' or prop.blockers()):
            raise ValueError('交互物合同与对象或起始图前提不符')
        if prop and prop.motion_type == 'occluded_rigid_translation' and not self.unsupported_motion_acknowledged and not (info.context or {}).get('planning_only'):
            raise ValueError('当前生成器不适合带遮挡的刚体平移，请明确确认是否尝试')
        stages = [t.stage for t in self.end_targets]
        if len(stages) != len(set(stages)) or any(s >= len(self.plan.stages) for s in stages):
            raise ValueError('Target images must identify unique existing segments')
        for target in self.end_targets:
            if self.plan.stages[target.stage].last_frame == 'original' and target.sha256 != self.reference_sha256:
                raise ValueError('A target image cannot override the requested original ending')
            if target.sha256 == self.reference_sha256 and not (self.spec.return_to_reference and target.stage == len(self.plan.stages)-1):
                raise ValueError('Returning to the original image requires explicit authorization')
        if self.plan_sha256 != digest(self.plan.model_dump(mode="json")):
            raise ValueError("Plan hash does not match the approved plan")
        if self.compiled_prompts and (len(self.compiled_prompts)!=len(self.plan.stages) or any(not p or len(p)>1000 for p in self.compiled_prompts)):
            raise ValueError('Frozen provider prompts must match all stages and their size limit')
        if self.generation_policy_version in (1,2,3,4,5):
            from .generation_conditions import compile_conditions
            if not self.plan.quality or self.plan.quality.version != 4:
                raise ValueError('Drawing conditions policy 1 requires the complete version 4 motion contract')
            expected = [compile_conditions(self.plan, i, policy_version=self.generation_policy_version) for i in range(len(self.plan.stages))]
            if self.compiled_prompts and self.compiled_prompts != expected:
                raise ValueError('Frozen drawing conditions differ from the approved plan')
        if self.plan.questions:
            raise ValueError("Unanswered questions must be resolved before execution")
        if self.plan.stages[-1].last_frame == "original" and not self.spec.return_to_reference:
            raise ValueError("The user did not authorize returning to the reference pose")
        if self.spec.return_to_reference and self.plan.stages[-1].last_frame != "original":
            raise ValueError("The requested return to reference must be bound to the final stage")
        if len(self.plan.stages) * self.spec.candidate_count > self.spec.budget.max_generation_calls:
            raise ValueError("The plan exceeds the authorized generation-call limit")
        counts = [stage.frame_count for stage in self.plan.stages]
        budget = self.spec.budget
        if ((budget.max_frames_per_request and max(counts) > budget.max_frames_per_request)
                or (budget.max_total_frames and sum(counts) * self.spec.candidate_count > budget.max_total_frames)):
            raise ValueError("方案超过用户授权的绘图帧数")
        checks = 1 + len(self.plan.stages) if self.plan.quality and self.plan.quality.version >= 3 else 1
        reviews = review_calls_per_check(self.spec) * checks
        if self.plan.quality and self.spec.candidate_count * reviews > self.spec.budget.max_review_calls:
            raise ValueError(f'Each candidate needs {reviews} visual calls for segment checks and final review; respect the review budget')
        source = self.spec.description + "\n" + self.spec.ending
        for requirement in self.plan.requirements:
            if requirement.source == "user" and requirement.evidence not in source:
                raise ValueError("A user requirement must quote the user's actual input")
        return self


class StageRun(Contract):
    state: Literal["created", "submitting", "unknown", "pending", "complete", "reviewing", "awaiting_review", "accepted", "rejected", "failed", "repairing"] = "created"
    submission_attempts: int = Field(default=0, ge=0, le=1)
    provider_job_id: str | None = None
    error: dict[str, Any] | None = None
    actual_frame_count: int = Field(default=0, ge=0, le=64)
    usage: dict[str, Any] = Field(default_factory=dict)
    review: dict[str, Any] | None = None
    accepted: dict[str, Any] | None = None
    repairs: list[dict[str, Any]] = Field(default_factory=list, max_length=2)
    state_checkpoint: dict[str, Any] | None = None
    active_frames: list[dict[str, Any]] | None = None
    review_history: list[dict[str, Any]] = Field(default_factory=list)
    adjustment_history: list[dict[str, Any]] = Field(default_factory=list)

    @model_serializer(mode='wrap')
    def preserve_legacy_stage(self, handler):
        data=handler(self)
        if self.state_checkpoint is None: data.pop('state_checkpoint', None)
        if not self.adjustment_history:data.pop('adjustment_history',None)
        return data


class PlanExecution(Contract):
    version: Literal[1] = 1
    stages: list[StageRun] = Field(min_length=1, max_length=4)
    actual_frame_count: int = Field(default=0, ge=0, le=64)
    timeline: list[dict[str, Any]] = Field(default_factory=list)
    quality_review: dict[str, Any] | None = None
    frame_mapping: list[dict[str, Any]] = Field(default_factory=list)


class PlanControl(Contract):
    enabled: bool = False
    message: str = "等待确认制作方案"


class OpenWork(Contract):
    frame_budget: dict[str, Any] | None = None
    version: Literal[1, 2, 3] = 3
    id: str = Field(pattern=r"^[0-9a-f]{32}$")
    revision: int = Field(default=1, ge=1)
    request_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    request_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    spec: TaskSpec
    character: dict[str, Any]
    reference_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    status: Literal["planning", "ready", "needs_input", "planning_failed", "budget_exhausted", "executing"] = "planning"
    message: str = "正在制定制作方案"
    created_at: str
    updated_at: str
    planning_calls: list[dict[str, Any]] = Field(default_factory=list)
    messages: list[dict[str, Any]] = Field(default_factory=list)
    plan: PlanProposal | None = None
    plan_sha256: str | None = None
    job_id: str | None = None
    history: list[dict[str, Any]] = Field(default_factory=list)
    planning_authorized: bool = False
    auto_execute: bool = False
    planning_config: dict[str, Any] = Field(default_factory=dict)
    planning_format_version: Literal[1, 2, 3] | None = None
    end_targets: list[TargetImage] = Field(default_factory=list, max_length=4)
    visual_structure: dict[str,Any] | None = None
    generation_policy_version: Literal[1, 2, 3, 4, 5] | None = None
    visibility_review_version: Literal[1, 2, 3, 4] | None = None
    # Set only on copies made for paper experiments; ordinary works omit it.
    experiment: dict[str, Any] | None = None

    @model_serializer(mode='wrap')
    def preserve_structure_free_work(self,handler):
        data=handler(self)
        if self.experiment is None:data.pop('experiment',None)
        if self.visual_structure is None:data.pop('visual_structure',None)
        if self.planning_format_version is None:data.pop('planning_format_version',None)
        if self.generation_policy_version is None:data.pop('generation_policy_version',None)
        if self.visibility_review_version is None:data.pop('visibility_review_version',None)
        return data
