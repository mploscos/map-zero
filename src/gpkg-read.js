import Database from 'better-sqlite3';

import { decodeGeoPackageGeometry } from './geometry-read.js';
import { resolveManifestLayers } from './manifest.js';
import { quoteIdentifier } from './utils.js';

const LAYER_ALIASES = {
  aviation: 'aip',
  aip: 'aviation'
};

/**
 * @typedef {import('../packages/core/src/manifest.js').ManifestLayer & { style?: string }} ManifestLayer
 *
 * @typedef {{
 *   format?: string,
 *   version?: number,
 *   name?: string,
 *   bbox?: [number, number, number, number],
 *   data?: string,
 *   styles?: Record<string, string>,
 *   layers?: Array<string | import('../packages/core/src/manifest.js').ManifestLayerInput>
 * }} Manifest
 *
 * @typedef {Map<string, Map<string, Set<string>>>} HiddenFilters
 *
 * @typedef {{
 *   column: string,
 *   include?: string[],
 *   exclude?: string[],
 *   minNumber?: number,
 *   maxNumber?: number
 * }} TilePropertyFilter
 *
 * @typedef {{
 *   all?: TilePropertyFilter[],
 *   any?: TilePropertyFilter[],
 *   minRtreeSpan?: number,
 *   zoom?: number
 * }} TileQueryFilters
 */

/**
 * Open a GeoPackage reader in readonly mode.
 *
 * @param {{ gpkgPath: string, manifest: Manifest, hiddenFilters?: HiddenFilters }} options
 * @returns {{
 *   close: () => void,
 *   getInfo: (packageDir: string) => Record<string, unknown>,
 *   getLayers: () => Array<Record<string, unknown>>,
 *   getLayerStats: () => Array<Record<string, unknown>>,
 *   hasFeaturesInBbox: (layerId: string, bbox: [number, number, number, number]) => boolean,
 *   iterateFeatureBounds: (layerId: string, zoom?: number) => Iterable<{minx: number, miny: number, maxx: number, maxy: number}>,
 *   getTileFeatures: (layerId: string, bbox: [number, number, number, number], filters?: TileQueryFilters) => Array<Record<string, unknown>>
 * }}
 */
