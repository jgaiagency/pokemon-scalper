import { abortableDelay } from './timing.mjs';
import { isRetailerUrl } from './retail-url-policy.mjs';

const RETRYABLE_CODES = new Set([
  'SCALPER_RATE_LIMITED', 'SCALPER_BACKOFF', 'SCALPER_CIRCUIT_OPEN',
  'SCALPER_THROTTLED', 'SCALPER_SERVER_ERROR', 'SCALPER_POLL_TIMEOUT', 'SCALPER_TRANSPORT_ERROR',
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function classifyResponse(response) {
  const status = Number(response?.status);
  if (status === 403 || status === 429) return 'throttled';
  if (status >= 500 && status <= 599) return 'server-error';
  if (status >= 400 && status <= 499) return 'client-error';
  return 'ok';
}

export function retryAfterMs(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

export class TokenBucket {
  constructor({ ratePerSecond, capacity = ratePerSecond, now = Date.now } = {}) {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) throw new RangeError('Token bucket ratePerSecond must be positive');
    if (!Number.isFinite(capacity) || capacity < 1) throw new RangeError('Token bucket capacity must be at least one');
    Object.assign(this, { ratePerSecond, capacity, now });
    this.tokens = capacity;
    this.updatedAt = now();
  }

  #refill() {
    const timestamp = this.now();
    const elapsed = Math.max(0, timestamp - this.updatedAt);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.ratePerSecond / 1_000));
    this.updatedAt = timestamp;
  }

  tryTake() {
    this.#refill();
    if (this.tokens < 1) return { allowed: false, retryAfterMs: Math.ceil((1 - this.tokens) * 1_000 / this.ratePerSecond) };
    this.tokens -= 1;
    return { allowed: true, retryAfterMs: 0 };
  }
}

export class CircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 30_000, now = Date.now } = {}) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new RangeError('Circuit breaker threshold must be positive');
    Object.assign(this, { failureThreshold, cooldownMs, now });
    this.failures = 0;
    this.openUntil = 0;
    this.halfOpenProbe = false;
  }

  allow() {
    const timestamp = this.now();
    if (!this.openUntil) return { allowed: true, state: 'closed', retryAfterMs: 0 };
    if (timestamp < this.openUntil) return { allowed: false, state: 'open', retryAfterMs: this.openUntil - timestamp };
    if (this.halfOpenProbe) return { allowed: false, state: 'half-open', retryAfterMs: this.cooldownMs };
    this.halfOpenProbe = true;
    return { allowed: true, state: 'half-open', retryAfterMs: 0 };
  }

  success() {
    this.failures = 0;
    this.openUntil = 0;
    this.halfOpenProbe = false;
  }

  failure() {
    this.failures += 1;
    if (this.halfOpenProbe || this.failures >= this.failureThreshold) {
      this.openUntil = this.now() + this.cooldownMs;
      this.halfOpenProbe = false;
    }
  }

  stats() {
    const state = !this.openUntil ? 'closed' : this.now() < this.openUntil ? 'open' : 'half-open';
    return { state, failures: this.failures, openUntil: this.openUntil };
  }
}

