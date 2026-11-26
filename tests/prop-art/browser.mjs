// Optional real-browser acceptance. All services and data use one isolated test run.
import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { loadManifest, findCapability, prepareTask, persistTask, repositoryRoot } from '../../lib/workbench/runtime.mjs';
import path from 'node:path';

const loaded = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const playwright = loaded.chromium ? loaded : loaded.default;
async function freePort() { const socket=createServer(); await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));return port; }
const [servicePort, bridgePort, webPort] = await Promise.all([freePort(),freePort(),freePort()]);
const root = path.resolve('work/test-runs',process.env.WORKBENCH_TEST_RUN,'browser'); await mkdir(root,{recursive:true});
const env = {...process.env, PYTHONUTF8:'1', SPRITE_PIPELINE_API_URL:`http://127.0.0.1:${servicePort}`,WORKBENCH_RUNTIME_PORT:String(bridgePort),WORKBENCH_RUNTIME_URL:`http://127.0.0.1:${bridgePort}`,WORKBENCH_FRONTEND_URL:`http://127.0.0.1:${webPort}`};
const children=[];
function start(cmd,args) {const child=spawn(cmd,args,{env,stdio:['ignore','pipe','pipe']}); child.log=''; for(const stream of [child.stdout,child.stderr]) stream.on('data',d=>{child.log+=d;}); children.push(child);return child;}
const python=process.env.SPRITE_TEST_PYTHON || path.resolve('Tools/SpritePipeline/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
async function ready(child,url) {for(let i=0;i<200;i++){try{if((await fetch(url)).ok)return;}catch{/*starting*/}if(child.exitCode!==null||i===199)throw new Error(child.log);await new Promise(r=>setTimeout(r,100));}}
let browser;
try {
  const manifest = await loadManifest();
  const fixture = (await prepareTask(manifest, findCapability(manifest, 'image-assets'), {operation: 'generate-prop', prompt: 'Side view battery with complete casing and terminals', name: 'Public battery', width: 1024, height: 1024}, 'running')).task;
  const image = await sharp(await readFile('Tools/PixelProp/examples/battery.png')).resize(1024,1024).png().toBuffer();
  const folder = path.resolve(manifest.workspace.outputDirectory,fixture.id); await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'image.png'), image);
  await writeFile(path.join(folder,'result.json'), JSON.stringify({image:'image.png',kind:'prop',width:1024,height:1024,hasAlpha:true,hasTransparency:true,sha256:createHash('sha256').update(image).digest('hex')}));
  fixture.status='completed';fixture.outputs=['image.png','result.json'].map(p=>path.relative(repositoryRoot,path.join(folder,p)).replaceAll('\\','/')); await persistTask(manifest,fixture);
  const service=start(python,['tests/prop-art/pixel-prop-server.py',path.join(root,'service'),String(servicePort)]);await ready(service,env.SPRITE_PIPELINE_API_URL+'/health');
  const bridge=start(process.execPath,['scripts/workbench-http.mjs']);await ready(bridge,env.WORKBENCH_RUNTIME_URL+'/health');
  const web=start(process.execPath,['node_modules/vinext/dist/cli.js','start','--hostname','127.0.0.1','--port',String(webPort)]);await ready(web,env.WORKBENCH_FRONTEND_URL+'/tools/interactable-motion');
  browser=await playwright.chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const requests=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/workbench/'))requests.push({url:r.url(),body:r.postDataJSON()});});
  await page.goto(env.WORKBENCH_FRONTEND_URL+'/tools/interactable-motion');
  await page.getByText('还没有 128 px 物品原图？在这里获取',{exact:true}).click();
  await page.getByText('导入 PNG / 从物品图转换',{exact:true}).click();
  const tools=page.locator('.prop-reference-tools');
  await tools.getByLabel('物品源图片',{exact:true}).setInputFiles('Tools/PixelProp/examples/battery.png');
  await tools.getByText('请使用 128 × 128；大图可用“从物品图转换”。',{exact:true}).waitFor();
  await tools.getByLabel('物品源图片',{exact:true}).setInputFiles('Tools/PixelProp/examples/battery-128.png');
  await tools.getByAltText('物品原图 1 倍预览').waitFor();
  await tools.getByLabel('导入物品外观说明').fill('侧视电池，关闭状态，外壳、电极和指示灯完整');
  await tools.getByRole('button',{name:'保存为导入任务',exact:true}).click();
  await tools.getByLabel('移送确认说明',{exact:true}).waitFor();
  assert.equal(await tools.getByRole('button',{name:'用作交互物动画对象',exact:true}).isEnabled(),false);
  await tools.getByLabel('移送确认说明',{exact:true}).fill('已核对侧视、关闭状态、外壳与电极完整和透明背景');
  await tools.getByRole('button',{name:'用作交互物动画对象',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('select[aria-label="交互物对象"]')?.value.startsWith('reference_'));
  const picker=page.getByLabel('交互物对象',{exact:true});
  assert.match(await picker.locator('option:checked').textContent(),/导入/);
  await picker.selectOption('');
  await page.getByText('还没有 128 px 物品原图？在这里获取',{exact:true}).click();
  await page.getByText('导入 PNG / 从物品图转换',{exact:true}).click();
  await tools.getByRole('tab',{name:'从物品图转换',exact:true}).click();
  await tools.getByLabel('物品源图片',{exact:true}).setInputFiles('Tools/PixelProp/examples/battery.png');
  await tools.getByAltText('物品原图 4 倍预览').waitFor({timeout:30000});
  assert.equal(await tools.getByAltText('物品原图 4 倍预览').evaluate(el=>el.getBoundingClientRect().width),512);
  await page.screenshot({path:path.join(root,'conversion-dialog.png'),fullPage:true});
  const before=requests.filter(r=>r.url.endsWith('/convert-prop/preview')).length;
  await tools.getByLabel('转换预设',{exact:true}).selectOption('pixel');
  await page.waitForFunction(()=>document.querySelector('.prop-reference-tools input[aria-label="转换颜色数"]')?.value==='0');
  await tools.getByRole('button',{name:'保存转换结果',exact:true}).waitFor({state:'visible'});
  await tools.getByAltText('物品原图 4 倍预览').waitFor({timeout:30000});
  assert.ok(requests.filter(r=>r.url.endsWith('/convert-prop/preview')).length>before);
  await tools.getByLabel('转换颜色数',{exact:true}).fill('12');
  await tools.getByLabel('导入物品外观说明').fill('侧视电池，完整电极与黄色指示灯');
  await tools.getByRole('button',{name:'保存转换结果',exact:true}).click({timeout:30000});
  await tools.getByLabel('移送确认说明',{exact:true}).waitFor();
  await tools.getByLabel('移送确认说明',{exact:true}).fill('已对比原图，侧视与初态一致，小部件完整且背景透明');
  await tools.getByRole('button',{name:'用作交互物动画对象',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('select[aria-label="交互物对象"]')?.value.startsWith('reference_'));
  assert.match(await picker.locator('option:checked').textContent(),/转换/);
  await page.screenshot({path:path.join(root,'motion-transferred.png'),fullPage:true});
  assert.equal(requests.filter(r=>r.body?.input?.operation==='import').length,1);
  assert.equal(requests.filter(r=>r.body?.input?.operation==='convert-prop').length,1);
  assert.equal(requests.filter(r=>r.body?.input?.operation==='generate').length,0);
  // The current GPT candidate opens the same dialog with its exact saved source.
  await page.goto(env.WORKBENCH_FRONTEND_URL+'/tools/interactable-editor?imageTask='+fixture.id);
  await page.getByRole('button',{name:'转换为 128 px 物品原图',exact:true}).click();
  const candidateTools=page.locator('.prop-tools-dialog[open]');
  await candidateTools.getByAltText('物品原图 4 倍预览').waitFor({timeout:30000});
  assert.equal(await candidateTools.getByLabel('转换源任务',{exact:true}).inputValue(),fixture.id);
  assert.match(await candidateTools.getByLabel('导入物品外观说明').inputValue(),/complete casing/);
  await candidateTools.getByLabel('预览背景',{exact:true}).selectOption('dark');
  await page.screenshot({path:path.join(root,'candidate-dialog-dark.png'),fullPage:true});
  await candidateTools.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByText('导入 PNG / 从物品图转换',{exact:true}).first().click();
  await page.setViewportSize({width:430,height:900});
  const editorTools=page.locator('.prop-tools-dialog[open]');
  await editorTools.getByLabel('物品源图片',{exact:true}).setInputFiles('Tools/PixelProp/examples/battery-128.png');
  await editorTools.getByAltText('物品原图 4 倍预览').waitFor();
  await page.screenshot({path:path.join(root,'editor-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('PASS browser import/invalid size, preview/preset/parameters, save/confirmation/transfer, source labels and 430px editor; '+root);
} catch(error) {
  if(browser) for(const context of browser.contexts())for(const page of context.pages()){await page.screenshot({path:path.join(root,'failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(-8000));}
  throw error;
} finally {
  await browser?.close();
  for(const child of children.reverse())if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
}
