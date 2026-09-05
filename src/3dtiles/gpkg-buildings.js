import Database from 'better-sqlite3';

import { decodeGeoPackageGeometry } from '../geometry-read.js';
import { bboxIntersects, quoteIdentifier } from '../utils.js';
import { cleanRing } from './extrude.js';

const DEFAULT_LEVEL_HEIGHT = 3;

/**
 * @typedef {{
 *   table: string,
 *   geometryColumn: string,
 *   rtree: string,
 *   bbox: [number, number, number, number]
 * }} BuildingMetadata
 */

/**
 * @param {string} gpkgPath
 * @returns {Database.Database}
 */
export function openReadonlyGeoPackage(gpkgPath) {
  const db = new Database(gpkgPath, { readonly: true, fileMustExist: true });
  for (const pragma of ['query_only = ON', 'temp_store = MEMORY', 'cache_size = -65536']) {
    try {
      db.pragma(pragma);
    } catch {
      // Optional read tuning.
    }
  }
  return db;
}

/**
 * @param {Database.Database} db
 * @param {[number, number, number, number]} fallbackBbox
 * @returns {BuildingMetadata}
 */
export function readBuildingsMetadata(db, fallbackBbox) {
  const geometry = db.prepare(`
    SELECT column_name
    FROM gpkg_geometry_columns
    WHERE table_name = 'buildings'
  `).get();
  if (!geometry?.column_name) {
    throw new Error('GeoPackage does not contain a buildings geometry column');
  }

  const geometryColumn = String(geometry.column_name);
  const rtree = `rtree_buildings_${geometryColumn}`;
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
    WHERE table_name = 'buildings'
  `).get();
  const bbox = validBbox([content?.min_x, content?.min_y, content?.max_x, content?.max_y])
    ? [Number(content.min_x), Number(content.min_y), Number(content.max_x), Number(content.max_y)]
    : fallbackBbox;

  return {
    table: 'buildings',
    geometryColumn,
    rtree,
    bbox
  };
}

/**
 * @param {Database.Database} db
 * @param {BuildingMetadata} metadata
 * @param {[number, number, number, number]} bbox
 * @returns {number}
 */
export function countBuildings(db, metadata, bbox) {
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
 * @param {Database.Database} db
 * @param {BuildingMetadata} metadata
 * @param {[number, number, number, number]} bbox
 * @param {{ defaultHeight: number, limit?: number, seenIds?: Set<number>, warn?: (message: string) => void }} options
 * @returns {{ footprints: import('./extrude.js').Footprint[], skipped: number }}
 */
export function readBuildingFootprints(db, metadata, bbox, options) {
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
  const footprints = [];
  let skipped = 0;

  for (const row of rows) {
    if (options.seenIds?.has(row.__mapzero_rowid)) continue;
    options.seenIds?.add(row.__mapzero_rowid);
    const geometry = decodeGeoPackageGeometry(row[metadata.geometryColumn]);
    if (!geometry) {
      skipped++;
      continue;
    }

    const polygons = polygonsFromGeometry(geometry);
    if (polygons.length === 0) {
      skipped++;
      continue;
    }

    const height = buildingHeight(row, options.defaultHeight);
    for (const polygon of polygons) {
      const outerRing = cleanRing(polygon[0] ?? []);
      if (outerRing.length < 3) {
        skipped++;
        continue;
      }

      const footprintBbox = ringBbox(outerRing);
      if (!options.seenIds && !bboxIntersects(footprintBbox, bbox)) {
        continue;
      }

      footprints.push({
        coordinates: outerRing,
        height
      });
    }
  }

  return { footprints, skipped };
}

/**
 * @param {{ type: string, coordinates: unknown }} geometry
 * @returns {Array<Array<Array<[number, number]>>>}
 */
function polygonsFromGeometry(geometry) {
  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    return /** @type {Array<Array<Array<[number, number]>>>} */ ([geometry.coordinates]);
  }

  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return /** @type {Array<Array<Array<[number, number]>>>} */ (geometry.coordinates);
  }

  return [];
}

/**
 * @param {Record<string, unknown>} row
 * @param {number} defaultHeight
 * @returns {number}
 */
function buildingHeight(row, defaultHeight) {
  const explicitHeight = parseMeters(row.height);
  if (explicitHeight !== null) {
    return explicitHeight;
  }

  const levels = Number(row['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    return Math.min(levels * DEFAULT_LEVEL_HEIGHT, 500);
  }

  return defaultHeight;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parseMeters(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const match = /^(-?\d+(?:[.,]\d+)?)/.exec(String(value).trim());
  if (!match) {
    return null;
  }

  const height = Number(match[1].replace(',', '.'));
  return Number.isFinite(height) && height > 0 ? Math.min(height, 500) : null;
}

/**
 * @param {Array<[number, number]>} ring
 * @returns {[number, number, number, number]}
 */
function ringBbox(ring) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
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
