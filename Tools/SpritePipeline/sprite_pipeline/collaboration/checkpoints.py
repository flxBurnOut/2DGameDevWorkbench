"""Real, hash-bound pose checkpoints. Models advise; explicit review unlocks continuation."""
from __future__ import annotations
import hashlib
from .contracts import digest
from .model_config import ModelRegistry
from .visual_review import Observations, Audit, evidence_panels, grounded_audit
from .drawing_frames import FRAME_NORMALIZATION, playback_indices
from ..errors import ConflictError, ValidationHarnessError
from ..models import CandidateStatus, utc_now
from ..vision_evidence import image_part, raster
from .review_inputs import prop_review_context, review_dimensions, observation_content, audit_content
from .state_chain import confirmed_state, transition


def checked_plan(job):
    return bool(job.request.open_plan and job.request.open_plan.plan.quality and job.request.open_plan.plan.quality.version >= 3)


def review_call_count(job):
    return sum(len((c.plan_execution.quality_review or {}).get('requests', [])) +
               sum(len((r.review or {}).get('requests', [])) + sum(len(h.get('requests',[])) for h in r.review_history) for r in c.plan_execution.stages)
               for c in job.candidates if c.plan_execution)


class Checkpoints:
    def __init__(self, service):
        self.s = service
        self.registry = getattr(service, 'open_motion_review_registry', None) or ModelRegistry(service.settings)

    def run_record(self, job, index, stage):
        if not checked_plan(job) or not 0 <= stage < len(job.request.open_plan.plan.stages):
            raise ValidationHarnessError('此任务没有对应的分段检查点')
        return self.s._candidate(job, index).plan_execution.stages[stage]

    def snapshot_bytes(self, job_id, source):
        try:
            data = self.s.store.resolve_job_path(job_id, source['path']).read_bytes()
        except FileNotFoundError as exc:
            raise ConflictError('已确认的姿势快照缺失，停止后续生成') from exc
        if hashlib.sha256(data).hexdigest() != source['sha256']:
            raise ConflictError('已确认的姿势快照发生变化，停止后续生成')
        return data

    def accepted_frames(self, job, index, stage):
        run = self.run_record(job, index, stage)
        if run.state != 'accepted' or not run.accepted:
            raise ConflictError('前一片段尚未确认，不能将未经检查的姿势传入下一段')
        data = [self.snapshot_bytes(job.job_id, item) for item in run.accepted['frames']]
        if not data or hashlib.sha256(data[-1]).hexdigest() != run.accepted['anchor_sha256']:
            raise ConflictError('实际姿势锚点与已确认片段不一致')
        if run.state_checkpoint and self.snapshot_bytes(job.job_id, run.state_checkpoint) != data[-1]:
            raise ConflictError('已确认的状态帧与过渡末帧不一致')
        return data

    def input_frame(self, job, index, stage):
        if stage:
            return self.accepted_frames(job, index, stage - 1)[-1]
        data = (self.s.store.job_dir(job.job_id) / 'input/reference.png').read_bytes()
        if hashlib.sha256(data).hexdigest() != job.reference_sha256:
            raise ConflictError('原始参考图已改变')
        return data

    def state_image(self, job, index, stage):
        if not checked_plan(job) or not job.request.open_plan.plan.quality.interactable:
            raise ValidationHarnessError('仅交互物作业登记状态图')
        run = self.run_record(job, index, stage)
        if run.accepted:
            return self.accepted_frames(job, index, stage)[-1]
        if run.state_checkpoint:
            return self.snapshot_bytes(job.job_id, run.state_checkpoint)
        raise ConflictError('本段尚无已确认状态图')

    def evidence(self, job, index, stage):
        from .execution import PlanGeneration
        run = self.run_record(job, index, stage)
        if run.state in {'created', 'submitting', 'pending', 'unknown', 'failed'}:
            raise ConflictError('片段尚未完整保存，暂时不能检查')
        engine = PlanGeneration(self.s)
        raw = engine.saved_frames(job.job_id, index, stage, expected_manifest_sha256=run.frames_manifest_sha256)
        first = self.input_frame(job, index, stage)
        definition = job.request.open_plan.plan.stages[stage]
        indices = playback_indices(raw, definition.frame_count, first)
        frames = [{'raw_index': i, 'sha256': hashlib.sha256(raw[i]).hexdigest(),
                   'path': (engine.directory(job.job_id,index,stage) / f'frame_{i:03d}.png').relative_to(self.s.store.job_dir(job.job_id)).as_posix()}
                  for i in indices]
        if run.active_frames is not None:
            from .repairs import LocalRepairs
            if len(run.active_frames)!=len(frames):raise ConflictError('修复版本帧数与原片段不同')
            LocalRepairs(self.s).read_frames(job.job_id,run.active_frames)
            frames=run.active_frames
        from .targets import target_bytes
        target = target_bytes(self.s,job,stage)
        target_identity = {'target_sha256':hashlib.sha256(target).hexdigest()} if target else {}
        token = digest({'job': job.job_id, 'candidate': index, 'stage': stage,
                        'plan': job.request.open_plan.plan_sha256, 'frames': frames,
                        **target_identity,
                        'input_sha256': hashlib.sha256(first).hexdigest()})
        return {'token': token, 'frames': frames, **target_identity, 'input_sha256': hashlib.sha256(first).hexdigest(),
                'context_removed': indices[0] != 0, 'raw_count': len(raw),
                'frame_normalization': FRAME_NORMALIZATION}

    def view(self, job_id, index, stage, *, job=None, preview=None):
        job = job if job is not None else self.s.store.load(job_id)
        run = self.run_record(job, index, stage)
        evidence = self.evidence(job, index, stage) if preview is None else preview
        if run.accepted:
            if preview is None:
                self.accepted_frames(job, index, stage)
            if run.accepted['token'] != evidence['token']:
                raise ConflictError('片段原始内容已改变，已采用记录不能用于新内容')
        edge = transition(job.request.open_plan.plan, stage)
        return {**evidence, **({'transition': edge, 'state_image': confirmed_state(job.request.open_plan.plan, stage, run)} if edge else {}),
                'stage_index': stage, 'candidate_index': index, 'state': run.state,
                'definition': job.request.open_plan.plan.stages[stage].model_dump(mode='json'),
                'fps': job.action.fps, 'review': run.review, 'accepted': run.accepted, 'state_checkpoint': run.state_checkpoint, 'repairs':run.repairs}

    def inspect(self, job_id, index, stage):
        job = self.s.store.load(job_id)
        run = self.run_record(job,index,stage)
        if run.state == 'reviewing':
            with self.s.store.locked_job(job_id) as current:
                r = self.run_record(current,index,stage)
                r.review = {**(r.review or {}), 'state':'unknown', 'verdict':'uncertain',
                            'summary':'分段视觉请求曾被中断，未自动重发；请检查真实帧后裁决。'}
                r.state = 'awaiting_review'; current.plan_control.enabled = False
                current.plan_control.message = '分段检查曾中断，等待实际画面确认'
            return
        if run.state != 'complete': return
        evidence = self.evidence(job,index,stage)
        from .motion_evidence import measurements
        prop_context = prop_review_context(job.request.open_plan, stage)
        metrics = measurements([self.s.store.resolve_job_path(job_id,f['path']).read_bytes() for f in evidence['frames']],job.action.fps, prop_context.get('interactable'),
            (self.s.store.job_dir(job_id) / 'input/reference.png'))
        from .prop_measurements import tracked_measurements, guard_measurements
        cues = tracked_measurements(self.s, job, index, stage, evidence['token'])
        if cues:
            metrics['tracked_parts'] = cues
        with self.s.store.locked_job(job_id) as current:
            r = self.run_record(current,index,stage)
            r.state = 'reviewing'
            r.review = {'state':'running','verdict':'uncertain','token':evidence['token'],'requests':[],'motion_evidence':metrics}
            if job.request.open_plan.spec.review_protocol == 'experts_v1':
                r.review['protocol'] = 'experts_v1'
            current.plan_control.message = f'正在检查第 {stage+1} 段实际姿势与运动'
        try:
            if self.s._candidate(job,index).diagnostic_only:
                report = {'state':'diagnostic', 'verdict':'uncertain', 'summary':'诊断片段未调用视觉模型，需确认流程。'}
                if job.request.open_plan.spec.review_protocol == 'experts_v1':
                    from .production_review import diagnostic_report
                    report.update(diagnostic_report())
            else:
                paths = [self.s.store.resolve_job_path(job_id,f['path']) for f in evidence['frames']]
                reference = self.s.store.job_dir(job_id)/'input/reference.png'
                pictures = evidence_panels(paths,reference,job.action.fps)
                # Also show the accepted input. Original appearance is never replaced by a drifted input.
                input_path = reference if not stage else self.s.store.resolve_job_path(job_id,self.run_record(job,index,stage-1).accepted['frames'][-1]['path'])
                pictures += [{'type':'input_text','text':'INPUT POSE, before frame 1; not a generated frame. Compare continuity to this accepted image.'},image_part(raster(input_path,256))]
                target = next((t for t in job.request.open_plan.end_targets if t.stage == stage),None)
                if target:
                    pictures += [{'type':'input_text','text':'TARGET POSE GUIDE, NOT a generated frame. Verify whether actual frames approach it; do not claim exact pixel equality. Human target note: '+target.note},image_part(raster(self.s.store.job_dir(job_id)/'targets'/target.filename,256))]
                observations = self.call(job_id,index,stage,'observe',observation_content(pictures, interactable=bool(prop_context), segment=True),Observations,len(paths))
                if [f.frame for f in observations.frames] != list(range(1,len(paths)+1)):
                    raise ValidationHarnessError('分段逐帧观察不完整或顺序错误')
                with self.s.store.locked_job(job_id) as current:
                    self.run_record(current,index,stage).review['observations'] = observations.model_dump(mode='json')
                definition = job.request.open_plan.plan.stages[stage]
                contract = {**prop_context, 'segment':definition.model_dump(mode='json'),
                    'appearance':job.request.open_plan.plan.quality.appearance_contract,
                    'user_request':job.request.open_plan.spec.description,
                    'pixel_cues_not_verdict':metrics,
                    'seconds_per_frame':1/job.action.fps, 'observations':observations.model_dump(mode='json')}
                from .adjustment_review import add_accepted_goals
                contract=add_accepted_goals(contract,self.s._candidate(job,index),stage)
                audit = self.call(job_id,index,stage,'audit',audit_content(pictures,contract,job.action.fps,segment=True),Audit,len(paths))
                if {c.dimension for c in audit.checks} != set(review_dimensions(prop_context)) or any(f > len(paths) for c in audit.checks for f in c.frames):
                    raise ValidationHarnessError('分段验收证据无效')
                verdict,checks,summary = grounded_audit(audit,len(paths))
                report = {'state':'complete','verdict':verdict,'checks':checks,'summary':summary,'model_audit':audit.model_dump(mode='json')}
                if job.request.open_plan.spec.review_protocol == 'experts_v1':
                    from .production_review import ProductionReview
                    report = ProductionReview(self.s, job_id, index, stage=stage).finish(report,
                        lambda phase, content, schema, count: self.call(job_id,index,stage,phase,content,schema,count),
                        expected_token=evidence['token'], expected_fps=job.action.fps)
                else:
                    report = guard_measurements(report, cues)
        except Exception as exc:
            report = {'state':'failed','verdict':'uncertain','summary':str(exc) if isinstance(exc,ValidationHarnessError) else '分段视觉检查未完成，未自动重试；请人工检查。'}
        with self.s.store.locked_job(job_id) as current:
            r = self.run_record(current,index,stage)
            r.review.update(report); r.state = 'awaiting_review'
            current.plan_control.enabled = False
            current.plan_control.message = f'第 {stage+1} 段已保存，等待确认实际姿势后继续'
            current.touch('open_motion_checkpoint_ready',candidate_index=index,stage=stage)

    def call(self, job_id, index, stage, phase, content, schema, count):
        with self.s.store.locked_job(job_id) as job:
            if review_call_count(job) >= job.request.open_plan.spec.budget.max_review_calls:
                raise ValidationHarnessError('视觉调用达到已授权上限，未继续请求')
            profile = self.registry.profile('reviewer',job.request.open_plan.model_snapshot)
            request = {'phase':phase,'state':'submitting','profile':profile.model_dump(mode='json')}
            if job.request.open_plan.spec.review_protocol == 'experts_v1':
                request['input_sha256'] = digest(content)
            self.run_record(job,index,stage).review['requests'].append(request)
        receipt = {}
        try:
            result, metadata = self.registry.send('reviewer',content,schema,count,snapshot=job.request.open_plan.model_snapshot,
                schema_name='open_motion_checkpoint',on_response=receipt.update,
                **({'interactable': True} if job.request.open_plan.plan.quality.interactable else {}))
            request.update(state='complete',**metadata)
            if job.request.open_plan.spec.review_protocol == 'experts_v1':
                request['response'] = result.model_dump(mode='json')
            return result
        finally:
            if request['state'] == 'submitting': request.update(state='failed_request' if receipt.get('http_status') else 'invalid_response' if receipt.get('response_id') or receipt.get('output_sha256') else 'failed_or_unknown',**receipt)
            with self.s.store.locked_job(job_id) as current:
                self.run_record(current,index,stage).review['requests'][-1] = request

    def decide(self, job_id, index, stage, *, token, note, decision, acknowledge=False, reviewer='user', anchor_frame=None, acknowledge_trim=False,human_seconds=None):
        if decision not in {'accept','reject','accept_state'} or len(note.strip()) < 4:
            raise ValidationHarnessError('请填写实际检查结论并选择确认或不合格')
        with self.s.store.operation_lock(job_id,'open_plan',timeout_seconds=0.2):
            job = self.s.store.load(job_id); run = self.run_record(job,index,stage)
            evidence = self.evidence(job,index,stage)
            end = len(evidence['frames']) - 1 if anchor_frame is None else anchor_frame
            if type(end) is not int or not 0 <= end < len(evidence['frames']):
                raise ValidationHarnessError('请选择当前片段中真实存在的锚点帧')
            pinned = run.state_checkpoint
            if pinned and decision != 'reject':
                if end != pinned['frame'] or evidence['frames'][end]['sha256'] != pinned['sha256']:
                    raise ConflictError('已确认的状态帧与所选锚点不一致')
                self.snapshot_bytes(job_id, pinned)
            if decision == 'accept' and end < len(evidence['frames'])-1 and not acknowledge_trim:
                raise ValidationHarnessError('选择提前到达的姿势时，须明确确认截取范围；原始尾帧会完整保留')
            if evidence['token'] != token:
                raise ConflictError('片段或输入姿势已改变，请重新查看；旧结论不可沿用')
            if pinned and decision == 'accept_state':
                return job  # Same selected frame, verified against the current version.
            if run.state == 'accepted' and decision == 'accept' and run.accepted['token'] == token:
                if run.accepted.get('selected_anchor_frame',len(evidence['frames'])-1) != end:
                    raise ConflictError('该片段已锁定为其他锚点，不能重复确认改写')
                self.accepted_frames(job,index,stage)
                return job  # Idempotent response recovery, never re-enable a paused task.
            if run.state != 'awaiting_review':
                raise ConflictError('当前片段不能重复裁决或绕过未完成的检查')
            from .adjustments import pending_adjustment
            if pending_adjustment(self.s,job,index,stage):raise ConflictError('请先采用备选或保留原版，再确认当前片段')
            if any(a['state'] in {'submitting','pending','unknown','awaiting_review'} for a in run.repairs):
                raise ConflictError('请先处理局部修复预览或未知请求，再确认原片段')
            if run.review.get('token') != token:
                raise ConflictError('视觉报告与实际帧不一致，请保留原记录并重新制定方案')
            if decision == 'accept' and run.review.get('verdict') != 'pass' and not acknowledge:
                raise ValidationHarnessError('模型意见未通过；需实际检查后明确接受提醒并写明依据')
            if decision == 'accept_state':
                if not job.request.open_plan.plan.quality.interactable:
                    raise ValidationHarnessError('独立确认状态帧仅用于交互物合同')
                state_check = next((c for c in run.review.get('checks', []) if c['dimension'] == 'state_frame'), {})
                if (state_check.get('status') != 'pass' or state_check.get('confidence', 0) < .85
                        or end + 1 not in state_check.get('frames', [])) and not acknowledge:
                    raise ValidationHarnessError('所选状态帧缺少通过的帧级意见，请实际检查并确认提醒')
                frame = evidence['frames'][end]
                data = self.s.store.resolve_job_path(job_id, frame['path']).read_bytes()
                if hashlib.sha256(data).hexdigest() != frame['sha256']:
                    raise ConflictError('所选状态帧发生变化')
                path = self.s.store.job_dir(job_id) / 'checkpoints' / f'c{index}' / f's{stage}-{token[:20]}-state-{end}.png'
                self.s._atomic_write_bytes(path, data)
                with self.s.store.locked_job(job_id) as current:
                    self.run_record(current,index,stage).state_checkpoint = {
                        **frame, 'frame': end, 'token': token,
                        'path': path.relative_to(self.s.store.job_dir(job_id)).as_posix(), 'note': note.strip(),
                        'human_seconds':human_seconds,'reviewer': reviewer, 'accepted_at': utc_now(), 'acknowledge_warnings': acknowledge}
                    current.plan_control.enabled = False
                    current.plan_control.message = '状态帧已锁定，过渡仍待修复或确认'
                    current.touch('open_motion_state_frame_accepted', candidate_index=index, stage=stage, frame=end)
                return current
            snapshot = None
            if decision == 'accept':
                # Keep Windows paths short; full identity and integrity hashes stay in the record.
                root = self.s.store.job_dir(job_id)/'checkpoints'/f'c{index}'/f's{stage}-{token[:20]}-{end}'
                root.mkdir(parents=True,exist_ok=True)
                frozen = []
                for n, item in enumerate(evidence['frames'][:end+1]):
                    data = self.s.store.resolve_job_path(job_id,item['path']).read_bytes()
                    if hashlib.sha256(data).hexdigest() != item['sha256']: raise ConflictError('确认期间帧发生变化')
                    path = root/f'frame_{n:03d}.png'
                    if path.exists() and path.read_bytes() != data: raise ConflictError('已有锁定快照不同，禁止覆盖')
                    self.s._atomic_write_bytes(path,data)
                    frozen.append({**item,'path':path.relative_to(self.s.store.job_dir(job_id)).as_posix()})
                snapshot = {**evidence,'frames':frozen,'anchor_sha256':frozen[-1]['sha256'],
                            'selected_anchor_frame':end,'excluded_tail':evidence['frames'][end+1:],
                            'selection_policy':'explicit_human_endpoint','acknowledge_trim':acknowledge_trim,
                            'note':note.strip(),'reviewer':reviewer,'accepted_at':utc_now(),'acknowledge_warnings':acknowledge}
            with self.s.store.locked_job(job_id) as current:
                r = self.run_record(current,index,stage)
                r.state = 'accepted' if snapshot else 'rejected'; r.accepted = snapshot
                r.review['human_decision'] = {'decision':decision,'human_seconds':human_seconds,'note':note.strip(),'reviewer':reviewer,'token':token,'anchor_frame':end if snapshot else None}
                current.plan_control.enabled = bool(snapshot)
                current.plan_control.message = '实际姿势已锁定，继续已授权制作' if snapshot else '当前片段不合格，已停止后续制作；原始结果保留'
                if not snapshot:self.s._candidate(current,index).status = CandidateStatus.rejected
                self.s._refresh_job_status(current)
                current.touch('open_motion_checkpoint_decided',candidate_index=index,stage=stage,decision=decision)
            return current
