export function createMetrics() {
  return {
    requested: 0,
    cacheHits: 0,
    decoded: 0,
    features: 0,
    overzoomed: 0,
    requestLevels: {},
    sourceLevels: {},
    renderMs: { total: 0, max: 0 },
    decodeMs: { total: 0, max: 0 }
  };
}

export function recordMetricTime(metrics, key, value) {
  metrics[key].total += value;
  metrics[key].max = Math.max(metrics[key].max, value);
}

export function addMetricCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}
