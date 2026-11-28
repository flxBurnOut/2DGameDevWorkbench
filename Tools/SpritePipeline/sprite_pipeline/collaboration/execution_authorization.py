"""Bind a durable generation authorization to one native Job."""
from ..errors import ConflictError, NotFoundError, ValidationHarnessError
from ..models import GenerationRequest, utc_now
from ..providers.account import account_key
from .contracts import ExecutionIntent, PlanBinding, digest, prop_contract
from .experiment_requests import pipeline_prompts
from .quality import compiled_prompt
from .structure_control import require_current_structure
from .targets import check_target_set, freeze_targets, target_set_hash, verified_target


def can_auto_start(work):
    if not (work.auto_execute and work.planning_authorized and work.status == 'ready'
            and work.plan is not None and work.plan_sha256 and not work.end_targets):
        return False
    prop = prop_contract(work.plan)
    return not prop or prop.motion_type != 'occluded_rigid_translation'


class ExecutionAuthorization:
    def __init__(self, workspace):
        self.ws = workspace
        self.s = workspace.service
        self.store = workspace.store

    @staticmethod
    def job_key(work):
        return f'open-motion-{work.id}-{work.revision}'

    def account(self, work):
        settings = self.s.settings
        return account_key(settings) if work.spec.provider == 'pixellab' and settings.pixellab_api_key else None

    def intent(self, work, authorization, *, account=None, allow_unsupported_motion=False):
        return ExecutionIntent(revision=work.revision, plan_sha256=work.plan_sha256,
            targets_sha256=target_set_hash(work.end_targets), authorization=authorization,
            generation_account=account or self.account(work), allow_unsupported_motion=allow_unsupported_motion)

    def verify_plan(self, work, *, allow_unsupported_motion):
        if work.plan is None or work.plan_sha256 != digest(work.plan.model_dump(mode='json')):
            raise ConflictError('已授权方案缺失或发生变化')
        pipeline_prompts(work)
        prop = prop_contract(work.plan)
        unsupported = bool(prop and prop.motion_type == 'occluded_rigid_translation')
        if unsupported and not allow_unsupported_motion:
            raise ValidationHarnessError('当前生成器不适合带遮挡的刚体平移，请确认是否仍要尝试')
        require_current_structure(self.s, work.visual_structure, work.reference_sha256)
        self.ws.reference(work)
        if work.frame_budget is not None:
            from .frame_budget import plan_cost
            _, problem = plan_cost(work, work.plan)
            if problem:
                raise ValidationHarnessError(problem)
        for target in work.end_targets:
            verified_target(self.ws.directory(work.id) / target.filename, target.sha256)
        return prop, unsupported

    def verify_binding(self, work, job):
        binding = job.request.open_plan
        if (not binding or not job.plan_control or job.request.request_key != self.job_key(work)
                or binding.work_id != work.id or binding.revision != work.revision
                or binding.plan_sha256 != work.plan_sha256 or binding.reference_sha256 != work.reference_sha256
                or binding.end_targets != work.end_targets or binding.spec != work.spec):
            raise ConflictError('原 Job 与已授权方案或目标图不一致，请核对原记录')
        prompts = pipeline_prompts(work)
        if prompts is not None and binding.compiled_prompts != prompts:
            raise ConflictError('原 Job 发出的提示词与冻结的实验协议不一致')
        return binding

    def legacy_intent(self, work, job):
        binding = self.verify_binding(work, job)
        intent = self.intent(work, 'legacy_binding', account=job.generation_account,
                             allow_unsupported_motion=bool(binding.unsupported_motion_acknowledged))
        control = next((event['event'] for event in reversed(job.events)
                        if event.get('event') in {'open_plan_paused', 'open_plan_resumed'}), None)
        if control == 'open_plan_paused':
            intent.phase = 'paused'
        return intent

    def create_bound_job(self, work, prop, unsupported):
        character, _ = self.s.presets.load_object(work.spec.object_id, object_type=work.spec.object_type)
        prompts = pipeline_prompts(work)
        if prompts is None:
            prompts = [compiled_prompt(work.plan, character, i, policy_version=work.generation_policy_version)
                       for i in range(len(work.plan.stages))]
        binding = PlanBinding(prop_structure_policy=1 if prop and work.frame_budget is not None else None,
            unsupported_motion_acknowledged=True if unsupported else None, work_id=work.id,
            revision=work.revision, plan_sha256=work.plan_sha256, reference_sha256=work.reference_sha256,
            spec=work.spec, plan=work.plan, model_snapshot=work.planning_config,
            visual_structure=work.visual_structure, generation_policy_version=work.generation_policy_version,
            visibility_review_version=work.visibility_review_version, end_targets=work.end_targets,
            compiled_prompts=prompts)
        request = GenerationRequest(**work.spec.identity_fields(), action_id='motion_' + work.id[:12],
            provider=work.spec.provider, candidate_count=work.spec.candidate_count, seed=work.spec.seed,
            request_key=self.job_key(work), open_plan=binding)
        return self.s.create_job(request)

    def activate(self, work, job=None):
        """Called under the Work lock. The Job gate opens only after all bindings persist."""
        try:
            return self._activate(work, job)
        except (ConflictError, NotFoundError, ValidationHarnessError) as exc:
            intent = work.execution_intent
            error = {'code': exc.code, 'message': exc.message}
            if intent and intent.phase == 'authorized' and intent.activation_error != error:
                intent.activation_error = error
                work.message = '制作授权等待核对：' + exc.message
                self.ws.save(work)
            raise

    def _activate(self, work, job):
        intent = work.execution_intent
        if not intent or intent.revision != work.revision or intent.plan_sha256 != work.plan_sha256:
            raise ConflictError('当前版本缺少匹配的制作授权')
        if work.status != ('executing' if work.job_id else 'ready'):
            raise ConflictError('制作授权与作品状态不一致')
        check_target_set(work.end_targets, intent.targets_sha256)
        if work.job_id:
            job = job or self.store.load(work.job_id)
            self.verify_binding(work, job)
        if intent.phase == 'paused':
            return work, job
        if job and job.generation_requested_at is not None:
            if intent.phase != 'active':
                intent.phase = 'active'
                intent.activation_error = None
                work.message = '正在按方案制作'
                self.ws.save(work)
            return work, job
        if intent.phase == 'active':
            raise ConflictError('已启用的 Job 缺少制作开始记录，请核对原记录')
        if job and any(c.submission_attempts or c.provider_job_id or c.frames for c in job.candidates):
            raise ConflictError('Job 已有执行记录且缺少制作开始时间，请核对原请求')

        account = self.account(work)
        if intent.generation_account and intent.generation_account != account:
            raise ConflictError('制作授权绑定的 PixelLab 账户已改变，请恢复原账户')
        if not intent.generation_account and account:
            intent.generation_account = account
            self.ws.save(work)
        prop, unsupported = self.verify_plan(work, allow_unsupported_motion=intent.allow_unsupported_motion)
        if job is None:
            job = self.create_bound_job(work, prop, unsupported)
            self.verify_binding(work, job)
            work.job_id = job.job_id
            work.status = 'executing'
            work.message = '正在按方案制作'
            self.ws.save(work)

        freeze_targets(self.ws, work, job.job_id)
        with self.store.locked_job(job.job_id) as current:
            self.verify_binding(work, current)
            if current.generation_requested_at is None:
                if current.generation_account and current.generation_account != intent.generation_account:
                    raise ConflictError('已绑定的 Job 账户与制作授权不一致，请核对原记录')
                current.plan_control.enabled = True
                current.plan_control.message = '等待执行计划'
                current.generation_account = intent.generation_account
                current.generation_requested_at = utc_now()
                current.touch('open_plan_authorized', plan_sha256=work.plan_sha256)
        intent.phase = 'active'
        intent.activation_error = None
        work.message = '正在按方案制作'
        self.ws.save(work)
        return work, current

    def start(self, work_id, revision, plan_sha256, *, allow_unsupported_motion=False, expected_targets=None):
        with self.ws.lock(work_id):
            work = self.ws.load(work_id)
            if work.revision != revision or work.plan_sha256 != plan_sha256:
                raise ConflictError('方案版本已改变，请查看最新方案')
            check_target_set(work.end_targets, expected_targets)
            job = self.store.load(work.job_id) if work.job_id else None
            if work.execution_intent is None:
                if job:
                    self.verify_binding(work, job)
                    if job.generation_requested_at is not None:
                        return work, job
                    work.execution_intent = self.legacy_intent(work, job)
                else:
                    if work.status != 'ready':
                        raise ConflictError('方案尚未就绪')
                    self.verify_plan(work, allow_unsupported_motion=allow_unsupported_motion)
                    work.execution_intent = self.intent(work, 'explicit', allow_unsupported_motion=allow_unsupported_motion)
                    work.message = '制作授权已保存，正在绑定原任务'
                self.ws.save(work)
            return self.activate(work, job)

    def recover(self, snapshot):
        with self.ws.lock(snapshot.id, timeout=0.1):
            work = self.ws.load(snapshot.id)
            if work.revision != snapshot.revision:
                return work, None
            job = None
            if work.execution_intent is None:
                if work.job_id:
                    job = self.store.load(work.job_id)
                    if job.generation_requested_at is not None or job.request.request_key != self.job_key(work):
                        return work, job
                    work.execution_intent = self.legacy_intent(work, job)
                elif can_auto_start(work):
                    work.execution_intent = self.intent(work, 'automatic')
                else:
                    return work, None
                self.ws.save(work)
            return self.activate(work, job)

    def pause(self, work_id, revision, *, resume=False):
        with self.ws.lock(work_id):
            work = self.ws.load(work_id)
            if work.revision != revision or not (work.job_id or work.execution_intent):
                raise ConflictError('当前版本没有可暂停的生成')
            if work.job_id:
                with self.store.locked_job(work.job_id) as job:
                    if job.generation_requested_at is not None:
                        if resume and any(r.state in {'reviewing', 'awaiting_review', 'rejected'}
                                          for c in job.candidates for r in c.plan_execution.stages):
                            raise ConflictError('请先检查当前片段并确认实际姿势；继续按钮不能绕过分段验收')
                        if resume and any(c.status.value in {'submission_unknown', 'failed'} and not c.frames for c in job.candidates):
                            raise ConflictError('请先查询原请求解决异常；无法取回时可修改需求建立新版本，不会重发原片段')
                        job.plan_control.enabled = resume
                        job.plan_control.message = '继续按已授权方案制作' if resume else '已暂停后续提交，已发出的请求仍会取回'
                        job.touch('open_plan_resumed' if resume else 'open_plan_paused')
                if job.generation_requested_at is not None:
                    return work, job
                if work.execution_intent is None:
                    work.execution_intent = self.legacy_intent(work, job)
            else:
                job = None
            if work.execution_intent.phase == 'active':
                raise ConflictError('原 Job 缺少已启用的记录，请核对原请求')
            work.execution_intent.phase = 'authorized' if resume else 'paused'
            if not resume:
                work.message = '已暂停尚未启用的制作授权'
            self.ws.save(work)
            return self.activate(work, job) if resume else (work, job)
