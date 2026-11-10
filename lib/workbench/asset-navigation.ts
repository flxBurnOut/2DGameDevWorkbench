export type AssetLocation = {
  query: string;
  kind: string;
  scope: 'active' | 'trashed';
  offset: number;
  snapshot: string;
  asset: string;
};
const kinds = new Set(['', 'character', 'prop', 'animation', 'map', 'map-image', 'interactable', 'scene']);
export function readAssetLocation(search: string): AssetLocation {
  const params = new URLSearchParams(search);
  const offset = Number(params.get('offset') || 0);
  return {
    query: params.get('query') || '',
    kind: kinds.has(params.get('kind') || '') ? params.get('kind') || '' : '',
    scope: params.get('scope') === 'trashed' ? 'trashed' : 'active',
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    snapshot: params.get('snapshot') || '',
    asset: params.get('asset') || '',
  };
}
export function assetLocationHref(state: AssetLocation): string {
  const params = new URLSearchParams();
  if (state.query) params.set('query', state.query);
  if (state.kind) params.set('kind', state.kind);
  if (state.scope === 'trashed') params.set('scope', state.scope);
  if (state.offset) params.set('offset', String(state.offset));
  if (state.snapshot) params.set('snapshot', state.snapshot);
  if (state.asset) params.set('asset', state.asset);
  return '/assets' + (params.size ? '?' + params : '');
}
