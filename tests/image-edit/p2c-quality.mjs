import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { imageEditRequest } from '../../lib/workbench/image-edits.mjs';
import { loadManifest } from '../../lib/workbench/runtime.mjs';
import { json, save, sha } from '../../scripts/image-edit-evaluation/core.mjs';

export async function checkP2cResume(root, fixture, batch) {
  const dir = path.join(fixture, 'p2c'),
    prior = path.join(fixture, 'frozen/cases/geometry-1');
  const { input } = await json(path.join(prior, 'intent.json'));
  const { targetId, expectedRevision, expectedSha256 } = input;
  const namespace = 'p0-' + batch.id;
  const previous = process.env.WORKBENCH_TEST_RUN;
  let edit;
  try {
    process.env.WORKBENCH_TEST_RUN = namespace;
    ({ edit } = await imageEditRequest(
      root,
      await loadManifest(),
      'image-session-create',
      {
        targetId,
        expectedRevision,
        expectedSha256,
        commandId: 'p2c-source',
      },
    ));
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_TEST_RUN;
    else process.env.WORKBENCH_TEST_RUN = previous;
  }
  const cases = ['one', 'two', 'three', 'four'].map((id) => ({ id }));
  const order = cases.flatMap(({ id }) =>
    ['rgb', 'shading'].map((arm) => ({ id, arm, ticket: id + '-' + arm })),
  );
  const protocol = {
    namespace,
    cases,
    order,
    endpoints: [batch.service.endpoint],
    model: batch.service.model,
    quality: 'medium',
    maxImages: 8,
    maxReviews: 8,
    maxUsd: 3,
    retries: 0,
    pricing: { image: batch.pricing.perMillion },
  };
  await save(path.join(dir, 'protocol.json'), protocol);
  const png = await readFile(path.join(prior, 'source.png'));
  const rows = order.map((row) => ({
    ...row,
    prompt: input.operation.prompt,
    sourceWidth: 1024,
    sourceHeight: 1024,
    sourceSha256: sha(png),
    refs: [],
    input: {
      ...input,
      editId: edit.editId,
      baseCandidateVersion: 'source',
      expectedEditRevision: edit.revision,
      commandId: 'generate-' + row.ticket,
    },
  }));
  await save(path.join(dir, 'frozen.json'), {
    rows,
    protocolSha256: sha(await readFile(path.join(dir, 'protocol.json'))),
  });
  await save(path.join(dir, 'authorization.json'), {
    frozenSha256: sha(await readFile(path.join(dir, 'frozen.json'))),
  });
  await save(path.join(dir, 'ledger.json'), { entries: [] });
  const arm = path.join(dir, 'one/rgb');
  await mkdir(arm, { recursive: true });
  await writeFile(path.join(dir, 'one/source.png'), png);
  await copyFile(
    path.join(prior, 'mask.png'),
    path.join(arm, 'expected-mask.png'),
  );

  // Replace fetch before the runner loads. A second generation or any review fails the fixture.
  const preload = path.join(dir, 'mock-provider.mjs');
  await writeFile(
    preload,
    `import {writeFile,readFile} from 'node:fs/promises';
    globalThis.fetch=async(url,{body})=>{
      if(url!==${JSON.stringify(batch.service.endpoint)} || body.get('quality')!=='medium')throw Error('Unexpected request');
      await writeFile(new URL('call.txt',import.meta.url),'mock',{flag:'wx'});
      const image=await readFile(new URL('one/source.png',import.meta.url));
      return Response.json({data:[{b64_json:image.toString('base64')}],quality:'high',
        usage:{input_tokens:2,output_tokens:3,input_tokens_details:{text_tokens:1,image_tokens:1}}});
    };`,
  );
  const env = {
    ...process.env,
    WORKBENCH_TEST_RUN: namespace,
    OPENAI_API_KEY: 'p2c-fixture-only',
    MAP_STITCHER_OPENAI_API_URL: batch.service.endpoint,
  };
  const run = () =>
    execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        'scripts/image-edit-evaluation/p2c.mjs',
        dir,
        'approved-3-usd',
      ],
      {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        windowsHide: true,
      },
    );
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(run, /Invalid quality pair/);
    const { entries } = await json(path.join(dir, 'ledger.json'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'accounted');
    assert.ok(entries[0].costUsd > 0);
    assert.equal(
      (await json(path.join(dir, 'one/invalid-pair.json'))).returnedQuality,
      'high',
    );
  }
}
