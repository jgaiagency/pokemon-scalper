import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileDefault = promisify(execFileCallback);
const interactiveRunDefault = (path, args) => new Promise((resolve, reject) => {
  const child = spawn(path, args, { stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(Object.assign(new Error(`Keychain command exited with ${signal ?? code}`), { code, signal }));
  });
});
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function validateName(name) {
  if (!SAFE_NAME.test(name ?? '')) throw new Error('Secret name must use only letters, numbers, dot, colon, underscore, or dash');
}

function vaultError(action, name, cause) {
  const error = new Error(`Could not ${action} Keychain secret ${name}`);
  error.code = 'SCALPER_KEYCHAIN_ERROR';
  error.cause = cause;
  return error;
}

export class KeychainVault {
  constructor({
    service = 'com.local.pokemon-scalper',
    securityPath = '/usr/bin/security',
    execFile = execFileDefault,
    interactiveRun = interactiveRunDefault,
    platform = process.platform,
  } = {}) {
    this.service = service;
    this.securityPath = securityPath;
    this.execFile = execFile;
    this.interactiveRun = interactiveRun;
    this.platform = platform;
  }

  #assertSupported() {
    if (this.platform !== 'darwin') {
      const error = new Error('The system Keychain vault is available only on macOS');
      error.code = 'SCALPER_KEYCHAIN_UNAVAILABLE';
      throw error;
    }
  }

  async set(name, value) {
    this.#assertSupported();
    validateName(name);
    if (typeof value !== 'string' || value.length === 0) throw new Error('Secret value must be a non-empty string');
    try {
      await this.execFile(this.securityPath, [
        'add-generic-password', '-U', '-a', name, '-s', this.service, '-w', value,
      ], { windowsHide: true });
      return { stored: true, name };
    } catch (cause) {
      throw vaultError('store', name, cause);
    }
  }

  async setInteractive(name) {
    this.#assertSupported();
    validateName(name);
    try {
      // `security` documents `-w` without a value, placed last, as the safe
      // hidden-prompt form. The secret never enters this process or argv.
      await this.interactiveRun(this.securityPath, [
        'add-generic-password', '-U', '-a', name, '-s', this.service, '-w',
      ]);
      return { stored: true, name };
    } catch (cause) {
      throw vaultError('store', name, cause);
    }
  }

  async get(name) {
    this.#assertSupported();
    validateName(name);
    try {
      const result = await this.execFile(this.securityPath, [
        'find-generic-password', '-a', name, '-s', this.service, '-w',
      ], { windowsHide: true });
      return String(result?.stdout ?? '').replace(/[\r\n]+$/, '');
    } catch (cause) {
      if (cause?.code === 44 || /could not be found|item not found/i.test(cause?.stderr ?? cause?.message ?? '')) return null;
      throw vaultError('read', name, cause);
    }
  }

  async has(name) {
    return (await this.get(name)) !== null;
  }

  async delete(name) {
    this.#assertSupported();
    validateName(name);
    try {
      await this.execFile(this.securityPath, [
        'delete-generic-password', '-a', name, '-s', this.service,
      ], { windowsHide: true });
      return { deleted: true, name };
    } catch (cause) {
      if (cause?.code === 44 || /could not be found|item not found/i.test(cause?.stderr ?? cause?.message ?? '')) {
        return { deleted: false, name };
      }
      throw vaultError('delete', name, cause);
    }
  }

  async resolve(reference) {
    if (typeof reference !== 'string' || !reference.startsWith('keychain:')) return reference;
    return this.get(reference.slice('keychain:'.length));
  }
}

export function createKeychainVault(options) {
  return new KeychainVault(options);
}
