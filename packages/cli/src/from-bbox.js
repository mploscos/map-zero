import { createWriteStream, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';

import { buildPackage } from './build.js';
import { export3dTiles } from './3dtiles/export.js';
import { exportPmtiles } from './export-pmtiles.js';
import { packageMapZero } from './package.js';

const GEOFABRIK_INDEX_URL = 'https://download.geofabrik.de/index-v1.json';
const DOWNLOAD_TIMEOUT_SECONDS = 60;
const execFileAsync = promisify(execFile);

/**
 * Download the smallest matching OSM extract and build a complete map-zero
 * package for the requested bbox.
 *
 * @param {{
 *   bbox: [number, number, number, number],
 *   out: string,
 *   layers: string[],
 *   minZoom?: number,
 *   maxZoom?: number,
 *   workers?: number,
 *   forcePmtiles?: boolean,
 *   pmtiles?: boolean,
 *   tiles3d?: boolean,
 *   zip?: boolean,
 *   includeGpkg?: boolean,
 *   batchSize?: number,
 *   keepTemp?: boolean,
 *   debugBuild?: boolean,
 *   cacheDir?: string,
 *   providerIndexUrl?: string,
 *   extracts?: string[],
 *   forceDownload?: boolean,
 *   onStage?: (message: string) => void,
 *   onBuildProgress?: Parameters<typeof buildPackage>[0]['onProgress'],
 *   onPmtilesProgress?: Parameters<typeof exportPmtiles>[0]['onProgress'],
 *   on3dTilesProgress?: Parameters<typeof export3dTiles>[0]['onProgress']
 * }} options
 * @returns {Promise<{
 *   outDir: string,
 *   source: { name: string, id: string, url: string, path: string },
 *   sources: Array<{ name: string, id: string, url: string, path: string }>,
 *   counts: Record<string, number>,
 *   aip?: Awaited<ReturnType<typeof buildPackage>>['aip'],
 *   pmtiles?: Awaited<ReturnType<typeof exportPmtiles>>,
 *   tiles3d?: Awaited<ReturnType<typeof export3dTiles>>,
 *   zip?: Awaited<ReturnType<typeof packageMapZero>>
 * }>}
 */
export async function createPackageFromBbox(options) {
  const bbox = options.bbox;
  const outDir = resolve(options.out);
  const cacheDir = resolve(options.cacheDir ?? join(homedir(), '.cache', 'map-zero', 'osm'));
  const providerOptions = { cacheDir, indexUrl: options.providerIndexUrl };
  const providers = options.extracts?.length
    ? await findGeofabrikExtractsById(bbox, options.extracts, providerOptions)
    : await findGeofabrikExtracts(bbox, providerOptions);

  options.onStage?.(`Using ${providers.length} OSM extract${providers.length === 1 ? '' : 's'}: ${providers.map((provider) => provider.id).join(', ')}`);
  const sources = [];
  for (const provider of providers) {
    sources.push({
      provider,
      path: await downloadExtract(provider, {
        cacheDir,
        forceDownload: Boolean(options.forceDownload),
        onStage: options.onStage
      })
    });
  }

  options.onStage?.('Building map-zero package');
  const build = await buildPackage({
    source: sources.map((source) => source.path),
    bbox,
    layers: options.layers,
    out: outDir,
    keepTemp: options.keepTemp,
    batchSize: options.batchSize,
    debugBuild: options.debugBuild,
    onProgress: options.onBuildProgress
  });

  /** @type {Awaited<ReturnType<typeof exportPmtiles>> | undefined} */
  let pmtiles;
  if (options.pmtiles !== false) {
    options.onStage?.('Exporting PMTiles');
    pmtiles = await exportPmtiles({
      packageDir: outDir,
      minZoom: options.minZoom ?? 8,
      maxZoom: options.maxZoom ?? 16,
      workers: options.workers ?? 1,
      force: Boolean(options.forcePmtiles),
      onProgress: options.onPmtilesProgress
    });
  }

  /** @type {Awaited<ReturnType<typeof export3dTiles>> | undefined} */
  let tiles3d;
  if (options.tiles3d !== false) {
    options.onStage?.('Exporting 3D Tiles');
    tiles3d = await export3dTiles({
      packageDir: outDir,
      onProgress: options.on3dTilesProgress
    });
  }

  /** @type {Awaited<ReturnType<typeof packageMapZero>> | undefined} */
  let zip;
  if (options.zip !== false) {
    options.onStage?.('Creating portable zip');
    zip = await packageMapZero({
      packageDir: outDir,
      includeGpkg: Boolean(options.includeGpkg)
    });
  }

  return {
    outDir,
    source: {
      name: sources[0].provider.name,
      id: sources[0].provider.id,
      url: sources[0].provider.url,
      path: sources[0].path
    },
    sources: sources.map((source) => ({
      name: source.provider.name,
      id: source.provider.id,
      url: source.provider.url,
      path: source.path
    })),
    counts: build.counts,
    aip: build.aip,
    pmtiles,
    tiles3d,
    zip
  };
}

/**
 * Generate one standalone airport/runway catalog for a bbox. The temporary
 * GeoPackage is an implementation detail and is removed before returning.
 *
 * @param {{
 *   bbox: [number, number, number, number],
 *   out: string,
 *   batchSize?: number,
 *   cacheDir?: string,
 *   providerIndexUrl?: string,
 *   extracts?: string[],
 *   forceDownload?: boolean,
 *   onStage?: (message: string) => void,
 *   onBuildProgress?: Parameters<typeof buildPackage>[0]['onProgress']
 * }} options
 */
export async function createAirportCatalogFromBbox(options) {
  const workDir = await fs.mkdtemp(join(tmpdir(), 'map-zero-airports-'));
  try {
    const result = await createPackageFromBbox({
      ...options,
      out: join(workDir, 'source.mapzero'),
      layers: ['aip'],
      pmtiles: false,
      tiles3d: false,
      zip: false
    });
    if (!result.aip) {
      throw new Error('AIP airport catalog was not generated');
    }

    const outPath = resolve(options.out);
    await fs.mkdir(dirname(outPath), { recursive: true });
    await fs.copyFile(result.aip.outPath, outPath);
    return {
      outPath,
      source: result.source,
      sources: result.sources,
      summary: result.aip.summary
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/**
 * @param {[number, number, number, number]} bbox
 * @param {{ cacheDir: string, indexUrl?: string }} options
 */
export async function findGeofabrikExtract(bbox, options) {
  return (await findGeofabrikExtracts(bbox, options))[0];
}

/**
 * @param {[number, number, number, number]} bbox
 * @param {{ cacheDir: string, indexUrl?: string }} options
 */
export async function findGeofabrikExtracts(bbox, options) {
  const index = await loadGeofabrikIndex(options.cacheDir, options.indexUrl ?? GEOFABRIK_INDEX_URL);
  const features = Array.isArray(index.features) ? index.features : [];
  const normalizedFeatures = features
    .map(normalizeGeofabrikFeature)
    .filter(Boolean)
    .filter((feature) => bboxIntersectsBbox(bbox, feature.bbox));
  const candidates = await Promise.all(normalizedFeatures
    .filter((feature) => bboxInsideFeature(bbox, feature))
    .map((feature) => annotateCachedExtract(feature, options.cacheDir)));

  const selected = await selectGeofabrikCandidates(candidates, normalizedFeatures, bbox, options.cacheDir);
  if (selected.length === 0) {
    const intersecting = geofabrikExtractCandidates(normalizedFeatures, bbox);
    const hint = intersecting.length > 0
      ? ` Intersecting extracts: ${intersecting.map((feature) => feature.id).join(', ')}.` +
        ` Inspect them with "map-zero extracts --bbox=${formatBbox(bbox)}" and select with --extracts.`
      : '';
    throw new Error(`no single Geofabrik extract fully contains bbox ${formatBbox(bbox)}.${hint}`);
  }
  return selected;
}

/**
 * List human-scale Geofabrik extracts that intersect a bbox.
 *
 * @param {[number, number, number, number]} bbox
 * @param {{ cacheDir?: string, indexUrl?: string }} options
 */
export async function findGeofabrikExtractCandidates(bbox, options) {
  const cacheDir = resolve(options.cacheDir ?? join(homedir(), '.cache', 'map-zero', 'osm'));
  const index = await loadGeofabrikIndex(cacheDir, options.indexUrl ?? GEOFABRIK_INDEX_URL);
  const features = (Array.isArray(index.features) ? index.features : [])
    .map(normalizeGeofabrikFeature)
    .filter(Boolean);
  return Promise.all(
    geofabrikExtractCandidates(features, bbox)
      .map((feature) => annotateCachedExtract(feature, cacheDir))
  );
}

/**
 * Resolve an explicit set of Geofabrik extracts for discontinuous regions.
 *
 * @param {[number, number, number, number]} bbox
 * @param {string[]} ids
 * @param {{ cacheDir: string, indexUrl?: string }} options
 */
export async function findGeofabrikExtractsById(bbox, ids, options) {
  const index = await loadGeofabrikIndex(options.cacheDir, options.indexUrl ?? GEOFABRIK_INDEX_URL);
  const features = (Array.isArray(index.features) ? index.features : [])
    .map(normalizeGeofabrikFeature)
    .filter(Boolean);
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const selected = [];
  for (const id of new Set(ids)) {
    const feature = byId.get(id);
    if (!feature) {
      throw new Error(`unknown Geofabrik extract: ${id}`);
    }
    if (!bboxIntersectsBbox(bbox, feature.bbox)) {
      throw new Error(`Geofabrik extract ${id} does not intersect bbox ${formatBbox(bbox)}`);
    }
    selected.push(await annotateCachedExtract(feature, options.cacheDir));
  }
  return selected;
}

async function loadGeofabrikIndex(cacheDir, indexUrl) {
  await fs.mkdir(cacheDir, { recursive: true });
  const indexPath = join(cacheDir, 'geofabrik-index-v1.json');
  const cached = await fs.readFile(indexPath, 'utf8').catch(() => null);
  if (cached) {
    return JSON.parse(cached);
  }

  const text = await downloadText(indexUrl, 'Geofabrik index');
  await fs.writeFile(indexPath, text);
  return JSON.parse(text);
}

function normalizeGeofabrikFeature(feature) {
  const properties = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const urls = properties.urls && typeof properties.urls === 'object' ? properties.urls : {};
  const url = typeof urls.pbf === 'string' ? urls.pbf : null;
  const id = typeof properties.id === 'string' ? properties.id : null;
  const name = typeof properties.name === 'string' ? properties.name : id;
  if (!url || !id || !name || !feature?.geometry) {
    return null;
  }
  return {
    id,
    name,
    url,
    parent: typeof properties.parent === 'string' ? properties.parent : null,
    adminCodes: adminCodesFromProperties(properties),
    geometry: feature.geometry,
    bbox: geometryBbox(feature.geometry)
  };
}

function adminCodesFromProperties(properties) {
  const value = properties['iso3166-2'];
  return (Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === 'string');
}

async function annotateCachedExtract(feature, cacheDir) {
  const fileName = safeFileName(basename(new URL(feature.url).pathname) || `${feature.id}.osm.pbf`);
  const filePath = join(cacheDir, fileName);
  const stat = await fs.stat(filePath).catch(() => null);
  return {
    ...feature,
    cached: Boolean(stat?.isFile() && stat.size > 0),
    path: filePath
  };
}

async function selectGeofabrikCandidates(candidates, features, bbox, cacheDir) {
  const sorted = [...candidates].sort((a, b) => featureArea(a) - featureArea(b));
  const smallest = sorted[0];
  if (!smallest) return [];
  const combined = await combinedAdministrativeCandidates(features, bbox, cacheDir);
  if (combined.length > 1 && combined.length <= 4) {
    return combined;
  }

  const boundarySafe = boundarySafeCandidate(sorted, features, bbox, smallest);

  const smallestArea = featureArea(boundarySafe);
  const cached = sorted
    .filter((candidate) => featureArea(candidate) >= smallestArea)
    .filter((candidate) => candidate.cached)
    .filter((candidate) => featureArea(candidate) <= smallestArea * 6)
    .sort((a, b) => featureArea(a) - featureArea(b))[0];

  return [cached ?? boundarySafe];
}

async function combinedAdministrativeCandidates(features, bbox, cacheDir) {
  const samples = bboxSamplePoints(bbox);
  const groups = new Map();
  for (const feature of features) {
    if (!feature.parent || !feature.adminCodes?.length) continue;
    if (!samples.some((point) => pointInGeometry(point, feature.geometry))) continue;
    if (!groups.has(feature.parent)) groups.set(feature.parent, []);
    groups.get(feature.parent).push(feature);
  }

  const plans = [];
  for (const group of groups.values()) {
    const relevant = group
      .filter((feature) => samples.some((point) => pointInGeometry(point, feature.geometry)))
      .sort((a, b) => featureArea(a) - featureArea(b));
    const covered = samples.every((point) => relevant.some((feature) => pointInGeometry(point, feature.geometry)));
    if (covered && relevant.length > 1) {
      plans.push(relevant);
    }
  }

  const best = plans
    .sort((a, b) => a.reduce((total, item) => total + featureArea(item), 0) - b.reduce((total, item) => total + featureArea(item), 0))[0];
  return best ? Promise.all(best.map((feature) => annotateCachedExtract(feature, cacheDir))) : [];
}

function boundarySafeCandidate(candidates, features, bbox, selected) {
  if (!selected.adminCodes?.length || !selected.parent) {
    return selected;
  }

  const siblingAdministrativeOverlap = features.some((feature) =>
    feature.id !== selected.id &&
    feature.parent === selected.parent &&
    feature.adminCodes?.length > 0 &&
    bboxIntersectsBbox(bbox, feature.bbox) &&
    bboxSamplePoints(bbox).some((point) => pointInGeometry(point, feature.geometry))
  );
  if (!siblingAdministrativeOverlap) {
    return selected;
  }

  return candidates.find((candidate) => !candidate.adminCodes?.length) ?? selected;
}

function geofabrikExtractCandidates(features, bbox) {
  const rootIds = new Set(features.filter((feature) => !feature.parent).map((feature) => feature.id));
  const intersecting = features.filter((feature) => geometryIntersectsBbox(feature.geometry, bbox));
  const regional = intersecting.filter((feature) => feature.parent && rootIds.has(feature.parent));
  return (regional.length > 0 ? regional : intersecting)
    .sort((a, b) => featureArea(a) - featureArea(b));
}

function geometryIntersectsBbox(geometry, bbox) {
  if (bboxSamplePoints(bbox).some((point) => pointInGeometry(point, geometry))) {
    return true;
  }
  const points = [];
  collectGeometryPoints(geometry, points);
  return points.some((point) => pointInsideBbox(point, bbox));
}

function pointInsideBbox(point, bbox) {
  return point[0] >= bbox[0] && point[0] <= bbox[2] &&
    point[1] >= bbox[1] && point[1] <= bbox[3];
}

async function downloadExtract(provider, options) {
  await fs.mkdir(options.cacheDir, { recursive: true });
  const fileName = safeFileName(basename(new URL(provider.url).pathname) || `${provider.id}.osm.pbf`);
  const filePath = join(options.cacheDir, fileName);
  const stat = await fs.stat(filePath).catch(() => null);
  if (stat?.isFile() && stat.size > 0 && !options.forceDownload) {
    options.onStage?.(`Using cached extract: ${filePath}`);
    return filePath;
  }

  options.onStage?.(`Downloading ${provider.url}`);
  const tempPath = `${filePath}.part`;
  await downloadFile(provider.url, tempPath, `OSM extract ${provider.id}`);
  await fs.rename(tempPath, filePath);
  return filePath;
}

async function downloadText(url, label) {
  try {
    const response = await fetchWithTimeout(url, label);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch (fetchError) {
    try {
      const result = await execFileAsync('wget', [
        '-q',
        '-O',
        '-',
        `--timeout=${DOWNLOAD_TIMEOUT_SECONDS}`,
        '--tries=1',
        url
      ], {
        maxBuffer: 32 * 1024 * 1024
      });
      return result.stdout;
    } catch (wgetError) {
      throw new Error(`${label} download failed from ${url}. fetch: ${errorMessage(fetchError)}. wget: ${errorMessage(wgetError)}`);
    }
  }
}

async function downloadFile(url, filePath, label) {
  await fs.rm(filePath, { force: true });
  try {
    const response = await fetchWithTimeout(url, label);
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    const stream = createWriteStream(filePath);
    try {
      for await (const chunk of response.body) {
        if (!stream.write(Buffer.from(chunk))) {
          await once(stream, 'drain');
        }
      }
      stream.end();
      await once(stream, 'finish');
      return;
    } catch (error) {
      stream.destroy();
      throw error;
    }
  } catch (fetchError) {
    await fs.rm(filePath, { force: true });
    try {
      await execFileAsync('wget', [
        '-q',
        '-O',
        filePath,
        `--timeout=${DOWNLOAD_TIMEOUT_SECONDS}`,
        '--tries=1',
        url
      ]);
    } catch (wgetError) {
      await fs.rm(filePath, { force: true });
      throw new Error(`${label} download failed from ${url}. fetch: ${errorMessage(fetchError)}. wget: ${errorMessage(wgetError)}`);
    }
  }
}

async function fetchWithTimeout(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_SECONDS * 1000);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'map-zero/0.3.1',
        accept: 'application/json,application/octet-stream,*/*'
      }
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`timeout after ${DOWNLOAD_TIMEOUT_SECONDS}s`);
    }
    throw new Error(`${label} fetch failed: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function bboxInsideFeature(bbox, feature) {
  if (feature.bbox && !bboxInsideBbox(bbox, feature.bbox)) {
    return false;
  }
  return bboxSamplePoints(bbox).every((point) => pointInGeometry(point, feature.geometry));
}

function bboxInsideBbox(inner, outer) {
  return inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[2] <= outer[2] &&
    inner[3] <= outer[3];
}

function bboxIntersectsBbox(a, b) {
  return Boolean(a && b) &&
    a[0] <= b[2] &&
    a[2] >= b[0] &&
    a[1] <= b[3] &&
    a[3] >= b[1];
}

function bboxSamplePoints(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const points = [];
  for (const lonFactor of [0, 0.25, 0.5, 0.75, 1]) {
    for (const latFactor of [0, 0.25, 0.5, 0.75, 1]) {
      points.push([
        minLon + (maxLon - minLon) * lonFactor,
        minLat + (maxLat - minLat) * latFactor
      ]);
    }
  }
  return points;
}

function pointInGeometry(point, geometry) {
  if (geometry?.type === 'Polygon') {
    return pointInPolygon(point, geometry.coordinates);
  }
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  }
  return false;
}

function pointInPolygon(point, rings) {
  if (!Array.isArray(rings) || rings.length === 0) {
    return false;
  }
  if (!pointInRing(point, rings[0])) {
    return false;
  }
  return rings.slice(1).every((hole) => !pointInRing(point, hole));
}

function pointInRing(point, ring) {
  const unwrapped = unwrapRing(ring);
  if (unwrapped.length === 0) return false;
  let inside = false;
  const center = unwrapped.reduce((total, coordinate) => total + coordinate[0], 0) / unwrapped.length;
  let x = point[0];
  while (x - center > 180) x -= 360;
  while (x - center < -180) x += 360;
  const y = point[1];
  for (let i = 0, j = unwrapped.length - 1; i < unwrapped.length; j = i, i += 1) {
    const [xi, yi] = unwrapped[i];
    const [xj, yj] = unwrapped[j];
    if (pointOnSegment(x, y, xi, yi, xj, yj)) {
      return true;
    }
    const intersects = ((yi > y) !== (yj > y)) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function unwrapRing(ring) {
  const unwrapped = [];
  for (const coordinate of ring ?? []) {
    let longitude = Number(coordinate?.[0]);
    const latitude = Number(coordinate?.[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    const previous = unwrapped.at(-1)?.[0];
    if (previous !== undefined) {
      while (longitude - previous > 180) longitude -= 360;
      while (longitude - previous < -180) longitude += 360;
    }
    unwrapped.push([longitude, latitude]);
  }
  return unwrapped;
}

function pointOnSegment(x, y, x1, y1, x2, y2) {
  const lengthSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (lengthSquared === 0) {
    return (x - x1) ** 2 + (y - y1) ** 2 <= 1e-20;
  }
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (x - x1) * (x2 - x1) + (y - y1) * (y2 - y1);
  if (dot < 0) return false;
  return dot <= lengthSquared;
}

function geometryBbox(geometry) {
  const points = [];
  collectGeometryPoints(geometry, points);
  if (points.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const point of points) {
    minLon = Math.min(minLon, point[0]);
    minLat = Math.min(minLat, point[1]);
    maxLon = Math.max(maxLon, point[0]);
    maxLat = Math.max(maxLat, point[1]);
  }
  return [minLon, minLat, maxLon, maxLat];
}

function collectGeometryPoints(geometry, points) {
  if (geometry?.type === 'Polygon') {
    for (const ring of geometry.coordinates ?? []) {
      collectRingPoints(ring, points);
    }
  }
  if (geometry?.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates ?? []) {
      for (const ring of polygon) {
        collectRingPoints(ring, points);
      }
    }
  }
}

function collectRingPoints(ring, points) {
  for (const point of ring ?? []) {
    const lon = Number(point?.[0]);
    const lat = Number(point?.[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      points.push([lon, lat]);
    }
  }
}

function featureArea(feature) {
  const bbox = feature.bbox;
  if (!bbox) return Infinity;
  return Math.abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
}

function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function formatBbox(bbox) {
  return bbox.map((value) => Number(value.toFixed(7))).join(',');
}
