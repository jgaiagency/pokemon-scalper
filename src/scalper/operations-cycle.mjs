import { fileURLToPath } from 'node:url';
import { AlertManager } from './alerts.mjs';
import { loadEnvFile } from './env.mjs';
import {
  OperationalEventLog,
  generateOperationsReport,
  notifyReportIssues,
  rotateOperationalLogs,
  writeOperationsReport,
} from './operations.mjs';
import { createHttpTransport } from './transports/http.mjs';

export async function runOperationsCycle({ env = process.env, now = Date.now() } = {}) {
  const dataDir = env.SCALPER_DATA_DIR || 'data/scalper';
  const events = new OperationalEventLog({ path: `${dataDir}/operations-events.jsonl` });
  const http = createHttpTransport();
  const alerts = new AlertManager({
    webhookUrl: env.SCALPER_ALERT_WEBHOOK_URL || env.SCALPER_DISCORD_WEBHOOK_URL,
    transport: http,
    events,
  });
  const report = await generateOperationsReport({ dataDir, now });
  const reportPath = await writeOperationsReport(report, { dataDir });
  let notification;
  try { notification = await notifyReportIssues(report, { alerts, dataDir, now }); } catch (error) {
    notification = { sent: false, error: error.message, code: error.code };
  }
  const rotation = await rotateOperationalLogs({
    dataDir,
    maxBytes: Number(env.SCALPER_LOG_MAX_BYTES || 5 * 1024 * 1024),
    maxArchives: Number(env.SCALPER_LOG_ARCHIVES || 5),
  });
  await events.record('operations-cycle', { status: report.status, reportPath, notification, rotated: rotation.filter((item) => item.rotated).map((item) => item.name) });
  return { reportPath, report, notification, rotation };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  console.log(JSON.stringify(await runOperationsCycle(), null, 2));
}
