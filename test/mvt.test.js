import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import MVT from 'ol/format/MVT.js';
import { PMTiles } from 'pmtiles';

import { createManifest } from '../src/manifest.js';
import { writeGeoPackage } from '../src/gpkg.js';
import { openGeoPackageReader } from '../src/gpkg-read.js';
import { createHiddenFilters } from '../src/style-filters.js';
import { encodeMvtTile, encodeMvtTileSet, encodeMvtTileWithStats, encodeMvtTileSetWithStats } from '../src/mvt.js';
import { getOsmLayerPolicy } from '../src/mvt-osm-policy.js';
import { exportPmtiles } from '../src/export-pmtiles.js';
import { LocalPmtilesSource } from '../src/pmtiles-source.js';
import { osmFixture, osmCases, osmSnapshot } from './fixtures/mvt-osm.js';

const bbox = [0.01, 0.01, 0.12, 0.12];
const geometries = [
  { type: 'Point', coordinates: [0.06, 0.06] },
  { type: 'LineString', coordinates: [[0.02, 0.02], [0.10, 0.08], [0.11, 0.03]] },
  { type: 'Polygon', coordinates: [[[0.02, 0.02], [0.08, 0.02], [0.08, 0.08], [0.02, 0.08], [0.02, 0.02]]] }
];
const layers = ['observations', 'routes', 'regions', 'mixed'].map((id, i) => ({
  id, table: `survey_${i}`, geometryType: geometries[i]?.type.toUpperCase() ?? 'GEOMETRY', minZoom: 8, maxZoom: 9,
  source: 'survey'
}));
const properties = {
  id: 'sample', description: 'Medición ñ', rank: 7, value: 123.75,
  // These values would be filtered by the OSM road/POI policies at this zoom.
  highway: 'footway', amenity: 'restaurant', custom_flag: 'active'
};

async function genericFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'map-zero-generic-mvt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gpkgPath = join(dir, 'data.gpkg');
  const schemas = layers.map((layer) => ({ id: layer.table, geometryType: layer.geometryType, columns: {
    id: 'TEXT', description: 'TEXT', rank: 'INTEGER', value: 'REAL', highway: 'TEXT', amenity: 'TEXT', custom_flag: 'TEXT'
  } }));
  const data = Object.fromEntries(layers.map((layer, i) => [layer.table,
    (i === 3 ? geometries : [geometries[i]]).map((geometry, j) => ({ geometry, properties: { ...properties, id: `${layer.id}-${j}` } }))
  ]));
  writeGeoPackage(gpkgPath, data, schemas, bbox);
  const manifest = createManifest({ outDir: dir, layers, bbox });
  manifest.styles = {};
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const reader = openGeoPackageReader({ gpkgPath, manifest });
  t.after(() => reader.close());
  return { dir, gpkgPath, manifest, reader };
}

