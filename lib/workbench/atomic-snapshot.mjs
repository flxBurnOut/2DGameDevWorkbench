import { randomUUID } from 'node:crypto';
import { rename, rm, stat, writeFile } from 'node:fs/promises';

export async function replaceAtomicPath(temporary, file) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, file); break; }
    catch (error) {
      // Windows readers or antivirus can temporarily lock the destination.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 39) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

export async function writeAtomicSnapshot(file, bytes, { observe = false } = {}) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    const before = observe ? await stat(temporary, { bigint: true }) : null;
    await replaceAtomicPath(temporary, file);
    if (before) {
      const after = await stat(file, { bigint: true, throwIfNoEntry: false }).catch(() => null);
      if (after && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs)
        return after;
    }
  } finally { await rm(temporary, { force: true }); }
}
