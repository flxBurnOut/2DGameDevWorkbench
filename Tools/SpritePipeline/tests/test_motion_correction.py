from vision_test_fixtures import observed
import copy
import json
from pathlib import Path
from unittest.mock import patch, PropertyMock
import pytest
from test_harness_integration import TemporaryHarness, FakeResponse, FakePixelLabClient
from sprite_pipeline.service import SpritePipelineService
from sprite_pipeline.models import GenerationRequest, ReviewStatus
from sprite_pipeline.motion_correction import MotionCorrection, active
from sprite_pipeline.vision_review import VisionReviewer, MotionReview
from sprite_pipeline.providers.base import Submission, PollResult, PollStatus, ProviderRequest
from sprite_pipeline.providers.pixellab import PixelLabProvider
from sprite_pipeline.errors import ConflictError, ValidationHarnessError, ProviderTemporaryError, ExportBlockedError

PASS={"verdict":"pass","confidence":0.96,"summary":"一段连续攻击","issues":[]}
FAIL={"verdict":"fail","confidence":0.96,"summary":"第七帧刀突然翻向","issues":[{"code":"weapon_flip","evidence_status":"confirmed","evidence_confidence":0.96,"frames":[7],"description":"刀尖提前翻转","correction":"Keep blade behind shoulder during charge.","phase":"charge","phase_confidence":0.96}]}

class FakeProvider:
    name="pixellab"
    diagnostic_only=False
    def __init__(self,fixture):
        self.fixture=fixture; self.requests=[]; self.unknown=False; self.frame_count=16; self.edit_shifts=(4,3,6,7)
    def submit(self,request):
        self.requests.append(request)
        if request.edit_frames and self.unknown:
            raise ProviderTemporaryError("unknown",details={"submission_unknown":True,"safe_to_retry":False})
        return Submission(provider=self.name,provider_job_id=f"remote-{len(self.requests):06d}",status="pending",expected_frame_count=request.frame_count,expected_size=(64,64),request_record={},raw_response={})
    def poll(self,job_id):
        request=self.requests[int(job_id.split("-")[-1])-1]
        if request.edit_frames:
            # Deliberately alter ALL four context frames: only the selected one may be adopted.
            paths=self.fixture.write_sequence(self.fixture.root/"edited",shifts=self.edit_shifts)
        else:
            paths=self.fixture.write_sequence(self.fixture.root/"original",shifts=tuple(i%4 for i in range(self.frame_count)))
        return PollResult(provider=self.name,provider_job_id=job_id,status=PollStatus.completed,provider_status="completed",images=[p.read_bytes() for p in paths],diagnostic_only=False)
    def wait(self,job_id):
        return self.poll(job_id)

@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("SPRITE_PIPELINE_VISION_PROVIDER","openai")
    fixture=TemporaryHarness(tmp_path)
    for name in ("attack","attack_in_air"):
        preset=json.loads((Path(__file__).parents[1]/f"presets/actions/{name}.json").read_text(encoding="utf-8"))
        # These tests isolate review/repair and legacy single-submission recovery.
        # Default two-stage generation has its own provider and crash regression suite.
        preset["generation_strategy"]="single"
        (fixture.action_dir/f"{name}.json").write_text(json.dumps(preset),encoding="utf-8")
    service=SpritePipelineService(tmp_path); provider=FakeProvider(fixture)
    with patch("sprite_pipeline.providers.get_provider",return_value=provider), patch.object(SpritePipelineService,"_check_submission_quota"), patch.object(VisionReviewer,"configured",new_callable=PropertyMock,return_value=True):
        yield service,provider,fixture

def create(setup,action="attack",count=1):
    s,p,f=setup
    return s.create_job(GenerationRequest(character_id=f.character_id,action_id=action,provider="pixellab",candidate_count=count))

