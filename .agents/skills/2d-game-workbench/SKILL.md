---
name: 2d-game-workbench
description: Drive this repository's reusable 2D game production capabilities when a user asks to create, organize, preview, export, or hand off pixel character or item reference art, sprite-animation frames, saved map assets, independent Godot interactable objects, or completed scene exports. Map and scene production remain manual in the frontend; use forge-game-engineering for game architecture and scripts.
---

# Forge asset production

You are the main Agent running in an external client. The user's request controls scope and authorization. Use the repository registry and bridge so conversation-driven work follows the same task contract shown by the visual workbench. The web app provides task visibility and direct editing; it is not another Agent.

## Choose the bridge

- Prefer the `2d-game-workbench` MCP server when the host exposes it. It provides typed discovery, task execution, and status tools over STDIO.
- If MCP is unavailable, use the equivalent `npm run workbench -- ...` CLI commands from the repository root.

## Understand vague requests

Use the `conversationGuidance` returned by `workbench_list_capabilities`, or read [the shared conversation guide](../../../workbench/conversation-guide.md), when a creator describes a goal without tool parameters. It covers character art/motion, manual map editing boundaries, and interactable behavior. Inspect available context and assets first. Ask only about unresolved choices affecting the result; prefer WorkBuddy's currently available `AskUserQuestion` after reading its schema, with concise chat as fallback. Never invent tool availability, switch mode solely for a question, treat a cancelled question as an answer, or create placeholder tasks while clarifying. Do not ask again for choices already supplied. Preserve the user's plan-only versus execution scope.

## Workflow with MCP

1. Call `workbench_list_capabilities`. Do not infer an unregistered capability or operation.
2. Call `workbench_describe_capability` and shape the request to its declared input schema.
3. Keep user source files in place. Pass repository-relative paths when possible and never overwrite source assets.
4. Call `workbench_prepare_task` when the user explicitly requests input validation. Discussion and planning do not create records; resolve unapproved external execution before run.
5. Call `workbench_run_task` only when execution is authorized.
6. Read or refresh the returned task with `workbench_get_task`. Keep exact IDs, status and verified output paths as technical evidence; lead the user-facing reply with the outcome, exact artwork link and one useful next step.

## CLI fallback

1. Run `npm run workbench -- list --json` to discover available capabilities. Do not infer an unregistered capability.
2. Run `npm run workbench -- describe <capability-id> --json` and shape the request to its declared input schema.
3. Keep user source files in place. Pass repository-relative paths when possible and never overwrite source assets.
4. Run `npm run workbench -- prepare <capability-id> --input <json-file>` first when the user explicitly requests input validation. Discussion and planning do not create records; resolve unapproved external execution before run.
5. When execution is authorized, run `npm run workbench -- run <capability-id> --input <json-file>`; local-only operations do not require an external URL.
6. Use `npm run workbench -- status <task-id> --json` for follow-up. Keep exact IDs, status and verified output paths as technical evidence; lead the user-facing reply with the outcome, exact artwork link and one useful next step.

## Conversation-only production

- After list/describe, use `workbench_get_environment` to distinguish installation, service reachability, interface compatibility, and saved key state. If the local service is offline and installed, `workbench_start_services` starts it without generation; query environment until ready. Never repeatedly start an incompatible or occupied service.
- Use `workbench_list_presets` to discover real character/action IDs and defaults. Use `workbench_list_tasks` to find earlier work, including native jobs from the web page. Workbench task IDs and native job IDs are different identifiers.
- Read `workbench_get_result` to get structured characterId, candidates, orderedFrames and delivery paths. Use `workbench_read_artifact` for actual image inspection; GIF preview contains only its first frame, so review ordered frame PNGs for motion.
- For a character brief with authorized generation, chain reference-art generate → get → get_result → transfer → get_result → sprite create-and-generate using the returned characterId. Reuse user-authorized scope; ask only about missing creative choices or additional cost, not internal IDs or routine tool parameters.
- For sprite review, use safety/check and inspect actual frames before approve. Record the visual reasoning in reviewNote, resolve rejected/repair-requested frames, and acknowledge only warnings actually evaluated. Export only after the underlying gate accepts review. Do not claim image quality based only on file existence.
- Recovery uses recover for a known PixelLab job or attach-provider-job for an independently known providerJobId. Never use create/generate as a polling or ambiguous-request recovery shortcut. Failed submissions can still contain a recoverable remoteJobId.
- Diagnostic fixture output proves orchestration only; never label it as AI-generated production art. Use normal production providers for real user assets.

## Guardrails

