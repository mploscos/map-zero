import { createReadStream, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import parseOsmPbf from 'osm-pbf-parser';

import {
  geoPackageLayersForOsm,
  isPoi,
  layersForRelation,
  layersForWay,
  propertiesForLayer
} from './layers.js';
import { openGeoPackageWriter } from './gpkg.js';
import {
  bboxIntersects,
  closeRing,
  dedupeCoordinates,
  geometryBbox,
  pointInBbox,
  pointInRing
} from './utils.js';

const require = createRequire(import.meta.url);
const osmPbfParsers = require('osm-pbf-parser/lib/parsers.js');
const { BlobParser, BlobDecompressor } = parseOsmPbf;

/**
 * @typedef {{ id: string, type: string, tags: Record<string, string>, refs: string[] }} WaySummary
 * @typedef {{ id: string, type: string, tags: Record<string, string>, layers: string[], members: RelationMember[] }} RelationSummary
 * @typedef {{ id: string, type: string, role: string }} RelationMember
 * @typedef {{ type: string, coordinates: unknown }} Geometry
 * @typedef {{ geometry: Geometry, properties: Record<string, string | null>, bbox: [number, number, number, number] }} Feature
 * @typedef {{
 *   phase: 'stage' | 'progress' | 'summary',
 *   step: string,
 *   label?: string,
 *   message?: string,
 *   bytesRead?: number,
 *   totalBytes?: number,
 *   entities?: number,
 *   itemsDone?: number,
 *   totalItems?: number
 * }} ProgressEvent
 */

/**
 * Infer the full source extent from OSM node coordinates.
 *
 * This keeps `--bbox` optional while still avoiding a full in-memory node load.
 *
 * @param {string | string[]} source
 * @param {{ totalBytes?: number, onProgress?: (event: ProgressEvent) => void }} [options]
 * @returns {Promise<[number, number, number, number]>}
 */
export async function inferOsmBbox(source, options = {}) {
  const headerBbox = await readOsmHeaderBbox(source);
  if (headerBbox) {
    options.onProgress?.({
      phase: 'summary',
      step: 'scan-bbox',
      message: `Inferred bbox ${formatBbox(headerBbox)} from PBF header`
    });
    return headerBbox;
  }

  /** @type {[number, number, number, number] | null} */
  let bbox = null;
  let nodeCount = 0;

  await scanOsm(source, (entity) => {
    if (entity.type !== 'node') {
      return;
    }

    const coordinate = getNodeCoordinate(entity);
    if (!coordinate) {
      return;
    }

    const [lon, lat] = coordinate;
    nodeCount += 1;

    if (!bbox) {
      bbox = [lon, lat, lon, lat];
      return;
    }

    bbox[0] = Math.min(bbox[0], lon);
    bbox[1] = Math.min(bbox[1], lat);
    bbox[2] = Math.max(bbox[2], lon);
    bbox[3] = Math.max(bbox[3], lat);
  }, {
    step: 'scan-bbox',
    label: 'PBF scan: inferring bbox from nodes',
    totalBytes: options.totalBytes,
    onProgress: options.onProgress
  });

  if (!bbox || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new Error('could not infer a valid bbox from PBF node coordinates');
  }

  options.onProgress?.({
    phase: 'summary',
    step: 'scan-bbox',
    message: `Inferred bbox ${formatBbox(bbox)} from ${nodeCount} nodes`
  });

  return bbox;
}

/**
 * Build a GeoPackage from OSM data using a disk-backed temporary SQLite store.
 *
 * @param {string} source
 * @param {[number, number, number, number]} bbox
 * @param {string[]} layers
 * @param {string} gpkgPath
 * @param {{
 *   totalBytes?: number,
 *   batchSize?: number,
 *   keepTemp?: boolean,
 *   tempPath?: string,
 *   debugBuild?: boolean,
 *   onProgress?: (event: ProgressEvent) => void
 * }} [options]
 * @returns {Promise<{ counts: Record<string, number>, tempPath: string }>}
 */
export async function buildOsmGeoPackage(source, bbox, layers, gpkgPath, options = {}) {
  const sources = Array.isArray(source) ? source : [source];
  const selectedLayers = new Set(layers);
  const progress = options.onProgress;
  const batchSize = options.batchSize ?? 5000;
  const tempPath = options.tempPath ?? join(tmpdir(), `map-zero-build-${process.pid}-${randomUUID()}.sqlite`);
  const temp = createBuildTempDatabase(tempPath);
  const writer = openGeoPackageWriter(gpkgPath, geoPackageLayersForOsm(layers), bbox);
  let success = false;

  try {
    createBuildTempSchema(temp);
    for (const sourcePath of sources) {
      options.onProgress?.({
        phase: 'stage',
        step: 'scan-source',
        message: `Scanning OSM extract ${sourcePath}`
      });
      await scanCandidateRows(sourcePath, bbox, selectedLayers, temp, options);
      await scanRelationWayRows(sourcePath, temp, options);
      await scanReferencedNodesAndPoints(sourcePath, bbox, selectedLayers, temp, writer, options);
    }
    await writeWayFeaturesFromTemp(temp, writer, bbox, batchSize, progress, options.debugBuild);
    await writeRelationFeaturesFromTemp(temp, writer, bbox, batchSize, progress, options.debugBuild);

    success = true;
    return {
      counts: writer.counts(),
      tempPath
    };
  } finally {
    writer.close();
    temp.close();
    if (success && !options.keepTemp) {
      rmSync(tempPath, { force: true });
    }
  }
}

/**
 * Extract normalized logical features from an OSM PBF file.
 *
 * The parser is streamed, but the file is scanned three times so relation
 * member ways and referenced nodes can be resolved without retaining every node.
 *
 * @param {string} source
 * @param {[number, number, number, number]} bbox
 * @param {string[]} layers
 * @param {{ totalBytes?: number, onProgress?: (event: ProgressEvent) => void }} [options]
 * @returns {Promise<Record<string, Feature[]>>}
 */
export async function extractOsmFeatures(source, bbox, layers, options = {}) {
  const selectedLayers = new Set(layers);
  const progress = options.onProgress;
  /** @type {Map<string, WaySummary & { layers: string[] }>} */
  const candidateWays = new Map();
  /** @type {Map<string, RelationSummary>} */
  const candidateRelations = new Map();
  const relationWayIds = new Set();
  const neededNodeIds = createNodeIdStore();

  await scanOsm(source, (entity) => {
    if (entity.type === 'way') {
      const tags = getTags(entity);
      const matchedLayers = layersForWay(tags, selectedLayers);

      if (matchedLayers.length > 0) {
        const way = summarizeWay(entity, tags);
        candidateWays.set(way.id, { ...way, layers: matchedLayers });
        for (const ref of way.refs) {
          neededNodeIds.add(ref);
        }
      }
    }

    if (entity.type === 'relation') {
      const tags = getTags(entity);
      const matchedLayers = layersForRelation(tags, selectedLayers);

      if (matchedLayers.length > 0) {
        const relation = summarizeRelation(entity, tags, matchedLayers);
        candidateRelations.set(relation.id, relation);

        for (const member of relation.members) {
          if (member.type === 'way') {
            relationWayIds.add(member.id);
          }
        }
      }
    }
  }, {
    step: 'scan-candidates',
    label: 'PBF scan: finding candidate ways and relations',
    totalBytes: options.totalBytes,
    onProgress: progress
  });

  progress?.({
    phase: 'summary',
    step: 'scan-candidates',
    message: `Found ${candidateWays.size} candidate ways and ${candidateRelations.size} candidate relations`
  });

  /** @type {Map<string, WaySummary>} */
  const relationWays = new Map();

  if (relationWayIds.size > 0) {
    await scanOsm(source, (entity) => {
      if (entity.type !== 'way') {
        return;
      }

      const id = String(entity.id);
      if (!relationWayIds.has(id)) {
        return;
      }

      if (candidateWays.has(id)) {
        return;
      }

      const way = summarizeWay(entity, getTags(entity));
      relationWays.set(way.id, way);
      for (const ref of way.refs) {
        neededNodeIds.add(ref);
      }
    }, {
      step: 'scan-relation-ways',
      label: 'PBF scan: resolving relation member ways',
      totalBytes: options.totalBytes,
      onProgress: progress
    });

    progress?.({
      phase: 'summary',
      step: 'scan-relation-ways',
      message: `Resolved ${relationWays.size} relation member ways`
    });
  } else {
    progress?.({
      phase: 'summary',
      step: 'scan-relation-ways',
      message: 'No relation member ways to resolve'
    });
  }

  neededNodeIds.flush();

  const nodes = createNodeCoordinateStore();
  const features = createFeatureBuckets(layers);

  await scanOsm(source, (entity) => {
    if (entity.type !== 'node') {
      return;
    }

    const coordinate = getNodeCoordinate(entity);
    if (!coordinate) {
      return;
    }

    const id = String(entity.id);
    if (neededNodeIds.has(id)) {
      nodes.set(id, coordinate);
    }

    if (selectedLayers.has('pois')) {
      const tags = getTags(entity);
      if (isPoi(tags) && pointInBbox(coordinate, bbox)) {
        features.pois.push({
          geometry: {
            type: 'Point',
            coordinates: coordinate
          },
          properties: propertiesForLayer('pois', { id, type: 'node', tags }),
          bbox: [coordinate[0], coordinate[1], coordinate[0], coordinate[1]]
        });
      }
    }

    if (selectedLayers.has('aip')) {
      const tags = getTags(entity);
      if (tags.aeroway && pointInBbox(coordinate, bbox)) {
        features.aip.push({
          geometry: {
            type: 'Point',
            coordinates: coordinate
          },
          properties: propertiesForLayer('aip', { id, type: 'node', tags }),
          bbox: [coordinate[0], coordinate[1], coordinate[0], coordinate[1]]
        });
      }
    }
  }, {
    step: 'scan-nodes',
    label: 'PBF scan: loading referenced nodes and point features',
    totalBytes: options.totalBytes,
    onProgress: progress
  });

  nodes.flush();
  neededNodeIds.close();

  progress?.({
    phase: 'summary',
    step: 'scan-nodes',
    message: `Loaded ${nodes.size} referenced nodes`
  });

  progress?.({
    phase: 'stage',
    step: 'build-way-geometries',
    message: `Building geometries for ${candidateWays.size} ways`
  });
  let processedWays = 0;
  for (const way of candidateWays.values()) {
    for (const layer of way.layers) {
      const geometry = buildWayGeometry(layer, way, nodes);
      addFeatureIfInside(features, layer, geometry, bbox, {
        id: way.id,
        type: 'way',
        tags: way.tags
      });
    }

    processedWays += 1;
    if (processedWays % 5000 === 0 || processedWays === candidateWays.size) {
      progress?.({
        phase: 'progress',
        step: 'build-way-geometries',
        label: 'Building way geometries',
        itemsDone: processedWays,
        totalItems: candidateWays.size
      });
    }
  }

  progress?.({
    phase: 'stage',
    step: 'build-relation-geometries',
    message: `Building geometries for ${candidateRelations.size} relations`
  });
  let processedRelations = 0;
  for (const relation of candidateRelations.values()) {
    for (const layer of relation.layers) {
      const geometry = buildRelationGeometry(layer, relation, relationWays, candidateWays, nodes);
      addFeatureIfInside(features, layer, geometry, bbox, {
        id: relation.id,
        type: 'relation',
        tags: relation.tags
      });
    }

    processedRelations += 1;
    if (processedRelations % 500 === 0 || processedRelations === candidateRelations.size) {
      progress?.({
        phase: 'progress',
        step: 'build-relation-geometries',
        label: 'Building relation geometries',
        itemsDone: processedRelations,
        totalItems: candidateRelations.size
      });
    }
  }

  progress?.({
    phase: 'summary',
    step: 'extract-complete',
    message: `Extracted ${countFeatures(features)} features`
  });

  nodes.close();

  return features;
}

/**
 * Stream all decoded OSM entities from a PBF file.
 *
 * @param {string} source
 * @param {(entity: Record<string, unknown>) => void} onEntity
 * @param {{ step: string, label: string, totalBytes?: number, onProgress?: (event: ProgressEvent) => void }} options
 * @returns {Promise<void>}
 */
function scanOsm(source, onEntity, options) {
  return new Promise((resolve, reject) => {
    const parser = parseOsmPbf();
    const stream = createReadStream(source);
    let bytesRead = 0;
    let entities = 0;

    options.onProgress?.({
      phase: 'stage',
      step: options.step,
      message: options.label
    });

    stream
      .on('data', (chunk) => {
        bytesRead += chunk.length;
        options.onProgress?.({
          phase: 'progress',
          step: options.step,
          label: options.label,
          bytesRead,
          totalBytes: options.totalBytes,
          entities
        });
      })
      .on('error', reject)
      .pipe(parser)
      .on('data', (items) => {
        const batch = Array.isArray(items) ? items : [items];
        entities += batch.length;
        for (const item of batch) {
          onEntity(/** @type {Record<string, unknown>} */ (item));
        }
      })
      .on('error', reject)
      .on('end', () => {
        options.onProgress?.({
          phase: 'progress',
          step: options.step,
          label: options.label,
          bytesRead,
          totalBytes: options.totalBytes,
          entities
        });
        resolve();
      });
  });
}

/**
 * @param {string} tempPath
 * @returns {Database.Database}
 */
function createBuildTempDatabase(tempPath) {
  rmSync(tempPath, { force: true });
  const db = new Database(tempPath);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('locking_mode = EXCLUSIVE');
  db.pragma('cache_size = -128000');
  return db;
}

/**
 * @param {Database.Database} db
 */
function createBuildTempSchema(db) {
  db.exec(`
    CREATE TABLE needed_nodes (
      node_id TEXT PRIMARY KEY
    ) WITHOUT ROWID;

    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      lon REAL NOT NULL,
      lat REAL NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE candidate_ways (
      id TEXT NOT NULL,
      layer TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      node_ids_json TEXT NOT NULL,
      PRIMARY KEY (id, layer)
    );

    CREATE TABLE relation_way_ids (
      id TEXT PRIMARY KEY
    ) WITHOUT ROWID;

    CREATE TABLE relation_ways (
      id TEXT PRIMARY KEY,
      tags_json TEXT NOT NULL,
      node_ids_json TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE candidate_relations (
      id TEXT NOT NULL,
      layer TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      members_json TEXT NOT NULL,
      PRIMARY KEY (id, layer)
    );

    CREATE INDEX candidate_ways_layer_idx ON candidate_ways(layer);
    CREATE INDEX candidate_relations_layer_idx ON candidate_relations(layer);
  `);
}

/**
 * @param {string} source
 * @param {[number, number, number, number]} bbox
 * @param {Set<string>} selectedLayers
 * @param {Database.Database} db
 * @param {{ totalBytes?: number, onProgress?: (event: ProgressEvent) => void }} options
 */
async function scanCandidateRows(source, bbox, selectedLayers, db, options) {
  const insertWay = db.prepare('INSERT OR IGNORE INTO candidate_ways (id, layer, tags_json, node_ids_json) VALUES (?, ?, ?, ?)');
  const insertNeededNode = db.prepare('INSERT OR IGNORE INTO needed_nodes (node_id) VALUES (?)');
  const insertRelationWayId = db.prepare('INSERT OR IGNORE INTO relation_way_ids (id) VALUES (?)');
  const insertRelation = db.prepare('INSERT OR IGNORE INTO candidate_relations (id, layer, tags_json, members_json) VALUES (?, ?, ?, ?)');
  let candidateWayRows = 0;
  let candidateRelations = 0;

  db.exec('BEGIN');
  try {
    await scanOsm(source, (entity) => {
      if (entity.type === 'way') {
        const tags = getTags(entity);
        const matchedLayers = layersForWay(tags, selectedLayers);

        if (matchedLayers.length > 0) {
          const way = summarizeWay(entity, tags);
          const tagsJson = JSON.stringify(tags);
          const refsJson = JSON.stringify(way.refs);

          for (const layer of matchedLayers) {
            insertWay.run(way.id, layer, tagsJson, refsJson);
            candidateWayRows += 1;
          }

          for (const ref of way.refs) {
            insertNeededNode.run(ref);
          }
        }
      }

      if (entity.type === 'relation') {
        const tags = getTags(entity);
        const matchedLayers = layersForRelation(tags, selectedLayers);

        if (matchedLayers.length > 0) {
          const relation = summarizeRelation(entity, tags, matchedLayers);
          const tagsJson = JSON.stringify(tags);
          const membersJson = JSON.stringify(relation.members);

          for (const layer of matchedLayers) {
            insertRelation.run(relation.id, layer, tagsJson, membersJson);
            candidateRelations += 1;
          }

          for (const member of relation.members) {
            if (member.type === 'way') {
              insertRelationWayId.run(member.id);
            }
          }
        }
      }
    }, {
      step: 'scan-candidates',
      label: 'PBF scan: finding candidate ways and relations',
      totalBytes: options.totalBytes,
      onProgress: options.onProgress
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  options.onProgress?.({
    phase: 'summary',
    step: 'scan-candidates',
    message: `Stored ${candidateWayRows} candidate way rows and ${candidateRelations} candidate relation rows`
  });
}

/**
 * @param {string} source
 * @param {Database.Database} db
 * @param {{ totalBytes?: number, onProgress?: (event: ProgressEvent) => void }} options
 */
async function scanRelationWayRows(source, db, options) {
  const relationWayNeeded = db.prepare('SELECT 1 FROM relation_way_ids WHERE id = ?');
  const candidateWayExists = db.prepare('SELECT 1 FROM candidate_ways WHERE id = ? LIMIT 1');
  const insertRelationWay = db.prepare('INSERT OR IGNORE INTO relation_ways (id, tags_json, node_ids_json) VALUES (?, ?, ?)');
  const insertNeededNode = db.prepare('INSERT OR IGNORE INTO needed_nodes (node_id) VALUES (?)');
  const relationWayCount = /** @type {{ count: number }} */ (db.prepare('SELECT COUNT(*) AS count FROM relation_way_ids').get()).count;
  let resolved = 0;

  if (relationWayCount === 0) {
    options.onProgress?.({
      phase: 'summary',
      step: 'scan-relation-ways',
      message: 'No relation member ways to resolve'
    });
    return;
  }

  db.exec('BEGIN');
  try {
    await scanOsm(source, (entity) => {
      if (entity.type !== 'way') {
        return;
      }

      const id = String(entity.id);
      if (!relationWayNeeded.get(id) || candidateWayExists.get(id)) {
        return;
      }

      const way = summarizeWay(entity, getTags(entity));
      insertRelationWay.run(way.id, JSON.stringify(way.tags), JSON.stringify(way.refs));
      resolved += 1;

      for (const ref of way.refs) {
        insertNeededNode.run(ref);
      }
    }, {
      step: 'scan-relation-ways',
      label: 'PBF scan: resolving relation member ways',
      totalBytes: options.totalBytes,
      onProgress: options.onProgress
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  options.onProgress?.({
    phase: 'summary',
    step: 'scan-relation-ways',
    message: `Resolved ${resolved} relation member ways`
  });
}

/**
 * @param {string} source
 * @param {[number, number, number, number]} bbox
 * @param {Set<string>} selectedLayers
 * @param {Database.Database} db
 * @param {ReturnType<typeof openGeoPackageWriter>} writer
 * @param {{ totalBytes?: number, onProgress?: (event: ProgressEvent) => void }} options
 */
async function scanReferencedNodesAndPoints(source, bbox, selectedLayers, db, writer, options) {
  const neededNode = db.prepare('SELECT 1 FROM needed_nodes WHERE node_id = ?');
  const insertNode = db.prepare('INSERT OR REPLACE INTO nodes (id, lon, lat) VALUES (?, ?, ?)');
  let loaded = 0;

  db.exec('BEGIN');
  try {
    await scanOsm(source, (entity) => {
      if (entity.type !== 'node') {
        return;
      }

      const coordinate = getNodeCoordinate(entity);
      if (!coordinate) {
        return;
      }

      const id = String(entity.id);
      if (neededNode.get(id)) {
        insertNode.run(id, coordinate[0], coordinate[1]);
        loaded += 1;
      }

      writePointFeaturesIfNeeded(writer, selectedLayers, entity, id, coordinate, bbox);
    }, {
      step: 'scan-nodes',
      label: 'PBF scan: loading referenced nodes and point features',
      totalBytes: options.totalBytes,
      onProgress: options.onProgress
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  options.onProgress?.({
    phase: 'summary',
    step: 'scan-nodes',
    message: `Loaded ${loaded} referenced nodes`
  });
}

/**
 * @param {ReturnType<typeof openGeoPackageWriter>} writer
 * @param {Set<string>} selectedLayers
 * @param {Record<string, unknown>} entity
 * @param {string} id
 * @param {[number, number]} coordinate
 * @param {[number, number, number, number]} bbox
 */
function writePointFeaturesIfNeeded(writer, selectedLayers, entity, id, coordinate, bbox) {
  if (!pointInBbox(coordinate, bbox)) {
    return;
  }

  if (selectedLayers.has('pois')) {
    const tags = getTags(entity);
    if (isPoi(tags)) {
      writer.insertFeature('pois', {
        geometry: {
          type: 'Point',
          coordinates: coordinate
        },
        properties: propertiesForLayer('pois', { id, type: 'node', tags }),
        bbox: [coordinate[0], coordinate[1], coordinate[0], coordinate[1]]
      });
    }
  }

  if (selectedLayers.has('aip')) {
    const tags = getTags(entity);
    if (tags.aeroway) {
      writer.insertFeature('aip', {
        geometry: {
          type: 'Point',
          coordinates: coordinate
        },
        properties: propertiesForLayer('aip', { id, type: 'node', tags }),
        bbox: [coordinate[0], coordinate[1], coordinate[0], coordinate[1]]
      });
    }
  }
}

/**
 * @param {Database.Database} db
 * @param {ReturnType<typeof openGeoPackageWriter>} writer
 * @param {[number, number, number, number]} bbox
 * @param {number} batchSize
 * @param {((event: ProgressEvent) => void) | undefined} progress
 * @param {boolean | undefined} debugBuild
 */
async function writeWayFeaturesFromTemp(db, writer, bbox, batchSize, progress, debugBuild) {
  const total = /** @type {{ count: number }} */ (db.prepare('SELECT COUNT(*) AS count FROM candidate_ways').get()).count;
  const selectBatch = db.prepare(`
    SELECT rowid, id, layer, tags_json, node_ids_json
    FROM candidate_ways
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ?
  `);
  let lastRowId = 0;
  let processed = 0;

  progress?.({
    phase: 'stage',
    step: 'build-way-geometries',
    message: `Building geometries for ${total} way rows`
  });

  while (processed < total) {
    const rows = /** @type {Array<{ rowid: number, id: string, layer: string, tags_json: string, node_ids_json: string }>} */ (selectBatch.all(lastRowId, batchSize));
    if (rows.length === 0) {
      break;
    }

    lastRowId = rows.at(-1)?.rowid ?? lastRowId;
    const ways = rows.map((row) => ({
      id: row.id,
      layer: row.layer,
      tags: /** @type {Record<string, string>} */ (JSON.parse(row.tags_json)),
      refs: /** @type {string[]} */ (JSON.parse(row.node_ids_json))
    }));
    const nodes = loadNodesForWays(db, ways);

    writer.transaction(() => {
      for (const way of ways) {
        const geometry = buildWayGeometry(way.layer, {
          id: way.id,
          type: 'way',
          tags: way.tags,
          refs: way.refs
        }, nodes);
        writeFeatureIfInside(writer, way.layer, geometry, bbox, {
          id: way.id,
          type: 'way',
          tags: way.tags
        });
      }
    });

    processed += rows.length;
    if (processed % (batchSize * 4) === 0 || processed >= total) {
      progress?.({
        phase: 'progress',
        step: 'build-way-geometries',
        label: debugBuild ? `Building way geometries (${memorySummary()})` : 'Building way geometries',
        itemsDone: processed,
        totalItems: total
      });
    }
  }
}

/**
 * @param {Database.Database} db
 * @param {ReturnType<typeof openGeoPackageWriter>} writer
 * @param {[number, number, number, number]} bbox
 * @param {number} batchSize
 * @param {((event: ProgressEvent) => void) | undefined} progress
 * @param {boolean | undefined} debugBuild
 */
async function writeRelationFeaturesFromTemp(db, writer, bbox, batchSize, progress, debugBuild) {
  const total = /** @type {{ count: number }} */ (db.prepare('SELECT COUNT(*) AS count FROM candidate_relations').get()).count;
  const selectBatch = db.prepare(`
    SELECT rowid, id, layer, tags_json, members_json
    FROM candidate_relations
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ?
  `);
  let lastRowId = 0;
  let processed = 0;

  progress?.({
    phase: 'stage',
    step: 'build-relation-geometries',
    message: `Building geometries for ${total} relation rows`
  });

  while (processed < total) {
    const rows = /** @type {Array<{ rowid: number, id: string, layer: string, tags_json: string, members_json: string }>} */ (selectBatch.all(lastRowId, batchSize));
    if (rows.length === 0) {
      break;
    }

    lastRowId = rows.at(-1)?.rowid ?? lastRowId;
    writer.transaction(() => {
      for (const row of rows) {
        const relation = {
          id: row.id,
          type: 'relation',
          tags: /** @type {Record<string, string>} */ (JSON.parse(row.tags_json)),
          layers: [row.layer],
          members: /** @type {RelationMember[]} */ (JSON.parse(row.members_json))
        };
        const relationWays = loadRelationWayMaps(db, relation);
        const nodes = loadNodesForWayMaps(db, relationWays.relationWays, relationWays.candidateWays);
        const geometry = buildRelationGeometry(row.layer, relation, relationWays.relationWays, relationWays.candidateWays, nodes);
        writeFeatureIfInside(writer, row.layer, geometry, bbox, {
          id: row.id,
          type: 'relation',
          tags: relation.tags
        });
      }
    });

    processed += rows.length;
    progress?.({
      phase: 'progress',
      step: 'build-relation-geometries',
      label: debugBuild ? `Building relation geometries (${memorySummary()})` : 'Building relation geometries',
      itemsDone: processed,
      totalItems: total
    });
  }
}

/**
 * @param {Database.Database} db
 * @param {Array<{ refs: string[] }>} ways
 * @returns {Map<string, [number, number]>}
 */
function loadNodesForWays(db, ways) {
  const ids = new Set();
  for (const way of ways) {
    for (const ref of way.refs) {
      ids.add(ref);
    }
  }

  return loadNodeMap(db, ids);
}

/**
 * @param {Database.Database} db
 * @param {Set<string>} ids
 * @returns {Map<string, [number, number]>}
 */
function loadNodeMap(db, ids) {
  const selectNode = db.prepare('SELECT lon, lat FROM nodes WHERE id = ?');
  const nodes = new Map();
  for (const id of ids) {
    const row = /** @type {{ lon: number, lat: number } | undefined} */ (selectNode.get(id));
    if (row) {
      nodes.set(id, [row.lon, row.lat]);
    }
  }
  return nodes;
}

/**
 * @param {Database.Database} db
 * @param {RelationSummary} relation
 * @returns {{ relationWays: Map<string, WaySummary>, candidateWays: Map<string, WaySummary & { layers: string[] }> }}
 */
function loadRelationWayMaps(db, relation) {
  const selectRelationWay = db.prepare('SELECT tags_json, node_ids_json FROM relation_ways WHERE id = ?');
  const selectCandidateWay = db.prepare('SELECT layer, tags_json, node_ids_json FROM candidate_ways WHERE id = ? LIMIT 1');
  /** @type {Map<string, WaySummary>} */
  const relationWays = new Map();
  /** @type {Map<string, WaySummary & { layers: string[] }>} */
  const candidateWays = new Map();

  for (const member of relation.members) {
    if (member.type !== 'way') {
      continue;
    }

    const relationWay = /** @type {{ tags_json: string, node_ids_json: string } | undefined} */ (selectRelationWay.get(member.id));
    if (relationWay) {
      relationWays.set(member.id, {
        id: member.id,
        type: 'way',
        tags: /** @type {Record<string, string>} */ (JSON.parse(relationWay.tags_json)),
        refs: /** @type {string[]} */ (JSON.parse(relationWay.node_ids_json))
      });
      continue;
    }

    const candidateWay = /** @type {{ layer: string, tags_json: string, node_ids_json: string } | undefined} */ (selectCandidateWay.get(member.id));
    if (candidateWay) {
      candidateWays.set(member.id, {
        id: member.id,
        type: 'way',
        tags: /** @type {Record<string, string>} */ (JSON.parse(candidateWay.tags_json)),
        refs: /** @type {string[]} */ (JSON.parse(candidateWay.node_ids_json)),
        layers: [candidateWay.layer]
      });
    }
  }

  return { relationWays, candidateWays };
}

/**
 * @param {Database.Database} db
 * @param {Map<string, WaySummary>} relationWays
 * @param {Map<string, WaySummary & { layers: string[] }>} candidateWays
 * @returns {Map<string, [number, number]>}
 */
function loadNodesForWayMaps(db, relationWays, candidateWays) {
  const ids = new Set();
  for (const way of relationWays.values()) {
    for (const ref of way.refs) {
      ids.add(ref);
    }
  }
  for (const way of candidateWays.values()) {
    for (const ref of way.refs) {
      ids.add(ref);
    }
  }
  return loadNodeMap(db, ids);
}

/**
 * @param {ReturnType<typeof openGeoPackageWriter>} writer
 * @param {string} layer
 * @param {Geometry | null} geometry
 * @param {[number, number, number, number]} bbox
 * @param {{ id: string | number, type: string, tags: Record<string, string> }} entity
 */
function writeFeatureIfInside(writer, layer, geometry, bbox, entity) {
  if (!geometry) {
    return;
  }

  const normalizedGeometry = normalizeFeatureGeometryForLayer(layer, geometry);
  if (!normalizedGeometry) {
    return;
  }

  const featureBbox = geometryBbox(normalizedGeometry);
  if (!featureBbox || !bboxIntersects(featureBbox, bbox)) {
    return;
  }

  writer.insertFeature(layer, {
    geometry: normalizedGeometry,
    properties: propertiesForLayer(layer, entity),
    bbox: featureBbox
  });
}

/**
 * Match feature geometry to the destination GeoPackage layer type.
 *
 * Some operational infrastructure is mapped as areas or ways in OSM, but the
 * `pois` layer is intentionally point-based. Store a representative point so
 * station buildings, protected-area relations, power plants, etc. can still be
 * queried and labelled as POIs without changing the public layer schema.
 *
 * @param {string} layer
 * @param {Geometry} geometry
 * @returns {Geometry | null}
 */
function normalizeFeatureGeometryForLayer(layer, geometry) {
  if (layer !== 'pois') {
    return geometry;
  }

  const coordinate = representativePoint(geometry);
  if (!coordinate) {
    return null;
  }

  return {
    type: 'Point',
    coordinates: coordinate
  };
}

/**
 * @param {Geometry} geometry
 * @returns {[number, number] | null}
 */
function representativePoint(geometry) {
  if (geometry.type === 'Point' && isCoordinate(geometry.coordinates)) {
    return geometry.coordinates;
  }

  if (geometry.type === 'MultiPoint' && Array.isArray(geometry.coordinates)) {
    return firstCoordinate(geometry.coordinates);
  }

  if (geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
    return lineAnchor(geometry.coordinates);
  }

  if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
    const line = largestLine(geometry.coordinates);
    return line ? lineAnchor(line) : bboxCenter(geometry);
  }

  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    return polygonAnchor(geometry.coordinates) ?? bboxCenter(geometry);
  }

  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    const polygon = largestPolygon(geometry.coordinates);
    return polygon ? polygonAnchor(polygon) ?? bboxCenter(geometry) : bboxCenter(geometry);
  }

  return bboxCenter(geometry);
}

/**
 * @param {unknown} value
 * @returns {value is [number, number]}
 */
function isCoordinate(value) {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

/**
 * @param {unknown[]} values
 * @returns {[number, number] | null}
 */
function firstCoordinate(values) {
  for (const value of values) {
    if (isCoordinate(value)) {
      return value;
    }
  }
  return null;
}

/**
 * @param {unknown[]} coordinates
 * @returns {[number, number] | null}
 */
function lineAnchor(coordinates) {
  const line = coordinates.filter(isCoordinate);
  if (line.length === 0) {
    return null;
  }
  if (line.length === 1) {
    return line[0];
  }

  let totalLength = 0;
  for (let index = 1; index < line.length; index += 1) {
    totalLength += coordinateDistance(line[index - 1], line[index]);
  }

  if (totalLength === 0) {
    return line[Math.floor(line.length / 2)];
  }

  const target = totalLength / 2;
  let distance = 0;
  for (let index = 1; index < line.length; index += 1) {
    const previous = line[index - 1];
    const current = line[index];
    const segmentLength = coordinateDistance(previous, current);
    if (distance + segmentLength >= target) {
      const ratio = segmentLength === 0 ? 0 : (target - distance) / segmentLength;
      return [
        previous[0] + (current[0] - previous[0]) * ratio,
        previous[1] + (current[1] - previous[1]) * ratio
      ];
    }
    distance += segmentLength;
  }

  return line.at(-1) ?? null;
}

/**
 * @param {unknown[]} lines
 * @returns {unknown[] | null}
 */
function largestLine(lines) {
  /** @type {unknown[] | null} */
  let best = null;
  let bestLength = -1;

  for (const line of lines) {
    if (!Array.isArray(line)) {
      continue;
    }

    let length = 0;
    const coordinates = line.filter(isCoordinate);
    for (let index = 1; index < coordinates.length; index += 1) {
      length += coordinateDistance(coordinates[index - 1], coordinates[index]);
    }

    if (length > bestLength) {
      best = line;
      bestLength = length;
    }
  }

  return best;
}

/**
 * @param {unknown[]} polygon
 * @returns {[number, number] | null}
 */
function polygonAnchor(polygon) {
  const outerRing = Array.isArray(polygon[0]) ? /** @type {unknown[]} */ (polygon[0]) : [];
  const ring = outerRing.filter(isCoordinate);
  if (ring.length === 0) {
    return null;
  }

  const coordinates = ring.length > 1 && sameCoordinate(ring[0], ring.at(-1)) ? ring.slice(0, -1) : ring;
  const sum = coordinates.reduce((accumulator, coordinate) => {
    accumulator[0] += coordinate[0];
    accumulator[1] += coordinate[1];
    return accumulator;
  }, [0, 0]);
  /** @type {[number, number]} */
  const center = [sum[0] / coordinates.length, sum[1] / coordinates.length];

  return pointInRing(center, ring) ? center : ring[0];
}

/**
 * @param {unknown[]} polygons
 * @returns {unknown[] | null}
 */
function largestPolygon(polygons) {
  /** @type {unknown[] | null} */
  let best = null;
  let bestArea = -1;

  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) {
      continue;
    }

    const area = Math.abs(ringArea(/** @type {unknown[]} */ (polygon[0])));
    if (area > bestArea) {
      best = polygon;
      bestArea = area;
    }
  }

  return best;
}

/**
 * @param {unknown[]} ring
 * @returns {number}
 */
function ringArea(ring) {
  const coordinates = ring.filter(isCoordinate);
  let area = 0;

  for (let index = 0; index < coordinates.length; index += 1) {
    const current = coordinates[index];
    const next = coordinates[(index + 1) % coordinates.length];
    area += current[0] * next[1] - next[0] * current[1];
  }

  return area / 2;
}

/**
 * @param {[number, number]} a
 * @param {[number, number] | undefined} b
 * @returns {boolean}
 */
function sameCoordinate(a, b) {
  return Boolean(b) && a[0] === b[0] && a[1] === b[1];
}

/**
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number}
 */
function coordinateDistance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * @param {Geometry} geometry
 * @returns {[number, number] | null}
 */
function bboxCenter(geometry) {
  const bbox = geometryBbox(geometry);
  if (!bbox) {
    return null;
  }

  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

/**
 * @returns {string}
 */
function memorySummary() {
  const heap = process.memoryUsage().heapUsed / 1024 / 1024;
  return `${heap.toFixed(0)} MB heap`;
}

/**
 * Create an ID lookup that stays in memory for small extracts and spills to a
 * temporary SQLite database before hitting V8's Set size limit.
 *
 * @returns {{
 *   add: (id: string) => void,
 *   has: (id: string) => boolean,
 *   flush: () => void,
 *   close: () => void
 * }}
 */
function createNodeIdStore() {
  const memoryLimit = 250_000;
  const batchSize = 50_000;
  /** @type {Array<Set<string>> | null} */
  let memory = createSetBuckets(64);
  let memorySize = 0;
  /** @type {Database.Database | null} */
  let db = null;
  /** @type {Database.Statement<[string]> | null} */
  let insert = null;
  /** @type {Database.Statement<[string]> | null} */
  let select = null;
  /** @type {string[]} */
  let pending = [];

  const flushPending = () => {
    if (!db || !insert || pending.length === 0) {
      return;
    }

    const values = pending;
    pending = [];
    db.transaction((items) => {
      for (const id of items) {
        insert.run(id);
      }
    })(values);
  };

  const spill = () => {
    if (db || !memory) {
      return;
    }

    db = createTempDatabase();
    db.exec('CREATE TABLE node_ids (id TEXT PRIMARY KEY) WITHOUT ROWID');
    insert = db.prepare('INSERT OR IGNORE INTO node_ids (id) VALUES (?)');
    select = db.prepare('SELECT 1 FROM node_ids WHERE id = ?');
    pending = [];
    for (const bucket of memory) {
      pending.push(...bucket);
    }
    memory = null;
    flushPending();
  };

  return {
    add(id) {
      if (memory) {
        const bucket = memory[bucketIndex(id, memory.length)];
        if (!bucket.has(id)) {
          bucket.add(id);
          memorySize += 1;
        }
        if (memorySize >= memoryLimit) {
          spill();
        }
        return;
      }

      pending.push(id);
      if (pending.length >= batchSize) {
        flushPending();
      }
    },
    has(id) {
      if (memory) {
        return memory[bucketIndex(id, memory.length)].has(id);
      }

      flushPending();
      return Boolean(select?.get(id));
    },
    flush() {
      flushPending();
    },
    close() {
      flushPending();
      closeTempDatabase(db);
      db = null;
      memory = null;
      memorySize = 0;
      pending = [];
    }
  };
}

/**
 * Create a coordinate lookup that spills to SQLite for large extracts.
 *
 * @returns {{
 *   size: number,
 *   set: (id: string, coordinate: [number, number]) => void,
 *   get: (id: string) => [number, number] | undefined,
 *   flush: () => void,
 *   close: () => void
 * }}
 */
function createNodeCoordinateStore() {
  const memoryLimit = 250_000;
  const batchSize = 50_000;
  /** @type {Array<Map<string, [number, number]>> | null} */
  let memory = createMapBuckets(64);
  /** @type {Database.Database | null} */
  let db = null;
  /** @type {Database.Statement<[string, number, number]> | null} */
  let insert = null;
  /** @type {Database.Statement<[string]> | null} */
  let select = null;
  /** @type {Array<[string, number, number]>} */
  let pending = [];
  let size = 0;

  const flushPending = () => {
    if (!db || !insert || pending.length === 0) {
      return;
    }

    const values = pending;
    pending = [];
    db.transaction((items) => {
      for (const [id, lon, lat] of items) {
        insert.run(id, lon, lat);
      }
    })(values);
  };

  const spill = () => {
    if (db || !memory) {
      return;
    }

    db = createTempDatabase();
    db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, lon REAL NOT NULL, lat REAL NOT NULL) WITHOUT ROWID');
    insert = db.prepare('INSERT OR REPLACE INTO nodes (id, lon, lat) VALUES (?, ?, ?)');
    select = db.prepare('SELECT lon, lat FROM nodes WHERE id = ?');
    pending = [];
    for (const bucket of memory) {
      for (const [id, coordinate] of bucket) {
        pending.push([id, coordinate[0], coordinate[1]]);
      }
    }
    memory = null;
    flushPending();
  };

  return {
    get size() {
      return size;
    },
    set(id, coordinate) {
      if (memory) {
        const bucket = memory[bucketIndex(id, memory.length)];
        if (!bucket.has(id)) {
          size += 1;
        }
        bucket.set(id, coordinate);
        if (size >= memoryLimit) {
          spill();
        }
        return;
      }

      size += 1;
      pending.push([id, coordinate[0], coordinate[1]]);
      if (pending.length >= batchSize) {
        flushPending();
      }
    },
    get(id) {
      if (memory) {
        return memory[bucketIndex(id, memory.length)].get(id);
      }

      flushPending();
      const row = /** @type {{ lon: number, lat: number } | undefined} */ (select?.get(id));
      return row ? [row.lon, row.lat] : undefined;
    },
    flush() {
      flushPending();
    },
    close() {
      flushPending();
      closeTempDatabase(db);
      db = null;
      memory = null;
      pending = [];
      size = 0;
    }
  };
}

/**
 * @returns {Database.Database & { __mapZeroTempPath?: string }}
 */
function createTempDatabase() {
  const tempPath = join(tmpdir(), `map-zero-${process.pid}-${randomUUID()}.sqlite`);
  const db = /** @type {Database.Database & { __mapZeroTempPath?: string }} */ (new Database(tempPath));
  db.__mapZeroTempPath = tempPath;
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('locking_mode = EXCLUSIVE');
  db.pragma('cache_size = -64000');
  return db;
}

/**
 * @param {(Database.Database & { __mapZeroTempPath?: string }) | null} db
 */
function closeTempDatabase(db) {
  if (!db) {
    return;
  }

  const tempPath = db.__mapZeroTempPath;
  db.close();
  if (tempPath) {
    rmSync(tempPath, { force: true });
  }
}

/**
 * @param {number} count
 * @returns {Array<Set<string>>}
 */
function createSetBuckets(count) {
  return Array.from({ length: count }, () => new Set());
}

/**
 * @param {number} count
 * @returns {Array<Map<string, [number, number]>>}
 */
function createMapBuckets(count) {
  return Array.from({ length: count }, () => new Map());
}

/**
 * @param {string} id
 * @param {number} count
 * @returns {number}
 */
function bucketIndex(id, count) {
  const numeric = Number(id);
  if (Number.isSafeInteger(numeric)) {
    return Math.abs(numeric) % count;
  }

  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }

  return hash % count;
}

/**
 * Read the optional bbox from the first OSM PBF header block.
 *
 * @param {string} source
 * @returns {Promise<[number, number, number, number] | null>}
 */
function readOsmHeaderBbox(source) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(source);
    const blobParser = new BlobParser();
    const decompressor = new BlobDecompressor();
    let done = false;

    const finish = (bbox) => {
      if (done) {
        return;
      }

      done = true;
      stream.destroy();
      blobParser.destroy();
      decompressor.destroy();
      resolve(bbox);
    };

    const fail = (error) => {
      if (done) {
        return;
      }

      done = true;
      reject(error);
    };

    stream
      .on('error', fail)
      .pipe(blobParser)
      .on('error', fail)
      .pipe(decompressor)
      .on('error', fail)
      .on('data', (chunk) => {
        if (chunk.type !== 'OSMHeader') {
          return;
        }

        const header = osmPbfParsers.osm.HeaderBlock.decode(chunk.data);
        finish(normalizeHeaderBbox(header.bbox));
      })
      .on('end', () => {
        finish(null);
      });
  });
}

/**
 * @param {unknown} headerBbox
 * @returns {[number, number, number, number] | null}
 */
function normalizeHeaderBbox(headerBbox) {
  if (!headerBbox || typeof headerBbox !== 'object') {
    return null;
  }

  const bbox = /** @type {{ left?: unknown, bottom?: unknown, right?: unknown, top?: unknown }} */ (headerBbox);
  const left = osmCoordinateNumber(bbox.left);
  const bottom = osmCoordinateNumber(bbox.bottom);
  const right = osmCoordinateNumber(bbox.right);
  const top = osmCoordinateNumber(bbox.top);

  if (
    !Number.isFinite(left) ||
    !Number.isFinite(bottom) ||
    !Number.isFinite(right) ||
    !Number.isFinite(top) ||
    left >= right ||
    bottom >= top
  ) {
    return null;
  }

  return [left, bottom, right, top];
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function osmCoordinateNumber(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric * 1e-9;
  }

  if (value && typeof value === 'object' && typeof value.toString === 'function') {
    const fromString = Number(value.toString());
    if (Number.isFinite(fromString)) {
      return fromString * 1e-9;
    }
  }

  return Number.NaN;
}

/**
 * @param {[number, number, number, number]} bbox
 * @returns {string}
 */
function formatBbox(bbox) {
  return bbox.map((value) => Number(value.toFixed(7))).join(',');
}

/**
 * @param {Record<string, Feature[]>} features
 * @returns {number}
 */
function countFeatures(features) {
  return Object.values(features).reduce((total, layerFeatures) => total + layerFeatures.length, 0);
}

/**
 * @param {Record<string, unknown>} entity
 * @param {Record<string, string>} tags
 * @returns {WaySummary}
 */
function summarizeWay(entity, tags) {
  return {
    id: String(entity.id),
    type: 'way',
    tags,
    refs: getWayRefs(entity)
  };
}

/**
 * @param {Record<string, unknown>} entity
 * @param {Record<string, string>} tags
 * @param {string[]} layers
 * @returns {RelationSummary}
 */
function summarizeRelation(entity, tags, layers) {
  return {
    id: String(entity.id),
    type: 'relation',
    tags,
    layers,
    members: getRelationMembers(entity)
  };
}

/**
 * @param {string[]} layers
 * @returns {Record<string, Feature[]>}
 */
function createFeatureBuckets(layers) {
  /** @type {Record<string, Feature[]>} */
  const features = {};
  for (const layer of layers) {
    features[layer] = [];
  }
  return features;
}

/**
 * @param {Record<string, Feature[]>} features
 * @param {string} layer
 * @param {Geometry | null} geometry
 * @param {[number, number, number, number]} bbox
 * @param {{ id: string | number, type: string, tags: Record<string, string> }} entity
 */
function addFeatureIfInside(features, layer, geometry, bbox, entity) {
  if (!geometry) {
    return;
  }

  const normalizedGeometry = normalizeFeatureGeometryForLayer(layer, geometry);
  if (!normalizedGeometry) {
    return;
  }

  const featureBbox = geometryBbox(normalizedGeometry);
  if (!featureBbox || !bboxIntersects(featureBbox, bbox)) {
    return;
  }

  features[layer].push({
    geometry: normalizedGeometry,
    properties: propertiesForLayer(layer, entity),
    bbox: featureBbox
  });
}

/**
 * @param {string} layer
 * @param {WaySummary} way
 * @param {Map<string, [number, number]>} nodes
 * @returns {Geometry | null}
 */
function buildWayGeometry(layer, way, nodes) {
  if (layer === 'roads' || layer === 'railways' || layer === 'coastline' || layer === 'cliffs') {
    return buildLineString(way.refs, nodes);
  }

  if (layer === 'boundaries') {
    return isClosedRefs(way.refs) ? buildWayMultiPolygon(way.refs, nodes) : buildLineString(way.refs, nodes);
  }

  if (layer === 'aip' || layer === 'aviation') {
    return buildAviationWayGeometry(way, nodes);
  }

  if (layer === 'pois') {
    return isClosedRefs(way.refs) ? buildWayMultiPolygon(way.refs, nodes) : buildLineString(way.refs, nodes);
  }

  return buildWayMultiPolygon(way.refs, nodes);
}

/**
 * @param {WaySummary} way
 * @param {Map<string, [number, number]>} nodes
 * @returns {Geometry | null}
 */
function buildAviationWayGeometry(way, nodes) {
  const aeroway = way.tags.aeroway;
  const polygonPreferred = aeroway === 'apron' || aeroway === 'terminal' || aeroway === 'helipad';

  if (isClosedRefs(way.refs)) {
    return buildWayMultiPolygon(way.refs, nodes);
  }

  if (polygonPreferred) {
    return null;
  }

  return buildLineString(way.refs, nodes);
}

/**
 * @param {string} layer
 * @param {RelationSummary} relation
 * @param {Map<string, WaySummary>} relationWays
 * @param {Map<string, WaySummary & { layers: string[] }>} candidateWays
 * @param {Map<string, [number, number]>} nodes
 * @returns {Geometry | null}
 */
function buildRelationGeometry(layer, relation, relationWays, candidateWays, nodes) {
  const multipolygon = buildRelationMultiPolygon(relation, relationWays, candidateWays, nodes);

  if (layer === 'coastline' || layer === 'cliffs') {
    return multipolygon ?? buildRelationMultiLineString(relation, relationWays, candidateWays, nodes);
  }

  if (multipolygon || (layer !== 'boundaries' && layer !== 'pois')) {
    return multipolygon;
  }

  return buildRelationMultiLineString(relation, relationWays, candidateWays, nodes);
}

/**
 * @param {string[]} refs
 * @param {Map<string, [number, number]>} nodes
 * @returns {Geometry | null}
 */
function buildLineString(refs, nodes) {
  const coordinates = dedupeCoordinates(coordsForRefs(refs, nodes));

  if (coordinates.length < 2) {
    return null;
  }

  return {
    type: 'LineString',
    coordinates
  };
}

/**
 * @param {string[]} refs
 * @param {Map<string, [number, number]>} nodes
 * @returns {Geometry | null}
 */
function buildWayMultiPolygon(refs, nodes) {
  if (!isClosedRefs(refs)) {
    return null;
  }

  const ring = closeRing(coordsForRefs(refs, nodes));

  if (ring.length < 4) {
    return null;
  }

  return {
    type: 'MultiPolygon',
    coordinates: [[ring]]
  };
}

/**
 * @param {RelationSummary} relation
 * @param {Map<string, WaySummary>} relationWays
 * @param {Map<string, WaySummary & { layers: string[] }>} candidateWays
 * @param {Map<string, [number, number]>} nodes
 * @returns {Geometry | null}
 */
function buildRelationMultiPolygon(relation, relationWays, candidateWays, nodes) {
  const outerSequences = [];
  const innerSequences = [];

  for (const member of relation.members) {
    if (member.type !== 'way') {
      continue;
    }

    const way = relationWays.get(member.id) ?? candidateWays.get(member.id);
    if (!way || way.refs.length < 2) {
      continue;
    }

    if (member.role === 'inner') {
      innerSequences.push(way.refs);
    } else {
      outerSequences.push(way.refs);
    }
  }

  const outerRings = assembleClosedRings(outerSequences)
    .map((refs) => closeRing(coordsForRefs(refs, nodes)))
    .filter((ring) => ring.length >= 4);

  if (outerRings.length === 0) {
    return null;
  }

  const innerRings = assembleClosedRings(innerSequences)
    .map((refs) => closeRing(coordsForRefs(refs, nodes)))
    .filter((ring) => ring.length >= 4);

  const polygons = outerRings.map((outer) => [outer]);

  for (const inner of innerRings) {
    const sample = inner[0];
    const polygon = polygons.find(([outer]) => pointInRing(sample, outer));
    if (polygon) {
      polygon.push(inner);
    }
  }

  return {
    type: 'MultiPolygon',
    coordinates: polygons
  };
}

/**
 * @param {RelationSummary} relation
 * @param {Map<string, WaySummary>} relationWays
 * @param {Map<string, WaySummary & { layers: string[] }>} candidateWays
 * @param {Map<string, [number, number]>} nodes
 * @returns {Geometry | null}
 */
function buildRelationMultiLineString(relation, relationWays, candidateWays, nodes) {
  const lines = [];

  for (const member of relation.members) {
    if (member.type !== 'way') {
      continue;
    }

    const way = relationWays.get(member.id) ?? candidateWays.get(member.id);
    if (!way) {
      continue;
    }

    const coordinates = dedupeCoordinates(coordsForRefs(way.refs, nodes));
    if (coordinates.length >= 2) {
      lines.push(coordinates);
    }
  }

  if (lines.length === 0) {
    return null;
  }

  if (lines.length === 1) {
    return {
      type: 'LineString',
      coordinates: lines[0]
    };
  }

  return {
    type: 'MultiLineString',
    coordinates: lines
  };
}

/**
 * @param {Array<string[]>} sequences
 * @returns {Array<string[]>}
 */
function assembleClosedRings(sequences) {
  const remaining = sequences.map((sequence) => [...sequence]).filter((sequence) => sequence.length >= 2);
  const rings = [];

  while (remaining.length > 0) {
    let current = /** @type {string[]} */ (remaining.shift());
    let changed = true;

    while (!isClosedRefs(current) && changed) {
      changed = false;

      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const first = current[0];
        const last = current.at(-1);
        const candidateFirst = candidate[0];
        const candidateLast = candidate.at(-1);

        if (last === candidateFirst) {
          current = current.concat(candidate.slice(1));
        } else if (last === candidateLast) {
          current = current.concat([...candidate].reverse().slice(1));
        } else if (first === candidateLast) {
          current = candidate.concat(current.slice(1));
        } else if (first === candidateFirst) {
          current = [...candidate].reverse().concat(current.slice(1));
        } else {
          continue;
        }

        remaining.splice(index, 1);
        changed = true;
        break;
      }
    }

    if (isClosedRefs(current) && current.length >= 4) {
      rings.push(current);
    }
  }

  return rings;
}

/**
 * @param {string[]} refs
 * @param {Map<string, [number, number]>} nodes
 * @returns {Array<[number, number]>}
 */
function coordsForRefs(refs, nodes) {
  /** @type {Array<[number, number]>} */
  const coordinates = [];

  for (const ref of refs) {
    const coordinate = nodes.get(ref);
    if (coordinate) {
      coordinates.push(coordinate);
    }
  }

  return coordinates;
}

/**
 * @param {string[]} refs
 * @returns {boolean}
 */
function isClosedRefs(refs) {
  return refs.length >= 4 && refs[0] === refs.at(-1);
}

/**
 * @param {Record<string, unknown>} entity
 * @returns {Record<string, string>}
 */
function getTags(entity) {
  const tags = entity.tags;

  if (!tags) {
    return {};
  }

  if (Array.isArray(tags)) {
    /** @type {Record<string, string>} */
    const normalized = {};
    for (const tag of tags) {
      if (Array.isArray(tag) && tag.length >= 2) {
        normalized[String(tag[0])] = String(tag[1]);
      } else if (tag && typeof tag === 'object' && 'k' in tag && 'v' in tag) {
        normalized[String(tag.k)] = String(tag.v);
      }
    }
    return normalized;
  }

  if (typeof tags === 'object') {
    /** @type {Record<string, string>} */
    const normalized = {};
    for (const [key, value] of Object.entries(tags)) {
      normalized[key] = String(value);
    }
    return normalized;
  }

  return {};
}

/**
 * @param {Record<string, unknown>} entity
 * @returns {string[]}
 */
function getWayRefs(entity) {
  const refs = entity.refs ?? entity.nodes ?? entity.nodeRefs;

  if (!Array.isArray(refs)) {
    return [];
  }

  return refs.map((ref) => String(ref));
}

/**
 * @param {Record<string, unknown>} entity
 * @returns {RelationMember[]}
 */
function getRelationMembers(entity) {
  const members = entity.members;

  if (!Array.isArray(members)) {
    return [];
  }

  return members.map((member) => {
    const record = /** @type {Record<string, unknown>} */ (member);
    return {
      id: String(record.id ?? record.ref),
      type: normalizeMemberType(record.type),
      role: String(record.role ?? '')
    };
  });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeMemberType(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value === 0) {
    return 'node';
  }

  if (value === 1) {
    return 'way';
  }

  if (value === 2) {
    return 'relation';
  }

  return String(value);
}

/**
 * @param {Record<string, unknown>} entity
 * @returns {[number, number] | null}
 */
function getNodeCoordinate(entity) {
  const lon = Number(entity.lon ?? entity.longitude ?? entity.x);
  const lat = Number(entity.lat ?? entity.latitude ?? entity.y);

  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null;
  }

  return [lon, lat];
}
