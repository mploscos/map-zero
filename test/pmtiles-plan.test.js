import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSparseTilePlan } from '../src/pmtiles-plan.js';
import { writeGeoPackage } from 'map-zero/gpkg';
import { exportPmtiles } from 'map-zero/export-pmtiles';

const coverage = { minX: 0, minY: 0, maxX: 99, maxY: 99, tileCount: 10000 };
const asRange = ([minX, minY, maxX, maxY]) => ({ minX, minY, maxX, maxY, tileCount: (maxX-minX+1)*(maxY-minY+1) });
const layers = [{ id: 'test', exists: true, rtree: 'test_rtree' }];

test('sparse interval union deduplicates overlapping extents without enumerating their area', () => {
  const reader = { getLayers: () => layers, *iterateFeatureBounds() {
    yield { minx: 1, miny: 2, maxx: 3, maxy: 4 };
    yield { minx: 3, miny: 3, maxx: 4, maxy: 5 };
    yield { minx: -10, miny: 0, maxx: -1, maxy: 2 }; // outside package
  } };
  const plan = createSparseTilePlan(reader, 5, coverage, asRange);
  assert.equal(plan.tileCount, 13);
  assert.equal(plan.intervalCount, 5);
  const keys = plan.ranges.flatMap((range) => Array.from({length: range.maxY-range.minY+1}, (_, i) => `${range.minX}/${range.minY+i}`));
  assert.equal(new Set(keys).size, 13);
  assert.equal(plan.ranges.length, 4);
});

test('interval budget bounds allocations and closes the streaming cursor on fallback', () => {
  let read = 0, closed = false;
  const reader = { getLayers: () => layers, *iterateFeatureBounds() {
    try { for (let i = 0; i < 1e6; i++) { read++; yield {minx: 1, miny: 1, maxx: 1, maxy: 1}; } }
    finally { closed = true; }
  } };
  const plan = createSparseTilePlan(reader, 5, coverage, asRange, {maxIntervals: 4});
  assert.equal(plan.reason, 'interval-budget');
  assert.equal(plan.tileCount, coverage.tileCount);
  assert.equal(plan.intervalCount, 4);
  assert.equal(read, 5);
  assert.equal(closed, true);
  const huge = { getLayers: () => layers, *iterateFeatureBounds() { yield {minx: 0, miny: 0, maxx: 1e6, maxy: 1e6}; } };
  assert.equal(createSparseTilePlan(huge, 20, asRange([0,0,1e6,1e6]), asRange).reason, 'interval-budget');
});

test('a global package with sparse points avoids the theoretical bbox export guard', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sparse-world-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const bbox = [-180, -85, 180, 85];
  writeGeoPackage(join(dir, 'data.gpkg'), {points: [{geometry:{type:'Point',coordinates:[0.01,0.01]}, properties:{id:'one'}}]},
    [{id:'points', geometryType:'POINT', columns:{id:'TEXT'}}], bbox);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({format:'mapzero',version:1,bbox,styles:{},layers:['points']}));
  const result = await exportPmtiles({packageDir:dir,minZoom:10,maxZoom:14});
  assert.ok(result.estimatedTiles > 100000);
  assert.equal(result.sparsePlanCandidates, 45);
  assert.ok(result.writtenTiles > 0);
  assert.ok(result.planning.every((step) => step.mode === 'rtree' && step.extentCount === 1));
  await assert.rejects(exportPmtiles({packageDir:dir,minZoom:10,maxZoom:14,tilePlanning:'bbox'}), /use --force/);
});
