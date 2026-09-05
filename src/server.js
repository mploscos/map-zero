import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';

import { PMTiles } from 'pmtiles';
import { LocalPmtilesSource } from './pmtiles-source.js';
import Fastify from 'fastify';

import { openGeoPackageReader } from './gpkg-read.js';
import { createCesiumViewerHtml, createViewerHtml } from './html.js';
import { encodeMvtTileSetWithStats, encodeMvtTileWithStats } from './mvt.js';
import { createHiddenFilters } from './style-filters.js';
import { TileCache } from './tile-cache.js';

/**
 * @typedef {{
 *   buffer: Buffer,
 *   featureCount: number,
 *   originalFeatureCount: number,
 *   encodedFeatureCount: number,
 *   droppedFeatureCount: number,
 *   bbox: [number, number, number, number],
 *   layerNames: string[],
 *   emptyReason: string,
 *   originalVertexCount: number,
 *   simplifiedVertexCount: number,
 *   droppedSmallFeatures: number,
 *   simplificationTolerance: number
 * }} TileGenerationResult
 */

/**
 * Create a readonly map-zero HTTP server.
 *
 * @param {{ packageDir: string, tileCache?: boolean, tileCacheSize?: number, tileMaxFeatures?: number, debugTiles?: boolean, debugLabels?: boolean }} options
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function createMapZeroServer(options) {
  const packageDir = resolve(options.packageDir);
  const manifestPath = join(packageDir, 'manifest.json');
  const stylesDir = join(packageDir, 'styles');
  const manifest = await readJsonFile(manifestPath);
  const gpkgPath = join(packageDir, String(manifest.data ?? 'data.gpkg'));
  const defaultStyle = await readDefaultStyle(packageDir, manifest);

  validateManifest(manifest);
  await assertReadableFile(gpkgPath, 'GeoPackage');

  const reader = openGeoPackageReader({
    gpkgPath,
    manifest,
    hiddenFilters: createHiddenFilters(manifest, defaultStyle)
  });
  const assetVersion = String(Date.now());
  const tileCache = options.tileCache === false
    ? null
    : new TileCache(options.tileCacheSize ?? 500);
  /** @type {Map<string, Promise<TileGenerationResult>>} */
  const pendingTiles = new Map();
  const app = Fastify({
    logger: false
  });

  app.addHook('onClose', async () => {
    tileCache?.clear();
    pendingTiles.clear();
    reader.close();
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = Number(error.statusCode) || 500;
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'internal server error' : error.message
    });
  });

  app.get('/', async (request, reply) => {
    reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(createViewerHtml({ assetVersion }));
  });

  app.get('/cesium', async (request, reply) => {
    reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(createCesiumViewerHtml({ assetVersion }));
  });

  app.get('/map-zero-ol.js', async (request, reply) => {
    const moduleSource = await fs.readFile(new URL('../packages/ol/src/index.js', import.meta.url), 'utf8');
    const cacheBustedSource = rewriteCoreModuleImports(moduleSource)
      .replace(
        "from './labels.js';",
        `from './labels.js?v=${encodeURIComponent(assetVersion)}';`
      );
    reply
      .header('cache-control', 'no-store')
      .type('text/javascript; charset=utf-8')
      .send(cacheBustedSource);
  });

  app.get('/labels.js', async (request, reply) => {
    const moduleSource = await fs.readFile(new URL('../packages/ol/src/labels.js', import.meta.url), 'utf8');
    reply
      .header('cache-control', 'no-store')
      .type('text/javascript; charset=utf-8')
      .send(rewriteCoreModuleImports(moduleSource));
  });

  app.get('/zoom.js', async (request, reply) => {
    const moduleSource = await fs.readFile(new URL('../packages/ol/src/zoom.js', import.meta.url), 'utf8');
    reply
      .header('cache-control', 'no-store')
      .type('text/javascript; charset=utf-8')
      .send(moduleSource);
  });

  app.get('/vendor/pmtiles.js', async (request, reply) => {
    const moduleSource = await fs.readFile(new URL('../node_modules/pmtiles/dist/esm/index.js', import.meta.url), 'utf8');
    reply
      .header('cache-control', 'public, max-age=31536000, immutable')
      .type('text/javascript; charset=utf-8')
      .send(moduleSource);
  });

  app.get('/vendor/fflate.js', async (request, reply) => {
    const moduleSource = await fs.readFile(new URL('../node_modules/fflate/esm/browser.js', import.meta.url), 'utf8');
    reply
      .header('cache-control', 'public, max-age=31536000, immutable')
      .type('text/javascript; charset=utf-8')
      .send(moduleSource);
  });

  for (const [route, name] of [['/map-zero-cesium.js', 'index.js'], ['/vector.js', 'vector.js'], ['/cesium-labels.js', 'cesium-labels.js']]) {
    app.get(route, async (request, reply) => {
      const source = await fs.readFile(new URL(`../packages/cesium/src/${name}`, import.meta.url), 'utf8');
      reply.header('cache-control', 'no-store').type('text/javascript; charset=utf-8')
        .send(rewriteCoreModuleImports(source).replace(/import\s*\{([^}]+)\}\s*from 'cesium';/g,
          'const {$1} = globalThis.Cesium;'));
    });
  }
  for (const [route, allowed] of [
    ['/map-zero-core/:name', ['style.js', 'labels.js']],
    ['/map-zero-core/shared/:name', ['cache.js', 'layers.js']]
  ]) {
    app.get(route, async (request, reply) => {
      const name = String(request.params.name ?? '');
      if (!allowed.includes(name)) return reply.code(404).send({ error: 'not found' });
      const directory = route.includes('/shared/') ? 'shared/' : '';
      const source = await fs.readFile(new URL(`../packages/core/src/${directory}${name}`, import.meta.url), 'utf8');
      return reply.header('cache-control', 'no-store').type('text/javascript; charset=utf-8').send(source);
    });
  }

  app.get('/manifest.json', async (request, reply) => {
    reply.header('cache-control', 'no-store').send(manifest);
  });

  const pmtilesPath = pmtilesArchivePath(packageDir, manifest);
  if (pmtilesPath) {
    app.get(`/${pmtilesPath.url}`, async (request, reply) => {
      await sendRangeFile(request, reply, pmtilesPath.path, 'application/vnd.pmtiles');
    });
  }

  const archiveSource = pmtilesPath ? new LocalPmtilesSource(pmtilesPath.path) : null;
  const archive = archiveSource ? new PMTiles(archiveSource) : null;
  if (archiveSource) app.addHook('onClose', () => archiveSource.close());
  app.get('/api/vector-tiles/:z/:x/:y.mvt', async (request, reply) => {
    const { z, x, y } = request.params;
    const coords = [z, x, y].map(Number);
    if (!coords.every(Number.isInteger) || coords[0] < 0 || coords[0] > 22
      || coords[1] < 0 || coords[2] < 0 || coords[1] >= 2 ** coords[0] || coords[2] >= 2 ** coords[0]) {
      return reply.code(400).send({ error: 'invalid XYZ tile coordinates' });
    }
    if (!archive) return reply.redirect(`/api/tiles/${z}/${x}/${y}.mvt`);
    const tile = await archive.getZxy(...coords);
    if (!tile) return reply.code(204).send();
    return reply.type('application/vnd.mapbox-vector-tile').send(Buffer.from(tile.data));
  });

  const tilesetUrls = Object.values(manifest.tiles3d?.tilesets ?? { default: manifest.tiles3d?.url }).filter((url) => typeof url === 'string');
  const tilesetPaths = new Map();
  for (const url of tilesetUrls) {
    const path = tiles3dBasePath(packageDir, { ...manifest, tiles3d: { ...manifest.tiles3d, url } });
    if (path) tilesetPaths.set(path.urlPrefix, path);
  }
  for (const tiles3dPath of tilesetPaths.values()) {
    app.get(`/${tiles3dPath.urlPrefix}/*`, async (request, reply) => {
      const params = /** @type {Record<string, string>} */ (request.params);
      const relativePath = params['*'] ?? '';
      const filePath = safeJoin(tiles3dPath.pathPrefix, relativePath);
      if (!filePath) {
        reply.status(404).send({ error: 'file not found' });
        return;
      }

      await sendRangeFile(request, reply, filePath, contentTypeFor3dTiles(filePath));
    });
  }

  app.get('/styles/:name', async (request, reply) => {
    const { name } = /** @type {{ name: string }} */ (request.params);
    const safeName = validateStyleName(name);
    const stylePath = join(stylesDir, safeName);
    const style = await readJsonFile(stylePath).catch(() => null);

    if (!style) {
      reply.status(404).send({ error: `style not found: ${safeName}` });
      return;
    }

    reply.header('cache-control', 'no-store').send(style);
  });

  app.get('/api/info', async (request, reply) => {
    reply.header('cache-control', 'no-store').send(reader.getInfo(packageDir));
  });

  app.get('/api/layers', async (request, reply) => {
    reply.header('cache-control', 'no-store').send({
      layers: reader.getLayers()
    });
  });

  app.get('/api/tiles/:z/:x/:y.mvt', async (request, reply) => {
    const { z, x, y } = /** @type {{ z: string, x: string, y: string }} */ (request.params);
    const { layers, detail } = /** @type {{ layers?: string, detail?: string }} */ (request.query);
    const layerIds = parseTileLayerQuery(layers);
    const tileDetail = parseTileDetailQuery(detail);
    const resolvedDetail = resolveTileDetail(z, tileDetail);
    const label = tileLayerLabel(layerIds);

    await sendMvtTile(reply, {
      cacheKey: createTileCacheKey(packageDir, label, z, x, y, resolvedDetail),
      cacheLabel: label,
      z,
      x,
      y,
      detail: resolvedDetail,
      tileCache,
      pendingTiles,
      debugTiles: Boolean(options.debugTiles),
      generate: () => encodeMvtTileSetWithStats(reader, z, x, y, layerIds, {
        detail: resolvedDetail,
        maxFeatures: options.tileMaxFeatures,
        style: defaultStyle,
        debugLabels: Boolean(options.debugLabels)
      })
    });
  });

  app.get('/api/tiles/:layer/:z/:x/:y.mvt', async (request, reply) => {
    const { layer, z, x, y } = /** @type {{ layer: string, z: string, x: string, y: string }} */ (request.params);
    const { detail } = /** @type {{ detail?: string }} */ (request.query);
    const tileDetail = parseTileDetailQuery(detail);
    const resolvedDetail = resolveTileDetail(z, tileDetail);

    await sendMvtTile(reply, {
      cacheKey: createTileCacheKey(packageDir, layer, z, x, y, resolvedDetail),
      cacheLabel: layer,
      z,
      x,
      y,
      detail: resolvedDetail,
      tileCache,
      pendingTiles,
      debugTiles: Boolean(options.debugTiles),
      generate: () => encodeMvtTileWithStats(reader, layer, z, x, y, {
        detail: resolvedDetail,
        maxFeatures: options.tileMaxFeatures,
        style: defaultStyle,
        debugLabels: Boolean(options.debugLabels)
      })
    });
  });

  return app;
}

