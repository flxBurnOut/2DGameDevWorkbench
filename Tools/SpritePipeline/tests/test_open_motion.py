"""Open tasks must work without adding an action preset or per-action prompt."""
import copy
import hashlib
import uuid
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from test_harness_integration import TemporaryHarness
from sprite_pipeline.api_app import create_api
from sprite_pipeline.collaboration.api import candidate_digest
from sprite_pipeline.collaboration.contracts import TaskSpec
from sprite_pipeline.collaboration.workspace import OpenMotionWorkspace
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.errors import ConflictError, NotFoundError, ValidationHarnessError, ProviderTemporaryError
from sprite_pipeline.models import ExportOptions
from sprite_pipeline.providers.base import Submission, PollResult, PollStatus
from sprite_pipeline.service import SpritePipelineService
from sprite_pipeline.collaboration.planning import PlanningModel
from sprite_pipeline.collaboration.contracts import CoordinatorTurn
from sprite_pipeline.vision_review import VisionReviewer


class Planner:
    configured = True
    configuration = {"provider": "test", "model": "isolated-planner"}
    def __init__(self, stages=2):
        self.calls = []; self.stages = stages

    def __call__(self, role, work, reference, *, question="", crop=None):
        self.calls.append((role, question, crop))
        assert hashlib.sha256(reference).hexdigest() == work.reference_sha256
        if role != "coordinator":
            return {"action": "propose", "summary": f"{role} 独立观察与建议"}, {"usage": {"output_tokens": 10}}
        plan = {"title": work.spec.description[:80], "animation_name": "custom_motion",
                "summary": "按原要求完成动作，最终姿势保留用户指定状态", "grounded": False,
                "requirements": [{"text": "用户要求", "source": "user", "evidence": work.spec.description}],
                "stages": [{"name": f"阶段 {i+1}", "goal": "完成该段动作", "prompt": work.spec.description + " Keep identity and facing unchanged.",
                            "frame_count": 4, "first_frame": "original" if i == 0 else "previous_end", "last_frame": "none",
                            "acceptance": [work.spec.description]} for i in range(self.stages)]}
        return {"action": "finalize", "summary": "协调方案", "plan": plan}, {"response_id": "test-final"}


class Provider:
    name = "fixture"; diagnostic_only = True
    def __init__(self, fixture):
        self.fixture = fixture; self.requests = []; self.unknown = False; self.pending = False
    def submit(self, request):
        self.requests.append(request)
        if self.unknown:
            raise ProviderTemporaryError("ambiguous", details={"submission_unknown": True})
        return Submission(provider=self.name, provider_job_id=f"remote-{len(self.requests):06}", status="pending",
                          expected_frame_count=4, expected_size=(64,64), request_record={}, raw_response={}, diagnostic_only=True)
    def poll(self, job_id):
        paths = self.fixture.write_sequence(self.fixture.root / job_id)
        return PollResult(provider=self.name, provider_job_id=job_id, status=PollStatus.pending if self.pending else PollStatus.completed,
                          provider_status="processing" if self.pending else "completed", images=[] if self.pending else [p.read_bytes() for p in paths], diagnostic_only=True)
    def wait(self, job_id):
        return self.poll(job_id)


@pytest.fixture
def setup(tmp_path):
    fixture = TemporaryHarness(tmp_path)
    service = SpritePipelineService(tmp_path)
    planner = Planner(); service.open_motion_model = planner
    provider = Provider(fixture)
    with patch("sprite_pipeline.providers.get_provider", return_value=provider):
        yield service, OpenMotionWorkspace(service), planner, provider, fixture


def spec(description="角色摘帽后鞠躬，结束时保持低头", **kwargs):
    return TaskSpec(character_id="test_hero", description=description, provider="fixture", **{'review_protocol':'baseline', **kwargs})


def ready(workspace, value=None):
    w = workspace.create(value or spec(), uuid.uuid4().hex, planning_authorized=True)
    return workspace.plan(w.id)


