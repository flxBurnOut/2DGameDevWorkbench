"""Device policy and truthful telemetry, independent of semantic/model identity."""
import json
import os
from contextlib import contextmanager
from pathlib import Path


def requested_device(job=None):
    if job and 'device' in job:
        return job['device']
    if os.environ.get('FORGE_STRUCTURE_DEVICE'):
        return os.environ['FORGE_STRUCTURE_DEVICE']
    config = Path(__file__).resolve().parents[2] / 'work/visual-structure-runtime/device.json'
    return json.loads(config.read_text()).get('device', 'auto') if config.is_file() else 'auto'


def select_device(torch, requested='auto'):
    if requested not in ('auto', 'cuda', 'mps', 'cpu'):
        raise ValueError('FORGE_STRUCTURE_DEVICE must be auto, cuda, mps or cpu')
    mps = getattr(getattr(torch, 'backends', None), 'mps', None)
    available = {'cpu': True, 'cuda': torch.cuda.is_available(),
                 'mps': bool(mps and mps.is_available())}
    if requested == 'auto':
        return next(d for d in ('cuda', 'mps', 'cpu') if available[d])
    if not available[requested]:
        raise ValueError(f'Requested {requested} device is unavailable; choose cpu explicitly to run locally')
    return requested


def synchronize(torch, device):
    if device == 'cuda': torch.cuda.synchronize()
    elif device == 'mps': torch.mps.synchronize()


def telemetry(torch, device, requested):
    return {'requested_device': requested, 'device': device, 'precision': 'float32',
            'torch': getattr(torch, '__version__', 'test-double'),
            'mps_fallback_enabled': os.environ.get('PYTORCH_ENABLE_MPS_FALLBACK') == '1',
            'automatic_retry': False,
            'attention_policy': 'mps_bounded_math_v1' if device == 'mps' else 'native',
            'pool_layout': 'contiguous_nchw' if device == 'mps' else 'native',
            # These are end-of-job snapshots, NOT peaks.
            'mps_allocated_bytes': torch.mps.current_allocated_memory() if device == 'mps' else None,
            'mps_driver_bytes': torch.mps.driver_allocated_memory() if device == 'mps' else None,
            'peak_gpu_bytes': torch.cuda.max_memory_allocated() if device == 'cuda' else None}


@contextmanager
def inference_context(torch, device, model):
    """Bound SAM's MPS attention intermediates; retain full keys and FP32.

    Chunking queries retains every key and the full softmax domain. On the pinned
    Torch 2.7.1, Hiera's channels-last max-pool also needs contiguous NCHW input:
    otherwise its output differs substantially from CPU. No CPU operator fallback.
    Both adaptations are worker-local and restored even after a failure.
    """
    if device != 'mps':
        yield
        return
    import math
    import torch.nn.functional as functional
    original = functional.scaled_dot_product_attention
    hooks = []

    def bounded(q, k, v, attn_mask=None, dropout_p=0.0, is_causal=False, *, scale=None, enable_gqa=False):
        if q.device.type != 'mps':
            return original(q, k, v, attn_mask, dropout_p, is_causal, scale=scale, enable_gqa=enable_gqa)
        if dropout_p or is_causal or enable_gqa:
            raise ValueError('Bounded SAM attention supports non-causal inference without dropout/GQA only')
        batch_heads = math.prod(q.shape[:-2])
        chunk = max(1, min(q.shape[-2], 4_194_304 // max(1, batch_heads * k.shape[-2])))
        k, v = k.contiguous(), v.contiguous()
        outputs = []
        for start in range(0, q.shape[-2], chunk):
            mask = attn_mask
            if mask is not None and mask.shape[-2] != 1:
                mask = mask[..., start:start + chunk, :]
            scores = q[..., start:start + chunk, :].contiguous() @ k.transpose(-2, -1).contiguous()
            scores = scores * (scale if scale is not None else q.shape[-1] ** -0.5)
            if mask is not None:
                scores = scores.masked_fill(~mask, float('-inf')) if mask.dtype == torch.bool else scores + mask
            # SDPA defines an entirely masked query as zero, rather than NaN.
            outputs.append(torch.nan_to_num(torch.softmax(scores, dim=-1), nan=0.0) @ v)
        return torch.cat(outputs, dim=-2)
    try:
        for module in model.modules():
            if isinstance(module, torch.nn.MaxPool2d):
                hooks.append(module.register_forward_pre_hook(
                    lambda _, args: (args[0].contiguous(),)))
        functional.scaled_dot_product_attention = bounded
        yield
    finally:
        functional.scaled_dot_product_attention = original
        for hook in hooks:
            hook.remove()
