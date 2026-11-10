import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export async function verifyCandidateCritic(request, editId, candidate, directory) {
  const originalFetch=globalThis.fetch,originalEndpoint=process.env.SCENE_EXPERT_OPENAI_URL;
  const originalKey=process.env.OPENAI_API_KEY;
  process.env.SCENE_EXPERT_OPENAI_URL='http://127.0.0.1:9082/v1/responses';
  let calls=0,mode='fail',prepared;
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  const base={editId,candidateVersion:candidate.version,expectedCandidateSha256:candidate.sha256,previewWidth:160};
  globalThis.fetch=async(url,opts)=>{
    assert.equal(url,process.env.SCENE_EXPERT_OPENAI_URL);calls++;
    const body=JSON.parse(opts.body),content=body.input[0].content;
    assert.equal(body.store,false);
    assert.deepEqual(content.filter(x=>x.type==='input_image').map(x=>sha(Buffer.from(x.image_url.split(',')[1],'base64'))),prepared.views.map(x=>x.sha256));
    assert.ok(!opts.body.includes(editId) && !opts.body.includes(candidate.version));
    if(prepared.phase==='review'){
      for(const forbidden of ['left board','MAY RECOMPUTE','effective-mask','raw-overview','fixture agent'])assert.ok(!opts.body.includes(forbidden),forbidden);
    }
    if(mode==='disconnect')throw new Error('Fixture disconnect');
    const output=prepared.phase==='diagnosis'?{targetInRaw:'pass',lostDuringComposite:'yes',insideOriginalAuthority:'yes',explanation:'Gem is clipped',nextStep:'Correct the mask'}
      :{target:mode==='pass'?'pass':'fail',preservation:'pass',boundary:'pass',placement:'pass',summary:'fixture',
        defects:mode==='pass'?[]:[{x:mode==='bad-point'?9000:301,y:201,severity:'major',description:'Gem absent'}]};
    return Response.json({id:'response-fixture',status:'completed',model:body.model,usage:{input_tokens:100,output_tokens:30},
      output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]});
  };
  try{
    const prep=async(extra,id)=>(await request('image-critic-prepare',{...base,...extra,commandId:id})).check;
    const run=(rec,id)=>request('image-critic-run',{reviewRef:rec.reviewRef,commandId:id});
    await assert.rejects(prep({expectedCandidateSha256:'0'.repeat(64)},'wrong-check'),{code:'IMAGE_REVIEW_CONFLICT'});
    delete process.env.OPENAI_API_KEY;
    prepared=await prep({},'check');assert.equal(prepared.service.configured,false);
    const frozenViews=prepared.views.map(v=>v.sha256);
    process.env.OPENAI_API_KEY='mock-critic-fixture';
    const available=(await request('image-critic-get',{reviewRef:prepared.reviewRef})).check;
    assert.equal(available.service.configured,true);assert.deepEqual(available.views.map(v=>v.sha256),frozenViews);
    assert.equal((await prep({},'check')).service.configured,true);
    assert.equal(calls,0);assert.equal(prepared.instruction,'Replace the lower medallion with a blue gem.');
    assert.equal(prepared.views.length,6);assert.equal((await prep({},'same-check')).reviewRef,prepared.reviewRef);
    const sessionFile=path.join(directory,'sessions',sha(editId)+'.json'),sessionBytes=await readFile(sessionFile);
    const historical=JSON.parse(sessionBytes);historical.target.revision++;
    await writeFile(sessionFile,JSON.stringify(historical));
    try{
      await assert.rejects(prep({instruction:'stale source'},'stale-prepare'),{code:'IMAGE_SOURCE_CONFLICT'});
      await assert.rejects(run(prepared,'run-check'),{code:'IMAGE_SOURCE_CONFLICT'});
      assert.equal((await request('image-critic-get',{reviewRef:prepared.reviewRef})).check.status,'prepared');
      assert.equal(calls,0);
    }finally{await writeFile(sessionFile,sessionBytes);}
    const [a,b]=await Promise.all([run(prepared,'run-check'),run(prepared,'run-check')]);
    assert.equal(calls,1);assert.equal(a.check.result.verdict,'fail');assert.equal(b.replayed,true);
    await assert.rejects(run(prepared,'another-run'),{code:'CRITIC_ALREADY_REQUESTED'});
    prepared=await prep({parentReviewRef:prepared.reviewRef},'check-diagnose');assert.equal(prepared.views.length,10);
    assert.equal(prepared.excludedVisibleChanges,1);assert.equal((await run(prepared,'run-diagnosis')).check.result.action,'recompose');
    mode='pass';prepared=await prep({instruction:'Other brief'},'different-brief');
    assert.equal((await run(prepared,'pass-check')).check.result.verdict,'pass');
    await assert.rejects(prep({parentReviewRef:prepared.reviewRef},'reject-pass-diagnosis'),{code:'CRITIC_PHASE_CONFLICT'});
    mode='bad-point';prepared=await prep({instruction:'Verify evidence'},'bad-location');assert.equal((await run(prepared,'run-location')).check.result.verdict,'uncertain');
    mode='disconnect';prepared=await prep({instruction:'Interrupted fixture'},'interrupted');assert.equal((await run(prepared,'unknown')).check.status,'attention_required');
    const before=calls;await run(prepared,'unknown');assert.equal(calls,before);
    const file=path.join(directory,'visual-checks',sha(prepared.reviewRef)+'.json'),record=JSON.parse(await readFile(file));
    record.status='requesting';await writeFile(file,JSON.stringify(record));
    assert.equal((await request('image-critic-get',{reviewRef:prepared.reviewRef})).check.status,'attention_required');assert.equal(calls,before);
    console.log('Candidate critic passed: blinded evidence and instruction, phase isolation, pixel-bound repair, immutable verdict, once-only dispatch, stale hash, abstention and interruption recovery.');
  }finally{
    globalThis.fetch=originalFetch;
    if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;
    if(originalEndpoint===undefined)delete process.env.SCENE_EXPERT_OPENAI_URL;else process.env.SCENE_EXPERT_OPENAI_URL=originalEndpoint;
  }
}
