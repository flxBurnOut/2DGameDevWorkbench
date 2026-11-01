"""Offline, pinned Marigold IID analysis. Paths come from the Bridge, not image metadata."""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'


def digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', required=True)
    args = parser.parse_args()
    job = json.loads(Path(args.job).read_text(encoding='utf-8'))
    model = Path(job['model'])
    pinned = json.loads((model.parent / 'installed.json').read_text(encoding='utf-8'))
    for name, expected in pinned['files'].items():
        if digest(model / name) != expected:
            raise ValueError('Pinned model file changed: ' + name)
    if digest(job['source']) != job['sourceSha256']:
        raise ValueError('Source changed')
    import numpy as np
    import torch
    import diffusers
    from PIL import Image
    started = time.monotonic()
    image = Image.open(job['source']).convert('RGBA')
    rgba = np.asarray(image).astype(np.float32) / 255
    h, w = rgba.shape[:2]
    if max(w, h) > 1536 or w * h > 2359296:
        raise ValueError('Intrinsic experiment supports at most 1536 pixels per edge')
    pipe = diffusers.MarigoldIntrinsicsPipeline.from_pretrained(str(model), variant='fp16', torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32, local_files_only=True)
    if torch.cuda.is_available():
        pipe.enable_model_cpu_offload()
        torch.cuda.reset_peak_memory_stats()
    pipe.set_progress_bar_config(disable=True)
    predictions = []
    backgrounds = [.5, .75] if np.any(rgba[:, :, 3] < 1) else [.5]
    for background in backgrounds:
        rgb = rgba[:, :, :3] * rgba[:, :, 3:] + background * (1 - rgba[:, :, 3:])
        result = pipe(Image.fromarray(np.rint(rgb * 255).astype('uint8')), num_inference_steps=4, ensemble_size=3, processing_resolution=512, match_input_resolution=True, output_uncertainty=True, generator=torch.Generator('cpu').manual_seed(1807))
        predictions.append((np.asarray(result.prediction), np.asarray(result.uncertainty)))
    pred, uncertainty = predictions[0]
    if pred.shape != (3, h, w, 3) or uncertainty.shape != pred.shape:
        raise ValueError('Unexpected Marigold output shape: ' + str((pred.shape, uncertainty.shape)))
    a, s, r = pred
    rgb = rgba[:, :, :3]
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    visible = rgba[:, :, 3] >= .5
    # Shading/residual are scale-ambiguous. Fit two nonnegative global gains,
    # record them, and evaluate error BEFORE any original-image compensation.
    matrix = np.stack([(a*s)[visible].reshape(-1), r[visible].reshape(-1)], axis=1)
    gains = np.linalg.lstsq(matrix[::8], linear[visible].reshape(-1)[::8], rcond=None)[0] if np.any(visible) else np.ones(2)
    gains = np.clip(gains, 0, 16)
    layers = {'albedo': a, 'shading': s*gains[0], 'residual': r*gains[1]}
    scales = np.array([1, gains[0], gains[1]])[:, None, None, None]
    disagreements = [uncertainty * scales]
    origins = ['ensemble-albedo', 'ensemble-shading', 'ensemble-residual']
    if len(predictions) > 1:
        disagreements.append(np.abs(predictions[1][0] - pred) * scales)
        origins.extend(['backdrop-albedo', 'backdrop-shading', 'backdrop-residual'])
    differences = np.concatenate(disagreements, axis=0)
    layers['uncertainty'] = differences.max(axis=0)
    output = Path(job['output'])
    output.mkdir(parents=True, exist_ok=True)
    files = {}
    for name, values in layers.items():
        if not np.all(np.isfinite(values)):
            raise ValueError('Non-finite analysis values')
        file = output / (name + '.f32')
        np.asarray(values, dtype='<f4').tofile(file)
        files[name] = {'sha256': digest(file), 'file': file.name}
        preview = np.clip(values, 0, 1)
        if name != 'uncertainty':
            preview = np.where(preview <= .0031308, 12.92*preview, 1.055*preview**(1/2.4)-.055)
        Image.fromarray(np.rint(preview*255).astype('uint8')).save(output / (name+'.png'))
    receipt = {'sourceSha256': job['sourceSha256'], 'width': w, 'height': h, 'model': pinned['model'], 'revision': pinned['revision'], 'modelFiles': pinned['files'], 'colorSpace': 'linear-rgb', 'dtype': 'float32-le', 'gains': gains.tolist(), 'processingResolution': 512, 'steps': 4, 'ensemble': 3, 'seed': 1807, 'backgrounds': backgrounds, 'torch': torch.__version__, 'diffusers': diffusers.__version__, 'device': 'cuda-offload' if torch.cuda.is_available() else 'cpu', 'elapsedSeconds': time.monotonic()-started, 'peakCudaBytes': torch.cuda.max_memory_allocated() if torch.cuda.is_available() else 0, 'files': files}
    origin_file = output / 'disagreement-origin.u8'
    differences.max(axis=-1).argmax(axis=0).astype('uint8').tofile(origin_file)
    receipt['disagreementOrigin'] = {'sha256': digest(origin_file), 'labels': origins}
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
