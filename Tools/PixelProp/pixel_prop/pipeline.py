"""Pure local conversion; accepts bytes and returns bytes plus reproducibility evidence."""
from collections import Counter
from dataclasses import dataclass
import io
from PIL import Image, UnidentifiedImageError
from .recipe import ALGORITHM_VERSION, Recipe
from .quantize import quantize
from .report import comparison, diagnostics, png_bytes, sha256


class InputError(ValueError):
    pass


def decode(data):
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in ('PNG', 'WEBP', 'JPEG') or max(image.size) > 4096:
                raise InputError('Use PNG, WebP or JPEG, longest edge at most 4096')
            if getattr(image, 'n_frames', 1) != 1:
                raise InputError('Animated images are not supported')
            image.load()
            return image.convert('RGBA')
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise InputError('Cannot decode input image') from exc


def inspect(data):
    return {'sha256': sha256(data), **diagnostics(decode(data))}


def dominant(image, size):
    sw, sh = image.size
    dw, dh = size
    pixels = image.load()
    result = []
    for y in range(dh):
        for x in range(dw):
            counts = Counter(pixels[sx, sy] for sy in range(y*sh//dh, max(y*sh//dh+1, (y+1)*sh//dh))
                             for sx in range(x*sw//dw, max(x*sw//dw+1, (x+1)*sw//dw)) if pixels[sx, sy][3])
            result.append(min(counts, key=lambda c: (-counts[c], c)) if counts else (0, 0, 0, 0))
    output = Image.new('RGBA', size); output.putdata(result)
    return output


def cleanup(image, recipe):
    source = image.load(); width, height = image.size
    output = image.copy(); target = output.load()
    neighbors = ((-1, 0), (1, 0), (0, -1), (0, 1))
    if recipe['removeIsolated']:
        for y in range(height):
            for x in range(width):
                p = source[x, y]
                if p[3] and not any(0 <= x+dx < width and 0 <= y+dy < height and source[x+dx, y+dy] == p for dx, dy in neighbors):
                    target[x, y] = (0, 0, 0, 0)
    if recipe['outline'] != 'none':
        rgb = (24, 24, 32) if recipe['outline'] == 'dark' else tuple(bytes.fromhex(recipe['outline'][1:]))
        source = output.copy().load()
        for y in range(height):
            for x in range(width):
                if not source[x, y][3] and any(0 <= x+dx < width and 0 <= y+dy < height and source[x+dx, y+dy][3] for dx, dy in neighbors):
                    target[x, y] = (*rgb, 255)
    return output


@dataclass(frozen=True)
class Conversion:
    png: bytes
    report: dict
    compare: bytes


def convert(source_bytes, recipe=None):
    recipe = Recipe.from_dict(recipe or {}) if isinstance(recipe, dict) or recipe is None else Recipe.from_dict(recipe.normalized())
    settings = recipe.normalized()
    source = decode(source_bytes)
    image = source.copy()
    if recipe.background != 'alpha':
        key = tuple(bytes.fromhex(recipe.background[5:]))
        image.putdata([(0, 0, 0, 0) if p[:3] == key else p for p in image.getdata()])
    if image.getchannel('A').getextrema()[0] == 255:
        raise InputError('No transparent background; set background=key:#RRGGBB')
    bbox = image.getchannel('A').getbbox()
    if bbox is None:
        raise InputError('Input has no visible pixels')
    image = image.crop(bbox)
    available = recipe.size - recipe.padding * 2
    scale = available / max(image.size)
    dimensions = tuple(max(1, min(available, int(n*scale+.5))) for n in image.size)
    if recipe.resample == 'area':
        image = image.convert('RGBa').resize(dimensions, Image.Resampling.BOX).convert('RGBA')
    elif recipe.resample == 'dominant':
        image = dominant(image, dimensions)
    else:
        image = image.resize(dimensions, Image.Resampling.NEAREST)
    canvas = Image.new('RGBA', (recipe.size, recipe.size))
    canvas.paste(image, ((recipe.size-image.width)//2,
                        recipe.size-recipe.padding-image.height if recipe.anchor == 'bottom' else (recipe.size-image.height)//2))
    canvas.putdata([(*p[:3], 255) if p[3] >= recipe.alphaThreshold else (0, 0, 0, 0) for p in canvas.getdata()])
    if not canvas.getchannel('A').getbbox():
        raise InputError('No visible pixels remain after alpha thresholding')
    canvas = cleanup(quantize(canvas, settings), settings)
    stats = diagnostics(canvas)
    if not stats['visiblePixels'] or canvas.getchannel('A').getextrema()[0] == 255:
        raise InputError('Output must contain visible pixels and a transparent background; adjust padding/cleanup')
    png = png_bytes(canvas)
    warnings = []
    if min(dimensions) < 16 or stats['visiblePixels'] < recipe.size*recipe.size*.03:
        warnings.append('主体过小，请检查小部件是否丢失。')
    if max(source.size) > recipe.size * 2:
        warnings.append('缩小可能使细线断裂，请对照原图检查部件完整性。')
    if recipe.outline != 'none' and recipe.padding == 0:
        warnings.append('轮廓可能在画布边缘被裁切；建议增加留白。')
    report = {'tool': 'pixel-prop', 'algorithmVersion': ALGORITHM_VERSION,
              'sourceSha256': sha256(source_bytes), 'sourceWidth': source.width, 'sourceHeight': source.height,
              'recipe': settings, 'recipeSha256': recipe.sha256, 'sha256': sha256(png), **stats, 'warnings': warnings}
    return Conversion(png, report, comparison(source, canvas))
