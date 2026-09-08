import { decodeGeoPackageGeometry } from '../geometry-read.js';
import { quoteIdentifier } from '../utils.js';
import { resolveManifestLayers } from '../manifest.js';

const LAYER_ALIASES = {
  aviation: 'aip',
  aip: 'aviation'
};

/** RTree-backed source with half-open ownership by envelope centre. A feature
 * crossing cells is emitted once, with its complete geometry. Content encoders
 * never need to know SQL, storage columns, or deduplication rules.
 */
export function createOwnedFeatureSource(db, metadata, decorate = feature => feature) {
  const where = `r.minx <= ? AND r.maxx >= ? AND r.miny <= ? AND r.maxy >= ?
    AND (r.minx+r.maxx)/2 >= ? AND (r.minx+r.maxx)/2 < ?
    AND (r.miny+r.maxy)/2 >= ? AND (r.miny+r.maxy)/2 < ?`;
  const count = db.prepare(`SELECT count(*) n FROM ${quoteIdentifier(metadata.rtree)} r WHERE ${where}`);
  const rows = db.prepare(`SELECT f.* FROM ${quoteIdentifier(metadata.table)} f
    JOIN ${quoteIdentifier(metadata.rtree)} r ON f.rowid=r.id WHERE ${where} ORDER BY f.rowid`);
  const params = ([w,s,e,n]) => [e,w,n,s,w,e,s,n];
  return {
    count: box => count.get(...params(box)).n,
    *features(box) {
      for (const row of rows.iterate(...params(box))) {
        const feature = rowToFeature(row, metadata.geometryColumn);
        if (!feature) continue;
        feature.properties = Object.fromEntries(Object.entries(feature.properties).filter(([,value]) => !Buffer.isBuffer(value)));
        yield decorate(feature);
      }
    }
  };
}

/**
 * @typedef {{
 *   id: string,
 *   table: string,
 *   geometryColumn: string,
 *   rtree: string,
 *   bbox: [number, number, number, number]
 * }} LayerMetadata
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} manifest
 * @param {string} layerId
 * @returns {LayerMetadata}
 */
export function readLayerMetadata(db, manifest, layerId) {
  const layers = resolveManifestLayers(manifest);
  const manifestLayer = layers.find((layer) => layer.id === layerId) ??
    layers.find((layer) => layer.id === LAYER_ALIASES[layerId]);
  if (!manifestLayer) {
    throw new Error(`manifest does not contain layer: ${layerId}`);
  }

  const table = manifestLayer.table;
  const geometry = db.prepare(`
    SELECT column_name
    FROM gpkg_geometry_columns
    WHERE table_name = ?
  `).get(table);
  if (!geometry?.column_name) {
    throw new Error(`GeoPackage does not contain a geometry column for ${layerId}`);
  }

  const geometryColumn = String(geometry.column_name);
  const rtree = `rtree_${table}_${geometryColumn}`;
  const rtreeRow = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(rtree);
  if (!rtreeRow) {
    throw new Error(`GeoPackage does not contain expected RTree table ${rtree}`);
  }

  const content = db.prepare(`
    SELECT min_x, min_y, max_x, max_y
    FROM gpkg_contents
    WHERE table_name = ?
  `).get(table);
  const fallback = Array.isArray(manifest.bbox) ? manifest.bbox.map(Number) : [-180, -90, 180, 90];
  const bbox = validBbox([content?.min_x, content?.min_y, content?.max_x, content?.max_y])
    ? [Number(content.min_x), Number(content.min_y), Number(content.max_x), Number(content.max_y)]
    : /** @type {[number, number, number, number]} */ (fallback);

  return {
    ...manifestLayer,
    id: layerId,
    table,
    geometryColumn,
    rtree,
    bbox
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {LayerMetadata} metadata
 * @param {[number, number, number, number]} bbox
 * @returns {number}
 */
export function countLayerFeatures(db, metadata, bbox) {
  const [minX, minY, maxX, maxY] = bbox;
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ${quoteIdentifier(metadata.rtree)}
    WHERE minx <= ?
      AND maxx >= ?
      AND miny <= ?
      AND maxy >= ?
  `).get(maxX, minX, maxY, minY);
  return Number(row?.count ?? 0);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {LayerMetadata} metadata
 * @param {[number, number, number, number]} bbox
 * @param {{ limit?: number, seenIds?: Set<number> }} [options]
 * @returns {Array<{ type: 'Feature', geometry: Record<string, unknown>, properties: Record<string, unknown> }>}
 */
export function readLayerFeatures(db, metadata, bbox, options = {}) {
  const [minX, minY, maxX, maxY] = bbox;
  const limitClause = Number.isInteger(options.limit) && options.limit > 0 ? 'LIMIT ?' : '';
  const params = [maxX, minX, maxY, minY];
  if (limitClause) {
    params.push(Number(options.limit));
  }

  const rows = db.prepare(`
    SELECT feature_table.rowid AS __mapzero_rowid, feature_table.*
    FROM ${quoteIdentifier(metadata.table)} AS feature_table
    JOIN ${quoteIdentifier(metadata.rtree)} AS rtree_table
      ON feature_table.rowid = rtree_table.id
    WHERE rtree_table.minx <= ?
      AND rtree_table.maxx >= ?
      AND rtree_table.miny <= ?
      AND rtree_table.maxy >= ?
    ${limitClause}
  `).iterate(...params);

  const features = [];
  for (const row of rows) {
    if (options.seenIds?.has(row.__mapzero_rowid)) continue;
    options.seenIds?.add(row.__mapzero_rowid);
    const feature = rowToFeature(row, metadata.geometryColumn);
    if (feature) features.push(feature);
  }
  return features;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} geometryColumn
 * @returns {{ type: 'Feature', geometry: Record<string, unknown>, properties: Record<string, unknown> } | null}
 */
function rowToFeature(row, geometryColumn) {
  const geometry = decodeGeoPackageGeometry(/** @type {Buffer | null} */ (row[geometryColumn]));
  if (!geometry) {
    return null;
  }

  const properties = {};
  for (const [key, value] of Object.entries(row)) {
    if (key !== geometryColumn && key !== '__mapzero_rowid') {
      properties[key] = value;
    }
  }

  return {
    type: 'Feature',
    geometry,
    properties
  };
}

/**
 * @param {unknown[]} value
 * @returns {boolean}
 */
function validBbox(value) {
  return value.length === 4 &&
    value.every((part) => Number.isFinite(Number(part))) &&
    Number(value[0]) < Number(value[2]) &&
    Number(value[1]) < Number(value[3]);
}
