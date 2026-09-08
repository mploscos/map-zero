import assert from 'node:assert/strict';
import test from 'node:test';
import { openGeoPackageWriter, writeGeoPackage } from 'map-zero/gpkg';
import { openGeoPackageReader } from 'map-zero/gpkg-read';
import { createManifest, resolveManifestLayers, isLayerInZoomRange } from 'map-zero/manifest';
import * as legacyWriter from 'map-zero/src/gpkg.js';
import * as legacyReader from 'map-zero/src/gpkg-read.js';
import * as legacyManifest from 'map-zero/src/manifest.js';
import { exportPmtiles } from 'map-zero/export-pmtiles';
import { exportPmtiles as legacyExportPmtiles } from '../src/export-pmtiles.js';

test('public GeoPackage and manifest entry points reuse existing implementations and preserve deep imports', () => {
  assert.equal(openGeoPackageWriter, legacyWriter.openGeoPackageWriter);
  assert.equal(writeGeoPackage, legacyWriter.writeGeoPackage);
  assert.equal(openGeoPackageReader, legacyReader.openGeoPackageReader);
  assert.equal(createManifest, legacyManifest.createManifest);
  assert.equal(resolveManifestLayers, legacyManifest.resolveManifestLayers);
  assert.equal(isLayerInZoomRange, legacyManifest.isLayerInZoomRange);
  assert.equal(exportPmtiles, legacyExportPmtiles);
});
