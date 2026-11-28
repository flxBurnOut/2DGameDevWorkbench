import io
import json
from pathlib import Path
import subprocess
import sys
import pytest
from PIL import Image
from pixel_prop import ALGORITHM_VERSION, InputError, Recipe, convert, inspect
from pixel_prop.report import png_bytes

EXAMPLES = Path(__file__).resolve().parents[1] / 'examples'


def decoded(data):
    with Image.open(io.BytesIO(data)) as image:
        return image.convert('RGBA').tobytes()


def interior_holes(data):
    """Transparent pixels not reachable from the canvas border, i.e. holes inside the subject."""
    with Image.open(io.BytesIO(data)) as image:
        rgba = image.convert('RGBA'); w, h = rgba.size; p = rgba.load()
    seen, stack = set(), [(x, y) for x in range(w) for y in (0, h-1)] + [(x, y) for y in range(h) for x in (0, w-1)]
    while stack:
        x, y = stack.pop()
        if (x, y) in seen or not (0 <= x < w and 0 <= y < h) or p[x, y][3]: continue
        seen.add((x, y)); stack += [(x+1, y), (x-1, y), (x, y+1), (x, y-1)]
    return sum(1 for y in range(h) for x in range(w) if not p[x, y][3] and (x, y) not in seen)


def test_golden_and_repeatability():
    source = (EXAMPLES / 'battery.png').read_bytes()
    expected = json.loads((EXAMPLES / 'golden.json').read_text())
    results = [convert(source, Recipe()) for _ in range(3)]
    for result in results:
        # Pixels are pinned across platforms; PNG bytes may differ between zlib builds.
        assert decoded(result.png) == decoded((EXAMPLES / 'battery-128.png').read_bytes())
        assert {key: result.report[key] for key in expected} == expected
        assert interior_holes(result.png) == 0
        assert result.report['semiTransparentPixels'] == 0
        assert result.report['colors'] <= 24
        assert result.report['bbox'][3] == 124
    assert results[0] == results[1] == results[2]
    assert ALGORITHM_VERSION == expected['algorithmVersion']


@pytest.mark.parametrize('resample', ['area', 'dominant', 'nearest'])
@pytest.mark.parametrize('size', [64, 128])
def test_resampling_size_and_palette(resample, size):
    recipe = Recipe(size=size, resample=resample, palette=['#000000', '#ffffff'], dither=True, removeIsolated=False)
    a = convert((EXAMPLES / 'battery.png').read_bytes(), recipe)
    b = convert((EXAMPLES / 'battery.png').read_bytes(), recipe)
    assert a.png == b.png
    with Image.open(io.BytesIO(a.png)) as image:
        assert image.size == (size, size)
        assert {p[:3] for p in image.getdata() if p[3]} <= {(0, 0, 0), (255, 255, 255)}
        assert {p[3] for p in image.getdata()} == {0, 255}
        assert image.info == {}


def test_canonical_recipe_and_file_palette(tmp_path):
    assert Recipe.from_dict({'colors':24, 'padding':4}).sha256 == Recipe().sha256
    palette = tmp_path / 'palette.json'; palette.write_text('["#AABBCC", "#112233", "#aabbcc"]')
    assert Recipe(palette=str(palette)).normalized()['palette'] == ['#aabbcc', '#112233']
    assert Recipe(palette=str(palette)).sha256 == Recipe(palette=['#aabbcc', '#112233']).sha256


@pytest.mark.parametrize('value', [{'size':65}, {'size':True}, {'colors':1}, {'colors':65}, {'padding':17},
    {'alphaThreshold':0}, {'anchor':'top'}, {'fit':'stretch'}, {'resample':'random'}, {'dither':1},
    {'removeIsolated':'yes'}, {'outline':'blue'}, {'background':'white'}, {'palette':['bad']}, {'surprise':1}])
def test_bad_recipes(value):
    with pytest.raises(ValueError): Recipe.from_dict(value)


def test_transparency_key_and_invalid_input():
    with pytest.raises(InputError): convert(b'not an image')
    with pytest.raises(InputError): convert(png_bytes(Image.new('RGBA', (8, 8))))
    image = Image.new('RGBA', (32, 32), '#ffffff'); image.paste('#ff0000', (8, 8, 24, 24))
    source = png_bytes(image)
    with pytest.raises(InputError, match='background'): convert(source)
    result = convert(source, Recipe(background='key:#ffffff', colors=0))
    assert result.report['colors'] == 1
    for format in ('JPEG', 'WEBP'):
        stream = io.BytesIO(); image.convert('RGB').save(stream, format=format)
        assert convert(stream.getvalue(), Recipe(background='key:#ffffff')).report['width'] == 128
    with pytest.raises(InputError): convert(png_bytes(Image.new('RGBA', (4097, 1))))


