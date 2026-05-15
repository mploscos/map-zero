import { createWriteStream, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import { openGeoPackageReader } from './gpkg-read.js';
import { detailForZoom, encodeMvtTileSetWithStats } from './mvt.js';
import { tileIdForZxy, writePmtilesArchive } from './pmtiles.js';
import { createHiddenFilters } from './style-filters.js';

const DEFAULT_MIN_ZOOM = 8;
const DEFAULT_MAX_ZOOM = 16;
const MAX_ZOOM = 22;
const LARGE_EXPORT_TILE_LIMIT = 100_000;
const VERY_LARGE_EXPORT_TILE_LIMIT = 500_000;
const WEB_MERCATOR_MAX_LAT = 85.05112878;

/**
 * @typedef {{ minX: number, minY: number, maxX: number, maxY: number, tileCount: number }} TileRange
 *
 * @typedef {(event: {
 *   phase: 'estimate' | 'zoom-progress' | 'zoom' | 'done',
 *   zoom?: number,
 *   tileCount?: number,
 *   tilesByZoom?: Array<{ zoom: number, tileCount: number }>,
 *   bbox?: [number, number, number, number],
 *   coverage?: { widthDegrees: number, heightDegrees: number, approximateAreaKm2: number },
 *   recommendation?: string[],
 *   highEstimate?: boolean,
 *   veryHighEstimate?: boolean,
 *   completedTiles?: number,
 *   totalTiles?: number,
 *   tilesPerSecond?: number,
 *   averageTileSize?: number,
 *   etaSeconds?: number | null,
 *   workers?: number,
 *   writtenTiles?: number,
 *   skippedEmptyTiles?: number,
 *   outputBytes?: number,
 *   outputPath?: string
 * }) => void} ExportProgress
 *
 * @typedef {{
 *   entries: import('./pmtiles.js').PmtilesEntry[],
 *   tileDataOffset: number,
 *   writtenTiles: number,
 *   skippedEmptyTiles: number
 * }} ZoomExportResult
 */

/**
 * Export a .mapzero package to a static vector PMTiles archive.
 *
 * @param {{
 *   packageDir: string,
 *   out?: string,
 *   minZoom?: number,
 *   maxZoom?: number,
 *   workers?: number,
 *   force?: boolean,
 *   onProgress?: ExportProgress
 * }} options
 * @returns {Promise<{ outPath: string, minZoom: number, maxZoom: number, estimatedTiles: number, writtenTiles: number, skippedEmptyTiles: number, outputBytes: number }>}
 */
export async function exportPmtiles(options) {
  const packageDir = resolve(options.packageDir);
  const manifestPath = join(packageDir, 'manifest.json');
  const manifest = await readJsonFile(manifestPath);
  validateManifest(manifest);

  const minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;
  const maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM;
  validateZoomRange(minZoom, maxZoom);
  const workers = normalizeWorkerCount(options.workers);

  const outPath = resolve(options.out ?? join(packageDir, 'tiles.pmtiles'));
  const manifestTileUrl = relativePackagePath(packageDir, outPath);
  const bbox = normalizeBbox(/** @type {unknown} */ (manifest.bbox));
  const defaultStyle = await readDefaultStyle(packageDir, manifest);
  const gpkgPath = join(packageDir, String(manifest.data ?? 'data.gpkg'));
  await assertReadableFile(gpkgPath, 'GeoPackage');

  const rangesByZoom = createTileRangesByZoom(bbox, minZoom, maxZoom);
  const estimate = createExportEstimate(rangesByZoom, bbox, minZoom, maxZoom);
  const estimatedTiles = estimate.tileCount;
  options.onProgress?.({
    phase: 'estimate',
    tileCount: estimatedTiles,
    tilesByZoom: estimate.tilesByZoom,
    bbox,
    coverage: estimate.coverage,
    recommendation: estimate.recommendation,
    highEstimate: estimate.highEstimate,
    veryHighEstimate: estimate.veryHighEstimate
  });

  if (estimatedTiles > LARGE_EXPORT_TILE_LIMIT && !options.force) {
    throw new Error(
      `PMTiles export would generate up to ${formatInteger(estimatedTiles)} tiles; use --force to proceed`
    );
  }

  const reader = openGeoPackageReader({
    gpkgPath,
    manifest,
    hiddenFilters: createHiddenFilters(manifest, defaultStyle)
  });

  const tmpTileDataPath = `${outPath}.tiles-${process.pid}-${Date.now()}`;
  await fs.mkdir(dirname(outPath), { recursive: true });
  const tileDataStream = createWriteStream(tmpTileDataPath, { flags: 'w' });
  /** @type {import('./pmtiles.js').PmtilesEntry[]} */
  const entries = [];
  let tileDataOffset = 0;
  let writtenTiles = 0;
  let skippedEmptyTiles = 0;

  try {
    if (workers <= 1) {
      for (const [zoom, range] of rangesByZoom.entries()) {
        const result = await exportZoomSequential({
          reader,
          manifest,
          defaultStyle,
          zoom,
          range,
          tileDataStream,
          tileDataOffset,
          onProgress: options.onProgress,
          workers
        });
        entries.push(...result.entries);
        tileDataOffset = result.tileDataOffset;
        writtenTiles += result.writtenTiles;
        skippedEmptyTiles += result.skippedEmptyTiles;
      }
    } else {
      reader.close();
      for (const [zoom, range] of rangesByZoom.entries()) {
        const result = await exportZoomParallel({
          packageDir,
          gpkgPath,
          manifest,
          defaultStyle,
          zoom,
          range,
          tileDataStream,
          tileDataOffset,
          workers,
          onProgress: options.onProgress
        });
        entries.push(...result.entries);
        tileDataOffset = result.tileDataOffset;
        writtenTiles += result.writtenTiles;
        skippedEmptyTiles += result.skippedEmptyTiles;
      }
    }

    await closeWriteStream(tileDataStream);
  } catch (error) {
    tileDataStream.destroy();
    throw error;
  } finally {
    try {
      reader.close();
    } catch {
      // Parallel exports close the setup reader before workers open their own readonly handles.
    }
  }

  if (entries.length === 0) {
    await fs.rm(tmpTileDataPath, { force: true });
    throw new Error('PMTiles export produced no non-empty tiles');
  }

  const metadata = createPmtilesMetadata(manifest, defaultStyle, minZoom, maxZoom, bbox);
  const archive = await writePmtilesArchive({
    outPath,
    tileDataPath: tmpTileDataPath,
    entries,
    metadata,
    minZoom,
    maxZoom,
    bbox,
    centerZoom: Math.min(Math.max(12, minZoom), maxZoom)
  });
  await fs.rm(tmpTileDataPath, { force: true });
  await updateManifestTiles(manifestPath, manifest, {
    url: manifestTileUrl,
    minZoom,
    maxZoom
  });

  options.onProgress?.({
    phase: 'done',
    writtenTiles,
    skippedEmptyTiles,
    outputBytes: archive.bytes,
    outputPath: outPath
  });

  return {
    outPath,
    minZoom,
    maxZoom,
    estimatedTiles,
    writtenTiles,
    skippedEmptyTiles,
    outputBytes: archive.bytes
  };
}

/**
 * @param {{
 *   reader: ReturnType<typeof openGeoPackageReader>,
 *   manifest: Record<string, unknown>,
 *   defaultStyle: Record<string, unknown> | null,
 *   zoom: number,
 *   range: TileRange,
 *   tileDataStream: import('node:fs').WriteStream,
 *   tileDataOffset: number,
 *   workers: number,
 *   onProgress?: ExportProgress
 * }} options
 * @returns {Promise<ZoomExportResult>}
 */
async function exportZoomSequential(options) {
  const layerIds = activeLayerIdsForZoom(options.manifest, options.defaultStyle, options.zoom);
  const detail = detailForZoom(options.zoom);
  const progress = createZoomProgress(options.zoom, options.range.tileCount, options.workers, options.onProgress);
  /** @type {import('./pmtiles.js').PmtilesEntry[]} */
  const entries = [];
  let tileDataOffset = options.tileDataOffset;
  let writtenTiles = 0;
  let skippedEmptyTiles = 0;
  let tileBytes = 0;

  for (const task of tileTasksForRange(options.zoom, options.range)) {
    const result = encodeMvtTileSetWithStats(options.reader, options.zoom, task.x, task.y, layerIds, {
      detail,
      style: options.defaultStyle
    });

    if (result.encodedFeatureCount === 0) {
      skippedEmptyTiles += 1;
      progress.update({ writtenTiles, skippedEmptyTiles, tileBytes });
      continue;
    }

    await writeStreamChunk(options.tileDataStream, result.buffer);
    entries.push({
      tileId: task.tileId,
      offset: tileDataOffset,
      length: result.buffer.length,
      runLength: 1
    });
    tileDataOffset += result.buffer.length;
    writtenTiles += 1;
    tileBytes += result.buffer.length;
    progress.update({ writtenTiles, skippedEmptyTiles, tileBytes });
  }

  progress.finish({ writtenTiles, skippedEmptyTiles, tileBytes });
  return {
    entries,
    tileDataOffset,
    writtenTiles,
    skippedEmptyTiles
  };
}

/**
 * @param {{
 *   packageDir: string,
 *   gpkgPath: string,
 *   manifest: Record<string, unknown>,
 *   defaultStyle: Record<string, unknown> | null,
 *   zoom: number,
 *   range: TileRange,
 *   tileDataStream: import('node:fs').WriteStream,
 *   tileDataOffset: number,
 *   workers: number,
 *   onProgress?: ExportProgress
 * }} options
 * @returns {Promise<ZoomExportResult>}
 */
function exportZoomParallel(options) {
  const layerIds = activeLayerIdsForZoom(options.manifest, options.defaultStyle, options.zoom);
  const detail = detailForZoom(options.zoom);
  const progress = createZoomProgress(options.zoom, options.range.tileCount, options.workers, options.onProgress);
  const iterator = tileTasksForRange(options.zoom, options.range);
  /** @type {import('./pmtiles.js').PmtilesEntry[]} */
  const entries = [];
  const workerCount = Math.min(options.workers, Math.max(1, options.range.tileCount));
  const workers = [];
  let tileDataOffset = options.tileDataOffset;
  let writtenTiles = 0;
  let skippedEmptyTiles = 0;
  let tileBytes = 0;
  let activeJobs = 0;
  let nextJobId = 0;
  let closedWorkers = 0;
  let closing = false;
  let writeChain = Promise.resolve();

  return new Promise((resolvePromise, rejectPromise) => {
    /**
     * @param {Error} error
     */
    const fail = (error) => {
      if (closing) {
        return;
      }
      closing = true;
      for (const worker of workers) {
        worker.terminate();
      }
      rejectPromise(error);
    };

    const maybeClose = () => {
      if (closing || activeJobs > 0) {
        return;
      }

      closing = true;
      for (const worker of workers) {
        worker.postMessage({ type: 'close' });
      }
    };

    /**
     * @param {Worker} worker
     */
    const assign = (worker) => {
      if (closing) {
        return;
      }

      const next = iterator.next();
      if (next.done) {
        maybeClose();
        return;
      }

      activeJobs += 1;
      worker.postMessage({
        id: nextJobId,
        z: options.zoom,
        x: next.value.x,
        y: next.value.y,
        tileId: next.value.tileId,
        layerIds,
        detail
      });
      nextJobId += 1;
    };

    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(new URL('./pmtiles-worker.js', import.meta.url), {
        workerData: {
          packageDir: options.packageDir,
          gpkgPath: options.gpkgPath,
          manifest: options.manifest,
          defaultStyle: options.defaultStyle
        }
      });
      workers.push(worker);

      worker.on('message', (message) => {
        if (message?.type === 'closed') {
          closedWorkers += 1;
          worker.terminate();
          if (closedWorkers === workers.length) {
            progress.finish({ writtenTiles, skippedEmptyTiles, tileBytes });
            resolvePromise({
              entries,
              tileDataOffset,
              writtenTiles,
              skippedEmptyTiles
            });
          }
          return;
        }

        if (message?.type === 'error') {
          fail(new Error(message.message || 'PMTiles worker failed'));
          return;
        }

        if (message?.type !== 'tile') {
          return;
        }

        (async () => {
          try {
            activeJobs -= 1;
            if (message.empty) {
              skippedEmptyTiles += 1;
            } else {
              const buffer = Buffer.from(message.buffer);
              await (writeChain = writeChain.then(async () => {
                await writeStreamChunk(options.tileDataStream, buffer);
                entries.push({
                  tileId: message.tileId,
                  offset: tileDataOffset,
                  length: buffer.length,
                  runLength: 1
                });
                tileDataOffset += buffer.length;
              }));
              writtenTiles += 1;
              tileBytes += buffer.length;
            }

            progress.update({ writtenTiles, skippedEmptyTiles, tileBytes });
            assign(worker);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
      worker.on('error', fail);
      worker.on('exit', (code) => {
        if (!closing && code !== 0) {
          fail(new Error(`PMTiles worker exited with code ${code}`));
        }
      });
    }

    for (const worker of workers) {
      assign(worker);
    }
  });
}

/**
 * @param {number} zoom
 * @param {number} totalTiles
 * @param {number} workers
 * @param {ExportProgress | undefined} onProgress
 * @returns {{ update: (counts: { writtenTiles: number, skippedEmptyTiles: number, tileBytes: number }) => void, finish: (counts: { writtenTiles: number, skippedEmptyTiles: number, tileBytes: number }) => void }}
 */
function createZoomProgress(zoom, totalTiles, workers, onProgress) {
  const startedAt = Date.now();
  let completedTiles = 0;
  let lastReportAt = 0;

  const eventFor = (counts) => {
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const tilesPerSecond = completedTiles / elapsedSeconds;
    const remainingTiles = Math.max(0, totalTiles - completedTiles);
    return {
      zoom,
      workers,
      completedTiles,
      totalTiles,
      tileCount: totalTiles,
      writtenTiles: counts.writtenTiles,
      skippedEmptyTiles: counts.skippedEmptyTiles,
      averageTileSize: counts.writtenTiles > 0 ? counts.tileBytes / counts.writtenTiles : 0,
      tilesPerSecond,
      etaSeconds: tilesPerSecond > 0 ? remainingTiles / tilesPerSecond : null
    };
  };

  return {
    update(counts) {
      completedTiles += 1;
      const now = Date.now();
      if (now - lastReportAt < 1000 && completedTiles < totalTiles) {
        return;
      }

      lastReportAt = now;
      onProgress?.({
        phase: 'zoom-progress',
        ...eventFor(counts)
      });
    },

    finish(counts) {
      completedTiles = totalTiles;
      onProgress?.({
        phase: 'zoom',
        ...eventFor(counts)
      });
    }
  };
}

/**
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
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
 * @param {number} minZoom
 * @param {number} maxZoom
 */
function validateZoomRange(minZoom, maxZoom) {
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom < 0 || maxZoom > MAX_ZOOM || minZoom > maxZoom) {
    throw new Error(`zoom range must use integers with 0 <= minzoom <= maxzoom <= ${MAX_ZOOM}`);
  }
}

/**
 * @param {number | undefined} value
 * @returns {number}
 */
function normalizeWorkerCount(value) {
  const requested = value ?? 1;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error('workers must be a positive integer');
  }

  return Math.min(requested, Math.max(1, availableParallelism()));
}

/**
 * @param {unknown} bbox
 * @returns {[number, number, number, number]}
 */
function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error('manifest bbox must be [minLon,minLat,maxLon,maxLat]');
  }

  const values = bbox.map(Number);
  if (values.some((value) => !Number.isFinite(value)) || values[0] >= values[2] || values[1] >= values[3]) {
    throw new Error('manifest bbox is invalid');
  }

  return /** @type {[number, number, number, number]} */ (values);
}

/**
 * @param {string} packageDir
 * @param {string} outPath
 * @returns {string}
 */
function relativePackagePath(packageDir, outPath) {
  const relativePath = relative(packageDir, outPath).split(sep).join('/');
  if (!relativePath || relativePath.startsWith('../') || relativePath === '..') {
    throw new Error('PMTiles output must be inside the .mapzero package folder');
  }

  return relativePath;
}

/**
 * @param {string} filePath
 * @param {string} label
 */
async function assertReadableFile(filePath, label) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`${label} file does not exist: ${filePath}`);
  }
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
 * @param {[number, number, number, number]} bbox
 * @param {number} minZoom
 * @param {number} maxZoom
 * @returns {Map<number, TileRange>}
 */