export function openGeoPackageReader(options) {
  const manifestLayers = resolveManifestLayers(options.manifest).map((layer) => ({ ...layer, style: layer.id }));
  const db = new Database(options.gpkgPath, {
    readonly: true,
    fileMustExist: true
  });
  configureReadPerformance(db);
  const statementCache = new Map();

  const layerById = new Map(manifestLayers.map((layer) => [layer.id, layer]));
  for (const layer of manifestLayers) {
    const alias = LAYER_ALIASES[layer.id];
    if (alias && !layerById.has(alias)) {
      layerById.set(alias, layer);
    }
  }

  const tableContents = loadContents(db);
  const geometryColumns = loadGeometryColumns(db);
  const layers = buildLayerMetadata(db, manifestLayers, tableContents, geometryColumns);
  const columnsByTable = new Map(layers.map((layer) => [
    String(layer.table),
    layer.exists ? loadTableColumns(db, String(layer.table)) : new Set()
  ]));
  try {
    for (const layer of layers) {
      if (!layer.featureZoom) continue;
      const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(String(layer.table))})`).all();
      for (const name of Object.values(layer.featureZoom)) {
        if (columns.find((column) => column.name === name)?.type.toUpperCase() !== 'INTEGER') {
          throw new Error(`featureZoom column ${layer.table}.${name} must exist and have type INTEGER`);
        }
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    close() {
      db.close();
    },

    getInfo(packageDir) {
      return {
        packagePath: packageDir,
        gpkgPath: options.gpkgPath,
        manifest: {
          format: options.manifest.format,
          version: options.manifest.version,
          name: options.manifest.name,
          bbox: options.manifest.bbox,
          data: options.manifest.data,
          styles: options.manifest.styles,
          layerCount: options.manifest.layers?.length ?? 0
        },
        layers
      };
    },

    getLayers() {
      return layers;
    },

    // Unfiltered persisted counts and index checks; no features are materialized.
    getLayerStats() {
      return layers.map((layer) => inspectLayer(db, layer));
    },

    // Conservative occupancy only: no property filters, geometry decoding or
    // row materialization. False positives are allowed; empty means no source.
    hasFeaturesInBbox(layerId, bbox) {
      const { metadata } = getReadableLayer(layerId, layerById, layers);
      const cacheKey = `occupancy:${metadata.rtree}`;
      let statement = statementCache.get(cacheKey);
      if (!statement) {
        statement = db.prepare(`SELECT 1 FROM ${quoteIdentifier(String(metadata.rtree))}
          WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ? LIMIT 1`);
        statementCache.set(cacheKey, statement);
      }
      return Boolean(statement.get(bbox[2], bbox[0], bbox[3], bbox[1]));
    },

    // Streaming envelopes only; optional visibility uses the same SQL predicate
    // as MVT reads. No geometry/property payloads enter a sparse tile plan.
    *iterateFeatureBounds(layerId, zoom) {
      const { layer, metadata } = getReadableLayer(layerId, layerById, layers);
      const params = [], keys = ['bounds', layer.table];
      const visibility = featureZoomSql(layer.featureZoom, zoom, params, keys);
      const key = JSON.stringify(keys);
      let statement = statementCache.get(key);
      if (!statement) {
        statement = db.prepare(`SELECT r.minx, r.miny, r.maxx, r.maxy
          FROM ${quoteIdentifier(String(metadata.rtree))} r
          JOIN ${quoteIdentifier(layer.table)} feature_table ON feature_table.rowid = r.id
          WHERE 1 ${visibility}`);
        statementCache.set(key, statement);
      }
      yield* statement.iterate(...params);
    },

    getTileFeatures(layerId, bbox, filters = {}) {
      const { layer, metadata } = getReadableLayer(layerId, layerById, layers);
      const tableColumns = columnsByTable.get(layer.table) ?? new Set();
      const hiddenFilters = hiddenFiltersForLayer(
        options.hiddenFilters?.get(layerId) ?? options.hiddenFilters?.get(String(layer.id)),
        tableColumns
      );
      const tileFilters = normalizeTileQueryFilters(filters, tableColumns);
      tileFilters.featureZoom = layer.featureZoom;
      tileFilters.zoom = filters.zoom;
      const rows = selectFeaturesWithBbox(
        db,
        layer.table,
        String(metadata.geometryColumn),
        String(metadata.rtree),
        bbox,
        hiddenFilters,
        tileFilters,
        statementCache
      );

      return rows
        .map((row) => rowToFeature(row, String(metadata.geometryColumn)))
        .filter((feature) => feature.geometry !== null);
    }
  };
}

/**
 * @param {Database.Database} db
 */
function configureReadPerformance(db) {
  for (const pragma of [
    'query_only = ON',
    'temp_store = MEMORY',
    'cache_size = -65536',
    'mmap_size = 268435456'
  ]) {
    try {
      db.pragma(pragma);
    } catch {
      // Some SQLite builds can reject optional tuning pragmas; readonly access still works without them.
    }
  }
}

/**
 * @param {Database.Database} db
 * @param {string} table
 * @returns {Set<string>}
 */
function loadTableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * @param {Database.Database} db
 * @returns {Map<string, Record<string, unknown>>}
 */
function loadContents(db) {
  const rows = db.prepare(`
    SELECT table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id
    FROM gpkg_contents
    WHERE data_type = 'features'
  `).all();

  return new Map(rows.map((row) => [String(row.table_name), row]));
}

/**
 * @param {Database.Database} db
 * @returns {Map<string, Record<string, unknown>>}
 */
function loadGeometryColumns(db) {
  const rows = db.prepare(`
    SELECT table_name, column_name, geometry_type_name, srs_id, z, m
    FROM gpkg_geometry_columns
  `).all();

  return new Map(rows.map((row) => [String(row.table_name), row]));
}

/**
 * @param {Database.Database} db
 * @param {ManifestLayer[]} manifestLayers
 * @param {Map<string, Record<string, unknown>>} tableContents
 * @param {Map<string, Record<string, unknown>>} geometryColumns
 * @returns {Array<Record<string, unknown>>}
 */
function buildLayerMetadata(db, manifestLayers, tableContents, geometryColumns) {
  return manifestLayers.map((layer) => {
    const content = tableContents.get(layer.table);
    const geometry = geometryColumns.get(layer.table);
    const geometryColumn = geometry?.column_name ? String(geometry.column_name) : null;
    const rtree = geometryColumn ? findRtree(db, layer.table, geometryColumn) : null;

    return {
      ...layer,
      exists: Boolean(content && geometry),
      geometryColumn,
      geometryType: geometry?.geometry_type_name ?? null,
      srsId: geometry?.srs_id ?? content?.srs_id ?? null,
      bbox: content
        ? [content.min_x, content.min_y, content.max_x, content.max_y].map((value) => Number(value))
        : null,
      rtree
    };
  });
}

/**
 * @param {Database.Database} db
 * @param {string} table
 * @param {string} geometryColumn
 * @returns {string | null}
 */
function findRtree(db, table, geometryColumn) {
  const rtree = `rtree_${table}_${geometryColumn}`;
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(rtree);

  return row ? rtree : null;
}

/**
 * @param {Database.Database} db
 * @param {string} table
 * @param {string} geometryColumn
 * @param {string} rtree
 * @param {[number, number, number, number]} bbox
 * @param {Array<{ column: string, values: string[] }>} hiddenFilters
 * @param {{ all: TilePropertyFilter[], any: TilePropertyFilter[], minRtreeSpan?: number, zoom?: number, featureZoom?: {minColumn?: string, maxColumn?: string} }} tileFilters
 * @param {Map<string, Database.Statement>} statementCache
 * @returns {Record<string, unknown>[]}
 */
function selectFeaturesWithBbox(db, table, geometryColumn, rtree, bbox, hiddenFilters, tileFilters, statementCache) {
  const [minX, minY, maxX, maxY] = bbox;
  const params = [maxX, minX, maxY, minY];
  let filterSql = '';
  const cacheKeyParts = [table, geometryColumn, rtree];
  filterSql += featureZoomSql(tileFilters.featureZoom, tileFilters.zoom, params, cacheKeyParts);

  for (const filter of hiddenFilters) {
    if (filter.values.length === 0) {
      continue;
    }

    filterSql += `
      AND (
        feature_table.${quoteIdentifier(filter.column)} IS NULL
        OR feature_table.${quoteIdentifier(filter.column)} NOT IN (${filter.values.map(() => '?').join(', ')})
      )`;
    params.push(...filter.values);
    cacheKeyParts.push(`hidden:${filter.column}:${filter.values.length}`);
  }

  for (const filter of tileFilters.all) {
    const sql = propertyFilterSql(filter, params, cacheKeyParts);
    if (sql) {
      filterSql += `
      AND ${sql}`;
    }
  }

  const anySql = tileFilters.any
    .map((filter) => propertyFilterSql(filter, params, cacheKeyParts))
    .filter(Boolean);
  if (anySql.length > 0) {
    cacheKeyParts.push(`any:${anySql.length}`);
    filterSql += `
      AND (${anySql.join(' OR ')})`;
  }

  if (Number.isFinite(tileFilters.minRtreeSpan) && Number(tileFilters.minRtreeSpan) > 0) {
    filterSql += `
      AND (
        (rtree_table.maxx - rtree_table.minx) >= ?
        OR (rtree_table.maxy - rtree_table.miny) >= ?
      )`;
    params.push(Number(tileFilters.minRtreeSpan), Number(tileFilters.minRtreeSpan));
    cacheKeyParts.push('rtree-span');
  }

  const cacheKey = cacheKeyParts.join('|');
  let statement = statementCache.get(cacheKey);
  if (!statement) {
    statement = db.prepare(`
    SELECT feature_table.*
    FROM ${quoteIdentifier(table)} AS feature_table
    JOIN ${quoteIdentifier(rtree)} AS rtree_table
      ON feature_table.rowid = rtree_table.id
    WHERE rtree_table.minx <= ?
      AND rtree_table.maxx >= ?
      AND rtree_table.miny <= ?
      AND rtree_table.maxy >= ?
      ${filterSql}
  `);
    statementCache.set(cacheKey, statement);
  }

  return statement.all(...params);
}

/** Inclusive optional per-feature visibility; NULL denotes an unbounded side.
 * Shared by decoded reads and the streaming envelope planner.
 * @param {{minColumn?: string, maxColumn?: string} | undefined} fields
 * @param {number | undefined} zoom
 * @param {unknown[]} params
 * @param {string[]} keys
 */
function featureZoomSql(fields, zoom, params, keys) {
  if (zoom === undefined) return '';
  if (!Number.isInteger(zoom) || zoom < 0) throw new Error('query zoom must be a non-negative integer');
  let sql = '';
  for (const [key, operator] of [['minColumn', '<='], ['maxColumn', '>=']]) {
    const name = fields?.[key];
    if (!name) continue;
    const column = `feature_table.${quoteIdentifier(name)}`;
    sql += ` AND (${column} IS NULL OR ${column} ${operator} ?)`;
    params.push(zoom);
    keys.push(`featureZoom:${key}:${name}`);
  }
  return sql;
}

/**
 * @param {TileQueryFilters} filters
 * @param {Set<string>} tableColumns
 * @returns {{ all: TilePropertyFilter[], any: TilePropertyFilter[] }}
 */
function normalizeTileQueryFilters(filters, tableColumns) {
  return {
    all: normalizePropertyFilters(filters.all, tableColumns),
    any: normalizePropertyFilters(filters.any, tableColumns),
    minRtreeSpan: Number.isFinite(filters.minRtreeSpan) ? Number(filters.minRtreeSpan) : undefined
  };
}

/**
 * @param {TilePropertyFilter[] | undefined} filters
 * @param {Set<string>} tableColumns
 * @returns {TilePropertyFilter[]}
 */
function normalizePropertyFilters(filters, tableColumns) {
  if (!Array.isArray(filters)) {
    return [];
  }

  return filters.filter((filter) => filter?.column && tableColumns.has(filter.column));
}

/**
 * @param {TilePropertyFilter} filter
 * @param {unknown[]} params
 * @param {string[]} cacheKeyParts
 * @returns {string}
 */
function propertyFilterSql(filter, params, cacheKeyParts) {
  const column = `feature_table.${quoteIdentifier(filter.column)}`;
  const parts = [];

  if (Array.isArray(filter.include)) {
    if (filter.include.length === 0) {
      return '0';
    }

    parts.push(`${column} IN (${filter.include.map(() => '?').join(', ')})`);
    params.push(...filter.include);
    cacheKeyParts.push(`include:${filter.column}:${filter.include.length}`);
  }

  if (Array.isArray(filter.exclude) && filter.exclude.length > 0) {
    parts.push(`(${column} IS NULL OR ${column} NOT IN (${filter.exclude.map(() => '?').join(', ')}))`);
    params.push(...filter.exclude);
    cacheKeyParts.push(`exclude:${filter.column}:${filter.exclude.length}`);
  }

  if (Number.isFinite(filter.minNumber)) {
    parts.push(`CAST(${column} AS REAL) >= ?`);
    params.push(Number(filter.minNumber));
    cacheKeyParts.push(`min:${filter.column}`);
  }

  if (Number.isFinite(filter.maxNumber)) {
    parts.push(`CAST(${column} AS REAL) <= ?`);
    params.push(Number(filter.maxNumber));
    cacheKeyParts.push(`max:${filter.column}`);
  }

  return parts.length > 0 ? `(${parts.join(' AND ')})` : '';
}

/**
 * @param {Map<string, Set<string>> | undefined} layerFilters
 * @param {Set<string>} tableColumns
 * @returns {Array<{ column: string, values: string[] }>}
 */
function hiddenFiltersForLayer(layerFilters, tableColumns) {
  if (!layerFilters) {
    return [];
  }

  const filters = [];
  for (const [column, values] of layerFilters.entries()) {
    if (tableColumns.has(column) && values.size > 0) {
      filters.push({
        column,
        values: [...values]
      });
    }
  }

  return filters;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} geometryColumn
 * @returns {{ type: 'Feature', id: unknown, geometry: Record<string, unknown> | null, properties: Record<string, unknown> }}
 */
function rowToFeature(row, geometryColumn) {
  const geometry = decodeGeoPackageGeometry(/** @type {Buffer | null} */ (row[geometryColumn]));
  /** @type {Record<string, unknown>} */
  const properties = {};

  for (const [key, value] of Object.entries(row)) {
    if (key !== geometryColumn) {
      properties[key] = value;
    }
  }

  return {
    type: 'Feature',
    id: properties.fid ?? properties.id ?? null,
    geometry,
    properties
  };
}

/**
 * @param {string} layerId
 * @param {Map<string, ManifestLayer>} layerById
 * @param {Array<Record<string, unknown>>} layers
 * @returns {{ layer: ManifestLayer, metadata: Record<string, unknown> }}
 */
function getReadableLayer(layerId, layerById, layers) {
  const layer = layerById.get(layerId);
  if (!layer) {
    throw httpError(404, `unknown layer: ${layerId}`);
  }

  const metadata = layers.find((item) => item.id === layer.id);
  if (!metadata || !metadata.exists || !metadata.geometryColumn) {
    throw httpError(404, `layer is not available in GeoPackage: ${layerId}`);
  }

  if (!metadata.rtree) {
    throw httpError(400, `layer does not have an RTree spatial index: ${layerId}`);
  }

  return { layer, metadata };
}

/**
 * @param {number} statusCode
 * @param {string} message
 * @returns {Error & { statusCode: number }}
 */
function httpError(statusCode, message) {
  const error = /** @type {Error & { statusCode: number }} */ (new Error(message));
  error.statusCode = statusCode;
  return error;
}

/**
 * Inspect persisted feature counts and RTree structure/ID coverage. This does
 * not decode geometries or verify each envelope against geometry coordinates.
 * @param {Database.Database} db
 * @param {Record<string, unknown>} layer
 * @returns {Record<string, unknown>}
 */
function inspectLayer(db, layer) {
  const table = quoteIdentifier(String(layer.table));
  const featureCount = layer.exists ? db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count : null;
  const result = { id: layer.id, table: layer.table, featureCount, rtree: {
    table: layer.rtree, registered: false, entryCount: null, missingEntries: null,
    orphanEntries: null, invalidBounds: null, integrity: null, verified: false
  } };
  if (!layer.exists || !layer.rtree) return result;
  const rtree = quoteIdentifier(String(layer.rtree));
  const primaryKeys = db.prepare(`PRAGMA table_info(${table})`).all().filter((column) => column.pk);
  const extensionTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gpkg_extensions'").get();
  result.rtree.registered = Boolean(extensionTable && db.prepare(`
    SELECT 1 FROM gpkg_extensions WHERE table_name = ? AND column_name = ? AND extension_name = 'gpkg_rtree_index'
  `).get(layer.table, layer.geometryColumn));
  result.rtree.entryCount = db.prepare(`SELECT COUNT(*) AS count FROM ${rtree}`).get().count;
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(layer.rtree);
  if (!/USING\s+rtree\s*\(/i.test(definition?.sql ?? '') || primaryKeys.length !== 1) return result;
  const key = quoteIdentifier(primaryKeys[0].name);
  result.rtree.integrity = db.prepare('SELECT rtreecheck(?) AS result').get(layer.rtree).result;
  result.rtree.missingEntries = db.prepare(`SELECT COUNT(*) AS count FROM ${table} f LEFT JOIN ${rtree} r ON f.${key} = r.id WHERE r.id IS NULL`).get().count;
  result.rtree.orphanEntries = db.prepare(`SELECT COUNT(*) AS count FROM ${rtree} r LEFT JOIN ${table} f ON f.${key} = r.id WHERE f.${key} IS NULL`).get().count;
  result.rtree.invalidBounds = db.prepare(`SELECT COUNT(*) AS count FROM ${rtree} WHERE minx > maxx OR miny > maxy`).get().count;
  result.rtree.verified = result.rtree.registered && result.rtree.integrity === 'ok' &&
    result.rtree.entryCount === featureCount && result.rtree.missingEntries === 0 &&
    result.rtree.orphanEntries === 0 && result.rtree.invalidBounds === 0;
  return result;
}
