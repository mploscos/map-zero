import { decodeGeoPackageGeometry } from '../geometry-read.js';
import { quoteIdentifier } from '../utils.js';

const LAYER_ALIASES = {
  aviation: 'aip',
  aip: 'aviation'
};

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
  const manifestLayer = Array.isArray(manifest.layers)
    ? manifest.layers.find((layer) => layer?.id === layerId) ??
      manifest.layers.find((layer) => layer?.id === LAYER_ALIASES[layerId])
    : null;
  if (!manifestLayer?.table) {
    throw new Error(`manifest does not contain layer: ${layerId}`);
  }

  const table = String(manifestLayer.table);
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
 * @param {{ limit?: number }} [options]
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
    SELECT feature_table.*
    FROM ${quoteIdentifier(metadata.table)} AS feature_table
    JOIN ${quoteIdentifier(metadata.rtree)} AS rtree_table
      ON feature_table.rowid = rtree_table.id
    WHERE rtree_table.minx <= ?
      AND rtree_table.maxx >= ?
      AND rtree_table.miny <= ?
      AND rtree_table.maxy >= ?
    ${limitClause}
  `).all(...params);

  return rows.map((row) => rowToFeature(row, metadata.geometryColumn)).filter(Boolean);
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
    if (key !== geometryColumn) {
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
