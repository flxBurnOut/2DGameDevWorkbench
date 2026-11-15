import { readFile, writeFile } from 'node:fs/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { projectSchema } from '../features/interactable-editor/contract.mjs';

const schema = zodToJsonSchema(projectSchema, { $refStrategy: 'none' });
delete schema.$schema;
schema.description =
  'InteractableProject v1. Missing optional fields use editor defaults. See docs/interactable-editor.md and examples/requests/interactable-export.json.';
// Projects saved before the copyWorms export was removed carry this field. The
// zod contract drops it; listing it here keeps task validation from rejecting them.
schema.properties.objects.items.properties.copyworms = {
  type: 'object',
  description:
    'Retired. Accepted in projects saved by earlier versions and ignored.',
};
const file = new URL('../workbench/manifest.json', import.meta.url);
const source = await readFile(file, 'utf8');
const start = source.indexOf('"id": "interactable-editor"');
if (start < 0)
  throw new Error('Register interactable-editor in the manifest first.');
// Touch only this capability, preserving unrelated manifest formatting and changes.
const tail = source.slice(start);
const match =
  /"project": \{[\s\S]*?\n          \},\r?\n          "selectedDefinitionIds"/.exec(
    tail,
  );
if (!match) throw new Error('Cannot locate the interactable project schema.');
const rendered = JSON.stringify(schema, null, 2).replaceAll(
  '\n',
  '\n          ',
);
await writeFile(
  file,
  source.slice(0, start) +
    tail.replace(
      match[0],
      `"project": ${rendered},\n          "selectedDefinitionIds"`,
    ),
);
console.log(
  'Updated only interactable-editor project schema in workbench/manifest.json',
);
