import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import MVT from 'ol/format/MVT.js';
import { writeGeoPackage } from 'map-zero/gpkg';
import { openGeoPackageReader } from 'map-zero/gpkg-read';
import { resolveManifestLayers } from 'map-zero/manifest';
import { encodeMvtTileSet } from '../src/mvt.js';

const bbox = [0, 0, 0.01, 0.01];
const descriptor = { id: 'observations', table: 'survey', minZoom: 1, maxZoom: 12,
  featureZoom: { minColumn: 'first zoom', maxColumn: 'last_zoom' } };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'feature-zoom-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'data.gpkg');
  writeGeoPackage(file, { survey: [
    ['early', 2, 4], ['late', 6, 8], ['always', null, null], ['open-end', 8, null], ['open-start', null, 2]
  ].map(([id, min, max]) => ({ geometry: { type: 'Point', coordinates: [0.005, 0.005] },
    properties: { id, 'first zoom': min, last_zoom: max } })) },
  [{ id: 'survey', geometryType: 'POINT', columns: { id: 'TEXT', 'first zoom': 'INTEGER', last_zoom: 'INTEGER' } }], bbox);
  return file;
}

test('generic feature visibility is inclusive, nullable and applied to policy reads in SQL', (t) => {
  const file = fixture(t);
  const reader = openGeoPackageReader({ gpkgPath: file, manifest: { layers: [descriptor] } });
  t.after(() => reader.close());
  for (const [z, expected] of [[1, ['always', 'open-start']], [2, ['always', 'early', 'open-start']],
    [4, ['always', 'early']], [5, ['always']], [6, ['always', 'late']], [8, ['always', 'late', 'open-end']], [9, ['always', 'open-end']]]) {
    assert.deepEqual(reader.getTileFeatures('observations', bbox, { zoom: z }).map((f) => f.properties.id).sort(), expected);
    assert.equal([...reader.iterateFeatureBounds('observations', z)].length, expected.length);
    for (const getLayerPolicy of [undefined, () => ({ readFeatures(source, context) {
      const features = source.getTileFeatures(context.sourceLayer, context.bbox, { zoom: 0 });
      return { features, originalFeatureCount: features.length };
    } })]) {
      const encoded = encodeMvtTileSet(reader, z, 2 ** (z - 1), 2 ** (z - 1) - 1, ['observations'], { getLayerPolicy });
      const rows = new MVT().readFeatures(Uint8Array.from(encoded).buffer);
      assert.deepEqual(rows.map((f) => f.getProperties().id).sort(), expected);
    }
  }
  assert.equal(reader.getTileFeatures('observations', bbox).length, 5, 'unzoomed inspection reads all records');
  const db = new Database(file);
  // Deliberately corrupt only the payload, retaining its occupied RTree entry.
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'survey'").all()) {
    db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  }
  db.prepare('UPDATE survey SET geom = ? WHERE id = ?').run(Buffer.from('bad'), 'late');
  db.close();
  assert.doesNotThrow(() => reader.getTileFeatures('observations', bbox, { zoom: 2 }));
  assert.throws(() => reader.getTileFeatures('observations', bbox, { zoom: 6 }), /invalid GeoPackage geometry/);
});

test('feature zoom is opt-in and descriptors/INTEGER columns are validated', (t) => {
  const file = fixture(t);
  const reader = openGeoPackageReader({ gpkgPath: file, manifest: { layers: [{ id: 'observations', table: 'survey' }] } });
  assert.equal(reader.getTileFeatures('observations', bbox, { zoom: 0 }).length, 5);
  reader.close();
  for (const featureZoom of [null, {}, [], { minColumn: '' }, { typo: 'a' }]) {
    assert.throws(() => resolveManifestLayers({ layers: [{ ...descriptor, featureZoom }] }), /featureZoom/);
  }
  for (const featureZoom of [{ minColumn: 'missing' }, { maxColumn: 'id' }]) {
    assert.throws(() => openGeoPackageReader({ gpkgPath: file, manifest: { layers: [{ ...descriptor, featureZoom }] } }), /INTEGER/);
  }
  const oneBound = openGeoPackageReader({ gpkgPath: file, manifest: { layers: [{ ...descriptor, featureZoom: { maxColumn: 'last_zoom' } }] } });
  assert.deepEqual(oneBound.getTileFeatures('observations', bbox, { zoom: 9 }).map((f) => f.properties.id).sort(), ['always', 'open-end']);
  oneBound.close();
});
