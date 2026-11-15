"""Save deterministic frame edits as playback alternatives, never as model draws."""
import base64
import binascii
import hashlib
import io
import tempfile
from pathlib import Path
from pydantic import Field, model_validator
from .adjustment_regions import FrameEditRegion, rgba, mask_for
from .adjustments import ACTIVE, frozen_inputs
from .contracts import Contract, digest
from .workspace import now
from ..errors import ConflictError, ValidationHarnessError
from ..jsonio import atomic_write_json
from ..processing import run_qa


class PalettePair(Contract):
    source: str = Field(pattern='^#[0-9a-fA-F]{6}$')
    target: str = Field(pattern='^#[0-9a-fA-F]{6}$')


class FramePatch(Contract):
    region: FrameEditRegion
    png_base64: str | None = Field(default=None, max_length=200000)


class LocalFrameEdit(Contract):
    expected_revision: int = Field(ge=1)
    candidate_index: int = Field(ge=1, le=8)
    stage_index: int | None = Field(default=None, ge=0, le=3)
    token: str = Field(pattern='^[0-9a-f]{64}$')
    request_key: str = Field(min_length=8, max_length=128, pattern='^[A-Za-z0-9._:-]+$')
    description: str = Field(min_length=1, max_length=500)
    frames: list[FramePatch] = Field(min_length=1, max_length=64)
    palette: list[PalettePair] | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode='after')
    def exact_inputs(self):
        indices = [p.region.frame for p in self.frames]
        if indices != sorted(set(indices)):
            raise ValueError('选帧须有序且不能重复')
        if self.palette and len(set((p.source.lower() for p in self.palette))) != len(self.palette):
            raise ValueError('色表原色重复')
        if any(((p.png_base64 is not None) == (self.palette is not None) for p in self.frames)):
            raise ValueError('请选择候选 PNG 或同一组色表')
        return self


def required_locks(manager, task):
    context = manager.context(task['work_id'], task['revision'], task['candidate'], task['stage'])
    if set(task['local_frames']).intersection(context['locked_frames']):
        raise ConflictError('选中的帧已锁定，不能采用此备选')