@pytest.mark.parametrize("action",["attack","attack_in_air"])
def test_default_pass_does_not_spend_extra(setup,action):
    s,p,_=setup; job=create(setup,action)
    with patch.object(VisionReviewer,"review",return_value=PASS) as review:
        result=s.generate_job(job.job_id)
        assert result.motion_control["state"]=="passed"
        assert len(p.requests)==1 and review.call_count==1
        for _ in range(4): s.generate_job(job.job_id)
        assert len(p.requests)==1 and review.call_count==1

def test_failed_checks_only_tag_frames_across_candidates_and_restart(setup):
    s,p,_=setup; job=create(setup,count=2)
    with patch.object(VisionReviewer,"review",return_value=FAIL) as review:
        result=s.generate_job(job.job_id)
        assert result.motion_control["state"]=="needs_repair"
        assert len(p.requests)==2 and review.call_count==2
        assert result.motion_control["attempts"]==[]
        restarted=SpritePipelineService(s.settings.root)
        for _ in range(3): restarted.generate_job(job.job_id)
        assert len(p.requests)==2 and review.call_count==2
        for c in result.candidates:
            assert c.frames[6].review_status==ReviewStatus.repair_requested
            assert c.frames[6].motion_tags[0]["label"]=="刀刃翻向"
            assert not c.frames[5].motion_tags


def test_human_requested_proposal_only_changes_target_after_explicit_adoption(setup):
    s,p,_=setup; job=create(setup)
    with patch.object(VisionReviewer,"review",side_effect=[FAIL,PASS]):
        result=s.generate_job(job.job_id)
        original=[f.active_path for f in result.candidates[0].frames]
        control=MotionCorrection(s)
        a=control.manual(job.job_id,1,6,result.candidates[0].frames[6].sha256,wait=True)
        assert [f.active_path for f in s.get_job(job.job_id).candidates[0].frames]==original
        with pytest.raises(ConflictError,match="人确认"):
            control.adopt(job.job_id,a["id"])
        result=control.adopt(job.job_id,a["id"],manual=True)
    assert len(p.requests)==2
    c=result.candidates[0]
    assert c.frames[6].active_path.startswith("motion/")
    assert all(not f.active_path.startswith("motion/") for f in c.frames if f.index!=6)
    assert s.store.resolve_job_path(job.job_id,c.frames[6].raw_path).is_file()
    assert not c.frames[6].motion_tags
    assert "INTENDED PHASE=charge" in p.requests[-1].prompt
    assert "LOCK previous frame 6" in p.requests[-1].prompt
    assert "LOCK next frame 8" in p.requests[-1].prompt


def test_uncertain_or_missing_service_stops_without_spending(setup):
    s,p,_=setup; job=create(setup)
    with patch.object(VisionReviewer,"configured",new_callable=PropertyMock,return_value=False),patch.object(VisionReviewer,"review") as review:
        with pytest.raises(ValidationHarnessError,match="视觉检查 API Key"):
            s.generate_job(job.job_id)
        assert len(p.requests)==0 and not review.called


def test_passing_repair_clears_old_marks_outside_replaced_frames(setup):
    s,p,_=setup; job=create(setup)
    report={**FAIL,"issues":[{**FAIL["issues"][0],"frames":[7,10]}]}
    with patch.object(VisionReviewer,"review",side_effect=[report,PASS]):
        result=s.generate_job(job.job_id)
        control=MotionCorrection(s)
        proposal=control.manual(job.job_id,1,6,result.candidates[0].frames[6].sha256,wait=True)
        result=control.adopt(job.job_id,proposal["id"],manual=True)
    assert result.motion_control["state"]=="passed"
    assert len(p.requests)==2
    candidate=result.candidates[0]
    assert candidate.frames[6].active_path.startswith("motion/")
    assert not candidate.frames[9].active_path.startswith("motion/")
    assert all(f.review_status!=ReviewStatus.repair_requested for f in candidate.frames)
    assert candidate.frames[9].review_note==""


