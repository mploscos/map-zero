import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import Database from 'better-sqlite3';

import { buildPackage } from '../src/build.js';
import { openGeoPackageWriter, writeGeoPackage } from '../src/gpkg.js';
import { openGeoPackageReader } from '../src/gpkg-read.js';
import { geoPackageLayersForOsm, LAYER_DEFINITIONS, SUPPORTED_LAYERS } from '../src/layers.js';
import { quoteIdentifier } from '../src/utils.js';

const bbox = [-5, -5, 5, 5];
const point = { type: 'Point', coordinates: [0, 0] };
const line = [[0, 0], [1, 1]];
const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
const geometries = [
  point,
  { type: 'LineString', coordinates: line },
  { type: 'MultiLineString', coordinates: [line, [[2, 2], [3, 3]]] },
  { type: 'Polygon', coordinates: [ring] },
  { type: 'MultiPolygon', coordinates: [[ring]] }
];

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'map-zero-gpkg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, gpkgPath: join(dir, 'data.gpkg') };
}

function withReader(gpkgPath, layers, fn) {
  const reader = openGeoPackageReader({ gpkgPath, manifest: { layers } });
  try {
    fn(reader);
  } finally {
    reader.close();
  }
}

function withDatabase(gpkgPath, fn) {
  const db = new Database(gpkgPath, { readonly: true, fileMustExist: true });
  try {
    fn(db);
  } finally {
    db.close();
  }
}

