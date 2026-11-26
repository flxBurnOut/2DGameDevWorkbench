"""Frozen, bounded attack phases; never reroll a phase automatically."""
from __future__ import annotations
import hashlib
import io
import math
import shutil
from pathlib import Path
from PIL import Image
from .errors import ConflictError, ValidationHarnessError, ProviderError
from .jsonio import atomic_write_json, read_json
from .models import CandidateStatus, utc_now
from .providers.base import ProviderRequest, PollStatus
from .providers.account import AccountSlotBusy, animation_intent_id
from .grip_contract import grip_rule
from .prompts import character_identity_parts


def segment_counts(action):
    n=action.generation_frame_count
    if (action.generation_strategy not in {'two_stage_attack','three_stage_attack','reference_anchored_attack'} or action.action_id not in {'attack','attack_in_air'}
            or action.loop or n<8 or n>16 or n%2 or action.provider_frame_selection):
        return []
    if action.generation_strategy=='reference_anchored_attack' and action.action_id!='attack':
        return []
    if action.generation_strategy=='three_stage_attack' and n>=12:
        return [4,n-8,4]
    # Grounded 16-frame attacks use 6+10; shorter requests retain legal even stages.
    first=6 if action.generation_strategy=='reference_anchored_attack' and n>=14 else 4
    return [first,n-first]


