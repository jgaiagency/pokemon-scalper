import { fileURLToPath } from 'node:url';
import { runConfiguredDryRun } from './dry-run.mjs';
import { runHealthCheck } from './health.mjs';
import { runSiteLane } from './lane-cli.mjs';
import { createScalper as createDefaultScalper } from './wiring.mjs';

const SITE_COMMANDS = Object.freeze({
  pc: 'pokemon-center',
  tcp: 'tcgplayer',
  bb: 'bestbuy',
  tgt: 'target',
});

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function shutdownPromise(scalper) {
  return new Promise((resolve) => {
    const shutdown = () => scalper.stop().finally(resolve);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

export async function runCommand(command, args = [], {
  createScalper = createDefaultScalper,
  env = process.env,
} = {}) {
  if (SITE_COMMANDS[command]) {
    return runSiteLane({
      site: SITE_COMMANDS[command],
      dropId: optionValue(args, '--drop-id'),
      createScalper,
    });
  }

  const scalper = await createScalper({ connectDiscord: command === 'watch' || command === 'discord' });
  if (command === 'watch') {
    await scalper.tasks?.markInterrupted?.({ olderThanMs: 0 });
    await scalper.challengeBroker?.expireInactive?.();
    const stopped = shutdownPromise(scalper);
    await Promise.race([scalper.orchestrator.watch(), stopped]);
    return { status: 'stopped' };
  }
  if (command === 'discord') {
    if (!scalper.discordConnected) {
      await scalper.stop();
      return { status: 'disabled', reason: 'SCALPER_DISCORD_BOT_TOKEN is not configured' };
    }
    await shutdownPromise(scalper);
    return { status: 'stopped' };
  }
  try {
    if (command === 'dry') {
      return await runConfiguredDryRun({
        calendar: scalper.calendar,
        dryRun: scalper.dryRun,
        orchestrator: scalper.orchestrator,
        env,
      });
    }
    if (command === 'health') return await runHealthCheck(scalper);
    throw new Error(`Unknown scalper command: ${command ?? '(missing)'}`);
  } finally {
    await scalper.stop();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runCommand(process.argv[2], process.argv.slice(3));
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  if (process.argv[2] === 'health' && result?.ok === false) process.exitCode = 1;
}
