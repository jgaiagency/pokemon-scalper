import { config } from './config.mjs';
import { abortableDelay } from '../../timing.mjs';
import { pollWithGovernance } from '../../rate-limit.mjs';

export function isAvailable(payload) {
  const data = payload?.bodyJson ?? payload;
  return data?.availability === 'IN_STOCK' && data?.addToCartEnabled === true;
}

export function pollingDelayMs({ mode = 'surprise', untilDropMs = Infinity, random = Math.random } = {}) {
  const base = mode === 'surprise' ? config.polling.surpriseMs : untilDropMs <= 30_000 ? config.polling.fullThrottleMs : config.polling.preDropMs;
  return Math.max(1, Math.round(base * (0.9 + random() * 0.2)));
}

export async function pollForAvailability({ http, productUrl, mode = 'surprise', dropTimeMs, clock = { now: Date.now }, sleep = abortableDelay, random = Math.random, signal, maxPolls = Infinity, maxDurationMs, onAvailable } = {}) {
  if (!http?.get) throw new Error('Pokémon Center detector requires an injected HTTP transport');
  if (!productUrl) throw new Error('Pokémon Center product endpoint has not been measured');
  return pollWithGovernance({
    request: () => http.get(productUrl, { signal }), isAvailable,
    delayMs: () => pollingDelayMs({ mode, untilDropMs: dropTimeMs === undefined ? Infinity : dropTimeMs - clock.now(), random }),
    mode, clock, sleep, signal, maxPolls,
    maxDurationMs: maxDurationMs ?? (mode === 'surprise' ? config.polling.maxWatcherMs : Infinity), onAvailable,
  });
}
