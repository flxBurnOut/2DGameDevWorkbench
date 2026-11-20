import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("stage_assets", ROOT / ".agents/skills/forge-game-engineering/scripts/stage_assets.py")
stage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stage)
FIXTURES = Path(os.environ["WORKBENCH_ENGINEERING_FIXTURES"])


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=FIXTURES)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.spec = json.loads((FIXTURES / "sprite.json").read_text(encoding="utf-8"))
        self.before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in FIXTURES.iterdir() if p.is_file()}

    def tearDown(self):
        for name, sha in self.before.items():
            self.assertEqual(hashlib.sha256((FIXTURES / name).read_bytes()).hexdigest(), sha)

    def sprite(self, spec=None):
        path = self.root / "input.json"
        path.write_text(json.dumps(spec or self.spec), encoding="utf-8")
        return stage.stage_sprite(path, self.root / "out", "Assets/Hero")

    def bad_sprite(self, edit, pattern):
        edit(self.spec)
        with self.assertRaisesRegex(ValueError, pattern):
            self.sprite()
        self.assertFalse((self.root / "out").exists())

    def test_ordered_frames_atlas_and_real_pngs_preserved(self):
        report = self.sprite()
        self.assertEqual(report["animations"][0]["frames"][0]["region"], [32, 0, 32, 32])
        self.assertEqual(report["animations"][0]["frames"][1]["region"], [0, 32, 32, 32])
        self.assertEqual(report["animations"][1]["frames"][1]["duration"], 2)
        self.assertFalse(report["engineValidated"])
        out = self.root / "out"
        self.assertFalse((out / "project.godot").exists())
        copied = list((out / "Assets/Hero/textures").glob("*.png"))
        self.assertEqual({hashlib.sha256(p.read_bytes()).hexdigest() for p in copied}, set(report["sourceFiles"].values()))

    def test_changed_source_rejected(self):
        self.bad_sprite(lambda s: s["animations"][0]["frames"][0].update(sha256="0" * 64), "SHA-256")

    def test_geometry_not_guessed(self):
        self.bad_sprite(lambda s: s["animations"][0]["frames"][0].update(region=[50, 0, 32, 32]), "exceeds")

    def test_inconsistent_frame_size_rejected(self):
        self.bad_sprite(lambda s: s["animations"][0]["frames"][0].update(region=[32, 0, 16, 16]), "dimensions differ")

    def test_loop_must_be_explicit(self):
        self.bad_sprite(lambda s: s["animations"][0].pop("loop"), "explicit boolean")

    def test_unknown_fps_not_invented(self):
        self.bad_sprite(lambda s: s["animations"][0].pop("fps"), "finite number")

    def test_no_empty_or_duplicate_animation(self):
        for change in (lambda s: s["animations"][0].update(frames=[]), lambda s: s["animations"][1].update(name="attack")):
            with self.subTest():
                self.spec = json.loads((FIXTURES / "sprite.json").read_text(encoding="utf-8"))
                self.bad_sprite(change, "frames|unique")

    def test_invalid_trigger_and_namespace_rejected(self):
        self.bad_sprite(lambda s: s["animations"][0].update(frameEvents={"99": "damage"}), "frame event")
        with self.assertRaises(ValueError):
            stage.resource_root("../game")

    def test_existing_target_untouched(self):
        out = self.root / "out"
        out.mkdir()
        marker = out / "project.godot"
        marker.write_text("user project", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.sprite()
        self.assertEqual(marker.read_text(), "user project")

if __name__ == "__main__":
    unittest.main()