- Treat `workbench/manifest.json` as the source of truth shared with the web interface.
- Do not imply that the web app contains a general Agent chat. Browser page tools, when the host exposes them, are controls for the visible editor and do not replace repository MCP.
- Never invent a successful API response or claim an asset was generated when a task is only prepared or awaiting configuration.
- Read optional service URLs and tokens from environment variables named in the manifest. Never write secrets to the repository, task record, command output, or chat.
- If required input is missing, ask only for those fields. If an operation returns `awaiting_configuration`, preserve the task and explain the exact environment variable; do not treat other local adapter operations as unavailable.
- Keep task records under `work/` and generated or downloaded artifacts under `outputs/`; both are local runtime data and should remain uncommitted.
- Poll an asynchronous task with `get` or `status`; do not call `run` again merely to query progress.
- A task is complete only when its task record says `completed` and every reported output path exists. Check/save completion is not artwork approval or export; inspect the actual candidate state. `attention_required` needs review or recovery, not blind resubmission.

## Capability selection

- Use `reference-art` `generate` with `subject=prop` for a single isolated PixelLab item (128x128 transparent side-view PNG, prompt up to 1800 characters). Poll the same task, inspect the image and use the exact `artTask` editor link. Inventory uses `kind=prop`. The image is not an interactive object or a character preset; never transfer it. For a requested complete object, bind the returned PNG path/data and `generation: {sourceTaskId, sha256}` metadata into the selected existing project's assets, preserve project/definition IDs, set the selected default visual, and save/export through interactable-editor. Do not silently replace state-specific art. Read [item art](../../../docs/prop-art.md).

- Use `reference-art` `generate` for PixelLab character images (64x64 or 128x128 transparent PNG, default 128; prompt and optional name/facing/seed/size). It shares the SpritePipeline protected key. Use `transfer` with the completed source task ID to import a reusable character; this never generates animation. Poll with get/status and never resubmit to recover an ambiguous paid POST.

- Use `sprite-generator` for SpritePipeline `create`, `create-and-generate`, `generate-existing`, `get`, `export`, `check`, `safety`, `review-frame`, `approve`, `reject`, `recover`, and `attach-provider-job`. Use declared preset IDs; do not derive IDs from free text.
- Map original-image generation, stitching and extension are manual frontend workflows. MCP excludes map-stitcher; direct the user to /tools/map-stitcher. Do not bypass this boundary through CLI, HTTP or browser tools.
- Use `interactable-editor` `save-project` for complete editable source and `export-godot` for inspect, toggle, pickup, and sequence objects. Export is local and does not require credentials, SpritePipeline, a Godot installation, or a mandatory validation step.
- Scene composition is a manual `editorModules` workflow, not an executable MCP capability. It consumes existing maps and interactables.
- For copyWorms compatibility, use the declared `copyworms` target profile. Export success means files were created, not that the target game passed engine regression tests.
- When a request spans capabilities, run separate tasks as authorized, then summarize their outputs together.

## Read only what the task needs

- Overall architecture and state boundaries: `docs/architecture.md`.
- Reference images, shared credentials and handoff: `docs/reference-art.md`.
- Sprite operations and asynchronous behavior: `docs/sprite-generator.md`.
- Map composition, external generation, state, and export: `docs/map-stitcher.md`.
- Interactable schema, assets, profiles, and Godot handoff: `docs/interactable-editor.md`.
- Protocol and troubleshooting: `docs/connector-contract.md` and `docs/agent-clients.md`.

- First-stage MCP acceptance and manual prompts: `docs/agent-phase1-acceptance.md`.
- Full human procedures, backup and troubleshooting: `docs/operations-manual.md`.

## Interactable authoring

Use workbench_interactable_template for a complete inspect/toggle/pickup/sequence project without creating a task. Fill in the requested behavior and supplied assets, preserving projectId and definitionId. Run save-project to persist a portable source project without exporting. get_result.viewPath opens this task in the frontend editor; differing local drafts are retained separately. Resume by reading the existing source artifact, editing it and saving again. Use export-godot only for a requested package. A saved logic draft is not an exported asset or generated artwork.

## Present work in WorkBuddy

Use [execution-stage preview following](../../../docs/agent-preview-follow.md): call workbench_present before execution to arm this MCP connection, then run/get_task publish their current step automatically. After reading a different existing artwork or candidate, explicitly present its exact identity. Check requestId with workbench_get_frontend_context; never claim pending as displayed. Pause/busy/save failures keep the current page; do not use host navigation to override them. Repeated polls do not reload the page. Current-page summaries identify browser work but do not expose draft pixels or full map state.

