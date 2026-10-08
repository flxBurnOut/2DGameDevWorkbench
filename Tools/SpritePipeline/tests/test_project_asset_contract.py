from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from sprite_pipeline.models import ActionPreset, CharacterPreset
from sprite_pipeline.project_profile import DREAMWEAVER_PROFILE
from sprite_pipeline.prompts import compose_generation_prompt


class ProjectAssetContractTests(unittest.TestCase):
    def test_cyber_warrior_actions_use_uniform_sixteen_frame_contract(self) -> None:
        profile = DREAMWEAVER_PROFILE
        self.assertEqual(profile.manifest_character_id, "player_warrior_cyber")
        self.assertEqual((profile.cell_width, profile.cell_height, profile.columns), (128, 128, 4))
        expected = {
            "idle": ("idle", "赛博人物待机.png", 16, 8, True, (512, 512)),
            "walk": ("walk", "赛博人物行走.png", 16, 5, True, (512, 512)),
            "jump": ("jump", "赛博人物跳跃.png", 16, 6, True, (512, 512)),
            "attack": ("attack", "赛博人物攻击.png", 16, 18, False, (512, 512)),
            "attack_in_air": ("attack_in_air", "赛博人物空中攻击.png", 16, 18, False, (512, 512)),
            "hurt": ("hit", "赛博人物受击.png", 16, 12, True, (512, 512)),
            "backward_evade": ("backward_evade", "赛博人物向后闪避.png", 16, 12, False, (512, 512)),
            "death": ("defeated", "赛博人物失败.png", 16, 12, False, (512, 512)),
        }
        self.assertEqual({item.action_id for item in profile.actions}, set(expected))
        for action in profile.actions:
            with self.subTest(action=action.action_id):
                manifest_name, filename, count, fps, loop, size = expected[action.action_id]
                self.assertEqual(action.manifest_action_name, manifest_name)
                self.assertEqual(action.filename, filename)
                self.assertEqual((action.frame_count, action.fps, action.loop), (count, fps, loop))
                self.assertEqual(action.provider_frame_count, 16)
                self.assertEqual(action.sheet_size, size)
                self.assertEqual(len(action.frame_cells), count)
                self.assertEqual(action.frame_cells, tuple((index % 4, index // 4) for index in range(16)))
                self.assertEqual(action.unused_cells, ())
                self.assertFalse(action.is_sparse)

    def test_every_bundled_action_preset_defaults_to_sixteen_frames(self) -> None:
        expected_cells = [(index % 4, index // 4) for index in range(16)]
        for path in sorted((PROJECT_ROOT / "presets" / "actions").glob("*.json")):
            action = ActionPreset.model_validate(json.loads(path.read_text(encoding="utf-8")))
            with self.subTest(action=action.action_id):
                self.assertEqual(action.frame_count, 16)
                self.assertEqual(action.generation_frame_count, 16)
                self.assertEqual(action.generation_frame_selection, list(range(16)))
                self.assertEqual(action.frame_cells, expected_cells)
                self.assertEqual((action.sheet_columns, action.sheet_rows), (4, 4))

    def test_ground_attack_prompt_requires_exactly_one_charged_vertical_chop(self) -> None:
        action = ActionPreset.model_validate(
            json.loads((PROJECT_ROOT / "presets" / "actions" / "attack.json").read_text(encoding="utf-8"))
        )
        character_path = PROJECT_ROOT / "presets" / "characters" / "diagnostic_dummy" / "character.json"
        character = CharacterPreset.model_validate(json.loads(character_path.read_text(encoding="utf-8")))
        prompt = compose_generation_prompt(character, action)

        self.assertFalse(action.loop)
        self.assertIn("37.5% raise into a brief shoulder-back charge", prompt)
        self.assertIn("37.5% a fast high-to-low cut", prompt)
        self.assertIn("decelerating follow-through", prompt)
        self.assertIn("final 25% recover", prompt)
        self.assertIn("exactly one attack total", prompt)
        self.assertIn("after contact: no wind-up/swing; no repeat, second hit, combo, or loop", prompt)
        self.assertIn("vertical chop only; no horizontal slash, thrust, spin, or projectile", prompt)
        self.assertLessEqual(len(prompt), 1000)

    def test_actions_upgraded_from_lower_counts_are_marked_for_godot_follow_up(self) -> None:
        expected_legacy_counts = {
            "jump": 12,
            "attack": 5,
            "attack_in_air": 5,
            "hurt": 12,
            "backward_evade": 8,
        }
        for action_id in ("jump", "attack", "attack_in_air", "hurt"):
            with self.subTest(action=action_id):
                self.assertEqual(DREAMWEAVER_PROFILE.action(action_id).integration_status, "frame_upgrade")
        for action_id, count in expected_legacy_counts.items():
            with self.subTest(legacy_action=action_id):
                action = DREAMWEAVER_PROFILE.action(action_id)
                self.assertEqual(len(action.legacy_frame_cells), count)
                self.assertIsNotNone(action.legacy_sheet_rows)

    def test_backward_evade_is_explicitly_new_instead_of_claiming_existing_integration(self) -> None:
        action = DREAMWEAVER_PROFILE.action("backward_evade")
        self.assertEqual(action.integration_status, "new")
        self.assertIn("Godot", action.note)


if __name__ == "__main__":
    unittest.main()
