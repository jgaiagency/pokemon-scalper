export function createSignalAlertHandler({ alerts, minRank = 0, metrics } = {}) {
  const threshold = Number.isFinite(Number(minRank)) ? Number(minRank) : 0;
  return async (signal, rank = 0) => {
    const numericRank = Number(rank) || 0;
    if (numericRank < threshold) {
      metrics?.increment?.('discord_signal_alerts', { outcome: 'suppressed', site: signal?.site ?? 'unknown' });
      return { delivered: false, reason: 'below-rank-threshold', rank: numericRank, minRank: threshold };
    }
    metrics?.increment?.('discord_signal_alerts', { outcome: 'paged', site: signal?.site ?? 'unknown' });
    return alerts?.dropDetected?.({ signal, rank: numericRank });
  };
}
