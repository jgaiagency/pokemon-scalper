export const NTP_SOURCES = Object.freeze([
  'pool.ntp.org',
  'time.apple.com',
  'time.cloudflare.com',
]);

const hrtimeMs = () => Number(process.hrtime.bigint()) / 1_000_000;

export class SynchronizedClock {
  #transport;
  #sources;
  #wallNow;
  #monotonicNow;
  #alert;
  #logger;
  #intervalMs;
  #timer = null;
  #offsetMs = 0;
  #anchorEpochMs;
  #anchorMonotonicMs;
  #stats = null;

  constructor({
    transport,
    sources = NTP_SOURCES,
    wallNow = Date.now,
    monotonicNow = hrtimeMs,
    alert,
    logger = console,
    intervalMs = 30_000,
  } = {}) {
    this.#transport = transport;
    this.#sources = [...sources];
    this.#wallNow = wallNow;
    this.#monotonicNow = monotonicNow;
    this.#alert = alert;
    this.#logger = logger;
    this.#intervalMs = intervalMs;
    this.#anchorEpochMs = wallNow();
    this.#anchorMonotonicMs = monotonicNow();
    if (this.#sources.length < 3) throw new Error('Clock sync requires at least 3 NTP sources');
  }

  now() {
    return this.#anchorEpochMs + (this.#monotonicNow() - this.#anchorMonotonicMs);
  }

  driftMs() {
    return this.#offsetMs;
  }

  stats() {
    return this.#stats ? { ...this.#stats, samples: [...this.#stats.samples] } : null;
  }

  isSynchronized() {
    return this.#stats !== null;
  }

  async syncOnce() {
    if (!this.#transport?.query) {
      throw new Error('An NTP transport with query(source) must be injected');
    }
    const settled = await Promise.allSettled(this.#sources.map(async (source) => {
      const sample = await this.#transport.query(source);
      if (!Number.isFinite(sample?.offsetMs) || !Number.isFinite(sample?.roundTripMs)) {
        throw new Error(`Invalid NTP sample from ${source}`);
      }
      return { source, offsetMs: sample.offsetMs, roundTripMs: sample.roundTripMs };
    }));
    const samples = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    if (samples.length === 0) throw new AggregateError(settled.map((item) => item.reason).filter(Boolean), 'All NTP sources failed');

    const best = samples.reduce((current, sample) => sample.roundTripMs < current.roundTripMs ? sample : current);
    const mean = samples.reduce((sum, sample) => sum + sample.offsetMs, 0) / samples.length;
    const jitterMs = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample.offsetMs - mean) ** 2), 0) / samples.length);
    this.#offsetMs = best.offsetMs;
    this.#anchorEpochMs = this.#wallNow() + best.offsetMs;
    this.#anchorMonotonicMs = this.#monotonicNow();
    this.#stats = { source: best.source, offsetMs: best.offsetMs, jitterMs, sampledAt: this.#anchorEpochMs, samples };

    if (Math.abs(best.offsetMs) > 100) {
      const event = { type: 'clock-drift', driftMs: best.offsetMs, jitterMs, source: best.source };
      this.#logger?.warn?.(`Clock drift is ${best.offsetMs} ms (${best.source})`);
      await this.#alert?.(event);
    }
    return this.stats();
  }

  async start() {
    await this.syncOnce();
    if (this.#timer === null) {
      this.#timer = setInterval(() => {
        this.syncOnce().catch((error) => this.#logger?.warn?.('NTP sync failed', error));
      }, this.#intervalMs);
      this.#timer.unref?.();
    }
    return this;
  }

  stop() {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}

export function createClock(options) {
  return new SynchronizedClock(options);
}
