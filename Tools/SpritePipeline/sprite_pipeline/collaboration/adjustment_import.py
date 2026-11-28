"""Local maintenance: link a completed isolated alternative, without executing it.

No public HTTP/MCP operation. Caller must supply the exact native selection.
"""
import copy
import hashlib
import re
import uuid
from pathlib import Path
from .contracts import digest
from .adjustments import ACTIVE
from .adjustment_attempts import require_drawing_slot
from .review_evaluation import ReviewEvidence
from .workspace import now
from ..errors import ConflictError, ValidationHarnessError
from ..jsonio import read_json, atomic_write_json


def register_saved_alternative(manager, source_folder, *, work_id, revision, candidate, stage, source_token):
    source=Path(source_folder).resolve(strict=True)
    original=read_json(source/'task.json')
    task=copy.deepcopy(original)
    if not re.fullmatch(r'[0-9a-f]{32}',str(task.get('id',''))):
        raise ValidationHarnessError('备选标识无效')
    expected={'work_id':work_id,'revision':revision,'candidate':candidate,'stage':stage,'source_token':source_token}
    if any(task.get(k)!=v for k,v in expected.items()):raise ConflictError('备选不属于指定作品、版本或片段')
    if task['state']!='ready' or not task.get('proposed_frames') or not task.get('review'):
        raise ConflictError('仅能关联已完成的备选；失败、未知和进行中的请求不能移入或重启')
    if any(c.get('state') in {'submitting','unknown','failed_or_unknown'} for key in ('planning_calls','generation_calls','review_calls') for c in task[key]):
        raise ConflictError('备选仍有未知请求，不能关联')
    destination=manager.folder(task)
    source_digest=digest(original)
    with manager.ws.lock(work_id):
        if (destination/'task.json').exists():
            saved=manager.load(work_id,task['id'])
            if saved.get('linked_source',{}).get('task_sha256')!=source_digest:
                raise ConflictError('已有同名但不同来源的备选，未覆盖')
            manager.verify(saved)
            return saved
        context=manager.context(work_id,revision,candidate,stage)
        if context['token']!=source_token:raise ConflictError('当前原作品已改变，不能关联旧备选')
        if any(t['state'] in ACTIVE for t in context['tasks']):raise ConflictError('请先处理当前备选')
        require_drawing_slot(context,task['start'],task['end'],additional=max(1,len(task['generation_calls'])))
        manager.verify(task,live=True,folder=source)
        evidence=ReviewEvidence(source/'evidence')
        if [p.read_bytes() for p in evidence.paths]!=[(source/f['file']).read_bytes() for f in task['proposed_frames']]:
            raise ConflictError('检查证据与备选图片不一致')
        receipt=manager.root(work_id)/'requests'/f"{digest({'request_key':task['request_key']})}.json"
        if receipt.exists() and read_json(receipt)!={'id':task['id'],'identity':task['request_identity']}:
            raise ConflictError('原请求身份冲突，未关联')
        # Stage below a separate directory; listing cannot expose a partial copy.
        staging=manager.root(work_id)/'imports'/uuid.uuid4().hex
        staging.mkdir(parents=True,exist_ok=False)
        for path in source.rglob('*'):
            if path.is_symlink():raise ValidationHarnessError('不支持含符号链接的备选目录')
            if not path.is_file():continue
            data=path.read_bytes();target=staging/path.relative_to(source)
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
            if hashlib.sha256(target.read_bytes()).digest()!=hashlib.sha256(data).digest():
                raise ConflictError('备选复制校验失败，未关联')
        manager.verify(task,live=True,folder=staging)
        ReviewEvidence(staging/'evidence').verify()
        task['linked_source']={'task_sha256':source_digest,'path':str(source),'linked_at':now(),
                               'new_provider_calls':0,'adopted':False}
        atomic_write_json(staging/'task.json',task)
        staging.rename(destination)
        atomic_write_json(receipt,{'id':task['id'],'identity':task['request_identity']})
        return task
