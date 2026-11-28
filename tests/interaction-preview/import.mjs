import assert from 'node:assert/strict';
import {createObject} from '../../features/interactable-editor/contract.mjs';
import {initialState,committedState,stateAppearance} from '../../features/interactable-editor/simulator.mjs';
import {importedStates} from '../../features/interaction-preview/import-model.mjs';
import {objectWorldPoint,objectLocalPoint,evaluateInteraction,previewBounds} from '../../features/interaction-preview/model.mjs';

function sceneAppearance(object,state){
  const appearance=stateAppearance(object,state);
  const visible=(appearance.visible ?? object.visual.visible) && !(state.completed && object.completion!=='remain');
  return {appearance,visible};
}
for(const kind of ['toggle','sequence','pickup','inspect']){
  const object=createObject(kind);object.visual.assetId='base';object.visual.tint='#aabbcc';
  object.visual.visible=true;
  if(kind==='sequence'){
    object.behavior.entries=[{name:'变色',pages:[],feedback:[],appearance:{assetId:'base',animation:'',visible:true,solidEnabled:false,tint:'#ffe9a8'}}];
    object.behavior.onEnd='stay_last';
  }
  const imported=importedStates(object),initial=initialState(object),next=committedState(object,initial);
  const initialEntry=imported.entries.find(e=>e.id===imported.initial);
  const expectedInitial=sceneAppearance(object,initial);
  assert.equal(initialEntry.visible,expectedInitial.visible);
  assert.equal(initialEntry.tint,expectedInitial.appearance.tint||object.visual.tint);
  if(imported.entries.length>1){
    const after=imported.entries[1],expected=sceneAppearance(object,next);
    assert.equal(after.visible,expected.visible,kind+' completion visibility must match the source editor');
    assert.equal(after.tint,expected.appearance.tint||object.visual.tint);
  }
  if(kind==='pickup')assert.equal(imported.entries[1].visible,false);
  if(kind==='sequence')assert.deepEqual(imported.entries.map(e=>e.tint),['#aabbcc','#ffe9a8'],'initial appearance must not skip to the first completed entry');
}
const object=createObject('toggle');object.behavior.initialToggle=true;
assert.equal(importedStates(object).initial,'state_1');
object.visual.float=true;assert.throws(()=>importedStates(object),/持续浮动/,'unsupported motion cannot be silently frozen');

const placement={position:{x:30,y:50},origin:{x:0,y:0},scale:2,flip_x:true};
const context={object:placement,object_rendering:{width:48,height:64,offset:{x:3,y:-4},scale:1.5,flip_x:true,flip_y:true}};
const state={width:128,height:128};
assert.deepEqual(objectWorldPoint({x:128,y:0},context,state),{x:96,y:138});
assert.deepEqual(objectLocalPoint({x:96,y:138},context,state),{x:128,y:0});
assert.deepEqual(objectWorldPoint({x:64,y:64},context,state),{x:24,y:42});
const id={position:{x:0,y:0},origin:{x:0,y:0},scale:1,flip_x:false};
const anchor={id:'p',samples:[{frame:0,state:'visible',point:{x:64,y:64}}]};
const source={fps:12,frames:[{index:0,width:128,height:128}]};
const sample={actor:id,actor_anchors:[{id:'p',samples:[{frame:0,state:'visible',point:{x:24,y:42}}]}],
  ...context,initial_state:'initial',object_states:[{id:'initial',...state,visible:true,tint:'#ffffff',anchors:[anchor],fps:1,frames:[{duration:1}],loop:false}],events:[],
  relations:[{id:'r',kind:'contact',actor_anchor:'p',object_anchor:'p',window:{start:0,end:0},tolerance_px:1}]};
assert.equal(evaluateInteraction(source,sample)[0].status,'matched','geometry must include the source display transform');
sample.object_states[0].visible=false;
assert.equal(evaluateInteraction(source,sample)[0].status,'unknown','hidden material cannot provide visible contact evidence');
assert.deepEqual(previewBounds(source,sample),{x:-60,y:-66,width:200,height:216});
console.log('Imported states match source initial/completed appearances; dimensions, tint, visibility, both flips and inverse point mapping passed.');
