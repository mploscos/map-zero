import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Feature from 'ol/Feature.js';
import { createXYZ } from 'ol/tilegrid.js';
import { openGeoPackageWriter } from '../src/gpkg.js';
import { createManifest, resolveManifestLayers } from '../src/manifest.js';
import { exportPmtiles } from '../src/export-pmtiles.js';
import { createPmtilesVectorSource, withFeatureZoomVisibility } from '../packages/ol/src/pmtiles.js';

test('generic File/Blob MVT source, stable string IDs, property projection and actual-view visibility', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapzero-ol-pmtiles-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const layers = [{ id: 'observations', table: 'observations', minZoom: 8, maxZoom: 12,
    featureZoom: { minColumn: 'start', maxColumn: 'end' }, tileProperties: ['name'] }];
  const bbox = [0.01, 0.01, 0.02, 0.02];
  const writer = openGeoPackageWriter(path.join(dir, 'data.gpkg'), [{ id: 'observations', geometryType: 'POINT',
    columns: { id: 'TEXT', name: 'TEXT', start: 'INTEGER', end: 'INTEGER', richJson: 'TEXT' } }], bbox);
  writer.insertFeature('observations', { geometry: { type: 'Point', coordinates: [0.015, 0.015] },
    properties: { id: 'survey:alpha', name: 'Alpha', start: 8, end: 12, richJson: '{"large":[]}' } });
  writer.close();
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(createManifest({ outDir: dir, bbox, layers })));
  await exportPmtiles({ packageDir: dir, minZoom: 12, maxZoom: 12, workers: 1 });
  const bytes = await fs.readFile(path.join(dir, 'tiles.pmtiles'));
  const slices = [];
  class RangeOnlyBlob extends Blob {
    arrayBuffer() { throw new Error('Whole archive read is forbidden'); }
    slice(start, end) { slices.push([start, end]); return super.slice(start, end); }
  }
  const controller = await createPmtilesVectorSource({ input: new RangeOnlyBlob([bytes]) });
  t.after(() => controller.destroy());
  assert.equal(controller.layers[0].featureZoom.minColumn, 'start');
  assert.equal(controller.metadata.vector_layers[0].fields.start, 'Number');
  assert.ok(slices.length > 0);
  assert.equal(controller.metrics.rangeRequests, slices.length);
  const coord = [12, 2048, 2047];
  const features = await new Promise((resolve, reject) => {
    controller.source.getTileLoadFunction()({ getTileCoord: () => coord,
      setLoader: (load) => load(createXYZ().getTileCoordExtent(coord), 1, 'EPSG:3857'),
      setFeatures: resolve, setState: (state) => reject(new Error(`tile state ${state}`)) });
  });
  assert.equal(features.length, 1);
  assert.equal(features[0].getId(), 'survey:alpha');
  assert.equal(features[0].get('id'), 'survey:alpha');
  assert.equal(features[0].get('name'), 'Alpha');
  assert.equal(features[0].get('richJson'), undefined);
  assert.equal(features[0].get('start'), 8);
  assert.equal(features[0].get('end'), 12);
  assert.equal(features[0].getGeometry().getType(), 'Point');
  let actualZoom;
  const style = withFeatureZoomVisibility(() => 'visible', { layers: controller.layers, getZoom: () => actualZoom });
  for (const z of [7, 8, 12, 13]) {
    actualZoom = z;
    assert.equal(style(features[0], 999), z === 8 || z === 12 ? 'visible' : null);
  }
  // Old descriptors do not opt ordinary properties into feature visibility.
  actualZoom = 13;
  const old = withFeatureZoomVisibility(() => 'visible', { layers: [{ id: 'observations' }], getZoom: () => actualZoom });
  assert.equal(old(features[0], 999), 'visible');
  const unbounded = new Feature({ layer: 'observations', start: null, end: null });
  actualZoom = 8;
  assert.equal(style(unbounded, 999), 'visible');
  assert.throws(() => resolveManifestLayers({ layers: [{ id: 'bad', tileProperties: 'name' }] }), /tileProperties/);
});

test('failed PMTiles reads set tile error instead of masquerading as empty tiles', async () => {
  const { createPmtilesTileLoadFunction } = await import('../packages/ol/src/pmtiles.js');
  const state = await new Promise((resolve) => {
    createPmtilesTileLoadFunction({}, { getZxy: async () => { throw new Error('network'); } })({
      getTileCoord: () => [0, 0, 0], setLoader: (load) => load(), setState: resolve,
      setFeatures: () => assert.fail('failure must not become empty')
    });
  });
  assert.equal(state, 3);
});
