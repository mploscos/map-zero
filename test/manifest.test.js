import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import MVT from 'ol/format/MVT.js';
import Feature from 'ol/Feature.js';
import { PMTiles } from 'pmtiles';
import { Color } from 'cesium';

import { createManifest, resolveManifestLayers, isLayerInZoomRange } from '../src/manifest.js';
import { resolveManifestLayers as resolveCoreLayers } from '../packages/core/src/manifest.js';
import { orderManifestLayers } from '../packages/core/src/style.js';
import { createMapZeroOpenLayersLayers } from '../packages/ol/src/index.js';
import { createMapZeroLabelLayer } from '../packages/ol/src/labels.js';
import { createStaticTileStyle } from '../packages/cesium/src/static-style.js';
import { writeGeoPackage } from '../src/gpkg.js';
import { openGeoPackageReader } from '../src/gpkg-read.js';
import { createMapZeroServer } from '../src/server.js';
import { encodeMvtTileWithStats, encodeMvtTileSetWithStats } from '../src/mvt.js';
import { exportPmtiles } from '../src/export-pmtiles.js';
import { LocalPmtilesSource } from '../src/pmtiles-source.js';
import { export3dTiles } from '../src/3dtiles/export.js';
import { readLayerMetadata, readLayerFeatures } from '../src/3dtiles/gpkg-features.js';
import { createHiddenFilters } from '../src/style-filters.js';
import { writePackageStyle } from '../src/style-command.js';

const bbox = [0.001, 0.001, 0.003, 0.003];
const ring = [[0.001, 0.001], [0.003, 0.001], [0.003, 0.003], [0.001, 0.003], [0.001, 0.001]];
const external = {
  id: 'regions', table: 'region "data"', geometryType: 'POLYGON',
  minZoom: 14, maxZoom: 15, source: 'survey'
};