function createTileRangesByZoom(bbox, minZoom, maxZoom) {
  const rangesByZoom = new Map();
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const range = tileRangeForBbox(bbox, z);
    rangesByZoom.set(z, range);
  }

  return rangesByZoom;
}

/**
 * @param {number} z
 * @param {TileRange} range
 * @returns {Generator<{ z: number, x: number, y: number, tileId: number }>}
 */
function* tileTasksForRange(z, range) {
  for (let x = range.minX; x <= range.maxX; x += 1) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      yield {
        z,
        x,
        y,
        tileId: tileIdForZxy(z, x, y)
      };
    }
  }
}

/**
 * @param {Map<number, TileRange>} rangesByZoom
 * @param {[number, number, number, number]} bbox
 * @param {number} minZoom
 * @param {number} maxZoom
 * @returns {{
 *   tileCount: number,
 *   tilesByZoom: Array<{ zoom: number, tileCount: number }>,
 *   coverage: { widthDegrees: number, heightDegrees: number, approximateAreaKm2: number },
 *   recommendation: string[],
 *   highEstimate: boolean,
 *   veryHighEstimate: boolean
 * }}
 */
function createExportEstimate(rangesByZoom, bbox, minZoom, maxZoom) {
  const tilesByZoom = [...rangesByZoom.entries()].map(([zoom, range]) => ({
    zoom,
    tileCount: range.tileCount
  }));
  const tileCount = tilesByZoom.reduce((sum, item) => sum + item.tileCount, 0);
  const coverage = estimateCoverage(bbox);
  const regional = isRegionalCoverage(coverage);
  const highEstimate = tileCount > LARGE_EXPORT_TILE_LIMIT;
  const veryHighEstimate = tileCount > VERY_LARGE_EXPORT_TILE_LIMIT;
  const recommendation = createExportRecommendation({
    minZoom,
    maxZoom,
    tileCount,
    coverage,
    regional,
    highEstimate,
    veryHighEstimate
  });

  return {
    tileCount,
    tilesByZoom,
    coverage,
    recommendation,
    highEstimate,
    veryHighEstimate
  };
}

