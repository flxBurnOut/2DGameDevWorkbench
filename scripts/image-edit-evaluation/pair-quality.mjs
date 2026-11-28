import { access } from 'node:fs/promises';
import path from 'node:path';
import { json, save } from './core.mjs';

export async function checkArmQuality(directory, arm, expectedQuality) {
  const invalidFile = path.join(directory, 'invalid-pair.json');
  try {
    await access(invalidFile);
    throw new Error('Invalid quality pair: ' + directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const result = await json(path.join(directory, arm, 'result.json'));
  if (result.returnedQuality !== expectedQuality) {
    await save(invalidFile, {
      status: 'invalid',
      reason: 'quality-mismatch',
      arm,
      expectedQuality,
      returnedQuality: result.returnedQuality ?? null,
      taskId: result.candidate?.taskId ?? null,
    });
    throw new Error('Invalid quality pair: ' + directory);
  }
  return result;
}
