import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { unzipSync } from 'fflate';

import {
  AIP_AIRPORT_CATALOG_FORMAT,
  createAipAirportCatalog
} from '../packages/core/src/aip.js';
import { exportAipAirportCatalog } from '../src/aip.js';
import { writeGeoPackage } from '../src/gpkg.js';
import { createManifest } from '../src/manifest.js';
import { packageMapZero } from '../src/package.js';
import { createMapZeroServer } from '../src/server.js';

const bbox = [-0.02, -0.02, 0.02, 0.02];
const airportRing = [[-0.015, -0.01], [0.015, -0.01], [0.015, 0.01], [-0.015, 0.01], [-0.015, -0.01]];

test('OSM AIP features become directional runway thresholds with true headings', () => {
  const catalog = createAipAirportCatalog(osmFeatures(), {
    bbox,
    source: { type: 'osm', name: 'OpenStreetMap' }
  });

  assert.equal(catalog.format, AIP_AIRPORT_CATALOG_FORMAT);
  assert.deepEqual(catalog.summary, {
    airports: 1,
    physicalRunways: 1,
    runwayDirections: 2,
    mappedThresholds: 2,
    estimatedThresholds: 0,
    unresolvedRunways: 0
  });
  const [airport] = catalog.airports;
  assert.equal(airport.id, 'TEST');
  assert.equal(airport.altitudeM, 100);
  assert.deepEqual(airport.runways.map((runway) => runway.designator), ['09', '27']);
  assert.deepEqual(airport.runways.map((runway) => runway.headingTrueDeg), [90, 270]);
  assert.deepEqual(airport.runways.map((runway) => runway.threshold.altitudeM), [101, 102]);
  assert.ok(airport.runways.every((runway) => runway.quality === 'mapped-threshold'));
});

test('normalized AIP airport and runway features keep source-provided headings', () => {
  const catalog = createAipAirportCatalog([
    feature('airports', { type: 'Point', coordinates: [-3.56, 40.47] }, {
      id: 'airport:LEMD', type: 'airport', ident: 'LEMD', icao: 'LEMD',
      name: 'Madrid', elevationM: 609
    }),
    feature('runways', { type: 'Point', coordinates: [-3.557869, 40.494886] }, {
      id: 'runway:LEMD:14L', type: 'runway', airportId: 'LEMD',
      runwayDesignator: '14L', headingDeg: 142.21, elevationM: 592
    })
  ], {
    bbox: [-3.6, 40.4, -3.5, 40.55],
    source: { type: 'arinc424' }
  });

  const [runway] = catalog.airports[0].runways;
  assert.equal(runway.designator, '14L');
  assert.equal(runway.headingTrueDeg, 142.21);
  assert.equal(runway.threshold.altitudeM, 592);
  assert.equal(runway.quality, 'source');
});

test('missing threshold points use runway endpoints and report the estimate', () => {
  const catalog = createAipAirportCatalog(osmFeatures().slice(0, 2), { bbox });
  const runways = catalog.airports[0].runways;
  assert.deepEqual(runways.map((runway) => runway.headingTrueDeg), [90, 270]);
  assert.ok(runways.every((runway) => runway.quality === 'estimated'));
  assert.equal(catalog.summary.estimatedThresholds, 2);
});

test('AIP exporter accepts normalized airport and runway GeoPackage layers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'map-zero-normalized-aip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const layers = [
    {
      id: 'airports', geometryType: 'POINT',
      columns: { id: 'TEXT', ident: 'TEXT', icao: 'TEXT', name: 'TEXT', elevationM: 'REAL' }
    },
    {
      id: 'runways', geometryType: 'POINT',
      columns: { id: 'TEXT', airportId: 'TEXT', runwayDesignator: 'TEXT', headingDeg: 'REAL', elevationM: 'REAL' }
    }
  ];
  writeGeoPackage(join(dir, 'data.gpkg'), {
    airports: [{
      geometry: { type: 'Point', coordinates: [-3.56, 40.47] },
      properties: { id: 'airport:LEMD', ident: 'LEMD', icao: 'LEMD', name: 'Madrid', elevationM: 609 }
    }],
    runways: [{
      geometry: { type: 'Point', coordinates: [-3.557869, 40.494886] },
      properties: {
        id: 'runway:LEMD:14L', airportId: 'airport:LEMD', runwayDesignator: '14L',
        headingDeg: 142.21, elevationM: 592
      }
    }]
  }, layers, [-3.6, 40.4, -3.5, 40.55]);
  const manifest = createManifest({ outDir: dir, bbox: [-3.6, 40.4, -3.5, 40.55], layers });
  manifest.styles = {};
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));

  const result = await exportAipAirportCatalog({ packageDir: dir });
  assert.equal(result.summary.airports, 1);
  const catalog = JSON.parse(await readFile(result.outPath, 'utf8'));
  assert.equal(catalog.airports[0].runways[0].headingTrueDeg, 142.21);
  assert.equal(catalog.source.type, 'aip');
});

test('AIP exporter updates the manifest, server and portable package', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'map-zero-aip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gpkgPath = join(dir, 'data.gpkg');
  const schema = {
    id: 'aip',
    geometryType: 'GEOMETRY',
    columns: {
      id: 'TEXT', name: 'TEXT', aeroway: 'TEXT', ref: 'TEXT', icao: 'TEXT',
      iata: 'TEXT', ele: 'TEXT', surface: 'TEXT', width: 'TEXT', length: 'TEXT'
    }
  };
  writeGeoPackage(gpkgPath, { aip: osmFeatures().map(({ geometry, properties }) => ({ geometry, properties })) }, [schema], bbox);
  const manifest = createManifest({ outDir: dir, bbox, layers: ['aip'] });
  manifest.styles = {};
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));

  const result = await exportAipAirportCatalog({ packageDir: dir });
  assert.equal(result.url, 'aip/airports.json');
  assert.equal(result.summary.runwayDirections, 2);
  const updated = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(updated.aip.airports, {
    format: AIP_AIRPORT_CATALOG_FORMAT,
    version: 1,
    url: 'aip/airports.json'
  });

  const app = await createMapZeroServer({ packageDir: dir });
  try {
    const response = await app.inject('/aip/airports.json');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().summary.runwayDirections, 2);
  } finally {
    await app.close();
  }

  const zip = await packageMapZero({ packageDir: dir, out: join(dir, 'delivery.zip') });
  const entries = unzipSync(await readFile(zip.outPath));
  assert.ok(entries[`${basename(dir)}/aip/airports.json`]);
});

function osmFeatures() {
  return [
    feature('aip', { type: 'Polygon', coordinates: [airportRing] }, {
      id: 'way/airport', name: 'Test Airport', aeroway: 'aerodrome', icao: 'TEST', ele: '100'
    }),
    feature('aip', { type: 'LineString', coordinates: [[-0.01, 0], [0.01, 0]] }, {
      id: 'way/runway', aeroway: 'runway', ref: '09/27', ele: '100'
    }),
    feature('aip', { type: 'Point', coordinates: [-0.01, 0] }, {
      id: 'node/09', aeroway: 'threshold', ref: '09', ele: '101'
    }),
    feature('aip', { type: 'Point', coordinates: [0.01, 0] }, {
      id: 'node/27', aeroway: 'threshold', ref: '27', ele: '102'
    })
  ];
}

function feature(layer, geometry, properties) {
  return { layer, geometry, properties };
}