def test_new_review_preserves_human_marks_and_retains_current_issues(setup):
    s,_,_=setup; job=create(setup)
    with patch.object(VisionReviewer,"review",return_value=PASS):
        s.generate_job(job.job_id)
    control=MotionCorrection(s)
    report={**FAIL,"issues":[{**FAIL["issues"][0],"frames":[7,10]}]}
    control._mark(job.job_id,1,report,"old")
    # Human review metadata is preserved; automatic motion evidence may refresh.
    s.review_frame(job.job_id,1,{"frame_index":9,"status":"repair_requested",
        "issue_type":"weapon_error","note":report["summary"],"reviewer":"artist"})
    human=s.get_job(job.job_id).candidates[0].frames[9].model_dump(exclude={"motion_tags"})
    control._mark(job.job_id,1,report,"still-failing")
    assert s.get_job(job.job_id).candidates[0].frames[9].model_dump(exclude={"motion_tags"})==human
    control._mark(job.job_id,1,FAIL,"partial")
    candidate=s.get_job(job.job_id).candidates[0]
    assert candidate.frames[6].review_status==ReviewStatus.repair_requested
    assert candidate.frames[9].model_dump(exclude={"motion_tags"})==human
    control._mark(job.job_id,1,PASS,"pass")
    candidate=s.get_job(job.job_id).candidates[0]
    assert candidate.frames[6].review_status==ReviewStatus.pending
    assert candidate.frames[9].model_dump(exclude={"motion_tags"})==human

def test_low_confidence_never_passes_or_rerolls(setup):
    s,p,_=setup; job=create(setup)
    with patch.object(VisionReviewer,"review",return_value={**PASS,"confidence":0.4}):
        result=s.generate_job(job.job_id)
    assert result.motion_control["state"]=="needs_repair" and len(p.requests)==1

def test_interrupted_visual_request_is_not_repeated(setup):
    s,p,_=setup; job=create(setup)
    with patch.object(VisionReviewer,"review",side_effect=TimeoutError("timeout")) as review:
        s.generate_job(job.job_id)
        for _ in range(4): s.generate_job(job.job_id)
        assert review.call_count==1 and len(p.requests)==1

def test_unknown_manual_submission_never_repeats_on_refresh(setup):
    s,p,_=setup; p.unknown=True; job=create(setup)
    with patch.object(VisionReviewer,"review",return_value=FAIL):
        result=s.generate_job(job.job_id)
        control=MotionCorrection(s)
        with pytest.raises(ProviderTemporaryError):
            control.manual(job.job_id,1,6,result.candidates[0].frames[6].sha256,wait=True)
        for _ in range(2):
            with pytest.raises(ConflictError):
                control.manual(job.job_id,1,6,result.candidates[0].frames[6].sha256,wait=True)
    assert len(p.requests)==2
    assert len(s.get_job(job.job_id).motion_control["attempts"])==1


def test_manual_has_separate_cap_and_explicit_adoption(setup):
    s,p,_=setup; job=create(setup)
    with patch.object(VisionReviewer,"review",return_value=FAIL):
        result=s.generate_job(job.job_id)
        control=MotionCorrection(s); f=result.candidates[0].frames[6]
        first=control.manual(job.job_id,1,6,f.sha256,wait=True)
        assert first["state"]=="proposed"
        assert len(p.requests)==2
        assert control.manual(job.job_id,1,6,f.sha256,wait=True)["id"]==first["id"]
        assert len(p.requests)==2
        second=control.manual(job.job_id,1,6,f.sha256,retry=True,wait=True)
        assert len(p.requests)==3 and second["id"]!=first["id"]
        with pytest.raises(ConflictError,match="两次上限"):
            control.manual(job.job_id,1,6,f.sha256,retry=True)
        assert s.get_job(job.job_id).candidates[0].frames[6].active_path==f.active_path
        accepted=control.adopt(job.job_id,second["id"],manual=True)
        assert accepted.candidates[0].frames[6].active_path.startswith("motion/")