/**
 * @param {[number, number, number, number]} bbox
 * @returns {{ widthDegrees: number, heightDegrees: number, approximateAreaKm2: number }}
 */
function estimateCoverage(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const widthDegrees = maxLon - minLon;
  const heightDegrees = maxLat - minLat;
  const meanLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180;
  const widthKm = Math.max(0, widthDegrees) * 111.32 * Math.max(0.01, Math.cos(meanLatRad));
  const heightKm = Math.max(0, heightDegrees) * 110.57;
  return {
    widthDegrees,
    heightDegrees,
    approximateAreaKm2: widthKm * heightKm
  };
}

/**
 * @param {{ approximateAreaKm2: number, widthDegrees: number, heightDegrees: number }} coverage
 * @returns {boolean}
 */
function isRegionalCoverage(coverage) {
  return coverage.approximateAreaKm2 >= 2_500
    || coverage.widthDegrees >= 1.5
    || coverage.heightDegrees >= 1.5;
}

/**
 * @param {{
 *   minZoom: number,
 *   maxZoom: number,
 *   tileCount: number,
 *   coverage: { approximateAreaKm2: number },
 *   regional: boolean,
 *   highEstimate: boolean,
 *   veryHighEstimate: boolean
 * }} options
 * @returns {string[]}
 */
