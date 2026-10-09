import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createStateStore } from './state-store.mjs';

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function redact(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /authorization|cookie|password|secret|token|card|cvv|webhook/i.test(key) ? '[redacted]' : redact(item, seen),
  ]));
}

export class OperationalEventLog {
  constructor({ path = 'data/scalper/operations-events.jsonl', now = Date.now } = {}) {
    this.path = path;
    this.now = now;
  }

  async record(type, details = {}) {
    if (!type) throw new Error('Operational event type is required');
    const event = { timestamp: this.now(), type, ...redact(details) };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    return event;
  }
}

export class RuntimeHeartbeat {
  constructor({ path = 'data/scalper/runtime-state.json', now = Date.now, intervalMs = 60_000, setTimer = setInterval, clearTimer = clearInterval } = {}) {
    this.path = path;
    this.now = now;
    this.intervalMs = intervalMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.startedAt = null;
    this.timer = null;
    this.details = {};
  }

  async write(extra = {}) {
    const timestamp = this.now();
    this.startedAt ??= timestamp;
    Object.assign(this.details, extra);
    const state = {
      version: 1,
      startedAt: this.startedAt,
      heartbeatAt: timestamp,
      pid: process.pid,
      ...this.details,
    };
    await atomicJson(this.path, state);
    return state;
  }

  async start(details = {}) {
    await this.write(details);
    if (!this.timer) {
      this.timer = this.setTimer(() => this.write().catch(() => {}), this.intervalMs);
      this.timer?.unref?.();
    }
    return this;
  }

  async stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    return this.write({ stoppedAt: this.now() });
  }
}

async function readJsonLines(path) {
  let source;
  try { source = await readFile(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const values = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line)); } catch { /* Keep reports available despite one partial final line. */ }
  }
  return values;
}

async function readRotatedJsonLines(path, maxArchives = 5) {
  const paths = [...Array(maxArchives).keys()].reverse().map((index) => `${path}.${index + 1}`).concat(path);
  return (await Promise.all(paths.map(readJsonLines))).flat();
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarizeLatencies(values) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  return {
    samples: valid.length,
    p50Ms: percentile(valid, 0.5),
    p95Ms: percentile(valid, 0.95),
    maxMs: valid.length ? Math.max(...valid) : null,
  };
}

