# Pixel Sprite Generation Harness (V0.1)

[中文说明](README.zh-CN.md)

This local harness turns transparent character reference art and an action spec
into auditable PNG animation candidates, deterministic QA previews, and a staged
Godot-compatible Sprite Sheet. It follows the repository plan while keeping the
core independent from any one operator interface.

The same `SpritePipelineService` is used by:

- PixelLab Animate with Text V3 or an offline diagnostic provider;
- a JSON-only command line designed for direct Codex orchestration;
- a loopback REST API for another tool or script;
- a seven-page, project-guided Gradio operator page.

It never writes into formal game asset directories or mixes normal user data
with source code. Runtime jobs and user character packages default to
`%LOCALAPPDATA%\SpritePipeline`; approved exports default to
`Documents\SpritePipeline\Exports`. Passing `--root` explicitly enables
portable/test mode.

## Implemented scope

- Versioned character/action presets with strict 64×64 or 128×128 cells.
- Durable JSON jobs, reference checksums, prompt snapshots, seeds, provider job
  IDs, redacted request/response records, usage, review state, and export hashes.
- PixelLab V3 submission and bounded background polling using the current
  official REST contract.
- Serial candidate generation; no credit-bearing POST retry after an ambiguous
  transport result.
- Live quota checks and an OS-backed cross-process lock around each chargeable
  submission, shared by the UI, REST API, and CLI.
- Documented dynamic unit estimation:
  `ceil(width * height * provider_frame_count / 65536)`. A 128x128,
  4/8/16-frame candidate costs approximately 1/2/4 subscription units.
- Idempotent task creation, append-only task revisions, background restart
  recovery, atomic result publication, and committed frame checksums.
- Successful responses with a different image count preserve every valid frame,
  surface a review warning, and pad the final project-width grid with transparent
  trailing cells instead of discarding paid output.
- Offline `fixture` provider for end-to-end diagnostics without a token. Its
  output is always marked `diagnostic_only` and is not production animation.
- Import from ordered PNG directories, animated GIFs, regular Sprite Sheets,
  and manifest-mapped sparse project sheets.
- Hard QA gates for count, dimensions, corruption, blank content, source alpha,
  configurable consecutive duplicate runs, and high-confidence abrupt
  frame-to-frame position jumps.
- Character-level warning thresholds for safe margins, area drift, centroid
  jumps, palette deviation, loop closure, and grounded baseline drift.
- Original/enlarged GIFs, enlarged indexed grid, adjacent-frame onion skins,
  project reference lines, and a preview sheet.
- Explicit per-frame review, replay-on-demand, a full repair timeline with pending, approved,
  repair-requested, modified, and blocking states, previous/next-problem
  navigation, keep-without-edit for falsely flagged or acceptable frames,
  a lossless in-browser pixel editor, unlimited local manual
  versions, two separately bounded external/future-AI replacements per bad
  frame, and deterministic staged export.
- Exported PNG, preview GIF, recipe JSON, and QA JSON.
- A progressively disclosed project UI whose default path is Start → 1 Generate
  (including reference import) → 2 Playback Review → optional 3 Frame Repair →
  4 Export.
  Every stage provides an explicit next action; approval opens and populates
  Export automatically. Recovery, raw records, existing-sheet import, and
  external whole-frame replacement remain available in clearly labelled
  secondary panels. The Asset Library and Settings sit outside the main path.
- A bundled Dreamweaver / Cyber Warrior profile: 128×128 RGBA cells, four
  columns, anchor (64,106), and a uniform sixteen-frame 4x4 / 512x512 output
  sheet for every new action while retaining project timing and filenames.
- Eleven bundled action templates. The project UI exposes idle, walk, jump,
  ground attack, air attack, hurt, backward evade, and defeated; three generic
  templates remain available to API/CLI users.
- Every bundled action now requests and exports sixteen frames. The generic
  import/recovery path still preserves valid non-sixteen and sparse legacy
  sheets instead of discarding existing or already-paid artwork.

