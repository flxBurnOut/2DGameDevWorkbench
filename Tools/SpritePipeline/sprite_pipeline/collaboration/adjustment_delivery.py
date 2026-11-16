"""Explicit adoption. Stage sources survive; complete clips get a new work version."""
import copy
import hashlib
from .contracts import digest
from .checkpoints import Checkpoints
from .visual_review import frame_digest
from .workspace import now
from ..jsonio import atomic_write_json
from ..models import CandidateStatus, JobStatus, utc_now
from ..errors import ConflictError, ValidationHarnessError


def adoption_note(task):
    return {k:copy.deepcopy(task[k]) for k in ('id','start','end','user_request','intent','intent_source','source_token','preview_token')}


def bound_review(task):
    report=copy.deepcopy(task['review'])
    report.update(adjustment_id=task['id'],preview_token=task['preview_token'],external_requests=copy.deepcopy(task['review_calls']),
                  external_budget=True,reviewed_fps=task['fps'],reviewed_intent_sha256=task['intent_sha256'])
    # Independent adjustment budget: never charge the parent ledger a second time.
    report.pop('requests',None)
    return report


def adopt_stage(manager,task):
    s=manager.s;job_id=task['source_job'];stage=task['stage'];index=task['candidate']
    with manager.store.operation_lock(job_id,'open_plan',timeout_seconds=.2):
        manager.verify(task,live=True)
        folder=manager.store.job_dir(job_id)/'adjustments'/task['id'];folder.mkdir(parents=True,exist_ok=True)
        proposed=copy.deepcopy(task['source_frames'])
        for i in task.get('local_frames',range(task['start'],task['end']+1)):
            data=(manager.folder(task)/task['proposed_frames'][i]['file']).read_bytes();path=folder/f'{i:03d}.png'
            if path.exists() and path.read_bytes()!=data:raise ConflictError('采用目录已有不同图片，未覆盖')
            s._atomic_write_bytes(path,data)
            proposed[i]={**proposed[i],'path':path.relative_to(manager.store.job_dir(job_id)).as_posix(),
                         'sha256':task['proposed_frames'][i]['sha256'],'adjustment_id':task['id']}
        with manager.store.locked_job(job_id) as job:
            candidate=s._candidate(job,index);r=candidate.plan_execution.stages[stage]
            r.review_history.append(r.review or {});r.active_frames=proposed;r.accepted=None;r.state='awaiting_review'
            r.adjustment_history.append(adoption_note(task))
            token=Checkpoints(s).evidence(job,index,stage)['token']
            r.review={**bound_review(task),'token':token}
            candidate.status=CandidateStatus.created;candidate.error=None
            job.plan_control.enabled=False;job.plan_control.message='已采用备选；检查结论已绑定，请确认本段后继续'
            s._refresh_job_status(job);job.touch('motion_adjustment_adopted',adjustment_id=task['id'],candidate_index=index,stage=stage)


