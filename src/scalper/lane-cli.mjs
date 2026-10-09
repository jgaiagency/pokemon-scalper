const TERMINAL = new Set(['purchased', 'paper-confirmed', 'missed', 'cancelled']);

function chronological(a, b) {
  const left = Date.parse(a.time);
  const right = Date.parse(b.time);
  if (!Number.isFinite(left)) return 1;
  if (!Number.isFinite(right)) return -1;
  return left - right;
}

export async function runSiteLane({ site, dropId, createScalper: create } = {}) {
  if (!site) throw new Error('Site lane CLI requires a site');
  const factory = create ?? (await import('./wiring.mjs')).createScalper;
  const scalper = await factory({
    connectDiscord: false,
    liveSites: [site],
    ...(dropId ? { liveDropIds: [dropId] } : {}),
  });
  try {
    const drops = (await scalper.calendar.allDrops())
      .filter((drop) => drop.sites?.includes(site) && !TERMINAL.has(drop.status))
      .sort(chronological);
    const drop = dropId ? drops.find((candidate) => candidate.id === dropId) : drops[0];
    if (dropId && !drop) {
      const error = new Error(`No active ${site} drop has id ${dropId}`);
      error.code = 'SCALPER_DROP_NOT_FOUND';
      throw error;
    }
    if (!drop) return { status: 'no-configured-drops', site };
    return await scalper.orchestrator.runDrop(drop, { site });
  } finally {
    await scalper.stop();
  }
}

export default runSiteLane;
