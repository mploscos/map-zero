import { createWriteStream, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { availableParallelism } from 'node:os';
import { gzipSync } from 'node:zlib';
import { Compression } from 'pmtiles';
import { Worker } from 'node:worker_threads';
import { finished } from 'node:stream/promises';

import { openGeoPackageReader } from './gpkg-read.js';
import { resolveManifestLayers, isLayerInZoomRange } from './manifest.js';
import { detailForZoom, encodeMvtTileSetWithStats, tileToBbox } from './mvt.js';
import { tileIdForZxy, writePmtilesArchive } from './pmtiles.js';
import { createHiddenFilters } from './style-filters.js';
import { createSparseTilePlan } from './pmtiles-plan.js';

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
 *   prunedEmptyTiles?: number,
 *   visitedTiles?: number,
 *   sparsePlanCandidates?: number,
 *   planExcludedTiles?: number,
 *   outputBytes?: number,
 *   outputPath?: string
 * }) => void} ExportProgress
 *
 * @typedef {{
 *   entries: import('./pmtiles.js').PmtilesEntry[],
 *   tileDataOffset: number,
 *   writtenTiles: number,
 *   skippedEmptyTiles: number,
 *   prunedEmptyTiles: number
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
 *   pruneEmptyTiles?: boolean,
 *   tilePlanning?: 'rtree' | 'bbox',
 *   onProgress?: ExportProgress
 * }} options
 * @returns {Promise<{ outPath: string, minZoom: number, maxZoom: number, estimatedTiles: number, sparsePlanCandidates: number, planExcludedTiles: number, writtenTiles: number, skippedEmptyTiles: number, prunedEmptyTiles: number, visitedTiles: number, outputBytes: number, planning: object[] }>}
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
  const tilePlanning = options.tilePlanning ?? 'rtree';
  if (!['rtree', 'bbox'].includes(tilePlanning)) throw new Error('tilePlanning must be rtree or bbox');

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

  const reader = openGeoPackageReader({
    gpkgPath,
    manifest,
    hiddenFilters: createHiddenFilters(manifest, defaultStyle)
  });

  const tmpTileDataPath = `${outPath}.tiles-${process.pid}-${Date.now()}`;
  await fs.mkdir(dirname(outPath), { recursive: true });
  const tileDataStream = createWriteStream(tmpTileDataPath, { flags: 'w' });
  // Observe errors from creation through close, including writes that were
  // accepted into the buffer but have not reached disk. Resolve to an error
  // value so an early I/O failure cannot become an unhandled rejection.
  const streamCompletion = finished(tileDataStream).then(() => null, (error) => error);
  /** @type {import('./pmtiles.js').PmtilesEntry[]} */
  const entries = [];
  let tileDataOffset = 0;
  let writtenTiles = 0;
  let skippedEmptyTiles = 0;
  let prunedEmptyTiles = 0;
  let sparsePlanCandidates = 0;
  const planning = [];

  try {
    for (const [zoom, range] of rangesByZoom.entries()) {
      const started = performance.now();
      const plan = createSparseTilePlan(reader, zoom, range, tileRangeForBbox, { mode: tilePlanning });
      const { ranges: _ranges, ...summary } = plan;
      planning.push({ zoom, ...summary, durationMs: performance.now() - started });
      sparsePlanCandidates += plan.tileCount;
      if (sparsePlanCandidates > LARGE_EXPORT_TILE_LIMIT && !options.force) {
        throw new Error(`PMTiles plan would generate over ${formatInteger(LARGE_EXPORT_TILE_LIMIT)} tiles; use --force to proceed`);
      }
      const exportZoom = workers <= 1 ? exportZoomSequential : exportZoomParallel;
      const result = await exportZoom({
        reader, packageDir, gpkgPath, manifest, defaultStyle, zoom, range, plan,
        tileDataStream, tileDataOffset, workers, onProgress: options.onProgress,
        pruneEmptyTiles: options.pruneEmptyTiles ?? true
      });
      for (const entry of result.entries) entries.push(entry);
      tileDataOffset = result.tileDataOffset;
      writtenTiles += result.writtenTiles;
      skippedEmptyTiles += result.skippedEmptyTiles;
      prunedEmptyTiles += result.prunedEmptyTiles;
    }

    tileDataStream.end();
    const streamError = await streamCompletion;
    if (streamError) throw streamError;
  } catch (error) {
    tileDataStream.destroy();
    await streamCompletion;
    await fs.rm(tmpTileDataPath, { force: true });
    throw error;
  } finally {
    reader.close();
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
    tileCompression: Compression.Gzip,
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
    prunedEmptyTiles,
    sparsePlanCandidates,
    planExcludedTiles: estimatedTiles - sparsePlanCandidates,
    visitedTiles: sparsePlanCandidates - prunedEmptyTiles,
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
    prunedEmptyTiles,
    sparsePlanCandidates,
    planExcludedTiles: estimatedTiles - sparsePlanCandidates,
    visitedTiles: sparsePlanCandidates - prunedEmptyTiles,
    planning,
    outputBytes: archive.bytes
  };
}

