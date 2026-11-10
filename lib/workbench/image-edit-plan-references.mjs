import sharp from 'sharp';
import { readImageAssetSource } from './adapters/image-assets-source.mjs';
import { blob, readBlob } from './image-edit-store.mjs';
import { linearToSrgb } from '../../features/image-edit/intrinsic-recolor.mjs';

function cropAround(bounds, width, height) {
  const padding = Math.min(96, Math.max(24, Math.round(Math.max(bounds.width, bounds.height) * .2)));
  const x = Math.max(0, bounds.x - padding), y = Math.max(0, bounds.y - padding);
  return {x, y, width: Math.min(width, bounds.x + bounds.width + padding) - x,
    height: Math.min(height, bounds.y + bounds.height + padding) - y};
}

async function shadingCrop(decoded, crop, shading) {
  const rgba = Buffer.alloc(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const source = (crop.y + y) * decoded.width + crop.x + x;
      const dest = (y * crop.width + x) * 4;
      rgba[dest + 3] = decoded.pixels[source * 4 + 3];
      if (!rgba[dest + 3]) continue;
      for (let channel = 0; channel < 3; channel++) {
        const linear = Math.min(1, shading[source * 3 + channel]);
        rgba[dest + channel] = Math.round(255 * linearToSrgb(linear));
      }
    }
  }
  return sharp(rgba, {raw:{width:crop.width,height:crop.height,channels:4}}).png().toBuffer();
}

export async function preparePlanReferences(root, directory, input, base, decoded, bounds, intrinsic) {
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
    const useShading = input.softReference.kind==='shading';
    const bytes = useShading ? await shadingCrop(decoded,crop,intrinsic.layers.shading) : clean;
    const layer = useShading ? {analysisId:intrinsic.analysis.analysisId, model:intrinsic.analysis.receipt.model,
      revision:intrinsic.analysis.receipt.revision, layerSha256:intrinsic.analysis.receipt.files.shading.sha256,
      encoding:'linear-shading-clamped-to-srgb-with-source-alpha'} : {};
    await add(bytes,'png',useShading?'diffuse-shading':'rgb-control',{...metadata,...layer});
    result.softReferencePreviewPng = (await sharp(bytes).resize({width:512,height:512,fit:'inside',withoutEnlargement:true,kernel:'nearest'}).png().toBuffer()).toString('base64');
  }
  await add(clean,'png','clean-crop',metadata);
  result.crop = crop;
  result.localPreviewPng = (await sharp(clean).resize({width:Math.min(crop.width*2,512),kernel:'nearest'}).png().toBuffer()).toString('base64');
  return result;
}
