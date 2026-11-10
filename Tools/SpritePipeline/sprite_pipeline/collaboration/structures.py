"""Versioned reference analysis. Reads never parse, draw, or retry a request."""
from __future__ import annotations

import hashlib
import io
import os
import re
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image
from ..errors import ConflictError, NotFoundError, ValidationHarnessError
from ..jsonio import atomic_write_json, read_json, inside, sha256_file
from .contracts import digest
from .model_config import ModelRegistry
from .structure_contracts import StructureProposal, coordinate_issues
from .structure_parser import PARSER_VERSION, parse


def now():
    return datetime.now(timezone.utc).isoformat()


class VisualStructures:
    def __init__(self, service):
        self.service = service
        self.store = service.store
        self.root = service.settings.data_root / 'visual-structures'
        self.registry = ModelRegistry(service.settings)
        self.parser = getattr(service, 'structure_parser', None)
        self.segmenter = getattr(service, 'structure_segmenter', None)

    def folder(self, identity):
        if not re.fullmatch(r'[0-9a-f]{32}', identity):
            raise ValidationHarnessError('结构标识无效')
        return self.root / identity

    def runtime(self):
        repo = self.service.settings.install_root.parents[1]
        base = repo / 'work/visual-structure-runtime'
        python = Path(os.environ.get('FORGE_STRUCTURE_PYTHON', base / ('venv/Scripts/python.exe' if os.name == 'nt' else 'venv/bin/python')))
        weights = Path(os.environ.get('FORGE_STRUCTURE_WEIGHTS', base / 'checkpoints/sam2.1_hiera_tiny.pt'))
        worker = repo / 'Tools/VisualStructure/worker.py'
        profile_path = repo / 'Tools/VisualStructure/runtime-profile.json'
        profile = read_json(profile_path) if profile_path.is_file() else {}
        ready = bool(self.segmenter) or all(p.is_file() for p in (python, weights, worker)) and bool(profile.get('weightsSha256'))
        result = {'ready': ready, 'model': 'SAM 2.1 Tiny', 'automatic_download': False,
                'python': str(python), 'weights': str(weights), 'worker': str(worker), 'profile': profile}
        if ready and not self.segmenter:
            from .structure_runtime import probe
            result['compute'] = probe(result)
            result['ready'] = result['compute']['available']
        return result

    def describe(self):
        runtime = self.runtime()
        profile = self.registry.profile('structure')
        return {'ready': runtime['ready'], 'model': runtime['model'], 'parser_version': PARSER_VERSION,
                'semantic_model': profile.model_dump(mode='json'),
                'semantic_configured': bool(self.parser or self.registry.key(profile.provider)),
                'automatic_download': False, 'compute': runtime.get('compute'),
                'message': f"本地分割已就绪 · {runtime.get('compute', {}).get('device', 'fixture').upper()}；查看和纠正不调用外部模型。" if runtime['ready'] else runtime.get('compute', {}).get('error', '尚未安装独立分割工具；可继续使用原制作流程。')}

    def reference(self, character_id):
        character, preset = self.service.presets.load_character(character_id)
        path = preset.parent / character.reference_frame
        self.service._validate_reference_image(path, character.cell_width, character.cell_height)
        data = path.read_bytes()
        return data, {'character_id': character_id, 'name': character.display_name,
                      'sha256': hashlib.sha256(data).hexdigest(), 'width': character.cell_width, 'height': character.cell_height}

    def save_record(self, record):
        record['updated_at'] = now()
        atomic_write_json(self.folder(record['id']) / 'record.json', record)

    def load(self, identity):
        folder = self.folder(identity)
        if not (folder / 'record.json').is_file():
            raise NotFoundError('未找到角色结构')
        record = read_json(folder / 'record.json')
        if sha256_file(folder / 'source.png') != record['source']['sha256']:
            raise ConflictError('结构来源快照已改变；停止使用旧结构')
        return record

    def document(self, record, revision=None):
        revision = record['revision'] if revision is None else revision
        if revision == 0: return None
        if not isinstance(revision, int) or not 1 <= revision <= record['revision']:
            raise ValidationHarnessError('结构版本无效')
        path = self.folder(record['id']) / f'revision-{revision}.json'
        doc = read_json(path)
        if digest({k:v for k,v in doc.items() if k != 'token'}) != doc['token'] or doc['source_sha256'] != record['source']['sha256']:
            raise ConflictError('结构版本或来源校验失败')
        for mask in doc['masks']:
            if sha256_file(inside(path.parent, path.parent / mask['file'])) != mask['sha256']:
                raise ConflictError('部件区域已改变；旧结构不可继续使用')
        return doc

    def source_current(self, record):
        try: return self.reference(record['source']['character_id'])[1]['sha256'] == record['source']['sha256']
        except (NotFoundError, ValidationHarnessError, OSError): return False

    def view(self, identity, revision=None):
        record = self.load(identity)
        return {'id': identity, 'state': record['state'], 'source': record['source'],
                'source_current': self.source_current(record), 'revision': record['revision'],
                'document': self.document(record, revision), 'error': record.get('error'),
                'history': record['history'], 'calls': record['calls'],
                'pending': bool(record.get('pending')), 'parser_version': record['parser_version'],
                'model_profile': self.registry.profile('structure', record['models']).model_dump(mode='json'),
                'created_at': record['created_at'], 'updated_at': record['updated_at']}

    def latest(self, character_id):
        _, source = self.reference(character_id)
        rows = []
        for path in self.root.glob('*/record.json'):
            try:
                record = read_json(path)
                if record['source']['character_id'] == character_id and record['source']['sha256'] == source['sha256']:
                    rows.append(record)
            except (OSError, ValueError, KeyError): continue
        latest = max(rows, key=lambda r:r['updated_at']) if rows else None
        return {'analysis': self.view(latest['id']) if latest else None, 'runtime': self.describe(), 'source': source}

    def create(self, character_id, request_key, *, authorized=False):
        if not authorized: raise ValidationHarnessError('解析原图需授权一次语义模型调用')
        if not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}', request_key): raise ValidationHarnessError('请求标识无效')
        data, source = self.reference(character_id)
        models = self.registry.load().model_dump(mode='json')
        runtime = self.runtime()
        fingerprint = digest({'source':source, 'parser':PARSER_VERSION,
                              'profile':self.registry.profile('structure',models).model_dump(mode='json'),
                              'segmentation': runtime['profile']})
        request = self.root / 'requests' / (hashlib.sha256(request_key.encode()).hexdigest()+'.json')
        def equivalent(previous):
            # Renaming the character or changing another expert's model does
            # not make the image need another paid semantic interpretation.
            return ({k:v for k,v in previous['source'].items() if k!='name'} == {k:v for k,v in source.items() if k!='name'}
                    and previous['parser_version']==PARSER_VERSION
                    and self.registry.profile('structure',previous['models'])==self.registry.profile('structure',models)
                    and previous['runtime_profile']==runtime['profile'])
        with self.store.global_lock('visual-structure-create'):
            if request.exists():
                previous = read_json(request)
                if previous['fingerprint'] != fingerprint and not equivalent(self.load(previous['id'])): raise ConflictError('同一请求标识已绑定其他来源或配置')
                return self.view(previous['id'])
            # Cache successes AND failures/unknown calls. New keys do not reroll.
            for path in self.root.glob('*/record.json'):
                previous = read_json(path)
                if previous['fingerprint'] == fingerprint or equivalent(previous):
                    atomic_write_json(request, {'id':previous['id'],'fingerprint':fingerprint})
                    return self.view(previous['id'])
            if not runtime['ready']:
                raise ValidationHarnessError(runtime.get('compute', {}).get('error') or '请先安装独立分割环境，不会调用模型')
            if not self.segmenter and sha256_file(Path(runtime['weights'])) != runtime['profile']['weightsSha256']:
                raise ValidationHarnessError('分割权重校验失败，未调用模型')
            profile = self.registry.profile('structure',models)
            if not self.parser and not self.registry.key(profile.provider): raise ValidationHarnessError('语义解析模型尚未配置 Key')
            identity = uuid.uuid4().hex; folder = self.folder(identity); folder.mkdir(parents=True)
            self.service._atomic_write_bytes(folder / 'source.png',data)
            record = {'id':identity,'version':1,'source':source,'fingerprint':fingerprint,'models':models,
                      'parser_version':PARSER_VERSION,'runtime_profile':runtime['profile'],
                      'state':'queued','revision':0,'created_at':now(),'history':[],'calls':[],
                      'mutations':{},'pending':None,'error':None}
            self.save_record(record); atomic_write_json(request,{'id':identity,'fingerprint':fingerprint})
        return self.view(identity)

    def _mask_sources(self, record):
        result = {}
        for revision in range(1,record['revision']+1):
            doc = self.document(record,revision)
            for mask in doc['masks']: result[mask['prompt_hash']] = mask
        return result

    def _segment(self, record, proposal):
        folder=self.folder(record['id'])
        with Image.open(folder/'source.png') as im: issues=coordinate_issues(proposal,im)
        bad={i['id'] for i in issues}; cached=self._mask_sources(record)
        masks, prompts = [], []
        for part in proposal.parts:
            if part.visibility != 'visible' or part.id in bad: continue
            prompt={'id':part.id,'box':part.box,'points':[[p.x,p.y] for p in part.points],'labels':[p.label for p in part.points]}
            key=digest(prompt)
            if key in cached: masks.append(cached[key])
            else: prompts.append(prompt)
        if prompts:
            output=folder/('masks-'+uuid.uuid4().hex)
            if self.segmenter:
                receipt=self.segmenter(folder/'source.png',prompts,output)
            else:
                runtime=self.runtime()
                if not runtime['ready']:
                    raise ValidationHarnessError(runtime.get('compute', {}).get('error') or '本地分割工具未就绪')
                job={'source':str(folder/'source.png'),'source_sha256':record['source']['sha256'],
                     'weights':runtime['weights'],'weights_sha256':record['runtime_profile']['weightsSha256'],
                     'output':str(output),'parts':prompts,'semantics_origin':record['pending']['origin'],
                     'device':runtime.get('compute', {}).get('requested_device', 'auto')}
                path=folder/(output.name+'-job.json');atomic_write_json(path,job)
                with self.store.global_lock('visual-structure-runtime', timeout_seconds=180):
                    run=subprocess.run([runtime['python'],runtime['worker'],'segment','--job',str(path)],
                        capture_output=True,timeout=180,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                if run.returncode:
                    # Local worker output contains no credentials; retain evidence.
                    (folder/(output.name+'-error.txt')).write_bytes(run.stderr[-16000:])
                    raise ValidationHarnessError('本地部件分割未完成；保留语义结果，可修正后再运行本地分割')
                receipt=read_json(output/'receipt.json')
            if receipt.get('source_sha256') != record['source']['sha256']:
                raise ConflictError('分割结果来源不匹配')
            by_id={p['id']:p for p in prompts}
            if {p['id'] for p in receipt['parts']} != set(by_id): raise ConflictError('分割结果部件不完整或错配')
            for mask in receipt['parts']:
                path=inside(output, output/mask['file'])
                if sha256_file(path) != mask['sha256']: raise ConflictError('分割区域哈希不匹配')
                with Image.open(path) as im:
                    if im.size != (record['source']['width'],record['source']['height']): raise ConflictError('区域尺寸不匹配')
                masks.append({'id':mask['id'],'file':path.relative_to(folder).as_posix(), 'sha256':mask['sha256'],
                              'prompt_hash':digest(by_id[mask['id']]),'area':mask['area'],'model_score':mask.get('model_score'),
                              'compute':{k:receipt.get(k) for k in ('device','seconds','precision','mps_fallback_enabled','mps_driver_bytes','peak_gpu_bytes')}})
        for mask in masks:
            if mask['area']==0: issues.append({'id':mask['id'],'message':'未识别到可见区域，请纠正或标记未知','severity':'needs_correction'})
        return masks,issues

    def _commit(self, record, proposal, masks, issues, confirmation=None):
        pending=record['pending']; revision=record['revision']+1
        doc={'version':1,'revision':revision,'source_sha256':record['source']['sha256'],
             'data':proposal.model_dump(mode='json'),'masks':masks,'issues':issues,
             'origin':pending['origin'],'note':pending['note'],'mutation_key':pending['request_key'],
             'confirmation':confirmation,'created_at':now()}
        doc['token']=digest(doc)
        path=self.folder(record['id'])/f'revision-{revision}.json'
        if path.exists():
            saved=read_json(path)
            if saved['mutation_key'] != doc['mutation_key'] or digest(saved['data']) != digest(doc['data']):
                raise ConflictError('未完成的版本写入冲突；保留所有记录')
            doc=saved
        else: atomic_write_json(path,doc)
        record['revision']=revision; record['state']='ready'; record['pending']=None;record['error']=None
        record['history'].append({'revision':revision,'origin':doc['origin'],'note':doc['note']})
        record['mutations'][pending['request_key']]={'fingerprint':pending['fingerprint'],'revision':revision}
        self.save_record(record)

    def run(self, identity):
        with self.store.global_lock('structure-run-'+identity,timeout_seconds=0.05):
            record=self.load(identity); folder=self.folder(identity)
            if record['state']=='parsing':
                # The worker lock is now free: previous caller has stopped. Never resubmit.
                record['state']='unknown'; record['error']='上次语义调用结果不明，已保留原请求；不会自动重试'
                self.save_record(record); return
            if record['state'] not in {'queued','segmenting'}: return
            try:
                if record['state']=='queued':
                    if record['calls']: raise ConflictError('已有语义请求，禁止重复提交')
                    record['state']='parsing'
                    record['calls'].append({'phase':'semantic','state':'reserved','request_id':uuid.uuid4().hex,'created_at':now()})
                    self.save_record(record)
                    def request_started():
                        record['calls'][0]['state']='submitted';self.save_record(record)
                    receipt={}
                    try:
                        parser=self.parser or parse
                        result,metadata=parser(self.registry,(folder/'source.png').read_bytes(),record['models'],
                                               on_request=request_started,on_response=receipt.update)
                    except Exception:
                        record['calls'][0].update(receipt);record['calls'][0]['state']='failed_or_unknown';raise
                    proposal=StructureProposal.model_validate(result.model_dump(mode='json') if hasattr(result,'model_dump') else result)
                    atomic_write_json(folder/'semantic.json',proposal.model_dump(mode='json'))
                    record['calls'][0].update({**receipt,**metadata,'state':'complete'})
                    record['pending']={'data':proposal.model_dump(mode='json'),'origin':'automatic_proposal',
                        'request_key':'initial-analysis','fingerprint':record['fingerprint'],'note':'语义解析结果；尚未人工确认'}
                    record['state']='segmenting';self.save_record(record)
                proposal=StructureProposal.model_validate(record['pending']['data'])
                masks,issues=self._segment(record,proposal)
                self._commit(record,proposal,masks,issues)
            except Exception as exc:
                message=str(exc) if isinstance(exc,(ValidationHarnessError,ConflictError)) else '结构分析未完成；原请求与来源已保留，不自动重试'
                # Keep a usable proposal for local correction if segmentation
                # failed after a paid semantic response. Never pay for it again.
                if record.get('pending') and record['revision']==0 and not isinstance(exc,ConflictError):
                    proposal=StructureProposal.model_validate(record['pending']['data'])
                    with Image.open(folder/'source.png') as im: issues=coordinate_issues(proposal,im)
                    issues.extend({'id':p.id,'message':'本地区域尚未生成；纠正后保存可重新计算','severity':'needs_correction'} for p in proposal.parts if p.visibility=='visible')
                    self._commit(record,proposal,[],issues)
                else: record['state']='failed'
                record['error']=message
                self.save_record(record)

    def recover(self, *, stopping=lambda:False):
        for path in self.root.glob('*/record.json'):
            if stopping(): break
            try:
                if read_json(path)['state'] in {'queued','parsing','segmenting'}: self.run(path.parent.name)
            except (ConflictError, OSError, ValueError): continue

    def correct(self, identity, expected_revision, token, request_key, *, data=None, restore_revision=None, confirm=False, note=''):
        if not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}',request_key): raise ValidationHarnessError('请求标识无效')
        if len(note.strip())<4 or len(note)>1000: raise ValidationHarnessError('请简述本次纠正或核对的依据（4–1000字符）')
        if sum([data is not None,restore_revision is not None,confirm]) != 1: raise ValidationHarnessError('每次只能纠正、恢复或确认一种操作')
        fingerprint=digest({'revision':expected_revision,'token':token,'data':data,'restore':restore_revision,'confirm':confirm,'note':note})
        with self.store.global_lock('structure-run-'+identity,timeout_seconds=1):
            record=self.load(identity)
            prior=record['mutations'].get(request_key)
            pending=record.get('pending')
            if prior or pending and pending['request_key']==request_key:
                if (prior or pending)['fingerprint']!=fingerprint: raise ConflictError('同一纠正请求标识的内容已改变')
                return self.view(identity)
            if record['state'] not in {'ready','failed'} or record['revision']==0: raise ConflictError('请等待结构结果后再纠正')
            current=self.document(record)
            if record['revision']!=expected_revision or current['token']!=token: raise ConflictError('结构版本已改变，请重新读取')
            if not self.source_current(record): raise ConflictError('角色原图已变化，不能继续修改旧结构')
            if record['revision']>=100: raise ValidationHarnessError('结构版本过多，请保留历史并建立新的分析')
            if restore_revision is not None:
                target=self.document(record,restore_revision)
                proposal=StructureProposal.model_validate(target['data'])
                masks,issues=target['masks'],target['issues']; origin='user_restore'
            elif confirm:
                if current['issues']: raise ValidationHarnessError('请先处理标出的坐标或区域问题')
                proposal=StructureProposal.model_validate(current['data']);masks,issues=current['masks'],current['issues'];origin='user_confirmed'
            else:
                proposal=StructureProposal.model_validate(data);origin='user_corrected'
            record['pending']={'data':proposal.model_dump(mode='json'),'origin':origin,'note':note,
                               'request_key':request_key,'fingerprint':fingerprint}
            if confirm or restore_revision is not None:
                self._commit(record,proposal,masks,issues,{'note':note,'at':now()} if confirm else None)
            else:
                record['state']='segmenting';self.save_record(record)
        return self.view(identity)

    def image(self, identity, part_id=None, revision=None):
        record=self.load(identity);folder=self.folder(identity)
        if part_id is None: return (folder/'source.png').read_bytes()
        doc=self.document(record,revision)
        mask=next((m for m in doc['masks'] if m['id']==part_id),None) if doc else None
        if not mask: raise NotFoundError('此部件暂无可用区域')
        return inside(folder,folder/mask['file']).read_bytes()
