import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { loadManifest, findCapability, runConnector, prepareTask, persistTask, validateInput, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import { listAssets } from '../../lib/workbench/asset-catalog.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const listen = createServer(); await new Promise(r => listen.listen(0, '127.0.0.1', r));
const port = listen.address().port; await new Promise(r => listen.close(r));
const manifest = await loadManifest(), capability = findCapability(manifest, 'reference-art');
const root = path.join(repositoryRoot, 'work/test-runs', process.env.WORKBENCH_TEST_RUN, 'prop-service');
const python = process.env.SPRITE_TEST_PYTHON || path.resolve('Tools/SpritePipeline/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const service = spawn(python, ['tests/prop-art/pixel-prop-server.py', root, String(port)], {stdio: ['ignore','pipe','pipe'], env: {...process.env, PYTHONUTF8: '1'}});
let log = ''; service.stderr.on('data', d => {log += d;});
const old = process.env.SPRITE_PIPELINE_API_URL;
process.env.SPRITE_PIPELINE_API_URL = `http://127.0.0.1:${port}`;
const client = new Client({name: 'local-prop-acceptance', version:'1'});
const bytes = await readFile('Tools/PixelProp/examples/battery-128.png');
const readResult = async task => JSON.parse(await readFile(task.outputs.find(p => p.endsWith('/result.json')), 'utf8'));
let bridge;
try {
  for (let i=0;i<100;i++) {
    try { if ((await fetch(process.env.SPRITE_PIPELINE_API_URL+'/health')).ok) break; } catch { /* startup */ }
    if (service.exitCode !== null || i===99) throw new Error(log || 'service startup timed out');
    await new Promise(r => setTimeout(r, 100));
  }
  assert.deepEqual(validateInput(capability, {operation:'import',subject:'prop',prompt:'battery',sourceImage:'data:image/png;base64,'+bytes.toString('base64')}), []);
  for (const input of [
    {operation:'import',subject:'prop',prompt:'battery',sourceImagePath:'x',facing:'right'},
    {operation:'convert-prop',prompt:'battery',sourceImagePath:'x',recipe:{colors:1}},
    {operation:'convert-prop',prompt:'battery',sourceImagePath:'x',recipe:{palette:[42]}},
    {operation:'convert-prop',prompt:'battery',sourceImagePath:'x',recipe:{unknown:true}},
    {operation:'transfer',sourceTaskId:'x',confirmation:{note:'   '}}
  ]) assert.ok(validateInput(capability,input).length, JSON.stringify(input));
  const imported = (await runConnector(manifest, capability, {operation:'import',subject:'prop',prompt:'closed battery with complete casing',sourceImage:'data:image/png;base64,'+bytes.toString('base64')})).task;
  const result = await readResult(imported);
  assert.equal(result.subject,'prop'); assert.equal(result.provenance.providerCalled,false); assert.equal(result.provenance.diagnostics.semiTransparentPixels,0);
  await assert.rejects(runConnector(manifest,capability,{operation:'transfer',sourceTaskId:imported.id}),/确认说明/);
  const transfer = async sourceTaskId => (await runConnector(manifest, capability, {operation:'transfer',sourceTaskId,confirmation:{note:'已核对侧视、关闭状态、外壳与电极完整、背景透明'}})).task;
  const handoff = await readResult(await transfer(imported.id));
  assert.equal(handoff.objectId,(await readResult(await transfer(imported.id))).objectId);
  assert.match(handoff.href,/^\/tools\/interactable-motion\?object=/);
  assert.equal(JSON.parse(await readFile(path.join(root,'presets/objects',handoff.objectId,'provenance.json'),'utf8')).type,'import');
  const data = await readFile('Tools/PixelProp/examples/battery.png');
  // A registered completed image task, without ever invoking its adapter/provider.
  const imageCap = findCapability(manifest,'image-assets');
  const fixture = (await prepareTask(manifest,imageCap,{operation:'generate-prop',prompt:'battery'},'running')).task;
  const folder = path.resolve(manifest.workspace.outputDirectory,fixture.id); await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'image.png'),data);
  await writeFile(path.join(folder,'result.json'),JSON.stringify({kind:'prop',sha256:createHash('sha256').update(data).digest('hex'),width:512,height:512}));
  fixture.status='completed'; fixture.outputs=['image.png','result.json'].map(p=>path.relative(repositoryRoot,path.join(folder,p)).replaceAll('\\','/')); await persistTask(manifest,fixture);
  const converted = (await runConnector(manifest,capability,{operation:'convert-prop',sourceTaskId:fixture.id,prompt:'battery casing',recipe:{colors:8}})).task;
  const meta = await readResult(converted);
  assert.equal(meta.subject,'prop'); assert.equal(meta.provenance.sourceTaskId,fixture.id); assert.equal(meta.provenance.providerCalled,false);
  for(const file of ['reference.png','compare.png','recipe.json','report.json','result.json']) assert.ok(converted.outputs.some(p=>p.endsWith('/'+file)));
  await transfer(converted.id);
  const recipePath = converted.outputs.find(p=>p.endsWith('/recipe.json'));
  const recipeData = await readFile(recipePath); await writeFile(recipePath,'{}');
  await assert.rejects(transfer(converted.id),/配方|变化/); await writeFile(recipePath,recipeData);
  await writeFile(path.join(folder,'image.png'),bytes);
  await assert.rejects(transfer(converted.id),/哈希/); await writeFile(path.join(folder,'image.png'),data);
  const assets = await listAssets(manifest,{kind:'prop'});
  assert.ok(assets.assets.some(a=>a.id==='reference:'+converted.id));
  assert.ok(!((await listAssets(manifest,{kind:'character'})).assets.some(a=>a.taskId===converted.id)));
  await client.connect(new StdioClientTransport({command:process.execPath,args:['scripts/workbench-mcp.mjs'],cwd:repositoryRoot,env:{...process.env},stderr:'pipe'}));
  const called = await client.callTool({name:'workbench_run_task',arguments:{capabilityId:'reference-art',input:{operation:'convert-prop',sourceImagePath:'Tools/PixelProp/examples/battery.png',prompt:'public battery',recipe:{palette:['#192e49','#f4c358'],removeIsolated:false}}}});
  assert.ok(!called.isError,JSON.stringify(called)); assert.equal(called.structuredContent.status,'completed');
  // HTTP preview goes through the bridge, creates no workbench task and returns the same recipe/hash.
  const listener=createServer(); await new Promise(r=>listener.listen(0,'127.0.0.1',r)); const bridgePort=listener.address().port; await new Promise(r=>listener.close(r));
  bridge=spawn(process.execPath,['scripts/workbench-http.mjs'],{env:{...process.env,WORKBENCH_RUNTIME_PORT:String(bridgePort)},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('bridge timeout')),10000);bridge.stdout.on('data',d=>{if(d.toString().includes('ready at')){clearTimeout(timer);resolve();}});bridge.once('exit',()=>{clearTimeout(timer);reject(new Error('bridge exit'));});});
  const preview = await fetch(`http://127.0.0.1:${bridgePort}/v1/reference-art/convert-prop/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sourceTaskId:fixture.id,recipe:{colors:8}})});
  assert.equal(preview.status,200); assert.equal((await preview.json()).report.sha256,meta.sha256);
  const invalid=await fetch(`http://127.0.0.1:${bridgePort}/v1/reference-art/convert-prop/preview`,{method:'POST',headers:{'content-type':'application/json'},body:'{"apiKey":"must-not-be-forwarded"}'});assert.equal(invalid.status,400);
  const opaque=await sharp({create:{width:128,height:128,channels:4,background:'#ffffff'}}).png().toBuffer();
  await assert.rejects(runConnector(manifest,capability,{operation:'import',subject:'prop',sourceImage:'data:image/png;base64,'+opaque.toString('base64'),prompt:'battery'}),/透明/);
  console.log('PASS local prop import, confirmation, provenance, conversion/replay, task source hashes, palette schema, catalog, MCP and HTTP preview; paid calls forbidden');
} finally {
  await client.close();
  for (const child of [bridge, service]) if(child && child.exitCode===null) {const exited=new Promise(r=>child.once('exit',r)); child.kill(); await exited;}
  if(old===undefined) delete process.env.SPRITE_PIPELINE_API_URL; else process.env.SPRITE_PIPELINE_API_URL=old;
}
