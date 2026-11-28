import type { GodotPackageManifest } from './package.mjs';
export function gameHandoff(delivery: {title:string;deliveryId:string;project:{name:string;path:string}} | null, manifest?: Pick<GodotPackageManifest, 'kind' | 'details'>): {summary:string;prompt:string};
