import { fileURLToPath } from 'node:url';
import { KeychainVault } from './secret-vault.mjs';

export async function runVaultCommand([command, name], { vault = new KeychainVault(), prompt } = {}) {
  if (!command || !name) throw new Error('Usage: npm run scalper:secret -- <set|status|delete> <NAME>');
  if (command === 'set') {
    if (prompt) {
      const value = await prompt();
      if (!value) throw new Error('Secret value cannot be empty');
      return vault.set(name, value);
    }
    if (!vault.setInteractive) throw new Error('Vault does not support secure interactive entry');
    return vault.setInteractive(name);
  }
  if (command === 'status') return { name, configured: await vault.has(name) };
  if (command === 'delete') return vault.delete(name);
  throw new Error(`Unknown secret command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runVaultCommand(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
}
