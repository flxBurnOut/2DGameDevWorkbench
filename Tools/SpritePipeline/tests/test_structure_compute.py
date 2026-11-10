"""Device policy/probes need no model downloads or Torch in SpritePipeline."""
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from sprite_pipeline.collaboration import structure_runtime


@pytest.fixture
def compute(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'VisualStructure'))
    return importlib.import_module('compute')


def torch_stub(cuda=False, mps=False):
    return SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: cuda),
                           backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps)))


@pytest.mark.parametrize('cuda,mps,expected', [(True, True, 'cuda'), (False, True, 'mps'), (False, False, 'cpu')])
def test_auto_priority(compute, cuda, mps, expected):
    assert compute.select_device(torch_stub(cuda, mps), 'auto') == expected


def test_explicit_device_is_never_silently_replaced(compute):
    assert compute.select_device(torch_stub(True, True), 'cpu') == 'cpu'
    for requested in ['cuda', 'mps', 'invalid']:
        with pytest.raises(ValueError):
            compute.select_device(torch_stub(), requested)


def test_request_then_environment_then_local_config(compute, monkeypatch, tmp_path):
    worker = tmp_path/'Tools/VisualStructure/compute.py'
    monkeypatch.setattr(compute, '__file__', str(worker))
    config = tmp_path/'work/visual-structure-runtime/device.json'
    config.parent.mkdir(parents=True)
    monkeypatch.delenv('FORGE_STRUCTURE_DEVICE', raising=False)
    assert compute.requested_device() == 'auto'
    config.write_text('{"device":"cpu"}')
    assert compute.requested_device() == 'cpu'
    monkeypatch.setenv('FORGE_STRUCTURE_DEVICE', 'mps')
    assert compute.requested_device() == 'mps'
    assert compute.requested_device({'device': 'cuda'}) == 'cuda'
    config.write_text('broken json')
    monkeypatch.delenv('FORGE_STRUCTURE_DEVICE')
    with pytest.raises(ValueError):
        compute.requested_device()


def test_probe_cache_invalidates_on_policy_change_and_does_not_retry(monkeypatch, tmp_path):
    structure_runtime._cache.clear()
    worker = tmp_path/'Tools/VisualStructure/worker.py'
    worker.parent.mkdir(parents=True);worker.write_text('# fixture')
    runtime = {'worker':str(worker), 'python':str(tmp_path/'python')}
    calls = []
    def run(*args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout=json.dumps({'device':'cpu','requested_device':'cpu'}))
    monkeypatch.setattr(structure_runtime.subprocess, 'run', run)
    monkeypatch.delenv('FORGE_STRUCTURE_DEVICE', raising=False)
    assert structure_runtime.probe(runtime)['available']
    assert structure_runtime.probe(runtime)['device'] == 'cpu'
    assert len(calls) == 1
    monkeypatch.setenv('FORGE_STRUCTURE_DEVICE', 'mps')
    monkeypatch.setattr(structure_runtime.subprocess, 'run', lambda *a,**kw: SimpleNamespace(
        returncode=1, stdout='', stderr='ValueError: Requested mps device is unavailable'))
    failed = structure_runtime.probe(runtime)
    assert not failed['available'] and failed['device'] is None
    assert 'mps device is unavailable' in failed['error']
    # Cache failures as well: viewing the page cannot repeatedly launch probes.
    monkeypatch.setattr(structure_runtime.subprocess, 'run', lambda *a,**kw: pytest.fail('Unexpected automatic retry'))
    assert structure_runtime.probe(runtime) == failed
