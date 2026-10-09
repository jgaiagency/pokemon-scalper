function normalizeLabels(labels = {}) {
  return Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

function metricKey(name, labels) {
  return `${name}:${JSON.stringify(normalizeLabels(labels))}`;
}

export class MetricsRegistry {
  #counters = new Map();
  #histograms = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  increment(name, labels = {}, value = 1) {
    const normalized = normalizeLabels(labels);
    const key = metricKey(name, normalized);
    const current = this.#counters.get(key) ?? { name, labels: normalized, value: 0 };
    current.value += Number(value);
    this.#counters.set(key, current);
    return current.value;
  }

  observe(name, value, labels = {}) {
    if (!Number.isFinite(Number(value))) return;
    const observation = Number(value);
    const normalized = normalizeLabels(labels);
    const key = metricKey(name, normalized);
    const current = this.#histograms.get(key) ?? {
      name, labels: normalized, count: 0, sum: 0, min: Infinity, max: -Infinity,
    };
    current.count += 1;
    current.sum += observation;
    current.min = Math.min(current.min, observation);
    current.max = Math.max(current.max, observation);
    this.#histograms.set(key, current);
  }

  snapshot() {
    const counters = [...this.#counters.values()].map((metric) => structuredClone(metric));
    const histograms = [...this.#histograms.values()].map((metric) => ({
      ...structuredClone(metric), average: metric.sum / metric.count,
    }));
    const sort = (left, right) => metricKey(left.name, left.labels).localeCompare(metricKey(right.name, right.labels));
    return { timestamp: this.#now(), counters: counters.sort(sort), histograms: histograms.sort(sort) };
  }
}

export function createMetricsRegistry(options) {
  return new MetricsRegistry(options);
}
