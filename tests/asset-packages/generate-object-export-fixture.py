"""Regenerate the synthetic object ZIP through the real SpriteFrames exporter.

Run with Tools/SpritePipeline/.venv/bin/python. No provider or admission API is
called; this fixture exercises the export/import contract before N2.
"""
from pathlib import Path
import hashlib
import sys
import tempfile

from PIL import Image, ImageDraw

repository = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repository / "Tools" / "SpritePipeline"))
from sprite_pipeline.processing.godot_export import build_godot_package


def main():
    destination = Path(__file__).with_name("fixtures") / "interactable-animation.zip"
    with tempfile.TemporaryDirectory(prefix="object-export-fixture-") as directory:
        sheet = Image.new("RGBA", (256, 128), (0, 0, 0, 0))
        drawing = ImageDraw.Draw(sheet)
        drawing.rectangle((40, 16, 87, 119), fill=(90, 60, 30, 255))
        drawing.rectangle((168, 16, 183, 119), fill=(90, 60, 30, 255))
        sheet_path = Path(directory) / "sprite-sheet.png"
        sheet.save(sheet_path)
        recipe = {
            "job_id": "fixture_door_open", "candidate_index": 1,
            "character_id": "fixture_door", "object_id": "fixture_door",
            "object_type": "interactable", "action_id": "door_open",
            "frame_count": 2, "runtime_fps": 8, "loop": False,
            "cell_width": 128, "cell_height": 128,
            "source_region_px": [[0, 0, 128, 128], [128, 0, 128, 128]],
            "sheet_sha256": hashlib.sha256(sheet_path.read_bytes()).hexdigest(),
            "diagnostic_only": True,
        }
        build_godot_package(sheet_path, destination, recipe,
                            anchor_x=64, ground_y=119, facing=None)
    print(destination)


if __name__ == "__main__":
    main()
