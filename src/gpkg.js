import { existsSync, unlinkSync } from 'node:fs';

import Database from 'better-sqlite3';

import { LAYER_DEFINITIONS } from './layers.js';
import { geometryBbox, quoteIdentifier } from './utils.js';

const SRS_ID = 4326;

/**
 * @typedef {{ type: string, coordinates: unknown }} Geometry
 * @typedef {{ geometry: Geometry, properties: Record<string, string | null>, bbox?: [number, number, number, number] }} Feature
 */

/**
 * Write selected features into a GeoPackage.
 *
 * @param {string} filePath
 * @param {Record<string, Feature[]>} featuresByLayer
 * @param {string[]} layers
 * @param {[number, number, number, number]} packageBbox
 */
export function writeGeoPackage(filePath, featuresByLayer, layers, packageBbox) {
  const writer = openGeoPackageWriter(filePath, layers, packageBbox);

  try {
    writer.transaction(() => {
      for (const layer of layers) {
        for (const feature of featuresByLayer[layer] ?? []) {
          writer.insertFeature(layer, feature);
        }
      }
    });
  } finally {
    writer.close();
  }
}

/**
 * Open a GeoPackage writer that accepts features incrementally.
 *
 * @param {string} filePath
 * @param {string[]} layers
 * @param {[number, number, number, number]} packageBbox
 * @returns {{
 *   insertFeature: (layer: string, feature: Feature) => void,
 *   transaction: (fn: () => void) => void,
 *   counts: () => Record<string, number>,
 *   close: () => void
 * }}
 */
export function openGeoPackageWriter(filePath, layers, packageBbox) {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  const db = new Database(filePath);
  /** @type {Record<string, { insert: Database.Statement, spatialIndex: { insert: Database.Statement } | null, propertyColumns: string[] }>} */
  const layerWriters = {};
  /** @type {Record<string, number>} */
  const featureCounts = Object.fromEntries(layers.map((layer) => [layer, 0]));
  const seenFeatureIds = Object.fromEntries(layers.map((layer) => [layer, new Set()]));
  let closed = false;

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('application_id = 1196444487');
  db.pragma('user_version = 10400');

  db.transaction(() => {
    createCoreTables(db);

    for (const layer of layers) {
      createFeatureTable(db, layer);
      registerFeatureTable(db, layer, [], packageBbox);
      layerWriters[layer] = createLayerWriter(db, layer);
    }
  })();

  return {
    insertFeature(layer, feature) {
      const writer = layerWriters[layer];
      if (!writer) {
        throw new Error(`unknown GeoPackage layer: ${layer}`);
      }

      const featureId = feature.properties.id;
      if (featureId) {
        const seen = seenFeatureIds[layer];
        if (seen.has(featureId)) {
          return;
        }
        seen.add(featureId);
      }

      const values = [
        encodeGeoPackageGeometry(feature.geometry),
        ...writer.propertyColumns.map((column) => feature.properties[column] ?? null)
      ];
      const info = writer.insert.run(values);
      featureCounts[layer] += 1;

      if (writer.spatialIndex) {
        const bbox = feature.bbox ?? geometryBbox(feature.geometry);
        if (bbox) {
          writer.spatialIndex.insert.run(info.lastInsertRowid, bbox[0], bbox[2], bbox[1], bbox[3]);
        }
      }
    },
    transaction(fn) {
      db.transaction(fn)();
    },
    counts() {
      return { ...featureCounts };
    },
    close() {
      if (closed) {
        return;
      }

      for (const layer of layers) {
        if (layerWriters[layer]?.spatialIndex) {
          createSpatialIndexMetadata(db, layer);
        }
      }

      closed = true;
      db.close();
    }
  };
}

/**
 * @param {Database.Database} db
 */