def test_premultiplied_alpha_does_not_gray_edges():
    image = Image.new('RGBA', (512, 512), (0, 255, 0, 0))
    image.paste((220, 40, 30, 255), (55, 55, 460, 460))
    result = convert(png_bytes(image), Recipe(colors=0, removeIsolated=False))
    with Image.open(io.BytesIO(result.png)) as output:
        assert {p[:3] for p in output.getdata() if p[3]} == {(220, 40, 30)}


def test_outline_preserves_interior_and_inspect():
    source = (EXAMPLES / 'battery.png').read_bytes()
    plain = convert(source, Recipe(resample='nearest', colors=0, removeIsolated=False))
    outlined = convert(source, Recipe(resample='nearest', colors=0, removeIsolated=False, outline='#010203'))
    with Image.open(io.BytesIO(plain.png)) as a, Image.open(io.BytesIO(outlined.png)) as b:
        for p, q in zip(a.getdata(), b.getdata()):
            if p[3]: assert p == q
            elif q[3]: assert q == (1, 2, 3, 255)
    report = inspect(outlined.png)
    assert report['sha256'] == outlined.report['sha256']
    assert report['pixelSha256'] == outlined.report['pixelSha256']
    assert report['semiTransparentPixels'] == 0


def test_cli_json_and_exit_codes(tmp_path):
    def call(*args):
        p = subprocess.run([sys.executable, '-m', 'pixel_prop.cli', *map(str, args)], capture_output=True, text=True)
        return p.returncode, json.loads(p.stdout)
    target = tmp_path / 'prop.png'
    code, report = call('convert', EXAMPLES/'battery.png', '-o', target, '--report', tmp_path/'report.json', '--compare', tmp_path/'compare.png')
    assert code == 0 and target.is_file()
    assert call('inspect', target)[1]['sha256'] == report['sha256']
    assert call('convert', EXAMPLES/'battery.png', '-o', target, '--colors', 1)[0] == 2
    assert call('convert', tmp_path/'missing.png', '-o', target)[0] == 3
    assert call('convert')[0] == 2


def test_large_palette_search_matches_exhaustive_oklab():
    from pixel_prop.quantize import palette_search, oklab
    colors = [(i, (i*31)%256, (i*71)%256) for i in range(256)]
    labs = [oklab(c) for c in colors]
    # Duplicate entries also test the stable original-order tie break.
    labs += labs[:2]
    search = palette_search(labs)
    for rgb in [(i, (i*11)%256, (i*47)%256) for i in range(256)]:
        lab = oklab(rgb)
        assert search(lab) == min(range(len(labs)), key=lambda i: sum((lab[a]-labs[i][a])**2 for a in range(3)))


def test_pixel_hash_ignores_png_compression():
    from pixel_prop import pixel_digest
    result = convert((EXAMPLES / 'battery.png').read_bytes(), Recipe())
    with Image.open(io.BytesIO(result.png)) as image:
        other = io.BytesIO(); image.save(other, format='PNG', compress_level=1)
    assert other.getvalue() != result.png
    assert pixel_digest(other.getvalue()) == pixel_digest(result.png) == result.report['pixelSha256']


def test_isolated_cleanup_recolours_interior_and_removes_detached_specks():
    from pixel_prop.pipeline import cleanup
    image = Image.new('RGBA', (9, 9))
    for x in range(1, 6):
        for y in range(1, 6):
            image.putpixel((x, y), (10, 20, 30, 255))
    image.putpixel((3, 3), (200, 0, 0, 255))   # odd pixel inside the body
    image.putpixel((1, 1), (0, 200, 0, 255))   # odd corner pixel on the silhouette
    image.putpixel((8, 8), (5, 5, 5, 255))     # detached speck
    image.putpixel((7, 6), (9, 9, 9, 255)); image.putpixel((6, 7), (9, 9, 9, 255))  # diagonal pair of different colours
    settings = {**Recipe().normalized(), 'outline': 'none'}
    out = cleanup(image, settings)
    assert out.getpixel((3, 3)) == (10, 20, 30, 255)
    assert out.getpixel((1, 1)) == (10, 20, 30, 255)
    assert out.getpixel((8, 8))[3] == 0
    assert out.getpixel((7, 6)) == (9, 9, 9, 255), 'diagonally connected pixels are not detached specks'


def test_default_recipe_never_opens_holes_in_shaded_art():
    from PIL import ImageDraw, ImageFilter
    image = Image.new('RGBA', (1024, 1024)); draw = ImageDraw.Draw(image)
    for r in range(380, 0, -2):
        c = int(60 + 150 * (1 - r / 380))
        draw.ellipse((512 - r, 560 - r * 0.8, 512 + r, 560 + r * 0.8), fill=(c, int(c * 0.6), 40, 255))
    for i in range(40):
        draw.line((300 + i * 10, 300, 320 + i * 10, 820), fill=(200, 180, 90, 255), width=3)
    source = png_bytes(image.filter(ImageFilter.GaussianBlur(1.5)))
    for resample in ('area', 'dominant', 'nearest'):
        result = convert(source, Recipe(resample=resample))
        assert interior_holes(result.png) == 0, resample
