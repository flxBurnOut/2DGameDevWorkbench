"""Free, versioned joint previews. No provider, task mutation, or adoption path."""
from __future__ import annotations

from PIL import Image
import hashlib

from ..errors import ConflictError, ValidationHarnessError, NotFoundError
from ..jsonio import atomic_write_json, read_json
from .contracts import digest
from .interaction_contracts import check_anchors, InteractionContext
from .production_review import ProductionReview
from .structures import now
from .workspace import OpenMotionWorkspace
from .interaction_structure import exchange_structure


class InteractionPreviews:
    def __init__(self, service):
        self.service = service
        self.workspace = OpenMotionWorkspace(service)
        self.root = service.settings.data_root / 'interaction-previews'

    def folder(self, work, candidate, stage):
        # Workspace.load validated the work identity before path construction.
        return self.root / work.id / f'{work.revision}-{candidate}-{"full" if stage is None else stage}'

    def structure(self, source):
        from .tracking import TemporalStructures
        try:
            analysis = TemporalStructures(self.service).latest(source['job_id'], source['candidate'], source['stage'])['analysis']
            return exchange_structure(analysis, source)
        except (OSError, ValueError, KeyError, ConflictError, ValidationHarnessError, NotFoundError):
            return {'state': 'unavailable', 'binding': None, 'anchors': [], 'relations': []}

    def source(self, work, candidate, stage):
        if not work.job_id:
            raise ValidationHarnessError('动画尚无实际帧，不能建立联合预览')
        job = self.service.store.load(work.job_id)
        _, _, frames = ProductionReview(self.service, work.job_id, candidate, stage=stage).identity(job)
        if not frames:
            raise ValidationHarnessError('此范围尚无完整保存的实际动画')
        native = self.service._candidate(job, candidate)
        result = []
        for index, frame in enumerate(frames):
            with Image.open(self.service.store.resolve_job_path(job.job_id, frame['path'])) as image:
                width, height = image.size
            result.append({'index': index, 'raw_index': frame.get('raw_index', native.frames[index].index if stage is None else index),
                           'sha256': frame['sha256'], 'width': width, 'height': height})
        source = {'work_id': work.id, 'revision': work.revision, 'job_id': work.job_id,
                  'candidate': candidate, 'stage': stage, 'fps': job.action.fps, 'frames': result,
                  'reference_sha256': job.reference_sha256}
        return {**source, 'token': digest(source)}

    def read(self, work_id, candidate=1, stage=None, revision=None):
        work = self.workspace.load(work_id, revision)
        path = self.folder(work, candidate, stage) / 'head.json'
        head = read_json(path) if path.is_file() else {'version': 0, 'requests': {}}
        document = None
        if head['version']:
            document = read_json(path.parent / f'revision-{head["version"]}.json')
            if digest({k: v for k, v in document.items() if k != 'token'}) != document['token']:
                raise ConflictError('已保存联合预览的内容校验失败')
        error, source = None, None
        try:
            source = self.source(work, candidate, stage)
        except (ConflictError, ValidationHarnessError, NotFoundError, OSError) as cause:
            error = str(cause)
        work_current = self.workspace.load(work_id).revision == work.revision
        structure = self.structure(source) if source else {'state': 'unavailable', 'binding': None, 'anchors': [], 'relations': []}
        current = bool(source and (not document or source['token'] == document['source']['token']) and work_current)
        if document and document['context'].get('structure_binding'):
            current = current and document['context']['structure_binding'] == structure['binding']
        return {'document': document, 'source': source, 'source_current': current, 'error': error,
                'structure': structure, 'work_current': work_current, 'context_version': head['version'], 'model_calls': 0}

    def save(self, work_id, request):
        work = self.workspace.load(work_id)
        if work.revision != request.expected_revision:
            raise ConflictError('作品版本已变化，未保存联合预览')
        if not work.job_id:
            raise ValidationHarnessError('动画尚无实际帧')
        folder = self.folder(work, request.candidate_index, request.stage_index)
        fingerprint = digest(request.model_dump(mode='json'))
        with self.service.store.global_lock('interaction-' + digest(str(folder))):
            path = folder / 'head.json'
            head = read_json(path) if path.is_file() else {'version': 0, 'requests': {}}
            previous = head['requests'].get(request.request_key)
            if previous:
                if previous['fingerprint'] != fingerprint:
                    # Optional display fields were added without changing the
                    # meaning of old requests. Compare the exact saved version
                    # under the current schema before rejecting a legacy replay.
                    prior=read_json(folder/f'revision-{previous["version"]}.json')
                    valid=digest({k:v for k,v in prior.items() if k!='token'})==prior['token']
                    source=prior['source']
                    same_identity=(source['work_id']==work_id and source['revision']==request.expected_revision
                        and source['candidate']==request.candidate_index and source['stage']==request.stage_index
                        and source['token']==request.source_token and prior['version']-1==request.expected_context_version)
                    same_context=InteractionContext.model_validate(prior['context']).model_dump(mode='json')==request.context.model_dump(mode='json')
                    if not (valid and same_identity and same_context):
                        raise ConflictError('此请求标识已用于不同的联合预览')
                return self.read(work_id, request.candidate_index, request.stage_index)
            if head['version'] != request.expected_context_version:
                raise ConflictError('联合预览已被更新，请重新读取后保存')
            with self.service.store._process_lock(work.job_id, timeout_seconds=5):
                source = self.source(work, request.candidate_index, request.stage_index)
                if source['token'] != request.source_token:
                    raise ConflictError('角色帧、播放速度或来源已变化，未套用旧标注')
                if request.context.structure_binding:
                    structure = self.structure(source)
                    if request.context.structure_binding.model_dump() != structure['binding']:
                        raise ConflictError('所复用的 V2 结构已变化或尚未核对')
                    for anchor in request.context.actor_anchors:
                        if anchor.provenance == 'confirmed_structure' and anchor.model_dump(mode='json') not in structure['anchors']:
                            raise ConflictError('锚点与实际结构记录不符；手工修改必须标为人工观察')
                try:
                    check_anchors(request.context.actor_anchors, [(f['width'], f['height']) for f in source['frames']])
                except ValueError as error:
                    raise ValidationHarnessError(str(error)) from error
                duration = len(source['frames']) / source['fps']
                if any(e.time >= duration for e in request.context.events) or any(
                    r.window.start >= duration or r.window.end > duration or
                    r.response_window and (r.response_window.start >= duration or r.response_window.end > duration)
                    for r in request.context.relations
                ):
                    raise ValidationHarnessError('交互时间超出角色实际播放时长')
                if self.workspace.load(work_id).revision != work.revision:
                    raise ConflictError('保存期间作品版本已变化')
                document = {'version': head['version'] + 1, 'source': source,
                            'context': request.context.model_dump(mode='json'), 'saved_at': now()}
                document['token'] = digest(document)
                atomic_write_json(folder / f'revision-{document["version"]}.json', document)
                head['version'] = document['version']
                head['requests'][request.request_key] = {'fingerprint': fingerprint, 'version': document['version']}
                atomic_write_json(path, head)
        return self.read(work_id, request.candidate_index, request.stage_index)

    def image(self, work_id, candidate, stage, revision, token, index):
        work = self.workspace.load(work_id, revision)
        source = self.source(work, candidate, stage)
        if source['token'] != token or not 0 <= index < len(source['frames']):
            raise ConflictError('联合预览的实际帧已改变，不能显示旧标注')
        job = self.service.store.load(work.job_id)
        _, _, frames = ProductionReview(self.service, work.job_id, candidate, stage=stage).identity(job)
        data = self.service.store.resolve_job_path(work.job_id, frames[index]['path']).read_bytes()
        if hashlib.sha256(data).hexdigest() != source['frames'][index]['sha256']:
            raise ConflictError('读取期间实际图片发生变化')
        return data
