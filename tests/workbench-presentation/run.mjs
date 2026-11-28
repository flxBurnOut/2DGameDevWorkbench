import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  taskPresentation,
  taskViewPath,
  mcpContent,
} from "../../lib/workbench/presentation.mjs";
const manifest = JSON.parse(
  await readFile(
    new URL("../../workbench/manifest.json", import.meta.url),
    "utf8",
  ),
);
const base = {
  id: "example",
  capabilityId: "reference-art",
  status: "prepared",
  input: { operation: "generate", name: "骑士" },
};
assert.equal(taskPresentation(manifest, base).state, "prepared");
assert.equal(
  taskPresentation(manifest, { ...base, status: "awaiting_configuration" })
    .state,
  "awaiting_configuration",
);
assert.equal(
  taskPresentation(
    manifest,
    { ...base, status: "completed" },
    { artifacts: [{ path: "outputs/example/reference.png", missing: true }] },
  ).state,
  "attention_required",
);
const transfer = {
  ...base,
  status: "completed",
  input: { operation: "transfer", sourceTaskId: "source-1" },
};
assert.equal(
  taskViewPath(manifest, transfer),
  "/tools/reference-art?task=source-1",
);
assert.equal(
  taskPresentation(manifest, transfer, {
    result: { characterId: "reference_one" },
  }).actions[0].viewPath,
  "/tools/sprite-generator?character=reference_one",
);
const sprite = {
  ...base,
  capabilityId: "sprite-generator",
  input: { operation: "get", jobId: "old-job", candidateIndex: 3 },
};
assert.equal(
  taskViewPath(manifest, sprite),
  "/tools/sprite-generator?job=old-job&candidate=3",
);
for (const [remoteStatus, state] of [
  ["created", "saved"],
  ["queued", "running"],
  ["not_submitted", "not_submitted"],
  ["review_required", "attention_required"],
  ["approved", "saved"],
  ["exported", "completed"],
]) {
  assert.equal(
    taskPresentation(manifest, {
      ...sprite,
      status: "completed",
      adapter: { remoteStatus },
    }).state,
    state,
  );
}
const animation = taskPresentation(
  manifest,
  { ...sprite, status: "completed", adapter: { remoteStatus: "exported" } },
  { artifacts: [{ path: "outputs/example/preview.gif" }] },
);
assert.equal(animation.preview.kind, "animation");
assert.equal(animation.browserOpened, false);
const saved = {
  ...base,
  capabilityId: "interactable-editor",
  status: "completed",
  input: { operation: "save-project", project: { name: "门" } },
};
assert.equal(taskPresentation(manifest, saved).state, "saved");
for (const [operation, route] of [["generate-prop", "/tools/interactable-editor"], ["edit-image", "/tools/interactable-editor"]]) {
  const imageTask = { ...base, capabilityId: "image-assets", status: "completed", input: { operation } };
  const imagePresentation = taskPresentation(manifest, imageTask, { artifacts: [{ path: "outputs/example/image.png" }] });
  assert.equal(imagePresentation.viewPath, `${route}?imageTask=example`);
  assert.equal(imagePresentation.preview.kind, "image");
  assert.match(imagePresentation.summary, /候选已保存/);
}
const rich = {
  taskId: "example",
  status: "completed",
  presentation: animation,
  result: { orderedFrames: Array(200).fill("frames/example.png") },
};
assert(
  mcpContent("workbench_get_result", rich).length < JSON.stringify(rich).length,
);
assert(!mcpContent("workbench_get_result", rich).includes("orderedFrames"));
assert.equal(
  JSON.parse(
    mcpContent("workbench_get_result", { ...rich, detailIncluded: true }),
  ).result.orderedFrames.length,
  200,
);
const polled = JSON.parse(
  mcpContent("workbench_get_task", {
    task: { id: "keep-original-task", status: "running" },
    presentation: animation,
    refreshError: "network stack and internal diagnostics",
  }),
);
assert.equal(polled.taskId, "keep-original-task");
assert.equal(polled.status, "running");
assert.match(polled.issue, /上次保存的状态/);
assert(!JSON.stringify(polled).includes("internal diagnostics"));
const failedPresentation = {
  ...animation,
  issue: { summary: "请检查原任务。", detail: "long diagnostic details" },
};
const listed = JSON.parse(
  mcpContent("workbench_list_tasks", {
    tasks: [{ id: "failed-original", presentation: failedPresentation }],
  }),
);
assert.equal(listed.matches[0].taskId, "failed-original");
assert.deepEqual(listed.matches[0].issue, { summary: "请检查原任务。" });
assert(
  !taskPresentation(manifest, sprite, {
    candidateIndex: 1,
    artifacts: [{ path: "outputs/example/preview.gif" }],
  }).preview,
);
console.log(
  "Presentation: exact identities, honest states, missing artifacts, animated preview and compact/full fallback passed.",
);