PixelLab Edit Animation V2 and GPT-Image-2 automatic repair are intentionally
not in V0.1. The built-in editor already provides exact RGBA pencil and an
eraser that clears both generated and newly painted pixels to transparent black,
eyedropper, exact four-connected fill, rectangular selection with integer-pixel
nudge, opt-in previous/next onion skins that are temporarily hidden while erasing,
position deltas, integer zoom, a non-exported
pixel grid, pan, undo/redo, bounded crash-recovery drafts, and verified manual
versions. Manual-save and QA status are reported separately, so a durable
version cannot be misreported as lost when a later preview check fails. A
repaired PNG can still be inserted with the separately bounded `replace-frame`
fallback. `replace-frame` also requires the source frame's captured SHA-256, so
an external editor cannot silently overwrite a newer version.

Drafts retain both the base and edited RGBA buffers. If another window changes
the durable frame, recovery performs a three-way pixel merge and only applies
non-conflicting changes; editing stays locked until the recovery choice is
resolved. Every page instance has an independent draft slot, preventing cloned
or late-closing tabs from overwriting each other. External replacement uploads
are likewise bound to the job, candidate, frame, and base SHA-256 captured when
the file was selected, and are cleared whenever that repair context changes.

Successful QA records its algorithm version. A candidate approved under an
older QA version may be rechecked before export and must then be approved again;
an exported candidate remains immutable. The export recipe and QA report both
record the QA algorithm version.

After a manual or external frame repair, the repair page persists and displays
an issue delta—resolved, new, and persisting—against the last successful QA.
If rechecking fails, that baseline remains available for a later retry.

For provider-generated candidates, the immutable source manifest, commit marker,
and raw PNGs are service-level prerequisites for QA, approval, and export. An
active repaired frame may differ from its raw source, but cannot hide source
corruption. Repeated recovery scans of the same persistent error are no-ops and
do not grow the append-only job journal indefinitely.

Codex may commit a same-size transparent PNG with `pixel-edit-frame`. Its
`--base-sha256` is mandatory and must be the hash captured when the source
frame was read, so a stale local edit cannot overwrite a newer UI/API/CLI
version.

## Install

Python 3.11 or newer is required.

```powershell
cd Tools\SpritePipeline
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

If `python` is not on `PATH` on a Windows Codex host, bootstrap from the bundled runtime:

```powershell
$codexPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $codexPython -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Save the PixelLab token from the UI's **API & Project** page; it takes effect
without restarting. Windows stores it with current-user DPAPI protection. The
token is only placed in the Bearer header, and persisted provider records redact
secrets and base64 image bodies. Automated deployments may use the process
environment variable `PIXELLAB_API_KEY`, but a real token should no longer be
stored in the repository `.env`.

## Add a character

Copy `presets/characters/_template/character.example.json` to
`presets/characters/<character_id>/character.json`, then add at least
`idle_reference.png`. The reference must match the configured 64×64 or 128×128
size, contain an alpha channel, and contain visible pixels.

Keep `identity_description` about identity only. Put anticipation, contact,
hold, recovery, and looping behavior in an action JSON under `presets/actions/`.
QA thresholds belong in the character preset rather than processing code.

The template leaves optional assets as `null`; set a filename only when that
asset is present. `list-presets` verifies referenced assets and marks broken
packages invalid.

## Offline smoke test

The bundled `diagnostic_dummy` and `fixture` exercise the complete workflow
without a token or network call. Their outputs are never production art:

```powershell
$created = .\harness.ps1 create --request examples\create_job.json | ConvertFrom-Json
$jobId = $created.data.job.job_id
.\harness.ps1 generate --job $jobId
.\harness.ps1 approve --job $jobId --candidate 1 --reviewer codex --acknowledge-warnings
.\harness.ps1 export --job $jobId --candidate 1
```

## Codex / JSON CLI

Every successful command prints one UTF-8 JSON object to stdout and exits `0`.
Expected validation/workflow errors also print one JSON object and exit `2`.
This makes commands safe for Codex to call and inspect without screen control.

From `Tools/SpritePipeline`:

```powershell
.\harness.ps1 list-presets
$created = .\harness.ps1 create --character your_character --action forward_thrust --provider pixellab --candidates 1 --request-key <stable-unique-value> | ConvertFrom-Json
$jobId = $created.data.job.job_id
.\harness.ps1 generate --job $jobId
.\harness.ps1 status --job $jobId
.\harness.ps1 safety --job $jobId --candidate 1
```

