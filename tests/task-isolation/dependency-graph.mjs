// Production static value imports/re-exports. Type-only, dynamic and package edges are excluded.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const files = new Set();
for (const dir of ['app', 'components', 'features', 'lib', 'scripts']) {
  for (const name of await readdir(dir, { recursive: true })) {
    if (/\.(?:[cm]?js|tsx?)$/.test(name) && !/\.d\.(?:ts|mts|cts)$/.test(name)) files.add(path.join(dir, name));
  }
}
function resolve(from, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return;
  const base = specifier.startsWith('@/') ? path.normalize(specifier.slice(2)) : path.join(path.dirname(from), specifier);
  for (const suffix of ['', '.mjs', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']) {
    const candidate = path.normalize(base + suffix);
    if (files.has(candidate)) return candidate;
  }
}
const graph = new Map();
for (const file of files) {
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest);
  const dependencies = new Set();
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    const clause = node.importClause ?? node.exportClause;
    const named = clause?.namedBindings?.elements ?? clause?.elements;
    if (node.isTypeOnly || clause?.isTypeOnly || (!clause?.name && named?.length && named.every(element => element.isTypeOnly))) continue;
    if (!node.moduleSpecifier) continue;
    const target = resolve(file, node.moduleSpecifier.text);
    if (target) dependencies.add(target);
  }
  graph.set(file, dependencies);
}
const done = new Set(), active = new Set();
function visit(file) {
  if (done.has(file)) return;
  assert(!active.has(file), 'Static import cycle: ' + [...active, file].join(' -> '));
  active.add(file);
  for (const dependency of graph.get(file)) visit(dependency);
  active.delete(file);
  done.add(file);
}
for (const file of graph.keys()) visit(file);
console.log(`PASS ${files.size} production modules and ${[...graph.values()].reduce((n, edges) => n + edges.size, 0)} static value edges, zero cycles.`);
