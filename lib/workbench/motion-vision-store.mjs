import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {imageSettingsPath} from './image-settings-store.mjs';

export function motionVisionDirectory() {
  const work=path.dirname(path.dirname(imageSettingsPath()));
  return process.env.SPRITE_PIPELINE_HOME || path.join(process.env.SPRITE_PIPELINE_DATA_DIR || path.join(work,'sprite-pipeline'),'config');
}

// Reuse Python's protected credential codec, including Windows DPAPI and macOS
// Keychain. Secrets cross only the child stdout pipe, never argv, files or logs.
export function motionVisionCredential(provider,run=spawnSync) {
  const dir=motionVisionDirectory();
  if(!existsSync(path.join(dir,'credentials.json')))return '';
  if(!['openai','tokenhub'].includes(provider))throw new Error('未知的视觉服务。');
  const root=fileURLToPath(new URL('../../Tools/SpritePipeline/',import.meta.url));
  const executable=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const script="import sys; from pathlib import Path; from sprite_pipeline.credential_store import CredentialStore; sys.stdout.write(CredentialStore(Path(sys.argv[1])).get(sys.argv[2]) or '')";
  const result=run(executable,['-c',script,dir,provider==='openai'?'motion_vision_api_key':'motion_hunyuan_api_key'],
    {cwd:root,encoding:'utf8',timeout:10000,maxBuffer:8192,windowsHide:true});
  if(result.error||result.status!==0)throw new Error('无法解锁序列帧视觉服务的本机凭据。');
  return result.stdout.trim();
}