function createCoreTables(db) {
  db.exec(`
    CREATE TABLE gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL,
      description TEXT
    );

    INSERT INTO gpkg_spatial_ref_sys (
      srs_name,
      srs_id,
      organization,
      organization_coordsys_id,
      definition,
      description
    ) VALUES
      ('Undefined Cartesian', -1, 'NONE', -1, 'undefined', 'undefined Cartesian coordinate reference system'),
      ('Undefined Geographic', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system'),
      (
        'WGS 84 geodetic',
        4326,
        'EPSG',
        4326,
        'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
        'longitude/latitude coordinates in decimal degrees on the WGS 84 datum'
      );

    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY,
      data_type TEXT NOT NULL,
      identifier TEXT UNIQUE,
      description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE,
      min_y DOUBLE,
      max_x DOUBLE,
      max_y DOUBLE,
      srs_id INTEGER,
      CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
    );

    CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      geometry_type_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL,
      m TINYINT NOT NULL,
      PRIMARY KEY (table_name, column_name),
      CONSTRAINT fk_ggc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
      CONSTRAINT fk_ggc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
    );
  `);
}

/**
 * @param {Database.Database} db
 * @param {string} layer
 */
function createFeatureTable(db, layer) {
  const definition = LAYER_DEFINITIONS[layer];
  const columns = definition.columns
    .map((column) => `${quoteIdentifier(column)} TEXT`)
    .join(',\n      ');

  db.exec(`
    CREATE TABLE ${quoteIdentifier(layer)} (
      ${quoteIdentifier('fid')} INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      ${quoteIdentifier('geom')} BLOB NOT NULL,
      ${columns}
    );
  `);
}

/**
 * @param {Database.Database} db
 * @param {string} layer
 * @param {Feature[]} features
 * @param {[number, number, number, number]} packageBbox
 */
