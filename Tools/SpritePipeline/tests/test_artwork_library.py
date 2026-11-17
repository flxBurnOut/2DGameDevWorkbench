import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image

from sprite_pipeline.artwork_library import ArtworkLibrary, animation_actions
from sprite_pipeline.errors import ValidationHarnessError
from sprite_pipeline.models import CandidateStatus
from sprite_pipeline.service import QA_ALGORITHM_VERSION, SpritePipelineService
from test_harness_integration import TemporaryHarness


@pytest.fixture
def library_setup():
    with tempfile.TemporaryDirectory(prefix="artwork-test-") as directory:
        fixture = TemporaryHarness(Path(directory))
        service = SpritePipelineService(Path(directory))
        yield fixture, service, ArtworkLibrary(service)


def test_empty_failed_and_fixture_runs_do_not_become_artworks(library_setup):
    fixture, service, library = library_setup
    empty = service.create_job(fixture.create_request('import'))
    failed = service.create_job(fixture.create_request('import'))
    with service.store.locked_job(failed.job_id) as job:
        job.candidates[0].status = CandidateStatus.failed
    diagnostic = service.create_job(fixture.create_request('fixture'))
    service.generate_job(diagnostic.job_id)
    rows = library.list_artworks()
    assert [row['kind'] for row in rows] == ['character']
    assert len(service.list_jobs()) == 3
    assert {empty.job_id, failed.job_id, diagnostic.job_id} == {row['job_id'] for row in service.list_jobs()}


def test_animation_cards_are_per_material_and_catalog_remains_lazy(library_setup):
    fixture, service, library = library_setup
    request = {**fixture.create_request('import'), 'candidate_count': 2}
    job = service.create_job(request)
    paths = fixture.write_sequence(fixture.root / 'inputs')
    service.ingest_candidate(job.job_id, 2, fixture.root / 'inputs')
    with service.store.locked_job(job.job_id) as updated:
        updated.character.display_name = '红袍法师'
        updated.action.display_name = '红袍法师原地举杖施法循环'
    with patch.object(service.store, 'load', side_effect=AssertionError('must not open tasks')), patch.object(Image, 'open', side_effect=AssertionError('must not decode frames')):
        rows = library.list_artworks()
    animations = [row for row in rows if row['kind'] == 'animation']
    assert len(animations) == 1
    assert animations[0]['title'] == '红袍法师原地举杖施法循环'
    assert animations[0]['candidate_index'] == 2
    assert animations[0]['job_id'] == job.job_id
    assert 'review' in animations[0]['actions']
    assert all(path.is_file() for path in paths)


def test_old_summary_backfills_materials_once(library_setup):
    fixture, service, library = library_setup
    job = service.create_job(fixture.create_request('import'))
    fixture.write_sequence(fixture.root / 'inputs')
    service.ingest_candidate(job.job_id, 1, fixture.root / 'inputs')
    path = service.store.job_dir(job.job_id) / 'summary.json'
    summary = json.loads(path.read_text())
    summary['summary_schema_version'] = 1
    summary.pop('artworks')
    path.write_text(json.dumps(summary))
    assert any(row['kind'] == 'animation' for row in library.list_artworks())
    assert json.loads(path.read_text())['summary_schema_version'] == 3
    with patch.object(service.store, 'load', side_effect=AssertionError('second list should use summary')):
        assert any(row['kind'] == 'animation' for row in library.list_artworks())


def test_repair_and_approval_change_available_actions(library_setup):
    fixture, service, library = library_setup
    job = service.create_job(fixture.create_request('import'))
    fixture.write_sequence(fixture.root / 'inputs')
    service.ingest_candidate(job.job_id, 1, fixture.root / 'inputs')
    artwork_id = f'animation:{job.job_id}:1'
    assert 'export' not in library.get(artwork_id)['actions']
    service.review_frame(job.job_id, 1, {'frame_index': 0, 'status': 'repair_requested', 'issue_type': 'other'})
    assert library.get(artwork_id)['actions'][0] == 'edit'
    service.review_frame(job.job_id, 1, {'frame_index': 0, 'status': 'approved'})
    service.approve_candidate(job.job_id, 1, reviewer='test', acknowledge_warnings=True)
    assert library.get(artwork_id)['actions'] == ['export', 'review']
    with service.store.locked_job(job.job_id) as updated:
        updated.candidates[0].qa_algorithm_version = 'old-version'
    assert library.get(artwork_id)['actions'] == ['review']


