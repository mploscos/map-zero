import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findGeofabrikExtract, findGeofabrikExtracts } from '../src/from-bbox.js';

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
    /no Geofabrik extract fully contains bbox/
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