test('external GeoPackage layer preserves TEXT, INTEGER, REAL and NULL on read', async (t) => {
  const { gpkgPath } = await fixture(t);
  const layers = [{
    id: 'airspaces',
    geometryType: 'POLYGON',
    columns: { id: 'TEXT', name: 'TEXT', priority: 'INTEGER', lowerLimitM: 'REAL', upperLimitM: 'REAL' }
  }];
  const properties = [
    { id: 'zone-1', name: 'Área "Norte"', priority: 7, lowerLimitM: -12.5, upperLimitM: 1234.75 },
    { id: 'zone-2', name: '', priority: 0, lowerLimitM: 0, upperLimitM: 0 },
    { id: 'zone-3', name: null, priority: null, lowerLimitM: null }
  ];
  writeGeoPackage(gpkgPath, {
    airspaces: properties.map((properties) => ({ geometry: geometries[3], properties }))
  }, layers, bbox);

  withDatabase(gpkgPath, (db) => {
    assert.deepEqual(db.pragma('table_info(airspaces)').map(({ name, type }) => [name, type]), [
      ['fid', 'INTEGER'], ['geom', 'BLOB'], ['id', 'TEXT'], ['name', 'TEXT'],
      ['priority', 'INTEGER'], ['lowerLimitM', 'REAL'], ['upperLimitM', 'REAL']
    ]);
    assert.deepEqual(db.prepare(`
      SELECT typeof(name) AS text, typeof(priority) AS integer,
        typeof(lowerLimitM) AS real FROM airspaces WHERE id = 'zone-1'
    `).get(), { text: 'text', integer: 'integer', real: 'real' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM rtree_airspaces_geom').get().n, 3);
    assert.equal(db.prepare('SELECT geom FROM airspaces LIMIT 1').get().geom.readInt32LE(4), 4326);
    assert.deepEqual(db.prepare('SELECT srs_id, organization FROM gpkg_spatial_ref_sys WHERE srs_id = 4326').get(), {
      srs_id: 4326, organization: 'EPSG'
    });
    assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE type = ?').get('trigger').n, 6);
    assert.equal(db.prepare('SELECT extension_name FROM gpkg_extensions').get().extension_name, 'gpkg_rtree_index');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });

  withReader(gpkgPath, ['airspaces'], (reader) => {
    const [metadata] = reader.getLayers();
    assert.equal(metadata.geometryType, 'POLYGON');
    assert.equal(metadata.srsId, 4326);
    assert.equal(metadata.rtree, 'rtree_airspaces_geom');
    assert.deepEqual(metadata.bbox, bbox);
    const features = reader.getTileFeatures('airspaces', bbox).sort((a, b) => a.id - b.id);
    assert.deepEqual(features.map(({ properties: { fid, ...values } }) => values), [
      properties[0], properties[1], { ...properties[2], upperLimitM: null }
    ]);
    assert.deepEqual(features[0].geometry, geometries[3]);
    assert.deepEqual(reader.getTileFeatures('airspaces', [3, 3, 4, 4]), []);
    assert.deepEqual(reader.getTileFeatures('airspaces', bbox, {
      all: [{ column: 'upperLimitM', minNumber: 1200 }]
    }).map((feature) => feature.properties.id), ['zone-1']);
  });
});

test('incremental GeoPackage writes preserve all geometry types and mixed GEOMETRY tables', async (t) => {
  const { gpkgPath } = await fixture(t);
  const layers = geometries.map((geometry) => ({
    id: geometry.type,
    geometryType: geometry.type.toUpperCase(),
    columns: { id: 'INTEGER' }
  }));
  layers.push({ id: 'mixed', geometryType: 'GEOMETRY', columns: { id: 'INTEGER' } });
  const writer = openGeoPackageWriter(gpkgPath, layers, bbox);
  try {
    for (const [id, geometry] of geometries.entries()) {
      const feature = { geometry, properties: { id } };
      writer.transaction(() => {
        writer.insertFeature('mixed', feature);
        writer.insertFeature(geometry.type, feature);
      });
    }
    // A second batch and a standalone write must not duplicate ids, including 0.
    writer.transaction(() => {
      for (const [id, geometry] of geometries.entries()) {
        writer.insertFeature('mixed', { geometry, properties: { id } });
      }
    });
    writer.insertFeature('mixed', { geometry: point, properties: { id: 0 } });
    assert.deepEqual(writer.counts(), { Point: 1, LineString: 1, MultiLineString: 1, Polygon: 1, MultiPolygon: 1, mixed: 5 });
    assert.throws(() => writer.insertFeature('toString', { geometry: point, properties: {} }), /unknown GeoPackage layer/);
  } finally {
    writer.close();
  }
  writer.close();

  withReader(gpkgPath, layers.map(({ id }) => id), (reader) => {
    const mixed = reader.getTileFeatures('mixed', bbox).sort((a, b) => a.properties.id - b.properties.id);
    assert.deepEqual(mixed.map(({ geometry }) => geometry), geometries);
    for (const geometry of geometries) {
      const [feature] = reader.getTileFeatures(geometry.type, bbox);
      assert.deepEqual(feature.geometry, geometry);
    }
    assert.equal(reader.getLayers().find(({ id }) => id === 'mixed').geometryType, 'GEOMETRY');
  });
});

test('GeoPackage keeps features without ids and quotes externally supplied SQL identifiers', async (t) => {
  const { gpkgPath } = await fixture(t);
  const id = 'external "layer"';
  writeGeoPackage(gpkgPath, {
    [id]: [null, '', undefined].map((id) => ({ geometry: point, properties: { id, 'select "value"': 4.5 } })),
    geometryOnly: [{ geometry: point, properties: {} }]
  }, [
    { id, geometryType: 'POINT', columns: { id: 'TEXT', 'select "value"': 'REAL' } },
    { id: 'geometryOnly', geometryType: 'POINT', columns: {} }
  ], bbox);
  withReader(gpkgPath, [id, 'geometryOnly'], (reader) => {
    const features = reader.getTileFeatures(id, bbox);
    assert.equal(features.length, 3);
    assert.ok(features.every((feature) => feature.properties['select "value"'] === 4.5));
    assert.deepEqual(reader.getTileFeatures('geometryOnly', bbox)[0].geometry, point);
  });
});

test('invalid layer descriptors fail before replacing an existing output file', async (t) => {
  const { gpkgPath } = await fixture(t);
  const original = 'existing output';
  await writeFile(gpkgPath, original);
  const valid = { id: 'external', geometryType: 'POINT', columns: { id: 'TEXT' } };
  const invalidLayers = [
    ['roads'],
    [null],
    [{ ...valid, id: 'gpkg_contents' }],
    [{ ...valid, id: 'rtree_external_geom' }],
    [{ ...valid, id: '' }],
    [valid, { ...valid, id: 'EXTERNAL' }],
    [{ ...valid, geometryType: 'INVALID' }],
    [{ ...valid, columns: ['id'] }],
    [{ ...valid, columns: { amount: 'REAL); DROP TABLE external; --' } }],
    [{ ...valid, columns: { FID: 'INTEGER' } }],
    [{ ...valid, columns: { geom: 'TEXT' } }],
    [{ ...valid, columns: { rowid: 'INTEGER' } }],
    [{ ...valid, columns: { name: 'TEXT', NAME: 'TEXT' } }]
  ];
  for (const layers of invalidLayers) {
    assert.throws(() => openGeoPackageWriter(gpkgPath, layers, bbox), /GeoPackage/);
    assert.equal(await readFile(gpkgPath, 'utf8'), original);
  }
});

test('OSM package build retains schemas, aliases, text properties and deduplication across sources', async (t) => {
  const { dir } = await fixture(t);
  const source = join(dir, 'source.osm.pbf');
  await writeFile(source, osmFixture());
  const out = join(dir, 'osm.mapzero');
  const { counts } = await buildPackage({
    source: [source, source], out, batchSize: 1,
    layers: [...SUPPORTED_LAYERS.filter((id) => id !== 'aip'), 'aviation']
  });
  assert.equal(counts.roads, 1);
  assert.equal(counts.aip, 1);
  assert.equal(counts.pois, 1);
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.layers, SUPPORTED_LAYERS);
  assert.deepEqual(manifest.bbox, bbox);
  const gpkgPath = join(out, 'data.gpkg');
  withDatabase(gpkgPath, (db) => {
    for (const id of SUPPORTED_LAYERS) {
      const schema = db.pragma(`table_info(${quoteIdentifier(id)})`);
      assert.deepEqual(schema.slice(2).map(({ name, type }) => [name, type]),
        LAYER_DEFINITIONS[id].columns.map((column) => [column, 'TEXT']));
      const metadata = db.prepare('SELECT geometry_type_name FROM gpkg_geometry_columns WHERE table_name = ?').get(id);
      assert.equal(metadata.geometry_type_name, LAYER_DEFINITIONS[id].gpkgGeometryType);
    }
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });
  withReader(gpkgPath, manifest.layers, (reader) => {
    const [road] = reader.getTileFeatures('roads', bbox);
    assert.deepEqual(road.properties, {
      fid: 1, id: 'way/10', name: 'Test Road', ref: '001', highway: 'residential',
      layer: null, bridge: null, tunnel: null, oneway: null, junction: null,
      construction: null, service: null, access: null
    });
    assert.equal(road.geometry.type, 'LineString');
    assert.equal(road.geometry.coordinates.length, 2);
    assert.deepEqual(reader.getTileFeatures('aviation', bbox), reader.getTileFeatures('aip', bbox));
    assert.deepEqual(reader.getTileFeatures('aip', bbox)[0].geometry, point);
  });
  assert.throws(() => geoPackageLayersForOsm(['airspaces']), /unknown OSM layer/);
});

/** Generate a tiny PBF using the same installed protobuf schemas as osm.js. */
function osmFixture() {
  const require = createRequire(import.meta.url);
  const { file, osm } = require('osm-pbf-parser/lib/parsers.js');
  const block = (type, raw) => {
    const blob = file.Blob.encode({ zlib_data: deflateSync(raw), raw_size: raw.length });
    const header = file.BlobHeader.encode({ type, datasize: blob.length });
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    return Buffer.concat([length, header, blob]);
  };
  return Buffer.concat([
    block('OSMHeader', osm.HeaderBlock.encode({
      required_features: ['OsmSchema-V0.6', 'DenseNodes'],
      bbox: { left: -5e9, right: 5e9, top: 5e9, bottom: -5e9 }
    })),
    block('OSMData', osm.PrimitiveBlock.encode({
      stringtable: { s: ['', 'highway', 'residential', 'name', 'Test Road', 'ref', '001', 'aeroway', 'helipad'].map((s) => Buffer.from(s)) },
      primitivegroup: [
        { dense: { id: [1, 1], lat: [0, 10000000], lon: [0, 10000000], keys_vals: [7, 8, 0, 0] } },
        { ways: [{ id: 10, keys: [1, 3, 5], vals: [2, 4, 6], refs: [1, 1] }] }
      ]
    }))
  ]);
}
