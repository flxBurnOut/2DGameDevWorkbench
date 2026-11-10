"""Versioned temporal observations, separate from animation and its decisions."""
from __future__ import annotations

import copy
import re
import subprocess
import uuid
from pathlib import Path

from ..errors import ConflictError, NotFoundError, ValidationHarnessError
from ..jsonio import atomic_write_json, read_json, inside, sha256_file
from .contracts import digest
from .structures import VisualStructures, now
from .review_evaluation import ReviewEvidence
from .review_sources import snapshot_review
from .production_review import ProductionReview
from .tracking_observation import observe, select_keyframes, OBSERVER_VERSION
from .tracking_data import correction_inputs, validate_receipt, tracking_cues

TRACKER_VERSION='sam2_png_parts_v1'
TRACKING_POLICY='manual_first_frame_v2'


class TemporalStructures:
    def __init__(self, service):
        self.service=service;self.store=service.store
        self.structures=VisualStructures(service)
        self.registry=self.structures.registry
        self.root=service.settings.data_root/'temporal-structures'
        self.observer=getattr(service,'structure_observer',None)
        self.tracker=getattr(service,'structure_tracker',None)

    def folder(self, identity):
        if not re.fullmatch(r'[0-9a-f]{32}',identity):raise ValidationHarnessError('时序结构标识无效')
        return self.root/identity

    def save(self, record):
        record['updated_at']=now();atomic_write_json(self.folder(record['id'])/'record.json',record)

    def load(self, identity):
        path=self.folder(identity)/'record.json'
        if not path.is_file():raise NotFoundError('未找到动作结构')
        record=read_json(path)
        evidence=ReviewEvidence(path.parent/'evidence')
        if evidence.token!=record['evidence_token']:raise ConflictError('动作结构的输入快照发生变化')
        structure=read_json(path.parent/'structure.json')
        if digest(structure)!=record['structure_snapshot_sha256']:raise ConflictError('动作结构的参考结构发生变化')
        if record.get('intent_sha256') and sha256_file(path.parent/'intent.json')!=record['intent_sha256']:
            raise ConflictError('动作结构的原始要求快照发生变化')
        for part in record['parts']:
            if sha256_file(inside(path.parent,path.parent/part['file']))!=part['sha256']:
                raise ConflictError('参考部件区域发生变化')
        return record

    def document(self, record, revision=None):
        version=record['revision'] if revision is None else revision
        if version==0:return None
        if type(version) is not int or not 1<=version<=record['revision']:raise ValidationHarnessError('时序结构版本无效')
        folder=self.folder(record['id']);doc=read_json(folder/f'revision-{version}.json')
        if digest({k:v for k,v in doc.items() if k!='token'})!=doc['token']:
            raise ConflictError('时序结构版本校验失败')
        receipt=read_json(inside(folder,folder/doc['receipt']))
        if digest(receipt)!=doc['receipt_sha256']:raise ConflictError('时序结构推理记录发生变化')
        job=read_json(inside(folder,folder/doc['job']))
        if digest(job)!=doc['job_sha256']:raise ConflictError('时序结构推理输入发生变化')
        validate_receipt(receipt,(folder/doc['receipt']).parent,job)
        return doc

    def current(self, record):
        try:
            job=self.store.load(record['source']['job_id'])
            identity,_,_=ProductionReview(self.service,job.job_id,record['source']['candidate'],stage=record['source']['stage']).identity(job)
            structure=self.structures.view(record['structure_id'])
            return identity==record['source_identity'] and structure['source_current'] and structure['document']['token']==record['structure_token']
        except (ConflictError,NotFoundError,ValidationHarnessError,OSError,KeyError,AttributeError):return False

    def view(self, identity, revision=None):
        record=self.load(identity);doc=self.document(record,revision)
        if doc:
            receipt=read_json(self.folder(identity)/doc['receipt'])
            shown=copy.deepcopy(doc);shown['frames']=receipt['frames'];shown['width']=receipt['width'];shown['height']=receipt['height']
            shown['compute']={k:receipt.get(k) for k in ('device','seconds','precision','mps_fallback_enabled','mps_driver_bytes','peak_gpu_bytes')}
            shown['parts']=read_json(self.folder(identity)/'structure.json')['data']['parts']
        else:shown=None
        from .temporal_review_service import review_view
        return {'id':identity,'state':record['state'],'revision':record['revision'],'source':record['source'],
                'source_current':self.current(record),'document':shown,'calls':record['calls'],
                'error':record.get('error'),'history':record['history'],'pending':bool(record.get('pending')),
                'structure_id':record['structure_id'],'created_at':record['created_at'],'updated_at':record['updated_at'],
                'supports_review':record.get('supports_review',True),
                'structured_review':review_view(self,record,doc)}

    def latest(self, job_id, candidate, stage=None):
        rows=[]
        for path in self.root.glob('*/record.json'):
            try:
                r=read_json(path);source=r['source']
                if source['job_id']==job_id and source['candidate']==candidate and source['stage']==stage:rows.append(r)
            except (OSError,ValueError,KeyError):continue
        latest=max(rows,key=lambda r:r['updated_at']) if rows else None
        return {'analysis':self.view(latest['id']) if latest else None}

    def snapshot(self, job_id, candidate, destination, token, stage):
        job=self.store.load(job_id)
        if job.request.open_plan.plan.quality or stage is not None:
            return snapshot_review(self.service,job_id,candidate,destination,expected_token=token,stage=stage)
        # Earlier open-motion works can still expose their actual frames. Do
        # not manufacture a quality contract or run a baseline for those works.
        with self.store._process_lock(job_id,timeout_seconds=5):
            job=self.store.load(job_id)
            _,actual_token,frames=ProductionReview(self.service,job_id,candidate).identity(job)
            if actual_token!=token or not frames:raise ConflictError('实际动画帧已改变或尚未完整保存')
            return ReviewEvidence.create(destination,paths=[self.store.resolve_job_path(job_id,f['path']) for f in frames],
                reference=self.store.job_dir(job_id)/'input/reference.png',fps=job.action.fps,
                context={'user_request':job.request.open_plan.spec.description,'timing_note':'原作品只有技术检查；本结构记录不补造视觉基线。'},
                source={'job_id':job_id,'candidate':candidate,'stage':None,'token':token})

    def create(self, job_id, candidate, structure_id, structure_token, request_key, *, stage=None, authorized=False, use_semantic=True):
        if not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}',request_key):raise ValidationHarnessError('请求标识无效')
        if use_semantic and not authorized:raise ValidationHarnessError('分析动作结构需要授权一次关键帧语义核验；查看不收费')
        structure=self.structures.view(structure_id)
        doc=structure['document']
        if not structure['source_current'] or not doc or doc['token']!=structure_token:
            raise ConflictError('参考结构已改变，请重新查看')
        if doc['issues'] or not doc['confirmation']:
            raise ValidationHarnessError('请先核对并确认参考结构中的可见部位；未知部位可以保留')
        runtime=self.structures.runtime()
        if not runtime['ready'] and not self.tracker:
            raise ValidationHarnessError(runtime.get('compute', {}).get('error') or '本地结构追踪环境尚未安装')
        models=self.registry.load().model_dump(mode='json')
        if use_semantic and not self.observer and not self.registry.key(self.registry.profile('structure',models).provider):
            raise ValidationHarnessError('结构模型尚未配置；没有提交请求')
        job=self.store.load(job_id)
        if job.reference_sha256!=structure['source']['sha256']:
            raise ConflictError('角色结构不是此动画使用的参考图')
        source_identity,frame_token,_=ProductionReview(self.service,job_id,candidate,stage=stage).identity(job)
        fingerprint=digest({'job_id':job_id,'candidate':candidate,'stage':stage,'source':source_identity,'structure':structure_token,'tracker':TRACKER_VERSION,
                            'tracking_policy':TRACKING_POLICY,
                            'observer':OBSERVER_VERSION,'profile':self.registry.profile('structure',models).model_dump(mode='json'),
                            'runtime':runtime['profile'],'use_semantic':use_semantic})
        request_fingerprint=digest({'job_id':job_id,'candidate':candidate,'stage':stage,'structure':structure_token,'use_semantic':use_semantic})
        with self.store.global_lock('temporal-structure-create'):
            index=self.root/'requests'/(digest(request_key)+'.json')
            if index.exists():
                saved=read_json(index)
                if saved['fingerprint']!=request_fingerprint:raise ConflictError('请求标识已用于不同动画或结构')
                return self.view(saved['id'])
            for path in self.root.glob('*/record.json'):
                prior=read_json(path)
                if prior['fingerprint']==fingerprint:
                    atomic_write_json(index,{'id':prior['id'],'fingerprint':request_fingerprint})
                    return self.view(prior['id'])
            identity=uuid.uuid4().hex;folder=self.folder(identity);folder.mkdir(parents=True)
            evidence=self.snapshot(job_id,candidate,folder/'evidence',frame_token,stage)
            if evidence.manifest['reference']['sha256']!=structure['source']['sha256']:
                raise ConflictError('动画快照与结构参考图不同')
            atomic_write_json(folder/'structure.json',doc)
            atomic_write_json(folder/'intent.json',{'explicit_user_text':[job.request.open_plan.spec.description,job.request.open_plan.spec.ending]})
            parts=[]
            for mask in doc['masks']:
                if not mask['area']:continue
                path=folder/'reference-parts'/(mask['id']+'.png');path.parent.mkdir(exist_ok=True)
                path.write_bytes(self.structures.image(structure_id,mask['id'],structure['revision']))
                if sha256_file(path)!=mask['sha256']:raise ConflictError('参考区域复制校验失败')
                parts.append({'id':mask['id'],'file':path.relative_to(folder).as_posix(),'sha256':mask['sha256']})
            if not parts:raise ValidationHarnessError('没有可供追踪的参考部件')
            record={'id':identity,'fingerprint':fingerprint,'state':'queued','revision':0,
                'source':{**evidence.manifest['source'],'fps':job.action.fps},'source_identity':source_identity,
                'evidence_token':evidence.token,'structure_id':structure_id,'structure_token':structure_token,
                'supports_review':bool(job.request.open_plan.plan.quality),
                'intent_sha256':sha256_file(folder/'intent.json'),
                'structure_snapshot_sha256':digest(doc),'parts':parts,'models':models,'runtime_profile':runtime['profile'],
                'selected_frames':select_keyframes(evidence.paths,job.action.fps),'calls':[],'history':[],
                'created_at':now(),'updated_at':now(),'pending':None,'request_key':request_key,'use_semantic':use_semantic,
                'tracking_policy':TRACKING_POLICY}
            self.save(record);atomic_write_json(index,{'id':identity,'fingerprint':request_fingerprint})
        return self.view(identity)

    def run(self, identity):
        with self.store.global_lock('temporal-structure-run-'+identity,timeout_seconds=.05):
            record=self.load(identity);folder=self.folder(identity)
            if record['state']=='observing':
                record.update(state='unknown',error='上次结构核验未完成；请求已保留，不自动重发');self.save(record);return
            if record['state'] not in {'queued','tracking'}:return
            try:
                if not self.current(record):raise ConflictError('原动画或参考结构已改变；停止使用旧输入')
                evidence=ReviewEvidence(folder/'evidence');structure=read_json(folder/'structure.json')['data']
                if record['state']=='queued' and not record['use_semantic']:
                    record['pending']={'observations':{'summary':'仅本地追踪，未调用语义核验','frames':[],'corrections':[],'issues':[]},
                        'manual_corrections':[],'note':'本地追踪提议，需要核对实际画面','origin':'local_tracking','request_key':record['request_key']}
                    record['state']='tracking';self.save(record)
                if record['state']=='queued':
                    if record['calls']:raise ConflictError('已有结构核验请求，不得重复发送')
                    record['state']='observing'
                    record['calls'].append({'phase':'semantic_keyframes','request_id':uuid.uuid4().hex,'state':'reserved','created_at':now()})
                    self.save(record);receipt={}
                    def started():record['calls'][0]['state']='submitted';self.save(record)
                    try:
                        result,metadata=(self.observer or observe)(self.registry,folder/'evidence/reference.png',structure,
                            evidence.paths,record['selected_frames'],record['models'],on_request=started,on_response=receipt.update)
                    except Exception:
                        call=record['calls'][0]
                        state='invalid_response' if receipt.get('response_id') else 'failed_before_submission' if call['state']=='reserved' else 'failed_or_unknown'
                        call.update(receipt,state=state)
                        self.save(record);raise
                    values=result.model_dump(mode='json') if hasattr(result,'model_dump') else result
                    atomic_write_json(folder/'semantic.json',values)
                    record['calls'][0].update({**receipt,**metadata,'state':'complete'})
                    parsed=correction_inputs(structure,values,evidence.paths,record['selected_frames'])
                    record['pending']={'observations':parsed,'manual_corrections':[],
                        'note':'关键帧语义提议与本地追踪；尚未核对全部实际画面','origin':'automatic_proposal','request_key':record['request_key']}
                    record['state']='tracking';self.save(record)
                self._track(record,evidence,structure)
            except Exception as exc:
                record.update(state='failed',error=str(exc) if isinstance(exc,(ConflictError,ValidationHarnessError)) else '本地时序结构未完成；已保留输入和请求，不自动重试')
                self.save(record)

    def _track(self, record, evidence, structure):
        folder=self.folder(record['id']);pending=record['pending'];runtime=self.structures.runtime()
        existing=folder/f'revision-{record["revision"]+1}.json'
        if existing.exists():
            saved=read_json(existing)
            if saved.get('mutation_key')!=pending['request_key']:raise ConflictError('已保存版本与待恢复修改不同')
            self._commit(record,saved);return
        if not self.tracker and not runtime['ready']:
            raise ValidationHarnessError(runtime.get('compute', {}).get('error') or '本地追踪工具未就绪')
        output=folder/('tracks-'+uuid.uuid4().hex)
        corrections={(c['frame_index'],c['part_id']):c for c in pending['observations']['corrections'] if c['part_id'] in {p['id'] for p in record['parts']}}
        for correction in pending['manual_corrections']:corrections[(correction['frame_index'],correction['part_id'])]=correction
        job={'source':record['source'],'reference':{'path':str(folder/'evidence/reference.png'),'sha256':evidence.manifest['reference']['sha256']},
            'frames':[{'frame_index':i,'path':str(path),'sha256':evidence.manifest['frames'][i]['sha256']} for i,path in enumerate(evidence.paths)],
            'parts':[{'id':p['id'],'mask_path':str(folder/p['file']),'mask_sha256':p['sha256']} for p in record['parts']],
            'fps':record['source']['fps'],'weights':runtime['weights'],'weights_sha256':record['runtime_profile']['weightsSha256'],
            'output':str(output),'corrections':list(corrections.values()),
            'device':runtime.get('compute', {}).get('requested_device', 'auto')}
        policy=pending.get('tracking_policy',record.get('tracking_policy'))
        if policy is not None:job['tracking_policy']=policy
        job_path=folder/(output.name+'-job.json');atomic_write_json(job_path,job)
        with self.store.global_lock('visual-structure-runtime',timeout_seconds=180):
            if self.tracker:receipt=self.tracker(job)
            else:
                run=subprocess.run([runtime['python'],runtime['worker'],'track','--job',str(job_path)],capture_output=True,
                    timeout=600,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                if run.returncode:
                    (folder/(output.name+'-error.txt')).write_bytes(run.stderr[-16000:])
                    raise ValidationHarnessError('本地跨帧追踪未完成；已保存语义核验，可本地纠正后继续')
                receipt=read_json(output/'receipt.json')
        validate_receipt(receipt,output,job)
        if not self.current(record):raise ConflictError('追踪期间原动画或参考结构改变')
        doc={'version':1,'revision':record['revision']+1,'source_identity':record['source_identity'],
            'structure_token':record['structure_token'],'observations':pending['observations'],
            'manual_corrections':pending['manual_corrections'],'receipt':(output/'receipt.json').relative_to(folder).as_posix(),
            'receipt_sha256':digest(receipt),'job':job_path.name,'job_sha256':digest(job),
            'cues':tracking_cues(receipt,output,structure),'origin':pending['origin'],'note':pending['note'],
            'confirmation':None,'created_at':now(),'mutation_key':pending['request_key']}
        self._commit(record,doc)

    def _commit(self, record, doc):
        doc['token']=digest({k:v for k,v in doc.items() if k!='token'})
        path=self.folder(record['id'])/f'revision-{doc["revision"]}.json'
        if path.exists():
            saved=read_json(path)
            if saved!=doc:raise ConflictError('时序版本已存在，不覆盖历史')
            receipt=read_json(self.folder(record['id'])/doc['receipt'])
            job=read_json(self.folder(record['id'])/doc['job'])
            if digest(receipt)!=doc['receipt_sha256'] or digest(job)!=doc['job_sha256']:
                raise ConflictError('中断恢复的推理证据已改变')
            validate_receipt(receipt,(self.folder(record['id'])/doc['receipt']).parent,job)
        else:atomic_write_json(path,doc)
        record['history'].append({'revision':doc['revision'],'token':doc['token'],'note':doc['note'],'created_at':doc['created_at']})
        record.update(revision=doc['revision'],state='ready',pending=None,error=None);self.save(record)

    def correct(self, identity, revision, token, request_key, *, correction=None, restore_revision=None, confirm=False, note=''):
        if not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}',request_key) or len(note.strip())<4:raise ValidationHarnessError('纠正需请求标识和实际观察说明')
        if sum([correction is not None,restore_revision is not None,confirm])!=1:raise ValidationHarnessError('每次仅保存纠正、恢复或确认之一')
        with self.store.global_lock('temporal-structure-run-'+identity,timeout_seconds=.05):
            record=self.load(identity);current=self.document(record)
            if not self.current(record):raise ConflictError('原动画或参考结构已改变')
            if not current or revision!=record['revision'] or token!=current['token']:raise ConflictError('时序结构已改变，请刷新')
            if record['state']!='ready' or record.get('pending'):raise ConflictError('当前分析尚未完成')
            if record['revision']>=100:raise ValidationHarnessError('时序结构修订数量已达上限')
            if any(read_json(self.folder(identity)/f'revision-{r["revision"]}.json')['mutation_key']==request_key for r in record['history']):
                raise ConflictError('该修改请求已经保存，请读取现有结果')
            if correction is not None:
                from .tracking_corrections import validate_correction
                evidence=ReviewEvidence(self.folder(identity)/'evidence')
                clean=validate_correction(correction,current,evidence,read_json(self.folder(identity)/'structure.json')['data'])
                manual={(c['frame_index'],c['part_id']):c for c in current['manual_corrections']}
                manual[(clean['frame_index'],clean['part_id'])]=clean
                record['pending']={'observations':current['observations'],'manual_corrections':list(manual.values()),
                    'origin':'user_correction','note':note,'request_key':request_key,'tracking_policy':TRACKING_POLICY}
                record['state']='tracking';self.save(record)
            else:
                selected=self.document(record,restore_revision) if restore_revision is not None else current
                doc=copy.deepcopy(selected);doc.pop('token')
                doc.update(revision=record['revision']+1,created_at=now(),note=note,mutation_key=request_key,
                           origin='user_confirmed' if confirm else 'restore',confirmation={'note':note,'at':now()} if confirm else None)
                self._commit(record,doc)
        return self.view(identity)

    def image(self, identity, frame_index, part_id=None, revision=None):
        record=self.load(identity);evidence=ReviewEvidence(self.folder(identity)/'evidence')
        if type(frame_index) is not int or not 0<=frame_index<len(evidence.paths):raise ValidationHarnessError('实际帧编号无效')
        if part_id is None:return evidence.paths[frame_index].read_bytes()
        doc=self.document(record,revision)
        if not doc:raise NotFoundError('尚无时序区域')
        receipt=read_json(self.folder(identity)/doc['receipt'])
        part=next((p for p in receipt['frames'][frame_index]['parts'] if p['id']==part_id),None)
        if not part:raise NotFoundError('未找到当前帧的部件')
        return inside((self.folder(identity)/doc['receipt']).parent,(self.folder(identity)/doc['receipt']).parent/part['file']).read_bytes()

    def recover(self, *, stopping=lambda:False):
        for path in self.root.glob('*/record.json'):
            if stopping():break
            try:
                record=read_json(path)
                if record['state'] in {'queued','observing','tracking'}:self.run(record['id'])
                if not stopping() and record.get('selected_review'):
                    from .temporal_review_service import run_review
                    run_review(self,record['id'])
            except Exception:continue
