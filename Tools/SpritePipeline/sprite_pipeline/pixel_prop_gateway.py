"""Workbench source admission and replay for the standalone PixelProp converter."""
import base64
import binascii
import hashlib
import io
import os
import re
from PIL import Image
from pixel_prop import ALGORITHM_VERSION, Recipe, convert
from .errors import ConflictError, ValidationHarnessError
from .jsonio import inside, read_json

MAX_SOURCE_BYTES = 30_000_000


def repository(service):
    return service.settings.install_root.parents[1]


def workspace(repo):
    config = read_json(repo / 'workbench/manifest.json')['workspace']
    namespace = os.environ.get('WORKBENCH_TEST_RUN')
    if namespace:
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}', namespace):
            raise ValidationHarnessError('无效的测试工作区')
        return repo / 'work/test-runs' / namespace / 'tasks', repo / 'outputs/test-runs' / namespace
    return inside(repo, repo / config['taskDirectory']), inside(repo, repo / config['outputDirectory'])


def registered(repo, task_id, capability, operations, filename):
    if not isinstance(task_id, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}', task_id):
        raise ValidationHarnessError('无效的源任务 ID')
    tasks, outputs = workspace(repo)
    task = read_json(inside(tasks, tasks / (task_id + '.json')))
    if (task.get('id') != task_id or task.get('capabilityId') != capability or task.get('status') != 'completed'
            or task.get('input', {}).get('operation') not in operations):
        raise ValidationHarnessError('请选择已经完成的合格源任务')
    folder = inside(outputs, outputs / task_id)
    def artifact(name):
        target = inside(folder, folder / name)
        if target.relative_to(repo).as_posix() not in task.get('outputs', []):
            raise ValidationHarnessError('源任务没有登记所需产物：' + name)
        return target
    result = read_json(artifact('result.json'))
    image = artifact(filename)
    if not image.is_file() or image.stat().st_size > MAX_SOURCE_BYTES:
        raise ValidationHarnessError('源图片不是普通文件或超过 30 MB')
    data = image.read_bytes()
    if hashlib.sha256(data).hexdigest() != result.get('sha256'):
        raise ConflictError('源图片与登记的哈希不一致')
    return task, result, data, artifact


def source_bytes(service, fields):
    repo = repository(service)
    keys = [k for k in ('sourceTaskId', 'sourceImagePath', 'sourceImage') if fields.get(k) is not None]
    if len(keys) != 1:
        raise ValidationHarnessError('请选择一个源任务、仓库内图片路径或上传图片')
    key = keys[0]
    if key == 'sourceTaskId':
        task, result, data, _ = registered(repo, fields[key], 'image-assets', {'generate-prop', 'edit-image'}, 'image.png')
        if result.get('kind') != 'prop' or (task['input']['operation'] == 'edit-image' and task['input'].get('kind') != 'prop'):
            raise ValidationHarnessError('只能转换 image-assets 的物品任务')
        return data, {'sourceType': 'task', 'sourceTaskId': task['id']}
    if key == 'sourceImagePath':
        target = inside(repo, repo / fields[key])
        if not target.is_file() or target.stat().st_size > MAX_SOURCE_BYTES:
            raise ValidationHarnessError('源图片必须是仓库内 30 MB 以内的普通文件')
        return target.read_bytes(), {'sourceType': 'repository-file', 'sourcePath': target.relative_to(repo).as_posix()}
    value = fields[key]
    if not isinstance(value, str) or not re.fullmatch(r'data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}', value):
        raise ValidationHarnessError('上传 PNG、WebP 或 JPEG 的 base64 data URL')
    try:
        data = base64.b64decode(value.split(',', 1)[1], validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValidationHarnessError('源图片编码无效') from exc
    if len(data) > MAX_SOURCE_BYTES:
        raise ValidationHarnessError('源图片超过 30 MB')
    return data, {'sourceType': 'browser-image'}


def resolve_recipe(service, value):
    if not isinstance(value, dict):
        raise ValidationHarnessError('recipe 必须是对象')
    data = dict(value)
    palette = data.get('palette')
    if isinstance(palette, str):
        repo = repository(service)
        if palette.startswith('object:'):
            identity = palette[7:]
            preset, path = service.presets.load_object(identity, object_type='interactable')
            provenance = service.presets.object_provenance(identity)
            if provenance['type'] != 'pixellab':
                raise ValidationHarnessError('只能沿用 PixelLab 物品原图的调色板')
            with Image.open(inside(path.parent, path.parent / preset.reference_frame)) as image:
                if image.format != 'PNG' or image.size != (128, 128):
                    raise ValidationHarnessError('调色板对象需要 128 px PixelLab 原图')
                data['palette'] = ['#%02x%02x%02x' % rgb for rgb in sorted({p[:3] for p in image.convert('RGBA').getdata() if p[3] == 255})]
        else:
            target = inside(repo, repo / palette)
            if not target.is_file() or target.stat().st_size > 200_000:
                raise ValidationHarnessError('调色板文件需要是仓库内 200 KB 以内的 JSON 颜色列表')
            data['palette'] = read_json(target)
    try:
        recipe = Recipe.from_dict(data)
        if recipe.size != 128:
            raise ValueError('工作台物品原图固定 128×128')
        return recipe
    except (ValueError, OSError, TypeError) as exc:
        raise ValidationHarnessError(str(exc)) from exc


def conversion(service, fields):
    try:
        data, origin = source_bytes(service, fields)
        recipe = resolve_recipe(service, fields.get('recipe', {}))
        result = convert(data, recipe)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        raise ValidationHarnessError('无法转换：请检查仓库内源图片、登记哈希和配方。' + (str(exc) if isinstance(exc, ValueError) else '')) from exc
    return result, {**origin, 'type': 'convert-prop', 'providerCalled': False,
                    'tool': 'pixel-prop', 'algorithmVersion': ALGORITHM_VERSION,
                    'sourceSha256': result.report['sourceSha256'], 'recipeSha256': result.report['recipeSha256']}


def replay(service, task, result, artifact):
    provenance = result.get('provenance', {})
    if provenance.get('algorithmVersion') != ALGORITHM_VERSION:
        raise ConflictError('PixelProp 算法版本已变化，请重新转换')
    recipe = read_json(artifact('recipe.json'))
    report = read_json(artifact('report.json'))
    try:
        rebuilt, origin = conversion(service, task['input'])
    except (ConflictError, ValidationHarnessError) as exc:
        raise ConflictError('源图或配方已变化，请重新转换。' + str(exc)) from exc
    if (recipe != rebuilt.report['recipe'] or report != rebuilt.report
            or provenance != origin or rebuilt.report['sha256'] != result['sha256']):
        raise ConflictError('源图、配方或转换工具已变化，请重新转换')