def test_stale_manual_preview_does_not_overwrite_pixel_edit(setup):
    s,p,f=setup; job=create(setup)
    with patch.object(VisionReviewer,"review",return_value=FAIL):
        result=s.generate_job(job.job_id)
        control=MotionCorrection(s); target=result.candidates[0].frames[6]
        a=control.manual(job.job_id,1,6,target.sha256,wait=True)
        path=f.root/"external.png"; f.write_frame(path,shift_x=1)
        s.replace_frame(job.job_id,1,6,path,base_sha256=target.sha256)
        with pytest.raises(ConflictError,match="动画已修改"):
            control.adopt(job.job_id,a["id"],manual=True)

def test_legacy_and_non_attack_jobs_never_get_implicit_charges(setup):
    s,p,f=setup
    job=s.create_job(GenerationRequest(character_id=f.character_id,action_id=f.action_id,provider="pixellab"))
    assert job.motion_control is None
    job=create(setup)
    with s.store.locked_job(job.job_id) as saved: saved.motion_control=None
    with patch.object(VisionReviewer,"review") as review:
        s.generate_job(job.job_id)
        assert not review.called and len(p.requests)==1

def test_endpoint_and_redacted_edit_request(setup):
    _,_,fixture=setup
    png=fixture.reference_path.read_bytes()
    client=FakePixelLabClient(FakeResponse({"background_job_id":"remote-edit-0001","status":"processing"},202),FakeResponse({}))
    provider=PixelLabProvider(api_key="test-secret-value",http_client=client)
    result=provider.submit(ProviderRequest(reference_image=png,prompt="Fix frame 2",frame_count=4,seed=0,edit_frames=(png,)*4))
    assert client.post_calls[0][0].endswith("/v2/edit-animation-v2")
    body=client.post_calls[0][1]
    assert len(body["frames"])==4 and "first_frame" not in body
    assert "base64" not in json.dumps(result.request_record)
    assert "test-secret-value" not in json.dumps(result.request_record)

def test_structured_review_rejects_contradictions():
    with pytest.raises(ValueError): MotionReview.model_validate({**FAIL,"verdict":"pass"})
    assert not MotionCorrection.improves(FAIL,{**FAIL,"issues":[{**FAIL["issues"][0],"code":"extra_strike"}]})


