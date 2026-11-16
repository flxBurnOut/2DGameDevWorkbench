// Optional UI acceptance with an isolated native service and local image runtime.
import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,readFile} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {loadManifest} from '../../lib/workbench/runtime.mjs';
import {imageEditRequest} from '../../lib/workbench/image-edits.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve('work/test-runs',process.env.WORKBENCH_TEST_RUN,'motion-local-browser');
await mkdir(root,{recursive:true});
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const python=process.env.SPRITE_TEST_PYTHON||path.resolve('Tools/SpritePipeline/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const service=spawn(python,['Tools/SpritePipeline/tests/open_motion_server.py',root,String(port),'--checkpoints','--expert-reviews'],{stdio:['ignore','pipe','pipe']});
let log='';service.stderr.on('data',d=>log+=d);
const base='http://127.0.0.1:'+port,prev=process.env.SPRITE_PIPELINE_API_URL;process.env.SPRITE_PIPELINE_API_URL=base;
const manifest=await loadManifest(),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function req(route,body){const res=await fetch(base+'/v1/'+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const value=await res.json();assert.ok(res.ok,JSON.stringify(value));return value;}
let browser,page;
try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}if(service.exitCode!==null||i===99)throw Error(log);await delay(100);}
  let work=await req('open-motion',{spec:{character_id:'test_hero',description:'Lift glove then lower it slowly',provider:'fixture',candidate_count:1,review_protocol:'experts_v1',budget:{max_planning_calls:8,max_generation_calls:2,max_review_calls:15}},request_key:'local-browser-test',planning_authorized:true,auto_execute:false});
  for(let i=0;work.status==='planning'&&i<100;i++){await delay(100);work=await req('open-motion/'+work.id);}
  assert.equal(work.status,'ready');
  await req('open-motion/'+work.id+'/generate',{expected_revision:1,plan_sha256:work.plan_sha256});
  for(let i=0;i<100;i++){work=await req('open-motion/'+work.id);if(work.job?.candidates[0].plan_execution.stages[0].state==='awaiting_review')break;await delay(100);}
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/workbench/**',r=>r.fulfill({status:503,json:{error:'Isolated fixture'}}));
  await page.route('**/api/workbench/open-motion?**',async route=>{
    const request=route.request(),url=new URL(request.url()),dest=new URL('/v1/'+url.searchParams.get('path'),base);
    for(const name of ['candidate','revision','stage'])if(url.searchParams.has(name))dest.searchParams.set(name,url.searchParams.get(name));
    const res=await fetch(dest,{method:request.method(),headers:{'content-type':'application/json'},...(request.postData()?{body:request.postData()}:{})});
    await route.fulfill({status:res.status,contentType:res.headers.get('content-type'),body:Buffer.from(await res.arrayBuffer())});
  });
  await page.route('**/api/workbench/image-edit/*',async route=>{
    try{const op=new URL(route.request().url()).pathname.split('/').at(-1);
      await route.fulfill({json:await imageEditRequest(process.cwd(),manifest,'image-'+op,route.request().postDataJSON())});
    }catch(e){await route.fulfill({status:e.status||400,json:{error:e.message,code:e.code}});}
  });
  await page.route('**/api/workbench/artifacts?**',async route=>{
    const name=new URL(route.request().url()).searchParams.get('path'),file=path.resolve(name||'');
    const allowed=path.resolve(manifest.workspace.outputDirectory)+path.sep;
    assert.ok(file.startsWith(allowed));await route.fulfill({contentType:'image/png',body:await readFile(file)});
  });
  const web=process.env.FORGE_TEST_WEB_URL||'http://localhost:3000';
  await page.goto(web+'/tools/sprite-generator?work='+work.id);
  await page.getByRole('heading',{name:/确认第 1 段/}).waitFor();
  await page.getByLabel('当前片段逐帧查看').fill('1');
  const edit=page.getByRole('button',{name:'局部调整当前帧',exact:true});await edit.click();
  const dialog=page.getByRole('dialog',{name:'局部调整'});await dialog.getByRole('button',{name:'选整图',exact:true}).click();
  await dialog.getByLabel('原色',{exact:true}).fill('#184680');
  await dialog.getByLabel('替换色',{exact:true}).fill('#00ff00');
  await dialog.getByRole('button',{name:'精确替色',exact:true}).click();
  const save=dialog.getByRole('button',{name:/^保存为动画备选/});
  await save.click();await page.getByRole('button',{name:'同步播放完整对比',exact:true}).waitFor();
  await page.screenshot({path:path.join(root,'single-frame-alternative.png'),fullPage:true});
  await page.getByRole('button',{name:'保留原版',exact:true}).click();
  await page.getByRole('button',{name:'调整部分帧',exact:true}).click();
  await page.getByLabel('修正工具',{exact:true}).selectOption('local');
  await page.getByLabel('原色',{exact:true}).fill('#184680');
  await page.getByRole('button',{name:'选中全部可编辑帧',exact:true}).click();
  await page.getByRole('button',{name:'保存替色备选',exact:true}).click();
  await page.getByRole('button',{name:'同步播放完整对比',exact:true}).waitFor();
  await page.screenshot({path:path.join(root,'palette-alternative.png'),fullPage:true});
  await page.getByRole('button',{name:'保留原版',exact:true}).click();
  const context=await req('open-motion/'+work.id+'/adjustments?revision=1&candidate=1&stage=0');
  assert.equal(context.tasks.length,2);assert.ok(context.tasks.every(t=>t.state==='rejected'&&t.generation_calls.length===0));
  assert.ok(context.tasks.every(t=>t.spatial_protection.frames.some(f=>f.changed_inside_pixels>0)));
  assert.ok(context.tasks.every(t=>t.spatial_protection.frames.every(f=>f.protected_changed_pixels===0)));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({browser:'local-frame-edit passed',evidence:root,checks:['same-image-workspace','save-native-alternative','retained-source','multi-frame-palette','zero-generation-calls'],paidCalls:0}));
}catch(e){if(page){await page.screenshot({path:path.join(root,'failure.png'),fullPage:true});console.log('Evidence',root,(await page.locator('body').innerText()).slice(-3000));}throw e;}
finally{await browser?.close();service.kill();if(prev===undefined)delete process.env.SPRITE_PIPELINE_API_URL;else process.env.SPRITE_PIPELINE_API_URL=prev;}
