"""Bounded local edits; immutable sources, explicit preview/adoption and no rerolls."""
import hashlib
import io
from PIL import Image
from .contracts import digest, review_calls_per_check
from .drawing_receipts import poll_drawing, read_poll_receipt, repair_playback, response_usage
from ..errors import ConflictError, ValidationHarnessError, ProviderError
from ..jsonio import atomic_write_json
from ..models import CandidateStatus, utc_now
from ..providers.account import AccountSlotBusy
from ..providers.base import ProviderRequest, PollStatus


# Same tiers as motion alternatives, so tool usage can be counted in one place.
REPAIR_LEVELS = {'appearance': 'restricted_generation', 'transition': 'window_redraw'}


def raw_repair_name(index):
    return f'frame_{index:03d}.png'


def generation_calls(job):
    return sum(r.submission_attempts + len(r.repairs) for c in job.candidates for r in c.plan_execution.stages)


def repair_request(reference, window, after, prompt, seed, mode):
    """Explicit context slots in edit mode are NEVER treated as playback frames."""
    if mode == 'appearance':
        with Image.open(io.BytesIO(reference)) as image:limit=edit_window_limit(*image.size)
        if len(window)<2 or len(window)%2 or len(window)>limit:raise ValidationHarnessError(f'此尺寸外观修复每次支持2至{limit}个连续偶数帧，另外保留两张参考图')
        frames = (reference, *window, after)
        instruction = ('Slot 1 is appearance reference, last slot is continuity context, neither is playback. '
                       'Edit ONLY middle slots; retain their existing poses, timing and camera. '+prompt)
        return ProviderRequest(reference_image=reference,edit_frames=frames,prompt=instruction,frame_count=len(frames),seed=seed)
    return ProviderRequest(reference_image=window[0],last_frame=window[-1],prompt=prompt,frame_count=len(window),seed=seed)