function registerFeatureTable(db, layer, features, packageBbox) {
  const definition = LAYER_DEFINITIONS[layer];
  const bbox = features.length > 0 ? mergeFeatureBboxes(features) : packageBbox;

  db.prepare(`
    INSERT INTO gpkg_contents (
      table_name,
      data_type,
      identifier,
      description,
      min_x,
      min_y,
      max_x,
      max_y,
      srs_id
    ) VALUES (?, 'features', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    layer,
    layer,
    `map-zero ${layer}`,
    bbox[0],
    bbox[1],
    bbox[2],
    bbox[3],
    SRS_ID
  );

  db.prepare(`
    INSERT INTO gpkg_geometry_columns (
      table_name,
      column_name,
      geometry_type_name,
      srs_id,
      z,
      m
    ) VALUES (?, 'geom', ?, ?, 0, 0)
  `).run(layer, definition.gpkgGeometryType, SRS_ID);
}

/**
 * @param {Database.Database} db
 * @param {string} layer
 * @param {Feature[]} features
 */
function insertFeatures(db, layer, features) {
  const writer = createLayerWriter(db, layer);

  for (const feature of features) {
    const values = [
      encodeGeoPackageGeometry(feature.geometry),
      ...writer.propertyColumns.map((column) => feature.properties[column] ?? null)
    ];
    const info = writer.insert.run(values);

    if (writer.spatialIndex) {
      const bbox = feature.bbox ?? geometryBbox(feature.geometry);
      if (bbox) {
        writer.spatialIndex.insert.run(info.lastInsertRowid, bbox[0], bbox[2], bbox[1], bbox[3]);
      }
    }
  }

  if (writer.spatialIndex) {
    createSpatialIndexMetadata(db, layer);
  }
}

/**
 * @param {Database.Database} db
 * @param {string} layer
 * @returns {{ insert: Database.Statement, spatialIndex: { insert: Database.Statement } | null, propertyColumns: string[] }}
 */
function createLayerWriter(db, layer) {
  const definition = LAYER_DEFINITIONS[layer];
  const table = quoteIdentifier(layer);
  const propertyColumns = definition.columns;
  const columns = ['geom', ...propertyColumns];
  const insertSql = `
    INSERT INTO ${table} (${columns.map(quoteIdentifier).join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `;

  return {
    insert: db.prepare(insertSql),
    spatialIndex: createSpatialIndex(db, layer),
    propertyColumns
  };
}

/**
 * @param {Database.Database} db
 * @param {string} layer
 * @returns {{ insert: Database.Statement } | null}
 */
function createSpatialIndex(db, layer) {
  const rtree = quoteIdentifier(`rtree_${layer}_geom`);

  try {
    db.exec(`CREATE VIRTUAL TABLE ${rtree} USING rtree(id, minx, maxx, miny, maxy);`);
    return {
      insert: db.prepare(`INSERT INTO ${rtree} (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)`)
    };
  } catch {
    return null;
  }
}

/**
 * Register the GeoPackage RTree extension after manual index population.
 *
 * @param {Database.Database} db
 * @param {string} layer
 */
function createSpatialIndexMetadata(db, layer) {
  const table = quoteIdentifier(layer);
  const rtree = quoteIdentifier(`rtree_${layer}_geom`);
  const fid = quoteIdentifier('fid');
  const geom = quoteIdentifier('geom');

  db.exec(`
    CREATE TABLE IF NOT EXISTS gpkg_extensions (
      table_name TEXT,
      column_name TEXT,
      extension_name TEXT NOT NULL,
      definition TEXT NOT NULL,
      scope TEXT NOT NULL,
      CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name)
    );
  `);

  db.prepare(`
    INSERT OR REPLACE INTO gpkg_extensions (
      table_name,
      column_name,
      extension_name,
      definition,
      scope
    ) VALUES (?, 'geom', 'gpkg_rtree_index', 'http://www.geopackage.org/spec/#extension_rtree', 'write-only')
  `).run(layer);

  db.exec(`
    CREATE TRIGGER ${quoteIdentifier(`rtree_${layer}_geom_insert`)}
    AFTER INSERT ON ${table}
    WHEN (NEW.${geom} NOT NULL AND NOT ST_IsEmpty(NEW.${geom}))
    BEGIN
      INSERT OR REPLACE INTO ${rtree}
      VALUES (
        NEW.${fid},
        ST_MinX(NEW.${geom}),
        ST_MaxX(NEW.${geom}),
        ST_MinY(NEW.${geom}),
        ST_MaxY(NEW.${geom})
      );
    END;

    CREATE TRIGGER ${quoteIdentifier(`rtree_${layer}_geom_update1`)}
    AFTER UPDATE OF ${geom} ON ${table}
    WHEN OLD.${fid} = NEW.${fid} AND (NEW.${geom} NOT NULL AND NOT ST_IsEmpty(NEW.${geom}))
    BEGIN
      INSERT OR REPLACE INTO ${rtree}
      VALUES (
        NEW.${fid},
        ST_MinX(NEW.${geom}),
        ST_MaxX(NEW.${geom}),
        ST_MinY(NEW.${geom}),
        ST_MaxY(NEW.${geom})
      );
    END;

    CREATE TRIGGER ${quoteIdentifier(`rtree_${layer}_geom_update2`)}
    AFTER UPDATE OF ${geom} ON ${table}
    WHEN OLD.${fid} = NEW.${fid} AND (NEW.${geom} ISNULL OR ST_IsEmpty(NEW.${geom}))
    BEGIN
      DELETE FROM ${rtree} WHERE id = OLD.${fid};
    END;

    CREATE TRIGGER ${quoteIdentifier(`rtree_${layer}_geom_update3`)}
    AFTER UPDATE ON ${table}
    WHEN OLD.${fid} != NEW.${fid} AND (NEW.${geom} NOT NULL AND NOT ST_IsEmpty(NEW.${geom}))
    BEGIN
      DELETE FROM ${rtree} WHERE id = OLD.${fid};
      INSERT OR REPLACE INTO ${rtree}
      VALUES (
        NEW.${fid},
        ST_MinX(NEW.${geom}),
        ST_MaxX(NEW.${geom}),
        ST_MinY(NEW.${geom}),
        ST_MaxY(NEW.${geom})
      );
    END;

    CREATE TRIGGER ${quoteIdentifier(`rtree_${layer}_geom_update4`)}
    AFTER UPDATE ON ${table}
    WHEN OLD.${fid} != NEW.${fid} AND (NEW.${geom} ISNULL OR ST_IsEmpty(NEW.${geom}))
    BEGIN
      DELETE FROM ${rtree} WHERE id IN (OLD.${fid}, NEW.${fid});
    END;

    CREATE TRIGGER ${quoteIdentifier(`rtree_${layer}_geom_delete`)}
    AFTER DELETE ON ${table}
    WHEN OLD.${geom} NOT NULL
    BEGIN
      DELETE FROM ${rtree} WHERE id = OLD.${fid};
    END;
  `);
}

/**
 * @param {Feature[]} features
 * @returns {[number, number, number, number]}
 */
function mergeFeatureBboxes(features) {
  /** @type {[number, number, number, number] | null} */
  let bbox = null;

  for (const feature of features) {
    const featureBbox = feature.bbox ?? geometryBbox(feature.geometry);
    if (!featureBbox) {
      continue;
    }

    if (!bbox) {
      bbox = [...featureBbox];
      continue;
    }

    bbox[0] = Math.min(bbox[0], featureBbox[0]);
    bbox[1] = Math.min(bbox[1], featureBbox[1]);
    bbox[2] = Math.max(bbox[2], featureBbox[2]);
    bbox[3] = Math.max(bbox[3], featureBbox[3]);
  }

  return bbox ?? [0, 0, 0, 0];
}

/**
 * Encode a GeoJSON-like geometry as GeoPackage binary geometry.
 *
 * @param {Geometry} geometry
 * @returns {Buffer}
 */
function encodeGeoPackageGeometry(geometry) {
  const header = Buffer.alloc(8);
  header.writeUInt8(0x47, 0);
  header.writeUInt8(0x50, 1);
  header.writeUInt8(0, 2);
  header.writeUInt8(1, 3);
  header.writeInt32LE(SRS_ID, 4);

  return Buffer.concat([header, encodeWkbGeometry(geometry)]);
}

/**
 * @param {Geometry} geometry
 * @returns {Buffer}
 */
function encodeWkbGeometry(geometry) {
  switch (geometry.type) {
    case 'Point':
      return concatWkb([
        uint8(1),
        uint32(1),
        double(/** @type {[number, number]} */ (geometry.coordinates)[0]),
        double(/** @type {[number, number]} */ (geometry.coordinates)[1])
      ]);

    case 'LineString':
      return encodeWkbLineString(/** @type {Array<[number, number]>} */ (geometry.coordinates));

    case 'MultiLineString':
      return concatWkb([
        uint8(1),
        uint32(5),
        uint32(/** @type {Array<Array<[number, number]>>} */ (geometry.coordinates).length),
        .../** @type {Array<Array<[number, number]>>} */ (geometry.coordinates).map(encodeWkbLineString)
      ]);

    case 'Polygon':
      return encodeWkbPolygon(/** @type {Array<Array<[number, number]>>} */ (geometry.coordinates));

    case 'MultiPolygon':
      return concatWkb([
        uint8(1),
        uint32(6),
        uint32(/** @type {Array<Array<Array<[number, number]>>>} */ (geometry.coordinates).length),
        .../** @type {Array<Array<Array<[number, number]>>>} */ (geometry.coordinates).map(encodeWkbPolygon)
      ]);

    default:
      throw new Error(`unsupported geometry type: ${geometry.type}`);
  }
}

/**
 * @param {Array<[number, number]>} coordinates
 * @returns {Buffer}
 */
function encodeWkbLineString(coordinates) {
  return concatWkb([
    uint8(1),
    uint32(2),
    uint32(coordinates.length),
    ...coordinates.flatMap(([x, y]) => [double(x), double(y)])
  ]);
}

/**
 * @param {Array<Array<[number, number]>>} rings
 * @returns {Buffer}
 */
function encodeWkbPolygon(rings) {
  return concatWkb([
    uint8(1),
    uint32(3),
    uint32(rings.length),
    ...rings.flatMap((ring) => [
      uint32(ring.length),
      ...ring.flatMap(([x, y]) => [double(x), double(y)])
    ])
  ]);
}

/**
 * @param {Buffer[]} parts
 * @returns {Buffer}
 */
function concatWkb(parts) {
  return Buffer.concat(parts);
}

/**
 * @param {number} value
 * @returns {Buffer}
 */
function uint8(value) {
  const buffer = Buffer.alloc(1);
  buffer.writeUInt8(value);
  return buffer;
}

/**
 * @param {number} value
 * @returns {Buffer}
 */
function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

/**
 * @param {number} value
 * @returns {Buffer}
 */
function double(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value);
  return buffer;
}