/**
 * Start a readonly map-zero HTTP server.
 *
 * @param {{
 *   packageDir: string,
 *   host: string,
 *   port: number,
 *   open?: boolean,
 *   tileCache?: boolean,
 *   tileCacheSize?: number,
 *   tileMaxFeatures?: number,
 *   debugTiles?: boolean,
 *   debugLabels?: boolean
 * }} options
 * @returns {Promise<{ app: import('fastify').FastifyInstance, url: string }>}
 */
export async function serveMapZero(options) {
  const app = await createMapZeroServer(options);
  await app.listen({
    host: options.host,
    port: options.port
  });

  const url = `http://${options.host}:${options.port}`;
  if (options.open) {
    openBrowser(url);
  }

  return {
    app,
    url
  };
}

/**
 * Serve one MVT tile through cache and in-flight request coalescing.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {{
 *   cacheKey: string,
 *   cacheLabel: string,
 *   z: string,
 *   x: string,
 *   y: string,
 *   detail: string,
 *   tileCache: TileCache | null,
 *   pendingTiles: Map<string, Promise<TileGenerationResult>>,
 *   debugTiles: boolean,
 *   generate: () => TileGenerationResult
 * }} options
 */
async function sendMvtTile(reply, options) {
  const startedAt = performance.now();
  const cached = /** @type {TileGenerationResult | undefined} */ (options.tileCache?.get(options.cacheKey));
  if (cached) {
    sendTileReply(reply, cached.buffer, 'hit');
    logTileTiming(options, 'hit', startedAt, cached);
    return;
  }

  const pending = options.pendingTiles.get(options.cacheKey);
  if (pending) {
    const result = await pending;
    sendTileReply(reply, result.buffer, 'hit');
    logTileTiming(options, 'hit', startedAt, result);
    return;
  }

  const promise = Promise.resolve().then(options.generate);
  options.pendingTiles.set(options.cacheKey, promise);

  try {
    const result = await promise;
    options.tileCache?.set(options.cacheKey, result);
    sendTileReply(reply, result.buffer, 'miss');
    logTileTiming(options, 'miss', startedAt, result);
  } finally {
    options.pendingTiles.delete(options.cacheKey);
  }
}