def edit_window_limit(width,height):
    side=max(width,height)
    total=16 if side<=64 else 9 if side<=80 else 4
    return ((total-2)//2)*2


class LocalRepairs:
    def __init__(self,service): self.s=service;self.store=service.store

    def run(self,job,index,stage):
        from .checkpoints import Checkpoints
        return Checkpoints(self.s).run_record(job,index,stage)

    def read_frames(self,job_id,items):
        result=[]
        for item in items:
            data=self.store.resolve_job_path(job_id,item['path']).read_bytes()
            if hashlib.sha256(data).hexdigest()!=item['sha256']:raise ConflictError('修复依据或结果图片已改变')
            result.append(data)
        return result

    def create(self,job_id,index,stage,*,token,start,end,note,mode,request_key,authorized,provider,with_job=False):
        from .checkpoints import Checkpoints,review_call_count
        if not authorized:raise ValidationHarnessError('局部修复会增加一次 PixelLab 请求，须明确授权')
        if mode not in {'appearance','transition'} or not 4 <= len(note.strip()) <= 700:
            raise ValidationHarnessError('请选择外观或运动修复，并描述实际缺陷')
        with self.store.operation_lock(job_id,'open_plan',timeout_seconds=0.2):
            job=self.store.load(job_id);run=self.run(job,index,stage)
            identity=digest({'token':token,'start':start,'end':end,'mode':mode,'note':note})
            for attempt in run.repairs:
                if attempt['request_key']==request_key:
                    if attempt['identity']!=identity:raise ConflictError('同一修复请求编号的内容不同')
                    return (attempt, job) if with_job else attempt
            candidate=self.s._candidate(job,index)
            from .experiment_policy import require_tool
            require_tool(self.s,job,REPAIR_LEVELS[mode])
            from .adjustments import pending_adjustment
            if pending_adjustment(self.s,job,index,stage):raise ConflictError('请先处理当前修改备选')
            if any(a['state'] in {'submitting','pending','unknown','awaiting_review'} for a in run.repairs):raise ConflictError('先处理已有修复，不创建重复请求')
            if run.state not in {'awaiting_review','rejected'} or candidate.frames or any(r.submission_attempts for r in candidate.plan_execution.stages[stage+1:]):
                raise ConflictError('只修复当前未锁定片段；后段已执行时需新版本重新核对依赖')
            evidence=Checkpoints(self.s).evidence(job,index,stage)
            if token!=evidence['token']:raise ConflictError('片段已改变，请重新检查')
            if run.state_checkpoint and start <= run.state_checkpoint['frame'] <= end:
                raise ValidationHarnessError('修复范围包含已确认的状态帧')
            count=end-start+1
            maximum=edit_window_limit(job.character.cell_width,job.character.cell_height) if mode=='appearance' else 16
            minimum=2 if mode=='appearance' else 4
            if type(start) is not int or type(end) is not int or start<1 or end>=len(evidence['frames'])-1 or count<minimum or count%2 or count>maximum:
                raise ValidationHarnessError(f'此尺寸与修复方式支持{minimum}至{maximum}个内部连续偶数帧；首末帧保留用于核对接缝')
            future=sum(r.submission_attempts==0 for c in job.candidates for r in c.plan_execution.stages)
            if len(run.repairs)>=2 or generation_calls(job)+1+future>job.request.open_plan.spec.budget.max_generation_calls:
                raise ValidationHarnessError('修复次数或已授权生成预算已用完；不会自动追加')
            remaining=sum(r.state!='accepted' for c in job.candidates for r in c.plan_execution.stages)
            finals=sum(not c.frames for c in job.candidates)
            if review_call_count(job)+review_calls_per_check(job.request.open_plan.spec)*(remaining+finals)>job.request.open_plan.spec.budget.max_review_calls:
                raise ValidationHarnessError('视觉预算不足以重新检查当前片段、后续片段及整段；不会跳过检查')
            base=self.read_frames(job_id,evidence['frames']);reference=(self.store.job_dir(job_id)/'input/reference.png').read_bytes()
            if hashlib.sha256(reference).hexdigest()!=job.reference_sha256:raise ConflictError('参考图已改变')
            from .execution import stage_seed
            seed=stage_seed(candidate.seed,stage)
            request=repair_request(reference,base[start:end+1],base[end+1],note.strip(),seed,mode)
            self.s._check_submission_quota(job_id,index,provider,phase_frame_count=request.frame_count)
            number=len(run.repairs);folder=self.store.job_dir(job_id)/'repairs'/f'c{index}s{stage}r{number}'
            folder.mkdir(parents=True,exist_ok=True)
            attempt={'number':number,'request_key':request_key,'identity':identity,'base_token':token,'base_frames':evidence['frames'],
                'start':start,'end':end,'mode':mode,'repair_level':REPAIR_LEVELS[mode],'note':note.strip(),'seed':seed,'state':'submitting','folder':folder.relative_to(self.store.job_dir(job_id)).as_posix(),
                'input_count':request.frame_count,'created_at':utc_now().isoformat(),'requests':1,'source_preserved':True}
            atomic_write_json(folder/'intent.json',{**attempt,'prompt':request.prompt,'input_hashes':[hashlib.sha256(b).hexdigest() for b in (request.edit_frames or (request.reference_image,request.last_frame))]})
            with self.store.locked_job(job_id) as current:
                self.run(current,index,stage).repairs.append(attempt);self.run(current,index,stage).state='repairing'
                c=self.s._candidate(current,index);c.status=CandidateStatus.provider_pending;c.error=None
                c.submission_attempts=sum(r.submission_attempts+len(r.repairs) for r in c.plan_execution.stages)
                current.plan_control.enabled=False;current.plan_control.message='正在局部修复，原片段保留'
                self.s._refresh_job_status(current);current.touch('motion_local_repair_requested',stage=stage,candidate_index=index)
            try:
                submitted=provider.submit(request)
            except AccountSlotBusy:
                with self.store.locked_job(job_id) as current:
                    restored=self.run(current,index,stage)
                    restored.repairs.pop()
                    restored.state=run.state
                    c=self.s._candidate(current,index)
                    c.status=candidate.status;c.error=candidate.error;c.submission_attempts=candidate.submission_attempts
                    current.plan_control.enabled=job.plan_control.enabled;current.plan_control.message=job.plan_control.message
                    self.s._refresh_job_status(current);current.touch('motion_local_repair_not_submitted',stage=stage,candidate_index=index)
                raise
            except Exception as exc:
                with self.store.locked_job(job_id) as current:
                    a=self.run(current,index,stage).repairs[number]
                    a['state']='unknown' if not isinstance(exc,ProviderError) or exc.details.get('submission_unknown') else 'failed'
                    a['error']=exc.as_dict() if isinstance(exc,ProviderError) else {'code':'submission_unknown','message':'修复提交结果未知，禁止重发'}
                    if isinstance(exc, ProviderError):
                        a['usage'] = response_usage(exc.details.get('response'))
                        if exc.details.get('provider_job_id'):
                            a['provider_job_id'] = exc.details['provider_job_id']
                    self.run(current,index,stage).state='awaiting_review';self.s._candidate(current,index).status=CandidateStatus.created
                    current.plan_control.message='局部修复未完成；请核对原请求，原片段保留'
                raise
            with self.store.locked_job(job_id) as current:
                a=self.run(current,index,stage).repairs[number]
                a.update(state='pending', provider_job_id=submitted.provider_job_id, usage=response_usage(submitted.raw_response))
            atomic_write_json(folder/'request.json',submitted.request_record);atomic_write_json(folder/'response.json',submitted.raw_response)
            return (a, current) if with_job else a

    def poll(self,job_id,index,stage,provider):
        job=self.store.load(job_id);run=self.run(job,index,stage);a=run.repairs[-1]
        if a['state']=='submitting':
            with self.store.locked_job(job_id) as current:
                r=self.run(current,index,stage);r.repairs[-1]['state']='unknown';r.state='awaiting_review'
                self.s._candidate(current,index).status=CandidateStatus.created;current.plan_control.enabled=False
                current.plan_control.message='局部修复提交曾中断，未自动重发'
            return
        if a['state']!='pending':return
        folder = self.store.resolve_job_path(job_id, a['folder'])
        update = {}
        try:
            result = poll_drawing(folder, provider, a['provider_job_id'], (job.character.cell_width, job.character.cell_height),
                                  raw_repair_name, self.s._atomic_write_bytes, usage=a.get('usage'))
            if result['status'] == PollStatus.pending:
                self._record_usage(job_id, index, stage, a, result['usage'])
                return
            items = [{'path': (folder / item['file']).relative_to(self.store.job_dir(job_id)).as_posix(),
                      'sha256': item['sha256'], 'repair_index': item['raw_index']} for item in result['frames']]
            update.update(usage=result['usage'], raw_frames=items, raw_count=result['raw_count'],
                          provider_status=result['provider_status'], invalid_raw_indices=result['invalid_frames'])
            if result['status'] == PollStatus.failed:
                raise ValidationHarnessError('修复请求失败，原始片段保留',details=result['error'] or {})
            base = self.read_frames(job_id, a['base_frames'])
            _, indices = repair_playback(folder, result, raw_repair_name, a['input_count'], a['mode'], base[a['start']])
            window = [items[i] for i in indices]
            combined=[dict(x) for x in a['base_frames']]
            for i,item in enumerate(window,a['start']):combined[i]={**item,'raw_index':combined[i]['raw_index'],'repair_attempt':a['number']}
            preview_token=digest({'base':a['base_token'],'attempt':a['number'],'frames':combined})
            update.update(state='awaiting_review', proposed_frames=combined, token=preview_token, playback_raw_indices=list(indices))
        except ProviderError:
            receipt = read_poll_receipt(folder / 'poll-receipt.json', a['provider_job_id'])
            self._record_usage(job_id, index, stage, a, response_usage(receipt))
            raise
        except (ConflictError,ValidationHarnessError) as exc:
            receipt = read_poll_receipt(folder / 'poll-receipt.json', a['provider_job_id'])
            update.update(state='failed', error=exc.as_dict(), usage=response_usage(update) or response_usage(receipt) or a.get('usage', {}))
        atomic_write_json(folder/'result.json',update)
        with self.store.locked_job(job_id) as current:
            r=self.run(current,index,stage);r.repairs[-1].update(update);r.state='awaiting_review'
            self.s._candidate(current,index).status=CandidateStatus.created;current.plan_control.enabled=False
            current.plan_control.message = ('修复预览已保存，请检查整段与两侧接缝后选择采用或保留原片段'
                                            if update['state'] == 'awaiting_review' else '修复未完成，原片段和绘图回执已保留')
            self.s._refresh_job_status(current);current.touch('motion_local_repair_saved',stage=stage,candidate_index=index)

    def _record_usage(self, job_id, index, stage, attempt, usage):
        if usage and usage != attempt.get('usage'):
            with self.store.locked_job(job_id) as job:
                self.run(job, index, stage).repairs[attempt['number']]['usage'] = usage

    def decide(self,job_id,index,stage,number,token,note,decision):
        from .checkpoints import Checkpoints
        if decision not in {'accept','reject'} or len(note.strip())<4:raise ValidationHarnessError('请写明整段与接缝的实际检查结果')
        with self.store.operation_lock(job_id,'open_plan',timeout_seconds=0.2):
            job=self.store.load(job_id);run=self.run(job,index,stage)
            if not 0<=number<len(run.repairs):raise ValidationHarnessError('修复记录不存在')
            a=run.repairs[number]
            if a['state'] in {'unknown','failed'} and decision=='reject' and token==a['base_token']:
                with self.store.locked_job(job_id) as current:
                    self.run(current,index,stage).repairs[number].update(state='rejected',human_note=note.strip(),unresolved_request_preserved=True)
                return current
            if a.get('token')!=token:raise ConflictError('修复预览已改变')
            if a['state']==('accepted' if decision=='accept' else 'rejected'):return job
            if a['state']!='awaiting_review' or run.state!='awaiting_review':raise ConflictError('此修复当前不可采用')
            if Checkpoints(self.s).evidence(job,index,stage)['token']!=a['base_token']:raise ConflictError('修复所依据的原片段已改变')
            self.read_frames(job_id,a['proposed_frames'])
            with self.store.locked_job(job_id) as current:
                r=self.run(current,index,stage);attempt=r.repairs[number]
                attempt.update(state='accepted' if decision=='accept' else 'rejected',human_note=note.strip(),decided_at=utc_now().isoformat())
                if decision=='accept':
                    r.active_frames=attempt['proposed_frames'];r.review_history.append(r.review or {});r.review=None;r.accepted=None;r.state='complete'
                current.plan_control.enabled=False;self.s._candidate(current,index).status=CandidateStatus.created
                current.plan_control.message='采用修复版本，重新检查整段；仍须确认本段' if decision=='accept' else '保留原片段，失败修复已留存'
                self.s._refresh_job_status(current);current.touch('motion_local_repair_decided',stage=stage,candidate_index=index)
            return current
