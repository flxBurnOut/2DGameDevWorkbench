"""Read-only, bounded device probe. Never part of paid semantic cache identity."""
import json
import os
import subprocess
import threading
import time
from pathlib import Path

_cache = {}
_lock = threading.Lock()


def probe(runtime):
    worker = Path(runtime['worker'])
    config = worker.parents[2] / 'work/visual-structure-runtime/device.json'
    paths = [Path(runtime['python']), worker, worker.with_name('compute.py'), config]
    key = (tuple((str(p), p.stat().st_mtime_ns if p.exists() else None) for p in paths),
           os.environ.get('FORGE_STRUCTURE_DEVICE'), os.environ.get('PYTORCH_ENABLE_MPS_FALLBACK'))
    with _lock:
        prior = _cache.get(key)
        if prior and time.monotonic() - prior[0] < 30:
            return prior[1]
        try:
            run = subprocess.run([runtime['python'], runtime['worker'], 'doctor'],
                                 capture_output=True, text=True, timeout=30,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if run.returncode:
                detail = run.stderr.strip().splitlines()
                raise ValueError(detail[-1][:500] if detail else 'Device probe exited without a diagnostic')
            value = json.loads(run.stdout)
            if not isinstance(value, dict) or value.get('device') not in ('cpu', 'cuda', 'mps'):
                raise ValueError('Device probe failed')
            result = {'available': True, **value}
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            result = {'available': False, 'device': None,
                      'error': f'本地计算设备检查失败：{str(exc)[:500]}。请运行 visual-structure:check；可显式切换 CPU。'}
        _cache.clear()
        _cache[key] = (time.monotonic(), result)
        return result
