import { initialState, committedState, stateAppearance } from '../interactable-editor/simulator.mjs';

// Compile frozen appearance snapshots using the editor's existing state rules.
// Events remain an explicit preview schedule; this does not execute behavior.
export function importedStates(object) {
  if(object.visual.float)throw new Error('此物件启用了持续浮动；当前联合约定尚不能核对连续位移，未静默导入成固定外观。');
  const entries=[];
  function add(id,name,state){
    const a=stateAppearance(object,state);
    entries.push({id,name,asset:a.assetId||object.visual.assetId,clip:a.animation||object.visual.idleAnimation,
      visible:(a.visible??object.visual.visible)&&!(state.completed&&object.completion!=='remain'),
      tint:a.tint||object.visual.tint});
  }
  let state=initialState(object);
  if(object.behavior.kind==='toggle'){
    for(let i=0;i<2;i++)add(`state_${i}`,object.behavior.states[i].name,{...state,toggleState:!!i});
  }else{
    add('state_0','初始外观',state);
    if(object.behavior.kind==='sequence'){
      for(const [i,entry] of object.behavior.entries.entries()){
        state=committedState(object,state);add(`state_${i+1}`,entry.name,state);
      }
    }else if(object.behavior.kind==='pickup'||!object.behavior.repeat){
      add('state_1','交互完成后',committedState(object,state));
    }
  }
  if(entries.length>16)throw new Error('此物件超过联合预览的 16 个状态上限，未截断或省略状态。');
  return {entries,initial:object.behavior.kind==='toggle'&&object.behavior.initialToggle?'state_1':'state_0',
    rendering:{width:object.visual.width,height:object.visual.height,offset:{...object.visual.offset},scale:object.visual.scale,flip_x:object.visual.flipH,flip_y:object.visual.flipV}};
}
