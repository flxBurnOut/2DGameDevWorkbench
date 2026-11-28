"""Reuse saved baseline + two independent experts + at most one dispute.

This is advisory sidecar evidence. No native animation status or export changes.
"""
import copy
from .contracts import digest
from .structures import now
from .review_evaluation import ReviewEvidence, ReviewExperiment
from .tracking_review import StructuredReviewEvidence, STRUCTURE_REVIEW_VERSION
from .independent_review import attach_opinions
from ..errors import ConflictError, ValidationHarnessError
from ..jsonio import atomic_write_json,read_json


def review_view(tracks,record,doc):
    selected=record.get('selected_review')
    if not selected:return None
    folder=tracks.folder(record['id'])/'reviews'/selected
    record_view=read_json(folder/'request.json')
    result=read_json(folder/'result.json') if (folder/'result.json').is_file() else None
    current=bool(doc and record_view['document_token']==doc['token'] and tracks.current(record)
                 and record_view.get('structure_review_version',1)==STRUCTURE_REVIEW_VERSION)
    return {**record_view,'state':record_view['state'] if current else 'stale',
            'current':current,'result':result,'advisory_only':True}


def start_review(tracks,identity,token,*,authorized=False):
    if not authorized:raise ValidationHarnessError('结构辅助复核需要授权最多三次视觉请求')
    with tracks.store.global_lock('temporal-structure-run-'+identity,timeout_seconds=.05):
        record=tracks.load(identity);doc=tracks.document(record)
        if not doc or doc['token']!=token or not tracks.current(record):raise ConflictError('动作或结构版本已改变')
        if record['state']!='ready' or not doc['confirmation']:raise ValidationHarnessError('请先查看并确认当前结构观察')
        if not record.get('supports_review',True):
            raise ValidationHarnessError('此旧作品没有视觉基线；不能伪造或自动补跑基础检查')
        job=tracks.store.load(record['source']['job_id'])
        from .production_review import ProductionReview
        original=ProductionReview(tracks.service,job.job_id,record['source']['candidate'],stage=record['source']['stage']).native(job) or {}
        baseline=copy.deepcopy(original.get('expert_review',{}).get('baseline'))
        if not baseline and original.get('state')=='complete' and len(original.get('requests',[]))==2:
            baseline={**copy.deepcopy(original),'state':'complete','mode':'baseline','evidence_token':record['evidence_token'],
                      'model_snapshot':copy.deepcopy(job.request.open_plan.model_snapshot)}
        if not baseline or baseline.get('state')!='complete' or len(baseline.get('requests',[]))!=2:
            raise ValidationHarnessError('当前动画没有完整的两次基础检查；不能伪造或自动补跑基线')
        if baseline['evidence_token']!=record['evidence_token']:raise ConflictError('基础检查不是当前这组实际帧')
        label=f'r{doc["revision"]}-s{STRUCTURE_REVIEW_VERSION}'
        folder=tracks.folder(identity)/'reviews'/label
        if not (folder/'request.json').exists():
            folder.mkdir(parents=True,exist_ok=True)
            atomic_write_json(folder/'baseline.json',baseline)
            atomic_write_json(folder/'observations.json',doc['observations'])
            atomic_write_json(folder/'request.json',{'state':'queued','document_token':token,'revision':doc['revision'],
                'structure_review_version':STRUCTURE_REVIEW_VERSION,
                'baseline_sha256':digest(baseline),'max_new_calls':3,'reused_baseline_calls':2,'created_at':now()})
        record['selected_review']=label;tracks.save(record)
    return tracks.view(identity)


def run_review(tracks,identity):
    with tracks.store.global_lock('temporal-structure-review-'+identity,timeout_seconds=.05):
        record=tracks.load(identity);label=record.get('selected_review')
        if not label:return
        folder=tracks.folder(identity)/'reviews'/label;request=read_json(folder/'request.json')
        if request['state'] not in {'queued','running'}:return
        def save(**updates):request.update(updates);atomic_write_json(folder/'request.json',request)
        try:
            if request.get('structure_review_version',1)!=STRUCTURE_REVIEW_VERSION:
                raise ConflictError('结构观察协议已更新；保留旧请求，不自动追加或重试复核')
            doc=tracks.document(record,request['revision'])
            def current():
                latest=tracks.load(identity)
                return tracks.current(latest) and tracks.document(latest)['token']==request['document_token']
            if not current():raise ConflictError('复核请求绑定的观察已过期')
            baseline=read_json(folder/'baseline.json')
            if digest(baseline)!=request['baseline_sha256']:raise ConflictError('冻结基础检查已改变')
            evidence=StructuredReviewEvidence(ReviewEvidence(tracks.folder(identity)/'evidence'),
                job_path=tracks.folder(identity)/doc['job'],receipt_path=tracks.folder(identity)/doc['receipt'],
                reference_structure_path=tracks.folder(identity)/'structure.json',observations_path=folder/'observations.json',
                intent_path=(tracks.folder(identity)/'intent.json') if (tracks.folder(identity)/'intent.json').exists() else None,current_guard=current)
            registry=getattr(tracks.service,'open_motion_review_registry',None) or tracks.registry
            # ReviewExperiment persists before every call and never resubmits a
            # saved failed/unknown request. Resuming here is read-only for it.
            save(state='running',structure_binding=evidence.structure_binding)
            independent=ReviewExperiment(registry,evidence,folder/'independent',snapshot=baseline['model_snapshot'],max_calls=2).run(mode='independent',authorized=True)
            if independent['state']!='complete':
                atomic_write_json(folder/'result.json',independent);save(state=independent['state'],new_calls=len(independent['requests']));return
            augmented=attach_opinions(baseline,independent)
            atomic_write_json(folder/'augmented.json',augmented)
            final=ReviewExperiment(registry,evidence,folder/'dispute',snapshot=baseline['model_snapshot'],max_calls=1).resolve(augmented,authorized=True)
            evidence.verify()
            atomic_write_json(folder/'result.json',final)
            save(state=final['state'],new_calls=len(independent['requests'])+len(final['requests']),completed_at=now())
        except Exception as exc:
            save(state='failed',error=str(exc) if isinstance(exc,(ConflictError,ValidationHarnessError)) else '结构辅助复核未完成；保存已有请求，不自动重试')
