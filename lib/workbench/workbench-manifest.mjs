import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const repositoryRoot = path.resolve(moduleDirectory, '..', '..');
export const manifestPath = path.join(repositoryRoot, 'workbench', 'manifest.json');

export async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Test subprocesses inherit this namespace; production continues to use the manifest.
  const testRun = process.env.WORKBENCH_TEST_RUN;
  if (testRun) {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(testRun)) {
      throw new Error('WORKBENCH_TEST_RUN must be a simple test run identifier.');
    }
    manifest.workspace.assetTrashDirectory = `work/test-runs/${testRun}/asset-trash`;
    manifest.workspace.importedAssetDirectory = `work/test-runs/${testRun}/imported-assets`;
    manifest.workspace.packageImportDirectory = `work/test-runs/${testRun}/asset-package-imports`;
    manifest.workspace.taskDirectory = `work/test-runs/${testRun}/tasks`;
    manifest.workspace.presentationDirectory = `work/test-runs/${testRun}/presentation`;
    manifest.workspace.gameExportDirectory = `work/test-runs/${testRun}/game-exports`;

    manifest.workspace.documentDirectory = `work/test-runs/${testRun}/editor-documents`;
    manifest.workspace.imageEditDirectory = `work/test-runs/${testRun}/image-edits`;
    manifest.workspace.outputDirectory = `outputs/test-runs/${testRun}`;
  }
  return manifest;
}

export function agentCapabilities(manifest) {
  return manifest.capabilities.filter((capability) => capability.agent?.mode !== 'manual');
}

export function findAgentCapability(manifest, capabilityId) {
  const capability = findCapability(manifest, capabilityId);
  if (capability.agent?.mode === 'manual') {
    throw new Error(`${capability.name} uses the manual frontend: ${capability.ui.route}. ${capability.agent.reason}`);
  }
  return capability;
}

export function findCapability(manifest, capabilityId) {
  const capability = manifest.capabilities.find((candidate) => candidate.id === capabilityId);
  if (!capability) {
    throw new Error(`Unknown capability "${capabilityId}". List capabilities before choosing one.`);
  }
  return capability;
}
