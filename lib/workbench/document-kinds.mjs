import { interactableDocuments } from './interactable-documents.mjs';

const kinds = { interactable: interactableDocuments };
export const documentKinds = Object.freeze(Object.keys(kinds));
export function documentKind(kind) {
  const handler = Object.hasOwn(kinds, kind) && kinds[kind];
  if (!handler) throw Object.assign(new Error('Unsupported document kind.'), { status: 400, code: 'INVALID_DOCUMENT' });
  return handler;
}
