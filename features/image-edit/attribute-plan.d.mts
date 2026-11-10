import type { RegionSpec } from './core.mjs';
export type AttributeName = 'shape'|'texture'|'albedo'|'lighting'|'reflection';
export type AttributeAction = 'preserve'|'edit'|'recompute';
export type AttributePolicy = Record<AttributeName,AttributeAction>;
export const attributeNames: AttributeName[];
export const attributeLabels: Record<AttributeName,string>;
export const attributeDefaults: Record<'recolor'|'material'|'part',AttributePolicy>;
type PlanRegion = RegionSpec | Uint8Array;
export function planScope(pixels:Uint8Array,width:number,height:number,allowed:Uint8Array,target?:PlanRegion,influence?:PlanRegion,protectedRegions?:PlanRegion[]):{mask:Uint8Array;count:number;bounds:{x:number;y:number;width:number;height:number};spec?:RegionSpec};