async function fixture(t, layers = [external]) {
  const dir = await mkdtemp(join(tmpdir(), 'map-zero-manifest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const descriptors = resolveManifestLayers({ layers });
  const gpkgPath = join(dir, 'data.gpkg');
  const schemas = descriptors.map((layer) => ({
    id: layer.table, geometryType: layer.geometryType ?? 'POLYGON',
    columns: { id: 'TEXT', name: 'TEXT', height: 'REAL', landuse: 'TEXT' }
  }));
  const features = Object.fromEntries(descriptors.map((layer) => [layer.table, [{
    properties: { id: 'feature-1', name: 'Zone', height: 12.5, landuse: 'residential' },
    geometry: layer.geometryType === 'MULTIPOLYGON'
      ? { type: 'MultiPolygon', coordinates: [[ring]] }
      : { type: 'Polygon', coordinates: [ring] }
  }]]));
  writeGeoPackage(gpkgPath, features, schemas, bbox);
  const manifest = createManifest({ outDir: dir, bbox, layers });
  manifest.styles = {};
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, gpkgPath, manifest };
}

test('one shared resolver handles version 1 strings, descriptors and mixed arrays without mutation', () => {
  assert.equal(resolveManifestLayers, resolveCoreLayers);
  const descriptor = Object.freeze({ id: 'observations', geometryType: 'POINT', source: 'sensor' });
  const layers = Object.freeze(['roads', Object.freeze({ ...external }), descriptor]);
  const manifest = Object.freeze({ version: 1, layers });
  const resolved = resolveManifestLayers(manifest);
  assert.deepEqual(resolved, [
    { id: 'roads', table: 'roads' }, external, { ...descriptor, table: 'observations' }
  ]);
  resolved[1].table = 'other';
  assert.equal(layers[1].table, external.table);
  assert.deepEqual(resolveManifestLayers({}), []);
  assert.deepEqual(resolveManifestLayers({ layers: [] }), []);
  assert.equal(isLayerInZoomRange(external, 13), false);
  assert.equal(isLayerInZoomRange(external, 14), true);
  assert.equal(isLayerInZoomRange(external, 15), true);
  assert.equal(isLayerInZoomRange(external, 16), false);
  assert.equal(isLayerInZoomRange({ minZoom: 0, maxZoom: 0 }, 0), true);
  assert.equal(isLayerInZoomRange({}, 22), true);

  const legacy = createManifest({ outDir: 'old.mapzero', bbox, layers: ['roads', 'buildings'] });
  assert.equal(legacy.version, 1);
  assert.deepEqual(legacy.layers, ['roads', 'buildings']);
  const modern = createManifest({ outDir: 'new.mapzero', bbox, layers: [descriptor] });
  assert.equal(modern.version, 1);
  assert.deepEqual(modern.layers, [{ ...descriptor, table: 'observations' }]);
});

test('manifest resolver rejects malformed descriptors instead of coercing them to strings', () => {
  for (const layers of [
    null, 'roads', [42], [null], [{}], [''], [{ id: 'x', table: '' }], [{ id: 'x', table: null }],
    [{ id: 'x', source: {} }], [{ id: 'x', geometryType: 3 }],
    [{ id: 'x', minZoom: '4' }], [{ id: 'x', minZoom: -1 }],
    [{ id: 'x', maxZoom: Infinity }], [{ id: 'x', minZoom: 8, maxZoom: 4 }],
    ['roads', { id: 'roads', table: 'other' }]
  ]) {
    assert.throws(() => resolveManifestLayers({ layers }), /manifest/);
  }
});

test('legacy and descriptor manifests produce identical OSM MVT bytes', async (t) => {
  const encoded = [];
  for (const layers of [
    ['landuse'], [{ id: 'landuse' }], [{ id: 'landuse', table: 'survey_polygons', geometryType: 'POLYGON' }]
  ]) {
    const { gpkgPath, manifest } = await fixture(t, layers);
    const reader = openGeoPackageReader({ gpkgPath, manifest });
    try {
      encoded.push(encodeMvtTileSetWithStats(reader, 14, 8192, 8191).buffer);
    } finally { reader.close(); }
  }
  assert.deepEqual(encoded[0], encoded[1]);
  assert.deepEqual(encoded[0], encoded[2]);
});

test('GeoPackage reader and MVT keep public ids separate from tables and honor descriptor zooms', async (t) => {
  const { gpkgPath, manifest } = await fixture(t);
  const reader = openGeoPackageReader({ gpkgPath, manifest });
  try {
    const [metadata] = reader.getLayers();
    for (const [key, value] of Object.entries(external)) assert.equal(metadata[key], value);
    assert.equal(reader.getTileFeatures('regions', bbox)[0].properties.height, 12.5);
    assert.throws(() => reader.getTileFeatures(external.table, bbox), /unknown layer/);
    for (const z of [13, 14, 15, 16]) {
      const x = 2 ** (z - 1), y = x - 1;
      const single = encodeMvtTileWithStats(reader, 'regions', z, x, y);
      const combined = encodeMvtTileSetWithStats(reader, z, x, y);
      assert.equal(single.encodedFeatureCount, z === 14 || z === 15 ? 1 : 0);
      assert.equal(combined.encodedFeatureCount, single.encodedFeatureCount);
      if (single.encodedFeatureCount) {
        const decoded = decodeTile(single.buffer);
        assert.equal(decoded[0].get('layer'), 'regions');
        assert.equal(decoded[0].get('height'), 12.5);
      }
    }
  } finally { reader.close(); }

  const hiddenFilters = createHiddenFilters(manifest, {
    layers: { regions: { byProperty: { name: { Zone: { visible: false } } } } }
  });
  const filtered = openGeoPackageReader({ gpkgPath, manifest, hiddenFilters });
  try { assert.deepEqual(filtered.getTileFeatures('regions', bbox), []); }
  finally { filtered.close(); }

  const db = new Database(gpkgPath, { readonly: true });
  try {
    const metadata = readLayerMetadata(db, manifest, 'regions');
    assert.equal(metadata.table, external.table);
    assert.equal(metadata.source, 'survey');
    assert.equal(readLayerFeatures(db, metadata, bbox).length, 1);
  } finally { db.close(); }
});

test('OSM aliases resolve descriptors without replacing explicitly declared ids', async (t) => {
  const { gpkgPath } = await fixture(t, [{ id: 'aip', table: 'aero_data', geometryType: 'POLYGON' }]);
  const manifest = { layers: [{ id: 'aip', table: 'aero_data' }] };
  const reader = openGeoPackageReader({ gpkgPath, manifest });
  try {
    assert.equal(reader.getLayers().length, 1);
    assert.deepEqual(reader.getTileFeatures('aviation', bbox), reader.getTileFeatures('aip', bbox));
    assert.equal(encodeMvtTileSetWithStats(reader, 14, 8192, 8191, ['aviation']).encodedFeatureCount, 1);
  } finally { reader.close(); }
  const both = openGeoPackageReader({ gpkgPath, manifest: {
    layers: [...manifest.layers, { id: 'aviation', table: 'aero_data', source: 'explicit' }]
  } });
  try {
    assert.equal(both.getLayers().find(({ id }) => id === 'aviation').source, 'explicit');
  } finally { both.close(); }
});

test('server exposes descriptor metadata, preserves the manifest and serves browser dependencies', async (t) => {
  const { dir, manifest } = await fixture(t);
  const app = await createMapZeroServer({ packageDir: dir });
  try {
    assert.deepEqual((await app.inject('/manifest.json')).json(), manifest);
    const [layer] = (await app.inject('/api/layers')).json().layers;
    assert.equal(layer.id, 'regions');
    assert.equal(layer.table, external.table);
    assert.equal(layer.minZoom, 14);
    const tile = await app.inject('/api/tiles/regions/14/8192/8191.mvt');
    assert.equal(tile.statusCode, 200);
    assert.equal(decodeTile(tile.rawPayload)[0].get('layer'), 'regions');
    for (const path of ['/map-zero-core/manifest.js', '/map-zero-core/shared/layers.js', '/map-zero-ol.js', '/static-style.js', '/', '/cesium']) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 200, path);
      assert.ok(response.body.includes('resolveManifestLayers'), path);
    }
  } finally { await app.close(); }
});