/**
 * @param {import('fastify').FastifyReply} reply
 * @param {Buffer} buffer
 * @param {'hit' | 'miss'} cacheStatus
 */
function sendTileReply(reply, buffer, cacheStatus) {
  reply
    .header('X-MapZero-Cache', cacheStatus)
    .type('application/vnd.mapbox-vector-tile')
    .send(buffer);
}

/**
 * Browser viewer assets are served directly from source files. Keep shared
 * shared module imports resolvable without requiring a workspace symlink.
 *
 * @param {string} source
 * @returns {string}
 */
function rewriteCoreModuleImports(source) {
  return source.replaceAll('../../core/src/', '/map-zero-core/');
}

/**
 * @param {{
 *   cacheLabel: string,
 *   z: string,
 *   x: string,
 *   y: string,
 *   detail: string,
 *   debugTiles: boolean
 * }} options
 * @param {'hit' | 'miss'} cacheStatus
 * @param {number} startedAt
 * @param {TileGenerationResult} result
 */
function logTileTiming(options, cacheStatus, startedAt, result) {
  if (!options.debugTiles) {
    return;
  }

  const durationMs = Math.max(0, performance.now() - startedAt);
  console.error(
    `tile ${options.cacheLabel} ${options.z}/${options.x}/${options.y} ` +
    `detail=${options.detail} cache=${cacheStatus} ` +
    `bbox=${formatBbox(result.bbox)} layerNames=${result.layerNames.join(',')} ` +
    `durationMs=${durationMs.toFixed(1)} originalFeatureCount=${result.originalFeatureCount} ` +
    `encodedFeatureCount=${result.encodedFeatureCount} droppedFeatureCount=${result.droppedFeatureCount} ` +
    `originalVertexCount=${result.originalVertexCount} simplifiedVertexCount=${result.simplifiedVertexCount} ` +
    `droppedSmallFeatures=${result.droppedSmallFeatures} simplificationTolerance=${result.simplificationTolerance.toFixed(6)} ` +
    `sizeBytes=${result.buffer.length} emptyReason=${result.emptyReason}`
  );
}

