import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';

// This stable service name is needed to decrypt existing saved credentials.
const service = '2DGameDevWorkbench.map-generation';

export function createMacImageCredentials(run = spawnSync) {
  function command(args, input) {
    const result = run('/usr/bin/security', args, { input, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    if (result.error || result.status !== 0) throw new Error('macOS 钥匙串不可用，请解锁登录钥匙串并允许访问后重试。');
    return result.stdout.trim();
  }
  function loadKey(account) {
    if (!/^[0-9a-f-]{36}$/.test(account)) throw new Error('Invalid keychain account.');
    const value = command(['find-generic-password', '-s', service, '-a', account, '-w']);
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid keychain key.');
    return Buffer.from(value, 'hex');
  }
  return {
    seal(clear, existingAccount) {
      const account = existingAccount || randomUUID();
      const key = existingAccount ? loadKey(account) : randomBytes(32);
      if (!existingAccount) {
        // security's interactive parser reads this short, hex-only command from a pipe.
        // Neither the API token nor the encryption key appears in process arguments.
        command(['-i'], `add-generic-password -a ${account} -s ${service} -w ${key.toString('hex')}\n`);
        if (!loadKey(account).equals(key)) throw new Error('Keychain write verification failed.');
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(clear, 'utf8'), cipher.final()]);
      return JSON.stringify({ account, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
    },
    open(value) {
      const record = JSON.parse(value);
      const decipher = createDecipheriv('aes-256-gcm', loadKey(record.account), Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}
