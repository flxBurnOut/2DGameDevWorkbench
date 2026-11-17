# PixelProp

Offline, deterministic conversion of transparent artwork into a 64 or 128 pixel prop. Requires Python 3.11+ and Pillow 11–12. No network, credentials, or workbench dependency. Only explicit input and output paths are read or written.

```sh
pip install ./Tools/PixelProp
pixel-prop convert input.png -o prop.png --size 128 --colors 24 --report report.json --compare compare.png
pixel-prop convert input.png -o prop.png --recipe recipe.json
pixel-prop inspect prop.png
```

In this repository run `npm run sprite-pipeline:setup`, then `npm run pixel-prop -- <arguments>`. The setup installs this package into the SpritePipeline virtual environment. SpritePipeline package installers must install this local package before installing SpritePipeline; it is not fetched from a package registry.

```python
from pixel_prop import Recipe, convert, inspect, ALGORITHM_VERSION
result = convert(source_bytes, Recipe(size=128, colors=24))
# result.png, result.report, result.compare are in-memory outputs.
```

Inputs: single-frame PNG, WebP or JPEG, longest edge ≤4096. Opaque input requires an exact background key such as `--background 'key:#ffffff'`. This is color keying, not semantic background removal. An empty image or output without transparency is rejected.

Recipes are JSON objects with these defaults:

```json
{"size":128,"padding":4,"fit":"contain","anchor":"bottom","resample":"area","alphaThreshold":128,"colors":24,"palette":null,"dither":false,"removeIsolated":true,"outline":"none","background":"alpha"}
```

- `size`: 64 or 128; `padding`: 0–16; `anchor`: bottom or center.
- `resample`: area (premultiplied-alpha box average), dominant (most frequent visible RGBA in each source region, stable tie ordering), nearest (region center).
- `alphaThreshold`: 1–254; `colors`: 0 (preserve) or 2–64.
- `palette`: a list of `#RRGGBB` colors or JSON list file. Recipe-file palette paths are relative to the recipe. The workbench also resolves `object:<id>` for registered PixelLab props.
- `dither`: deterministic Floyd–Steinberg diffusion, default false.
- `removeIsolated`, default true: a visible pixel with no same-colour four-neighbour takes the most common colour of its visible neighbours; only a detached speck with no visible neighbour (diagonals included) becomes transparent. Cleanup never opens holes inside the subject.
- `outline`: none, dark, or `#RRGGBB`; adds a one-pixel outer contour without changing interior pixels.

The pipeline crops the visible bounding box and contains it within the padded canvas, thresholds alpha, performs deterministic weighted median cut and OKLab nearest-palette mapping, then cleans isolated pixels and applies the outline. PNG encoding uses fixed compression and no inherited metadata. The same source, recipe and algorithm version give identical pixels on every platform; PNG file bytes can differ between zlib builds, so compare `pixelSha256` (hash of the decoded RGBA pixels) rather than the file hash across machines. The report includes source/output file hashes, `pixelSha256`, canonical recipe/hash, algorithm version, dimensions, palette and alpha diagnostics, bounding box and warnings. The comparison shows the source beside a 4× nearest-neighbor output on a checkerboard.

CLI stdout is JSON. Exit status: 0 success, 2 invalid arguments/recipe, 3 invalid input or file I/O. Standard argparse help/errors go to the usual help/stderr streams.

Run tests: `python -m pytest Tools/PixelProp/tests`. Golden fixtures are generated from public geometric artwork in `examples/` and pin pixels by `pixelSha256`; no private assets are needed. Pillow upgrades require running these checks and reviewing golden changes before increasing the supported range or algorithm version. PixelProp conversion alone does not guarantee clean pixel art or PixelLab animation quality; compare small parts and thin lines before adoption.
