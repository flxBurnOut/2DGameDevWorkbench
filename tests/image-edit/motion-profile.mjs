import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {motionVisionProfile} from '../../lib/workbench/motion-vision-profile.mjs';
import {motionVisionCredential,motionVisionDirectory} from '../../lib/workbench/motion-vision-store.mjs';

const dir=motionVisionDirectory();
assert.ok(dir.includes(process.env.WORKBENCH_TEST_RUN),'isolated test configuration');
await mkdir(dir,{recursive:true});
const base={provider:'tokenhub',model:'hy-vision-2.0-instruct',max_output_tokens:8000,timeout_seconds:180,token_parameter:'auto',reasoning_effort:'auto',supports_images:true};
await writeFile(path.join(dir,'open_motion_models.json'),JSON.stringify({version:1,default:base,roles:{appearance:{...base,model:'kimi-k3.1-pro',reasoning_effort:'max'},reviewer:{...base,provider:'openai',model:'fixture-vision',max_output_tokens:2048}}}));
assert.equal((await motionVisionProfile('appearance')).tokenParameter,'max_completion_tokens');
assert.equal((await motionVisionProfile('appearance')).reasoningEffort,'max');
assert.equal((await motionVisionProfile('reviewer')).model,'fixture-vision');
assert.equal((await motionVisionProfile('motion')).model,base.model);
await writeFile(path.join(dir,'credentials.json'),'{}');
let calls=0;
assert.equal(motionVisionCredential('openai',(_exe,args,opts)=>{
  calls++;assert.equal(args.at(-1),'motion_vision_api_key');assert.equal(args.at(-2),dir);
  assert.ok(!JSON.stringify(args).includes('fixture-secret'));assert.ok(!Object.hasOwn(opts,'shell'));
  return {status:0,stdout:'fixture-secret'};
}),'fixture-secret');
assert.equal(calls,1);
await rm(path.join(dir,'credentials.json'));
const old=globalThis.fetch,endpoint=process.env.SPRITE_PIPELINE_API_URL;
process.env.SPRITE_PIPELINE_API_URL='http://127.0.0.1:9898';
globalThis.fetch=async url=>{assert.equal(url,'http://127.0.0.1:9898/v1/open-motion/settings');return Response.json({effective_roles:{appearance:{...base,model:'remote-profile'}}});};
try{assert.equal((await motionVisionProfile('appearance')).model,'remote-profile');}
finally{globalThis.fetch=old;if(endpoint===undefined)delete process.env.SPRITE_PIPELINE_API_URL;else process.env.SPRITE_PIPELINE_API_URL=endpoint;}
console.log('Shared motion models: role overrides, wire conversion, protected credential bridge and connected service profile verified.');
