import type {Interactable} from '../interactable-editor/contract.mjs';
import type {ObjectRendering} from './model.mjs';
export function importedStates(object:Interactable):{
  entries:{id:string;name:string;asset:string;clip:string;visible:boolean;tint:string}[];
  initial:string;
  rendering:ObjectRendering;
};