Follow the shared conversation guide's presentation section. Prefer `presentation.summary`, `viewUrl` and `actions`; retain the full structured result for reasoning rather than pasting it into chat. Query a native animation with `get_result(jobId, candidateIndex?)` and a workbench record with `get_result(taskId, candidateIndex?)`; exactly one identifier is required. Neither lookup creates a task or starts generation. Text-only clients can request `detail:true` to read complete artifacts and review evidence; keep those details out of routine user replies.

On the first WorkBuddy conversation preview, select the known artwork with workbench_present and open preview.hostAction.arguments unchanged, including previewSession. Use only a discovered host tool with its real schema. Later reuse the existing preview if supported and editing is safely saved, otherwise provide the exact link. Never reopen after dismissal or on reconnection without the user's request. Tool URLs and `browserOpened:false` are not evidence that a browser opened. Ask only the material unresolved choice through the available host question tool; no answer or cancellation means no selection.

Default reply: concise outcome, actual preview/link, one next step. Expand technical detail when requested or needed. Show animation in its player; a GIF first-frame image is insufficient motion evidence. Saved, review-ready, approved and exported remain distinct states.

## Inventory and handoff

Use `workbench_list_assets` for existing artwork, and list_tasks for execution history. Read [the asset catalog guide](../../../docs/asset-catalog.md) when inventorying or handing off assets. Follow nextOffset with snapshot until the requested scope is covered. Filter structured fields rather than searching an entire natural-language sentence: “latest three-candidate animation, candidate 2” means kind=animation, candidateCount=3, candidateIndex=2, sortBy=createdAt, limit=1.

Use get_asset for the exact assetId before making a handoff; preserve source relationships and file hashes. One animation candidate is one asset; retries/checks/exports are not extra artworks. Use get_asset_manifest with explicit selected assetIds for a portable inventory. Save returned data only where the user requested; this tool does not copy materials or change a game project. Missing files, pending review, source-only interactables and engine validation remain separate facts.

Coverage only includes persisted server assets. Do not claim browser-only maps, scenes, drafts or external project folders were inspected. Offline/partial coverage is not proof of deletion. Refer users to the existing editor for those drafts; map creation remains manual. Present useful category totals, preview links and unresolved issues without pasting the full file list into ordinary chat.

## Deliver actual export files

Completed manual scene exports are indexed as kind=scene, with a distinct asset per exportId and the saved sceneId/revision. Download provides the original scene-source.zip and scene-godot.zip; import the source ZIP in the scene editor to continue. Reads do not export again or index browser drafts. Archived execution history never hides assets. Asset details retain original creation time and source history; list_tasks supports offset/snapshot pagination over all unarchived records, following nextOffset until null.

Prefer an existing verified export. Current approved SpritePipeline export supplies PNG/sheet, preview, recipe/QA and a Godot ZIP via `godotPackage`; old records may omit the optional ZIP. Read `docs/sprite-generator.md` for the package contract. Do not regenerate, approve or re-export just because the user browsed or downloaded an older asset.

The SpriteFrames pack preserves exact selected frame order/regions, action alias, FPS and loop. Copy its `forge_sprites` tree intact; it supplies a single action and optional visual scene, not a game controller. Updating an existing multi-action character requires a clip merge through the engineering Skill. Asset-library download copies real bytes into ZIP; `get_asset_manifest` is a descriptive handoff and never substitutes for those files. Export success alone is not target-engine validation.

## Diagnose configuration accurately

Check API compatibility and UI readiness separately; `sprite-pipeline:api` does not serve the embedded UI. PixelLab Key is shared and persists in protected SpritePipeline settings; map keys also persist in protected local configuration, with server environment as an alternative. Dedicated settings return configured state, never key values. Startup tools do not install dependencies or restart occupied/incompatible services. Read `docs/operations-manual.md` before maintaining or restarting a service, and retain the user's data directory and in-flight work.

## Export directly to the selected game

Read [Godot delivery](../../../docs/godot-delivery.md) when exporting ready assets to an existing game. The frontend remembers the chosen project and writes an immutable delivery; export_to_game does the same for an exact saved assetId/revision. Only an existing Godot package can be delivered: no generation, implicit approval or replacement candidate. Map/scene production remains manual.

When continuing an authorized game task, list_game_exports then get_game_export finds the package and target without asking the user to locate files. Switch to the engineering Skill for install_game_export and actual code integration. Do not stop at copied resources or ask the user to delete project.godot, repair res paths or mount nodes. Preserve existing controllers, custom changes and other clips. The host Agent is not automatically awakened by a browser export; pending, assets installed, integrated and engine-verified are different outcomes.

## Continue into a game project

