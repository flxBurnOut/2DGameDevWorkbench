// Public profiles only. Credentials remain in their protected provider stores.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {motionVisionDirectory} from './motion-vision-store.mjs';
import {resolveSpritePipelineTarget} from './sprite-pipeline-supervisor.mjs';
import {modelProfileSchema} from './vision-model-contract.mjs';

async function optionalJson(filename) {
  try {return JSON.parse(await readFile(filename,'utf8'));}
  catch(error) {if(error.code==='ENOENT')return null;throw error;}
}

export async function motionVisionProfile(role) {
  const target=resolveSpritePipelineTarget();
  let profile;
  if(target.mode==='external' || process.env.SPRITE_PIPELINE_API_URL?.trim()){
    const response=await fetch(target.baseUrl.replace(/\/$/,'')+'/v1/open-motion/settings',{
      headers:process.env.SPRITE_PIPELINE_API_TOKEN?{Authorization:'Bearer '+process.env.SPRITE_PIPELINE_API_TOKEN}:{},
      signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok)throw new Error('无法读取所连接序列帧服务的视觉模型配置。');
    profile=(await response.json()).effective_roles?.[role];
    if(!profile)throw new Error('所连接服务没有返回有效的视觉模型角色。');
  }else{
    const dir=motionVisionDirectory();
    const config=await optionalJson(path.join(dir,'open_motion_models.json'));
    if(config){
      if(config.version!==1 || !config.default)throw new Error('不支持的序列帧视觉模型配置。');
      profile=config.roles?.[role] ?? config.default;
    }else{
      const legacy=process.env.SPRITE_PIPELINE_VISION_PROVIDER?.trim() ||
        (await optionalJson(path.join(dir,'motion_vision.json')))?.provider || 'hunyuan';
      if(!['hunyuan','openai'].includes(legacy))throw new Error('序列帧视觉服务配置无效。');
      profile=legacy==='hunyuan'?{provider:'tokenhub',model:'hy-vision-2.0-instruct'}:{provider:'openai',model:'gpt-5.4-2026-03-05'};
    }
  }
  if(profile.supports_images===false)throw new Error('此模型不支持图片。');
  const tokenParameter=profile.token_parameter || 'auto';
  return modelProfileSchema.parse({provider:profile.provider,model:profile.model,maxOutputTokens:profile.max_output_tokens??8000,
    timeoutSeconds:profile.timeout_seconds??180,reasoningEffort:profile.reasoning_effort??'auto',
    tokenParameter:tokenParameter==='auto'?(profile.model?.startsWith('kimi-k3')?'max_completion_tokens':'max_tokens'):tokenParameter});
}