def test_waiting_for_pixellab_account_does_not_start_a_plan_stage(setup, monkeypatch):
    from sprite_pipeline.providers.account import AccountSlotBusy

    service, workspace, _, provider, _ = setup
    work = ready(workspace)
    work = workspace.start(work.id, work.revision, work.plan_sha256)
    busy = True

    def account_slot():
        if busy:
            raise AccountSlotBusy('等待 PixelLab 账户空位')

    monkeypatch.setattr(provider, 'check_account_slot', account_slot, raising=False)
    monkeypatch.setattr(provider, 'get_balance', lambda: {'subscription': {'generations': 20}}, raising=False)
    provider.name = 'pixellab'
    queued = PlanGeneration(service).advance(work.job_id, provider)
    assert queued.status == 'queued' and not provider.requests
    stage = queued.candidates[0].plan_execution.stages[0]
    assert stage.state == 'created' and stage.submission_attempts == 0
    busy = False
    result = PlanGeneration(service).advance(work.job_id, provider)
    assert len(provider.requests) == 1 and result.candidates[0].provider_job_id == 'remote-000001'


@pytest.mark.parametrize("description", ["拔出地面上的长剑，最后高举长剑", "受惊后倒退两步，最后保持惊讶姿势", "摘下帽子弯腰致意，最后保持鞠躬"])
def test_novel_tasks_complete_without_presets(setup, description):
    service, workspace, planner, provider, fixture = setup
    before = sorted(fixture.action_dir.glob("*.json"))
    w = ready(workspace, spec(description))
    assert w.status == "ready" and [c[0] for c in planner.calls] == ["appearance", "motion", "strategy", "coordinator"]
    w = workspace.start(w.id, w.revision, w.plan_sha256)
    job = PlanGeneration(service).advance(w.job_id, provider, wait=True)
    assert len(job.candidates[0].frames) == 8
    assert job.motion_control is None and not job.candidates[0].attack_sequence
    assert provider.requests[1].reference_image == (fixture.root / "remote-000001/frame_003.png").read_bytes()
    assert all(r.last_frame is None for r in provider.requests)
    assert len(provider.requests) == 2 and sorted(fixture.action_dir.glob("*.json")) == before
    service.approve_candidate(job.job_id, 1, reviewer="test", acknowledge_warnings=True)
    result = service.export_candidate(job.job_id, 1)
    assert result.export.godot_package_path
    assert result.candidates[0].diagnostic_only
    # Reads, duplicate starts and recovery do not re-generate or lose approval.
    workspace.start(w.id, w.revision, w.plan_sha256)
    for _ in range(3):
        service.recover_pending_jobs(); workspace.view(w.id)
    assert len(provider.requests) == 2
    service.export_candidate(job.job_id, 1, ExportOptions(overwrite=True))


def test_read_does_not_create_idempotency_and_revision_conflict(setup):
    service, workspace, planner, provider, _ = setup
    assert workspace.listing() == [] and service.list_jobs() == []
    key = uuid.uuid4().hex
    w = workspace.create(spec(), key, planning_authorized=True)
    assert workspace.create(spec(), key, planning_authorized=True).id == w.id
    with pytest.raises(ConflictError):
        workspace.create(spec("完全不同的要求"), key, planning_authorized=True)
    w = workspace.plan(w.id)
    with pytest.raises(ConflictError): workspace.start(w.id, 2, w.plan_sha256)
    newer = workspace.revise(w.id, 1, spec("倒地后留在地面"), uuid.uuid4().hex, planning_authorized=True)
    assert newer.revision == 2 and workspace.view(w.id, 1)["spec"]["description"] != newer.spec.description
    client = TestClient(create_api(service=service))
    original = client.get(f'/v1/open-motion/requests/{key}')
    assert original.status_code == 200 and original.json()['revision'] == 1 and original.json()['latest_revision'] == 2
    assert workspace.create(spec(), key, planning_authorized=True).revision == 1
    with pytest.raises(ConflictError): workspace.start(w.id, 1, w.plan_sha256)
    assert not provider.requests


