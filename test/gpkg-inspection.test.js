import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { writeGeoPackage } from 'map-zero/gpkg';
import { openGeoPackageReader } from 'map-zero/gpkg-read';

const bbox = [-1, -1, 1, 1];
const schema = { id: 'survey data', geometryType: 'POINT', columns: { id: 'TEXT' } };
const features = [{ properties: { id: '1' }, geometry: { type: 'Point', coordinates: [0, 0] } }];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'map-zero-inspection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'data.gpkg');
  writeGeoPackage(out, { [schema.id]: features }, [schema], bbox, { lastChange: '2000-01-01T00:00:00.000Z' });
  return out;
}

function inspect(out) {
  const reader = openGeoPackageReader({ gpkgPath: out, manifest: { layers: [{ id: 'observations', table: schema.id }] } });
  try { return reader.getLayerStats()[0]; } finally { reader.close(); }
}

test('public reader inspects persisted counts and RTree integrity/coverage for independent id/table names', (t) => {
  const out = fixture(t);
  const stats = inspect(out);
  assert.equal(stats.id, 'observations');
  assert.equal(stats.table, 'survey data');
  assert.equal(stats.featureCount, 1);
  assert.deepEqual(stats.rtree, {
    table: 'rtree_survey data_geom', registered: true, entryCount: 1,
    missingEntries: 0, orphanEntries: 0, invalidBounds: 0, integrity: 'ok', verified: true
  });
  const db = new Database(out);
  try {
    db.exec('DELETE FROM "rtree_survey data_geom"; INSERT INTO "rtree_survey data_geom" VALUES (999, 0, 0, 0, 0)');
    const incomplete = inspect(out);
    assert.equal(incomplete.rtree.entryCount, 1, 'same count does not imply correct coverage');
    assert.equal(incomplete.rtree.missingEntries, 1);
    assert.equal(incomplete.rtree.orphanEntries, 1);
    assert.equal(incomplete.rtree.verified, false);
    db.exec('DROP TABLE "rtree_survey data_geom"');
    assert.equal(inspect(out).rtree.verified, false);
    assert.equal(inspect(out).rtree.table, null);
  } finally { db.close(); }
});

test('fixed lastChange enables deterministic exports and invalid timestamps do not replace output', (t) => {
  const out = fixture(t);
  const bytes = readFileSync(out);
  writeGeoPackage(out, { [schema.id]: features }, [schema], bbox, { lastChange: '2000-01-01T00:00:00.000Z' });
  assert.deepEqual(readFileSync(out), bytes);
  for (const lastChange of ['invalid', '2000-02-31T00:00:00.000Z', null, 42]) {
    writeFileSync(out, 'keep');
    assert.throws(() => writeGeoPackage(out, {}, [schema], bbox, { lastChange }), /lastChange/);
    assert.equal(readFileSync(out, 'utf8'), 'keep');
  }
});

test('RTree occupancy uses mapped table names and includes bbox boundaries', (t) => {
  const out = fixture(t);
  const reader = openGeoPackageReader({ gpkgPath: out, manifest: { layers: [{ id: 'observations', table: schema.id }] } });
  try {
    assert.equal(reader.hasFeaturesInBbox('observations', [-1, -1, 1, 1]), true);
    assert.equal(reader.hasFeaturesInBbox('observations', [0, 0, 1, 1]), true);
    assert.equal(reader.hasFeaturesInBbox('observations', [1, 1, 2, 2]), false);
    assert.throws(() => reader.hasFeaturesInBbox('missing', bbox), /unknown layer/);
  } finally { reader.close(); }
});
