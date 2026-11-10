"""Bounded whole-map SAM 2.1 proposals from an immutable overview, local only.

This worker never imports SpritePipeline or downloads anything. It predicts
visible masks, not object names, hidden anatomy, semantics or edit authority.
Overview contours must be refined against original pixels before quality claims.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

from compute import inference_context, requested_device, select_device, synchronize, telemetry

MODEL_CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def bounded_integer(value, low, high, name):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{name} must be an integer in {low}..{high}")
    return value


def automatic(job):
    import numpy as np
    import torch
    from PIL import Image
    from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
    from sam2.build_sam import build_sam2
    from sam2.utils.amg import rle_to_mask

    source, weights, output = map(Path, (job["source"], job["weights"], job["output"]))
    source_hash = sha(source)
    if source_hash != job["source_sha256"] or sha(weights) != job["weights_sha256"]:
        raise ValueError("Frozen overview or fixed checkpoint identity mismatch")
    params = job["parameters"]
    side = bounded_integer(params["points_per_side"], 8, 24, "points_per_side")
    batch = bounded_integer(params["points_per_batch"], 1, 32, "points_per_batch")
    maximum = bounded_integer(params["max_candidates"], 1, 96, "max_candidates")
    minimum_area = bounded_integer(params["minimum_area"], 1, 1024 * 1024, "minimum_area")
    iou, stability = params["predicted_iou_threshold"], params["stability_threshold"]
    if not 0.5 <= iou <= 0.95 or not 0.75 <= stability <= 0.99:
        raise ValueError("Automatic mask filtering thresholds exceed bounds")
    with Image.open(source) as raw:
        if raw.format != "PNG" or max(raw.size) > 1024:
            raise ValueError("Expected a PNG overview with longest edge <=1024")
        rgba = raw.convert("RGBA")
    width, height = rgba.size
    alpha = np.asarray(rgba)[:, :, 3] > 0
    background = Image.new("RGBA", rgba.size, (127, 127, 127, 255))
    background.alpha_composite(rgba)
    requested = requested_device(job)
    device = select_device(torch, requested)
    start = time.monotonic()
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    model = build_sam2(MODEL_CONFIG, str(weights), device=device, apply_postprocessing=False)
    generator = SAM2AutomaticMaskGenerator(
        model, points_per_side=side, points_per_batch=batch,
        pred_iou_thresh=iou, stability_score_thresh=stability,
        box_nms_thresh=0.7, crop_n_layers=0, min_mask_region_area=0,
        output_mode="uncompressed_rle", use_m2m=False,
    )
    with torch.inference_mode(), inference_context(torch, device, model):
        masks = generator.generate(np.array(background.convert("RGB"), copy=True))
    synchronize(torch, device)
    # Large complete proposals precede their small fragments. This is a bounded
    # geometric heuristic, not semantic grouping or measured segmentation accuracy.
    masks.sort(key=lambda item: (-item["area"], -item["predicted_iou"]))
    output.mkdir(parents=True, exist_ok=False)
    records, dropped = [], {"small_or_empty": 0, "large_region": 0, "output_budget": 0}
    box_pixels = 0
    for item in masks:
        if item["area"] < minimum_area:
            dropped["small_or_empty"] += 1
            continue
        if item["area"] > width * height * 0.70:
            dropped["large_region"] += 1
            continue
        if len(records) >= maximum:
            dropped["output_budget"] += 1
            continue
        visible = rle_to_mask(item["segmentation"]) & alpha
        ys, xs = np.nonzero(visible)
        area = int(visible.sum())
        if area < minimum_area:
            dropped["small_or_empty"] += 1
            continue
        x, y = int(xs.min()), int(ys.min())
        mask_width, mask_height = int(xs.max()) - x + 1, int(ys.max()) - y + 1
        if box_pixels + mask_width * mask_height > width * height * 4:
            dropped["output_budget"] += 1
            continue
        box_pixels += mask_width * mask_height
        name = f"auto_{len(records) + 1:03d}"
        filename = output / (name + ".png")
        Image.fromarray(visible[y:y + mask_height, x:x + mask_width].astype(np.uint8) * 255).save(filename)
        records.append({
            "id": name, "file": filename.name, "sha256": sha(filename),
            "bbox": {"x": x, "y": y, "width": mask_width, "height": mask_height},
            "area": area, "predicted_iou": float(item["predicted_iou"]),
            "stability_score": float(item["stability_score"]), "scores_are_accuracy": False,
        })
    if sha(source) != source_hash:
        raise ValueError("Frozen overview changed during inference")
    receipt = {
        "version": 1, "operation": "map-automatic", "source_sha256": source_hash,
        "source_map_hash": job["source_map_hash"], "original_size": job["original_size"],
        "width": width, "height": height, "weights_sha256": job["weights_sha256"],
        "model_config": MODEL_CONFIG, "parameters": {**params, "crop_n_layers": 0, "max_total_bbox_pixels": width * height * 4},
        "raw_candidates": len(masks), "parts": records, "dropped": dropped,
        "seconds": time.monotonic() - start, **telemetry(torch, device, requested),
        "paid_calls": 0, "network_calls": 0, "automatic_retry": False, "verification": "unverified",
        "contour_resolution": "overview", "native_pixel_accuracy": False,
        "limitations": ["Overview masks are not native-resolution contours", "No object names or semantic grouping", "Thin details can disappear after downscaling", "Occluded pixels are not reconstructed", "Scores are not accuracy"],
    }
    temporary = output / "receipt.tmp"
    temporary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output / "receipt.json")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    args = parser.parse_args()
    print(json.dumps(automatic(json.loads(Path(args.job).read_text(encoding="utf-8"))), ensure_ascii=False))