/**
 * @param {[number, number, number, number]} bbox
 * @returns {string}
 */
function formatBbox(bbox) {
  return bbox.map((value) => Number(value).toFixed(6)).join(',');
}

/**
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

/**
 * @param {string} packageDir
 * @param {Record<string, unknown>} manifest
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readDefaultStyle(packageDir, manifest) {
  const styles = /** @type {Record<string, unknown> | undefined} */ (manifest.styles);
  const defaultStylePath = styles?.default;
  if (typeof defaultStylePath !== 'string') {
    return null;
  }

  return readJsonFile(join(packageDir, defaultStylePath)).catch(() => null);
}

/**
 * @param {string} filePath
 * @param {string} label
 */
async function assertReadableFile(filePath, label) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`${label} file does not exist: ${filePath}`);
  }
}

/**
 * @param {Record<string, unknown>} manifest
 */
function validateManifest(manifest) {
  if (manifest.format !== 'mapzero') {
    throw new Error('manifest format must be mapzero');
  }

  if (!Array.isArray(manifest.layers)) {
    throw new Error('manifest must contain a layers array');
  }
}

/**
 * @param {string} name
 * @returns {string}
 */
function validateStyleName(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw httpError(400, 'invalid style name');
  }

  return name.endsWith('.json') ? name : `${name}.json`;
}

/**
 * @param {string | undefined} value
 * @returns {string[] | undefined}
 */
function parseTileLayerQuery(value) {
  if (!value) {
    return undefined;
  }

  if (value === '__none__') {
    return [];
  }

  const layers = value
    .split(',')
    .map((layer) => layer.trim())
    .filter(Boolean);

  if (layers.length === 0) {
    return undefined;
  }

  for (const layer of layers) {
    if (!/^[A-Za-z0-9_-]+$/.test(layer)) {
      throw httpError(400, 'invalid tile layer list');
    }
  }

  return [...new Set(layers)];
}

/**
 * @param {string[] | undefined} layerIds
 * @returns {string}
 */
function tileLayerLabel(layerIds) {
  if (!layerIds) {
    return '*';
  }

  if (layerIds.length === 0) {
    return '__none__';
  }

  return layerIds.join(',');
}

/**
 * @param {string} packageDir
 * @param {string} layerLabel
 * @param {string} z
 * @param {string} x
 * @param {string} y
 * @param {string} detail
 * @returns {string}
 */