On a Windows Codex host where `python` is not on `PATH`, use the included
launcher; it checks `.venv`, `PATH`, then the bundled Codex runtime:

```powershell
.\harness.ps1 list-presets
```

If PowerShell execution policy blocks `.ps1` files, use the equivalent CMD
launcher without changing machine policy:

```powershell
.\harness.cmd list-presets
.\harness.cmd serve-ui
```

Every later `harness.ps1` example can be replaced verbatim with `harness.cmd`.

Each candidate is a separate generation submission, so the UI and examples
default to one. One submission can consume more than one subscription unit;
use `estimate --character <id> --action <id> --candidates <n>` first.
Generation is sequential when more are requested. `generate`
waits by default. Use `--no-wait` to advance one submission/poll step, then call
it again after inspecting the durable status. `recover-all` scans every durable
task using only existing provider IDs. A `submission_unknown` candidate must
never be resubmitted; attach a discovered original ID with
`attach-provider-job`. To salvage an older candidate
whose provider job completed but the former strict count check rejected, run
`harness.ps1 recover --job <id> --candidate <n>`; recovery only polls the
existing provider job and never submits a new generation.

Review warnings before approval. The explicit acknowledgement is deliberate:

```powershell
.\harness.ps1 approve --job $jobId --candidate 1 --reviewer codex --acknowledge-warnings
.\harness.ps1 export --job $jobId --candidate 1
```

For existing frames or another generation API, create an `import` job and feed
its output into the same checks:

```powershell
.\harness.ps1 create --character your_character --action forward_thrust --provider import --candidates 1
.\harness.ps1 ingest --job <job_id> --candidate 1 --source D:\candidate_frames --kind png_dir
```

Sprite Sheet import requires `--kind sheet --columns N`. Provider, GIF, and
directory inputs preserve their actual usable frame counts. A provider count
difference is a review warning; unreadable, inconsistent-size, or otherwise
invalid frames remain blocking failures.

Use the REST API below for integration; generation, review and export remain separate steps.

## REST API

Start the loopback-only server:

```powershell
.\harness.ps1 serve-api
```

Interactive OpenAPI docs are at `http://127.0.0.1:8765/docs`. Main routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Local readiness and provider configuration |
| `GET` | `/v1/system/storage` | Separated data paths and migration status |
| `GET` | `/v1/account/balance` | Refresh the non-chargeable account balance |
| `GET` | `/v1/account/estimate` | Estimate dynamic generation units locally |
| `GET` | `/v1/jobs` | Read lightweight saved-task summaries without loading frames or previews |
| `POST` | `/v1/jobs` | Idempotent create from `GenerationRequest` JSON |
| `POST` | `/v1/jobs/{id}/generate` | Submit/poll one or all candidates |
| `GET` | `/v1/jobs/{id}` | Read the durable job record |
| `GET` | `/v1/jobs/{id}/candidates/{n}/safety` | Compact submit/result-integrity status |
| `POST` | `/v1/recovery/run` | Safely resume all durable tasks |
| `POST` | `/v1/jobs/{id}/candidates/{n}/recover` | Poll an existing provider job without submitting a generation |
| `POST` | `/v1/jobs/{id}/candidates/{n}/attach-provider-job` | Bind a known ID after an ambiguous submission |
| `POST` | `/v1/jobs/{id}/candidates/{n}/frames` | Import 1–64 base64 PNG frames |
| `GET` | `/v1/jobs/{id}/candidates/{n}/frames/{frame}/image` | Read the selected frame as a PNG artifact |
| `POST` | `/v1/jobs/{id}/candidates/{n}/reviews/frame` | Save one frame review |
| `GET` | `/v1/jobs/{id}/candidates/{n}/frames/{frame}/pixel-edit` | Read exact RGBA pixels and the base version hash |
| `POST` | `/v1/jobs/{id}/candidates/{n}/frames/{frame}/pixel-edit` | Commit a verified manual RGBA version and re-run QA |
| `POST` | `/v1/jobs/{id}/candidates/{n}/approve` | Explicitly approve a candidate |
| `POST` | `/v1/jobs/{id}/candidates/{n}/export` | Export after the approval gate |
| `GET` | `/v1/jobs/{id}/exports/{sheet|preview|recipe|qa}` | Read one recorded export artifact |