def test_terminal_or_inflight_work_never_offers_edit():
    for status in ('approved', 'rejected', 'failed', 'submitting', 'submission_unknown', 'provider_pending', 'saving', 'created'):
        _label, actions = animation_actions({'status': status}, QA_ALGORITHM_VERSION)
        assert 'edit' not in actions
        assert 'export' not in actions


def test_map_import_is_persistent_deduplicated_and_byte_exact(library_setup):
    fixture, service, library = library_setup
    source = fixture.root / 'forest.png'
    Image.new('RGB', (512, 256), '#498866').save(source)
    original = source.read_bytes()
    first = library.import_map(source, '森林地图')
    second = library.import_map(source, '重复点击')
    assert first['id'] == second['id']
    assert len(service.list_jobs()) == 0
    reloaded = ArtworkLibrary(SpritePipelineService(fixture.root)).get(first['id'])
    assert reloaded['title'] == '森林地图'
    assert Path(reloaded['source']).read_bytes() == original
    thumb = Path(library.thumbnail(reloaded))
    with Image.open(thumb) as image:
        assert image.size == (256, 128)
    assert Path(reloaded['source']).read_bytes() == original
    assert reloaded['actions'] == ['download']


def test_missing_thumbnail_preserves_material_and_falls_back_to_frame(library_setup):
    fixture, service, library = library_setup
    job = service.create_job(fixture.create_request('import'))
    fixture.write_sequence(fixture.root / 'inputs')
    service.ingest_candidate(job.job_id, 1, fixture.root / 'inputs')
    row = library.get(f'animation:{job.job_id}:1')
    Path(row['source']).unlink()
    assert library.thumbnail(row)
    Path(row['fallback']).unlink()
    assert library.thumbnail(row) is None
    assert library.get(row['id'])['id'] == row['id']


def test_invalid_map_is_not_published(library_setup):
    fixture, service, library = library_setup
    bad = fixture.root / 'bad.png'
    bad.write_text('not an image')
    with pytest.raises(ValidationHarnessError):
        library.import_map(bad)
    assert not list(library.maps_dir.glob('*/artwork.json'))
    assert service.list_jobs() == []


def test_filters_and_pages_preserve_distinct_material_ids():
    rows = [{'id': str(i), 'kind': 'animation' if i % 2 else 'map', 'title': f'森林 {i}', 'subtitle': '', 'status_label': '待检查'} for i in range(31)]
    page1, page, total = ArtworkLibrary.filter_page(rows, 'all', '', 1)
    page2, _, _ = ArtworkLibrary.filter_page(rows, 'all', '', 2)
    assert total == 31 and page == 1
    assert not {row['id'] for row in page1}.intersection(row['id'] for row in page2)
    maps, page, total = ArtworkLibrary.filter_page(rows, 'map', '森林', 999)
    assert page == 2 and total == 16 and len(maps) == 4
    assert all(row['kind'] == 'map' for row in maps)
    assert ArtworkLibrary.filter_page(rows, 'character', '', 4) == ([], 1, 0)


