"""Durable open-motion workspaces. Planning and execution have separate receipts."""
from __future__ import annotations

import hashlib
import re
import uuid
from contextlib import nullcontext
from datetime import datetime, timezone
from pydantic import ValidationError

from ..errors import ConflictError, HarnessError, InvalidPlanningResponse, NotFoundError, ValidationHarnessError
from ..jsonio import atomic_write_json, read_json, replace_with_retry
from ..vision_review import planning_validation_fields
from .contracts import ExpertTurn, OpenWork, PlanBinding, TaskSpec, digest, bind_original_requirements, default_new_review
from .model_config import ModelConfiguration, ModelRegistry
from .planning import PLANNING_FORMAT_VERSION, PlanningModel
from .planning_observations import REFERENCE_CROP_FOLLOWUP, reusable_observations
from .generation_conditions import DEFAULT_GENERATION_POLICY
from .visibility_review import DEFAULT_VISIBILITY_REVIEW
from .execution_authorization import ExecutionAuthorization, can_auto_start


def now():
    return datetime.now(timezone.utc).isoformat()


def record_error(exc, **identity):
    return {**identity, 'type': type(exc).__name__,
            **({'code': exc.code, 'message': exc.message} if isinstance(exc, HarnessError) else {})}


def motion_workspace_identity(service, *, create=False):
    root = service.settings.data_root / "open-motion"
    marker = root / ".workspace-identity.json"
    try:
        try:
            token = read_json(marker)
        except FileNotFoundError:
            if not create:
                return None
            with service.store.global_lock("motion_workspace_identity"):
                try:
                    token = read_json(marker)
                except FileNotFoundError:
                    token = uuid.uuid4().hex
                    atomic_write_json(marker, token)
        if isinstance(token, str) and re.fullmatch(r"[0-9a-f]{32}", token):
            return digest([str(root.resolve()), token])
    except (OSError, ValueError, ConflictError):
        pass
    return None