The API intentionally defaults to loopback and has no authentication. Do not
bind it to a public interface without adding access control and upload quotas.
Send an `Idempotency-Key` header when creating a task; retry the same request
with the same value after a client timeout to receive the original task.

## Operator UI

```powershell
.\harness.ps1 serve-ui
```

Open `http://127.0.0.1:7860`. **Artwork Library** is the first/default page,
followed by Guide & Example, Generate Animation, Playback Review, Frame Repair,
Export, and API & Project. Thumbnail cards show character references, saved
animation candidates, and imported maps, with type filters, search, and twelve
items per page. Card actions carry the exact character or candidate into the
existing generate, edit, review, or export workflow. Approved/exported candidates
remain read-only, and outdated QA requires review before export.

Empty, failed, and diagnostic executions remain available under **Execution
records** inside details; they do not create material cards. Character details
filter related executions, while animation details identify the owning task.
Full job history and candidate frames load only after opening a record.
Version 2 of `summary.json` indexes saved materials; old summaries are backfilled
once. The five-second refresh reads metadata and does not reset open details.
Only visible-page thumbnails are decoded/cached under `cache/artwork_thumbnails`;
animations use existing QA previews with an active-first-frame fallback.

**Import materials** saves character references without creating jobs. Static
PNG/JPEG/WebP maps (up to 32 MB / 16,777,216 pixels) are stored byte-for-byte under
`artworks/maps` in the user data directory and deduplicated by SHA-256. Maps offer
preview and original download; map generation/editing is outside this version.
An existing animation Sheet can be sent directly to the Playback Review import
panel. Closing the browser does not stop the local recovery worker.

Generate Animation accepts the character source PNG, reusable identity prompt,
and action prompt on one page. A 128×128 single frame is used directly; a
four-column project Sheet automatically contributes its first visible cell.
Existing completed Sheets are imported through Playback Review, where a
numbered grid is shown before they enter inspection. Frame Repair embeds the
exact-pixel editor and a full five-state frame timeline. It can jump to the
previous or next problem frame and preserves the current job, candidate, and
frame after saves, rechecks, and external replacements. Any frame in a
non-terminal, unexported candidate can be edited directly; only the bounded
external full-frame replacement still requires a repair-requested review mark.
For looping actions,
the last frame is the first frame's “loop previous” neighbor and the first frame
is the last frame's “loop next” neighbor. External PNG upload remains a
collapsed, provenance-bound fallback.
The diagnostic dummy appears only under Example.

## Tests

The unified pytest entry runs the Python suite and, when Node.js is installed,
the pure pixel-editor core suite. Tests do not make paid or network calls:

```powershell
python -m pytest -q
```

The real-browser smoke test—load, draw exact pixels, undo/redo, save, reload,
and byte-compare the result—has not yet been run. Python/Node regression tests
must not be reported as a passed browser smoke test.

The offline fixture proves storage, QA, review, and export plumbing. A real
model feasibility run with project characters is still required before treating
PixelLab as an approved production backend, as required by the original plan.
The idle fixture keeps the complete alpha silhouette at one canvas position and
changes only a few interior RGB pixels because idle has no intended root motion.
Other actions may move naturally. Generation prompts request a smooth
frame-to-frame root trajectory, while QA blocks high-confidence sudden jumps
without cropping, resizing, recentering, or changing the fixed cell dimensions.
New Cyber Warrior generations use one uniform 512×512, 4x4, sixteen-frame
contract for every action. Existing lower-frame assets remain valid import and
review inputs. Jump, ground attack, air attack, and hurt need their Godot frame
lists updated before replacement; backward evade still requires a new animation
and state mapping because it is not present in the supplied project manifest.

## License

This project is released under the [MIT License](LICENSE).

## 攻击视觉检查与人工修补



