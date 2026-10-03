import assert from 'node:assert/strict';
import test from 'node:test';
import { openGeoPackageWriter, writeGeoPackage } from '@map-zero/cli/gpkg';
import { openGeoPackageReader } from '@map-zero/cli/gpkg-read';
import { createManifest, resolveManifestLayers, isLayerInZoomRange } from '@map-zero/cli/manifest';
import * as legacyWriter from '@map-zero/cli/src/gpkg.js';
import * as legacyReader from '@map-zero/cli/src/gpkg-read.js';
import * as legacyManifest from '@map-zero/cli/src/manifest.js';
import { exportPmtiles } from '@map-zero/cli/export-pmtiles';
import * as coreAip from '../packages/core/src/aip.js';
import * as nodeAip from '../src/aip.js';
import { exportPmtiles as legacyExportPmtiles } from '../src/export-pmtiles.js';

test('public GeoPackage and manifest entry points reuse existing implementations and preserve deep imports', () => {
  assert.equal(openGeoPackageWriter, legacyWriter.openGeoPackageWriter);
  assert.equal(writeGeoPackage, legacyWriter.writeGeoPackage);
  assert.equal(openGeoPackageReader, legacyReader.openGeoPackageReader);
  assert.equal(createManifest, legacyManifest.createManifest);
  assert.equal(resolveManifestLayers, legacyManifest.resolveManifestLayers);
  assert.equal(isLayerInZoomRange, legacyManifest.isLayerInZoomRange);
  assert.equal(exportPmtiles, legacyExportPmtiles);
  assert.equal(coreAip.createAipAirportCatalog, nodeAip.createAipAirportCatalog);
  assert.equal(coreAip.exportAipAirportCatalog, undefined);
});