function trafficError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export class TrafficGovernor {
  constructor({
    policies = {}, now = Date.now, timeoutMs = 5_000, baseBackoffMs = 1_000,
    maxBackoffMs = 30_000, failureThreshold = 3, cooldownMs = 30_000,
    timeoutSignal = (ms) => AbortSignal.timeout(ms),
  } = {}) {
    Object.assign(this, { policies, now, timeoutMs, baseBackoffMs, maxBackoffMs, failureThreshold, cooldownMs, timeoutSignal });
    this.sites = new Map();
  }

  #site(site) {
    if (this.sites.has(site)) return this.sites.get(site);
    const ratePerSecond = Number(this.policies[site]?.maxRequestsPerSecond);
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) throw new Error(`No traffic policy is configured for ${site}`);
    const state = {
      bucket: new TokenBucket({ ratePerSecond, capacity: Math.max(1, Math.ceil(ratePerSecond)), now: this.now }),
      breaker: new CircuitBreaker({ failureThreshold: this.failureThreshold, cooldownMs: this.cooldownMs, now: this.now }),
      consecutiveFailures: 0,
      notBefore: 0,
    };
    this.sites.set(site, state);
    return state;
  }

  async request(site, operation, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (typeof operation !== 'function') throw new TypeError('Traffic-governed request requires an operation');
    const state = this.#site(site);
    const backoff = Math.max(0, state.notBefore - this.now());
    if (backoff > 0) throw trafficError(`${site} is backing off`, 'SCALPER_BACKOFF', { classification: 'throttled', retryAfterMs: backoff });
    const token = state.bucket.tryTake();
    if (!token.allowed) throw trafficError(`${site} shared request budget is exhausted`, 'SCALPER_RATE_LIMITED', {
      classification: 'throttled', retryAfterMs: token.retryAfterMs,
    });
    const breaker = state.breaker.allow();
    if (!breaker.allowed) throw trafficError(`${site} circuit is ${breaker.state}`, 'SCALPER_CIRCUIT_OPEN', {
      classification: 'throttled', retryAfterMs: breaker.retryAfterMs,
    });

    const timeout = this.timeoutSignal?.(timeoutMs);
    const requestSignal = signal && timeout && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
    let response;
    try {
      response = await operation(requestSignal);
    } catch (cause) {
      if (['SCALPER_UNSAFE_URL', 'SCALPER_UNSAFE_REDIRECT', 'SCALPER_REDIRECT_LIMIT', 'SCALPER_REDIRECT_REMEASURE'].includes(cause?.code)) throw cause;
      state.consecutiveFailures += 1;
      const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** (state.consecutiveFailures - 1)));
      state.notBefore = this.now() + delay;
      if (breaker.state === 'half-open') state.breaker.failure();
      if (cause?.name === 'TimeoutError') {
        throw trafficError(`${site} request timed out after ${timeoutMs} ms`, 'SCALPER_POLL_TIMEOUT', {
          cause, classification: 'server-error', retryAfterMs: delay,
        });
      }
      throw trafficError(`${site} request failed`, 'SCALPER_TRANSPORT_ERROR', {
        cause, classification: 'server-error', retryAfterMs: delay,
      });
    }

    const classification = classifyResponse(response);
    if (classification === 'ok') {
      state.consecutiveFailures = 0;
      state.notBefore = 0;
      state.breaker.success();
      return response;
    }
    if (classification === 'client-error') {
      state.breaker.success();
      throw trafficError(`${site} returned HTTP ${response.status}`, 'SCALPER_CLIENT_ERROR', { classification, response, retryAfterMs: 0 });
    }

    state.consecutiveFailures += 1;
    const exponential = Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** (state.consecutiveFailures - 1)));
    const retryHeader = response?.headers?.['retry-after'] ?? response?.headers?.get?.('retry-after');
    const delay = Math.max(exponential, retryAfterMs(retryHeader, this.now()));
    state.notBefore = this.now() + delay;
    if (response.status === 429 || Number(response.status) >= 500) state.breaker.failure();
    throw trafficError(`${site} returned HTTP ${response.status}`, classification === 'throttled' ? 'SCALPER_THROTTLED' : 'SCALPER_SERVER_ERROR', {
      classification, response, retryAfterMs: delay,
    });
  }

  httpFor(site, http) {
    if (!http?.request && !http?.get) throw new Error('Traffic governor requires an HTTP transport');
    const assertRetailerUrl = (url) => {
      if (!isRetailerUrl(url, site)) throw trafficError(`${site} request URL is outside the retailer allowlist`, 'SCALPER_UNSAFE_URL');
      return new URL(url);
    };
    const guardedGet = async (url, options, signal) => {
      let current = assertRetailerUrl(url);
      for (let hop = 0; hop <= 3; hop += 1) {
        const response = await http.get(current.href, { ...options, signal, redirect: 'manual' });
        const location = response?.headers?.location ?? response?.headers?.get?.('location');
        if (!REDIRECT_STATUSES.has(response?.status) || !location) {
          if (response?.url && !isRetailerUrl(response.url, site)) {
            throw trafficError(`${site} response escaped the retailer allowlist`, 'SCALPER_UNSAFE_REDIRECT');
          }
          return response;
        }
        const destination = new URL(location, current);
        if (!isRetailerUrl(destination.href, site)) {
          throw trafficError(`${site} redirect escaped the retailer allowlist`, 'SCALPER_UNSAFE_REDIRECT');
        }
        if (hop === 3) throw trafficError(`${site} exceeded the redirect limit`, 'SCALPER_REDIRECT_LIMIT');
        current = destination;
      }
      throw trafficError(`${site} exceeded the redirect limit`, 'SCALPER_REDIRECT_LIMIT');
    };
    const guardedRequest = async (input, signal) => {
      if (!http.request) throw new Error('Traffic-governed non-GET requests require the generic HTTP request transport');
      const current = assertRetailerUrl(input?.url);
      const response = await http.request({ ...input, url: current.href, signal, redirect: 'manual' });
      const location = response?.headers?.location ?? response?.headers?.get?.('location');
      if (REDIRECT_STATUSES.has(response?.status) && location) {
        const destination = new URL(location, current);
        if (!isRetailerUrl(destination.href, site)) {
          throw trafficError(`${site} redirect escaped the retailer allowlist`, 'SCALPER_UNSAFE_REDIRECT');
        }
        throw trafficError(`${site} mutating endpoint redirected; remeasure its canonical URL`, 'SCALPER_REDIRECT_REMEASURE');
      }
      if (response?.url && !isRetailerUrl(response.url, site)) {
        throw trafficError(`${site} response escaped the retailer allowlist`, 'SCALPER_UNSAFE_REDIRECT');
      }
      return response;
    };
    const governed = {
      request: (input = {}) => this.request(site, (signal) => guardedRequest(input, signal), { signal: input.signal }),
      get: (url, options = {}) => this.request(site, (signal) => guardedGet(url, options, signal), { signal: options.signal }),
      postJson: (url, body, options = {}) => this.request(site, (signal) => guardedRequest({
        method: 'POST', url,
        headers: { 'Content-Type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
      }, signal), { signal: options.signal }),
    };
    return governed;
  }
}

