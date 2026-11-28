import { normalizeProject } from '../interactable-editor/contract.mjs';
import { portableProject } from '../scene-composer/browser';
import type { ImportBundle } from '@/lib/workbench/asset-import';
import type { InteractionContext, InteractionSource, ObjectFrame, ObjectState } from './model.mjs';
import { importedStates } from './import-model.mjs';

async function sha(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map(v=>v.toString(16).padStart(2,'0')).join('');
}

export async function contextFromAsset(bundle: ImportBundle, source: InteractionSource): Promise<InteractionContext> {
  const file = bundle.files[0].file;
  const original = await file.text();
  const project = await portableProject(normalizeProject(JSON.parse(original)));
  const object = project.objects.find(o=>o.definitionId===bundle.asset.definitionId);
  if (!object) throw new Error('素材包中没有所选交互物。');
  const {entries,initial,rendering}=importedStates(object);
  const loaded = new Map<string, Omit<ObjectFrame,'raw_index'|'duration'|'region'>>();
  const result: ObjectState[] = [];
  for (const entry of entries) {
    const clip = object.visual.clips.find(c=>c.name===entry.clip);
    if(entry.clip&&!clip)throw new Error(`物件状态引用的动画“${entry.clip}”不存在，未替换为静态图片。`);
    if(clip&&(clip.frames.length>128||clip.frames.some(f=>f.duration<.25)))
      throw new Error('此物件动画超出当前联合预览的帧数或持续时间范围，未截帧或改变播放速度。');
    const frames: ObjectFrame[] = [];
    for (const [i, frame] of (clip?.frames || [{assetId:entry.asset, duration:1}]).entries()) {
      const asset = project.assets.find(a=>a.id===frame.assetId);
      if (!asset || asset.mime !== 'image/png' || !asset.source.startsWith('data:image/png;base64,'))
        throw new Error('联合预览需要交互物各状态的实际 PNG；请先补齐外观素材。');
      let data = loaded.get(asset.id);
      if (!data) {
        const png_base64=asset.source.split(',')[1];
        const bytes=Uint8Array.from(atob(png_base64),c=>c.charCodeAt(0));
        const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
        data={png_base64,sha256:await sha(bytes),width:image.width,height:image.height};
        image.close();loaded.set(asset.id,data);
      }
      frames.push({...data,raw_index:i,duration:frame.duration,region:'region' in frame ? frame.region || null : null});
    }
    const dimensions=frames[0].region || frames[0];
    result.push({id:entry.id,name:entry.name,frames,fps:clip?.fps||1,loop:clip?.loop||false,width:dimensions.width,height:dimensions.height,anchors:[],visible:entry.visible,tint:entry.tint});
  }
  const a=source.frames[0];
  return {
    version:1,title:`角色与${object.displayName}`,
    actor:{position:{x:0,y:0},origin:{x:a.width/2,y:a.height},scale:1,flip_x:false,facing:'unknown',depth:0},actor_anchors:[],
    object:{position:{x:a.width,y:0},origin:{x:0,y:0},scale:1,flip_x:false,facing:'unknown',depth:1},object_rendering:rendering,
    object_source:{asset_id:bundle.asset.id,revision:bundle.asset.revision!,sha256:await sha(new TextEncoder().encode(original)),label:object.displayName,scope:'frozen_import'},
    object_states:result,initial_state:initial,
    events:[],relations:[],interruption:'reset_on_restart',permissions:'preview_only',
  };
}
