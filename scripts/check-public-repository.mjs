import { execFileSync } from 'node:child_process';

// Check the Git index as well as ignore rules: force-added files must fail CI.
const files = execFileSync('git', ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'],
  { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
if (files.length) {
  console.error('Local-only files must not be tracked:\n' + files.map(file => `- ${file}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('PASS public repository excludes ignored local files');
}
