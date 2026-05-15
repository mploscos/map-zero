import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';

import { createManifest } from './manifest.js';
import { normalizeLayerId } from './layers.js';
import { buildOsmGeoPackage, inferOsmBbox } from './osm.js';
import { createNeonDarkStyle } from './style.js';

/**
 * Build a .mapzero package folder from an OSM PBF source.
 *
 * @param {{
 *   source: string,
 *   bbox?: [number, number, number, number],
 *   layers: string[],
 *   out: string,
 *   keepTemp?: boolean,
 *   batchSize?: number,
 *   debugBuild?: boolean,
 *   onProgress?: (event: {
 *     phase: 'stage' | 'progress' | 'summary',
 *     step: string,
 *     label?: string,
 *     message?: string,
 *     bytesRead?: number,
 *     totalBytes?: number,
 *     entities?: number,
 *     itemsDone?: number,
 *     totalItems?: number
 *   }) => void
 * }} options
 * @returns {Promise<{ outDir: string, counts: Record<string, number> }>}
 */
export async function buildPackage(options) {
  const source = resolve(options.source);
  const outDir = resolve(options.out);
  const stylesDir = join(outDir, 'styles');
  const gpkgPath = join(outDir, 'data.gpkg');
  const layers = [...new Set(options.layers.map(normalizeLayerId))];

  options.onProgress?.({
    phase: 'stage',
    step: 'validate',
    message: 'Validating input and preparing output folder'
  });
  const sourceStat = await assertReadableFile(source);
  await fs.mkdir(stylesDir, { recursive: true });

  const bbox = options.bbox ?? await inferOsmBbox(source, {
    totalBytes: sourceStat.size,
    onProgress: options.onProgress
  });

  options.onProgress?.({
    phase: 'stage',
    step: 'write-gpkg',
    message: 'Writing GeoPackage'
  });
  const buildResult = await buildOsmGeoPackage(source, bbox, layers, gpkgPath, {
    totalBytes: sourceStat.size,
    batchSize: options.batchSize,
    keepTemp: options.keepTemp,
    tempPath: join(outDir, '.mapzero-build-tmp.sqlite'),
    debugBuild: options.debugBuild,
    onProgress: options.onProgress
  });

  options.onProgress?.({
    phase: 'stage',
    step: 'write-manifest',
    message: 'Writing manifest and style'
  });
  await fs.writeFile(
    join(outDir, 'manifest.json'),
    `${JSON.stringify(createManifest({ outDir, bbox, layers }), null, 2)}\n`
  );

  await fs.writeFile(
    join(stylesDir, 'neon-dark.json'),
    `${JSON.stringify(createNeonDarkStyle(layers), null, 2)}\n`
  );

  return {
    outDir,
    counts: buildResult.counts
  };
}

/**
 * @param {string} filePath
 * @returns {Promise<import('node:fs').Stats>}
 */
async function assertReadableFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);

  if (!stat || !stat.isFile()) {
    throw new Error(`source file does not exist: ${filePath}`);
  }

  await assertOsmPbfFile(filePath, stat);

  return stat;
}

/**
 * @param {string} filePath
 * @param {import('node:fs').Stats} stat
 * @returns {Promise<void>}
 */
async function assertOsmPbfFile(filePath, stat) {
  if (stat.size < 16) {
    throw new Error(`source file is too small to be an OSM PBF: ${filePath}`);
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(1024, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    const textPrefix = header.toString('utf8', 0, Math.min(bytesRead, 128)).trimStart().toLowerCase();

    if (textPrefix.startsWith('<!doctype html') || textPrefix.startsWith('<html')) {
      throw new Error(
        `source file is HTML, not an OSM PBF: ${filePath}. Check the download URL and re-download with a .osm.pbf URL`
      );
    }

    if (!header.includes(Buffer.from('OSMHeader'))) {
      throw new Error(`source file does not look like an OSM PBF: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}