export async function generateOperationsReport({
  dataDir = 'data/scalper', now = Date.now(), since = now - 24 * 60 * 60_000,
  heartbeatStaleMs = 3 * 60_000,
  tasks,
} = {}) {
  const eventPath = join(dataDir, 'operations-events.jsonl');
  const orderPath = join(dataDir, 'paper-orders.jsonl');
  const [allEvents, allOrders, runtime, discovery] = await Promise.all([
    readRotatedJsonLines(eventPath),
    readRotatedJsonLines(orderPath),
    readJson(join(dataDir, 'runtime-state.json')),
    readJson(join(dataDir, 'discovery-state.json'), { sources: {} }),
  ]);
  const ownedState = tasks ? null : createStateStore({ path: join(dataDir, 'scalper.db'), dataDir });
  const taskRows = await (tasks ?? ownedState.tasks).list();
  ownedState?.close();
  const events = allEvents.filter((event) => Number(event.timestamp) >= since && Number(event.timestamp) <= now);
  const orders = allOrders.filter((order) => Number(order.timestamp) >= since && Number(order.timestamp) <= now);
  const cycles = events.filter((event) => event.type === 'discovery-cycle');
  const deliveryEvents = events.filter((event) => event.type === 'alert-delivery');
  const executions = events.filter((event) => event.type === 'discovery-execution');
  const signals = events.filter((event) => event.type === 'signal-inbox-message');
  const sourceFailures = {};
  for (const cycle of cycles) {
    for (const failure of cycle.errors ?? []) sourceFailures[failure.source] = (sourceFailures[failure.source] ?? 0) + 1;
  }
  const sourceChecks = cycles.reduce((total, cycle) => total + Number(cycle.sources ?? 0) + (cycle.errors?.length ?? 0), 0);
  const sourceFailureCount = Object.values(sourceFailures).reduce((total, count) => total + count, 0);
  const terminalTasks = taskRows.filter((task) => Number(task.updatedAt) >= since);
  const taskLatency = (state) => terminalTasks.flatMap((task) => {
    const event = task.events?.find((value) => value.state === state);
    return event && Number.isFinite(Number(event.at)) ? [Math.max(0, Number(event.at) - Number(task.createdAt))] : [];
  });
  const paperKeys = orders.map((order) => `${order.site}:${order.product}`);
  const duplicatePaperOrders = paperKeys.length - new Set(paperKeys).size;
  const heartbeatAt = Number(runtime?.heartbeatAt);
  const running = Boolean(runtime && Number.isFinite(heartbeatAt) && now - heartbeatAt <= heartbeatStaleMs && !runtime.stoppedAt);
  const alertCounts = { delivered: 0, failed: 0, notConfigured: 0 };
  for (const event of deliveryEvents) {
    if (event.outcome === 'delivered') alertCounts.delivered += 1;
    else if (event.outcome === 'not-configured') alertCounts.notConfigured += 1;
    else alertCounts.failed += 1;
  }
  const issues = [];
  if (!running) issues.push({ code: 'runtime-heartbeat-stale', detail: runtime ? `${Math.max(0, now - heartbeatAt)}ms old` : 'missing' });
  if (sourceChecks && sourceFailureCount / sourceChecks > 0.1) issues.push({ code: 'source-failure-rate', detail: `${sourceFailureCount}/${sourceChecks}` });
  if (alertCounts.failed) issues.push({ code: 'alert-delivery-failures', detail: String(alertCounts.failed) });
  if (duplicatePaperOrders) issues.push({ code: 'duplicate-paper-orders', detail: String(duplicatePaperOrders) });
  const uncertain = terminalTasks.filter((task) => task.state === 'uncertain').length;
  if (uncertain) issues.push({ code: 'uncertain-orders', detail: String(uncertain) });
  return {
    version: 1,
    generatedAt: now,
    window: { since, until: now, durationMs: Math.max(0, now - since) },
    status: issues.length ? 'degraded' : 'healthy',
    issues,
    runtime: {
      running,
      startedAt: runtime?.startedAt ?? null,
      heartbeatAt: runtime?.heartbeatAt ?? null,
      uptimeMs: runtime?.startedAt && runtime?.heartbeatAt ? Math.max(0, runtime.heartbeatAt - runtime.startedAt) : 0,
      mode: runtime?.mode ?? null,
      discordConnected: runtime?.discordConnected ?? false,
      signalInbox: runtime?.signalInbox ?? false,
    },
    discovery: {
      cycles: cycles.length,
      sourceChecks,
      sourceFailures: sourceFailureCount,
      sourceFailureRate: sourceChecks ? sourceFailureCount / sourceChecks : 0,
      failuresBySource: sourceFailures,
      currentSources: Object.keys(discovery?.sources ?? {}).length,
      currentItems: Object.values(discovery?.sources ?? {}).reduce((total, source) => total + (source.items?.length ?? 0), 0),
      transitions: cycles.reduce((total, cycle) => total + Number(cycle.transitions ?? cycle.alerts ?? 0), 0),
    },
    signals: {
      imported: signals.length,
      matched: signals.filter((event) => event.matched).length,
      rejected: signals.filter((event) => event.error).length,
    },
    alerts: alertCounts,
    executions: {
      total: executions.length,
      duplicatesSuppressed: executions.filter((event) => event.status === 'duplicate-suppressed').length,
      byStatus: Object.fromEntries([...new Set(executions.map((event) => event.status))].map((status) => [status, executions.filter((event) => event.status === status).length])),
    },
    paperOrders: {
      count: orders.length,
      duplicates: duplicatePaperOrders,
      bySite: Object.fromEntries([...new Set(orders.map((order) => order.site))].map((site) => [site, orders.filter((order) => order.site === site).length])),
      latency: summarizeLatencies(orders.map((order) => order.simulatedLatencyMs)),
    },
    tasks: {
      updated: terminalTasks.length,
      paperConfirmed: terminalTasks.filter((task) => task.state === 'paper-confirmed').length,
      failed: terminalTasks.filter((task) => task.state === 'failed').length,
      blocked: terminalTasks.filter((task) => task.state === 'blocked').length,
      uncertain,
      latency: {
        detectionToAuthorized: summarizeLatencies(taskLatency('authorized')),
        detectionToSubmitting: summarizeLatencies(taskLatency('submitting')),
        detectionToTerminal: summarizeLatencies(terminalTasks.flatMap((task) => {
          const event = [...(task.events ?? [])].reverse().find((value) => ['purchased', 'paper-confirmed', 'failed', 'uncertain', 'blocked'].includes(value.state));
          return event && Number.isFinite(Number(event.at)) ? [Math.max(0, Number(event.at) - Number(task.createdAt))] : [];
        })),
      },
    },
  };
}

