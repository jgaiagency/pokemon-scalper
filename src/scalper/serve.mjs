import { fileURLToPath } from 'node:url';
import { createDashboardServer, KillSwitchController } from './dashboard.mjs';
import { loadEnvFile } from './env.mjs';
import { runHealthCheck } from './health.mjs';
import { createScalper } from './wiring.mjs';
import { RuntimeHeartbeat } from './operations.mjs';
import { SignalInbox } from './signal-inbox.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';

function invoke(target, method, ...args) {
  return Promise.resolve().then(() => target?.[method]?.(...args));
}

export async function serve({
  env = process.env,
  create = createScalper,
  createDashboard = createDashboardServer,
  createHeartbeat = (options) => new RuntimeHeartbeat(options),
  createInbox = (options) => new SignalInbox(options),
  acquireLock = acquireInstanceLock,
  logger = console,
} = {}) {
  await loadEnvFile({ env });
  const dataDir = env.SCALPER_DATA_DIR || 'data/scalper';
  const lock = await acquireLock({ dataDir });
  let scalper;
  try {
    scalper = await create({ env, connectDiscord: true });
  } catch (error) {
    await lock.release();
    throw error;
  }
  let dashboard;
  let inbox;
  let heartbeat;
  try {
    const interrupted = await scalper.tasks?.markInterrupted?.({ olderThanMs: 0 }) ?? [];
    const expiredChallenges = await scalper.challengeBroker?.expireInactive?.() ?? [];
    dashboard = createDashboard({
      env,
      host: env.SCALPER_DASHBOARD_HOST || '127.0.0.1',
      port: Number(env.SCALPER_DASHBOARD_PORT || 4317),
      authToken: env.SCALPER_DASHBOARD_TOKEN,
      healthCheck: () => runHealthCheck(scalper),
      tasks: scalper.tasks,
      challenges: scalper.challengeBroker,
      ledger: scalper.ledger,
      killSwitch: new KillSwitchController({ env }),
    });
    const address = await dashboard.start();
    logger.log(`Scalper control dashboard: ${address.url}`);
    const inboxEnabled = env.SCALPER_SIGNAL_INBOX !== '0';
    inbox = inboxEnabled && scalper.discordFeed?.handleMessage && scalper.discordConfig
      ? createInbox({
        path: env.SCALPER_SIGNAL_INBOX_PATH || `${dataDir}/inbox/discord.jsonl`,
        cursorPath: `${dataDir}/inbox/cursor.json`,
        feed: scalper.discordFeed,
        guildId: scalper.discordConfig.guildId,
        channelId: scalper.discordConfig.channelIds?.[0],
        events: scalper.events,
        env,
      })
      : null;
    await inbox?.start?.();
    heartbeat = createHeartbeat({ path: `${dataDir}/runtime-state.json` });
    await heartbeat.start({
      mode: env.SCALPER_LIVE === '1' ? 'live' : 'paper',
      killSwitch: env.SCALPER_KILL_SWITCH === '1',
      discordConnected: scalper.discordConnected,
      signalInbox: Boolean(inbox),
    });
    await scalper.events?.record?.('service-start', {
      mode: env.SCALPER_LIVE === '1' ? 'live' : 'paper',
      discordConnected: scalper.discordConnected,
      signalInbox: Boolean(inbox),
    });
    await scalper.events?.record?.('restart-reconciliation', {
      success: true,
      interruptedTasks: interrupted.length,
      expiredChallenges: expiredChallenges.length,
    });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await Promise.allSettled([
          invoke(inbox, 'stop'),
          invoke(heartbeat, 'stop'),
          invoke(scalper.events, 'record', 'service-stop'),
        ]);
        await Promise.allSettled([
          invoke(dashboard, 'stop'),
          invoke(scalper, 'stop'),
        ]);
      } finally {
        await lock.release();
      }
    };
    const shutdown = new Promise((resolve) => {
      const requested = () => stop().finally(resolve);
      process.once('SIGINT', requested);
      process.once('SIGTERM', requested);
    });
    await Promise.race([scalper.orchestrator.watch(), shutdown]);
    await stop();
    return { status: 'stopped' };
  } catch (error) {
    await Promise.allSettled([
      invoke(inbox, 'stop'),
      invoke(heartbeat, 'stop'),
      invoke(dashboard, 'stop'),
      invoke(scalper, 'stop'),
      invoke(lock, 'release'),
    ]);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await serve();
}
