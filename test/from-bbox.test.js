import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findGeofabrikExtract,
  findGeofabrikExtractCandidates,
  findGeofabrikExtracts,
  findGeofabrikExtractsById
} from '../src/from-bbox.js';

test('findGeofabrikExtract picks the smallest extract that contains the bbox', async () => {
  const provider = await findGeofabrikExtract([-3.8, 40.35, -3.6, 40.5], {
    cacheDir: await tempCacheDir(),
    indexUrl: geofabrikIndexUrl([
      extract('world', 'World', [-180, -90, 180, 90]),
      extract('spain', 'Spain', [-10, 35, 5, 44]),
      extract('madrid', 'Madrid', [-4.2, 40.1, -3.3, 40.7])
    ])
  });

  assert.equal(provider.id, 'madrid');
  assert.equal(provider.url, 'https://example.test/madrid.osm.pbf');
});

test('findGeofabrikExtract rejects bboxes outside all extracts', async () => {
  const cacheDir = await tempCacheDir();
  await assert.rejects(
    () => findGeofabrikExtract([10, 10, 11, 11], {
      cacheDir,
      indexUrl: geofabrikIndexUrl([
        extract('small', 'Small', [-1, -1, 1, 1])
      ])
    }),
    /no single Geofabrik extract fully contains bbox/
  );
});

test('findGeofabrikExtract skips partial administrative extracts for border bboxes', async () => {
  const providers = await findGeofabrikExtracts([-74.0273607, 40.6944331, -73.959499, 40.7371016], {
    cacheDir: await tempCacheDir(),
    indexUrl: geofabrikIndexUrl([
      extract('us/new-jersey', 'New Jersey', [-75.58, 38.75, -73.99, 41.36], undefined, ['US-NJ'], 'north-america'),
      extract('us/new-york', 'New York', [-73.99, 40.44, -71.66, 45.02], undefined, ['US-NY'], 'north-america'),
      extract('us-northeast', 'US Northeast', [-80.53, 38.74, -66.87, 47.47], undefined, [], 'north-america')
    ])
  });

  assert.deepEqual(providers.map((provider) => provider.id), ['us/new-jersey', 'us/new-york']);
});

test('findGeofabrikExtract can reuse a cached broader valid extract', async () => {
  const cacheDir = await tempCacheDir();
  await writeFile(join(cacheDir, 'large-latest.osm.pbf'), 'cached');

  const provider = await findGeofabrikExtract([0.2, 0.2, 0.8, 0.8], {
    cacheDir,
    indexUrl: geofabrikIndexUrl([
      extract('small', 'Small', [0, 0, 1, 1], 'small-latest.osm.pbf'),
      extract('large', 'Large', [-0.5, -0.5, 1.5, 1.5], 'large-latest.osm.pbf')
    ])
  });

  assert.equal(provider.id, 'large');
  assert.equal(provider.cached, true);
});

test('antimeridian extracts do not cover the opposite side of the world', async () => {
  await assert.rejects(
    async () => findGeofabrikExtract([-18.3, 27.5, 4.5, 43.9], {
      cacheDir: await tempCacheDir(),
      indexUrl: geofabrikIndexUrl([
        extractWithGeometry('us', 'United States', {
          type: 'Polygon',
          coordinates: [[
            [170, 15], [-170, 15], [-170, 73], [170, 73], [170, 15]
          ]]
        })
      ])
    }),
    /no single Geofabrik extract fully contains bbox/
  );
});

test('explicit extracts support discontinuous regions', async () => {
  const providers = await findGeofabrikExtractsById(
    [-18.3, 27.5, 4.5, 43.9],
    ['spain', 'canary-islands'],
    {
      cacheDir: await tempCacheDir(),
      indexUrl: geofabrikIndexUrl([
        extract('spain', 'Spain', [-9.8, 35.2, 5.1, 44.2]),
        extract('canary-islands', 'Canary Islands', [-18.9, 26.3, -12.4, 30.3])
      ])
    }
  );

  assert.deepEqual(providers.map((provider) => provider.id), ['spain', 'canary-islands']);
});

test('extract discovery lists geographic candidates without antimeridian false positives', async () => {
  const candidates = await findGeofabrikExtractCandidates([-18.3, 27.5, 4.5, 43.9], {
    cacheDir: await tempCacheDir(),
    indexUrl: geofabrikIndexUrl([
      extract('europe', 'Europe', [-30, 25, 45, 72], undefined, [], null),
      extract('africa', 'Africa', [-20, -36, 52, 38], undefined, [], null),
      extract('spain', 'Spain', [-9.8, 35.2, 5.1, 44.2], undefined, ['ES'], 'europe'),
      extract('portugal', 'Portugal', [-10, 36, -6, 42.2], undefined, ['PT'], 'europe'),
      extract('canary-islands', 'Canary Islands', [-18.9, 26.3, -12.4, 30.3], undefined, [], 'africa'),
      extractWithGeometry('us', 'United States', {
        type: 'Polygon',
        coordinates: [[[170, 15], [-170, 15], [-170, 73], [170, 73], [170, 15]]]
      })
    ])
  });

  assert.deepEqual(candidates.map((candidate) => candidate.id), [
    'portugal',
    'canary-islands',
    'spain'
  ]);
});

async function tempCacheDir() {
  return mkdtemp(join(tmpdir(), 'map-zero-from-bbox-'));
}

function geofabrikIndexUrl(features) {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ features }))}`;
}

function extract(id, name, bbox, fileName = `${id}.osm.pbf`, adminCodes = ['XX-TEST'], parent = null) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return {
    type: 'Feature',
    properties: {
      id,
      parent,
      name,
      'iso3166-2': adminCodes,
      urls: {
        pbf: `https://example.test/${fileName}`
      }
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat]
      ]]
    }
  };
}

function extractWithGeometry(id, name, geometry) {
  return {
    type: 'Feature',
    properties: {
      id,
      name,
      urls: { pbf: `https://example.test/${id}.osm.pbf` }
    },
    geometry
  };
}