@pytest.mark.parametrize('boundary', ['receipt', 'publish'])
def test_creation_retry_never_dispatches_two_works(setup, monkeypatch, boundary):
    service, workspace, planner, provider, _ = setup
    key = uuid.uuid4().hex
    from sprite_pipeline.collaboration import workspace as workspace_module
    write_json = workspace_module.atomic_write_json
    replace = workspace_module.replace_with_retry

    def write_with_fault(path, value):
        if path.parent.name == 'requests':
            raise OSError('interrupted before request receipt')
        write_json(path, value)

    def replace_with_fault(path, target):
        if path.parent.name == 'pending':
            raise OSError('interrupted before work publication')
        return replace(path, target)

    with monkeypatch.context() as fault:
        if boundary == 'receipt':
            fault.setattr(workspace_module, 'atomic_write_json', write_with_fault)
        else:
            fault.setattr(workspace_module, 'replace_with_retry', replace_with_fault)
        with pytest.raises(OSError, match='interrupted'):
            workspace.create(spec(), key, planning_authorized=True, auto_execute=True)
    prepared = workspace.request_path(key).parent / 'pending' / workspace.request_path(key).name
    assert prepared.is_file() and not workspace.listing()
    original_id = json.loads(prepared.read_text(encoding='utf8'))['id']
    with pytest.raises(NotFoundError, match='未找到'):
        workspace.original_request(key)
    workspace.recover_planning()
    assert len(planner.calls) == (4 if boundary == 'publish' else 0)

    if boundary == 'publish':
        with pytest.raises(ConflictError):
            workspace.create(spec('Different request'), key, planning_authorized=True, auto_execute=True)
    work = workspace.create(spec(), key, planning_authorized=True, auto_execute=True)
    assert work.id == original_id and not prepared.exists()
    workspace.recover_planning()
    assert len(planner.calls) == 4 and len(workspace.listing()) == len(service.list_jobs()) == 1
    assert workspace.create(spec(), key, planning_authorized=True, auto_execute=True).id == work.id
    PlanGeneration(service).advance(workspace.load(work.id).job_id, provider)
    assert len(provider.requests) == 1


@pytest.mark.parametrize('boundary', ['history', 'work', 'job'])
def test_revision_publication_does_not_leave_wrong_generation_enabled(setup, monkeypatch, boundary):
    service, workspace, _, provider, _ = setup
    work = ready(workspace)
    work = workspace.start(work.id, work.revision, work.plan_sha256)
    assert service.store.load(work.job_id).plan_control.enabled
    if boundary == 'history':
        work.history = [{'revision': n + 1, 'title': 'previous'} for n in range(50)]
        workspace.save(work)

    def write_failure(_):
        raise OSError('interrupted revision write')

    from sprite_pipeline import store as store_module
    write_json = store_module.atomic_write_json

    def fail_job_publish(path, value):
        if path.parent.name == 'history' and path.name.startswith('job_'):
            raise OSError('interrupted revision write')
        write_json(path, value)

    key = uuid.uuid4().hex
    amended = spec('A different motion spec')
    with monkeypatch.context() as fault:
        if boundary == 'history':
            with pytest.raises(ValidationHarnessError, match='版本过多'):
                workspace.revise(work.id, 1, amended, key, planning_authorized=True)
        else:
            if boundary == 'work':
                fault.setattr(workspace, 'save', write_failure)
            else:
                fault.setattr(store_module, 'atomic_write_json', fail_job_publish)
            with pytest.raises(OSError, match='interrupted revision write'):
                workspace.revise(work.id, 1, amended, key, planning_authorized=True)

    assert service.store.load(work.job_id).plan_control.enabled
    if boundary == 'job':
        assert workspace.load(work.id).revision == 2
        assert workspace.revise(work.id, 1, amended, key, planning_authorized=True).revision == 2
        PlanGeneration(service).advance(work.job_id, provider)
        assert not provider.requests and not service.store.load(work.job_id).plan_control.enabled
        assert not (PlanGeneration(service).directory(work.job_id, 1, 0) / 'submit.intent.json').exists()
    else:
        assert workspace.load(work.id).revision == 1
        PlanGeneration(service).advance(work.job_id, provider)
        assert len(provider.requests) == 1


