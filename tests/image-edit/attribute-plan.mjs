import '../helpers/runtime-workspace.mjs';
import {verifyCandidateCritic} from './candidate-critic.mjs';
import {verifySoftReferences} from './soft-reference.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {planScope,attributeDefaults} from '../../features/image-edit/attribute-plan.mjs';
import {recolorSimple} from '../../features/image-edit/color-map.mjs';
import {createProject,createObject} from '../../features/interactable-editor/contract.mjs';
import {createDocument} from '../../lib/workbench/editor-documents.mjs';
import {imageEditRequest} from '../../lib/workbench/image-edits.mjs';
import {loadManifest,repositoryRoot} from '../../lib/workbench/runtime.mjs';

let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},reject=async(p,c)=>{await assert.rejects(p,e=>e.code===c);checks++;};
const sha=b=>createHash('sha256').update(b).digest('hex'),rect=(x,y,width,height)=>({type:'rectangle',x,y,width,height});
const px=new Uint8Array([153,76,51,255,17,29,31,0,153,76,51,1,153,76,51,255]);
const scope=planScope(px,4,1,new Uint8Array([1,1,1,0]),rect(0,0,2,1),rect(2,0,1,1),[rect(1,0,1,1)]);
eq([...scope.mask],[1,0,1,0]);
const fragmented=Uint8Array.from({length:512*512},(_,i)=>i%2);
const exact=planScope(new Uint8Array(fragmented.length*4),512,512,fragmented);
eq(exact.mask,fragmented);eq(exact.count,131072);eq(exact.spec,undefined);
for(const [source,from,to,expected] of [
  [[255,0,0,255],'#ff0000','#0000ff',[0,0,255,255]],
  [[1,3,255,1],'#0103ff','#01037f',[1,3,127,1]],
  [[0,0,0,255],'#000000','#112233',[17,34,51,255]],
])eq([...recolorSimple(Uint8Array.from(source),[1],from,to).pixels],expected);
eq(recolorSimple(px,scope.mask,'#994c33','#334c99','luminance').pixels.slice(0,4),new Uint8Array([51,76,153,255]));
eq(recolorSimple(px,scope.mask,'#994c33','#994c33','luminance').pixels,px);
assert.throws(()=>recolorSimple(px,scope.mask,'#000000','#112233','luminance'),{code:'INVALID_IMAGE_EDIT'});
const manifest=await loadManifest(),root=repositoryRoot,storage=path.resolve(root,manifest.workspace.imageEditDirectory);
assert(storage.includes('/test-runs/')||storage.includes('\\test-runs\\'));
const request=(op,input)=>imageEditRequest(root,manifest,op,input);
const pixels=Buffer.alloc(1024*1024*4);for(let i=0;i<pixels.length;i+=4)pixels.set([153,76,51,255],i);
pixels.set([33,17,91,1],(1024*211+313)*4);
const png=await sharp(pixels,{raw:{width:1024,height:1024,channels:4}}).png().toBuffer();
const project=createProject(),obj=createObject('inspect');obj.definitionId='sample';obj.visual.assetId='source';project.objects=[obj];project.assets=[{id:'source',name:'source.png',mime:'image/png',source:`data:image/png;base64,${png.toString('base64')}`}];
const {document}=await createDocument(root,manifest,{kind:'interactable',documentId:project.projectId,commandId:'create',content:project});
const {target}=await request('image-inspect',{target:{kind:'interactable',documentId:document.id,definitionId:'sample',slot:'visual'}});
const guards={targetId:target.targetId,expectedRevision:target.revision,expectedSha256:target.sha256};
let {edit}=await request('image-session-create',{...guards,commandId:'session'});
const region=await request('image-resolve',{...guards,region:rect(300,200,100,80)});
const original={type:'color-map',from:'#994c33',to:'#334c99'},constraints={preserveOutsideRegion:true,preserveDimensions:true,preserveAlpha:true};
const prepareInput={...guards,editId:edit.editId,expectedEditRevision:edit.revision,baseCandidateVersion:'source',regionRef:region.regionRef,commandId:'plan-local',part:'left board',policy:attributeDefaults.recolor,successCriteria:['blue, original grain retained'],targetRegion:rect(310,210,60,40),protectedRegions:[rect(320,220,5,5)],operation:original,constraints};
const {plan}=await request('image-plan-prepare',prepareInput);eq(plan.scope.count,2375);eq(plan.maxImageCalls,0);
eq((await request('image-plan-prepare',prepareInput)).replayed,true);
// Crash after plan persistence but before command acknowledgement recovers that plan.
const planCommandFile=path.join(storage,'commands',sha(prepareInput.commandId)+'.json');
const planCommand=JSON.parse(await readFile(planCommandFile,'utf8'));delete planCommand.result;await writeFile(planCommandFile,JSON.stringify(planCommand));
eq((await request('image-plan-prepare',prepareInput)).plan.planRef,plan.planRef);
const reference=path.join(storage,'retry-reference.png');
const retryPlan={...prepareInput,commandId:'retry-prepare',operation:{type:'ai-edit',prompt:'Adjust the board',references:[reference]}};
await assert.rejects(request('image-plan-prepare',retryPlan));
await writeFile(reference,png);
eq((await request('image-plan-prepare',retryPlan)).plan.referenceManifest[0].sha256,sha(png));
const named=await request('image-resolve',{...guards,region:rect(310,210,60,40),saveAs:'board',commandId:'named-board'});
const namedPlan=await request('image-plan-prepare',{...prepareInput,commandId:'named-plan',targetRegion:{type:'named',regionId:named.regionId}});
eq(namedPlan.plan.scope.count,2375);
await assert.rejects(request('image-plan-prepare',{...prepareInput,commandId:'alpha-conflict',changesSilhouette:true}));checks++;
const input={...guards,editId:edit.editId,expectedEditRevision:edit.revision,baseCandidateVersion:'source',regionRef:region.regionRef,operation:original,constraints,planRef:plan.planRef,commandId:'execute-local'};
await reject(request('image-edit',{...input,commandId:'bad-policy',operation:{...original,to:'#ffffff'}}),'IMAGE_PLAN_CONFLICT');
async function completed(result){for(let i=0;i<300;i++){const value=await request('image-session-get',{editId:result.edit.editId});const candidate=value.edit.candidates.find(c=>c.version===result.candidateVersion);if(!['preparing','running'].includes(candidate.status)){eq(candidate.status,'completed');return {edit:value.edit,candidate};}await new Promise(r=>setTimeout(r,10));}throw new Error('Timeout');}
const local=await completed(await request('image-edit',input));eq(local.candidate.diff.changedOutsideRegion,0);eq(local.candidate.diff.alphaChangedPixelCount,0);
eq((await request('image-edit',input)).candidateVersion,local.candidate.version);
await reject(request('image-edit',{...input,commandId:'reuse-plan',expectedEditRevision:local.edit.revision}),'IMAGE_PLAN_CONFLICT');
const image=(await request('image-session-get',{editId:edit.editId,candidateVersion:local.candidate.version,includePixels:true})).edit.pixels;
const bytes=Buffer.from(image.rgbaBase64,'base64');eq([...bytes.subarray((220*1024+320)*4,(220*1024+320)*4+4)],[153,76,51,255]);
eq(bytes[(211*1024+313)*4+3],1);
// A second edit sees changed colors, but the named protection still covers the source board.
const sourceBoard=await request('image-resolve',{...guards,region:{type:'connected-color',x:0,y:0},saveAs:'source-board',commandId:'name-source-board'});
const protectedPlan=await request('image-plan-prepare',{...prepareInput,expectedEditRevision:local.edit.revision,
  baseCandidateVersion:local.candidate.version,protectedRegions:[{type:'named',regionId:sourceBoard.regionId}],commandId:'protect-original-board'});
