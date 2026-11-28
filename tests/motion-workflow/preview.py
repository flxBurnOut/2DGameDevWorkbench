"""Two isolated, completed single-subject examples for hands-on review, editing and delivery."""
from pathlib import Path
from unittest.mock import patch
import json
import sys
import uuid
from threading import Thread
import uvicorn
from starlette.responses import JSONResponse

repo = Path(__file__).resolve().parents[2]
pipeline = repo / "Tools" / "SpritePipeline"
sys.path[:0] = [str(pipeline), str(pipeline / "tests")]

from test_interactable_motion import workspace_for
from test_interactable_state_chain import LampPlanner, ArchiveProvider
from test_open_motion import spec, Provider
from test_open_motion_checkpoints import CheckpointPlanner
from test_harness_integration import TemporaryHarness
from sprite_pipeline.collaboration.contracts import TaskSpec
from sprite_pipeline.collaboration.checkpoints import Checkpoints
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.api_app import create_api
from sprite_pipeline.vision_review import VisionReviewer


def make_candidate(service, workspace, planner, provider, task, *, trim_first=False):
    workspace.model = planner
    with patch("sprite_pipeline.providers.get_provider", return_value=provider):
        work = workspace.create(task, uuid.uuid4().hex, planning_authorized=True)
        work = workspace.plan(work.id)
        assert work.status == "ready", work.message
        work = workspace.start(work.id, work.revision, work.plan_sha256)
        engine, checkpoints = PlanGeneration(service), Checkpoints(service)
        for index in range(len(work.plan.stages)):
            engine.advance(work.job_id, provider, wait=True)
            evidence = checkpoints.view(work.job_id, 1, index)
            checkpoints.decide(work.job_id, 1, index, token=evidence["token"], decision="accept",
                               note="Scripted offline acceptance", acknowledge=True,
                               anchor_frame=2 if index == 0 and trim_first else None, acknowledge_trim=True)
        job = engine.advance(work.job_id, provider, wait=True)
        assert job.candidates[0].status.value == "review_ready"
        return work.id


root = Path(sys.argv[1])
root.mkdir()
service, workspace = workspace_for(root, "lamp", seed=2202)
lamp_preset = service.presets.object_path("lamp")
lamp_data = json.loads(lamp_preset.read_text(encoding="utf-8"))
lamp_data.update(display_name="离线信号灯", identity_description="信号灯面变色，灯壳固定。")
lamp_preset.write_text(json.dumps(lamp_data, ensure_ascii=False), encoding="utf-8")
ids = {
    "character": make_candidate(service, workspace, CheckpointPlanner(), Provider(TemporaryHarness(root / "hero")),
                                spec(description="离线角色帧回放，检查播放、修改与导出。")),
    "interactable": make_candidate(service, workspace, LampPlanner("lamp"), ArchiveProvider(),
                                    TaskSpec(object_type="interactable", object_id="lamp", provider="fixture",
                                             description="将信号灯分两步点亮并保持，底座固定。"), trim_first=True),
}
app = create_api(service=service)

@app.middleware("http")
async def local_preview(request, call_next):
    # Keep the diagnostic server usable with a configured desktop account. Only
    # local review, deterministic frame edits and delivery can mutate its two works.
    parts = request.url.path.split("/")
    if request.method not in {"GET", "HEAD"}:
        if not ("open-motion" in parts and any(w in parts for w in ids.values())
                and (parts[-1] in {"review", "export", "local-frame-edits"}
                     or ("adjustments" in parts and parts[-1] == "decision"))):
            return JSONResponse({"error": "离线样例可逐帧编辑、采用和导出。新绘图请使用正式工作区。"}, status_code=409)
    return await call_next(request)


server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=int(sys.argv[2]), lifespan="off", log_level="error"))

def stop_on_parent_exit():
    sys.stdin.buffer.read()
    server.should_exit = True

Thread(target=stop_on_parent_exit, daemon=True).start()
print(json.dumps(ids), flush=True)
with patch("sprite_pipeline.providers.get_provider", side_effect=AssertionError("Preview disables remote drawing")), patch.object(
    VisionReviewer, "_send", side_effect=AssertionError("Preview disables external model calls")
):
    server.run()