def test_pause_restart_multiple_candidates_and_ambiguous_request(setup):
    s, ws, model, p, _ = setup
    w = ready(ws, spec(candidate_count=2)); w = ws.start(w.id, 1, w.plan_sha256)
    p.pending = True
    PlanGeneration(s).advance(w.job_id, p)
    ws.pause(w.id, 1)
    p.pending = False
    for _ in range(3): s.recover_pending_jobs()
    assert len(p.requests) == 1  # Existing request collected; next stage not sent.
    ws.pause(w.id, 1, resume=True)
    for _ in range(6): s.recover_pending_jobs()
    assert len(p.requests) == 4
    assert all(len(c.frames) == 8 for c in s.get_job(w.job_id).candidates)
    other = ready(ws); other = ws.start(other.id, 1, other.plan_sha256)
    p.unknown = True
    with pytest.raises(ProviderTemporaryError): PlanGeneration(s).advance(other.job_id, p)
    for _ in range(3): s.recover_pending_jobs()
    assert len(p.requests) == 5
    assert s.get_job(other.job_id).candidates[0].status.value == "submission_unknown"


def test_reference_changed_or_budget_exhausted_never_submits(setup):
    s, ws, model, p, f = setup
    w = ready(ws, spec(budget={"max_planning_calls": 4, "max_generation_calls": 1}))
    assert w.status == "planning_failed" and not p.requests
    w = ready(ws)
    f.write_frame(f.reference_path, shift_x=1)
    with pytest.raises(ConflictError): ws.start(w.id, 1, w.plan_sha256)
    assert not p.requests


def test_expert_uses_consultation_and_reference_tool(setup):
    s, ws, model, p, _ = setup
    original = model.__call__
    seen = set()
    def dynamic(role, w, ref, **kwargs):
        if role == "appearance" and role not in seen:
            seen.add(role)
            return {"action": "inspect_reference", "crop": [20,10,48,58], "summary": "核对装备"}, {}
        if role == "strategy" and role not in seen:
            seen.add(role)
            return {"action": "consult", "target": "motion", "question": "最后是否需要回到站立？", "summary": "确认终态"}, {}
        return original(role, w, ref, **kwargs)
    with patch.object(Planner, "__call__", side_effect=dynamic):
        w = ready(ws)
    assert w.status == "ready" and len(w.planning_calls) == 7
    assert any(m[2] == [20,10,48,58] for m in model.calls)
    assert any(m[1] == "最后是否需要回到站立？" for m in model.calls)


def test_api_manual_review_guards_and_repeat_export(setup):
    s, ws, model, p, _ = setup
    client = TestClient(create_api(service=s))  # No background thread in this deterministic test.
    assert client.get("/v1/open-motion").json() == {"works": []}
    value = {"spec": spec().model_dump(), "request_key": uuid.uuid4().hex}
    assert client.post("/v1/open-motion", json=value).status_code == 422
    value["planning_authorized"] = True
    created = client.post("/v1/open-motion", json=value)
    assert created.status_code == 201, created.text
    work_id = created.json()["id"]; ws.plan(work_id); w = ws.load(work_id)
    assert client.post(f"/v1/open-motion/{work_id}/generate", json={"expected_revision":1,"plan_sha256":w.plan_sha256}).status_code == 200
    w = ws.load(work_id); PlanGeneration(s).advance(w.job_id, p, wait=True)
    c = s.get_job(w.job_id).candidates[0]
    body = {"expected_revision":1,"candidate_index":1,"candidate_sha256":"0"*64,"note":"完整播放并核对每段衔接", "acknowledge_warnings":True}
    assert client.post(f"/v1/open-motion/{work_id}/review", json=body).status_code == 409
    body["candidate_sha256"] = candidate_digest(c)
    assert client.post(f"/v1/open-motion/{work_id}/review", json=body).status_code == 200
    for _ in range(2):
        exported = client.post(f"/v1/open-motion/{work_id}/export", json={"expected_revision":1,"candidate_index":1})
        assert exported.status_code == 200, exported.text


