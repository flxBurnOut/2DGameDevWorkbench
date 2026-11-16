"""Admission of registered generated, imported and converted prop outputs."""
import hashlib
import io
from datetime import datetime, timezone
import tempfile
from pathlib import Path

from PIL import Image

from .errors import ConflictError, ValidationHarnessError
from .jsonio import atomic_write_json, sha256_file
from .models import InteractablePreset


def source_artifact(service, task_id, confirmation=None):
    """Admit registered PixelLab, imported, or reproducible converted props."""
    from .pixel_prop_gateway import registered, replay, repository
    task, result, data, artifact = registered(repository(service), task_id, 'reference-art',
        {'generate', 'import', 'convert-prop'}, 'reference.png')
    fields = task['input']
    operation = fields['operation']
    if fields.get('subject', 'prop' if operation == 'convert-prop' else 'character') != 'prop' or fields.get('size', 128) != 128:
        raise ValidationHarnessError('物品动画移送需要已完成的 128 像素物品原图任务')
    kind = 'pixellab' if operation == 'generate' else operation
    if operation == 'generate':
        if result.get('model') != 'pixflux' or not task.get('adapter', {}).get('referenceJobId'):
            raise ValidationHarnessError('PixelLab 物品原图任务缺少模型或上游任务身份')
    else:
        if (result.get('model') is not None or result.get('provenance', {}).get('type') != operation
                or result.get('provenance', {}).get('providerCalled') is not False):
            raise ValidationHarnessError('物品原图来源记录无效')
        note = confirmation.get('note') if isinstance(confirmation, dict) else None
        if not isinstance(note, str) or not 4 <= len(note.strip()) <= 1000:
            raise ValidationHarnessError('请填写至少 4 字的确认说明，核对视角、初始状态、部件完整和透明背景')
        if operation == 'convert-prop':
            replay(service, task, result, artifact)
        elif result['provenance'].get('sourceSha256') != result.get('sha256'):
            raise ConflictError('导入原图来源哈希不一致')
    if (result.get('subject', 'prop') != 'prop' or (result.get('width'), result.get('height')) != (128, 128)
            or len(data) > 2_000_000):
        raise ValidationHarnessError('源任务的物品原图记录无效')
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        alpha = image.convert('RGBA').getchannel('A')
        if image.format != 'PNG' or image.size != (128,128) or not alpha.getbbox() or alpha.getextrema()[0] == 255:
            raise ValidationHarnessError('物品原图必须是有可见内容和透明背景的 128 像素 PNG')
        left, _, right, bottom = alpha.getbbox()
    provenance = {'version': 1, 'type': kind, 'sourceTaskId': task_id, 'referenceSha256': result['sha256']}
    if kind != 'pixellab':
        provenance['confirmation'] = {'note': note.strip(), 'confirmedAt': datetime.now(timezone.utc).isoformat()}
    if operation == 'convert-prop':
        provenance['conversion'] = {key: result['provenance'][key] for key in ('tool', 'algorithmVersion', 'recipeSha256', 'sourceSha256')}
    return fields, data, {'x': (left + right - 1) // 2, 'ground_y': bottom - 1}, provenance


def transfer(service, task_id, description, confirmation=None):
    try:
        fields, data, anchor, provenance = source_artifact(service, task_id, confirmation)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise ValidationHarnessError('无法核对源任务及其登记产物，请检查本机工作台任务记录') from exc
    identity = 'reference_' + hashlib.sha256(task_id.encode()).hexdigest()[:24]
    path = service.presets.object_path(identity)
    with service.store.global_lock('reference-preset-' + identity):
        if service.presets.object_exists(identity):
            existing, saved = service.presets.load_object(identity, object_type='interactable')
            if sha256_file(saved.parent / existing.reference_frame) != hashlib.sha256(data).hexdigest() or (
                description and description != existing.identity_description):
                raise ConflictError('同一物品移送标识已绑定其他原图或外观说明')
            recorded = service.presets.object_provenance(identity)
            if recorded['type'] != provenance['type'] or (recorded.get('referenceSha256') and recorded['referenceSha256'] != provenance['referenceSha256']):
                raise ConflictError('同一物品移送标识的来源已变化')
            return identity
        preset = InteractablePreset(object_id=identity, display_name=fields.get('name') or '生成的交互物',
            identity_description=description or fields['prompt'][:1000], cell_width=128, cell_height=128,
            reference_frame='reference.png', anchor=anchor)
        root = service.presets.objects_dir
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root, prefix='.prop-import-') as tmp:
            package = Path(tmp) / 'preset'
            package.mkdir()
            (package / preset.reference_frame).write_bytes(data)
            atomic_write_json(package / 'object.json', preset.model_dump(mode='json'))
            atomic_write_json(package / 'provenance.json', provenance)
            package.rename(path.parent)
    return identity
