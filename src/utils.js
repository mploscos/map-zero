import { basename, extname } from 'node:path';

export { geometryBbox, pointInRing } from '../packages/core/src/geometry.js';

/**
 * Parse and validate a bbox string.
 *
 * @param {string} value minLon,minLat,maxLon,maxLat
 * @returns {[number, number, number, number]}
 */
export function parseBbox(value) {
  const parts = String(value).split(',').map((part) => Number(part.trim()));

  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error('bbox must use the format minLon,minLat,maxLon,maxLat');
  }

  const [minLon, minLat, maxLon, maxLat] = parts;

  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new Error('bbox coordinates must be valid WGS84 lon/lat values');
  }

  if (minLon >= maxLon || minLat >= maxLat) {
    throw new Error('bbox is inverted; minLon/minLat must be smaller than maxLon/maxLat');
  }

  return /** @type {[number, number, number, number]} */ (parts);
}

/**
 * Parse and validate a comma-separated layer list.
 *
 * @param {string} value
 * @param {string[]} supportedLayers
 * @param {Record<string, string>} [aliases]
 * @returns {string[]}
 */
export function parseLayerList(value, supportedLayers, aliases = {}) {
  const layers = String(value)
    .split(',')
    .map((layer) => layer.trim())
    .map((layer) => aliases[layer] ?? layer)
    .filter(Boolean);

  if (layers.length === 0) {
    throw new Error('at least one layer must be selected');
  }

  const supported = new Set(supportedLayers);
  const invalid = layers.filter((layer) => !supported.has(layer));

  if (invalid.length > 0) {
    throw new Error(`unsupported layer(s): ${invalid.join(', ')}`);
  }

  return [...new Set(layers)];
}

/**
 * Derive a package name from an output path.
 *
 * @param {string} outPath
 * @returns {string}
 */
export function packageNameFromPath(outPath) {
  const base = basename(outPath);
  return extname(base) === '.mapzero' ? base.slice(0, -'.mapzero'.length) : base;
}

/**
 * Check whether a coordinate is inside a bbox.
 *
 * @param {[number, number]} coordinate
 * @param {[number, number, number, number]} bbox
 * @returns {boolean}
 */
export function pointInBbox(coordinate, bbox) {
  const [lon, lat] = coordinate;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

/**
 * Check whether two bboxes intersect.
 *
 * @param {[number, number, number, number]} a
 * @param {[number, number, number, number]} b
 * @returns {boolean}
 */
export function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Remove consecutive duplicate coordinates from a line or ring.
 *
 * @param {Array<[number, number]>} coordinates
 * @returns {Array<[number, number]>}
 */
export function dedupeCoordinates(coordinates) {
  /** @type {Array<[number, number]>} */
  const deduped = [];

  for (const coordinate of coordinates) {
    const previous = deduped.at(-1);
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
      deduped.push(coordinate);
    }
  }

  return deduped;
}

/**
 * Close a polygon ring if needed.
 *
 * @param {Array<[number, number]>} coordinates
 * @returns {Array<[number, number]>}
 */
export function closeRing(coordinates) {
  const ring = dedupeCoordinates(coordinates);
  const first = ring[0];
  const last = ring.at(-1);

  if (!first || !last) {
    return ring;
  }

  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }

  return ring;
}

/**
 * Safely quote a SQLite identifier.
 *
 * @param {string} identifier
 * @returns {string}
 */
export function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}