eq(protectedPlan.plan.scope.spec.spans,[{startPixel:211*1024+313,length:1}]);

// Actual adapter submission, with every network call intercepted.
process.env.OPENAI_API_KEY='attribute-plan-fixture';process.env.MAP_STITCHER_OPENAI_API_URL='http://127.0.0.1:9012/v1/images/edits';
const rawPixels=Buffer.from(pixels),repairIndex=(201*1024+301)*4;
rawPixels.set([32,135,240,118],repairIndex);
const returnedPng=await sharp(rawPixels,{raw:{width:1024,height:1024,channels:4}}).png().toBuffer();
let calls=0,wire;const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{assert.equal(url,process.env.MAP_STITCHER_OPENAI_API_URL);calls++;const form=options.body;wire={prompt:form.get('prompt'),images:await Promise.all(form.getAll('image[]').map(async b=>Buffer.from(await b.arrayBuffer()))),mask:Buffer.from(await form.get('mask').arrayBuffer())};return Response.json({data:[{b64_json:returnedPng.toString('base64')}],usage:{input_tokens:1,output_tokens:1}});};
try{
  edit=local.edit;const operation={type:'ai-edit',prompt:'Replace the lower medallion with a blue gem.'};
  const {plan:ai}=await request('image-plan-prepare',{...prepareInput,expectedEditRevision:edit.revision,commandId:'plan-ai',operation,policy:attributeDefaults.part});
  eq(calls,0);eq(ai.crop.x,286);eq(ai.crop.y,186);
  const result=await completed(await request('image-edit',{...input,expectedEditRevision:edit.revision,operation,planRef:ai.planRef,commandId:'execute-ai'}));
  eq(calls,1);eq(wire.images.length,2);eq(sha(wire.images[0]),sha(png));assert(wire.prompt.includes('left board')&&wire.prompt.includes('MAY RECOMPUTE'));checks++;
  const crop=await sharp(wire.images[1]).metadata();eq([crop.width,crop.height],[108,88]);
  eq(result.candidate.attributePlan.planRef,ai.planRef);
  await verifyCandidateCritic(request,edit.editId,result.candidate,storage);
  const review=await request('image-review-record',{editId:edit.editId,candidateVersion:result.candidate.version,expectedCandidateSha256:result.candidate.sha256,commandId:'review',reviewer:'fixture agent',reviewerType:'agent',targetAchieved:false,preservedContent:true,boundaryAndAlpha:true,defects:[{x:310,y:210,description:'No gem'}]});eq(review.review.verdict,'fail');eq(review.review.independent,false);
  await reject(request('image-review-record',{editId:edit.editId,candidateVersion:result.candidate.version,expectedCandidateSha256:'a'.repeat(64),commandId:'wrong-review',reviewer:'fixture',reviewerType:'human',targetAchieved:true,preservedContent:true,boundaryAndAlpha:true,defects:[]}),'IMAGE_REVIEW_CONFLICT');
  const rawHash=result.candidate.evidence.rawSha256;
  eq(rawHash,sha(returnedPng));eq(result.candidate.diff.changedPixelCount,0);
  const op={type:'recompose-ai',candidateVersion:result.candidate.version,rawSha256:rawHash};
  const correction=(await request('image-resolve',{...guards,region:rect(301,201,1,1)})).regionRef;
  const corrected={...input,planRef:undefined,expectedEditRevision:result.edit.revision,regionRef:correction,operation:op,commandId:'recompose'};
  await reject(request('image-edit',{...corrected,commandId:'bad-raw',operation:{...op,rawSha256:'a'.repeat(64)}}),'RECOMPOSE_SOURCE_CONFLICT');
  const outside=(await request('image-resolve',{...guards,region:rect(0,0,1,1)})).regionRef;
  await reject(request('image-edit',{...corrected,commandId:'outside-original-authority',regionRef:outside}),'RECOMPOSE_SCOPE_CONFLICT');
  await reject(request('image-edit',{...corrected,commandId:'wrong-repair-base',baseCandidateVersion:local.candidate.version}),'RECOMPOSE_SOURCE_CONFLICT');
  const repair=await completed(await request('image-edit',corrected));
  eq((await request('image-edit',corrected)).candidateVersion,repair.candidate.version);
  eq(repair.candidate.diff.changedPixelCount,1);eq(repair.candidate.diff.changedOutsideRegion,0);eq(repair.candidate.diff.alphaChangedPixelCount,0);eq(calls,1);
  const repaired=(await request('image-session-get',{editId:edit.editId,candidateVersion:repair.candidate.version,includePixels:true})).edit.pixels;
  eq([...Buffer.from(repaired.rgbaBase64,'base64').subarray(repairIndex,repairIndex+4)],[32,135,240,255]);
  edit=repair.edit;
}finally{globalThis.fetch=nativeFetch;}

// Luminance mapping keeps the same authorization and Alpha guarantees as RGB mapping.
const luminance=await completed(await request('image-edit',{...input,planRef:undefined,expectedEditRevision:edit.revision,commandId:'luminance-candidate',operation:{...original,mapping:'luminance'}}));
eq(luminance.candidate.recolorEvidence.route,'simple-luminance-control');
eq(luminance.candidate.diff.alphaChangedPixelCount,0);eq(luminance.candidate.diff.changedOutsideRegion,0);
await verifySoftReferences({request,prepareInput,input,edit:luminance.edit,png,completed});
console.log(JSON.stringify({attributePlan:'passed',checks,mockedImageCalls:calls,realPaidCalls:0,namespace:process.env.WORKBENCH_TEST_RUN}));
