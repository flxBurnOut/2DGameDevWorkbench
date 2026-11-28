"""Small reproducible artwork for contract tests; original replay clips are optional."""
import io
import json
import os
from pathlib import Path

import pytest
from PIL import Image, ImageDraw


_root = os.environ.get("FORGE_MOTION_REPLAY_ROOT")
ARCHIVE = (Path(_root) if _root else Path(__file__).resolve().parents[3] / "examples") / "n2-pilot-20261110"
_has_archive = (ARCHIVE / "protocol.json").is_file()
if _root and not _has_archive:
    raise RuntimeError("FORGE_MOTION_REPLAY_ROOT must point to the directory containing n2-pilot-20261110")
archived = pytest.mark.skipif(not _has_archive, reason="historical pixel measurements require FORGE_MOTION_REPLAY_ROOT")


def _diagnostic_png(item, step=0):
    image = Image.new("RGBA", (128, 128))
    draw = ImageDraw.Draw(image)
    draw.rectangle((16, 24, 109, 104), fill=(37, 46, 60, 255))
    if item == "lamp":
        draw.rectangle((48, 35, 79, 61), fill=(60, 70 + step * 9, 64, 255))
    else:
        draw.rectangle((47, 34, 80, 83), fill=(80, 110, 125, 255))
    data = io.BytesIO()
    image.save(data, "PNG")
    return data.getvalue()


def reference_bytes(item):
    return (ARCHIVE / item / "A.png").read_bytes() if _has_archive else _diagnostic_png(item)


def lamp_frames():
    if _has_archive:
        return [p.read_bytes() for p in sorted((ARCHIVE / "lamp/seed-2202").glob("f*.png"))]
    return [_diagnostic_png("lamp", i) for i in range(17)]


def prop_action(item):
    if _has_archive:
        return json.loads((ARCHIVE / "protocol.json").read_text(encoding="utf-8"))["objects"][item]["action"]
    return f"Change the {item} from its initial state and hold the final state."