function createExportRecommendation(options) {
  const recommendation = [];

  if (options.regional) {
    recommendation.push('Large regional exports are usually practical up to z12-z13.');
    if (options.maxZoom > 13) {
      recommendation.push('Use separate city exports for z14+ instead of one high-zoom regional archive.');
    }
  } else {
    recommendation.push('City-scale exports are usually practical at z14-z16.');
  }

  if (options.highEstimate) {
    recommendation.push('The estimated tile count is high; reduce --maxzoom, tighten the package bbox, or split the export.');
  }

  if (options.veryHighEstimate) {
    recommendation.push('This export is very large and may take a long time even with empty tiles skipped.');
  }

  if (options.maxZoom >= 15 && options.coverage.approximateAreaKm2 > 2_500) {
    recommendation.push('For region-scale PMTiles, export overview tiles first, then create separate city packages for detailed zooms.');
  }

  if (options.minZoom > 8) {
    recommendation.push('Consider keeping z8-z10 for smooth overview navigation if the package is meant for browsing.');
  }

  return recommendation;
}

/**
 * @param {[number, number, number, number]} bbox
 * @param {number} z
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
function tileRangeForBbox(bbox, z) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const minX = lonToTileX(minLon, z);
  const maxX = lonToTileX(maxLon, z);
  const minY = latToTileY(maxLat, z);
  const maxY = latToTileY(minLat, z);
  return {
    minX,
    maxX,
    minY,
    maxY,
    tileCount: Math.max(0, maxX - minX + 1) * Math.max(0, maxY - minY + 1)
  };
}

/**
 * @param {number} lon
 * @param {number} z
 * @returns {number}
 */
