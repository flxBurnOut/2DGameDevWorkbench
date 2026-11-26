"""Metadata-free PNG encoding and human comparison images."""
import hashlib
import io
from PIL import Image


def png_bytes(image):
    output = io.BytesIO()
    # A fresh image strips inherited ICC, EXIF and text metadata.
    clean = Image.frombytes('RGBA', image.size, image.convert('RGBA').tobytes())
    clean.save(output, format='PNG', compress_level=9, optimize=False)
    return output.getvalue()


def pixel_sha256(image):
    """Hash of decoded RGBA pixels; unlike the PNG file hash it does not depend on the zlib build."""
    rgba = image.convert('RGBA')
    return hashlib.sha256(b'RGBA' + rgba.width.to_bytes(4, 'big') + rgba.height.to_bytes(4, 'big') + rgba.tobytes()).hexdigest()


def pixel_digest(data):
    with Image.open(io.BytesIO(data)) as image:
        return pixel_sha256(image)


def diagnostics(image):
    rgba = image.convert('RGBA')
    pixels = list(rgba.getdata())
    semi = sum(0 < p[3] < 255 for p in pixels)
    visible = sum(p[3] > 0 for p in pixels)
    bbox = rgba.getchannel('A').getbbox()
    return {'width': rgba.width, 'height': rgba.height, 'pixelSha256': pixel_sha256(rgba),
            'colors': len({p[:3] for p in pixels if p[3]}),
            'semiTransparentPixels': semi, 'semiTransparentRatio': semi / max(1, visible),
            'visiblePixels': visible, 'bbox': list(bbox) if bbox else None}


def comparison(source, output):
    height = output.height * 4
    source = source.copy()
    source.thumbnail((height, height), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (height * 2 + 8, height), '#d3d3d3')
    for y in range(0, height, 16):
        for x in range(0, canvas.width, 16):
            if (x//16+y//16) % 2:
                canvas.paste('#ededed', (x, y, min(x+16, canvas.width), min(y+16, height)))
    canvas.alpha_composite(source, ((height-source.width)//2, (height-source.height)//2))
    canvas.alpha_composite(output.resize((height, height), Image.Resampling.NEAREST), (height+8, 0))
    return png_bytes(canvas)


def sha256(data):
    return hashlib.sha256(data).hexdigest()