@pytest.mark.parametrize("archived", [False, True])
def test_gradio_renders_material_cards_and_routes_exact_candidate(library_setup, archived):
    import asyncio
    from functools import partial
    from gradio.state_holder import SessionState
    from sprite_pipeline.ui import build_ui

    fixture, service, library = library_setup
    job = service.create_job({**fixture.create_request('import'), 'candidate_count': 2})
    fixture.write_sequence(fixture.root / 'inputs')
    service.ingest_candidate(job.job_id, 2, fixture.root / 'inputs')
    if archived:
        service.archive_history()
        assert service.list_jobs() == []
    ui = build_ui(service=service)
    state = SessionState(ui)
    render = next(fn for fn in ui.fns.values() if fn.name == 'apply')
    rendered = asyncio.run(ui.process_api(render, inputs=[None, 'all', '', 1], state=state))
    assert rendered['render_config'] is not None
    callbacks = [fn.fn for fn in state.blocks_config.fns.values()
                 if isinstance(fn.fn, partial) and fn.fn.func.__name__ == 'artwork_action']
    artwork_id = f'animation:{job.job_id}:2'
    edit = next(callback for callback in callbacks if callback.args == (artwork_id, 'edit'))
    updates = edit()
    tabs = next(component for component in updates if component.__class__.__name__ == 'Tabs')
    assert updates[tabs]['selected'] == 'repair'
    assert any(isinstance(value, str) and 'candidate=2&amp;frame=0' in value for value in updates.values())
    generate = next(callback for callback in callbacks if callback.args == (f'character:{fixture.character_id}', 'generate'))
    updates = generate()
    assert updates[tabs]['selected'] == 'generate'
    assert any(component.__class__.__name__ == 'File' and value is None for component, value in updates.items())
    # A stale card must re-read durable state before offering the editor.
    service.approve_candidate(job.job_id, 2, reviewer='test', acknowledge_warnings=True)
    updates = edit()
    assert tabs not in updates
    assert any('状态已经改变' in str(value) for value in updates.values())


@pytest.mark.parametrize("archived", [False, True])
def test_workbench_link_opens_visible_details_for_exact_candidate(library_setup, archived):
    from types import SimpleNamespace
    from sprite_pipeline.ui import build_ui

    fixture, service, library = library_setup
    job = service.create_job({**fixture.create_request('import'), 'candidate_count': 3})
    fixture.write_sequence(fixture.root / 'inputs')
    service.ingest_candidate(job.job_id, 2, fixture.root / 'inputs')
    if archived:
        service.archive_history()
        assert service.list_jobs() == []
    before = service.get_job(job.job_id).model_dump_json()
    ui = build_ui(service=service)
    try:
        callback = next(fn for fn in ui.fns.values() if fn.name == 'load_workbench_entry')
        def invoke(params):
            result = callback.fn(None, SimpleNamespace(query_params=params))
            return result if isinstance(result, dict) else dict(zip(callback.outputs, result))
        updates = invoke({'workbench_job': job.job_id, 'workbench_candidate': '2'})
        detail = next(c for c in ui.blocks.values() if getattr(c, 'elem_id', None) == 'artwork-detail')
        content = next(c for c in ui.blocks.values() if getattr(c, 'label', None) == '记录中的候选画面')
        radio = next(c for c in ui.blocks.values() if getattr(c, 'label', None) == '该任务中的候选')
        assert updates.get(detail, {}).get('open') is True
        assert updates.get(content, {}).get('open') is True
        assert updates[radio]['value'] == 2
        assert not any('任务摘要不可用' in str(value) for value in updates.values())
        assert any('地面攻击' in str(value) or '候选 B' in str(value) for value in updates.values())
        gallery = next(c for c in ui.blocks.values() if getattr(c, 'label', None) == '逐帧画面')
        assert len(updates[gallery]) == 4
        assert all("candidate_02" in path for path, _caption in updates[gallery])
        invalid = invoke({'workbench_job': job.job_id, 'workbench_candidate': '8'})
        assert invalid[detail]['open'] is True
        assert invalid[radio]['value'] is None
        assert invalid[gallery] == []
        assert any('所选候选不存在' in str(value) for value in invalid.values())
        missing = invoke({'workbench_job': 'missing-original', 'workbench_candidate': '2'})
        assert missing[detail]['open'] is True
        assert missing[radio]['value'] is None
        assert any('找不到所选任务' in str(value) for value in missing.values())
        ordinary = invoke({})
        assert detail not in ordinary  # Homepage stays a library without forced scrolling/opening.
        assert service.get_job(job.job_id).model_dump_json() == before
    finally:
        ui.close()