def test_terminal_reference_anchor_requires_explicit_user_choice(setup):
    s, ws, model, p, _ = setup
    original = model.__call__
    def anchored(*args, **kwargs):
        turn, receipt = original(*args, **kwargs)
        if turn['action'] == 'finalize': turn['plan']['stages'][-1]['last_frame'] = 'original'
        return turn, receipt
    with patch.object(Planner,'__call__',side_effect=anchored):
        denied=ready(ws)
        assert denied.status=='planning_failed' and not p.requests
        accepted=ready(ws,spec(return_to_reference=True))
        assert accepted.status=='ready'
    accepted=ws.start(accepted.id,1,accepted.plan_sha256)
    PlanGeneration(s).advance(accepted.job_id,p,wait=True)
    assert p.requests[-1].last_frame == p.requests[0].reference_image


def test_invalid_model_receipt_is_preserved_and_never_retried(setup):
    _, ws, model, p, _ = setup
    receipt={'response_id':'paid-existing-response','requested_model':'test-model','usage':{'output_tokens':10}}
    with patch.object(Planner,'__call__',side_effect=ValidationHarnessError('invalid structured response',details={'model_receipt':receipt})) as call:
        w=ready(ws)
        ws.plan(w.id); ws.recover_planning()
        assert call.call_count==1
    assert w.planning_calls[-1]['state']=='invalid_response'
    assert w.planning_calls[-1]['response_id']==receipt['response_id'] and not p.requests


def test_changed_versions_and_candidate_exports_preserve_old_files(setup):
    s, ws, _, p, _ = setup
    w=ready(ws,spec(candidate_count=2));w=ws.start(w.id,1,w.plan_sha256)
    job=PlanGeneration(s).advance(w.job_id,p,wait=True)
    paths=[]
    for index in (1,2):
        s.approve_candidate(job.job_id,index,reviewer='test',acknowledge_warnings=True)
        exported=s.export_candidate(job.job_id,index,ExportOptions(overwrite=True))
        paths.append(exported.export.godot_package_path)
    assert paths[0]!=paths[1]
    old_bytes=[(s.settings.root / name).read_bytes() for name in paths]
    next_work=ws.revise(w.id,1,spec('另一个动作，结束时保持半蹲'),uuid.uuid4().hex,planning_authorized=True)
    next_work=ws.plan(next_work.id);next_work=ws.start(next_work.id,2,next_work.plan_sha256)
    job2=PlanGeneration(s).advance(next_work.job_id,p,wait=True)
    s.approve_candidate(job2.job_id,1,reviewer='test',acknowledge_warnings=True)
    out=s.export_candidate(job2.job_id,1,ExportOptions(overwrite=True))
    assert out.export.godot_package_path not in paths
    assert [(s.settings.root / name).read_bytes() for name in paths]==old_bytes
    assert ws.view(w.id,1)['job']['job_id']==job.job_id


def test_planning_wire_accepts_only_complete_json_envelope_and_saves_receipt(setup):
    s, ws, planner, _, _ = setup
    work=ws.create(spec(),uuid.uuid4().hex,planning_authorized=True)
    payload,_=planner('coordinator',work,ws.reference(work))
    reviewer=VisionReviewer(s.settings)
    metadata=[]
    class Response:
        status_code=200
        def json(self):
            return {'id':'wire-test','model':'hy-vision-2.0-instruct','usage':{'output_tokens':12},'choices':[{'finish_reason':'stop','message':{'content':'```json\n'+json.dumps(payload)+'\n```'}}]}
    class Client:
        def __enter__(self):return self
        def __exit__(self,*_):pass
        def post(self,*args,**kwargs):return Response()
    with patch('sprite_pipeline.vision_review.httpx.Client',return_value=Client()):
        result,receipt=reviewer._send([],CoordinatorTurn,'hunyuan','not-a-real-key',64,None,schema_name='open_motion_plan',on_response=metadata.append)
    assert result.action=='finalize' and receipt['response_id']=='wire-test'
    assert metadata[0]['output_sha256'] and metadata[0]['usage']['output_tokens']==12


