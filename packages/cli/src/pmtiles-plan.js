import { isLayerInZoomRange } from './manifest.js';

// Bound JS memory by interval records, never by geographic area or tile count.
const MAX_INTERVALS = 50_000;

/**
 * Stream visible feature envelopes and union their conservative tile ranges.
 * Intervals are stored per x column, sorted and merged without enumerating y
 * tiles. Long lines/large polygons keep their bbox overestimate. Exceeding the
 * budget abandons this zoom's plan and uses the existing bounded RTree walk.
 * The reader includes every eligible source, preserving OSM aliases/labels.
 *
 * @param {ReturnType<import('./gpkg-read.js').openGeoPackageReader>} reader
 * @param {number} zoom
 * @param {{minX:number,minY:number,maxX:number,maxY:number,tileCount:number}} coverage
 * @param {(bbox: number[], z: number) => typeof coverage} rangeForBbox
 * @param {{mode?: 'rtree'|'bbox', maxIntervals?: number}} [options]
 */
export function createSparseTilePlan(reader, zoom, coverage, rangeForBbox, options = {}) {
  let extentCount = 0, intervalCount = 0;
  const fallback = (reason) => ({
    ranges: [coverage], tileCount: coverage.tileCount, mode: 'bbox', reason, extentCount, intervalCount
  });
  if (options.mode === 'bbox') return fallback('requested');
  const sources = reader.getLayers();
  if (sources.some((layer) => !layer.exists || !layer.rtree)) return fallback('missing-source-index');
  const limit = options.maxIntervals ?? MAX_INTERVALS;
  const columns = new Map();
  for (const layer of sources) {
    if (!isLayerInZoomRange(layer, zoom)) continue;
    for (const bounds of reader.iterateFeatureBounds(String(layer.id), zoom)) {
      extentCount++;
      const bbox = [bounds.minx, bounds.miny, bounds.maxx, bounds.maxy];
      if (!bbox.every(Number.isFinite) || bbox[0] > bbox[2] || bbox[1] > bbox[3]) return fallback('invalid-extent');
      const range = rangeForBbox(bbox, zoom);
      const minX = Math.max(coverage.minX, range.minX), maxX = Math.min(coverage.maxX, range.maxX);
      const minY = Math.max(coverage.minY, range.minY), maxY = Math.min(coverage.maxY, range.maxY);
      if (minX > maxX || minY > maxY) continue;
      if (intervalCount + maxX - minX + 1 > limit) return fallback('interval-budget');
      for (let x = minX; x <= maxX; x++) {
        if (!columns.has(x)) columns.set(x, []);
        columns.get(x).push([minY, maxY]);
        intervalCount++;
      }
    }
  }
  const ranges = [];
  let tileCount = 0;
  for (const x of [...columns.keys()].sort((a, b) => a - b)) {
    const intervals = columns.get(x).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [min, max] of intervals) {
      const previous = merged.at(-1);
      if (previous && min <= previous[1] + 1) previous[1] = Math.max(previous[1], max);
      else merged.push([min, max]);
    }
    for (const [minY, maxY] of merged) {
      const count = maxY - minY + 1;
      ranges.push({ minX: x, maxX: x, minY, maxY, tileCount: count });
      tileCount += count;
    }
  }
  return { ranges, tileCount, mode: 'rtree', extentCount, intervalCount };
}
