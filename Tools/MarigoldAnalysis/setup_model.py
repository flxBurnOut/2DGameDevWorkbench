"""Explicit model download for the optional Marigold analysis worker."""
import hashlib
import json
from pathlib import Path

from huggingface_hub import snapshot_download

MODEL = 'prs-eth/marigold-iid-lighting-v1-1'
REVISION = '08c3930bb641abf786ba44ce92547507ebefbc16'
FILES = ['model_index.json', 'README.md', 'scheduler/scheduler_config.json',
         'text_encoder/config.json', 'text_encoder/model.fp16.safetensors',
         'tokenizer/merges.txt', 'tokenizer/special_tokens_map.json',
         'tokenizer/tokenizer_config.json', 'tokenizer/vocab.json',
         'unet/config.json', 'unet/diffusion_pytorch_model.fp16.safetensors',
         'vae/config.json', 'vae/diffusion_pytorch_model.fp16.safetensors']


def main():
    runtime = Path(__file__).resolve().parents[2] / 'work' / 'intrinsic-runtime'
    model = runtime / 'model'
    snapshot_download(MODEL, revision=REVISION, local_dir=model, allow_patterns=FILES)
    hashes = {}
    for name in FILES:
        digest = hashlib.sha256()
        with (model / name).open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        hashes[name] = digest.hexdigest()
    (runtime / 'installed.json').write_text(json.dumps({'model': MODEL, 'revision': REVISION, 'files': hashes}, indent=2), encoding='utf-8')
    print(json.dumps({'model': MODEL, 'revision': REVISION, 'files': len(hashes)}))


if __name__ == '__main__':
    main()