class OpenMotionWorkspace:
    def __init__(self, service, *, model=None):
        self.service = service
        self.store = service.store
        self.root = service.settings.data_root / "open-motion"
        self.model = model or getattr(service, "open_motion_model", None) or PlanningModel(service.settings)
        self.execution = ExecutionAuthorization(self)

    def directory(self, work_id):
        if not re.fullmatch(r"[0-9a-f]{32}", work_id):
            raise ValidationHarnessError("作品标识无效")
        return self.root / work_id

    def load(self, work_id, revision=None):
        path = self.directory(work_id) / "work.json"
        if not path.is_file():
            raise NotFoundError("未找到此作品")
        current = OpenWork.model_validate(read_json(path))
        from .structure_control import verify_structure
        if current.id != work_id:
            raise ConflictError('作品记录与路径不匹配')
        verify_structure(current.visual_structure,current.reference_sha256)
        if revision is not None and revision != current.revision:
            return self.historical(work_id, revision)
        return current

    def historical(self, work_id, revision):
        if not isinstance(revision, int) or revision < 1:
            raise ValidationHarnessError('版本号无效')
        path = self.directory(work_id) / f'version-{revision}.json'
        if not path.is_file():
            raise NotFoundError('未找到此版本')
        work = OpenWork.model_validate(read_json(path))
        if work.id != work_id or work.revision != revision:
            raise ConflictError('历史版本记录与路径不匹配')
        from .structure_control import verify_structure
        verify_structure(work.visual_structure, work.reference_sha256)
        return work

    def save(self, work):
        work.updated_at = now()
        atomic_write_json(self.directory(work.id) / "work.json", work.model_dump(mode="json"))

    def lock(self, work_id, *, timeout=5):
        self.directory(work_id)
        return self.store.global_lock("open-work-" + work_id, timeout_seconds=timeout)

    def reference(self, work):
        try:
            data = (self.directory(work.id) / f"reference-{work.revision}.png").read_bytes()
        except FileNotFoundError as exc:
            raise ConflictError('作品参考图缺失，已停止执行') from exc
        if hashlib.sha256(data).hexdigest() != work.reference_sha256:
            raise ConflictError("作品参考图已改变，已停止执行")
        return data

    def planning_configured(self, snapshot):
        if isinstance(self.model, PlanningModel):
            return self.model.registry.configured_for(snapshot)
        return self.model.configured

    def request_path(self, request_key):
        if not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}', request_key):
            raise ValidationHarnessError('请求标识无效')
        return self.root / 'requests' / (hashlib.sha256(request_key.encode()).hexdigest() + '.json')

    def original_request(self, request_key):
        path = self.request_path(request_key)
        if not path.is_file():
            raise NotFoundError('未找到此规划请求')
        receipt = read_json(path)
        work = self.load(receipt['id'], 1)
        if work.request_key != request_key or work.request_sha256 != receipt['fingerprint']:
            raise ConflictError('原始规划作品与请求回执不一致')
        return work

    def revision_request(self, work_id, request_key, *, current=None):
        self.request_path(request_key)
        current = current or self.load(work_id)
        if current.request_key == request_key:
            return current
        for revision in range(current.revision - 1, 0, -1):
            try:
                historical = self.historical(work_id, revision)
            except NotFoundError as exc:
                raise ConflictError('作品历史不完整，无法核对原请求标识') from exc
            if historical.request_key == request_key:
                return historical
        raise NotFoundError('未找到此作品的请求')

    def records(self, errors, *, stopping=lambda: False):
        for path in self.root.glob('*/work.json'):
            if stopping():
                break
            work_id = path.parent.name
            try:
                yield self.load(work_id)
            except (HarnessError, OSError, ValueError, KeyError, TypeError) as exc:
                errors.append(record_error(exc, work_id=work_id, phase='read'))

    def listing(self, *, errors=None):
        errors = [] if errors is None else errors
        rows = []
        jobs = {j['job_id']: j for j in self.store.list_jobs()}
        for w in self.records(errors):
            try:
                job = jobs.get(w.job_id, {})
                rows.append({"id": w.id, "revision": w.revision, "title": w.plan.title if w.plan else w.spec.description[:60],
                             "status": w.status, "job_id": w.job_id, "job_status": job.get("status"),
                             "updated_at": max(w.updated_at, job.get("updated_at", "")),
                             "object_id": w.spec.object_id, "object_type": w.spec.object_type, "object_name": w.character["display_name"],
                             "character_name": w.character["display_name"], "diagnostic_only": w.spec.provider == "fixture"})
            except (ValueError, OSError, KeyError, TypeError) as exc:
                errors.append(record_error(exc, work_id=w.id, phase='summary'))
        return sorted(rows, key=lambda row: row["updated_at"], reverse=True)

    def create(self, spec, request_key, *, planning_authorized=False, auto_execute=False, planning_models=None):
        spec = TaskSpec.model_validate(spec)
        if not planning_authorized:
            raise ValidationHarnessError("制定方案会调用模型，请先授权本次规划额度")
        request_path = self.request_path(request_key)
        prepared = request_path.parent / 'pending' / request_path.name
        requested = {"spec": spec.model_dump(mode="json"), "auto_execute": auto_execute}
        if planning_models:
            requested['planning_models'] = {role: profile.model_dump(mode='json', exclude_unset=True, exclude_none=True)
                                            for role, profile in planning_models.items()}
        fingerprint = digest(requested)
        with self.store.global_lock("open-work-creation"):
            if request_path.exists():
                receipt = read_json(request_path)
                if receipt["fingerprint"] != fingerprint:
                    raise ConflictError("同一请求标识已用于其他需求")
                try:
                    return self.original_request(request_key)
                except NotFoundError:
                    return self._publish_creation(prepared, request_key, receipt)
            if prepared.is_file():
                pending = OpenWork.model_validate(read_json(prepared))
                if pending.request_key != request_key or pending.request_sha256 != fingerprint:
                    raise ConflictError('同一请求标识已用于其他需求')
                receipt = {'id': pending.id, 'fingerprint': fingerprint}
                atomic_write_json(request_path, receipt)
                return self._publish_creation(prepared, request_key, receipt)
            spec = default_new_review(spec)
            from .frame_budget import require_minimum_budget
            require_minimum_budget(spec)
            planning_config = self.model.configuration
            if planning_models:
                config = ModelConfiguration.model_validate(planning_config) if 'default' in planning_config else ModelRegistry(self.service.settings).load()
                try:
                    planning_config = config.with_planning_models(planning_models).model_dump(mode='json')
                except ValidationError as exc:
                    raise ValidationHarnessError('本次规划的模型参数不适用：' + exc.errors(include_input=False)[0]['msg']) from None
            if not self.planning_configured(planning_config):
                raise ValidationHarnessError("请先在模型设置中配置规划模型；不会创建空生成任务")
            character, preset_path = self.service.presets.load_object(spec.object_id, object_type=spec.object_type)
            source = preset_path.parent / character.reference_frame
            self.service._validate_reference_image(source, character.cell_width, character.cell_height)
            data = source.read_bytes()
            from .structure_control import freeze_structure
            structure=freeze_structure(self.service,spec.visual_structure,hashlib.sha256(data).hexdigest(), object_type=spec.object_type)
            work = OpenWork(id=uuid.uuid4().hex, request_key=request_key, request_sha256=fingerprint,
                            spec=spec, character=self.service.presets.object_snapshot(character), reference_sha256=hashlib.sha256(data).hexdigest(),
                            created_at=now(), updated_at=now(), planning_authorized=True, auto_execute=auto_execute,
                            planning_config=planning_config,planning_format_version=PLANNING_FORMAT_VERSION,visual_structure=structure,
                            generation_policy_version=DEFAULT_GENERATION_POLICY if spec.provider != 'fixture' else None,
                            visibility_review_version=DEFAULT_VISIBILITY_REVIEW if spec.provider != 'fixture' and spec.review_protocol=='experts_v1' else None)
            directory = self.directory(work.id)
            directory.mkdir(parents=True)
            self.service._atomic_write_bytes(directory / "reference-1.png", data)
            # A prepared snapshot is invisible to the planner. Reserve its identity
            # before publishing work.json, then resume that exact snapshot on retry.
            atomic_write_json(prepared, work.model_dump(mode='json'))
            receipt = {'id': work.id, 'fingerprint': fingerprint}
            atomic_write_json(request_path, receipt)
            return self._publish_creation(prepared, request_key, receipt)

    def _publish_creation(self, prepared, request_key, receipt):
        target = self.directory(receipt['id']) / 'work.json'
        if target.is_file():
            return self.original_request(request_key)
        if not prepared.is_file():
            raise NotFoundError('未找到此作品的原始请求快照')
        work = OpenWork.model_validate(read_json(prepared))
        if (work.id != receipt['id'] or work.revision != 1 or work.request_key != request_key
                or work.request_sha256 != receipt['fingerprint']):
            raise ConflictError('原始请求快照与回执不一致')
        self.reference(work)
        replace_with_retry(prepared, target)
        return work

    def revise(self, work_id, expected_revision, spec, request_key, *, planning_authorized=False):
        spec = TaskSpec.model_validate(spec)
        if not planning_authorized:
            raise ValidationHarnessError("重新制定方案需要明确授权规划调用")
        if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", request_key):
            raise ValidationHarnessError("请求标识无效")
        with self.lock(work_id):
            work = self.load(work_id)
            fingerprint = digest({"spec": spec.model_dump(mode="json"), "auto_execute": False})
            try:
                previous = self.revision_request(work_id, request_key, current=work)
            except NotFoundError:
                previous = None
            if previous:
                if previous.request_sha256 != fingerprint or previous.revision != expected_revision + 1:
                    raise ConflictError("同一请求标识已用于其他需求")
                return previous
            # Revising an older task does not silently upgrade its policy/cost.
            if spec.review_protocol is None:
                spec = spec.model_copy(update={'review_protocol': work.spec.review_protocol or 'baseline'})
            if work.revision != expected_revision:
                raise ConflictError("需求版本已改变，请刷新后继续")
            if work.status == "planning":
                raise ConflictError("规划尚在执行，请等待结果后修改")
            if len(work.history) >= 50:
                raise ValidationHarnessError("当前作品版本过多，请另建作品；历史版本保留")
            from .frame_budget import require_minimum_budget
            require_minimum_budget(spec)
            planning_config = work.planning_config
            if not planning_config or (isinstance(self.model, PlanningModel) and 'default' not in planning_config):
                planning_config = self.model.configuration
            if not self.planning_configured(planning_config):
                raise ValidationHarnessError('请在模型设置中补齐此作品所用规划服务的凭据，再修改方案')
            character, preset_path = self.service.presets.load_object(spec.object_id, object_type=spec.object_type)
            source = preset_path.parent / character.reference_frame
            self.service._validate_reference_image(source, character.cell_width, character.cell_height)
            data = source.read_bytes()
            from .structure_control import freeze_structure
            structure=freeze_structure(self.service,spec.visual_structure,hashlib.sha256(data).hexdigest(), object_type=spec.object_type)
            previous_job_id = work.job_id
            snapshot = work.model_dump(mode="json"); snapshot.pop("history")
            atomic_write_json(self.directory(work.id) / f"version-{work.revision}.json", snapshot)
            work.history.append({"revision": work.revision, "title": work.plan.title if work.plan else work.spec.description[:60], "job_id": work.job_id})
            work.revision += 1; work.spec = spec; work.request_key = request_key; work.request_sha256 = fingerprint
            work.version = 3
            work.character = self.service.presets.object_snapshot(character); work.reference_sha256 = hashlib.sha256(data).hexdigest()
            work.plan = None; work.plan_sha256 = None; work.job_id = None
            work.execution_intent = None
            work.end_targets = []
            work.frame_budget = None
            work.planning_calls = []; work.messages = []; work.status = "planning"
            work.message = "正在按新要求制定方案"; work.auto_execute = False
            work.planning_config = planning_config
            work.planning_format_version = PLANNING_FORMAT_VERSION
            work.generation_policy_version = DEFAULT_GENERATION_POLICY if spec.provider != 'fixture' else None
            work.visibility_review_version = DEFAULT_VISIBILITY_REVIEW if spec.provider != 'fixture' and spec.review_protocol=='experts_v1' else None
            work.visual_structure=structure
            self.service._atomic_write_bytes(self.directory(work.id) / f"reference-{work.revision}.png", data)
            with self.store.locked_job(previous_job_id) if previous_job_id else nullcontext() as previous_job:
                if previous_job and any(c.status.value in {'submitting', 'submission_unknown', 'provider_pending', 'saving'}
                                        for c in previous_job.candidates):
                    raise ConflictError('已有请求尚未结束，请先核对结果；不会覆盖原任务')
                self.save(work)
                if previous_job and previous_job.plan_control and previous_job.plan_control.enabled:
                    previous_job.plan_control.enabled = False
                    previous_job.touch('open_plan_superseded')
            return work

    @staticmethod
    def _schedule_correction(work, queue, request, problem):
        role, _, _ = request
        index = len(work.planning_calls)
        work.messages.append({"role": "validator", "target_role": role, "call": index,
                              "response": {"action": "validation_feedback", "summary": problem}})
        if any(call['role'] == role and 'corrects_call' in call for call in work.planning_calls):
            raise ValidationHarnessError('该专家的一次校验修正未通过；已保留原结果。' + problem)
        remaining = work.spec.budget.max_planning_calls - index
        if remaining <= len(queue):
            raise ValidationHarnessError('规划额度不足以修正该专家结果并完成剩余专家；已保留原结果。' + problem)
        queue.insert(0, request)
        return index

    def plan(self, work_id, *, stopping=lambda: False):
        # This OS-backed lock spans the model call; a second process cannot run
        # the same planning turn. A crash leaves a receipt, never an automatic retry.
        with self.store.global_lock("open-planner-" + work_id, timeout_seconds=0.1):
            work = self.load(work_id)
            if work.status != "planning":
                return work
            if not work.planning_authorized:
                raise ConflictError('作品缺少已保存的规划授权')
            if work.planning_calls:
                work.status = "planning_failed"
                work.message = "规划曾被中断，已保留调用记录；请明确重新制定方案，不会自动重发"
                self.save(work); return work
            queue = [(role, "", None) for role in ("appearance", "motion", "strategy", "coordinator")]
            contributed = set()
            last_invalid_plan = None
            current_format = work.planning_format_version == PLANNING_FORMAT_VERSION
            correction_of = None
            correction_draft = None
            try:
                from .frame_budget import minimum_drawing_problem, planning_limits, plan_cost
                work.frame_budget = planning_limits(self.service, work)
                minimum_problem = minimum_drawing_problem(work)
                if minimum_problem:
                    work.status = 'budget_exhausted'
                    work.message = minimum_problem
                    self.save(work)
                    return work
                reference = self.reference(work)
                if current_format and work.revision > 1:
                    previous = self.load(work.id, work.revision - 1)
                    work.messages = reusable_observations(previous, work)
                    contributed.update(message['role'] for message in work.messages)
                    queue = [request for request in queue if request[0] not in contributed]
                while queue:
                    if stopping():
                        return work
                    if len(work.planning_calls) >= work.spec.budget.max_planning_calls:
                        work.status = "budget_exhausted"; work.message = "规划调用已到上限；原要求和已有提案均已保留"
                        self.save(work); return work
                    from .structure_control import require_current_structure
                    require_current_structure(self.service,work.visual_structure,work.reference_sha256)
                    request = queue.pop(0)
                    role, question, crop = request
                    model_question = question
                    work.message = {"appearance": "正在核对原图特征", "motion": "正在安排动作与衔接", "strategy": "正在制定生成策略", "coordinator": "正在协调并校验方案"}[role]
                    work.planning_calls.append({"role": role, "state": "submitting", "started_at": now(), "request_id": uuid.uuid4().hex,
                                                "reference_sha256": work.reference_sha256, "crop": crop})
                    if correction_of is not None:
                        work.planning_calls[-1]['corrects_call'] = correction_of
                        if work.planning_calls[correction_of - 1]['state'] == 'completed':
                            # Keep the coordinator's existing local-validation question
                            # contract. The saved peer transcript keeps the original question.
                            problem = work.messages[-1]['response']['summary']
                            model_question = (question + '\nLocal validator rejected the proposal. '
                                              'Correct ONLY the invalid plan, preserve the original task and return finalize: ' + problem).strip()
                        correction_of = None
                    if work.visual_structure:work.planning_calls[-1]['visual_structure_sha256']=work.visual_structure['sha256']
                    self.save(work)
                    fields = []
                    try:
                        draft_input = {'previous_draft': correction_draft} if correction_draft is not None else {}
                        correction_draft = None
                        turn, receipt = self.model(role, work, reference, question=model_question, crop=crop, **draft_input)
                    except InvalidPlanningResponse as exc:
                        receipt = exc.details.get('model_receipt', {})
                        fields = receipt.get('validation_fields', [])
                        if not current_format or not fields:
                            raise
                        correction_draft = exc.draft
                    else:
                        try:
                            if role=='strategy' and work.generation_policy_version in (4,5,6):
                                from .planning_draft import DraftInternalTurn
                                turn=DraftInternalTurn.model_validate(turn)
                            else:
                                turn = ExpertTurn.model_validate(turn)
                        except ValidationError as exc:
                            if not current_format:
                                raise
                            fields = planning_validation_fields(exc)
                    if fields:
                        work.planning_calls[-1].update({**receipt, 'state': 'invalid_response', 'finished_at': now(),
                                                        'validation_fields': fields})
                        correction_of = self._schedule_correction(work, queue, request, '；'.join(fields))
                        self.save(work)
                        continue
                    work.planning_calls[-1].update(state="completed", finished_at=now(), **receipt)
                    work.messages.append({"role": role, "question": question, "response": turn.model_dump(mode="json"), "call": len(work.planning_calls)})
                    if work.generation_policy_version in (5,6):
                        from .planning_budget import defer
                        if defer(work,role,turn,queue):
                            if turn.findings or turn.proposal:
                                contributed.add(role)
                            elif role != 'coordinator' and role not in contributed and not any(r == role for r, _, _ in queue):
                                raise ValidationHarnessError('规划额度不足以执行此专家的观察请求，且尚无可用意见；已保留原请求。')
                            self.save(work)
                            continue
                    if turn.action == "inspect_reference":
                        # Validate locally before scheduling a further paid call.
                        if turn.crop:
                            left, top, right, bottom = turn.crop
                            if not 0 <= left < right <= work.character["cell_width"] or not 0 <= top < bottom <= work.character["cell_height"]:
                                raise ValidationHarnessError("专家请求的观察区域超出参考图")
                        queue.insert(0, (role, REFERENCE_CROP_FOLLOWUP, turn.crop))
                    elif turn.action == "consult":
                        if turn.target == role:
                            raise ValidationHarnessError("专家不能向自己发起重复质询")
                        queue[0:0] = [(turn.target, turn.question, None), (role, "Your consultation has been answered; assess the peer evidence and continue.", None)]
                    elif turn.action == "finalize":
                        if role != "coordinator" or not {"appearance", "motion", "strategy"} <= contributed:
                            raise ValidationHarnessError("方案缺少必要的专家提案")
                        plan = bind_original_requirements(turn.plan, work.spec)
                        from .contracts import prop_contract
                        prop = prop_contract(plan)
                        if work.spec.object_type == 'interactable' and not prop:
                            raise ValidationHarnessError('交互物规划缺少起始图核对与状态合同；未提交生成')
                        blockers = prop.blockers() if prop else []
                        from .structure_control import prop_structure_problem
                        structure_problem = prop_structure_problem(prop, work.visual_structure) if prop else None
                        if structure_problem and not work.visual_structure:
                            blockers.append(structure_problem)
                            structure_problem = None
                        units, problem = plan_cost(work, plan)
                        from .contracts import skeleton_problem
                        problem = problem or structure_problem or skeleton_problem(plan, work.spec)
                        calls = len(plan.stages) * work.spec.candidate_count
                        if calls > work.spec.budget.max_generation_calls:
                            problem = f"方案需要 {calls} 次生成，但用户上限是 {work.spec.budget.max_generation_calls} 次。合并非必要片段，不能提高预算。"
                        elif not problem and not plan.questions and not blockers:
                            try:
                                PlanBinding.model_validate(dict(prop_structure_policy=1 if prop else None, work_id=work.id, revision=work.revision, plan_sha256=digest(plan.model_dump(mode="json")),
                                            reference_sha256=work.reference_sha256, spec=work.spec, plan=plan,visual_structure=work.visual_structure,
                                            generation_policy_version=work.generation_policy_version,
                                            visibility_review_version=work.visibility_review_version), context={'planning_only': True})
                                if work.version >= 2 and work.spec.provider != 'fixture':
                                    from .quality import validate_quality_plan
                                    from ..models import validate_object_preset
                                    validate_quality_plan(plan, work.spec, validate_object_preset(work.character), require_checkpoints=work.version >= 3,
                                                          policy_version=work.generation_policy_version)
                            except ValidationHarnessError as exc:
                                problem = str(exc)
                            except ValidationError as exc:
                                problem = "; ".join(e['msg'] for e in exc.errors(include_input=False))
                        if problem:
                            if current_format:
                                correction_of = self._schedule_correction(work, queue, request, problem)
                                self.save(work)
                                continue
                            invalid_hash = digest(plan.model_dump(mode='json'))
                            if last_invalid_plan == invalid_hash:
                                raise ValidationHarnessError('协调专家重复了同一无效方案，已停止额外调用。' + problem)
                            last_invalid_plan = invalid_hash
                            # A successful model turn can ask the local validator
                            # for feedback, within the already authorized cap.
                            # Failed/ambiguous network requests are never retried.
                            work.messages.append({"role":"validator", "response":{"action":"validation_feedback", "summary":problem}, "call":len(work.planning_calls)})
                            if len(work.planning_calls) >= work.spec.budget.max_planning_calls:
                                raise ValidationHarnessError("方案校验未通过，规划调用已到上限；未提交生成。" + problem)
                            queue.insert(0, ("coordinator", "Local validator rejected the proposal. Correct ONLY the invalid plan, preserve the original task and return finalize: " + problem, None))
                            self.save(work)
                            continue
                        work.frame_budget['estimated_units'] = units
                        work.plan = plan; work.plan_sha256 = digest(plan.model_dump(mode="json"))
                        work.status = "needs_input" if plan.questions else "ready"
                        work.message = "请补充方案中的关键问题" if plan.questions else "方案已就绪，等待制作授权"
                        unsupported = prop and prop.motion_type == 'occluded_rigid_translation'
                        if blockers:
                            work.status = "needs_input"
                            work.message = "起始图前提未满足，请核对原图：" + "；".join(blockers)
                        elif unsupported and work.status == "ready":
                            work.message = "当前生成器不适合带遮挡的刚体平移，请决定是否仍要尝试"
                        if can_auto_start(work):
                            work.execution_intent = self.execution.intent(work, 'automatic')
                            work.message = '制作授权已保存，正在绑定原任务'
                        self.save(work)
                        break
                    else:
                        contributed.add(role)
                        if role == "coordinator" and not queue:
                            queue.append((role, "Finalize a plan, or publish a plan with explicit questions if user input is required.", None))
                    self.save(work)
                else:
                    raise ValidationHarnessError("专家未形成可执行方案；已有提案保留")
            except Exception as exc:
                if work.status == 'ready' and work.plan is not None:
                    raise  # A finalized plan is not a failed model call.
                if work.planning_calls and work.planning_calls[-1]["state"] == "submitting":
                    work.planning_calls[-1].update(state='outcome_unknown', finished_at=now())
                    if isinstance(exc, ValidationHarnessError) and exc.details.get("model_receipt"):
                        receipt=exc.details['model_receipt']
                        work.planning_calls[-1].update(receipt)
                        work.planning_calls[-1]['state'] = 'invalid_response' if receipt.get('response_id') or receipt.get('output_sha256') else 'failed_request' if receipt.get('http_status') else 'outcome_unknown'
                work.status = "planning_failed"
                work.message = str(exc) if isinstance(exc, (ConflictError, ValidationHarnessError)) else "规划未完成，已保留记录；不会自动重复调用模型"
                self.save(work)
                return work
            if work.execution_intent and not stopping():
                return self.start(work.id, work.revision, work.plan_sha256)
            return work

    def recover_planning(self, *, stopping=lambda: False):
        summary = {'checked_at': now(), 'checked': 0, 'advanced': [], 'errors': []}
        if not stopping():
            self._recover_creations(stopping, summary['errors'])
        jobs = None
        for work in self.records(summary['errors'], stopping=stopping):
            summary['checked'] += 1
            try:
                if work.status == 'planning':
                    updated = self.plan(work.id, stopping=stopping)
                elif work.execution_intent:
                    if work.execution_intent.phase != 'authorized':
                        continue
                    updated, _ = self.execution.recover(work)
                elif work.job_id:
                    if jobs is None:
                        jobs = {row['job_id']: row for row in self.store.list_jobs()}
                    if jobs.get(work.job_id, {}).get('generation_requested'):
                        continue
                    updated, _ = self.execution.recover(work)
                elif can_auto_start(work):
                    updated, _ = self.execution.recover(work)
                else:
                    continue
                if updated.updated_at != work.updated_at:
                    summary['advanced'].append({'work_id': work.id, 'revision': updated.revision, 'status': updated.status})
            except (HarnessError, OSError, ValueError, KeyError, TypeError) as exc:
                if not isinstance(exc, ConflictError) or not exc.details.get('operation'):
                    phase = 'planning' if work.status == 'planning' else 'execution'
                    summary['errors'].append(record_error(exc, work_id=work.id, phase=phase))
        return summary

    def _recover_creations(self, stopping, errors):
        requests = self.root / 'requests'
        prepared_paths = list((requests / 'pending').glob('*.json'))
        if not prepared_paths:
            return
        try:
            with self.store.global_lock('open-work-creation', timeout_seconds=0.1):
                for prepared in prepared_paths:
                    if stopping():
                        return
                    receipt = requests / prepared.name
                    if not prepared.is_file() or not receipt.is_file():
                        continue
                    try:
                        key = read_json(prepared)['request_key']
                        if not isinstance(key, str) or self.request_path(key) != receipt:
                            raise ConflictError('准备记录与原始请求标识不一致')
                        self._publish_creation(prepared, key, read_json(receipt))
                    except (HarnessError, OSError, ValueError, KeyError, TypeError) as exc:
                        errors.append(record_error(exc, request_sha256=prepared.stem, phase='creation'))
        except ConflictError:
            pass  # A foreground create owns the publication lock.

    def start(self, work_id, expected_revision, plan_sha256, *, allow_unsupported_motion=False, expected_targets=None):
        work, _ = self.execution.start(work_id, expected_revision, plan_sha256,
                                       allow_unsupported_motion=allow_unsupported_motion, expected_targets=expected_targets)
        return work

    def pause(self, work_id, expected_revision, *, resume=False):
        work, _ = self.execution.pause(work_id, expected_revision, resume=resume)
        return work

    def view(self, work_id, revision=None):
        current = self.load(work_id)
        work = self.historical(work_id, revision) if revision is not None and revision != current.revision else current
        job = self.store.load(work.job_id) if work.job_id else None
        return self.render(work, job, current_revision=current.revision)

    def command_view(self, operation, work, job):
        result = self.render(work, job, current_revision=self.load(work.id).revision)
        result['command_receipt'] = {'version': 1, 'operation': operation, 'work_id': work.id,
            'work_revision': work.revision, 'job_id': job.job_id if job else None,
            'job_revision': job.revision if job else None, 'current_revision': result['current_revision']}
        return result

    def render(self, work, job, *, current_revision):
        result = work.model_dump(mode="json")
        from .targets import target_set_hash
        result["target_set_sha256"] = target_set_hash(work.end_targets)
        result["latest_revision"] = current_revision
        result["current_revision"] = current_revision
        if job:
            binding = job.request.open_plan
            if (job.job_id != work.job_id or not binding or binding.work_id != work.id
                    or binding.revision != work.revision or binding.plan_sha256 != work.plan_sha256):
                raise ConflictError('作品和 Job 快照来源不匹配')
        result["job"] = job.model_dump(mode="json") if job else None
        if job:
            from .state_chain import state_images
            from .visual_review import frame_digest, review_state
            for candidate, view in zip(job.candidates, result["job"]["candidates"], strict=True):
                view["review_token"] = frame_digest(candidate)
                if work.plan.quality:
                    view["quality_review"] = review_state(candidate)
                if work.spec.object_type == 'interactable':
                    view["state_chain"] = state_images(job, candidate)
        result["view_path"] = ("/tools/interactable-motion?work=" if work.spec.object_type == "interactable" else "/tools/sprite-generator?work=") + work.id
        result["diagnostic_only"] = work.spec.provider == "fixture" or bool(result["job"] and any(c["diagnostic_only"] for c in result["job"]["candidates"]))
        from .adjustments import Adjustments
        errors = []
        adjustments = Adjustments(self.service).listing(work.id, errors=errors)
        if errors:
            result['adjustment_record_errors'] = errors
        if adjustments:
            result['adjustment_usage']={k:sum(len(t[k+'_calls']) for t in adjustments) for k in ('planning','generation','review')}
            result['adjustment_usage']['tasks']=[{k:t[k] for k in ('id','revision','candidate','stage','state')} for t in adjustments]
        return result
