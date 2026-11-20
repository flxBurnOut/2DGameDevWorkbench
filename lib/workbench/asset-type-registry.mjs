export const registeredAssetKinds = Object.freeze(['character', 'prop', 'animation', 'interactable']);

export function assetKindEnabled(manifest, kind) {
  return (
    registeredAssetKinds.includes(kind) &&
    !(manifest.agentAssets?.assetCatalog?.disabledKinds || []).includes(kind)
  );
}

export function requireAssetKind(manifest, kind) {
  if (!assetKindEnabled(manifest, kind))
    throw new Error(`素材类型未启用：${kind}`);
}