def test_coordinator_can_correct_local_validation_within_original_budget(setup):
    _, ws, model, provider, _ = setup
    original=model.__call__;turns=0
    def oversized(role,*args,**kwargs):
        nonlocal turns
        if role=='coordinator':
            turns+=1
            model.stages=2 if turns==1 else 1
        return original(role,*args,**kwargs)
    with patch.object(Planner,'__call__',side_effect=oversized):
        work=ready(ws,spec(budget={'max_planning_calls':5,'max_generation_calls':1}))
    assert work.status=='ready' and len(work.planning_calls)==5
    assert len(work.plan.stages)==1 and not provider.requests
    assert any(m['role']=='validator' for m in work.messages)


def test_windows_sharing_retry_replaces_only_the_same_json(setup):
    import os
    import sprite_pipeline.jsonio as jsonio
    s, _, _, _, _ = setup
    filename=s.settings.root/'retry.json'
    jsonio.atomic_write_json(filename,{'version':1})
    replace=jsonio.os.replace
    denied=PermissionError('temporary sharing violation');denied.winerror=32
    with patch.object(jsonio.os,'name','nt'), patch.object(jsonio.time,'sleep') as sleep, patch.object(jsonio.os,'replace',side_effect=[denied,None]) as operation:
        jsonio.atomic_write_json(filename,{'version':2})
        assert operation.call_count==2 and sleep.call_count==1
        # The mock leaves the exact temporary bytes; publish them for verification.
        replace(*operation.call_args.args)
    assert jsonio.read_json(filename)=={'version':2}


def test_paraphrase_is_expert_interpretation_and_full_original_is_preserved(setup):
    from sprite_pipeline.collaboration.contracts import bind_original_requirements, PlanProposal
    _, ws, model, _, _ = setup
    work=ws.create(spec(),uuid.uuid4().hex,planning_authorized=True)
    turn,_=model('coordinator',work,ws.reference(work))
    turn['plan']['requirements'][0]['evidence']='A paraphrase rather than an exact user quote.'
    plan=bind_original_requirements(PlanProposal.model_validate(turn['plan']),work.spec)
    assert plan.requirements[0].source=='expert'
    assert plan.requirements[-1].source=='user' and plan.requirements[-1].evidence==work.spec.description
    assert plan.stages[0].prompt==turn['plan']['stages'][0]['prompt']


def test_motion_workspace_identity_survives_restart_and_rejects_replaced_store(tmp_path):
    import subprocess
    import sys
    from pathlib import Path

    def restart():
        # Each interpreter opens the same path with a fresh API and no cached identity.
        program = """
import json, sys
from fastapi.testclient import TestClient
from sprite_pipeline.api_app import create_api
client = TestClient(create_api(sys.argv[1]))
assert 'motion_workspace_id' not in client.get('/health').json()
print(json.dumps(client.get('/health', headers={'x-forge-motion-identity': '1'}).json()['motion_workspace_id']))
"""
        run = subprocess.run([sys.executable, "-c", program, str(tmp_path)], check=True, capture_output=True,
                             text=True, cwd=Path(__file__).resolve().parents[1])
        return json.loads(run.stdout)

    marker = tmp_path / "open-motion" / ".workspace-identity.json"
    original = restart()
    assert len(original) == 64 and restart() == original
    client = TestClient(create_api(tmp_path))
    probe = {"x-forge-motion-identity": "1"}
    with patch("sprite_pipeline.store.JobStore.global_lock", side_effect=PermissionError):
        assert client.get("/health", headers=probe).json()["motion_workspace_id"] == original
        marker.parent.rename(tmp_path / "archived-motion")
        assert client.get("/health").json()["ok"]
        assert client.get("/health", headers=probe).json()["motion_workspace_id"] is None
        assert not marker.exists()
    assert restart() != original
    denied = client.get("/paired/v1/v1/open-motion", headers={"x-forge-workspace": original})
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "WORKSPACE_MISMATCH"