def adopt_clip(manager, task):
    s=manager.s;work=manager.ws.load(task['work_id']);source=s.store.load(task['source_job'])
    candidate=s._candidate(source,task['candidate']);new_revision=work.revision+1
    if len(work.history)>=50:raise ValidationHarnessError('作品版本已达上限，不能覆盖历史')
    if not task.get('target_job'):
        task['target_job']=f"{utc_now().strftime('%Y%m%d')}_adjustment_{task['id']}_001"
        task['target_revision']=new_revision;manager.save(task)
    job_id=task['target_job'];root=s.store.job_dir(job_id)
    if not (root/'job.json').exists():
        for name in ('input','raw','repaired','previews','export','provider'):(root/name).mkdir(parents=True,exist_ok=True)
        # Copy only verified referenced data; no recursive copying of exports or other candidates.
        def copy_file(relative):
            old=s.store.resolve_job_path(source.job_id,relative)
            # A prior derived version may point into its published raw playback.
            # Do not prepopulate this new job's immutable provider-result directory.
            name=('adjustments/inherited/'+hashlib.sha256(relative.encode()).hexdigest()+'.png') if relative.startswith('raw/') else relative
            target=root/name;target.parent.mkdir(parents=True,exist_ok=True);s._atomic_write_bytes(target,old.read_bytes())
            return name
        for file,sha in source.input_sha256.items():
            data=(s.store.job_dir(source.job_id)/'input'/file).read_bytes()
            if hashlib.sha256(data).hexdigest()!=sha:raise ConflictError('源输入文件已改变')
            s._atomic_write_bytes(root/'input'/file,data)
        s._atomic_write_bytes(root/'input/reference.png',(manager.folder(task)/'reference.png').read_bytes())
        clone=source.model_copy(deep=True)
        c=candidate.model_copy(deep=True);c.candidate_index=1;c.candidate_id='candidate_01'
        for stage,r in enumerate(c.plan_execution.stages):
            from .execution import PlanGeneration
            raw=PlanGeneration(s).saved_frames(source.job_id,task['candidate'],stage)
            oldfolder=PlanGeneration(s).directory(source.job_id,task['candidate'],stage)
            newfolder=root/'provider'/'candidate_01.plan'/str(stage);newfolder.mkdir(parents=True,exist_ok=True)
            for i,data in enumerate(raw):s._atomic_write_bytes(newfolder/f'frame_{i:03d}.png',data)
            s._atomic_write_bytes(newfolder/'frames.json',(oldfolder/'frames.json').read_bytes())
            if r.state_checkpoint:
                r.state_checkpoint['path']=copy_file(r.state_checkpoint['path'])
            for f in (r.active_frames or [])+((r.accepted or {}).get('frames',[])):
                f['path']=copy_file(f['path'])
        for target in source.request.open_plan.end_targets:copy_file('targets/'+target.filename)
        clone.job_id=job_id;clone.revision=0;clone.created_at=utc_now();clone.updated_at=utc_now();clone.export=None
        clone.events=[];clone.generation_requested_at=None;clone.status=JobStatus.saving;clone.candidates=[c]
        clone.plan_control.enabled=False;clone.plan_control.message='修改备选经实际播放后采用，保留来源记录'
        clone.request.open_plan.revision=new_revision
        clone.request.open_plan.spec.candidate_count=1;clone.request.candidate_count=1
        clone.request.request_key='adjustment-'+task['id'];clone.request_fingerprint=digest(clone.request.model_dump(mode='json'))
        clone.action.frame_count=len(task['proposed_frames']);clone.action.provider_frame_count=None;clone.action.provider_frame_selection=[]
        clone.action.sheet_frame_cells=[];clone.action.sheet_columns=None;clone.action.sheet_rows=None
        c.frames=[];c.status=CandidateStatus.saving;c.provider_job_id=task['provider_job_id'];c.submission_attempts=0 if 'local_frames' in task else 1
        c.result_manifest_path=None;c.result_sha256=None;c.qa_completed_at=None;c.qa_input_sha256=None;c.qa_algorithm_version=None
        c.error=None;c.hard_failures=[];c.warnings=[];c.motion_review=None;c.qa_issue_baseline=None;c.qa_change_summary=None
        c.plan_execution.quality_review={'state':'pending','requests':[]}
        s.store.save(clone)
        images=[(manager.folder(task)/f['file']).read_bytes() for f in task['proposed_frames']]
        s._store_provider_frames(job_id,1,images,diagnostic_only=task['diagnostic'],expected_provider_job_id=task['provider_job_id'])
    cloned=s.store.load(job_id)
    if not cloned.candidates[0].frames:
        images=[(manager.folder(task)/f['file']).read_bytes() for f in task['proposed_frames']]
        s._store_provider_frames(job_id,1,images,diagnostic_only=task['diagnostic'],expected_provider_job_id=task['provider_job_id'])
    if s.store.load(job_id).candidates[0].status!=CandidateStatus.approved:
        with s.store.locked_job(job_id) as clone:
            c=clone.candidates[0]
            # The explicit full-clip adoption confirms these unchanged boundaries.
            for stage,r in enumerate(c.plan_execution.stages):
                row=c.plan_execution.timeline[stage]
                selected=[i-row['start'] for i in task.get('local_frames',range(task['start'],task['end']+1)) if row['start']<=i<row['start']+row['count']]
                if selected:
                    note=adoption_note(task);note['start']=selected[0];note['end']=selected[-1]
                    if not any(a['id']==task['id'] for a in r.adjustment_history):r.adjustment_history.append(note)
                    if r.accepted:
                        for i in selected:
                            item=r.accepted['frames'][i];f=c.frames[row['start']+i]
                            replacement={**item,'path':f.active_path,'sha256':f.sha256,'adjustment_id':task['id']}
                            r.accepted['frames'][i]=replacement
                            if r.active_frames is None:
                                # All actual original frames remain available, including excluded tails.
                                r.active_frames=Checkpoints(s).evidence(clone,1,stage)['frames']
                            r.active_frames[i]=replacement
                if r.accepted:
                    evidence=Checkpoints(s).evidence(clone,1,stage)
                    r.accepted.update(token=evidence['token'],note=task['decision_note'],reviewer='adjustment-user')
                    row['checkpoint_token']=evidence['token']
                    if r.review:r.review={**r.review,'token':evidence['token']}
            c.plan_execution.frame_mapping=[{**m,**({'adjustment_id':task['id']} if i in task.get('local_frames',range(task['start'],task['end']+1)) else {})} for i,m in enumerate(c.plan_execution.frame_mapping)]
            c.plan_execution.quality_review={**bound_review(task),'frame_digest':frame_digest(c)}
            clone.touch('derived_from_motion_adjustment',source_job=source.job_id,source_candidate=task['candidate'],adjustment_id=task['id'])
        s.check_candidate(job_id,1)
        s.approve_candidate(job_id,1,reviewer='adjustment-user',acknowledge_warnings=task['acknowledge'],review_note=task['decision_note'])
    # Publish only after the complete local candidate and adoption gate succeeded.
    manager.verify(task,live=True)
    snapshot=work.model_dump(mode='json');snapshot.pop('history')
    version_path=manager.ws.directory(work.id)/f'version-{work.revision}.json'
    if version_path.exists() and digest(read_version(version_path))!=digest(snapshot):raise ConflictError('历史版本已存在不同内容，未覆盖')
    atomic_write_json(version_path,snapshot)
    work.history.append({'revision':work.revision,'title':work.plan.title,'job_id':work.job_id})
    work.revision=new_revision;work.job_id=job_id;work.spec.candidate_count=1
    work.request_key='adjustment-'+task['id'];work.request_sha256=digest({'adjustment':task['id']})
    work.message='已采用修改版；原版可在历史版本中查看';work.updated_at=now()
    s._atomic_write_bytes(manager.ws.directory(work.id)/f'reference-{new_revision}.png',(manager.folder(task)/'reference.png').read_bytes())
    manager.ws.save(work)


def read_version(path):
    from ..jsonio import read_json
    return read_json(path)
