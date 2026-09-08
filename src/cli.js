#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { clearLine, cursorTo } from 'node:readline';

import { Command, InvalidArgumentError } from 'commander';

import { buildPackage } from './build.js';
import { export3dTiles } from './3dtiles/export.js';
import { exportPmtiles } from './export-pmtiles.js';
import { createPackageFromBbox } from './from-bbox.js';
import { LAYER_ALIASES, SUPPORTED_LAYERS } from './layers.js';
import { packageMapZero } from './package.js';
import { serveBboxBuilder } from './bbox-server.js';
import { serveMapZero } from './server.js';
import { availableStylePresets, availableStyleThemes, writePackageStyle } from './style-command.js';
import { parseBbox, parseLayerList } from './utils.js';

const program = new Command();

program
  .name('map-zero')
  .description('Build maps from OSM, export GeoPackage datasets to PMTiles, and serve offline vector map packages.')
  .version(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

program
  .command('build')
  .description('Build a .mapzero folder package from an OSM PBF source.')
  .argument('<source.osm.pbf>', 'OSM PBF source file')
  .option('--bbox <bbox>', 'optional minLon,minLat,maxLon,maxLat; defaults to the full PBF extent', parseBboxOption)
  .option('--layers <layers>', 'comma-separated logical layers; defaults to all supported layers', parseLayersOption)
  .option('--batch-size <count>', 'geometry build batch size', parsePositiveIntegerOption, 5000)
  .option('--keep-temp', 'keep the temporary SQLite build database')
  .option('--debug-build', 'show build memory usage in progress logs')
  .requiredOption('--out <output.mapzero>', 'output package folder')
  .action(async (source, options) => {
    const progress = createBuildProgressReporter();

    try {
      const result = await buildPackage({
        source,
        bbox: options.bbox,
        layers: options.layers ?? [...SUPPORTED_LAYERS],
        out: options.out,
        batchSize: options.batchSize,
        keepTemp: Boolean(options.keepTemp),
        debugBuild: Boolean(options.debugBuild),
        onProgress: progress.update
      });

      progress.finish();
      console.log(`Built ${result.outDir}`);
      for (const [layer, count] of Object.entries(result.counts)) {
        console.log(`  ${layer}: ${count}`);
      }
    } catch (error) {
      progress.finish();
      console.error(`map-zero: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command('from-bbox')
  .description('Download an OSM extract and build a complete map-zero package for a bbox.')
  .requiredOption('--bbox <bbox>', 'minLon,minLat,maxLon,maxLat', parseBboxOption)
  .requiredOption('--out <output.mapzero>', 'output package folder')
  .option('--layers <layers>', 'comma-separated logical layers; defaults to all supported layers', parseLayersOption)
  .option('--minzoom <zoom>', 'minimum PMTiles zoom to export', parseZoomOption, 8)
  .option('--maxzoom <zoom>', 'maximum PMTiles zoom to export', parseZoomOption, 16)
  .option('--workers <count>', 'parallel PMTiles tile generation workers', parsePositiveIntegerOption, 1)
  .option('--force-pmtiles', 'allow very large PMTiles exports')
  .option('--cache-dir <dir>', 'OSM extract cache directory; defaults to ~/.cache/map-zero/osm')
  .option('--provider-index-url <url>', 'Geofabrik-compatible index URL')
  .option('--force-download', 're-download the selected OSM extract even if cached')
  .option('--batch-size <count>', 'geometry build batch size', parsePositiveIntegerOption, 5000)
  .option('--keep-temp', 'keep the temporary SQLite build database')
  .option('--debug-build', 'show build memory usage in progress logs')
  .option('--no-pmtiles', 'skip PMTiles export')
  .option('--no-3dtiles', 'skip 3D Tiles export')
  .option('--no-zip', 'skip portable zip creation')
  .option('--include-gpkg', 'include data.gpkg in the portable zip')
  .action(async (options) => {
    const buildProgress = createBuildProgressReporter();
    try {
      const result = await createPackageFromBbox({
        bbox: options.bbox,
        out: options.out,
        layers: options.layers ?? [...SUPPORTED_LAYERS],
        minZoom: options.minzoom,
        maxZoom: options.maxzoom,
        workers: options.workers,
        forcePmtiles: Boolean(options.forcePmtiles),
        cacheDir: options.cacheDir,
        providerIndexUrl: options.providerIndexUrl,
        forceDownload: Boolean(options.forceDownload),
        batchSize: options.batchSize,
        keepTemp: Boolean(options.keepTemp),
        debugBuild: Boolean(options.debugBuild),
        pmtiles: options.pmtiles,
        tiles3d: options.tiles3d,
        zip: options.zip,
        includeGpkg: Boolean(options.includeGpkg),
        onStage(message) {
          console.log(message);
        },
        onBuildProgress: buildProgress.update,
        onPmtilesProgress: reportPmtilesProgress,
        on3dTilesProgress: report3dTilesProgress
      });
      buildProgress.finish();

      console.log(`Built ${result.outDir}`);
      for (const source of result.sources ?? [result.source]) {
        console.log(`  source: ${source.name} (${source.path})`);
      }
      for (const [layer, count] of Object.entries(result.counts)) {
        console.log(`  ${layer}: ${count}`);
      }
      if (result.pmtiles) {
        console.log(`  PMTiles: ${result.pmtiles.outPath} (${formatBytes(result.pmtiles.outputBytes)})`);
      }
      if (result.tiles3d) {
        console.log(`  3D Tiles: ${result.tiles3d.tilesetPath} (${formatBytes(result.tiles3d.outputBytes)})`);
      }
      if (result.zip) {
        console.log(`  ZIP: ${result.zip.outPath} (${formatBytes(result.zip.outputBytes)})`);
      }
    } catch (error) {
      buildProgress.finish();
      console.error(`map-zero: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command('pmtiles')
  .description('Export a .mapzero package to a static vector PMTiles archive.')
  .argument('<package.mapzero>', 'map-zero package folder')
  .option('--minzoom <zoom>', 'minimum zoom to export', parseZoomOption, 8)
  .option('--maxzoom <zoom>', 'maximum zoom to export', parseZoomOption, 16)
  .option('--workers <count>', 'parallel tile generation workers', parsePositiveIntegerOption, 1)
  .option('--force', 'allow very large tile count exports')
  .action(async (packageDir, options) => {
    try {
      const result = await exportPmtiles({
        packageDir,
        minZoom: options.minzoom,
        maxZoom: options.maxzoom,
        workers: options.workers,
        force: Boolean(options.force),
        onProgress: reportPmtilesProgress
      });

      console.log(`Exported ${result.outPath}`);
      console.log(`  zooms: ${result.minZoom}-${result.maxZoom}`);
      console.log(`  estimated tiles: ${result.estimatedTiles}`);
      console.log(`  written tiles: ${result.writtenTiles}`);
      console.log(`  skipped empty tiles: ${result.skippedEmptyTiles}`);
      console.log(`  size: ${formatBytes(result.outputBytes)}`);
    } catch (error) {
      console.error(`map-zero: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command('3dtiles')
  .description('Export Cesium 3D Tiles from a .mapzero package.')
  .argument('<package.mapzero>', 'map-zero package folder')
  .option('--out <dir>', 'output 3D Tiles folder; defaults to <package>/3dtiles')
  .option('--layers <layers>', 'comma-separated 3D layers; defaults to all manifest layers', parse3dTilesLayersOption)
  .option('--context-format <format>', 'context geometry: vector or mesh', 'vector')
  .option('--min-zoom <zoom>', 'minimum vector context zoom', parseNonNegativeIntegerOption)
  .option('--max-zoom <zoom>', 'maximum vector context zoom', parseNonNegativeIntegerOption)
  .option('--max-depth <count>', 'maximum spatial partition depth for 3D tiles', parseNonNegativeIntegerOption, 8)
  .option('--max-features <count>', 'maximum features per leaf tile before subdivision', parsePositiveIntegerOption, 1500)
  .option('--default-height <meters>', 'fallback building height in meters', parsePositiveNumberOption, 8)
  .action(async (packageDir, options) => {
    try {
      const result = await export3dTiles({
        packageDir,
        out: options.out,
        layers: options.layers,
        contextFormat: options.contextFormat,
        minZoom: options.minZoom,
        maxZoom: options.maxZoom,
        maxDepth: options.maxDepth,
        maxFeatures: options.maxFeatures,
        defaultHeight: options.defaultHeight,
        onProgress: report3dTilesProgress
      });

      console.log(`Exported ${result.tilesetPath}`);
      console.log(`  leaves: ${formatInteger(result.leafCount)}`);
      console.log(`  written tiles: ${formatInteger(result.writtenTiles)}`);
      console.log(`  skipped empty tiles: ${formatInteger(result.skippedTiles)}`);
      console.log(`  size: ${formatBytes(result.outputBytes)}`);
    } catch (error) {
      console.error(`map-zero: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command('style')
  .description('Rewrite package styles without rebuilding data.gpkg or tiles.pmtiles.')
  .argument('<package.mapzero>', 'map-zero package folder')
  .option('--preset <preset>', 'full style preset to write')
  .option('--theme <theme.json>', 'compact style theme file or bundled theme name')
  .option('--list-presets', 'list bundled full style presets')
  .option('--list-themes', 'list bundled compact style themes')
  .action(async (packageDir, options) => {
    try {
      if (options.listPresets) {
        console.log(availableStylePresets().join('\n'));
        return;
      }

      if (options.listThemes) {
        console.log(availableStyleThemes().join('\n'));
        return;
      }

      const result = await writePackageStyle({
        packageDir,
        preset: options.preset,
        theme: options.theme
      });
      console.log(`Wrote ${result.sourceType} ${result.name} style: ${result.stylePath}`);
      console.log(`Default style: ${result.styleUrl}`);
      console.log('data.gpkg and tiles.pmtiles were not modified.');
    } catch (error) {
      console.error(`map-zero: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command('package')
  .description('Create a portable zip with manifest, styles, PMTiles, and 3D Tiles.')
  .argument('<package.mapzero>', 'map-zero package folder')
  .option('--out <file.zip>', 'output zip path; defaults to <package>.zip')
  .option('--include-gpkg', 'include the source GeoPackage in the zip')
  .action(async (packageDir, options) => {
    try {
      const result = await packageMapZero({
        packageDir,
        out: options.out,
        includeGpkg: Boolean(options.includeGpkg)
      });

      console.log(`Packaged ${result.outPath}`);
      console.log(`  files: ${formatInteger(result.fileCount)}`);
      console.log(`  input size: ${formatBytes(result.inputBytes)}`);
      console.log(`  zip size: ${formatBytes(result.outputBytes)}`);
      console.log(`  data.gpkg: ${result.includedGpkg ? 'included' : 'excluded'}`);
    } catch (error) {
      console.error(`map-zero: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command('bbox-ui')
  .description('Open an OpenLayers bbox builder that can generate complete map-zero packages.')
  .option('--port <port>', 'HTTP port', parsePortOption, 8090)
  .option('--host <host>', 'HTTP host', '127.0.0.1')
  .option('--output-root <dir>', 'directory where generated .mapzero folders are written', process.cwd())
  .option('--cache-dir <dir>', 'OSM extract cache directory; defaults to ~/.cache/map-zero/osm')
  .option('--provider-index-url <url>', 'Geofabrik-compatible index URL')
  .action(async (options) => {
    try {
      const result = await serveBboxBuilder({
        host: options.host,
        port: options.port,
        outputRoot: options.outputRoot,
        cacheDir: options.cacheDir,
        providerIndexUrl: options.providerIndexUrl
      });

      console.log(`Serving bbox builder`);
      console.log(`Open ${result.url}`);
      console.log(`Output root: ${options.outputRoot}`);
    } catch (error) {
      console.error(`map-zero: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command('serve')
  .description('Serve a .mapzero package with a readonly HTTP API and OpenLayers viewer.')
  .argument('<package.mapzero>', 'map-zero package folder')
  .option('--port <port>', 'HTTP port', parsePortOption, 8080)
  .option('--host <host>', 'HTTP host', '127.0.0.1')
  .option('--open', 'open the viewer in the default browser')
  .option('--tile-cache-size <entries>', 'maximum in-memory generated MVT tile cache entries', parseTileCacheSizeOption, 500)
  .option('--tile-max-features <count>', 'maximum features to encode in one dynamic MVT tile', parseTileMaxFeaturesOption, 12000)
  .option('--no-tile-cache', 'disable the in-memory generated MVT tile cache')
  .option('--debug-tiles', 'log MVT tile cache and generation timings')
  .option('--debug-labels', 'log rejected generated label candidates')
  .action(async (packageDir, options) => {
    try {
      const result = await serveMapZero({
        packageDir,
        host: options.host,
        port: options.port,
        open: Boolean(options.open),
        tileCache: options.tileCache,
        tileCacheSize: options.tileCacheSize,
        tileMaxFeatures: options.tileMaxFeatures,
        debugTiles: Boolean(options.debugTiles),
        debugLabels: Boolean(options.debugLabels)
      });

      console.log(`Serving ${packageDir}`);
      console.log(`Open ${result.url}`);
    } catch (error) {
      console.error(`map-zero: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);

/**
 * @param {string} value
 * @returns {[number, number, number, number]}
 */
function parseBboxOption(value) {
  try {
    return parseBbox(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function parseLayersOption(value) {
  try {
    return parseLayerList(value, SUPPORTED_LAYERS, LAYER_ALIASES);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function parse3dTilesLayersOption(value) {
  try {
    return [...new Set(String(value).split(',').map(id => id.trim()).filter(Boolean))];
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {string} value
 * @returns {number}
 */
function parsePortOption(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('port must be an integer between 1 and 65535');
  }

  return port;
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseTileCacheSizeOption(value) {
  const entries = Number(value);
  if (!Number.isInteger(entries) || entries < 0) {
    throw new InvalidArgumentError('tile cache size must be a non-negative integer');
  }

  return entries;
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseTileMaxFeaturesOption(value) {
  return parsePositiveIntegerOption(value);
}

/**
 * @param {string} value
 * @returns {number}
 */
function parsePositiveIntegerOption(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new InvalidArgumentError('value must be a positive integer');
  }

  return count;
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseNonNegativeIntegerOption(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new InvalidArgumentError('value must be a non-negative integer');
  }

  return count;
}

/**
 * @param {string} value
 * @returns {number}
 */
function parsePositiveNumberOption(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) {
    throw new InvalidArgumentError('value must be a positive number');
  }

  return count;
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseZoomOption(value) {
  const zoom = Number(value);
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) {
    throw new InvalidArgumentError('zoom must be an integer between 0 and 22');
  }

  return zoom;
}

/**
 * @param {{
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
 *   outputBytes?: number
 * }} event
 */
function reportPmtilesProgress(event) {
  if (event.phase === 'estimate') {
    console.log(`Estimated tiles: ${formatInteger(event.tileCount ?? 0)}`);
    if (event.bbox) {
      console.log(`Coverage bbox: ${event.bbox.map((value) => formatCoordinate(value)).join(',')}`);
    }
    if (event.coverage) {
      console.log(
        `Coverage size: ${event.coverage.widthDegrees.toFixed(3)} x ${event.coverage.heightDegrees.toFixed(3)} degrees, ` +
        `~${formatInteger(Math.round(event.coverage.approximateAreaKm2))} km2`
      );
    }
    if (event.tilesByZoom?.length) {
      console.log('Estimated tiles by zoom:');
      for (const item of event.tilesByZoom) {
        console.log(`  z${item.zoom}: ${formatInteger(item.tileCount)}`);
      }
    }
    if (event.recommendation?.length) {
      console.log('Recommendation:');
      for (const line of event.recommendation) {
        console.log(`  - ${line}`);
      }
    }
    if (event.highEstimate) {
      console.log('Use --force only if this bbox and zoom range are intentional.');
    }
    return;
  }

  if (event.phase === 'zoom-progress') {
    console.log(
      `z${event.zoom}: ${formatInteger(event.completedTiles ?? 0)}/${formatInteger(event.totalTiles ?? event.tileCount ?? 0)} tiles, ` +
      `${formatNumber(event.tilesPerSecond ?? 0)} tiles/s, ` +
      `${formatInteger(event.writtenTiles ?? 0)} written, ${formatInteger(event.skippedEmptyTiles ?? 0)} empty, ` +
      `avg ${formatBytes(Math.round(event.averageTileSize ?? 0))}, ETA ${formatDuration(event.etaSeconds)}`
    );
    return;
  }

  if (event.phase === 'zoom') {
    console.log(
      `z${event.zoom}: ${formatInteger(event.tileCount ?? 0)} tiles, ` +
      `${formatInteger(event.writtenTiles ?? 0)} written, ${formatInteger(event.skippedEmptyTiles ?? 0)} empty, ` +
      `${formatNumber(event.tilesPerSecond ?? 0)} tiles/s, avg ${formatBytes(Math.round(event.averageTileSize ?? 0))}`
    );
    return;
  }

  if (event.phase === 'done') {
    console.log(`PMTiles size: ${formatBytes(event.outputBytes ?? 0)}`);
  }
}

/**
 * @param {{
 *   phase: 'estimate' | 'leaf' | 'zoom' | 'done',
 *   zoom?: number,
 *   candidates?: number,
 *   layerId?: string,
 *   leafIndex?: number,
 *   leafCount?: number,
 *   featureCount?: number,
 *   writtenTiles?: number,
 *   skippedTiles?: number,
 *   outputBytes?: number
 * }} event
 */
function report3dTilesProgress(event) {
  if (event.phase === 'zoom') {
    console.log(`3D vector context z${event.zoom}: ${formatInteger(event.candidates ?? 0)} candidate tiles`);
    return;
  }
  if (event.phase === 'estimate') {
    const layerId = event.layerId ? `${event.layerId}: ` : '';
    console.log(
      `3D Tiles plan: ${layerId}${formatInteger(event.leafCount ?? 0)} leaf tiles, ` +
      `${formatInteger(event.featureCount ?? 0)} features`
    );
    return;
  }

  if (event.phase === 'leaf') {
    const leafIndex = event.leafIndex ?? 0;
    const leafCount = event.leafCount ?? 0;
    if (leafIndex === leafCount || leafIndex % 10 === 0) {
      console.log(
        `3D Tiles: ${formatInteger(leafIndex)}/${formatInteger(leafCount)} leaves, ` +
        `${formatInteger(event.writtenTiles ?? 0)} written, ${formatInteger(event.skippedTiles ?? 0)} empty`
      );
    }
    return;
  }

  if (event.phase === 'done') {
    console.log(`3D Tiles size: ${formatBytes(event.outputBytes ?? 0)}`);
  }
}


/**
 * @param {number} value
 * @returns {string}
 */
function formatCoordinate(value) {
  return Number(value).toFixed(6).replace(/\.?0+$/, '');
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
  return Number(value).toFixed(value >= 100 ? 0 : 1);
}

/**
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) {
    return 'unknown';
  }

  const total = Math.max(0, Math.round(Number(seconds)));
  if (total < 60) {
    return `${total}s`;
  }

  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Create a small terminal progress renderer for long PBF builds.
 *
 * @returns {{ update: (event: {
 *   phase: 'stage' | 'progress' | 'summary',
 *   step: string,
 *   label?: string,
 *   message?: string,
 *   bytesRead?: number,
 *   totalBytes?: number,
 *   entities?: number,
 *   itemsDone?: number,
 *   totalItems?: number
 * }) => void, finish: () => void }}
 */
function createBuildProgressReporter() {
  const stream = process.stderr;
  const isInteractive = Boolean(stream.isTTY);
  const reportedBuckets = new Map();
  let hasActiveLine = false;
  let lastRenderAt = 0;

  return {
    update(event) {
      const text = formatProgressEvent(event);
      if (!text) {
        return;
      }

      if (event.phase === 'progress') {
        if (!isInteractive) {
          const bucket = progressBucket(event);
          const previousBucket = reportedBuckets.get(event.step);

          if (bucket !== null && bucket > 0 && bucket !== previousBucket) {
            reportedBuckets.set(event.step, bucket);
            stream.write(`${text}\n`);
          }

          return;
        }

        const now = Date.now();
        const isFinal = isCompleteProgress(event);
        if (!isFinal && now - lastRenderAt < 150) {
          return;
        }

        clearLine(stream, 0);
        cursorTo(stream, 0);
        stream.write(text);
        hasActiveLine = true;
        lastRenderAt = now;
        return;
      }

      if (hasActiveLine) {
        clearLine(stream, 0);
        cursorTo(stream, 0);
        hasActiveLine = false;
      }

      stream.write(`${text}\n`);
    },
    finish() {
      if (!hasActiveLine) {
        return;
      }

      clearLine(stream, 0);
      cursorTo(stream, 0);
      hasActiveLine = false;
    }
  };
}

/**
 * @param {{ bytesRead?: number, totalBytes?: number, itemsDone?: number, totalItems?: number }} event
 * @returns {number | null}
 */
function progressBucket(event) {
  const percent = progressPercent(event);
  if (percent === null) {
    return null;
  }

  return Math.min(100, Math.floor(percent / 25) * 25);
}

/**
 * @param {{
 *   phase: 'stage' | 'progress' | 'summary',
 *   step: string,
 *   label?: string,
 *   message?: string,
 *   bytesRead?: number,
 *   totalBytes?: number,
 *   entities?: number,
 *   itemsDone?: number,
 *   totalItems?: number
 * }} event
 * @returns {string}
 */
function formatProgressEvent(event) {
  if (event.phase === 'stage') {
    return `> ${event.message ?? event.label ?? event.step}`;
  }

  if (event.phase === 'summary') {
    return `> ${event.message ?? event.label ?? event.step}`;
  }

  const label = event.label ?? event.step;

  if (Number.isFinite(event.bytesRead) && Number.isFinite(event.totalBytes) && event.totalBytes > 0) {
    const percent = Math.min(100, Math.floor((Number(event.bytesRead) / Number(event.totalBytes)) * 100));
    const entities = Number.isFinite(event.entities) ? `, ${formatInteger(Number(event.entities))} entities` : '';
    return `${label}: ${percent}% (${formatBytes(Number(event.bytesRead))}/${formatBytes(Number(event.totalBytes))}${entities})`;
  }

  if (Number.isFinite(event.itemsDone) && Number.isFinite(event.totalItems) && event.totalItems > 0) {
    const percent = Math.min(100, Math.floor((Number(event.itemsDone) / Number(event.totalItems)) * 100));
    return `${label}: ${percent}% (${formatInteger(Number(event.itemsDone))}/${formatInteger(Number(event.totalItems))})`;
  }

  return label;
}

/**
 * @param {{ bytesRead?: number, totalBytes?: number, itemsDone?: number, totalItems?: number }} event
 * @returns {boolean}
 */
function isCompleteProgress(event) {
  if (Number.isFinite(event.bytesRead) && Number.isFinite(event.totalBytes)) {
    return Number(event.bytesRead) >= Number(event.totalBytes);
  }

  if (Number.isFinite(event.itemsDone) && Number.isFinite(event.totalItems)) {
    return Number(event.itemsDone) >= Number(event.totalItems);
  }

  return false;
}

/**
 * @param {{ bytesRead?: number, totalBytes?: number, itemsDone?: number, totalItems?: number }} event
 * @returns {number | null}
 */
function progressPercent(event) {
  if (Number.isFinite(event.bytesRead) && Number.isFinite(event.totalBytes) && Number(event.totalBytes) > 0) {
    return Math.min(100, Math.floor((Number(event.bytesRead) / Number(event.totalBytes)) * 100));
  }

  if (Number.isFinite(event.itemsDone) && Number.isFinite(event.totalItems) && Number(event.totalItems) > 0) {
    return Math.min(100, Math.floor((Number(event.itemsDone) / Number(event.totalItems)) * 100));
  }

  return null;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let current = value / 1024;
  for (const unit of units) {
    if (current < 1024 || unit === units.at(-1)) {
      return `${current.toFixed(current >= 100 ? 0 : 1)} ${unit}`;
    }
    current /= 1024;
  }

  return `${value} B`;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(value);
}
