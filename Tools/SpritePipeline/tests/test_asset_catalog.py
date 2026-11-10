import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from sprite_pipeline.api_app import create_api
from sprite_pipeline.asset_catalog import AssetCatalog
from sprite_pipeline.service import SpritePipelineService
from test_harness_integration import TemporaryHarness


def test_inventory_exact_candidate_and_files_are_read_only():
    with tempfile.TemporaryDirectory(prefix="catalog-test-") as directory:
        fixture = TemporaryHarness(Path(directory))
        service = SpritePipelineService(Path(directory))
        job = service.create_job({**fixture.create_request('import'), 'candidate_count': 3})
        fixture.write_sequence(fixture.root / 'inputs')
        service.ingest_candidate(job.job_id, 2, fixture.root / 'inputs')
        before = service.get_job(job.job_id).model_dump_json()
        catalog = AssetCatalog(service)
        rows = catalog.list()['assets']
        animations = [a for a in rows if a['kind'] == 'animation']
        assert len(animations) == 1
        selected = animations[0]
        assert selected['candidateIndex'] == 2 and selected['candidateCount'] == 3
        assert selected['frameCount'] == 4
        client = TestClient(create_api(service=service))
        assert client.get('/v1/artworks').json()['data']['assets'] == rows
        detail = client.get('/v1/artworks/' + selected['id']).json()['data']['asset']
        assert detail['width'] == 64 and detail['height'] == 64
        assert detail['fps'] == job.action.fps
        assert detail['loop'] is job.action.loop
        assert detail['productionRevision'] == service.get_job(job.job_id).revision
        assert detail['animationRepresentations'][0]['frameKeys'] == ['frame-0', 'frame-1', 'frame-2', 'frame-3']
        assert detail['animationRepresentations'][0]['fps'] == job.action.fps
        assert detail['animationRepresentations'][0]['loop'] is job.action.loop
        frame = next(f for f in detail['files'] if f['key'] == 'frame-1')
        image = client.get('/v1/artworks/file', params={'asset_id': selected['id'], 'key': 'frame-1'})
        assert image.status_code == 200
        assert hashlib.sha256(image.content).hexdigest() == frame['sha256']
        assert client.get('/v1/artworks/file', params={'asset_id': selected['id'], 'key': '../../config/credentials.json'}).status_code == 404
        assert client.get('/v1/artworks/' + f'animation:{job.job_id}:1').status_code == 404
        Path(frame['path']).unlink()
        missing = catalog.detail(selected['id'])
        assert next(f for f in missing['files'] if f['key'] == 'frame-1')['available'] is False
        assert service.get_job(job.job_id).model_dump_json() == before


def test_fixture_and_empty_jobs_do_not_become_assets():
    with tempfile.TemporaryDirectory(prefix="catalog-test-") as directory:
        fixture = TemporaryHarness(Path(directory))
        service = SpritePipelineService(Path(directory))
        empty = service.create_job(fixture.create_request('import'))
        diagnostic = service.create_job(fixture.create_request('fixture'))
        service.generate_job(diagnostic.job_id)
        assert not [a for a in AssetCatalog(service).list()['assets'] if a.get('jobId') in [empty.job_id, diagnostic.job_id]]


def test_archiving_history_preserves_artwork_details_and_downloads(tmp_path):
    fixture = TemporaryHarness(tmp_path)
    service = SpritePipelineService(tmp_path)
    job = service.create_job(fixture.create_request('import'))
    fixture.write_sequence(fixture.root / 'inputs')
    service.ingest_candidate(job.job_id, 1, fixture.root / 'inputs')
    client = TestClient(create_api(service=service))
    asset_id = f'animation:{job.job_id}:1'
    before = client.get('/v1/artworks/' + asset_id).json()['data']['asset']
    frame = client.get('/v1/artworks/file', params={'asset_id': asset_id, 'key': 'frame-1'}).content
    job_bytes = service.get_job(job.job_id).model_dump_json()
    assert service.archive_history()['count'] == 1
    assert service.list_jobs() == []
    # Reopen the service, as after a restart. The execution list stays empty,
    # while the very same candidate, creation time, revision and bytes remain readable.
    reopened = SpritePipelineService(tmp_path)
    assert reopened.list_jobs() == []
    catalog = AssetCatalog(reopened)
    assert catalog.detail(asset_id) == before
    assert catalog.file(asset_id, 'frame-1').read_bytes() == frame
    assert reopened.get_job(job.job_id).model_dump_json() == job_bytes


def test_original_frames_and_godot_export_have_separate_verified_playback(tmp_path):
    fixture = TemporaryHarness(tmp_path)
    service = SpritePipelineService(tmp_path)
    job = service.create_job(fixture.create_request('import'))
    fixture.write_sequence(tmp_path / 'incoming')
    service.ingest_candidate(job.job_id, 1, tmp_path / 'incoming')
    service.approve_candidate(job.job_id, 1, reviewer='catalog-test', acknowledge_warnings=True)
    job = service.export_candidate(job.job_id, 1)
    before = service.get_job(job.job_id).model_dump_json()
    with zipfile.ZipFile(service.settings.resolve_record_path(job.export.godot_package_path)) as package:
        contract = json.loads(package.read(next(name for name in package.namelist() if name.endswith('/export.json'))))
    catalog = AssetCatalog(service)
    detail = catalog.detail(f'animation:{job.job_id}:1')
    raw, exported = detail['animationRepresentations']
    assert raw['representation'] == 'frames'
    assert raw['fps'] == job.action.fps and raw['loop'] is job.action.loop
    assert exported['representation'] == 'sheet'
    assert exported['regions'] == contract['source_region_px']
    assert exported['fps'] == contract['fps'] and exported['loop'] is contract['loop']
    assert exported['anchor'] == contract['anchor']
    assert exported['sheetSha256'] == contract['sheet_sha256']
    # An old Godot contract cannot supply parameters for a different current sheet.
    sheet = service.settings.resolve_record_path(job.export.sheet_path)
    sheet.write_bytes(sheet.read_bytes() + b'changed')
    assert len(catalog.detail(f'animation:{job.job_id}:1')['animationRepresentations']) == 1
    assert service.get_job(job.job_id).model_dump_json() == before
