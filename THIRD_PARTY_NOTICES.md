# Third-party source and license status

This current-maintenance file records provenance and the license status of incorporated or behaviorally referenced source. It does not grant rights to user-supplied assets or externally generated media.

## NativeFramesGeneration / SpritePipeline

- Upstream: <https://github.com/flxBurnOut/NativeFramesGeneration.git>
- Synchronized through upstream commit `4f7f4cc4bee625d75c53570887ddf184dbe380ba` (attack sequence review, reference canvas and animation player, synchronized 2026-09-08), retaining the workbench job navigation, frame/export artifact endpoints, and their integration coverage under `Tools/SpritePipeline/`.
- License: MIT License, Copyright (c) 2026 flxBurnOut.
- Authorization confirmed by the copyright holder on 2026-09-04. The integrated copy includes its license at `Tools/SpritePipeline/LICENSE`; the upstream repository also carries the MIT license.
- Distribution status: **resolved under the MIT License**.

The workbench's `sprite-pipeline` adapter communicates with this component through its documented local REST API. Workbench-local additions also include the reference-art gateway and character deep-link handoff; these are not part of the upstream synchronization baseline.

## FrameRonin compatibility reference

- Upstream: <https://github.com/systemchester/FrameRonin.git>
- Website behavior reference: <https://frameronin.com/>
- No FrameRonin source is included in the tracked workbench. The map editor is a modular compatibility implementation built around the public Pixelwork v2 state shape and observed user-facing behavior.
- Any local reference clone under ignored runtime directories is research material only and must not be packaged or published.

## copyWorms interaction reference

- Upstream: <https://github.com/flxBurnOut/copyWorms>
- Reference revision: `bb1581d12c9626e294e403a01db5f3cffb229cd8`.
- Reference files: `LevelModule/Formal/InteractiveObject.gd`, the input and nearest-object selection in `LevelModule/Formal/Level_01.gd`, and `Tools/DropItem.gd`.
- `features/interactable-editor/godot-templates/` implements generalized range, focus, completion, and pickup behavior informed by those files, with new configuration, state isolation, dialogue, and packaging code. It does not embed copyWorms assets, game scenes, player controllers, singletons, or a source checkout. Exports are self-contained and never download upstream code.

## Package dependencies

### Optional visual structure runtime

- `Tools/VisualStructure/` is Forge integration code for the public SAM 2 API.
- Optional runtime: <https://github.com/facebookresearch/sam2>, pinned in
  `Tools/VisualStructure/runtime-profile.json` to commit
  `2b90b9f5ceec907a1c18123530e92e794ad901a4`.
- SAM 2 source and checkpoints use Apache-2.0; its upstream third-party files
  retain their own notices, including BSD-3-Clause components. Preserve those
  notices in any separately distributed runtime.
- Source, weights and the independent Torch environment are downloaded locally
  into ignored `work/visual-structure-runtime/`; they are not included in the
  tracked workbench or installed into SpritePipeline. No access credentials are
  distributed. SAM 3 is not bundled or part of this runtime profile.

JavaScript and Python dependencies retain their own licenses and notices. Exact installed JavaScript versions are recorded in `package-lock.json`; exact SpritePipeline Python versions are recorded in `Tools/SpritePipeline/requirements.lock`.

## External API services

Optional map original-image and layer generation can call Google Gemini (`gemini-3.1-flash-image`), OpenAI Images (`gpt-image-2`) or Tencent TokenHub Hunyuan Image 3.0 (`hy-image-v3`). Those services and their model outputs are not incorporated source dependencies; use is subject to the account owner's provider terms, configuration, usage limits, and content rights. No provider credential is distributed with this repository.

SpritePipeline can use providers configured within that component. Its provider-specific behavior and terms are documented by the upstream component and service; the workbench does not redistribute provider credentials.

## CopyWorms engineering reference

- Reference revision: `bb1581d12c9626e294e403a01db5f3cffb229cd8` of <https://github.com/flxBurnOut/copyWorms>.
- `.agents/skills/forge-game-engineering/` documents the project's actual architecture and asset contracts. Its small visual adapter and map mount helper adapt `PlayerModule/Formal/Player_Warrior.gd` playback/facing and `LevelModule/Formal/Level_02_SceneBuilder.gd` map re-entry behavior. It does not package game art, full player controllers, global managers or Pixelwork/plugin runtime code.
- The inspected game README states learning and competition use; this notice does not imply an MIT grant for that game or its third-party components. Any future source extraction must preserve provenance and applicable terms.

The workbench-integrated SpritePipeline additionally includes a local Godot SpriteFrames package exporter (`processing/godot_export.py`) and its UI/API/artifact integration. These changes are local integration work beyond the recorded upstream synchronization baseline; they do not imply that the independent upstream repository has been updated.

The Forge-specific `sprite_pipeline/workbench_export.py` bridge connects native sprite exports to the workbench project picker and Agent handoff. It is a workbench integration addition, not a claim of synchronization to the independent SpritePipeline upstream.