function lonToTileX(lon, z) {
  const n = 2 ** z;
  return clamp(Math.floor(((lon + 180) / 360) * n), 0, n - 1);
}

/**
 * @param {number} lat
 * @param {number} z
 * @returns {number}
 */
function latToTileY(lat, z) {
  const n = 2 ** z;
  const clampedLat = clamp(lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const latRad = (clampedLat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return clamp(Math.floor(y), 0, n - 1);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {Record<string, unknown> | null} style
 * @param {number} zoom
 * @returns {string[]}
 */
function activeLayerIdsForZoom(manifest, style, zoom) {
  const layers = /** @type {Array<Record<string, unknown>>} */ (manifest.layers ?? []);
  const visualLayers = layers
    .filter((layer) => {
      const rule = layerStyleRule(style, layer);
      if (rule.visible === false) {
        return false;
      }

      if (Number.isFinite(rule.minZoom) && zoom < Number(rule.minZoom)) {
        return false;
      }

      if (Number.isFinite(rule.maxZoom) && zoom > Number(rule.maxZoom)) {
        return false;
      }

      return true;
    })
    .map((layer) => String(layer.id));

  return visualLayers;
}

/**
 * @param {Record<string, unknown> | null} style
 * @param {Record<string, unknown>} layer
 * @returns {Record<string, unknown>}
 */
function layerStyleRule(style, layer) {
  const styleLayers = /** @type {Record<string, unknown> | undefined} */ (style?.layers);
  const rule = /** @type {Record<string, unknown>} */ (styleLayers?.[String(layer.style ?? layer.id)] ?? {});
  const visibility = rule.visibility && typeof rule.visibility === 'object'
    ? /** @type {Record<string, unknown>} */ (rule.visibility)
    : null;

  return visibility
    ? {
        ...rule,
        visible: visibility.visible ?? rule.visible,
        minZoom: visibility.minZoom ?? rule.minZoom,
        maxZoom: visibility.maxZoom ?? rule.maxZoom
      }
    : rule;
}

/**
 * @param {import('node:fs').WriteStream} stream
 * @param {Buffer} chunk
 * @returns {Promise<void>}
 */
function writeStreamChunk(stream, chunk) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (stream.write(chunk)) {
      resolvePromise();
      return;
    }

    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };

    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

/**
 * @param {import('node:fs').WriteStream} stream
 * @returns {Promise<void>}
 */
function closeWriteStream(stream) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.end(resolvePromise);
    stream.once('error', rejectPromise);
  });
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {Record<string, unknown> | null} style
 * @param {number} minZoom
 * @param {number} maxZoom
 * @param {[number, number, number, number]} bbox
 * @returns {Record<string, unknown>}
 */
