import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const run=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
let running=false;
export async function checkIntrinsicRuntime(root) {
  const runtime=path.join(root,'work/intrinsic-runtime');
  const python=path.join(runtime,'venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),model=path.join(runtime,'model');
  try { await Promise.all([access(python),access(path.join(runtime,'installed.json'))]); }
  catch { throw Object.assign(new Error('分层运行环境尚未安装。请按本地分层指南安装；不会自动下载或上传素材。'),{code:'INTRINSIC_UNAVAILABLE',status:422}); }
  return {python,model};
}
export async function intrinsicProfileKey(root) {
  const {model}=await checkIntrinsicRuntime(root);
  const files=[path.join(model,'..','installed.json'),path.join(root,'Tools/MarigoldAnalysis/worker.py'),path.join(root,'Tools/MarigoldAnalysis/requirements.txt')];
  return hash((await Promise.all(files.map(async file=>hash(await readFile(file))))).join(':'));
}
export async function runIntrinsicAnalysis(root,directory,source,sourceSha256) {
  if(running)throw Object.assign(new Error('本地分层分析正忙，请等待当前任务结束。'),{code:'INTRINSIC_BUSY',status:409});
  running=true;
  try {
    const {python,model}=await checkIntrinsicRuntime(root);
    await mkdir(directory,{recursive:true});
    const job=path.join(directory,'job.json');
    await writeFile(job,JSON.stringify({source,sourceSha256,output:directory,model}));
    await run(python,[path.join(root,'Tools/MarigoldAnalysis/worker.py'),'--job',job],{windowsHide:true,timeout:900000,maxBuffer:1024*1024});
    const receipt=JSON.parse(await readFile(path.join(directory,'receipt.json'),'utf8'));
    if(receipt.sourceSha256!==sourceSha256)throw new Error('分层回执与原图不符。');
    return receipt;
  }finally{running=false;}
}
export async function loadIntrinsicLayers(directory,receipt) {
  const layers={};
  for(const name of ['albedo','shading','residual','uncertainty']){
    const data=await readFile(path.join(directory,`${name}.f32`));
    if(hash(data)!==receipt.files[name].sha256||data.length!==receipt.width*receipt.height*12)throw new Error('分层数据已变或尺寸不符。');
    const array=new Float32Array(receipt.width*receipt.height*3);
    for(let i=0;i<array.length;i++){array[i]=data.readFloatLE(i*4);if(!Number.isFinite(array[i])||array[i]<0)throw new Error('分层数据无效。');}
    layers[name]=array;
  }
  if (receipt.disagreementOrigin) {
    const {sha256,labels} = receipt.disagreementOrigin;
    const indices = await readFile(path.join(directory,'disagreement-origin.u8'));
    if (hash(indices)!==sha256 || indices.length!==receipt.width*receipt.height ||
        !Array.isArray(labels) || !labels.length || indices.some(index=>index>=labels.length))
      throw new Error('分歧来源记录已变或尺寸不符。');
    layers.origin={indices,labels};
  }
  return layers;
}
