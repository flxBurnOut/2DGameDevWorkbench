import sharp from 'sharp';
import { readImageAssetSource } from './adapters/image-assets-source.mjs';
import { blob, readBlob } from './image-edit-store.mjs';

function cropAround(bounds, width, height) {
  const padding = Math.min(96, Math.max(24, Math.round(Math.max(bounds.width, bounds.height) * .2)));
  const x = Math.max(0, bounds.x - padding), y = Math.max(0, bounds.y - padding);
  return {x, y, width: Math.min(width, bounds.x + bounds.width + padding) - x,
    height: Math.min(height, bounds.y + bounds.height + padding) - y};
}

export async function preparePlanReferences(root, directory, input, base, decoded, bounds) {
  const references = [], referenceManifest = [], warnings = [];
  async function add(bytes, extension, role, metadata) {
    const stored = await blob(root, directory, bytes, extension);
    references.push(stored.file);
    referenceManifest.push({slot:references.length, role, sha256:stored.sha256, ...metadata});
  }
  for (const ref of input.operation.references ?? []) {
    const image = await readImageAssetSource(ref, root);
    await add(image.buffer, image.format==='jpeg'?'jpg':image.format, 'user-reference', {width:image.width,height:image.height});
  }
  const result = {references, referenceManifest, warnings, crop:null, localPreviewPng:null};
  if (!input.localContext) return result;
  if (references.length===8) {
    warnings.push('8 个参考槽已用满，本计划未加入局部参考。');
    return result;
  }
  const crop = cropAround(bounds, decoded.width, decoded.height);
  const clean = await sharp(await readBlob(root,base)).extract({left:crop.x,top:crop.y,width:crop.width,height:crop.height}).png().toBuffer();
  const metadata = {width:crop.width,height:crop.height,crop,baseSha256:base.sha256};
  if (input.softReference) {
    const bytes = clean;
    await add(bytes,'png','rgb-control',metadata);
    result.softReferencePreviewPng = (await sharp(bytes).resize({width:512,height:512,fit:'inside',withoutEnlargement:true,kernel:'nearest'}).png().toBuffer()).toString('base64');
  }
  await add(clean,'png','clean-crop',metadata);
  result.crop = crop;
  result.localPreviewPng = (await sharp(clean).resize({width:Math.min(crop.width*2,512),kernel:'nearest'}).png().toBuffer()).toString('base64');
  return result;
}
