import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const pipeline = path.join(repository, 'Tools/SpritePipeline');
const python =
  process.env.WORKBENCH_TEST_PYTHON ||
  path.join(
    pipeline,
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
if (!existsSync(path.join(repository, 'node_modules/zod'))) {
  throw new Error('Run npm ci before testing the browser-to-engine handoff.');
}
const selections = [
  'test_open_motion.py::test_api_manual_review_guards_and_repeat_export',
  'test_motion_adjustments.py::test_complete_candidate_creates_version_preserves_old_export_and_all_other_frames',
  'test_open_motion_recovery_media.py::test_automatic_ready_recovers_original_authorization',
  'test_open_motion_recovery_media.py::test_stage_media_detects_stale_tokens_missing_and_changed_bytes',
  'test_interactable_motion.py::test_uploaded_prop_reference_is_typed_idempotent_and_starts_no_work',
  'test_interactable_state_chain.py::test_archive_chain_from_selected_pixels_to_next_request',
  'test_interactable_state_chain.py::test_deterministic_palette_edit_on_archive_stage',
  'test_interactable_state_chain.py::test_local_frame_edits_refuse_stale_locked_and_outside_pixels',
  'test_interactable_state_chain.py::test_only_confirmed_playback_copies_are_exempt_from_stall_detection',
  'test_interactable_state_chain.py::test_accepted_state_chain_delivers_editor_project_and_godot',
  'test_visual_structures.py::test_correction_restore_confirmation_preserve_versions',
  'test_tracking_anchors.py::test_correct_points_without_model_or_tracking_and_reuse_in_v4',
  'test_interaction_previews.py',
];
const directory = mkdtempSync(path.join(tmpdir(), 'forge-'));
try {
  const result = spawnSync(
    python,
    [
      '-X',
      'utf8',
      '-m',
      'pytest',
      '-q',
      '--tb=short',
      '--basetemp',
      path.join(directory, 'tests'),
      ...selections.map((test) => 'tests/' + test),
    ],
    {
      cwd: pipeline,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
}