def create_local(manager, work_id, body):
    raw = body.model_dump(mode='json')
    identity = digest(raw)
    task_id = digest({'local': body.request_key})[:32]
    with manager.ws.lock(work_id):
        dest = manager.root(work_id) / task_id
        if dest.exists():
            prior = manager.load(work_id, task_id)
            if prior['request_identity'] != identity:
                raise ConflictError('同一命令的内容已改变')
            manager.verify(prior)
            return prior
        from .experiment_policy import policy_for, REFUSAL
        if policy_for(manager.s, work_id) == 'redraw_only':
            raise ValidationHarnessError(REFUSAL)
        context = manager.context(work_id, body.expected_revision, body.candidate_index, body.stage_index)
        if context['token'] != body.token:
            raise ConflictError('动画来源已改变')
        if any((t['state'] in ACTIVE for t in context['tasks'])):
            raise ConflictError('请先处理当前备选')
        work, job, c, frames, data, ref, _, token = manager.source(work_id, body.expected_revision, body.candidate_index, body.stage_index)
        indices = [p.region.frame for p in body.frames]
        if token != body.token or indices[-1] >= len(data) or set(indices).intersection(context['locked_frames']):
            raise ConflictError('不能修改已改变、锁定或不存在的帧')
        proposed = list(data)
        stats = []
        regions = []
        palette = {bytes.fromhex(p.source[1:]): bytes.fromhex(p.target[1:]) for p in body.palette or []}
        for patch in body.frames:
            region = patch.region.model_dump(mode='json')
            i = region['frame']
            if region['source_sha256'] != hashlib.sha256(data[i]).hexdigest():
                raise ConflictError('选区来源已改变')
            original = rgba(data[i])
            bits = mask_for(region, original.size, allow_full=True).tobytes()
            before = original.tobytes()
            if palette:
                out = bytearray(before)
                for j, v in enumerate(bits):
                    if v and before[4 * j + 3] and (before[4 * j:4 * j + 3] in palette):
                        out[4 * j:4 * j + 3] = palette[before[4 * j:4 * j + 3]]
                original.frombytes(bytes(out))
                stream = io.BytesIO()
                original.save(stream, 'PNG')
                png = stream.getvalue()
            else:
                try:
                    png = base64.b64decode(patch.png_base64, validate=True)
                except (ValueError, binascii.Error):
                    raise ValidationHarnessError('候选 PNG 编码无效') from None
            result = rgba(png)
            if result.size != original.size:
                raise ValidationHarnessError('候选尺寸改变')
            after = result.tobytes()
            changed = 0
            for j, v in enumerate(bits):
                if before[4 * j:4 * j + 4] != after[4 * j:4 * j + 4]:
                    if not v:
                        raise ConflictError('候选改变了授权区域外的像素')
                    changed += 1
            proposed[i] = png
            regions.append(region)
            stats.append({'frame': i + 1, 'changed_inside_pixels': changed, 'protected_changed_pixels': 0, 'editable_pixels': sum((bool(b) for b in bits))})
        intent = {'method': 'deterministic', 'goal': body.description, 'preserve': '保持未授权的帧、像素和播放时序'}
        task = {'version': 1, 'id': task_id, 'work_id': work_id, 'revision': work.revision, 'candidate': body.candidate_index, 'stage': body.stage_index, 'source_job': job.job_id, 'source_token': token, 'source_frames': frames, 'fps': job.action.fps, 'loop': job.action.loop, 'start': indices[0], 'end': indices[-1], 'local_frames': indices, 'user_request': body.description, 'expert_suggestions': [], 'intent_source': 'user', 'methods': ['deterministic'], 'intent': intent, 'intent_sha256': digest(intent), 'budget': {'planning': 0, 'generation': 0, 'review': 0}, 'models': {}, 'protocol': 'local_pixels_v1', 'diagnostic': c.diagnostic_only, 'seed': c.seed, 'reference_sha256': hashlib.sha256(ref).hexdigest(), 'state': 'ready', 'created_at': now(), 'updated_at': now(), 'request_key': body.request_key, 'request_identity': identity, 'edit_regions': regions, 'spatial_protection': {'frames': stats, 'regions_sha256': digest(regions)}, 'repair_level': 'deterministic', 'planning_calls': [], 'generation_calls': [], 'review_calls': [], 'usage': {'cost_usd': 0, 'units': 0}, 'provider_job_id': None, 'source_goal': work.spec.description, 'review': {'state': 'local_verified', 'verdict': 'uncertain', 'checks': [], 'summary': '已验证选区外像素；修改目标与播放效果需要人工检查。'}, 'message': '本地备选已保存，请播放后决定是否采用。'}
        task['protection_digest'] = digest(task['spatial_protection'])
        task['source_manifest'] = digest({'frames': [f['sha256'] for f in frames], 'reference': task['reference_sha256'], 'fps': task['fps'], 'loop': task['loop']})
        task['frozen_digest'] = digest(frozen_inputs(task))
        staging = manager.root(work_id) / 'staging'
        staging.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=staging) as tmp:
            folder = Path(tmp) / 'alternative'
            folder.mkdir()
            (folder / 'reference.png').write_bytes(ref)
            (folder / 'source').mkdir()
            (folder / 'proposed').mkdir()
            items = []
            for i, (a, b) in enumerate(zip(data, proposed)):
                (folder / 'source' / f'{i:03d}.png').write_bytes(a)
                file = f'proposed/{i:03d}.png'
                (folder / file).write_bytes(b)
                items.append({'file': file, 'sha256': hashlib.sha256(b).hexdigest()})
            task['proposed_frames'] = items
            task['preview_token'] = digest({'source': token, 'intent': intent, 'user': body.description, 'frames': items, 'fps': task['fps'], 'models': {}, 'protocol': task['protocol']})
            task['qa'] = run_qa([folder / f['file'] for f in items], len(items), job.character.cell_width, job.character.cell_height, reference_path=folder / 'reference.png', safe_margin=job.character.safe_margin, grounded=job.action.grounded, anchor_ground_y=job.character.anchor.ground_y, loop=task['loop'], thresholds=manager.s._qa_thresholds(job))
            manager.verify(task, live=True, folder=folder)
            atomic_write_json(folder / 'task.json', task)
            folder.rename(dest)
        return task
