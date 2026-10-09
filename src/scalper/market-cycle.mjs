import { loadEnvFile } from './env.mjs';
import { runMarketCommand } from './market-cli.mjs';

// Runs a market capture + rank cycle. Designed to be invoked by launchd
// every 6 hours (ops/market-tracker.launchd.plist). Exits 0 on success,
// 1 if capture produced errors for every source.

await loadEnvFile();
const capture = await runMarketCommand('capture');
const ranking = await runMarketCommand('rank');

const totalObservations = capture.observations?.length ?? 0;
const totalErrors = capture.errors?.length ?? 0;
const eligible = ranking.filter((product) => product.eligible).length;

console.log(JSON.stringify({
  capturedAt: capture.capturedAt,
  observations: totalObservations,
  errors: totalErrors,
  eligibleProducts: eligible,
  topProducts: ranking.slice(0, 3).map((product) => ({
    id: product.id,
    score: product.score,
    eligible: product.eligible,
    marketPrice: product.marketPrice,
    estimatedProfit: product.estimatedProfit,
  })),
}, null, 2));

if (totalObservations === 0 && totalErrors > 0) {
  console.error('All market sources failed. Check credentials in .env');
  process.exitCode = 1;
}
