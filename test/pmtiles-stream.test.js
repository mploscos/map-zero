import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { writeGeoPackage } from '../src/gpkg.js';
import { exportPmtiles } from '../src/export-pmtiles.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mapzero-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bbox = [-1, -1, 1, 1];
  writeGeoPackage(join(dir, 'data.gpkg'), {
    observations: [{ geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 'a' } }]
  }, [{ id: 'observations', geometryType: 'POINT', columns: { id: 'TEXT' } }], bbox);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    format: 'mapzero', version: 1, bbox, styles: {}, layers: ['observations']
  }));
  return dir;
}

// Delay disk writes to exercise errors while chunks remain buffered, rather
// than relying on filesystem timing. All successful I/O still uses real files.
function slowWrites(t, failure) {
  const createWriteStream = fs.createWriteStream;
  const write = fs.write;
  const writev = fs.writev;
  t.mock.method(fs, 'createWriteStream', (file, options) => createWriteStream(file, {
    ...options,
    fs: {
      ...fs,
      write(...args) {
        const callback = args.pop();
        setTimeout(() => failure ? callback(failure) : write(...args, callback), 20);
      },
      writev(...args) {
        const callback = args.pop();
        setTimeout(() => failure ? callback(failure) : writev(...args, callback), 20);
      }
    }
  }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

for (const workers of [1, 2]) {
  test(`PMTiles preserves an abort after a zoom and cleans pending writes (${workers} workers)`, async (t) => {
    const dir = await fixture(t);
    slowWrites(t);
    const original = new Error('stop after zoom');
    await assert.rejects(exportPmtiles({ packageDir: dir, minZoom: 4, maxZoom: 5, workers,
      onProgress(event) { if (event.phase === 'zoom') throw original; }
    }), (error) => error === original);
    assert.deepEqual((await readdir(dir)).filter((name) => !/^data\.gpkg-(wal|shm)$/.test(name)).sort(), ['data.gpkg', 'manifest.json']);
  });

  test(`PMTiles propagates an asynchronous disk failure (${workers} workers)`, async (t) => {
    const dir = await fixture(t);
    const original = Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    slowWrites(t, original);
    await assert.rejects(exportPmtiles({ packageDir: dir, minZoom: 4, maxZoom: 5, workers }),
      (error) => error === original);
    assert.deepEqual((await readdir(dir)).filter((name) => !/^data\.gpkg-(wal|shm)$/.test(name)).sort(), ['data.gpkg', 'manifest.json']);
  });
}

for (const workers of [1, 2]) {
  test(`PMTiles reports the next-zoom plan limit without masking it (${workers} workers)`, async (t) => {
    const dir = await fixture(t);
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.bbox = [-180, -85.05112878, 180, 85.05112878];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const originalManifest = await readFile(manifestPath);
    const archivePath = join(dir, 'tiles.pmtiles');
    await writeFile(archivePath, 'previous archive');
    slowWrites(t);
    let completedZoom = false;
    await assert.rejects(exportPmtiles({
      packageDir: dir, minZoom: 8, maxZoom: 9, workers, tilePlanning: 'bbox',
      onProgress(event) { if (event.phase === 'zoom' && event.zoom === 8) completedZoom = true; }
    }), /PMTiles plan would generate over 100,000 tiles; use --force to proceed/);
    assert.equal(completedZoom, true);
    assert.equal(await readFile(archivePath, 'utf8'), 'previous archive');
    assert.deepEqual(await readFile(manifestPath), originalManifest);
    assert.deepEqual((await readdir(dir)).filter((name) => !/^data\.gpkg-(wal|shm)$/.test(name)).sort(),
      ['data.gpkg', 'manifest.json', 'tiles.pmtiles']);
    // A subsequent export can reuse the persistent source after cleanup.
    const retry = await exportPmtiles({ packageDir: dir, minZoom: 8, maxZoom: 9, workers });
    assert.ok(retry.writtenTiles > 0);
    assert.equal((await readFile(archivePath)).subarray(0, 7).toString(), 'PMTiles');
  });
}
