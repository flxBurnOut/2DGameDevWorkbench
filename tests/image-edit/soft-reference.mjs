import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function verifySoftReferences({request,prepareInput,input,edit,png,completed}) {
  const userRef='data:image/png;base64,'+png.toString('base64');
  const operation={type:'ai-edit',prompt:'Add a fine scratch to the selected board.',references:[userRef]};
  const common={...prepareInput,expectedEditRevision:edit.revision,operation,localContext:true};
  const softReference={kind:'rgb'};
  const prepare=(kind,extra,id)=>request('image-plan-prepare',{...common,softReference:kind,...extra,commandId:id});
  await assert.rejects(prepare(softReference,{localContext:false},'soft-no-context'),{code:'IMAGE_SOFT_REFERENCE_CONFLICT'});
  await assert.rejects(prepare(softReference,{operation:{...operation,references:Array(7).fill(userRef)}},'soft-full'),{code:'IMAGE_SOFT_REFERENCE_CONFLICT'});
  await assert.rejects(prepare(softReference,{operation:{type:'color-map',from:'#112233',to:'#334455'}},'soft-local'),{code:'IMAGE_SOFT_REFERENCE_CONFLICT'});
  const {plan:b}=await prepare({kind:'rgb'},{},'soft-b');
  const {plan:c}=await prepare(softReference,{},'soft-c');
  assert.deepEqual(b.referenceManifest.map(r=>r.role),['user-reference','rgb-control','clean-crop']);
  assert.deepEqual(c.referenceManifest.map(r=>r.role),['user-reference','rgb-control','clean-crop']);
  assert.equal(b.compiledOperation.prompt,c.compiledOperation.prompt);
  assert.deepEqual(b.crop,c.crop);assert.equal(b.scope.mask.sha256,c.scope.mask.sha256);
  assert.equal(b.referenceManifest[1].sha256,b.referenceManifest[2].sha256);
  assert.equal(c.referenceManifest[1].sha256,c.referenceManifest[2].sha256);
  assert.equal(c.referenceManifest[2].sha256,b.referenceManifest[2].sha256);
  const [control,clean]=await Promise.all(c.compiledOperation.references.slice(1).map(async f=>sharp(await readFile(f)).ensureAlpha().raw().toBuffer()));
  for(let i=3;i<clean.length;i+=4)assert.equal(control[i],clean[i]);
  assert.ok(clean.some((v,i)=>i%4===3&&v===1));
  assert.deepEqual(control,clean);
  const submit={...input,expectedEditRevision:edit.revision,planRef:c.planRef,operation,commandId:'soft-send'};
  const path=c.compiledOperation.references[1],saved=await readFile(path);
  await writeFile(path,png);
  try{
    await assert.rejects(request('image-edit',submit),{code:'IMAGE_PLAN_REFERENCE_CONFLICT'});
    await assert.rejects(request('image-edit',{...submit,commandId:'soft-drift-second'}),{code:'IMAGE_PLAN_REFERENCE_CONFLICT'});
    assert.equal((await request('image-plan-get',{planRef:c.planRef})).plan.consumedCommandId,undefined);
  }finally{await writeFile(path,saved);}
  const native=globalThis.fetch;let calls=0;
  try{
    globalThis.fetch=async(url,opts)=>{
      assert.equal(url,process.env.MAP_STITCHER_OPENAI_API_URL);calls++;
      const packet=await Promise.all(opts.body.getAll('image[]').map(async f=>sha(Buffer.from(await f.arrayBuffer()))));
      assert.deepEqual(packet,[sha(png),...c.referenceManifest.map(v=>v.sha256)]);
      return Response.json({data:[{b64_json:png.toString('base64')}],usage:{input_tokens:1,output_tokens:1}});
    };
    const {candidate}=await completed(await request('image-edit',submit));
    assert.deepEqual(candidate.attributePlan.referenceManifest,c.referenceManifest);
    assert.equal((await request('image-plan-get',{planRef:c.planRef})).plan.consumedCommandId,submit.commandId);
    assert.equal((await request('image-edit',submit)).candidateVersion,candidate.version);
    assert.equal(calls,1);
  }finally{globalThis.fetch=native;}
  console.log('RGB soft references: deterministic prompt, mask and clean crop; ordered wire references, partial alpha, slot limit, tamper detection and paid-command replay passed.');
}
