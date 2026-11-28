import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { serializeUiManifest, uiManifestPath } from '../lib/workbench/ui-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Regenerate the page manifest; returns true when the file changed. */
export async function syncUiManifest({ check = false } = {}) {
  const manifest = JSON.parse(await readFile(path.join(root, 'workbench/manifest.json'), 'utf8'));
  const output = serializeUiManifest(manifest);
  const file = path.join(root, uiManifestPath);
  let current = '';
  try {
    // Git may check out generated JSON with CRLF on Windows.
    current = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current === output) return false;
  if (check) throw new Error(`${uiManifestPath} is stale; run npm run ui-manifest:sync`);
  await writeFile(file, output);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = await syncUiManifest({ check: process.argv.includes('--check') });
  console.log(changed ? `Updated ${uiManifestPath}` : `${uiManifestPath} is current`);
}
