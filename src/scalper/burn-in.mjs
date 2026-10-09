import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { generateOperationsReport } from './operations.mjs';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

async function readState(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeState(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export class BurnInManager {
  constructor({ env = process.env, dataDir = env.SCALPER_DATA_DIR || 'data/scalper', path = join(dataDir, 'burn-in.json'), now = Date.now } = {}) {
    this.env = env;
    this.dataDir = dataDir;
    this.path = path;
    this.now = now;
  }

  async start({ restart = false, durationMs = SEVEN_DAYS_MS } = {}) {
    if (this.env.SCALPER_LIVE === '1') throw new Error('Burn-in can only start in paper mode');
    const existing = await readState(this.path);
    if (existing && !restart) return this.status();
    const state = {
      version: 1,
      startedAt: this.now(),
      durationMs,
      mode: 'paper',
      status: 'running',
      discoveryCadence: [{
        startedAt: this.now(),
        intervalMs: Math.max(1_000, Number(this.env.SCALPER_DISCOVERY_INTERVAL_MS || 15_000)),
      }],
    };
    await writeState(this.path, state);
    return this.status();
  }

  async status() {
    const state = await readState(this.path);
    if (!state) return { started: false, status: 'not-started', passed: false, complete: false, criteria: [] };
    const now = this.now();
    const elapsedMs = Math.max(0, now - state.startedAt);
    const report = await generateOperationsReport({ dataDir: this.dataDir, now, since: state.startedAt });
    const discoveryIntervalMs = Math.max(1_000, Number(this.env.SCALPER_DISCOVERY_INTERVAL_MS || 15_000));
    const discoveryCadence = state.discoveryCadence?.length
      ? [...state.discoveryCadence]
      : [{ startedAt: state.startedAt, intervalMs: 120_000 }];
    if (Number(discoveryCadence.at(-1).intervalMs) !== discoveryIntervalMs) {
      discoveryCadence.push({ startedAt: now, intervalMs: discoveryIntervalMs });
    }
    const expectedRaw = discoveryCadence.reduce((total, segment, index) => {
      const until = discoveryCadence[index + 1]?.startedAt ?? now;
      return total + Math.max(0, until - Math.max(state.startedAt, segment.startedAt)) / Math.max(1_000, Number(segment.intervalMs));
    }, 0);
    const expectedCycles = Math.max(1, Math.floor(expectedRaw * 0.7));
    const realInputCount = report.discovery.transitions + report.signals.matched;
    const configuredLatencySamples = Number(this.env.SCALPER_BURN_IN_MIN_LATENCY_SAMPLES || 1);
    const minimumLatencySamples = Number.isInteger(configuredLatencySamples) && configuredLatencySamples > 0
      ? configuredLatencySamples
      : 1;
    const criteria = [
      { name: 'paper-mode', pass: this.env.SCALPER_LIVE !== '1' && state.mode === 'paper', actual: this.env.SCALPER_LIVE === '1' ? 'live' : 'paper' },
      { name: 'runtime-heartbeat', pass: report.runtime.running, actual: report.runtime.running },
      { name: 'discovery-coverage', pass: report.discovery.cycles >= expectedCycles, actual: report.discovery.cycles, required: expectedCycles },
      { name: 'source-reliability', pass: report.discovery.sourceFailureRate <= 0.05, actual: report.discovery.sourceFailureRate, maximum: 0.05 },
      { name: 'alert-delivery', pass: report.alerts.failed === 0, actual: report.alerts.failed, maximum: 0 },
      { name: 'no-duplicate-orders', pass: report.paperOrders.duplicates === 0, actual: report.paperOrders.duplicates, maximum: 0 },
      { name: 'no-uncertain-orders', pass: report.tasks.uncertain === 0, actual: report.tasks.uncertain, maximum: 0 },
      { name: 'real-input-observed', pass: realInputCount >= 1, actual: realInputCount, required: 1 },
      { name: 'paper-order-observed', pass: report.paperOrders.count >= 1, actual: report.paperOrders.count, required: 1 },
      {
        name: 'measured-latency',
        pass: report.paperOrders.latency.samples >= minimumLatencySamples,
        actual: report.paperOrders.latency.samples,
        required: minimumLatencySamples,
      },
    ];
    const complete = elapsedMs >= state.durationMs;
    const passed = complete && criteria.every((criterion) => criterion.pass);
    const status = passed ? 'passed' : complete ? 'failed' : 'running';
    const updated = { ...state, discoveryCadence, status, checkedAt: now };
    await writeState(this.path, updated);
    return {
      started: true,
      status,
      passed,
      complete,
      startedAt: state.startedAt,
      endsAt: state.startedAt + state.durationMs,
      elapsedMs,
      remainingMs: Math.max(0, state.durationMs - elapsedMs),
      criteria,
      summary: report,
    };
  }
}

export async function runBurnInCli({ argv = process.argv.slice(2), env = process.env } = {}) {
  const manager = new BurnInManager({ env });
  const command = argv[0] ?? 'status';
  if (command === 'start') return manager.start({ restart: argv.includes('--restart') });
  if (command === 'status') return manager.status();
  throw new Error('Usage: npm run scalper:burn-in -- [start|status] [--restart]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  console.log(JSON.stringify(await runBurnInCli(), null, 2));
}
