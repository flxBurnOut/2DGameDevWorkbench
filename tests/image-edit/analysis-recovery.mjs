import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {createObject, createProject} from '../../features/interactable-editor/contract.mjs';
import {createDocument} from '../../lib/workbench/editor-documents.mjs';
import {intrinsicProfileKey} from '../../lib/workbench/image-edit-intrinsics.mjs';
import {imageEditRequest} from '../../lib/workbench/image-edits.mjs';
import {atomic, hash, recordFile, saveSession, session} from '../../lib/workbench/image-edit-store.mjs';
import {loadManifest, repositoryRoot} from '../../lib/workbench/runtime.mjs';

const runs=path.join(repositoryRoot,'work','test-runs');
await mkdir(runs,{recursive:true});
const root=await mkdtemp(path.join(runs,'analysis-retry-')),manifest=await loadManifest();
const directory=path.join(root,manifest.workspace.imageEditDirectory);
const request=(op,input)=>imageEditRequest(root,manifest,op,input);
const source=await sharp({create:{width:1,height:1,channels:4,background:'#663311'}}).png().toBuffer();
const project=createProject(),obj=createObject('inspect');
obj.visual.assetId='sample';project.objects=[obj];
project.assets=[{id:'sample',name:'sample.png',mime:'image/png',source:'data:image/png;base64,'+source.toString('base64')}];
const {document}=await createDocument(root,manifest,{kind:'interactable',commandId:'create',content:project});
const {target}=await request('image-inspect',{target:{kind:'interactable',documentId:document.id,definitionId:obj.definitionId,slot:'visual'}});
const guards={targetId:target.targetId,expectedRevision:target.revision,expectedSha256:target.sha256};
const {edit}=await request('image-session-create',{...guards,commandId:'session'});
const input={...guards,editId:edit.editId,expectedEditRevision:edit.revision,baseCandidateVersion:'source',commandId:'retry-analysis'};
for(let attempt=0;attempt<2;attempt++)await assert.rejects(request('image-analysis-create',input),{code:'INTRINSIC_UNAVAILABLE'});

// Supply the runtime identity and a completed cache entry. The placeholder interpreter must never run.
for(const file of ['work/intrinsic-runtime/installed.json',
  'work/intrinsic-runtime/venv/'+(process.platform==='win32'?'Scripts/python.exe':'bin/python'),
  'Tools/MarigoldAnalysis/worker.py','Tools/MarigoldAnalysis/requirements.txt']){
  const dest=path.join(root,file);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,'fixture');
}
const profileKey=await intrinsicProfileKey(root),analysisId='cached-analysis';
const output=path.join(directory,'analysis-data',hash(analysisId)),files={};
await mkdir(output,{recursive:true});
for(const name of ['albedo','shading','residual','uncertainty']){
  const data=Buffer.alloc(12);await writeFile(path.join(output,name+'.f32'),data);files[name]={sha256:hash(data)};
}
const saved=await session(root,directory,edit.editId);
const entry={analysisId,baseCandidateVersion:'source',baseSha256:saved.source.sha256,profileKey};
await atomic(root,recordFile(directory,'analyses',analysisId),{...entry,editId:edit.editId,status:'completed',
  baseRgbaSha256:saved.source.rgbaSha256,width:1,height:1,receipt:{width:1,height:1,files}});
saved.analyses=[entry];await saveSession(root,directory,saved);
for(let attempt=0;attempt<2;attempt++){
  const recovered=await request('image-analysis-create',input);
  assert.equal(recovered.cacheHit,true);assert.equal(recovered.analysis.analysisId,analysisId);
}
console.log('Analysis recovery passed: the original command survived missing runtime and recovered the installed profile cache.');
