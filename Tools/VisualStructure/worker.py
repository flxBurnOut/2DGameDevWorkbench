"""Isolated, local-only SAM worker. Never imports or upgrades SpritePipeline.

The caller owns authorization, source identity and output confinement. This
process accepts a frozen job file, does no network access and changes no art.
Masks represent visible regions, not hidden anatomy or edit authorization.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from pathlib import Path
from compute import requested_device, select_device, synchronize, telemetry, inference_context

MODEL_CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path = Path(path)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def environment():
    import torch
    import torchvision
    requested = requested_device()
    device = select_device(torch, requested)
    # A real allocation + kernel validates access, not just a compiled-in backend.
    value = torch.ones(4, device=device).sum().item()
    synchronize(torch, device)
    if value != 4: raise RuntimeError('Device probe returned an invalid result')
    return {
        **telemetry(torch, device, requested),
        "mps_available": torch.backends.mps.is_available(),
        "torch": torch.__version__, "torchvision": torchvision.__version__,
        "cuda_available": torch.cuda.is_available(), "cuda_runtime": torch.version.cuda,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "device_capability": list(torch.cuda.get_device_capability(0)) if torch.cuda.is_available() else None,
        "compiled_architectures": torch.cuda.get_arch_list() if torch.cuda.is_available() else [],
        "model_config": MODEL_CONFIG, "network_calls": 0,
    }


def segment(job):
    import numpy as np
    import torch
    from PIL import Image
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    source, weights, output = map(Path, (job["source"], job["weights"], job["output"]))
    source_sha = sha(source)
    if source_sha != job["source_sha256"] or sha(weights) != job["weights_sha256"]:
        raise ValueError("Frozen source or model hash mismatch")
    parts = job["parts"]
    if not 1 <= len(parts) <= 32:
        raise ValueError("Expected 1-32 prompted parts")
    with Image.open(source) as raw:
        if raw.format != "PNG" or max(raw.size) > 1024:
            raise ValueError("Expected a bounded PNG source")
        rgba = raw.convert("RGBA")
    width, height = rgba.size
    seen = set()
    for part in parts:
        name = part["id"]
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", name) or name in seen:
            raise ValueError("Part IDs must be unique safe identifiers")
        seen.add(name)
        points, labels, box = part.get("points", []), part.get("labels", []), part.get("box")
        if len(points) != len(labels) or len(points) > 32 or any(v not in (0, 1) for v in labels):
            raise ValueError("Invalid point prompts")
        if any(len(p) != 2 or not (0 <= p[0] < width and 0 <= p[1] < height) for p in points):
            raise ValueError("Point prompt outside original pixels")
        if box is not None and (len(box) != 4 or not (0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height)):
            raise ValueError("Box prompt outside original pixels")
        if not points and box is None:
            raise ValueError("Each part needs observed point or box prompts")
    # Never overwrite a previous prediction. Each request has its own directory.
    output.mkdir(parents=True, exist_ok=False)
    requested = requested_device(job)
    device = select_device(torch, requested)
    start = time.monotonic()
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    predictor = SAM2ImagePredictor(build_sam2(MODEL_CONFIG, str(weights), device=device, apply_postprocessing=False))
    background = Image.new("RGBA", rgba.size, (127, 127, 127, 255))
    background.alpha_composite(rgba)
    alpha = np.asarray(rgba)[:, :, 3] > 0
    records = []
    with torch.inference_mode(), inference_context(torch, device, predictor.model):
        predictor.set_image(np.array(background.convert("RGB"), copy=True))
        for part in parts:
            masks, scores, _ = predictor.predict(
                point_coords=np.asarray(part["points"], dtype=np.float32) if part.get("points") else None,
                point_labels=np.asarray(part["labels"], dtype=np.int32) if part.get("points") else None,
                box=np.asarray(part["box"], dtype=np.float32) if part.get("box") else None,
                multimask_output=True,
            )
            selected = int(np.argmax(scores))
            raw_mask = masks[selected].astype(bool)
            visible = raw_mask & alpha
            path = output / (part["id"] + ".png")
            Image.fromarray(visible.astype(np.uint8) * 255).save(path)
            records.append({
                "id": part["id"], "file": path.name, "sha256": sha(path),
                "model_score": float(scores[selected]), "model_score_is_accuracy": False,
                "area": int(visible.sum()), "excluded_transparent_pixels": int((raw_mask & ~alpha).sum()),
                "prompt": part, "state": "proposed" if visible.any() else "unknown",
            })
    synchronize(torch, device)
    if sha(source) != source_sha:
        raise ValueError("Source changed during inference")
    receipt = {
        "version": 1, "operation": "segment", "source_sha256": source_sha,
        "width": width, "height": height, "weights_sha256": job["weights_sha256"],
        "model_config": MODEL_CONFIG, "parts": records, "device": device,
        "seconds": time.monotonic() - start,
        **telemetry(torch, device, requested),
        "paid_calls": 0, "source_unchanged": True, "semantics_origin": job["semantics_origin"],
        "limitations": ["Mask scores are not accuracy", "Occluded pixels are not reconstructed", "Masks do not authorize image editing"],
    }
    write_json(output / "receipt.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("doctor", "segment", "track"))
    parser.add_argument("--job")
    args = parser.parse_args()
    if args.operation == "doctor":
        result = environment()
    else:
        job = json.loads(Path(args.job).read_text(encoding="utf-8"))
        if args.operation == "track":
            from tracking import track
            result = track(job)
        else:
            result = segment(job)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
