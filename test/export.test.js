import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PMTiles, Compression, tileIdToZxy } from 'pmtiles';
import { writeGeoPackage } from '../src/gpkg.js';
import { createManifest } from '../src/manifest.js';
import { exportPmtiles } from '../src/export-pmtiles.js';
import { writePmtilesArchive } from '../src/pmtiles.js';
import { LocalPmtilesSource } from '../src/pmtiles-source.js';
import { export3dTiles } from '../src/3dtiles/export.js';
import { createMapZeroServer } from '../src/server.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'map-zero-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bbox = [-0.002, -0.002, 0.002, 0.002];
  const polygon = (id, x, y) => ({ properties: { id: String(id), height: '12', landuse: 'residential' },
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.003, y], [x + 0.003, y + 0.003], [x, y + 0.003], [x, y]]] } });
  const buildings = Array.from({ length: 5 }, (_, i) => polygon(i, -0.002 + i * 0.0002, -0.002 + i * 0.0002));
  const layers = ['buildings', 'landuse'];
  writeGeoPackage(join(dir, 'data.gpkg'), { buildings, landuse: buildings }, layers, bbox);
  const manifest = createManifest({ outDir: dir, bbox, layers });
  manifest.styles = {};
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

test('sequential and parallel PMTiles preserve every decoded tile and serve native MVT bytes', async (t) => {
  const dir = await fixture(t);
  const results = [];
  for (const workers of [1, Math.min(2, availableParallelism())]) {
    const result = await exportPmtiles({ packageDir: dir, out: join(dir, `${workers}.pmtiles`), minZoom: 14, maxZoom: 15, workers });
    const source = new LocalPmtilesSource(result.outPath);
    const archive = new PMTiles(source);
    try {
      const header = await archive.getHeader();
      assert.equal(header.tileCompression, Compression.Gzip);
      assert.equal(header.internalCompression, Compression.Gzip);
      assert.equal(header.numAddressedTiles, result.writtenTiles);
      const tiles = [];
      for (let z = 14; z <= 15; z++) {
        for (let x = 2 ** (z - 1) - 2; x <= 2 ** (z - 1) + 1; x++) {
          for (let y = 2 ** (z - 1) - 2; y <= 2 ** (z - 1) + 1; y++) {
            const tile = await archive.getZxy(z, x, y);
            tiles.push(tile ? Buffer.from(tile.data).toString('hex') : null);
          }
        }
      }
      assert.equal(tiles.filter(Boolean).length, result.writtenTiles);
      results.push(tiles);
      if (results.length === 2) {
        const app = await createMapZeroServer({ packageDir: dir });
        try {
          const reply = await app.inject('/api/vector-tiles/14/8192/8192.mvt');
          assert.equal(reply.statusCode, 200);
          assert.deepEqual(reply.rawPayload, Buffer.from((await archive.getZxy(14, 8192, 8192)).data));
          assert.equal((await app.inject('/api/vector-tiles/23/0/0.mvt')).statusCode, 400);
          assert.equal((await app.inject('/api/vector-tiles/14/0/0.mvt')).statusCode, 204);
        } finally { await app.close(); }
      }
    } finally { await source.close(); }
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal((await readdir(dir)).filter((name) => name.includes('.tiles-')).length, 0);
});

test('large PMTiles directories fit the 16 KiB root and resolve sparse leaf entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'map-zero-directory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const count = 100000;
  let tileId = 0;
  const entries = Array.from({ length: count }, (_, i) => {
    tileId += 1 + (i * 7919 % 65521);
    return { tileId, offset: i, length: 1, runLength: 1 };
  });
  const dataPath = join(dir, 'data');
  await writeFile(dataPath, Buffer.from(entries.map((_, i) => i % 256)));
  const outPath = join(dir, 'test.pmtiles');
  await writePmtilesArchive({ outPath, tileDataPath: dataPath, entries, metadata: {}, minZoom: 0, maxZoom: 17, bbox: [-180, -85, 180, 85] });
  const source = new LocalPmtilesSource(outPath);
  try {
    const archive = new PMTiles(source);
    const header = await archive.getHeader();
    assert.ok(header.rootDirectoryLength <= 16384 - 127);
    assert.ok(header.leafDirectoryLength > 0);
    for (const i of [0, 511, 12345, count - 1]) {
      assert.deepEqual(new Uint8Array((await archive.getZxy(...tileIdToZxy(entries[i].tileId))).data), new Uint8Array([i % 256]));
    }
  } finally { await source.close(); }
});

test('3D export emits crossing buildings once and never truncates dense flat leaves', async (t) => {
  const dir = await fixture(t);
  for (const maxDepth of [0, 2]) {
    const counts = new Map();
    await export3dTiles({ packageDir: dir, layers: ['buildings', 'landuse'], maxFeatures: 1, maxDepth,
      onProgress: (event) => {
        if (event.phase === 'leaf') counts.set(event.layerId, (counts.get(event.layerId) ?? 0) + event.featureCount);
      }
    });
    assert.equal(counts.get('buildings'), 5);
    assert.equal(counts.get('landuse'), 5);
    const tileset = JSON.parse(await readFile(join(dir, '3dtiles/buildings/tileset.json')));
    assert.ok(tileset.root.children.length > 0);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json')));
    assert.deepEqual(Object.keys(manifest.tiles3d.tilesets), ['buildings', 'landuse']);
    const app = await createMapZeroServer({ packageDir: dir });
    try {
      assert.equal((await app.inject('/3dtiles/landuse/tileset.json')).statusCode, 200);
      assert.equal((await app.inject('/3dtiles/buildings/tileset.json')).statusCode, 200);
    } finally { await app.close(); }
  }
});
