"""Deterministically derived interactable assets (B2/B3), never model draws.

A derived transition (reverse of an accepted transition, or a rotation draft)
or a derived state image (palette variant or uploaded artwork) records its
exact source, method and hashes. It stays a proposal until a person plays it
and accepts it with a note; only accepted records become library assets that
``import-motion-asset`` can bind. Source frames, checkpoints and exports are
never modified.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import re
from typing import Literal

from PIL import Image
from pydantic import Field, model_validator

from ..errors import ConflictError, NotFoundError, ValidationHarnessError
from ..jsonio import atomic_write_json, read_json
from .contracts import Contract, digest
from .state_chain import state_images, transition
from .targets import checked_png
from .workspace import now

METHODS = {'reverse': '倒放派生', 'rotation': '旋转草稿', 'palette': '色调派生', 'upload': '上传状态图'}
ASSET_PREFIX = 'motion-derived:'


class PaletteSpan(Contract):
    start: int = Field(ge=0, le=16383)
    length: int = Field(ge=1, le=16384)


class PalettePair(Contract):
    source: str = Field(pattern='^#[0-9a-fA-F]{6}$')
    target: str = Field(pattern='^#[0-9a-fA-F]{6}$')


class DerivedCreate(Contract):
    expected_revision: int = Field(ge=1)
    candidate_index: int = Field(ge=1, le=8)
    request_key: str = Field(min_length=8, max_length=128, pattern=r'^[A-Za-z0-9._:-]+$')
    method: Literal['reverse', 'rotation', 'palette', 'upload']
    # reverse / rotation: the transition it derives from; palette: the state chain entry.
    stage_index: int | None = Field(default=None, ge=0, le=3)
    state_index: int | None = Field(default=None, ge=0, le=4)
    name: str = Field(default='', max_length=80)
    note: str = Field(default='', max_length=1000)
    frames_png: list[str] | None = Field(default=None, min_length=2, max_length=64)
    png_base64: str | None = Field(default=None, max_length=2_000_000)
    palette: list[PalettePair] | None = Field(default=None, min_length=1, max_length=64)
    spans: list[PaletteSpan] | None = Field(default=None, min_length=1, max_length=8192)
    params: dict[str, float | int | str] = Field(default_factory=dict, max_length=12)

    @model_validator(mode='after')
    def inputs(self):
        need = {'reverse': ('stage_index',), 'rotation': ('stage_index', 'frames_png'),
                'palette': ('state_index', 'palette'), 'upload': ('png_base64',)}[self.method]
        if any(getattr(self, key) is None for key in need):
            raise ValueError('派生方式缺少必需输入：' + '、'.join(need))
        if self.method in {'palette', 'upload'} and len(self.name.strip()) < 1:
            raise ValueError('派生状态图需要名称')
        if self.method == 'upload' and len(self.note.strip()) < 4:
            raise ValueError('上传的状态图需要写明来源与核对依据')
        return self


class DerivedDecision(Contract):
    token: str = Field(pattern=r'^[0-9a-f]{64}$')
    decision: Literal['accept', 'reject']
    note: str = Field(min_length=4, max_length=2000)
    played: bool = False
    human_seconds: int | None = Field(default=None, ge=0, le=86400)


def _decode(value):
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ValidationHarnessError('图片编码无效') from None


def _rgba(data, size):
    with Image.open(io.BytesIO(data)) as image:
        if image.format != 'PNG' or image.size != size:
            raise ValidationHarnessError('派生帧须为与对象画布同尺寸的 PNG')
        return image.convert('RGBA')


def _png(image):
    out = io.BytesIO()
    image.save(out, 'PNG')
    return out.getvalue()


class DerivedAssets:
    def __init__(self, service):
        self.s = service
        self._ws = None

    @property
    def ws(self):
        # Built on demand: catalog listing only needs the data root.
        if self._ws is None:
            from .workspace import OpenMotionWorkspace
            self._ws = OpenMotionWorkspace(self.s)
        return self._ws

    def root(self, work_id):
        return self.ws.directory(work_id) / 'derived'

    def load(self, work_id, derived_id):
        if not re.fullmatch(r'[0-9a-f]{32}', derived_id):
            raise ValidationHarnessError('派生记录编号无效')
        path = self.root(work_id) / derived_id / 'record.json'
        if not path.is_file():
            raise NotFoundError('未找到派生记录')
        record = read_json(path)
        if record['id'] != derived_id or record['work_id'] != work_id:
            raise ConflictError('派生记录来源不匹配')
        return record

    def listing(self, work_id, revision=None):
        rows = [read_json(p) for p in sorted(self.root(work_id).glob('*/record.json'))] if self.root(work_id).is_dir() else []
        return sorted([r for r in rows if revision is None or r['revision'] == revision], key=lambda r: r['created_at'])

    def frame_bytes(self, record, index):
        if not 0 <= index < len(record['frames']):
            raise ValidationHarnessError('派生帧索引无效')
        item = record['frames'][index]
        data = (self.root(record['work_id']) / record['id'] / item['file']).read_bytes()
        if hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ConflictError('派生帧文件已改变')
        return data

    def _source(self, work_id, revision, index):
        work = self.ws.load(work_id)
        if work.revision != revision or not work.job_id or work.spec.object_type != 'interactable':
            raise ConflictError('作品版本已改变，请刷新后再派生')
        job = self.s.store.load(work.job_id)
        candidate = self.s._candidate(job, index)
        if candidate.diagnostic_only:
            raise ValidationHarnessError('诊断候选不能派生素材')
        return work, job, candidate

    def _chain_frames(self, job, candidate, stage):
        run = candidate.plan_execution.stages[stage] if candidate.plan_execution and stage < len(candidate.plan_execution.stages) else None
        if not run or run.state != 'accepted' or not run.accepted:
            raise ConflictError('只能从已接受的过渡派生')
        hold = job.request.open_plan.plan.quality.interactable.hold_frames if stage == len(job.request.open_plan.plan.stages) - 1 else 0
        frames = run.accepted['frames']
        return [self.s.store.resolve_job_path(job.job_id, f['path']) for f in frames + [frames[-1]] * hold], run.accepted

    def _state_bytes(self, job, candidate, state):
        if state['stage'] is None:
            data = (self.s.store.job_dir(job.job_id) / 'input/reference.png').read_bytes()
            if hashlib.sha256(data).hexdigest() != job.reference_sha256:
                raise ConflictError('原图已改变')
            return data
        from .checkpoints import Checkpoints
        return Checkpoints(self.s).state_image(job, candidate.candidate_index, state['stage'])

    def create(self, work_id, body: DerivedCreate):
        raw = body.model_dump(mode='json')
        identity = digest(raw)
        derived_id = digest({'derived': body.request_key})[:32]
        with self.ws.lock(work_id):
            folder = self.root(work_id) / derived_id
            if folder.exists():
                prior = self.load(work_id, derived_id)
                if prior['request_identity'] != identity:
                    raise ConflictError('同一命令的内容已改变')
                return prior
            work, job, candidate = self._source(work_id, body.expected_revision, body.candidate_index)
            size = (job.character.cell_width, job.character.cell_height)
            plan = job.request.open_plan.plan
            chain = state_images(job, candidate)
            source, params, kind = {}, dict(body.params), 'transition'
            if body.method == 'reverse':
                paths, accepted = self._chain_frames(job, candidate, body.stage_index)
                data = [p.read_bytes() for p in reversed(paths)]
                edge = transition(plan, body.stage_index)
                name = f"{edge['to_state']} → {edge['from_state']}"
                source = {'stage': body.stage_index, 'checkpoint_token': accepted['token'], 'frames': [hashlib.sha256(d).hexdigest() for d in reversed(data)]}
            elif body.method == 'rotation':
                edge = transition(plan, body.stage_index)
                base = next((s for s in chain if s['stage'] == (body.stage_index - 1 if body.stage_index else None)), None)
                if base is None:
                    raise ConflictError('起始状态尚未确认，不能以它为旋转草稿的起点')
                base_bytes = self._state_bytes(job, candidate, base)
                data = [_decode(v) for v in body.frames_png]
                images = [_rgba(d, size) for d in data]
                # Provenance: the draft must start exactly at the confirmed starting state.
                if images[0].tobytes() != _rgba(base_bytes, size).tobytes():
                    raise ConflictError('旋转草稿的首帧必须与起始状态图逐像素一致')
                data = [_png(i) for i in images]
                name = f"{edge['from_state']} → {edge['to_state']}（旋转草稿）"
                source = {'stage': body.stage_index, 'base_state': base['name'], 'base_sha256': base['sha256']}
            elif body.method == 'palette':
                kind = 'state'
                if body.state_index >= len(chain):
                    raise ConflictError('所选状态尚未确认')
                base = chain[body.state_index]
                image = _rgba(self._state_bytes(job, candidate, base), size)
                pixels = bytearray(image.tobytes())
                count = size[0] * size[1]
                mask = bytearray(count) if body.spans else bytearray(b'\x01' * count)
                end = -1
                for span in body.spans or []:
                    if span.start < end or span.start + span.length > count:
                        raise ValidationHarnessError('色调区域越界或顺序错误')
                    mask[span.start:span.start + span.length] = b'\x01' * span.length
                    end = span.start + span.length
                pairs = {bytes.fromhex(p.source[1:]): bytes.fromhex(p.target[1:]) for p in body.palette}
                changed = 0
                for i in range(count):
                    rgb = bytes(pixels[4 * i:4 * i + 3])
                    if mask[i] and pixels[4 * i + 3] and rgb in pairs:
                        pixels[4 * i:4 * i + 3] = pairs[rgb]
                        changed += 1
                if not changed:
                    raise ValidationHarnessError('所选颜色在区域内没有出现，未生成新的状态图')
                image.frombytes(bytes(pixels))
                data = [_png(image)]
                name = body.name.strip()
                source = {'state': base['name'], 'state_sha256': base['sha256'], 'stage': base['stage']}
                params.update(changed_pixels=changed)
                raw_palette = [p.model_dump() for p in body.palette]
                params['palette'] = ','.join(f"{p['source']}>{p['target']}" for p in raw_palette)
            else:
                kind = 'state'
                payload = _decode(body.png_base64)
                checked_png(payload, *size)
                data = [_png(_rgba(payload, size))]
                name = body.name.strip()
                source = {'upload_sha256': hashlib.sha256(payload).hexdigest()}
            if kind == 'transition' and not 2 <= len(data) <= 64:
                raise ValidationHarnessError('派生过渡需要 2–64 帧')
            folder.mkdir(parents=True)
            frames = []
            for i, item in enumerate(data):
                file = f'{i:03d}.png'
                self.s._atomic_write_bytes(folder / file, item)
                frames.append({'file': file, 'sha256': hashlib.sha256(item).hexdigest()})
            record = {
                'version': 1, 'id': derived_id, 'work_id': work_id, 'revision': work.revision, 'job_id': job.job_id,
                'candidate': body.candidate_index, 'plan_sha256': job.request.open_plan.plan_sha256,
                'kind': kind, 'method': body.method, 'method_label': METHODS[body.method], 'name': name[:120],
                'source': source, 'source_stage': body.stage_index if kind == 'transition' else source.get('stage'),
                'params': params, 'note': body.note.strip(), 'frames': frames,
                'fps': job.action.fps, 'loop': False, 'width': size[0], 'height': size[1],
                'state': 'ready', 'review': None, 'created_at': now(), 'updated_at': now(),
                'request_key': body.request_key, 'request_identity': identity,
                'usage': {'planning': 0, 'generation': 0, 'review': 0},
                # Fixture jobs never enter the library, like their state chains.
                'diagnostic': job.request.provider == 'fixture',
            }
            record['token'] = digest({'frames': frames, 'source': source, 'method': body.method, 'params': params})
            record['asset_id'] = f"{ASSET_PREFIX}{work_id}:{derived_id}"
            atomic_write_json(folder / 'record.json', record)
            return record

    def decide(self, work_id, derived_id, body: DerivedDecision):
        with self.ws.lock(work_id):
            record = self.load(work_id, derived_id)
            if record['token'] != body.token:
                raise ConflictError('派生结果已改变，请重新播放检查')
            if record['state'] != 'ready':
                if record['state'] == ('accepted' if body.decision == 'accept' else 'rejected'):
                    return record
                raise ConflictError('此派生结果已有结论')
            if body.decision == 'accept' and not body.played and record['kind'] == 'transition':
                raise ValidationHarnessError('请先完整播放派生过渡再接受')
            for i in range(len(record['frames'])):
                self.frame_bytes(record, i)
            record['state'] = 'accepted' if body.decision == 'accept' else 'rejected'
            record['review'] = {'note': body.note.strip(), 'played': body.played, 'decided_at': now(),
                                **({'human_seconds': body.human_seconds} if body.human_seconds is not None else {})}
            record['updated_at'] = now()
            atomic_write_json(self.root(work_id) / derived_id / 'record.json', record)
            return record

    # Asset-library representation: accepted records only.
    def catalog_rows(self):
        root = self.s.settings.data_root / 'open-motion'
        if not root.is_dir():
            return []
        rows = []
        for path in sorted(root.glob('*/derived/*/record.json')):
            try:
                record = read_json(path)
            except (OSError, ValueError):
                continue
            if record.get('state') != 'accepted' or record.get('diagnostic'):
                continue
            rows.append(self.row(record))
        return rows

    def row(self, record):
        state = record['kind'] == 'state'
        last = record['frames'][-1]['sha256']
        return {
            'id': record['asset_id'], 'kind': 'prop' if state else 'animation', 'motionSource': 'state' if state else 'transition',
            'derivation': record['method'], 'derivationLabel': record['method_label'],
            'title': f"{record['name']}（{record['method_label']}）", 'jobId': record['job_id'], 'candidateIndex': record['candidate'],
            'objectType': 'interactable', 'workId': record['work_id'], 'workRevision': record['revision'], 'planSha256': record['plan_sha256'],
            'width': record['width'], 'height': record['height'], 'stageIndex': record.get('source_stage'),
            'checkpointToken': record['token'], 'stateSha256': last, 'stateName': record['name'] if state else None,
            'frameCount': len(record['frames']), **({} if state else {'fps': record['fps'], 'loop': False}),
            'status': 'approved', 'statusLabel': '派生状态图' if state else '派生过渡',
            'createdAt': record['created_at'], 'updatedAt': record['updated_at'], 'previewKind': 'image',
            'availability': 'available', 'hasArtwork': True,
        }

    def resolve(self, asset_id):
        parts = asset_id[len(ASSET_PREFIX):].split(':') if asset_id.startswith(ASSET_PREFIX) else []
        if len(parts) != 2:
            raise NotFoundError('派生资产编号无效')
        record = self.load(parts[0], parts[1])
        if record['state'] != 'accepted' or record.get('diagnostic'):
            raise NotFoundError('派生素材尚未经人工接受，或来自诊断任务')
        folder = self.root(record['work_id']) / record['id']
        paths = {}
        for i, item in enumerate(record['frames']):
            key = 'source' if record['kind'] == 'state' else f'frame-{i}'
            paths[key] = (folder / item['file'], item['sha256'])
        paths['preview'] = next(reversed(paths.values()))
        return self.row(record), paths