export function createTrafficGovernor(options) {
  return new TrafficGovernor(options);
}

export async function pollWithGovernance({
  request, isAvailable, delayMs, mode = 'surprise', clock = { now: Date.now }, sleep = abortableDelay,
  signal, maxPolls = Infinity, maxDurationMs = Infinity, onAvailable,
} = {}) {
  const startedAt = clock.now();
  let response;
  let lastError;
  let polls = 0;
  while (polls < maxPolls && !signal?.aborted) {
    if (clock.now() - startedAt >= maxDurationMs) {
      return { available: false, status: 'expired', reason: 'watcher-expired', polls, response };
    }
    polls += 1;
    try {
      response = await request();
      lastError = null;
    } catch (error) {
      if (!RETRYABLE_CODES.has(error?.code)) throw error;
      lastError = error;
      const waitMs = Math.max(1, Number(error.retryAfterMs) || 1);
      if (clock.now() + waitMs - startedAt >= maxDurationMs) {
        return { available: false, status: 'expired', reason: 'watcher-expired', polls, response, lastError: error };
      }
      await sleep(waitMs, { signal });
      continue;
    }
    if (isAvailable(response)) {
      const result = { available: true, status: 'available', polls, response, detectedAt: clock.now() };
      await onAvailable?.(result);
      return result;
    }
    if (polls < maxPolls) {
      const waitMs = delayMs();
      if (clock.now() + waitMs - startedAt >= maxDurationMs) {
        return { available: false, status: 'expired', reason: 'watcher-expired', polls, response };
      }
      await sleep(waitMs, { signal });
    }
  }
  if (lastError) return {
    available: false,
    status: lastError.classification === 'server-error' ? 'server-error' : 'throttled',
    reason: lastError.code,
    polls,
    response,
    lastError,
  };
  return { available: false, status: 'not-in-stock', polls, response };
}