function createTileCacheKey(packageDir, layerLabel, z, x, y, detail) {
  return `${packageDir}|${layerLabel}|${z}/${x}/${y}|${detail}`;
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function parseTileDetailQuery(value) {
  if (!value) {
    return undefined;
  }

  if (!/^(overview|normal|full)$/.test(value)) {
    throw httpError(400, 'invalid tile detail level');
  }

  return value;
}

/**
 * @param {string} zValue
 * @param {string | undefined} detail
 * @returns {string}
 */
function resolveTileDetail(zValue, detail) {
  if (detail) {
    return detail;
  }

  const z = Number(zValue);
  if (Number.isFinite(z) && z <= 11) {
    return 'overview';
  }

  if (Number.isFinite(z) && z <= 14) {
    return 'normal';
  }

  return 'full';
}

/**
 * @param {string} packageDir
 * @param {Record<string, unknown>} manifest
 * @returns {{ url: string, path: string } | null}
 */
function pmtilesArchivePath(packageDir, manifest) {
  const tiles = /** @type {{ format?: unknown, url?: unknown } | undefined} */ (manifest.tiles);
  if (tiles?.format !== 'pmtiles' || typeof tiles.url !== 'string') {
    return null;
  }

  const url = tiles.url.replace(/^\/+/, '');
  if (!/^[A-Za-z0-9._/-]+$/.test(url) || url.includes('..')) {
    return null;
  }

  return {
    url,
    path: join(packageDir, url)
  };
}

/**
 * @param {string} packageDir
 * @param {Record<string, unknown>} manifest
 * @returns {{ urlPrefix: string, pathPrefix: string } | null}
 */
function tiles3dBasePath(packageDir, manifest) {
  const tiles3d = /** @type {{ format?: unknown, url?: unknown } | undefined} */ (manifest.tiles3d);
  if (tiles3d?.format !== '3dtiles' || typeof tiles3d.url !== 'string') {
    return null;
  }

  const url = tiles3d.url.replace(/^\/+/, '');
  if (!/^[A-Za-z0-9._/-]+$/.test(url) || url.includes('..')) {
    return null;
  }

  const urlPrefix = dirname(url).replaceAll('\\', '/');
  if (!urlPrefix || urlPrefix === '.') {
    return null;
  }

  return {
    urlPrefix,
    pathPrefix: join(packageDir, urlPrefix)
  };
}

/**
 * @param {string} baseDir
 * @param {string} relativePath
 * @returns {string | null}
 */
function safeJoin(baseDir, relativePath) {
  if (!/^[A-Za-z0-9._/-]+$/.test(relativePath) || relativePath.includes('..')) {
    return null;
  }

  const base = resolve(baseDir);
  const filePath = resolve(baseDir, relativePath);
  return filePath.startsWith(`${base}/`) || filePath === base ? filePath : null;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function contentTypeFor3dTiles(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.json') {
    return 'application/json; charset=utf-8';
  }

  if (ext === '.b3dm') {
    return 'application/octet-stream';
  }

  if (ext === '.glb') {
    return 'model/gltf-binary';
  }

  return 'application/octet-stream';
}

/**
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {string} filePath
 * @param {string} contentType
 */
async function sendRangeFile(request, reply, filePath, contentType) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    reply.status(404).send({ error: 'file not found' });
    return;
  }

  if (contentType.startsWith('application/json')) {
    const content = await fs.readFile(filePath, 'utf8');
    reply
      .header('cache-control', 'no-store')
      .type(contentType)
      .send(content);
    return;
  }

  const range = request.headers.range;
  reply
    .header('cache-control', 'no-store')
    .type(contentType);

  if (typeof range !== 'string') {
    reply
      .header('accept-ranges', 'none')
      .header('content-length', stat.size)
      .send(await fs.readFile(filePath));
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    reply.status(416).header('content-range', `bytes */${stat.size}`).send();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
    reply.status(416).header('content-range', `bytes */${stat.size}`).send();
    return;
  }

  const boundedEnd = Math.min(end, stat.size - 1);
  reply
    .status(206)
    .header('content-range', `bytes ${start}-${boundedEnd}/${stat.size}`)
    .header('content-length', boundedEnd - start + 1)
    .send(await readFileRange(filePath, start, boundedEnd));
}

/**
 * @param {string} filePath
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Buffer>}
 */
async function readFileRange(filePath, start, end) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(end - start + 1);
    const result = await handle.read(buffer, 0, buffer.length, start);
    return result.bytesRead === buffer.length ? buffer : buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} url
 */
function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

/**
 * @param {number} statusCode
 * @param {string} message
 * @returns {Error & { statusCode: number }}
 */
function httpError(statusCode, message) {
  const error = /** @type {Error & { statusCode: number }} */ (new Error(message));
  error.statusCode = statusCode;
  return error;
}
