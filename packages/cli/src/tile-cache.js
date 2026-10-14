/**
 * Small in-memory LRU cache for generated MVT tiles.
 */
export class TileCache {
  /**
   * @param {number} maxEntries
   */
  constructor(maxEntries) {
    this.maxEntries = Math.max(0, Math.floor(maxEntries));
    /** @type {Map<string, unknown>} */
    this.entries = new Map();
  }

  /**
   * @param {string} key
   * @returns {unknown | undefined}
   */
  get(key) {
    if (this.maxEntries <= 0) {
      return undefined;
    }

    const value = this.entries.get(key);
    if (value === undefined) {
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /**
   * @param {string} key
   * @param {unknown} value
   */
  set(key, value) {
    if (this.maxEntries <= 0) {
      return;
    }

    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  clear() {
    this.entries.clear();
  }
}
