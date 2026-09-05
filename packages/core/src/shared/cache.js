/** Bounded least-recently-used cache. Eviction releases references, not images
 * that may still be in use by a renderer. Rejected loads can be retried. */
export class LruCache extends Map {
  constructor(limit = 128) {
    super();
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Cache limit must be a positive integer');
    this.limit = limit;
  }

  get(key) {
    if (!super.has(key)) return undefined;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value);
    return value;
  }

  set(key, value) {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.limit) super.delete(this.keys().next().value);
    return this;
  }
}

export function cachedPromise(cache, key, load) {
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(load).catch((error) => {
    if (cache.get(key) === promise) cache.delete(key);
    throw error;
  });
  cache.set(key, promise);
  return promise;
}