def phase_timing(action):
    """Requested timing, not a classification of generated frames."""
    counts=segment_counts(action)
    if not counts:
        return {}
    if len(counts)==3:
        return dict(zip(['preparation','attack','recovery'],counts))
    recovery=max(1,sum(counts)//4)
    return {'preparation':counts[0], 'attack':counts[1]-recovery, 'recovery':recovery}


def phase_prompts(job):
    if job.action.generation_strategy=='reference_anchored_attack':
        return reference_anchored_prompts(job)
    if len(segment_counts(job.action))==3:
        return controlled_phase_prompts(job)
    air=job.action.action_id=='attack_in_air'
    timing=phase_timing(job.action)
    preparation=timing['preparation'];attack=timing['attack'];recovery=timing['recovery']
    motion=(
        [f'In {preparation} frames, prepare ONE airborne sword attack along a continuous flight arc. Draw the sword back, ready to strike by the last frame; no prolonged hold.',
         f'START THE STRIKE NOW. Use the first {attack} frames for ONE decisive airborne swing, full extension and follow-through; final {recovery} frames recover in the air. Accelerate through contact, then decelerate; body follows the blade. No new charge or second swing.']
        if air else
        [f'In {preparation} frames, raise the sword from the low ready pose to behind the shoulder. Finish visibly charged; hold only briefly at the end. Wind-up only, no forward cut or prolonged idle.',
         f'START THE STRIKE NOW. Use the first {attack} frames for ONE powerful forward high-to-low chop AND its follow-through; final {recovery} frames lower the SAME gripping hand to ready. Cut decisively early, then decelerate; body follows the blade. No new charge or second swing.'])
    identity=' '+ ' '.join(character_identity_parts(job.character)) + ' Fixed side camera, facing '+job.character.facing+'. Transparent background.'
    note=(' Style/rhythm request: '+job.request.action_description.strip()) if job.request.action_description else ''
    ownership = " " + grip_rule(job.character.weapon_hand,"this segment's FIRST frame")
    prompts=[text+ownership+identity+note for text in motion]
    if any(len(p)>1000 for p in prompts):
        raise ValidationHarnessError('阶段提示词超过 1000 字符；请缩短本次动作补充说明，尚未生成')
    return prompts



def controlled_phase_prompts(job):
    """Each request has one motion job, with a mobile arm and stable ownership."""
    air=job.action.action_id=='attack_in_air'
    motion=(
        ['Draw the sword back during ONE airborne arc; finish ready to cut, with no waiting or forward swing.',
         'START THE STRIKE NOW: swing ONCE immediately to full extension. Accelerate the blade, torso and shoulder together, then decelerate into follow-through. End at the end of the cut, no charge or new jump.',
         'RECOVERY ONLY: retract the extended sword toward the body and settle the same arm, smoothly along the existing airborne arc. Visible recovery throughout, no held strike pose or second attack.']
        if air else
        ['Raise the sword continuously from ready to BEHIND the shoulder; finish charged by the LAST frame. Torso and elbow coil together. No forward cut or prolonged hold.',
         'START THE STRIKE NOW: drive ONE high-to-low forward chop immediately, torso and elbow following the blade. Reach full extension early, then decelerate along the SAME arc into follow-through. No charge or second cut.',
         'RECOVERY ONLY: retract the sword and settle the torso from follow-through toward the LAST image. Move the SAME arm gradually throughout; do not hold the strike pose or snap to ready. No new cut.'])
    owner=job.character.weapon_hand
    who=(f"anatomical {owner.upper()} hand" if owner in {'left','right'} else
         'BOTH hands with unchanged leading/support roles' if owner=='both' else 'same physical hand(s) as the first image')
    grip=f' Keep weapon in {who}; free hand stays empty. Shoulder, elbow and wrist MUST MOVE; ownership stays fixed. No handoff or mirroring.'
    appearance=job.character.identity_description.strip()
    from .prompts import GENERIC_IDENTITIES
    if appearance in GENERIC_IDENTITIES: appearance=''
    identity=' Keep original outfit, body colors, helmet, proportions and sword; no added cape. '+appearance
    common=grip+identity+f' Fixed side view facing {job.character.facing}. Transparent background. No detached beams, flashes or projectiles.'
    note=(' Style: '+job.request.action_description.strip()) if job.request.action_description else ''
    prompts=[text+common+note for text in motion]
    if any(len(p)>1000 for p in prompts):
        raise ValidationHarnessError('阶段提示词超过 1000 字符；请缩短本次动作补充说明，尚未生成')
    return prompts



def reference_anchored_prompts(job):
    """Keep the existing visual anchors; add a small lunge to the continuous chop."""
    recovery=phase_timing(job.action)['recovery']
    motion=[
        'Raise the sword from the supplied low ready pose to a high position behind the shoulder. During this wind-up only, keep both feet at their FIRST-frame positions and keep the hips/torso facing as in the FIRST frame; no step, lunge or body turn. Finish visibly charged and ready to cut; hold briefly. This clip is the wind-up only.',
        f'START THE STRIKE NOW from the supplied charged pose. Drive ONE complete, powerful, fluid vertical chop forward/down in the first half, hips and torso driving the elbow and blade. Rear foot stays planted; lead foot makes ONE small forward lunge with the cut. Follow through low and decelerate; in the final {recovery} frames return the SAME lead foot and sword smoothly to the supplied final ready pose. Do not charge again.']
    owner=job.character.weapon_hand
    grip=(f' Keep the anatomical {owner.upper()} weapon hand throughout.' if owner in {'left','right'} else
          ' Keep both hands in their original leading/support roles.' if owner=='both' else
          ' Keep the SAME physical weapon hand throughout; free hand stays empty.')
    identity=job.character.identity_description.strip()
    from .prompts import GENERIC_IDENTITIES
    if not identity or identity in GENERIC_IDENTITIES:
        identity='Match the original armor colors, helmet, outfit, body proportions and sword design.'
    common=grip+' '+identity+f' Fixed side camera, facing {job.character.facing}. Transparent background.'
    note=(' Style: '+job.request.action_description.strip()) if job.request.action_description else ''
    prompts=[motion[0]+common+note,
             motion[1]+' FIRST image is the charged pose; LAST image anchors original body and weapon appearance. A continuous blade-following slash arc is allowed; keep the solid blade distinct.'+common+note]
    if any(len(p)>1000 for p in prompts):
        raise ValidationHarnessError('阶段提示词超过 1000 字符；请缩短本次动作补充说明，尚未生成')
    return prompts


def initialize(job):
    counts=segment_counts(job.action)
    if not counts or job.request.provider!='pixellab' or job.request.motion_repair or job.request.attack_segment:
        return
    prompts=phase_prompts(job)
    job.full_prompt="\n\n".join(f"Planned stage {i+1}: {p}" for i,p in enumerate(prompts))
    three=len(counts)==3
    anchored=job.action.generation_strategy=='reference_anchored_attack'
    timing=phase_timing(job.action)
    divisor=math.gcd(*timing.values())
    ratio=[n//divisor for n in timing.values()] if anchored else [1,2,1]
    for c in job.candidates:
        c.attack_sequence={'version':6 if anchored else 4 if three else 3,'maximum_submissions':len(counts),
            'rhythm':{'target_ratio':list(ratio),'requested_frames':dict(timing)},
            'grip_contract':{'weapon_hand':job.character.weapon_hand,'reference_sha256':job.reference_sha256},'stages':[
            {'name':name,'frame_count':n,'prompt':prompt,'state':'created','submission_attempts':0}
            for name,n,prompt in zip(['preparation','strike','recovery'] if three else ['preparation','strike_recovery'],counts,prompts)]}
        if anchored:
            c.attack_sequence['appearance_anchor']={'source':'original_reference','stage':1,'reference_sha256':job.reference_sha256}


class FixedAttackGeneration:
    def __init__(self,service):
        self.s=service;self.store=service.store

    def candidate(self,job,index):return self.s._candidate(job,index)

    def directory(self,job_id,index,stage):
        return self.store.job_dir(job_id)/'provider'/f'candidate_{index:02d}.sequence'/str(stage)

    def validate(self,c):
        seq=c.attack_sequence
        expected=3 if seq.get('version')==4 else 2
        if (seq.get('version') not in {1,2,3,4,5,6} or seq.get('maximum_submissions')!=expected or len(seq.get('stages',[]))!=expected
                or any(r.get('submission_attempts') not in {0,1} for r in seq['stages'])):
            raise ConflictError('攻击分段次数记录异常，已停止提交')
        if seq['version']>=2 and (seq.get('grip_contract',{}).get('weapon_hand') not in {'reference','left','right','both'} or len(seq.get('grip_contract',{}).get('reference_sha256',''))!=64):
            raise ConflictError('持刀手约束记录不完整，尚未提交')
        if seq['version'] in {3,5,6}:
            timing=seq.get('rhythm',{}).get('requested_frames',{})
            if (set(timing)!={'preparation','attack','recovery'} or any(type(n) is not int or n<1 for n in timing.values())
                    or timing['preparation']!=seq['stages'][0]['frame_count']
                    or timing['attack']+timing['recovery']!=seq['stages'][1]['frame_count']):
                raise ConflictError('攻击节奏与已保存的分段帧数不一致，尚未提交')
        if seq['version'] in {5,6} and seq.get('appearance_anchor')!={'source':'original_reference','stage':1,'reference_sha256':seq['grip_contract']['reference_sha256']}:
            raise ConflictError('原型视觉约束记录不完整，尚未提交')
        if seq['version']==4:
            counts=[r.get('frame_count') for r in seq['stages']]
            if (counts[0]!=4 or counts[2]!=4 or counts[1] not in {4,6,8}
                    or seq.get('rhythm',{}).get('requested_frames')!=dict(zip(['preparation','attack','recovery'],counts))
                    or [r.get('name') for r in seq['stages']]!=['preparation','strike','recovery']):
                raise ConflictError('攻击节奏与已保存的分段帧数不一致，尚未提交')
        return seq['stages']

    def saved_frames(self,job_id,index,stage):
        folder=self.directory(job_id,index,stage);manifest=read_json(folder/'frames.json')
        result=[]
        for i,item in enumerate(manifest['frames']):
            if item['filename']!=f'frame_{i:03d}.png':raise ConflictError('片段帧路径异常')
            path=folder/item['filename'];data=path.read_bytes()
            if hashlib.sha256(data).hexdigest()!=item['sha256']:raise ConflictError('已保存的片段帧发生变化')
            result.append(data)
        if not 2<=len(result)<=64:raise ValidationHarnessError('片段未提供足够的动画帧；未继续生成')
        return result

    def submit(self,job_id,index,stage,provider):
        with self.store.submission_lock(timeout_seconds=max(180,self.s.settings.http_timeout_seconds+60)):
            job=self.store.load(job_id);c=self.candidate(job,index);runs=self.validate(c);r=runs[stage]
            if r['state']!='created' or r['submission_attempts']:
                raise ConflictError('该攻击片段已提交，禁止重复生成')
            if shutil.disk_usage(self.s.settings.jobs_dir).free < 64*1024*1024:
                raise ValidationHarnessError('本地空间不足，尚未提交攻击片段')
            reference=(self.store.job_dir(job_id)/'input/reference.png').read_bytes()
            if hashlib.sha256(reference).hexdigest()!=job.reference_sha256:raise ConflictError('角色原图已改变')
            if c.attack_sequence.get('version',0)>=2 and c.attack_sequence['grip_contract']['reference_sha256']!=job.reference_sha256:
                raise ConflictError('持刀手约束的原图与当前任务不一致')
            first=reference if stage==0 else self.saved_frames(job_id,index,stage-1)[-1]
            # Anchor the continuous ground strike/recovery (v1/v5/v6), or final
            # ground recovery (v4), to the original. Air must not end in idle.
            endpoint=(stage==1 and c.attack_sequence['version'] in {1,5,6}) or (stage==2 and c.attack_sequence['version']==4)
            last=reference if endpoint and job.action.action_id=='attack' else None
            self.s._check_submission_quota(job_id,index,provider,phase_frame_count=r['frame_count'])
            folder=self.directory(job_id,index,stage);folder.mkdir(parents=True,exist_ok=True)
            request=ProviderRequest(reference_image=first,last_frame=last,prompt=r['prompt'],frame_count=r['frame_count'],
                seed=(c.seed+stage*104729)%(2**31-1) if c.seed is not None else None,transparent_background=job.character.transparent_background,
                local_submission_id=animation_intent_id(job_id,index,stage))
            atomic_write_json(folder/'submit.intent.json',{'maximum_submission_attempts':1,'stage':stage,'frame_count':r['frame_count'],
                'first_sha256':hashlib.sha256(first).hexdigest(),'last_sha256':hashlib.sha256(last).hexdigest() if last else None,
                'prompt':request.prompt,'seed':request.seed,'grip_contract':c.attack_sequence.get('grip_contract'),'rhythm':c.attack_sequence.get('rhythm')})
            with self.store.locked_job(job_id) as current:
                c=self.candidate(current,index);r=self.validate(c)[stage]
                if r['state']!='created' or r['submission_attempts']:raise ConflictError('片段已在其他进程提交')
                r.update(state='submitting',submission_attempts=1)
                current.generation_account=current.generation_account or getattr(provider,'account_fingerprint',None)
                c.status=CandidateStatus.submitting;c.provider_job_id=None;c.submission_attempts=sum(x['submission_attempts'] for x in self.validate(c))
                c.submission_started_at=utc_now();c.provider_name='pixellab';c.provider_model='animate-with-text-v3'
                c.raw_request_path=(folder/'submit.intent.json').relative_to(self.store.job_dir(job_id)).as_posix()
                current.generation_requested_at=current.generation_requested_at or utc_now()
                self.s._refresh_job_status(current);current.touch('attack_stage_submitting',candidate_index=index,stage=stage)
            try:submission=provider.submit(request)
            except AccountSlotBusy:raise
            except Exception as exc:
                unknown=not isinstance(exc,ProviderError) or bool(exc.details.get('submission_unknown'))
                with self.store.locked_job(job_id) as current:
                    c=self.candidate(current,index);self.validate(c)[stage].update(state='unknown' if unknown else 'failed')
                    c.status=CandidateStatus.submission_unknown if unknown else CandidateStatus.failed
                    if isinstance(exc,ProviderError):
                        c.provider_job_id=exc.details.get('provider_job_id')
                        c.usage=(exc.details.get('response') or {}).get('usage') or {}
                        self.validate(c)[stage].update(provider_job_id=c.provider_job_id,usage=c.usage)
                    c.error=exc.as_dict() if isinstance(exc,ProviderError) else {'code':'submission_unknown','message':'提交结果未知，不会重试'}
                    self.s._refresh_job_status(current);current.touch('attack_stage_submission_stopped',candidate_index=index,stage=stage)
                if isinstance(exc,ProviderError) and exc.details.get('submission_rejected'):return False
                raise
            # Save the remote ID before optional audit files.
            with self.store.locked_job(job_id) as current:
                c=self.candidate(current,index);self.validate(c)[stage].update(state='pending',provider_job_id=submission.provider_job_id)
                c.provider_job_id=submission.provider_job_id;c.provider_status=submission.status;c.submitted_at=utc_now()
                c.status=CandidateStatus.provider_pending;c.error=None;c.diagnostic_only=submission.diagnostic_only
                c.usage=submission.raw_response.get('usage') or {}
                self.validate(c)[stage]['usage']=c.usage
                self.s._refresh_job_status(current);current.touch('attack_stage_submitted',candidate_index=index,stage=stage,provider_job_id=submission.provider_job_id)
            atomic_write_json(folder/'submit.request.json',submission.request_record)
            atomic_write_json(folder/'submit.response.json',submission.raw_response)
            return True

    def poll(self,job_id,index,stage,provider,wait):
        job=self.store.load(job_id);c=self.candidate(job,index);r=self.validate(c)[stage]
        folder=self.directory(job_id,index,stage)
        if (folder/'frames.json').exists():
            self.saved_frames(job_id,index,stage)  # Recover saved paid bytes before any GET.
        else:
            result=provider.wait(r['provider_job_id']) if wait else provider.poll(r['provider_job_id'])
            if result.status==PollStatus.pending:return False
            if result.status==PollStatus.failed:
                with self.store.locked_job(job_id) as current:
                    c=self.candidate(current,index);self.validate(c)[stage].update(state='failed',error=result.error)
                    c.usage=result.usage or c.usage
                    self.validate(c)[stage]['usage']=c.usage
                    c.status=CandidateStatus.failed;c.error=result.error;self.s._refresh_job_status(current)
                return False
            manifest=[]
            for i,data in enumerate(result.images):
                with Image.open(io.BytesIO(data)) as im:
                    im.load()
                    if im.size!=(job.character.cell_width,job.character.cell_height):raise ValidationHarnessError('片段尺寸与原图不一致，保留已有结果')
                path=folder/f'frame_{i:03d}.png'
                if path.exists() and path.read_bytes()!=data:raise ConflictError('远端片段结果改变，原始文件已保留')
                self.s._atomic_write_bytes(path,data)
                manifest.append({'filename':path.name,'sha256':hashlib.sha256(data).hexdigest()})
            atomic_write_json(folder/'frames.json',{'provider_job_id':r['provider_job_id'],'frames':manifest,'usage':result.usage})
            self.saved_frames(job_id,index,stage)
        if c.attack_sequence['version'] in {4,5,6}:
            from .attack_timeline import select_phase
            try:
                select_phase(self.saved_frames(job_id,index,stage),r['frame_count'])
            except ValidationHarnessError as exc:
                with self.store.locked_job(job_id) as current:
                    item=self.candidate(current,index);self.validate(item)[stage].update(state='failed',error=exc.as_dict())
                    item.status=CandidateStatus.failed;item.error=exc.as_dict()
                    self.s._refresh_job_status(current);current.touch('attack_phase_count_stopped',candidate_index=index,stage=stage)
                raise
        with self.store.locked_job(job_id) as current:
            c=self.candidate(current,index);self.validate(c)[stage].update(state='complete')
            c.status=CandidateStatus.created if stage<len(self.validate(c))-1 else CandidateStatus.saving
            c.provider_completed_at=utc_now();c.error=None
            self.s._refresh_job_status(current);current.touch('attack_stage_saved',candidate_index=index,stage=stage)
        return True

    def assemble(self,job_id,index):
        job=self.store.load(job_id);c=self.candidate(job,index)
        runs=self.validate(c)
        if c.attack_sequence['version'] in {4,5,6}:
            from .attack_timeline import assemble_phases, assemble_anchored_phases
            args=([self.saved_frames(job_id,index,i) for i in range(len(runs))],
                  [r['frame_count'] for r in runs],[r['name'] for r in runs])
            if c.attack_sequence['version'] in {5,6}:
                reference=(self.store.job_dir(job_id)/'input/reference.png').read_bytes()
                combined,timeline=assemble_anchored_phases(*args,reference)
            else:
                combined,timeline=assemble_phases(*args)
            with self.store.locked_job(job_id) as current:
                item=self.candidate(current,index)
                item.attack_sequence.update(actual_frame_count=len(combined),timeline=timeline,
                    handoff_frame=timeline['phases'][1]['start'],handoff_frames=[p['start'] for p in timeline['phases'][1:]])
                item.status=CandidateStatus.saving;item.provider_job_id=runs[-1]['provider_job_id']
            if self.s._store_provider_frames(job_id,index,combined,diagnostic_only=c.diagnostic_only,expected_provider_job_id=runs[-1]['provider_job_id']):
                self.s.check_candidate(job_id,index)
            return
        first=self.saved_frames(job_id,index,0);last=self.saved_frames(job_id,index,1)
        def pixels(data):
            with Image.open(io.BytesIO(data)) as im:return im.convert('RGBA').tobytes()
        duplicate=pixels(first[-1])==pixels(last[0])
        combined=first+last[1:] if duplicate else first+last
        if len(combined)>64:raise ValidationHarnessError('完整攻击超过 64 帧，两个原始片段均已保留')
        with self.store.locked_job(job_id) as current:
            item=self.candidate(current,index);item.attack_sequence['join_duplicate_removed']=duplicate
            item.attack_sequence['actual_frame_count']=len(combined)
            item.attack_sequence['handoff_frame']=len(first) if duplicate else len(first)+1
            item.status=CandidateStatus.saving
            item.provider_job_id=self.validate(item)[1]['provider_job_id']
        if self.s._store_provider_frames(job_id,index,combined,diagnostic_only=c.diagnostic_only,expected_provider_job_id=c.provider_job_id):
            self.s.check_candidate(job_id,index)

    def recover(self,job_id,index,provider):
        """Only retrieve existing remote work; never submit the next segment here."""
        with self.store.operation_lock(job_id,'attack_sequence',timeout_seconds=1):
            job=self.store.load(job_id);c=self.candidate(job,index);runs=self.validate(c)
            if all(r['state']=='complete' for r in runs):
                self.assemble(job_id,index)
                return self.store.load(job_id)
            stage=next(i for i,r in enumerate(runs) if r['state']!='complete')
            if not c.provider_job_id or runs[stage]['state']=='created':
                raise ConflictError('下一段尚未提交；取回结果不会发起新的生成')
            with self.store.locked_job(job_id) as current:
                item=self.candidate(current,index)
                self.validate(item)[stage].update(state='pending',provider_job_id=item.provider_job_id)
                item.status=CandidateStatus.provider_pending
            if self.poll(job_id,index,stage,provider,False) and stage==len(runs)-1:self.assemble(job_id,index)
        return self.store.load(job_id)

    def advance(self,job_id,provider,*,wait=True,candidate_index=None):
        with self.store.operation_lock(job_id,'attack_sequence',timeout_seconds=1):
            job=self.store.load(job_id)
            if not self.s._same_generation_account(job,provider):return job
            targets=[candidate_index] if candidate_index is not None else [c.candidate_index for c in job.candidates]
            if any(c.candidate_index not in targets and c.status in {CandidateStatus.submitting,CandidateStatus.submission_unknown,CandidateStatus.provider_pending,CandidateStatus.saving} for c in job.candidates):
                raise ConflictError('另一个候选仍在执行，暂不能提交这个候选')
            for index in targets:
                existing=self.candidate(self.store.load(job_id),index)
                if existing.frames or existing.status in {CandidateStatus.failed,CandidateStatus.approved,CandidateStatus.rejected}:
                    continue
                for _ in range(len(self.validate(existing))+1 if wait else 1):
                    job=self.store.load(job_id);c=self.candidate(job,index);runs=self.validate(c)
                    if c.frames or c.status in {CandidateStatus.failed,CandidateStatus.approved,CandidateStatus.rejected}:break
                    if c.status in {CandidateStatus.submitting,CandidateStatus.submission_unknown}:
                        raise ConflictError('攻击片段提交结果未知，不会自动重试')
                    if all(r['state']=='complete' for r in runs):self.assemble(job_id,index);break
                    stage=next(i for i,r in enumerate(runs) if r['state']!='complete');r=runs[stage]
                    if r['state'] in {'unknown','submitting','failed'}:raise ConflictError('攻击片段已停止，不会重新提交')
                    if r['state']=='created':
                        try:
                            if not self.submit(job_id,index,stage,provider):break
                        except AccountSlotBusy as exc:
                            self.s._queue_candidate(job_id,index,exc,provider,stage=stage,selected_index=candidate_index)
                            return self.store.load(job_id)
                    if not self.poll(job_id,index,stage,provider,wait):break
                    if stage==len(runs)-1:self.assemble(job_id,index);break
                c=self.candidate(self.store.load(job_id),index)
                if not wait or c.status in {CandidateStatus.provider_pending,CandidateStatus.saving,CandidateStatus.created}:break
        from .motion_correction import MotionCorrection
        return MotionCorrection(self.s).advance(job_id,wait=wait)