地面/空中攻击的新 PixelLab 任务默认使用 `two_stage_attack`：每个候选固定生成准备/蓄力、挥击/收招两个片段；16 帧默认使用 4 + 12 个请求帧：4 帧起势/蓄力，8 帧出刀与随挥，4 帧收招。出刀先快后慢；中间 8 帧包含同一次攻击的随挥减速，不要求把刀匀速慢挥 8 帧。空中攻击的前 4 帧为沿连续飞行轨迹准备，不强加地面蓄力。第二段使用第一段实际末帧作为起始参考，持续沿用同一持刀手和肩肘腕连接。新计划不再用可能握法不同的原图待机姿势强制收招终点；两段分别以自身起始参考锁定握刀臂，文字明确要求同一只手完成挥击并回到准备姿势。角色可用 `weapon_hand` 声明左右手/双手，默认沿用原图的持刀手；其值和原图哈希在创建时冻结。两段都复用普通生成的角色身份约束，并保留创建时的专属外观说明及不得新增披风的约束；衔接帧不能取代原型定义。分别给出短阶段提示词，第二段必须立即出刀，不再重新蓄力。仅去掉两个片段间像素完全相同的重复衔接帧，保留其他所有实际返回帧，再检查整段动作。阶段端点是生成模型的引导输入，仍需实际画面验收。

每段最多提交一次，每个候选固定最多两次生成，不因视觉检查失败追加生成。提交前持久记录次数、原图/衔接帧哈希及远端任务 ID；重启只推进尚未提交的计划片段，提交结果未知时停止。取回接口只取回已存在的片段，不提交下一段。128×128、4 + 12 帧仍通常合计 4 个 generation 额度；较小尺寸按每段分别向上取整，页面及额度预检使用相同计算。每次提交仍读取余额。旧任务保留创建时的单段或两段计划、提示词、端点和额度预算，不自动转换或重新收费；显式选帧、循环及不支持两段帧数的动作保持原流程。

节奏比例是新生成的目标，不是按帧号强行贴上的视觉阶段标签。新计划保存 `rhythm` 中的请求帧分配，不能用后来的默认值覆盖。受 PixelLab 每次至少 4 帧且必须为偶数的限制，8/10/12/14 帧请求分别使用 4+4、4+6、4+8、4+10 两段，并为后段保留收招空间；这些较短任务不能精确达到 1:2:1。模型返回 17/18 等实际帧数时，保留全部有效帧，不通过删帧、补重复帧或拉长刀光凑比例。视觉阶段仍依据真实画面确认。


批量候选独立记录视觉结果与次数。某个候选网络或格式失败会显示“检查未完成”，后续候选继续检查，失败请求不自动重试。旧版因中途失败而跳过的后续候选可用“继续视觉检查”补做仅未发送的检查，已检查或结果未知的请求不会重发。

地面攻击（`attack`）和空中攻击（`attack_in_air`）的非循环生成默认进行视觉检查。协议 4 先记录每个实际帧的武器持有者、握剑手高度、刀尖位置及可见姿势，再用有帧号、含原图、跨页重叠的整段对照图核验动作完整性。即使初检没有疑点，也必须完成第二次检查。地面攻击必须有举刀、肩后蓄力停顿、从高到低出刀、随挥和收招的帧证据；空中攻击使用准备、出刀、伸展、随挥和收招，不套用地面蓄力。两次证据矛盾、覆盖不全或阶段缺失均不能通过，不能只凭模型自报置信度判定合格。

视觉复核必须逐帧追踪“原图持刀臂 / 另一条臂 / 双手 / 被遮挡”，并在分段交接处额外提供放大的对照图；不能把画面左右位置变化当作左右手变化。两次独立观察都能看到持刀手变化时，直接标记 `hand_swap` 待修补帧；无法辨认、记录不全或证据矛盾不能当成已通过。持刀手证据与动作阶段分别验证，已确认的换手不会被无效阶段证据丢弃。旧报告明确提示未检查持刀手，不自动重新收费。逐帧修补同时锁定持刀手，不复制错误邻帧的换手。