test('PMTiles descriptors work in sequential and worker exports, preserving metadata and zoom limits', async (t) => {
  const { dir, manifest } = await fixture(t);
  const tiles = [];
  for (const workers of [1, 2]) {
    const result = await exportPmtiles({ packageDir: dir, out: join(dir, `${workers}.pmtiles`), minZoom: 13, maxZoom: 16, workers });
    const source = new LocalPmtilesSource(result.outPath);
    try {
      const archive = new PMTiles(source);
      const metadata = await archive.getMetadata();
      assert.equal(metadata.vector_layers[0].id, 'regions');
      assert.equal(metadata.vector_layers[0].minzoom, 14);
      assert.equal(metadata.vector_layers[0].maxzoom, 15);
      const decoded = [];
      for (const z of [13, 14, 15, 16]) {
        const x = 2 ** (z - 1);
        const tile = await archive.getZxy(z, x, x - 1);
        assert.equal(Boolean(tile), z === 14 || z === 15);
        decoded.push(tile ? Buffer.from(tile.data).toString('hex') : null);
      }
      tiles.push(decoded);
    } finally { await source.close(); }
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).layers, manifest.layers);
  }
  assert.deepEqual(tiles[0], tiles[1]);
});

test('3D export and style command use descriptor ids while reading renamed OSM tables', async (t) => {
  const layers = [
    { id: 'buildings', table: 'structures', geometryType: 'MULTIPOLYGON', source: 'survey' },
    { id: 'landuse', table: 'zones', geometryType: 'MULTIPOLYGON' }
  ];
  const { dir } = await fixture(t, layers);
  const counts = new Map();
  await export3dTiles({ packageDir: dir, layers: ['buildings', 'landuse'], maxDepth: 0,
    onProgress(event) {
      if (event.phase === 'leaf') counts.set(event.layerId, (counts.get(event.layerId) ?? 0) + event.featureCount);
    }
  });
  assert.equal(counts.get('buildings'), 1);

  let updated = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(updated.layers, layers);
  assert.deepEqual(Object.keys(updated.tiles3d.tilesets).sort(), ['buildings', 'landuse']);
  assert.equal(updated.tiles3d.representations.landuse.sourceFeatures, 1);
  assert.equal(updated.tiles3d.representations.landuse.encoding, 'vector');
  const result = await writePackageStyle({ packageDir: dir, preset: 'neon-dark' });
  const style = JSON.parse(await readFile(result.stylePath, 'utf8'));
  assert.ok(style.layers.buildings);
  assert.ok(style.layers.landuse);
  updated = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(updated.layers, layers);
});

test('core, OpenLayers and Cesium consume descriptors by public id and geometry type', async (t) => {
  const manifest = { layers: [external], bbox };
  const styleDocument = { layers: { regions: { fill: '#ff0000', fillOpacity: 0.4, stroke: '#00ff00', strokeWidth: 1 } } };
  assert.deepEqual(orderManifestLayers(manifest, styleDocument)[0], { ...external, style: 'regions' });
  const controller = await createMapZeroOpenLayersLayers({
    manifestUrl: 'http://localhost/manifest.json', manifest, style: styleDocument, source: 'dynamic'
  });
  try {
    const source = controller.layers[0].getSource();
    const url = source.getTileUrlFunction();
    assert.equal(url([13, 4096, 4095]), undefined);
    assert.ok(url([14, 8192, 8191]).includes('layers=regions'));
    assert.equal(url([16, 32768, 32767]), undefined);
    const setStyle = t.mock.method(controller.layers[0], 'setStyle');
    controller.setVisible('regions', true);
    assert.ok(setStyle.mock.calls.at(-1).arguments[0].some(({ style }) => 'fill-color' in style));
    assert.deepEqual(controller.manifest, manifest);
  } finally { controller.destroy(); }

  const feature = { getProperty: (key) => key === '_layer' ? 'regions' : undefined };
  for (const zoom of [13, 14, 15, 16]) {
    const style = createStaticTileStyle(styleDocument, { manifest, zoom });
    assert.equal(style.show.evaluate(feature), zoom === 14 || zoom === 15);
    assert.equal(style.color.evaluate(feature, new Color()).alpha, 0.4);
  }
});

function decodeTile(buffer) {
  const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new MVT().readFeatures(data);
}

test('OpenLayers cached labels respect manifest zoom limits at the current view resolution', () => {
  const controller = createMapZeroLabelLayer({
    manifest: { layers: [{ id: 'roads', minZoom: 14, maxZoom: 15 }] },
    styleDocument: { labels: { roads: { enabled: true } } },
    tileUrlFunction: () => undefined,
    loadTileData: async () => null
  });
  try {
    const feature = new Feature({ sourceLayer: 'roads', text: 'Main Street', priority: 10 });
    const style = controller.layer.getStyleFunction();
    const resolution = (zoom) => 156543.03392804097 / 2 ** zoom;
    assert.equal(style(feature, resolution(13)), null);
    assert.ok(style(feature, resolution(14)));
    assert.ok(style(feature, resolution(15)));
    assert.equal(style(feature, resolution(16)), null);
  } finally { controller.destroy(); }
});
