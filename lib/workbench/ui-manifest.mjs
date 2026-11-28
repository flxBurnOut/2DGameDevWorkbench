// Pages need brand, navigation, module and route data only. Input schemas,
// connectors and Agent guidance stay in workbench/manifest.json for services.
export const uiManifestPath = 'lib/workbench/ui-manifest.json';

const moduleEntry = (capability) => ({
  id: capability.id,
  name: capability.name,
  shortName: capability.shortName,
  description: capability.description,
  executable: 'connector' in capability,
  ui: capability.ui,
});

export function buildUiManifest(manifest) {
  return {
    workspace: { name: manifest.workspace.name, brand: manifest.workspace.brand },
    productionLines: manifest.productionLines,
    assetImports: manifest.assetImports,
    assetCatalogRoute: manifest.agentAssets.assetCatalog.route,
    modules: [...manifest.capabilities, ...manifest.editorModules].map(moduleEntry),
  };
}

export const serializeUiManifest = (manifest) =>
  JSON.stringify(buildUiManifest(manifest), null, 2) + '\n';
