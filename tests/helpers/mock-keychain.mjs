// Preload only into an isolated test child. This replaces the OS Keychain call,
// never application crypto or storage. No real credentials or Keychain entries.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
if (
  !process.env.WORKBENCH_TEST_RUN ||
  !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(process.env.WORKBENCH_TEST_RUN)
)
  throw new Error('Mock Keychain requires an isolated WORKBENCH_TEST_RUN.');
const inherited = process.env.WORKBENCH_TEST_KEYCHAIN
  ? JSON.parse(process.env.WORKBENCH_TEST_KEYCHAIN)
  : null;
const keys = new Map(inherited?.run === process.env.WORKBENCH_TEST_RUN ? inherited.entries : []),
  original = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  if (command !== '/usr/bin/security') return original(command, args, options);
  if (args.length === 1 && args[0] === '-i') {
    const match =
      /^add-generic-password -a ([0-9a-f-]{36}) -s 2DGameDevWorkbench\.map-generation -w ([0-9a-f]{64})\n$/.exec(
        typeof options?.input === 'string' ? options.input : '',
      );
    if (match) {
      keys.set(match[1], match[2]);
      // Test child processes inherit the fixture keyring, allowing restart
      // coverage without touching the system Keychain or a real credential.
      process.env.WORKBENCH_TEST_KEYCHAIN = JSON.stringify({ run: process.env.WORKBENCH_TEST_RUN, entries: [...keys] });
      return { status: 0, stdout: '', stderr: '' };
    }
  }
  if (
    args[0] === 'find-generic-password' &&
    args[1] === '-s' &&
    args[2] === '2DGameDevWorkbench.map-generation' &&
    args[3] === '-a' &&
    args[5] === '-w' &&
    keys.has(args[4])
  )
    return { status: 0, stdout: keys.get(args[4]), stderr: '' };
  return {
    status: 1,
    stdout: '',
    stderr: 'Unsupported or unknown mock Keychain entry.',
  };
};
syncBuiltinESMExports();