/**
 * @param {{
 *   reader: ReturnType<typeof openGeoPackageReader>,
 *   pruneEmptyTiles: boolean,
 *   manifest: Record<string, unknown>,
 *   defaultStyle: Record<string, unknown> | null,
 *   zoom: number,
 *   range: TileRange,
 *   plan: ReturnType<typeof createSparseTilePlan>,
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
  let skippedEmptyTiles = options.range.tileCount - options.plan.tileCount;
  let prunedEmptyTiles = 0;
  let tileBytes = 0;

  const tasks = tileTasksWithCoverage(options, (count) => {
    prunedEmptyTiles += count;
    skippedEmptyTiles += count;
    progress.update({ writtenTiles, skippedEmptyTiles, tileBytes });
  });
  for (const task of tasks) {
    const result = encodeMvtTileSetWithStats(options.reader, options.zoom, task.x, task.y, layerIds, {
      detail,
      style: options.defaultStyle
    });

    if (result.encodedFeatureCount === 0) {
      skippedEmptyTiles += 1;
      progress.update({ writtenTiles, skippedEmptyTiles, tileBytes });
      continue;
    }

    const buffer = gzipSync(result.buffer, { level: 1 });
    await writeStreamChunk(options.tileDataStream, buffer);
    entries.push({
      tileId: task.tileId,
      offset: tileDataOffset,
      length: buffer.length,
      runLength: 1
    });
    tileDataOffset += buffer.length;
    writtenTiles += 1;
    tileBytes += buffer.length;
    progress.update({ writtenTiles, skippedEmptyTiles, tileBytes });
  }

  progress.finish({ writtenTiles, skippedEmptyTiles, tileBytes });
  return {
    entries,
    tileDataOffset,
    writtenTiles,
    skippedEmptyTiles,
    prunedEmptyTiles
  };
}

/**
 * @param {{
 *   packageDir: string,
 *   reader: ReturnType<typeof openGeoPackageReader>,
 *   pruneEmptyTiles: boolean,
 *   gpkgPath: string,
 *   manifest: Record<string, unknown>,
 *   defaultStyle: Record<string, unknown> | null,
 *   zoom: number,
 *   range: TileRange,
 *   plan: ReturnType<typeof createSparseTilePlan>,
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
  /** @type {import('./pmtiles.js').PmtilesEntry[]} */
  const entries = [];
  const workerCount = Math.min(options.workers, Math.max(1, options.range.tileCount));
  const workers = [];
  let tileDataOffset = options.tileDataOffset;
  let writtenTiles = 0;
  let skippedEmptyTiles = options.range.tileCount - options.plan.tileCount;
  let prunedEmptyTiles = 0;
  let tileBytes = 0;
  const iterator = tileTasksWithCoverage(options, (count) => {
    prunedEmptyTiles += count;
    skippedEmptyTiles += count;
    progress.update({ writtenTiles, skippedEmptyTiles, tileBytes });
  });
  let activeJobs = 0;
  let nextJobId = 0;
  let closedWorkers = 0;
  let closing = false;
  let failed = false;
  let writeChain = Promise.resolve();

  if (options.plan.tileCount === 0) {
    progress.finish({ writtenTiles, skippedEmptyTiles, tileBytes });
    return Promise.resolve({ entries, tileDataOffset, writtenTiles, skippedEmptyTiles, prunedEmptyTiles });
  }

  return new Promise((resolvePromise, rejectPromise) => {
    /**
     * @param {Error} error
     */
    const fail = (error) => {
      if (failed) return;
      failed = true;
      closing = true;
      // Stop producers and settle queued writes before the caller destroys
      // the stream or removes the temporary file. Keep the original failure.
      const stopped = workers.map((worker) => worker.terminate());
      Promise.allSettled([...stopped, writeChain]).then(() => rejectPromise(error));
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
        if (failed) return;
        if (message?.type === 'closed') {
          closedWorkers += 1;
          worker.terminate();
          if (closedWorkers === workers.length) {
            try {
              progress.finish({ writtenTiles, skippedEmptyTiles, tileBytes });
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            resolvePromise({
              entries,
              tileDataOffset,
              writtenTiles,
              skippedEmptyTiles,
              prunedEmptyTiles
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
            if (message.empty) {
              skippedEmptyTiles += 1;
            } else {
              const buffer = Buffer.from(message.buffer);
              await (writeChain = writeChain.then(async () => {
                if (failed) return;
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

            activeJobs -= 1;
            progress.update({ writtenTiles, skippedEmptyTiles, tileBytes });
            assign(worker);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
      worker.on('error', fail);
      worker.on('exit', (code) => {
        if (!closing) {
          fail(new Error(`PMTiles worker exited with code ${code}`));
        }
      });
    }

    try {
      for (const worker of workers) assign(worker);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
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
      completedTiles = counts.writtenTiles + counts.skippedEmptyTiles;
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
  resolveManifestLayers(manifest);
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
 * Recursively discard empty rectangles using RTree occupancy. Query all source
 * tables eligible at this zoom, including hidden/unrequested ones: this is a
 * conservative superset of the built-in policies' reads (aliases and labels
 * included). Missing indexes fall back to the old traversal/error behavior.
 * Blocks include a full neighboring tile beyond each edge, enclosing the MVT
 * query buffer. Small occupied blocks use the existing encoder unchanged.
 *
 * @param {{reader: ReturnType<typeof openGeoPackageReader>, zoom: number,
 *   range: TileRange, plan: ReturnType<typeof createSparseTilePlan>, pruneEmptyTiles: boolean}} options
 * @param {(count: number) => void} onPruned
 * @returns {Generator<{z: number, x: number, y: number, tileId: number}>}
 */
function* tileTasksWithCoverage(options, onPruned) {
  const { reader, zoom, range } = options;
  const layers = reader.getLayers();
  if (!options.pruneEmptyTiles || layers.some((layer) => !layer.exists || !layer.rtree)) {
    for (const block of options.plan.ranges) yield* tileTasksForRange(zoom, block);
    return;
  }
  const sources = layers.filter((layer) => isLayerInZoomRange(layer, zoom));
  const maxTile = 2 ** zoom - 1;

  /** @param {TileRange} block */
  function* visit(block) {
    const northWest = tileToBbox(zoom, Math.max(0, block.minX - 1), Math.max(0, block.minY - 1));
    const southEast = tileToBbox(zoom, Math.min(maxTile, block.maxX + 1), Math.min(maxTile, block.maxY + 1));
    const bounds = /** @type {[number, number, number, number]} */ ([northWest[0], southEast[1], southEast[2], northWest[3]]);
    if (!sources.some((layer) => reader.hasFeaturesInBbox(String(layer.id), bounds))) {
      onPruned(block.tileCount);
      return;
    }
    if (block.tileCount <= 16) {
      yield* tileTasksForRange(zoom, block);
      return;
    }
    const splitX = block.maxX - block.minX >= block.maxY - block.minY;
    const min = splitX ? 'minX' : 'minY';
    const max = splitX ? 'maxX' : 'maxY';
    const middle = Math.floor((block[min] + block[max]) / 2);
    const left = { ...block, [max]: middle };
    const right = { ...block, [min]: middle + 1 };
    for (const child of [left, right]) {
      child.tileCount = (child.maxX - child.minX + 1) * (child.maxY - child.minY + 1);
      yield* visit(child);
    }
  }
  for (const block of options.plan.ranges) yield* visit(block);
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
  const maxTile = 2 ** z - 1;
  const minX = clamp(lonToTileX(minLon, z) - 1, 0, maxTile);
  const maxX = clamp(lonToTileX(maxLon, z) + 1, 0, maxTile);
  const minY = clamp(latToTileY(maxLat, z) - 1, 0, maxTile);
  const maxY = clamp(latToTileY(minLat, z) + 1, 0, maxTile);
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
  const layers = resolveManifestLayers(manifest);
  const visualLayers = layers
    .filter((layer) => {
      if (!isLayerInZoomRange(layer, zoom)) return false;
      const rule = layerStyleRule(style, layer.id);
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
    .map((layer) => layer.id);

  return visualLayers;
}

/**
 * @param {Record<string, unknown> | null} style
 * @param {string} layerId
 * @returns {Record<string, unknown>}
 */
function layerStyleRule(style, layerId) {
  const styleLayers = /** @type {Record<string, unknown> | undefined} */ (style?.layers);
  const rule = /** @type {Record<string, unknown>} */ (styleLayers?.[layerId] ?? {});
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
  if (stream.errored) return Promise.reject(stream.errored);
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
 * @param {Record<string, unknown>} manifest
 * @param {Record<string, unknown> | null} style
 * @param {number} minZoom
 * @param {number} maxZoom
 * @param {[number, number, number, number]} bbox
 * @returns {Record<string, unknown>}
 */
function createPmtilesMetadata(manifest, style, minZoom, maxZoom, bbox) {
  const layers = resolveManifestLayers(manifest).filter((layer) =>
    (layer.minZoom ?? 0) <= maxZoom && (layer.maxZoom ?? Infinity) >= minZoom);
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
    'mapzero:layers': layers,
    vector_layers: layers.map((layer) => ({
      id: layer.id,
      fields: { ...fieldsForLayer(style, layer.id),
        ...Object.fromEntries(Object.values(layer.featureZoom ?? {}).map((name) => [name, 'Number'])) },
      ...(layer.minZoom === undefined ? {} : { minzoom: Math.max(minZoom, layer.minZoom) }),
      ...(layer.maxZoom === undefined ? {} : { maxzoom: Math.min(maxZoom, layer.maxZoom) })
    }))
  };
}

/**
 * @param {Record<string, unknown> | null} style
 * @param {string} layerId
 * @returns {Record<string, string>}
 */
function fieldsForLayer(style, layerId) {
  const fields = {
    id: 'String',
    name: 'String',
    layer: 'String',
    mapzero_geometry: 'String',
    mapzero_label_lon: 'Number',
    mapzero_label_lat: 'Number'
  };
  const byProperty = /** @type {Record<string, unknown> | undefined} */ (layerStyleRule(style, layerId).byProperty);
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
