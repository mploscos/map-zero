import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  AIP_AIRPORT_CATALOG_FORMAT,
  AIP_AIRPORT_CATALOG_VERSION,
  createAipAirportCatalog
} from '../packages/core/src/aip.js';
import { openGeoPackageReader } from './gpkg-read.js';
import { resolveManifestLayers } from './manifest.js';

export {
  AIP_AIRPORT_CATALOG_FORMAT,
  AIP_AIRPORT_CATALOG_VERSION,
  createAipAirportCatalog
} from '../packages/core/src/aip.js';

const DefaultCatalogUrl = 'aip/airports.json';

/**
 * Export an airport catalog from the AIP-compatible layers of a map-zero
 * package and declare the artifact in its manifest.
 *
 * Raw OSM packages use the `aip` layer. Source adapters such as ARINC may use
 * separate normalized `airports` and `runways` layers.
 *
 * @param {{packageDir: string, out?: string, source?: Record<string, unknown>}} options
 * @returns {Promise<{outPath: string, url: string, summary: Record<string, number>}>}
 */
export async function exportAipAirportCatalog(options) {
  const packageDir = resolve(options.packageDir);
  const manifestPath = join(packageDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const bbox = manifest.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) {
    throw new Error('manifest must contain a finite bbox before exporting AIP airports');
  }

  const url = catalogUrl(options.out ?? DefaultCatalogUrl);
  const gpkgPath = join(packageDir, String(manifest.data ?? 'data.gpkg'));
  const layers = resolveManifestLayers(manifest);
  const layerIds = new Set(layers.map((layer) => layer.id));
  const reader = openGeoPackageReader({ gpkgPath, manifest });
  let features;
  try {
    if (layerIds.has('aip')) {
      features = reader.getTileFeatures('aip', bbox, {
        any: [{ column: 'aeroway', include: ['aerodrome', 'airport', 'runway', 'threshold'] }]
      }).map((feature) => ({ ...feature, layer: 'aip' }));
    } else if (layerIds.has('airports') && layerIds.has('runways')) {
      features = [
        ...reader.getTileFeatures('airports', bbox).map((feature) => ({ ...feature, layer: 'airports' })),
        ...reader.getTileFeatures('runways', bbox).map((feature) => ({ ...feature, layer: 'runways' }))
      ];
    } else {
      throw new Error('package has no AIP-compatible airport and runway layers');
    }
  } finally {
    reader.close();
  }

  const catalog = createAipAirportCatalog(features, {
    bbox,
    source: options.source ?? sourceMetadata(layers)
  });
  const outPath = join(packageDir, url);
  await fs.mkdir(dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(catalog, null, 2)}\n`);

  const aip = manifest.aip && typeof manifest.aip === 'object' && !Array.isArray(manifest.aip)
    ? manifest.aip
    : {};
  manifest.aip = {
    ...aip,
    airports: {
      format: AIP_AIRPORT_CATALOG_FORMAT,
      version: AIP_AIRPORT_CATALOG_VERSION,
      url
    }
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    outPath,
    url,
    summary: /** @type {Record<string, number>} */ (catalog.summary)
  };
}

function sourceMetadata(layers) {
  const aip = layers.find((layer) => layer.id === 'aip');
  if (aip) {
    return {
      type: 'osm',
      name: 'OpenStreetMap',
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL-1.0'
    };
  }
  const source = layers.find((layer) => layer.id === 'airports')?.source;
  return { type: 'aip', ...(source ? { name: source } : {}) };
}

function catalogUrl(value) {
  const normalized = String(value).replaceAll('\\', '/');
  if (isAbsolute(normalized) || !normalized || normalized.startsWith('/')
      || normalized.split('/').includes('..') || !normalized.endsWith('.json')) {
    throw new Error(`invalid AIP airport catalog path: ${value}`);
  }
  return normalized;
}
