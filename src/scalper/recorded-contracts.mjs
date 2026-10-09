import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attestCart } from './attestation.mjs';
import { isAvailable as pokemonCenterAvailable } from './sites/pokemon-center/detect.mjs';

export const POKEMON_CENTER_CONTRACT_FILES = Object.freeze([
  'in-stock.json', 'out-of-stock.json', 'cart.json', 'checkout.json', 'confirmation.json', 'capture-metadata.json',
]);

function containsSensitiveKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (
    /authorization|cookie|set-cookie|card(number)?|cvv|password|access.?token|refresh.?token/i.test(key)
    || containsSensitiveKey(item)
  ));
}

export async function loadPokemonCenterContracts({ fixtureDir = 'tests/fixtures/pokemon-center' } = {}) {
  const values = {};
  const missing = [];
  for (const name of POKEMON_CENTER_CONTRACT_FILES) {
    try {
      values[name] = JSON.parse(await readFile(join(fixtureDir, name), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') missing.push(name);
      else throw new Error(`Invalid Pokémon Center recorded contract ${name}: ${error.message}`, { cause: error });
    }
  }
  if (missing.length) return { ready: false, missing, defects: [], contracts: null };
  const defects = [];
  for (const [name, value] of Object.entries(values)) {
    if (containsSensitiveKey(value)) defects.push(`${name}:sensitive-key`);
  }
  if (!pokemonCenterAvailable(values['in-stock.json'])) defects.push('in-stock.json:not-available');
  if (pokemonCenterAvailable(values['out-of-stock.json'])) defects.push('out-of-stock.json:false-positive');
  const expected = values['capture-metadata.json']?.expectedCart;
  if (!expected) defects.push('capture-metadata.json:expectedCart-missing');
  else {
    const attestation = attestCart(values['cart.json'], expected);
    if (!attestation.ok) defects.push(...attestation.defects.map((defect) => `cart.json:${defect.name}`));
  }
  if (!values['checkout.json']?.status) defects.push('checkout.json:status-missing');
  if (!values['confirmation.json']?.orderId) defects.push('confirmation.json:orderId-missing');
  return { ready: defects.length === 0, missing: [], defects, contracts: values };
}