function createPmtilesMetadata(manifest, style, minZoom, maxZoom, bbox) {
  const layers = /** @type {Array<Record<string, unknown>>} */ (manifest.layers ?? []);
  return {
    tilejson: '3.0.0',
    name: manifest.name ?? 'map-zero',
    version: String(manifest.version ?? 1),
    scheme: 'xyz',
    type: 'overlay',
    format: 'pbf',
    bounds: bbox,
    center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, Math.min(Math.max(12, minZoom), maxZoom)],
    minzoom: minZoom,
    maxzoom: maxZoom,
    vector_layers: layers.map((layer) => ({
      id: String(layer.id),
      fields: fieldsForLayer(style, layer)
    }))
  };
}

/**
 * @param {Record<string, unknown> | null} style
 * @param {Record<string, unknown>} layer
 * @returns {Record<string, string>}
 */
function fieldsForLayer(style, layer) {
  const fields = {
    id: 'String',
    name: 'String',
    layer: 'String'
  };
  const byProperty = /** @type {Record<string, unknown> | undefined} */ (layerStyleRule(style, layer).byProperty);
  if (byProperty) {
    for (const key of Object.keys(byProperty)) {
      fields[key] = 'String';
    }
  }

  return fields;
}

/**
 * @param {string} manifestPath
 * @param {Record<string, unknown>} manifest
 * @param {{ url: string, minZoom: number, maxZoom: number }} tiles
 */
async function updateManifestTiles(manifestPath, manifest, tiles) {
  const updated = {
    ...manifest,
    tiles: {
      format: 'pmtiles',
      url: tiles.url,
      minZoom: tiles.minZoom,
      maxZoom: tiles.maxZoom,
      type: 'mvt'
    }
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
}
