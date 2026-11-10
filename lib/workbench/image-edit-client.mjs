import { imageEditInputs } from './image-edit-contract.mjs';

export async function forwardImageEditRequest(operation, input, schemas = imageEditInputs) {
  const parsed = schemas[operation].parse(input);
  const base = process.env.WORKBENCH_RUNTIME_URL?.trim() || `http://127.0.0.1:${process.env.WORKBENCH_RUNTIME_PORT || 8790}`;
  let response;
  try {
    response = await fetch(`${base.replace(/\/+$/, '')}/v1/agent/${operation}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed), signal: AbortSignal.timeout(120000),
    });
  } catch (cause) {
    throw Object.assign(new Error('Image editing Bridge is unavailable. Reuse the current workbench service; do not resubmit an ambiguous operation with a new commandId.'), { code: 'IMAGE_EDIT_BRIDGE_UNAVAILABLE', status: 503, cause });
  }
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || 'Image editing request failed.'), body, { status: response.status });
  return body;
}
