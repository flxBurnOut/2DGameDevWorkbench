"""Public geometric battery artwork, generated without private inputs."""
from pathlib import Path
from PIL import Image, ImageDraw
from pixel_prop import Recipe, convert
from pixel_prop.report import png_bytes
import json

root = Path(__file__).parent
image = Image.new('RGBA', (512, 512))
draw = ImageDraw.Draw(image)
draw.rectangle((188, 64, 324, 100), fill='#273343')
draw.rounded_rectangle((116, 96, 396, 460), radius=24, fill='#315980', outline='#192e49', width=16)
draw.rectangle((152, 132, 188, 420), fill='#527e9b')
draw.rectangle((240, 168, 352, 204), fill='#f4c358')
draw.rectangle((240, 224, 352, 260), fill='#a77a30')
# Keep the committed source bytes: PNG compression differs between zlib builds.
if not (root / 'battery.png').exists():
    (root / 'battery.png').write_bytes(png_bytes(image))
source = (root / 'battery.png').read_bytes()
recipe = Recipe()
(root / 'recipe.json').write_text(json.dumps(recipe.normalized(), indent=2) + '\n')
result = convert(source, recipe)
(root / 'battery-128.png').write_bytes(result.png)
(root / 'golden.json').write_text(json.dumps({'sourceSha256': result.report['sourceSha256'], 'pixelSha256': result.report['pixelSha256'],
    'recipeSha256': result.report['recipeSha256'], 'algorithmVersion': result.report['algorithmVersion']}, indent=2) + '\n')
