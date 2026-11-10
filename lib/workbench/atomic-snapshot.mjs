import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

export async function writeAtomicSnapshot(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) {
        // Windows can briefly deny replacement while another process reads the
        // previous snapshot. Retry only this local commit, never the adapter.
        // A 500 ms window proved too short under active readers; allow ~2 s.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 39) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  } finally { await rm(temporary, { force: true }); }
}