def test_visual_wire_sends_ordered_frames_and_strict_schema(setup):
    s,p,f=setup
    paths=f.write_sequence(f.root/"vision-input",shifts=tuple(i%4 for i in range(16)))
    class Response:
        status_code=200
        def json(self):
            return {"status":"completed","id":"test-response","usage":{"total_tokens":123},"output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(observed(PASS))}]}]}
    with patch.object(VisionReviewer,"key",return_value="test-vision-secret"), patch("sprite_pipeline.vision_review.httpx.Client") as factory:
        client=factory.return_value.__enter__.return_value
        client.post.return_value=Response()
        result=VisionReviewer(s.settings).review(paths,"attack",f.reference_path)
        args=client.post.call_args_list[0]
        assert args.args[0]=="https://api.openai.com/v1/responses"
        body=args.kwargs["json"]
        assert body["store"] is False and body["text"]["format"]["strict"] is True
        assert body["max_output_tokens"]==6000
        images=[v for v in body["input"][0]["content"] if v["type"]=="input_image"]
        assert len(images)==17 and all(v["detail"]=="high" for v in images)
        assert result["usage"]["total_tokens"]==123
        assert result["verdict"]=="uncertain" and result["request_count"]==2
        assert "test-vision-secret" not in json.dumps(result)
        assert client.post.call_count==2


def test_visual_http_error_never_retries_or_leaks_response(setup):
    s,p,f=setup
    paths=f.write_sequence(f.root/"vision-input",shifts=tuple(i%4 for i in range(16)))
    with patch.object(VisionReviewer,"key",return_value="test-vision-secret"), patch("sprite_pipeline.vision_review.httpx.Client") as factory:
        client=factory.return_value.__enter__.return_value
        client.post.return_value.status_code=429
        with pytest.raises(ValidationHarnessError,match="HTTP 429"):
            VisionReviewer(s.settings).review(paths,"attack_in_air",f.reference_path)
        assert client.post.call_count==1
        assert not client.post.return_value.json.called


def test_hunyuan_default_and_credentials_are_separate(setup,monkeypatch):
    s,_,_=setup
    monkeypatch.delenv("SPRITE_PIPELINE_VISION_PROVIDER",raising=False)
    monkeypatch.delenv("TOKENHUB_API_KEY",raising=False)
    monkeypatch.delenv("OPENAI_API_KEY",raising=False)
    reviewer=VisionReviewer(s.settings)
    assert reviewer.provider=="hunyuan" and reviewer.key() is None
    reviewer.save_key("hunyuan-test-secret")
    reviewer.select("openai")
    assert reviewer.key() is None
    reviewer.save_key("openai-test-secret")
    reviewer.select("hunyuan")
    assert reviewer.key()=="hunyuan-test-secret"
    reviewer.save_key("")
    reviewer.select("openai")
    assert reviewer.key()=="openai-test-secret"
    config=(s.settings.config_dir/"motion_vision.json").read_text()
    assert "secret" not in config


def test_hunyuan_reuses_tokenhub_environment_key(setup,monkeypatch):
    s,_,_=setup
    monkeypatch.setenv("SPRITE_PIPELINE_VISION_PROVIDER","hunyuan")
    monkeypatch.setenv("TOKENHUB_API_KEY","shared-tokenhub-test-secret")
    reviewer=VisionReviewer(s.settings)
    assert reviewer.key()=="shared-tokenhub-test-secret"
    with pytest.raises(ValidationHarnessError,match="启动环境"):
        reviewer.save_key("replacement-secret")


@pytest.mark.parametrize("finish,content,should_pass",[("stop",json.dumps(observed(PASS)),True),("length",json.dumps(PASS),False),("stop","looks good",False),("stop",json.dumps({**FAIL,"verdict":"pass"}),False)])
def test_hunyuan_ordered_images_and_fail_closed(setup,monkeypatch,finish,content,should_pass):
    s,_,f=setup
    monkeypatch.setenv("SPRITE_PIPELINE_VISION_PROVIDER","hunyuan")
    paths=f.write_sequence(f.root/"hunyuan-vision",shifts=tuple(i%4 for i in range(16)))
    class Response:
        status_code=200
        def json(self):
            return {"id":"hy-review-test","choices":[{"finish_reason":finish,"message":{"content":content}}],"usage":{"total_tokens":200}}
    with patch.object(VisionReviewer,"key",return_value="hy-test-secret"),patch("sprite_pipeline.vision_review.httpx.Client") as factory:
        client=factory.return_value.__enter__.return_value
        client.post.return_value=Response()
        if should_pass:
            result=VisionReviewer(s.settings).review(paths,"attack",f.reference_path)
            assert result["provider"]=="hunyuan" and result["model"]=="hy-vision-2.0-instruct"
            assert "hy-test-secret" not in json.dumps(result)
        else:
            with pytest.raises(ValidationHarnessError,match="输出未完成" if finish == 'length' else "未取得有效结论"):
                VisionReviewer(s.settings).review(paths,"attack",f.reference_path)
        assert client.post.call_count==(2 if should_pass else 1)
        call=client.post.call_args_list[0]
        assert call.args[0]=="https://tokenhub.tencentmaas.com/v1/chat/completions"
        body=call.kwargs["json"]
        assert body["max_tokens"]==6000 and body["stream"] is False
        assert "input" not in body and "reasoning" not in body
        parts=body["messages"][0]["content"]
        assert len([v for v in parts if v["type"]=="image_url"])==17
        labels=[v["text"] for v in parts if v["type"]=="text" and v["text"].startswith("Frame ")]
        assert labels==[f"Frame {i+1}/16" for i in range(16)]


def test_lock_initialization_race_joins_regular_acquisition(setup,monkeypatch):
    import os
    s,_,_=setup
    original=os.write
    def concurrent_initialization(descriptor,payload):
        original(descriptor,payload)
        raise PermissionError("another process locked the newly initialized byte")
    monkeypatch.setattr(os,"write",concurrent_initialization)
    with s.store.global_lock("motion_init_race",timeout_seconds=1):
        pass