export async function writeOperationsReport(report, { dataDir = 'data/scalper' } = {}) {
  const day = new Date(report.generatedAt).toISOString().slice(0, 10);
  const reportDir = join(dataDir, 'reports');
  const path = join(reportDir, `${day}.json`);
  await atomicJson(path, report);
  await atomicJson(join(reportDir, 'latest.json'), report);
  return path;
}

export async function rotateFile(path, { maxBytes = 5 * 1024 * 1024, maxArchives = 5 } = {}) {
  let size;
  try { size = (await stat(path)).size; } catch (error) {
    if (error?.code === 'ENOENT') return { rotated: false, reason: 'missing' };
    throw error;
  }
  if (size < maxBytes) return { rotated: false, reason: 'below-limit', size };
  await unlink(`${path}.${maxArchives}`).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  for (let index = maxArchives - 1; index >= 1; index -= 1) {
    await rename(`${path}.${index}`, `${path}.${index + 1}`).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  }
  await rename(path, `${path}.1`);
  return { rotated: true, size, archive: `${path}.1` };
}

export async function rotateOperationalLogs({ dataDir = 'data/scalper', maxBytes, maxArchives } = {}) {
  const names = ['operations-events.jsonl', 'paper-orders.jsonl', 'discord-drops.jsonl', 'launchd.out.log', 'launchd.err.log', 'discovery-launchd.out.log', 'discovery-launchd.err.log', 'operations-launchd.out.log', 'operations-launchd.err.log'];
  return Promise.all(names.map(async (name) => ({ name, ...await rotateFile(join(dataDir, name), { maxBytes, maxArchives }) })));
}

export async function notifyReportIssues(report, {
  alerts, dataDir = 'data/scalper', now = Date.now(), cooldownMs = 6 * 60 * 60_000,
} = {}) {
  const path = join(dataDir, 'failure-alert-state.json');
  const previous = await readJson(path, {});
  const fingerprint = report.issues.map((item) => `${item.code}:${item.detail}`).sort().join('|');
  if (!fingerprint) {
    if (previous.fingerprint) await alerts?.send?.('operations-recovered', { previous: previous.fingerprint });
    await atomicJson(path, { version: 1, fingerprint: '', updatedAt: now });
    return { sent: Boolean(previous.fingerprint), recovered: Boolean(previous.fingerprint) };
  }
  if (previous.fingerprint === fingerprint && now - Number(previous.sentAt ?? 0) < cooldownMs) return { sent: false, reason: 'cooldown' };
  await alerts?.send?.('operations-degraded', { issues: report.issues.map((item) => item.code).join(', '), reportGeneratedAt: report.generatedAt });
  await atomicJson(path, { version: 1, fingerprint, sentAt: now, updatedAt: now });
  return { sent: true, recovered: false };
}

export function createOperationalEventLog(options) { return new OperationalEventLog(options); }
