export const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_COMMAND' }); };
export function selected(collection, ids, key = 'id') {
  const result = ids.map(id => collection.find(value => value[key] === id));
  if (result.some(value => !value)) fail('A selected node does not exist. Refresh the document before editing.');
  return result;
}
