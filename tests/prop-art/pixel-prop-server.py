"""Isolated local prop acceptance server; provider calls are forbidden."""
from pathlib import Path
import sys
from unittest.mock import patch
import shutil
import uvicorn

repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo/'Tools/SpritePipeline'))
from sprite_pipeline.service import SpritePipelineService
from sprite_pipeline.api_app import create_api

root = Path(sys.argv[1]).resolve()
shutil.copytree(repo/'Tools/SpritePipeline/presets', root/'presets', dirs_exist_ok=True)
service = SpritePipelineService(root)
with patch('sprite_pipeline.reference_art._provider_request', side_effect=AssertionError('No paid requests in local prop acceptance')):
    uvicorn.run(create_api(service=service), host='127.0.0.1', port=int(sys.argv[2]), log_level='warning')