每次最多两次视觉请求，使用同一已选模型。局部异常至多复核八项（优先外观漂移），整段动作完整性始终核验全部实际帧（1–64 帧）。确认的问题，包括缺失的攻击阶段，会直接标记待修补帧；查看结论可展开逐帧观察与调用记录。缺失阶段没有可靠的实际相位，修补时必须由人指定预期阶段，再带入阶段与前后帧约束。不会自动重新生成或采用替代帧。旧版通过报告明确显示未验证动作完整性，不自动重新收费检查。

生成动作描述放在提示词前部；保持角色服装与颜色不等于保持待机姿势。肩后持刀约束仅适用于蓄力阶段，允许从参考图待机姿势举刀。PixelLab 的文本约束仍是软约束，不能保证生成器按阶段执行。同一模型的两次检查也不等于独立模型验证：2026-09-07 的有上限真实样本复测仍发现 HY Vision 2.0 的握剑手位置和阶段描述错误，目前不能据此声称视觉识别准确率达标。协议回归测试验证检查与计费边界，不代表模型语义准确率。

在设置中保存视觉检查 API Key。默认使用 TokenHub 混元 `hy-vision-2.0-instruct`，可复用服务端 `TOKENHUB_API_KEY`；也可选择 OpenAI `gpt-5.4-2026-03-05`，使用独立的 `OPENAI_API_KEY`。两家密钥分开保管；图片发给所选服务，视觉检查按用量计费，不自动重试结果未知的请求。地图页面只保存在进程内的 Key 需在此另行保存。TokenHub Key 不指定模型；`hy-image-v3` 是图像生成模型，本页使用图片理解接口。新报告分别保存请求模型、服务回传模型（缺失时明确未知）、响应 ID、调用次数、用量及送检原图/帧哈希。

在 **3 · 逐帧修补 → AI 修补当前问题帧** 中，由人决定保留当前帧、手工修改或请求 AI 重新生成。新请求必须携带当前帧的攻击阶段及专项约束，并锁定前后帧参考；例如蓄力阶段要求刀保持在肩后，不提前出刀或重新蓄力。已复核、证据充分且对应当前版本的视觉判断可以自动提供阶段；否则必须人工选择，不能按固定帧号猜测阶段。修改其他帧后，旧报告不能继续自动提供阶段。

直接选中可编辑帧即可发起预览，无须先标为待修补。每帧最多人工生成两次。四个输入槽位使用前帧、目标帧、后帧及不可变原图；第四槽位明确标为身份参考而非动画帧，用于约束服装和配色。每个预览对完整动画进行检查，至多两次视觉调用；生成和检查分别按用量计费。必须先预览、再由人明确采用，只有目标帧会替换；其余帧与原始版本保留。保存的次数不会因刷新或重启重置，手工像素修补仍可继续。旧自动补做队列不再自动提交或采用，已有结果保留。

检查与修补继续支持实际 1–64 帧，完整保留播放顺序；缺少邻帧时仅对前三个提交上下文槽位补齐，第四槽位始终是原图，不增加最终帧数。单帧不足以证明动作连续性，不能判为通过。首尾帧明确记录缺失的邻帧，不虚构衔接。

旧版在发送前停止的检查可点击“继续视觉检查”，或调用 `POST /jobs/{job_id}/motion-review/resume`；它只复用原帧检查并打 tag，不自动重新生成。人工修补接口 `POST /jobs/{job_id}/candidates/{candidate_index}/frames/{frame_index}/ai-repair` 可传入 `phase`（默认 `auto`）；可用阶段为 `prepare`、`windup`、`charge`、`strike`、`extend`、`follow_through`、`recover`，其中举刀/蓄力仅用于地面攻击，伸展仅用于空中攻击。不确定或不适用的阶段会在收费请求前被拦截。

新生成提示始终优先锁定原图服装、身体/盔甲配色和装备，不因填写自定义角色描述而省略；所有预设仍受 1000 字符限制，超长会在请求前拒绝，原型与动作约束不会静默截断。

旧 `/attack-plans` 接口及记录保留兼容；复杂的分段方案面板不再显示。修补子任务作为执行记录保留，不列入作品库。

原图现可从作品库或生成页进入像素画布，保存副本并移送为新的生成原图。播放检查支持单次、循环、往返和整段 FPS 调整；详见[原图像素修改与播放检查](docs/reference-canvas-and-playback.md)。
