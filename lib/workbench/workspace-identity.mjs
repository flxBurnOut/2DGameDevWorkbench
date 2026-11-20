import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export function workspaceIdentity(root) {
  return createHash('sha256').update(realpathSync(root)).digest('hex');
}

export const localWorkspaceId = workspaceIdentity(fileURLToPath(new URL('../../', import.meta.url)));
