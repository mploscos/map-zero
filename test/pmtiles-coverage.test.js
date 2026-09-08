import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PMTiles } from 'pmtiles';
import { writeGeoPackage } from 'map-zero/gpkg';
import { exportPmtiles } from 'map-zero/export-pmtiles';
import { LocalPmtilesSource } from '../src/pmtiles-source.js';

test('RTree block pruning preserves every MVT payload including polar and tile-edge geometry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mapzero-coverage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bbox = [-180, -85.05112878, 180, 85.05112878];
  const geometries = [
    { type: 'Point', coordinates: [0, 0] },
    { type: 'Point', coordinates: [-179.999, 80] },
    { type: 'Point', coordinates: [179.999, -80] },
    { type: 'LineString', coordinates: [[-0.1, 79], [0.1, 79.3]] },
    { type: 'Polygon', coordinates: [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]] }
  ];
  const schemas = [{ id: 'physical table', geometryType: 'GEOMETRY', columns: { id: 'TEXT', value: 'REAL' } }];
  writeGeoPackage(join(dir, 'data.gpkg'), {
    'physical table': geometries.map((geometry, i) => ({ geometry, properties: { id: String(i), value: i + 0.5 } }))
  }, schemas, bbox);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    format: 'mapzero', version: 1, bbox, data: 'data.gpkg', styles: {},
    layers: [{ id: 'generic', table: 'physical table', minZoom: 5, maxZoom: 6 }]
  }));
  const snapshots = [];
  for (const [workers, pruneEmptyTiles, tilePlanning] of [[1, false, 'bbox'], [1, true, 'bbox'], [1, true, 'rtree'], [2, true, 'rtree']]) {
    const events = [];
    const result = await exportPmtiles({
      packageDir: dir, minZoom: 4, maxZoom: 7, workers, pruneEmptyTiles, tilePlanning,
      onProgress: (event) => { if (event.phase === 'zoom') events.push(event); }
    });
    assert.equal(result.visitedTiles + result.prunedEmptyTiles, result.sparsePlanCandidates);
    assert.equal(result.sparsePlanCandidates + result.planExcludedTiles, result.estimatedTiles);
    assert.equal(result.writtenTiles + result.skippedEmptyTiles, result.estimatedTiles);
    if (pruneEmptyTiles) assert.ok(result.prunedEmptyTiles + result.planExcludedTiles > result.estimatedTiles * 0.8);
    else assert.equal(result.prunedEmptyTiles, 0);
    for (const event of events) assert.equal(event.writtenTiles + event.skippedEmptyTiles, event.completedTiles);
    const source = new LocalPmtilesSource(result.outPath);
    const snapshot = [];
    try {
      const archive = new PMTiles(source);
      for (let z = 4; z <= 7; z++) {
        for (let x = 0; x < 2 ** z; x++) {
          for (let y = 0; y < 2 ** z; y++) {
            const tile = await archive.getZxy(z, x, y);
            if (tile) snapshot.push([z, x, y, createHash('sha256').update(Buffer.from(tile.data)).digest('hex')]);
          }
        }
      }
      assert.equal(snapshot.length, result.writtenTiles);
    } finally { await source.close(); }
    snapshots.push(snapshot);
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.deepEqual(snapshots[0], snapshots[2]);
  assert.deepEqual(snapshots[0], snapshots[3]);
});