When the user wants architecture, Godot scripts or integration of ready assets, read the Skill at `agentAssets.engineering.skill` in the manifest. This is an external Agent workflow grounded in CopyWorms, not a new production operation. Keep the exact asset selections and their readiness evidence. Map production remains manual; the engineering Skill consumes exported scenes/maps. Preserve a planning-only request and the distinction between the read-only reference game and the authorized target project.

## Internal frontend reuse

See [internal imports](../../../docs/internal-imports.md) for asset-library source selection, map/object/scene handoff and editing existing materials. These frontend imports read existing assets without production tasks or generation; map editing and scene placement remain manual. Static props are appearance only; preserve behavior, project/object identity, source hashes and exact animation candidate/FPS/loop. Changes in an editor require explicit replacement in an existing scene. Older prop metadata can omit subject only when the original task explicitly says prop and content checks pass.

Project selection uses the in-page folder browser or an explicit typed path. Browsing is read-only and cancellable; it must not start an OS dialog or lock the export window. Selecting a folder alone does not create a delivery or authorize generation.

Current Forge export and engine verification baseline: Godot 4.7.x. Use GODOT_47_BIN for engine tests. Read the actual executable version before running; historical 4.6.x reports and previously exported assets remain provenance, not current validation.

For coarse pixel characters, choose size=64 at generation, inspect actual gameplay-scale appearance, then transfer the original bytes. transfer may include identityDescription (up to 300 characters) with appearance only; do not copy standing-pose instructions into motion generation. Long source prompts use the reference-image identity lock by default. Full original prompts stay in source tasks.

Map assets include complete saved projects (mapType=project) and durable image/history assets (mapType=image); kind=map without mapType returns both. Preserve legacy asset IDs and exact source files. Resume a project through its exact editorPath; map-source.zip is editable source and can be imported into the map editor or scene composer, not used as a prop image or claimed as an existing Godot export. Project thumbnails remain display attachments. Browser-only legacy drafts require a manual open/save before server indexing; never bypass the manual-map boundary.

Map project thumbnails are optional, version-bound display attachments rendered locally by the manual editor. They are not separate map assets or engine exports. Missing previews do not imply missing source; legacy projects gain a thumbnail on the next manual open/save. Asset reads never render or generate a thumbnail.

## Recoverable asset recycle bin

Asset listing defaults to `scope=active`; use `scope=trashed` to inspect the recoverable recycle bin. Exact details expose `trashedAt`. The frontend confirms explicit selections before trash/restore; source files, original tool content, task history and existing scene references remain intact. This organizes the catalog and does not free disk space. A source being offline does not mean deletion; restoring a catalog entry does not repair missing files. Do not clean existing assets merely because the user requested implementation of the feature.

## WorkBuddy session preview

WorkBuddy MCP 0.11: use the returned preview.hostAction (including its previewSession URL) with the discovered host-native present_files schema. A visible page from this MCP session is required before the first run_task; preview_required means createsTask=false and providerCalled=false, so open/confirm the preview before resubmitting the same request. Once connected, run_task automatically arms following. Existing-task and candidate selections can still use workbench_present. Paused/blocked pages are never forced. When the user declined or closed the preview in this conversation, or the host tool was verified unavailable, pass the matching previewPolicy (user-declined/user-dismissed/host-unavailable) and report the reason; never silently bypass the gate. Explicitly requested reopening can use previewPolicy=auto. Other MCP clients stay headless unless explicitly presenting. The server cannot open WorkBuddy UI itself; page acknowledgement, not a returned URL, proves arrival.

## Sprite delivery from the native export step

In the embedded sprite workspace, a successful PNG + Godot export opens the shared game-project delivery dialog; the saved-export button can reopen it. The bridge carries the exact job and candidate, and mismatched saved packages are rejected. Copy the animation-specific WorkBuddy handoff after delivery: merge only this clip into the existing SpriteFrames/controller and preserve other actions, facing, scale, offsets and gameplay timing. Export/clipboard success is not Agent execution or engine acceptance. Standalone SpritePipeline retains ZIP downloads.

An approved/exported animation returns to export without another approval or generation. Library export and review return recover the exact candidate’s saved PNG/Godot files. Legacy PNG-only exports suggest a new filename for a complete package, preserving the old bundle; normal QA gates still govern rebuilding. Do not treat missing historical vision evidence as proof the user edited a frame.

Local reference import: reference-art operation=import copies a repository-contained 64/128 transparent PNG (sourceImagePath) and records import provenance; prompt is a description added at import, not evidence of an API generation. It needs no model or PixelLab service. Imported characters appear in reference history and may be transferred through the normal hash-checked flow; transfer still needs the local SpritePipeline service.
