"""N1 identity/compatibility only: no item-reference transfer or object templates."""
import hashlib
import json
from pathlib import Path
import shutil
from unittest.mock import patch
import uuid
import zipfile

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from object_test_fixtures import write_interactable
from test_harness_integration import TemporaryHarness
from test_open_motion import Planner
from sprite_pipeline.api_app import create_api
from sprite_pipeline.asset_catalog import AssetCatalog
from sprite_pipeline.collaboration.contracts import TaskSpec, digest, default_new_review
from sprite_pipeline.collaboration.execution import PlanGeneration
from sprite_pipeline.collaboration.workspace import OpenMotionWorkspace
from sprite_pipeline.errors import ConflictError, ValidationHarnessError
from sprite_pipeline.models import CharacterPreset, GenerationRequest, InteractablePreset
from sprite_pipeline.providers.fixture import FixtureProvider
from sprite_pipeline.service import SpritePipelineService


LEGACY = json.loads((Path(__file__).parent / "fixtures/legacy-object-identity.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("key,model", [("task_spec", TaskSpec), ("generation_request", GenerationRequest), ("character_preset", CharacterPreset)])
def test_historical_identity_dump_roundtrips_unchanged(key, model):
    fixture = LEGACY[key]
    value = model.model_validate(fixture["input"])
    assert value.object_type == "character" and value.object_id == value.character_id
    assert value.model_dump(mode="json") == fixture["dump"]
    assert model.model_validate(value.model_dump(mode="json")).model_dump(mode="json") == fixture["dump"]
    assert value.model_copy(deep=True).model_dump(mode="json") == fixture["dump"]
    if key == "task_spec":
        assert digest({"spec": value.model_dump(mode="json"), "auto_execute": False}) == fixture["request_fingerprint"]
        assert "object_id" not in default_new_review(value).model_dump(mode="json")
    elif key == "generation_request":
        payload = value.model_dump(mode="json", exclude={"request_key"})
        payload.pop("attack_segment", None)
        payload.pop("motion_repair", None)
        assert hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest() == fixture["request_fingerprint"]
    else:
        assert digest(value.model_dump(mode="json")) == fixture["dump_hash"]


def test_new_identity_is_typed_and_aliases_cannot_disagree():
    value = TaskSpec(object_id="door", object_type="interactable", description="Open the door.", provider="fixture")
    assert value.character_id == "door"
    assert value.model_dump(mode="json")["object_type"] == "interactable"
    assert "character_id" not in value.model_dump(mode="json")
    for extra in ({"character_id": "other"}, {"object_type": "map"}):
        with pytest.raises(ValidationError):
            TaskSpec.model_validate({**value.model_dump(mode="json"), **extra})
    assert TaskSpec(object_id="hero", description="Raise an arm.").object_type == "character"


@pytest.fixture
def objects(tmp_path):
    TemporaryHarness(tmp_path)
    preset = write_interactable(tmp_path)
    service = SpritePipelineService(tmp_path)
    service.open_motion_model = Planner()
    return service, preset


def test_object_presets_omit_character_only_fields_and_validate_type(objects):
    service, preset = objects
    assert "facing" not in preset.model_dump() and "weapon_hand" not in preset.model_dump()
    for update in ({"facing": "right"}, {"weapon_hand": "reference"}, {"cell_width": 64, "cell_height": 64, "anchor": {"x": 32, "ground_y": 63}}):
        with pytest.raises(ValidationError):
            InteractablePreset.model_validate({**preset.model_dump(), **update})
    assert service.presets.load_object("test_hero", object_type="character")[0].character_id == "test_hero"
    with pytest.raises(ValidationHarnessError, match="type does not match"):
        service.presets.load_object(preset.object_id, object_type="character")
    with pytest.raises(ValidationHarnessError, match="open-motion"):
        service.create_job({"object_id": preset.object_id, "object_type": "interactable", "action_id": "walk"})


def test_object_inventory_and_preview_are_read_only(objects):
    service, preset = objects
    client = TestClient(create_api(service=service))
    references = client.get("/v1/open-motion/references").json()
    row = next(row for row in references["objects"] if row["id"] == preset.object_id)
    assert row["object_type"] == "interactable" and "facing" not in row
    assert all(row["id"] != preset.object_id for row in references["characters"])
    assert client.get(f"/v1/open-motion/references/{preset.object_id}").status_code == 200
    assert service.list_jobs() == [] and service.open_motion_model.calls == []
    assert any(row["id"] == preset.object_id for row in service.list_presets()["objects"])


def test_character_import_reserves_existing_object_ids(objects):
    service, preset = objects
    write_interactable(service.settings.root, "fixture_door_002")
    original = service.presets.object_path(preset.object_id).read_bytes()
    source = service.presets.object_path(preset.object_id).parent / preset.reference_frame
    created = service.create_character_preset(display_name="Fixture door", character_id=preset.object_id, reference_image=source)
    assert created.character_id == "fixture_door_003"
    assert service.presets.load_object(preset.object_id)[0].object_type == "interactable"
    assert service.presets.object_path(preset.object_id).read_bytes() == original
    with pytest.raises(ConflictError, match="reserved by an object"):
        service.create_character_preset(display_name="Fixture door", character_id=preset.object_id,
            reference_image=source, reuse_if_identical=True)
    assert service.presets.object_path(preset.object_id).read_bytes() == original


def test_typed_character_object_keeps_character_structure_reads(objects):
    service, preset = objects
    character, source = service.presets.load_character("test_hero")
    data = character.model_dump(mode="json")
    data.pop("character_id")
    data.update(object_id="typed_hero", object_type="character")
    path = service.presets.object_path("typed_hero")
    path.parent.mkdir(parents=True)
    shutil.copy2(source.parent / character.reference_frame, path.parent / character.reference_frame)
    path.write_text(json.dumps(data), encoding="utf-8")
    client = TestClient(create_api(service=service))
    assert client.get("/v1/open-motion/references/typed_hero").status_code == 200
    response = client.get("/v1/open-motion/references/typed_hero/structure")
    assert response.status_code == 200, response.text
    from sprite_pipeline.collaboration.structures import VisualStructures
    structures = VisualStructures(service)
    assert structures.reference("typed_hero")[1]["character_id"] == "typed_hero"
    assert structures.reference(preset.object_id)[1]["object_type"] == "interactable"
    assert not service.list_jobs() and not service.open_motion_model.calls


@pytest.mark.parametrize("identity", [{"character_id": "test_hero"}, {"object_id": "test_hero", "object_type": "character"}, {"object_id": "fixture_door", "object_type": "interactable"}])
def test_old_and_new_objects_plan_resume_and_export_without_identity_migration(objects, identity):
    service, _ = objects
    workspace = OpenMotionWorkspace(service)
    spec = TaskSpec(**identity, description="Make the requested visible movement.", provider="fixture", review_protocol="baseline")
    key = uuid.uuid4().hex
    work = workspace.create(spec, key, planning_authorized=True)
    assert workspace.create(spec, key, planning_authorized=True).id == work.id
    if spec.object_type == "interactable":
        # A saved N1 plan predates the prop contract and keeps its original
        # fingerprint and execution behavior. New planning is tested on N2 archives.
        from sprite_pipeline.collaboration.contracts import PlanProposal
        value, _ = service.open_motion_model("coordinator", work, workspace.reference(work))
        work.plan = PlanProposal.model_validate(value["plan"])
        work.plan_sha256 = digest(work.plan.model_dump(mode="json"))
        work.status = "ready"
        workspace.save(work)
    else:
        work = workspace.plan(work.id)
    assert work.status == "ready", work.message
    provider = FixtureProvider()
    with patch("sprite_pipeline.providers.get_provider", return_value=provider):
        work = workspace.start(work.id, work.revision, work.plan_sha256)
        # Restart before execution; frozen identity and fingerprints remain readable.
        service = SpritePipelineService(service.settings.root)
        workspace = OpenMotionWorkspace(service)
        reloaded = workspace.load(work.id)
        assert reloaded.spec.model_dump(mode="json") == spec.model_dump(mode="json")
        job = PlanGeneration(service).advance(work.job_id, provider, wait=True)
        assert len(job.candidates[0].frames) == 8
        service.approve_candidate(job.job_id, 1, reviewer="test", acknowledge_warnings=True)
        result = service.export_candidate(job.job_id, 1)
        assert result.export.godot_package_path
        workspace.start(work.id, work.revision, work.plan_sha256)
        summary = service.list_jobs()[0]
        assert summary["object_id"] == spec.object_id and summary["object_type"] == spec.object_type
        catalog = AssetCatalog(service)
        asset_id = f"animation:{job.job_id}:1"
        assert not any(row["id"] == asset_id for row in catalog.list()["assets"])
        source = service.store.resolve_job_path(job.job_id, job.candidates[0].frames[0].active_path)
        row = {"id": asset_id, "kind": "animation", "job_id": job.job_id, "candidate_index": 1,
               "title": "Fixture animation", "status_label": "Exported", "updated_at": summary["updated_at"],
               "source": str(source), "fallback": str(source)}
        # Inject only inventory eligibility. The exact-ID metadata, files and archive are real.
        with patch.object(catalog.library, "get", return_value=row):
            detail = catalog.detail(asset_id)
        if spec.object_type == "interactable":
            assert detail["objectId"] == spec.object_id and detail["objectType"] == "interactable"
            assert "facing" not in detail
            assert [item["representation"] for item in detail["animationRepresentations"]] == ["frames", "sheet"]
            assert all("sourceFacing" not in item for item in detail["animationRepresentations"])
            with zipfile.ZipFile(service.settings.resolve_record_path(result.export.godot_package_path)) as archive:
                name = next(name for name in archive.namelist() if name.endswith("/export.json"))
                contract = json.loads(archive.read(name))
            assert contract["object_id"] == spec.object_id and "source_facing" not in contract