function decode(buffer) {
  return new MVT().readFeatures(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

function assertGenericFeatures(features) {
  assert.equal(features.length, 6);
  for (const [i, layer] of layers.entries()) {
    const actual = features.filter((feature) => feature.get('layer') === layer.id);
    assert.deepEqual(actual.map((feature) => feature.getType()).sort(),
      (i === 3 ? ['Point', 'LineString', 'Polygon'] : [geometries[i].type]).sort());
    for (const feature of actual) {
      for (const [key, value] of Object.entries(properties)) {
        if (key !== 'id') assert.equal(feature.get(key), value);
      }
      assert.equal(feature.get('mapzero_label_lon'), undefined);
      assert.equal(feature.get('poi_category'), undefined);
      assert.equal(feature.get('mapzero_geometry'), feature.getType());
    }
  }
}

test('generic MVT reads Point, LineString, Polygon and mixed layers, retaining arbitrary typed properties', async (t) => {
  const { reader } = await genericFixture(t);
  const getFeatures = t.mock.method(reader, 'getTileFeatures');
  for (const z of [7, 8, 9, 10]) {
    getFeatures.mock.resetCalls();
    const x = 2 ** (z - 1);
    const result = encodeMvtTileSetWithStats(reader, z, x, x - 1);
    if (z === 8 || z === 9) {
      assertGenericFeatures(decode(result.buffer));
      assert.equal(result.originalFeatureCount, 6);
      assert.equal(result.droppedFeatureCount, 0);
      assert.deepEqual(getFeatures.mock.calls.map(({ arguments: args }) => args[0]), layers.map(({ id }) => id));
      assert.ok(getFeatures.mock.calls.every(({ arguments: args }) => args[2] === undefined));
      assert.deepEqual(encodeMvtTileSet(reader, z, x, x - 1), result.buffer);
      for (const layer of layers) {
        const single = encodeMvtTileWithStats(reader, layer.id, z, x, x - 1);
        assert.equal(single.featureCount, layer.id === 'mixed' ? 3 : 1);
        assert.ok(decode(single.buffer).every((feature) => feature.get('layer') === layer.id));
        assert.deepEqual(encodeMvtTile(reader, layer.id, z, x, x - 1), single.buffer);
      }
    } else {
      assert.equal(result.featureCount, 0);
      assert.equal(result.originalFeatureCount, 0);
      assert.equal(getFeatures.mock.calls.length, 0);
      for (const layer of layers) assert.equal(encodeMvtTileWithStats(reader, layer.id, z, x, x - 1).featureCount, 0);
      assert.equal(getFeatures.mock.calls.length, 0);
    }
  }
});

test('generic PMTiles preserve layer IDs, types, properties and zoom bounds in sequential and worker exports', async (t) => {
  const { dir } = await genericFixture(t);
  const outputs = [];
  for (const workers of [1, 2]) {
    const result = await exportPmtiles({ packageDir: dir, out: join(dir, `generic-${workers}.pmtiles`), minZoom: 7, maxZoom: 10, workers });
    const source = new LocalPmtilesSource(result.outPath);
    try {
      const archive = new PMTiles(source);
      const metadata = await archive.getMetadata();
      assert.deepEqual(metadata.vector_layers.map(({ id, minzoom, maxzoom }) => ({ id, minzoom, maxzoom })),
        layers.map(({ id }) => ({ id, minzoom: 8, maxzoom: 9 })));
      const tiles = [];
      for (const z of [7, 8, 9, 10]) {
        const x = 2 ** (z - 1);
        const tile = await archive.getZxy(z, x, x - 1);
        assert.equal(Boolean(tile), z === 8 || z === 9);
        if (tile) assertGenericFeatures(decode(Buffer.from(tile.data)));
        tiles.push(tile ? Buffer.from(tile.data) : null);
      }
      outputs.push(tiles);
    } finally { await source.close(); }
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

test('injected policy can query arbitrary columns and define derived layers without encoder changes', async (t) => {
  const { reader } = await genericFixture(t);
  const contexts = [];
  const getLayerPolicy = (id, descriptor) => {
    if (id === 'selected') return {
      sourceLayer: 'mixed',
      readFeatures(source, context) {
        contexts.push(context);
        const features = source.getTileFeatures(context.sourceLayer, context.bbox, { all: [{ column: 'value', minNumber: 100 }] });
        return { features, originalFeatureCount: features.length };
      },
      featureLimit: () => 1,
      featurePriority: (feature) => feature.geometry.type === 'Polygon' ? 200 : 0,
      toleranceScale: () => 0,
      minFeatureSize: () => 0,
      prepareFeatures: (features) => features.map((feature) => ({ ...feature, properties: { ...feature.properties, selected: 'yes' } }))
    };
    if (descriptor) assert.equal(descriptor.source, 'survey');
    return getOsmLayerPolicy(id);
  };
  const result = encodeMvtTileWithStats(reader, 'selected', 8, 128, 127, { getLayerPolicy });
  assert.equal(result.originalFeatureCount, 3);
  assert.equal(result.featureCount, 1);
  assert.equal(result.droppedFeatureCount, 2);
  assert.equal(result.simplificationTolerance, 0);
  const [feature] = decode(result.buffer);
  assert.equal(feature.get('layer'), 'selected');
  assert.equal(feature.getType(), 'Polygon');
  assert.equal(feature.get('selected'), 'yes');
  assert.equal(contexts[0].descriptor.table, 'survey_3');
  assert.equal(contexts[0].sourceLayer, 'mixed');
  assert.equal(contexts[0].layerId, 'selected');
  assert.equal(encodeMvtTileWithStats(reader, 'selected', 7, 64, 63, { getLayerPolicy }).featureCount, 0);
  assert.equal(contexts.length, 1, 'source descriptor bounds apply before policy reads');
  assertGenericFeatures(decode(encodeMvtTileSet(reader, 8, 128, 127, undefined, { getLayerPolicy })));
  const combined = encodeMvtTileSetWithStats(reader, 8, 128, 127, ['observations', 'selected'], { getLayerPolicy, maxFeatures: 1 });
  assert.equal(decode(combined.buffer)[0].get('layer'), 'selected', 'injected priority also applies to the global budget');
  const declaredOutputReader = {
    getLayers: () => [...reader.getLayers(), { id: 'selected', table: 'survey_3', minZoom: 9, maxZoom: 9 }],
    getTileFeatures: (...args) => reader.getTileFeatures(...args)
  };
  assert.equal(encodeMvtTileWithStats(declaredOutputReader, 'selected', 8, 128, 127, { getLayerPolicy }).featureCount, 0);
  assert.equal(encodeMvtTileWithStats(declaredOutputReader, 'selected', 9, 256, 255, { getLayerPolicy }).featureCount, 1);
  const filtered = encodeMvtTileWithStats(reader, 'observations', 8, 128, 127, {
    getLayerPolicy: () => ({
      readFeatures(source, { sourceLayer, bbox }) {
        const features = source.getTileFeatures(sourceLayer, bbox, { all: [{ column: 'value', minNumber: 200 }] });
        return { features, originalFeatureCount: features.length };
      }
    })
  });
  assert.equal(filtered.featureCount, 0, 'arbitrary numeric SQL filters select candidates');
});

test('generic aliases resolve source IDs while preserving output IDs and descriptor zoom bounds', async (t) => {
  const { reader } = await genericFixture(t);
  const getLayerPolicy = () => ({ aliases: ['observations'] });
  const result = encodeMvtTileWithStats(reader, 'measurements', 8, 128, 127, { getLayerPolicy });
  assert.equal(result.featureCount, 1);
  assert.equal(decode(result.buffer)[0].get('layer'), 'measurements');
  assert.equal(encodeMvtTileWithStats(reader, 'measurements', 10, 512, 511, { getLayerPolicy }).featureCount, 0);
  const exact = encodeMvtTileWithStats(reader, 'routes', 8, 128, 127, { getLayerPolicy });
  assert.equal(decode(exact.buffer)[0].getType(), 'LineString');
});

test('generic fallback does not add domain quotas and keeps deterministic budget ordering', () => {
  const features = Array.from({ length: 650 }, (_, i) => ({
    geometry: geometries[0], properties: { id: String(i), rank: i }
  }));
  const reader = {
    getLayers: () => [{ id: 'samples', table: 'samples', exists: true, rtree: 'index' }],
    getTileFeatures: () => features
  };
  assert.equal(encodeMvtTileWithStats(reader, 'samples', 8, 128, 127).featureCount, 650);
  const result = encodeMvtTileWithStats(reader, 'samples', 8, 128, 127, { maxFeatures: 2 });
  assert.deepEqual(decode(result.buffer).map((feature) => feature.get('rank')), [0, 1]);
  assert.equal(result.droppedFeatureCount, 648);
  assert.equal(getOsmLayerPolicy('samples'), undefined);
  assert.equal(getOsmLayerPolicy('constructor'), undefined);
});

test('custom resolver can opt out of built-in OSM policy, while style property hiding stays in the reader', async (t) => {
  const { gpkgPath, manifest } = await genericFixture(t);
  const renamed = { ...manifest, layers: [{ id: 'roads', table: 'survey_1', minZoom: 8, maxZoom: 9 }] };
  const reader = openGeoPackageReader({ gpkgPath, manifest: renamed });
  try {
    assert.equal(encodeMvtTileWithStats(reader, 'roads', 8, 128, 127).featureCount, 0);
    const result = encodeMvtTileWithStats(reader, 'roads', 8, 128, 127, { getLayerPolicy: () => undefined });
    assert.equal(result.featureCount, 1);
    assert.equal(decode(result.buffer)[0].get('mapzero_label_lon'), undefined);
  } finally { reader.close(); }
  const style = { layers: { routes: { byProperty: { custom_flag: { active: { visible: false } } } } } };
  const filtered = openGeoPackageReader({ gpkgPath, manifest, hiddenFilters: createHiddenFilters(manifest, style) });
  try { assert.equal(encodeMvtTileWithStats(filtered, 'routes', 8, 128, 127).featureCount, 0); }
  finally { filtered.close(); }
});

test('OSM tiles, SQL filters and statistics match snapshots captured before the policy extraction', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/mvt-osm-baseline.json', import.meta.url), 'utf8'));
  for (const scenario of osmCases) {
    const fixture = await osmFixture(scenario.z);
    try {
      assert.deepEqual(osmSnapshot(encodeMvtTileSetWithStats, fixture, scenario), baseline[scenario.name], scenario.name);
    } finally { await fixture.close(); }
  }
});
