export async function runHealthCheck({ clock, accounts, calendar, metrics, ledger, tasks, challengeBroker, dryRun, env = process.env, now = Date.now } = {}) {
  if (!clock || !accounts || !calendar) throw new Error('Health check requires clock, accounts, and calendar');
  const timestamp = now();
  const driftMs = clock.driftMs();
  const accountList = await accounts.allAccounts();
  let valid = 0;
  let invalid = 0;
  const accountDetails = [];
  for (const account of accountList) {
    const session = await accounts.loadSession(account);
    const sessionValid = Boolean(session) && (!session.expiresAt || session.expiresAt > timestamp);
    if (sessionValid) valid += 1;
    else invalid += 1;
    accountDetails.push({ id: account.id, site: account.site, configured: Boolean(account.email) && !account.email.startsWith('replace-me'), sessionValid });
  }
  const configured = accountDetails.filter((account) => account.configured).length;
  const recentDrops = (await calendar.allDrops()).filter((drop) => Math.abs(Date.parse(drop.time) - timestamp) <= 24 * 60 * 60_000);
  const report = {
    timestamp,
    mode: (dryRun?.isLive?.() ?? env.SCALPER_LIVE === '1') ? 'live' : 'paper',
    clock: { synchronized: clock.isSynchronized(), driftMs, ok: clock.isSynchronized() && Math.abs(driftMs) <= 100 },
    accounts: { total: accountList.length, configured, details: accountDetails },
    sessions: { valid, invalid },
    recentDrops,
    ...(metrics?.snapshot ? { metrics: metrics.snapshot() } : {}),
  };
  if (ledger?.records) {
    const records = await ledger.records();
    report.purchaseLedger = {
      total: records.length,
      reserved: records.filter((record) => record.status === 'reserved').length,
      purchased: records.filter((record) => record.status === 'purchased').length,
      failed: records.filter((record) => record.status === 'failed').length,
      uncertain: records.filter((record) => record.status === 'uncertain').length,
    };
  }
  if (tasks?.list) {
    const taskList = await tasks.list();
    report.purchaseTasks = {
      total: taskList.length,
      active: taskList.filter((task) => !['purchased', 'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled'].includes(task.state)).length,
      awaitingHuman: taskList.filter((task) => task.state === 'awaiting-human').length,
      uncertain: taskList.filter((task) => task.state === 'uncertain').length,
    };
  }
  if (challengeBroker?.list) {
    const challengeList = await challengeBroker.list({ status: 'pending' });
    report.challenges = { pending: challengeList.length };
  }
  report.operationalOk = report.clock.ok
    && (report.purchaseLedger?.uncertain ?? 0) === 0
    && (report.purchaseTasks?.uncertain ?? 0) === 0;
  report.liveReady = report.operationalOk
    && configured === accountList.length
    && accountList.length > 0
    && invalid === 0;
  report.ok = report.mode === 'live' ? report.liveReady : report.operationalOk;
  return report;
}

export function createHealthCheck(dependencies) {
  return () => runHealthCheck(dependencies);
}
