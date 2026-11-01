#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  agentRequest,
  findCapability,
  loadManifest,
  prepareTask,
  publicCapability,
  refreshTask,
  repositoryRoot,
  runConnector,
  summarizeTask,
} from '../lib/workbench/runtime.mjs';

function parseArguments(values) {
  const positional = [];
  const flags = new Map();

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }

    const name = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      index += 1;
    }
  }

  return { positional, flags };
}

async function loadInput(flags) {
  const inline = flags.get('input-json');
  const inputFile = flags.get('input');

  if (typeof inline === 'string') return JSON.parse(inline);
  if (typeof inputFile === 'string') {
    const resolvedPath = path.resolve(repositoryRoot, inputFile);
    return JSON.parse(await readFile(resolvedPath, 'utf8'));
  }

  throw new Error('Provide --input <json-file> or --input-json <json>.');
}

function print(value, jsonMode) {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      process.stdout.write(
        `${item.id.padEnd(20)} ${item.name} ${item.connector.configured ? '[configured]' : '[needs connector]'}\n`,
      );
    }
    return;
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return `2D Game Dev Workbench runner

Commands:
  list [--json]
  describe <capability-id> [--json]
  doctor [--json]
  agent <guidance|environment|start|frontend|present|frontend-context|presets|tasks|result|artifact|interactable-template|assets|asset|asset-manifest|game-exports|game-export|export-to-game|install-game-export|complete-game-export|documents|document-get|document-create|document-save|document-apply|document-restore|document-observe|document-validate|document-simulate|document-adopt-image|document-export> [--input <json-file>] [--json]
  prepare <capability-id> --input <json-file> [--json]
  run <capability-id> --input <json-file> [--json]
  status <task-id> [--json]

Image editing agent operations: image-inspect, image-resolve, image-panel-suggest, image-edit,
  image-apply, image-session-create, image-session-get (canonical Bridge required).
Scene collaboration agent operations: scene-workflow-list, scene-workflow-create,
  scene-workflow-get, scene-workflow-execute, scene-workflow-revise,
  scene-workflow-pause, scene-workflow-resume, scene-workflow-observe,
  scene-workflow-adopt, scene-workflow-settings (canonical Bridge required).
`;
}

async function main() {
  const { positional, flags } = parseArguments(process.argv.slice(2));
  const [command, target] = positional;
  const jsonMode = flags.has('json');
  const manifest = await loadManifest();

  if (!command || command === 'help') {
    process.stdout.write(usage());
    return;
  }

  if (command === 'agent') {
    print(
      await agentRequest(
        manifest,
        target,
        flags.has('input') || flags.has('input-json') ? await loadInput(flags) : {},
      ),
      jsonMode,
    );
    return;
  }

  if (command === 'list') {
    print(manifest.capabilities.map(publicCapability), jsonMode);
    return;
  }

  if (command === 'describe') {
    print(findCapability(manifest, target), jsonMode);
    return;
  }

  if (command === 'doctor') {
    const report = {
      manifest: 'ok',
      schemaVersion: manifest.schemaVersion,
      capabilities: manifest.capabilities.map((capability) => {
        const published = publicCapability(capability);
        return {
          id: capability.id,
          connector: published.connector.type,
          adapter: published.connector.adapter,
          configured: published.connector.configured,
          ...(published.connector.urlEnv
            ? { urlEnv: published.connector.urlEnv }
            : {}),
          ...(published.connector.providers
            ? {
                providers: published.connector.providers.map((provider) => ({
                  id: provider.id,
                  model: provider.model,
                  configured: provider.configured,
                })),
                externalGenerationConfigured:
                  published.connector.externalGenerationConfigured,
                activeGenerationProvider:
                  published.connector.activeGenerationProvider,
              }
            : {}),
        };
      }),
    };
    print(report, jsonMode);
    return;
  }

  if (command === 'status') {
    if (!target) throw new Error('Provide a task ID.');
    const refreshed = await refreshTask(manifest, target);
    print(
      refreshed.refreshError
        ? { ...refreshed.task, refreshError: refreshed.refreshError }
        : refreshed.task,
      jsonMode,
    );
    return;
  }

  if (command === 'prepare' || command === 'run') {
    const capability = findCapability(manifest, target);
    const input = await loadInput(flags);
    const result =
      command === 'prepare'
        ? await prepareTask(manifest, capability, input)
        : await runConnector(manifest, capability, input);
    print(summarizeTask(result), jsonMode);
    return;
  }

  throw new Error(`Unknown command "${command}".\n\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
