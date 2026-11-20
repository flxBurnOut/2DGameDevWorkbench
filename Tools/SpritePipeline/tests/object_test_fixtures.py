"""Synthetic existing object presets; never unlock provider reference transfer."""
from pathlib import Path

from PIL import Image, ImageDraw

from sprite_pipeline.models import InteractablePreset


def write_interactable(root, object_id="fixture_door"):
    directory = Path(root) / "presets" / "objects" / object_id
    directory.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    ImageDraw.Draw(image).rectangle((40, 16, 87, 119), fill=(90, 60, 30, 255))
    image.save(directory / "reference.png")
    preset = InteractablePreset(object_id=object_id, display_name="Fixture door",
        cell_width=128, cell_height=128, reference_frame="reference.png",
        anchor={"x": 64, "ground_y": 119}, identity_description="A simple brown door.")
    (directory / "object.json").write_text(preset.model_dump_json(indent=2), encoding="utf-8")
    return preset
