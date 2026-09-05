import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { buildB3dm } from './b3dm.js';
import { buildClipperLineSurfaceMesh } from './clipper-surfaces.js';
import { buildMergedExtrudedPolygonMesh } from './extrude.js';
import { buildFlatLayerMesh, buildPolygonSurfaceMesh } from './flat.js';
import { buildGlbFromMesh } from './glb.js';
import {
  countLayerFeatures,
  readLayerFeatures,
  readLayerMetadata
} from './gpkg-features.js';
import {
  countBuildings,
  openReadonlyGeoPackage,
  readBuildingFootprints,
  readBuildingsMetadata
} from './gpkg-buildings.js';
import { buildContentNode, buildTileset } from './tileset.js';

/**
 * Orchestrates conversion from a .mapzero package into static Cesium 3D Tiles.
 *
 * The exporter reads GeoPackage data, subdivides each layer into manageable
 * geographic leaves, builds layer-specific meshes, wraps those meshes as GLB
 * and b3dm files, then updates manifest.json with Cesium metadata.
 */

const DEFAULT_BUILDING_HEIGHT = 9;
const DEFAULT_MAX_FEATURES = 2500;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_3D_LAYERS = ['buildings'];
const SUPPORTED_3D_LAYERS = ['buildings', 'landuse', 'water', 'aip', 'railways', 'roads', 'boundaries'];
const LAYER_ALIASES = {
  aviation: 'aip'
};

/**
 * Export extruded buildings from a map-zero package to Cesium 3D Tiles.
 *
 * @param {{
 *   packageDir: string,
 *   out?: string,
 *   layers?: string[],
 *   maxDepth?: number,
 *   maxFeatures?: number,
 *   defaultHeight?: number,
 *   onProgress?: (event: {
 *     phase: 'estimate' | 'leaf' | 'done',
 *     layerId?: string,
 *     leafIndex?: number,
 *     leafCount?: number,
 *     featureCount?: number,
 *     writtenTiles?: number,
 *     skippedTiles?: number,
 *     outputBytes?: number
 *   }) => void
 * }} options
 * @returns {Promise<{
 *   outDir: string,
 *   tilesetPath: string,
 *   leafCount: number,
 *   writtenTiles: number,
 *   skippedTiles: number,
 *   outputBytes: number
 * }>}
 */
export async function export3dTiles(options) {
  const layers = normalizeLayers(options.layers);
  const packageDir = resolve(options.packageDir);
  const manifestPath = join(packageDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const gpkgPath = join(packageDir, String(manifest.data ?? 'data.gpkg'));
  const outRoot = resolve(options.out ?? join(packageDir, '3dtiles'));
  const defaultHeight = positiveNumber(options.defaultHeight, DEFAULT_BUILDING_HEIGHT);
  const maxFeatures = positiveInteger(options.maxFeatures, DEFAULT_MAX_FEATURES);
  const maxDepth = nonNegativeInteger(options.maxDepth, DEFAULT_MAX_DEPTH);

  validateManifest(manifest);
  await fs.rm(outRoot, { recursive: true, force: true });
  await fs.mkdir(outRoot, { recursive: true });
  const style = await readDefaultStyle(packageDir, manifest);

  const db = openReadonlyGeoPackage(gpkgPath);
  try {
    const exportedTilesets = {};
    let totalLeaves = 0;
    let writtenTiles = 0;
    let skippedTiles = 0;
    let outputBytes = 0;

    for (const layerId of layers) {
      const result = layerId === 'buildings'
        ? await exportBuildingLayer(db, manifest, outRoot, {
            defaultHeight,
            maxFeatures,
            maxDepth,
            style,
            onProgress: options.onProgress,
            progressOffset: totalLeaves,
            writtenTiles,
            skippedTiles
          })
        : layerId === 'roads'
          ? await exportRoadLayer(db, manifest, outRoot, {
              maxFeatures,
              maxDepth,
              style,
              onProgress: options.onProgress,
              progressOffset: totalLeaves,
              writtenTiles,
              skippedTiles
            })
        : layerId === 'boundaries' || isAipLayer(layerId)
          ? await exportMixedSurfaceLayer(db, manifest, outRoot, layerId, {
              maxFeatures,
              maxDepth,
              style,
              onProgress: options.onProgress,
              progressOffset: totalLeaves,
              writtenTiles,
              skippedTiles
            })
        : layerId === 'railways'
          ? await exportLineSurfaceLayer(db, manifest, outRoot, layerId, {
              maxFeatures,
              maxDepth,
              style,
              onProgress: options.onProgress,
              progressOffset: totalLeaves,
              writtenTiles,
              skippedTiles
            })
        : await exportFlatLayer(db, manifest, outRoot, layerId, {
            maxFeatures,
            maxDepth,
            style,
            onProgress: options.onProgress,
            progressOffset: totalLeaves,
            writtenTiles,
            skippedTiles
          });

      if (!result) {
        continue;
      }

      exportedTilesets[layerId] = relative(packageDir, result.tilesetPath).replaceAll('\\', '/');
      totalLeaves += result.leafCount;
      writtenTiles += result.writtenTiles;
      skippedTiles += result.skippedTiles;
      outputBytes += result.outputBytes;
    }

    if (Object.keys(exportedTilesets).length === 0) {
      throw new Error('no 3D Tiles were generated');
    }

    await updateManifest3dTiles(manifestPath, manifest, exportedTilesets, /** @type {[number, number, number, number]} */ (manifest.bbox));
    options.onProgress?.({
      phase: 'done',
      leafCount: totalLeaves,
      writtenTiles,
      skippedTiles,
      outputBytes
    });

    return {
      outDir: outRoot,
      tilesetPath: join(outRoot, layers[0], 'tileset.json'),
      leafCount: totalLeaves,
      writtenTiles,
      skippedTiles,
      outputBytes
    };
  } finally {
    db.close();
  }
}

/**
 * Export extruded building footprints as the main 3D volume layer.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any>} manifest
 * @param {string} outRoot
 * @param {any} options
 * @returns {Promise<any>}
 */
async function exportBuildingLayer(db, manifest, outRoot, options) {
  const metadata = readBuildingsMetadata(db, /** @type {[number, number, number, number]} */ (manifest.bbox));
  const featureCount = countBuildings(db, metadata, metadata.bbox);
  const leaves = buildLeafPlan(db, metadata, metadata.bbox, {
    maxFeatures: options.maxFeatures,
    maxDepth: options.maxDepth,
    count: countBuildings
  });
  options.onProgress?.({ phase: 'estimate', layerId: 'buildings', leafCount: leaves.length, featureCount });

  const seenIds = new Set();
  return exportLayerTiles('buildings', metadata.bbox, leaves, outRoot, options.style, {
    readMesh: (leaf) => {
      const { footprints, skipped } = readBuildingFootprints(db, metadata, leaf.bbox, {
        defaultHeight: options.defaultHeight,
        seenIds
      });
      return {
        mesh: buildMergedExtrudedPolygonMesh(footprints),
        featureCount: footprints.length,
        skipped
      };
    }
  }, options);
}

/**
 * Export layers that may contain polygons, lines, and points as a pair of flat
 * surface meshes: polygon fill plus offset linework. AIP/aviation also converts
 * selected point features into small disks so they remain visible in 3D.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any>} manifest
 * @param {string} outRoot
 * @param {string} layerId
 * @param {any} options
 * @returns {Promise<any>}
 */
async function exportMixedSurfaceLayer(db, manifest, outRoot, layerId, options) {
  let metadata;
  try {
    metadata = readLayerMetadata(db, manifest, layerId);
  } catch (error) {
    console.warn(`3D Tiles: skipping ${layerId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const featureCount = countLayerFeatures(db, metadata, metadata.bbox);
  const leaves = buildLeafPlan(db, metadata, metadata.bbox, {
    maxFeatures: options.maxFeatures,
    maxDepth: options.maxDepth,
    count: countLayerFeatures
  });
  options.onProgress?.({ phase: 'estimate', layerId, leafCount: leaves.length, featureCount });

  const seenIds = new Set();
  return exportLayerTiles(layerId, metadata.bbox, leaves, outRoot, options.style, {
    readMeshes: async (leaf) => {
      const features = readLayerFeatures(db, metadata, leaf.bbox, {
        seenIds
      });
      const polygonFeatures = features.filter(hasPolygonGeometry);
      const pointFeatures = isAipLayer(layerId)
        ? pointDiskFeatures(features.filter(isVisibleAviationPointFeature), 14, 14)
        : [];
      const lineFeatures = features.filter(hasLineGeometry);
      const outlineFeatures = layerId === 'boundaries' || isAipLayer(layerId)
        ? polygonFeatures
        : [];
      const lines = linesFromFeatures([...lineFeatures, ...outlineFeatures]);
      const lineMesh = await buildClipperLineSurfaceMesh(lines, {
        widthMeters: lineWidthMeters(layerId, options.style),
        height: lineSurfaceHeight(layerId),
        scale: 100,
        arcToleranceMeters: isAipLayer(layerId) ? 0.35 : 0.25,
        cleanDistanceMeters: 0.05,
        minSegmentMeters: isAipLayer(layerId) ? 0.5 : 0.35
      });
      const polygonMesh = layerId === 'boundaries'
        ? null
        : buildPolygonSurfaceMesh([...polygonFeatures, ...pointFeatures], {
            height: polygonSurfaceHeight(layerId)
          });

      return {
        meshes: [
          { id: 'fill', mesh: polygonMesh, color: colorFactorForLayer(options.style, layerId) },
          { id: 'line', mesh: lineMesh, color: colorFactorForLayer(options.style, layerId) }
        ].filter((entry) => entry.mesh),
        featureCount: features.length,
        skipped: 0
      };
    }
  }, options);
}

/**
 * Export polygon/point-oriented layers with the generic flat mesh builder.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any>} manifest
 * @param {string} outRoot
 * @param {string} layerId
 * @param {any} options
 * @returns {Promise<any>}
 */
async function exportFlatLayer(db, manifest, outRoot, layerId, options) {
  let metadata;
  try {
    metadata = readLayerMetadata(db, manifest, layerId);
  } catch (error) {
    console.warn(`3D Tiles: skipping ${layerId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const featureCount = countLayerFeatures(db, metadata, metadata.bbox);
  const leaves = buildLeafPlan(db, metadata, metadata.bbox, {
    maxFeatures: options.maxFeatures,
    maxDepth: options.maxDepth,
    count: countLayerFeatures
  });
  options.onProgress?.({ phase: 'estimate', layerId, leafCount: leaves.length, featureCount });

  const seenIds = new Set();
  return exportLayerTiles(layerId, metadata.bbox, leaves, outRoot, options.style, {
    readMesh: (leaf) => {
      const features = readLayerFeatures(db, metadata, leaf.bbox, {
        seenIds
      });
      return {
        mesh: buildFlatLayerMesh(layerId, features, {
          lineWidthMeters: lineWidthMeters(layerId, options.style),
          height: polygonSurfaceHeight(layerId)
        }),
        featureCount: features.length,
        skipped: 0
      };
    }
  }, options);
}

/**
 * Export roads as dissolved offset surfaces rather than simple line ribbons.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any>} manifest
 * @param {string} outRoot
 * @param {any} options
 * @returns {Promise<any>}
 */
async function exportRoadLayer(db, manifest, outRoot, options) {
  let metadata;
  try {
    metadata = readLayerMetadata(db, manifest, 'roads');
  } catch (error) {
    console.warn(`3D Tiles: skipping roads: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const featureCount = countLayerFeatures(db, metadata, metadata.bbox);
  const leaves = buildLeafPlan(db, metadata, metadata.bbox, {
    maxFeatures: options.maxFeatures,
    maxDepth: options.maxDepth,
    count: countLayerFeatures
  });
  options.onProgress?.({ phase: 'estimate', layerId: 'roads', leafCount: leaves.length, featureCount });

  const seenIds = new Set();
  return exportLayerTiles('roads', metadata.bbox, leaves, outRoot, options.style, {
    readMeshes: async (leaf) => {
      const features = readLayerFeatures(db, metadata, leaf.bbox, {
        seenIds
      });
      const lines = linesFromFeatures(features);
      const bodyWidth = roadBodyWidthMeters(options.style);
      const body = await buildClipperLineSurfaceMesh(lines, {
        widthMeters: bodyWidth,
        height: lineSurfaceHeight('roads'),
        scale: 100,
        arcToleranceMeters: 0.45,
        cleanDistanceMeters: 0.05,
        minSegmentMeters: 0.75
      });

      return {
        meshes: [{ id: 'main', mesh: body, color: colorFactorForLayer(options.style, 'roads') }].filter((entry) => entry.mesh),
        featureCount: features.length,
        skipped: features.length - lines.length
      };
    }
  }, options);
}

/**
 * Export a line-only layer, currently railways, through the Clipper surface path.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any>} manifest
 * @param {string} outRoot
 * @param {string} layerId
 * @param {any} options
 * @returns {Promise<any>}
 */
async function exportLineSurfaceLayer(db, manifest, outRoot, layerId, options) {
  let metadata;
  try {
    metadata = readLayerMetadata(db, manifest, layerId);
  } catch (error) {
    console.warn(`3D Tiles: skipping ${layerId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const featureCount = countLayerFeatures(db, metadata, metadata.bbox);
  const leaves = buildLeafPlan(db, metadata, metadata.bbox, {
    maxFeatures: options.maxFeatures,
    maxDepth: options.maxDepth,
    count: countLayerFeatures
  });
  options.onProgress?.({ phase: 'estimate', layerId, leafCount: leaves.length, featureCount });

  const seenIds = new Set();
  return exportLayerTiles(layerId, metadata.bbox, leaves, outRoot, options.style, {
    readMeshes: async (leaf) => {
      const features = readLayerFeatures(db, metadata, leaf.bbox, {
        seenIds
      });
      const lines = linesFromFeatures(features);
      const mesh = await buildClipperLineSurfaceMesh(lines, {
        widthMeters: lineWidthMeters(layerId, options.style),
        height: lineSurfaceHeight(layerId),
        scale: 100,
        arcToleranceMeters: layerId === 'railways' ? 0.4 : 0.25,
        cleanDistanceMeters: 0.05,
        minSegmentMeters: layerId === 'railways' ? 0.5 : 0.35
      });

      return {
        meshes: [{ id: 'main', mesh, color: colorFactorForLayer(options.style, layerId) }].filter((entry) => entry.mesh),
        featureCount: features.length,
        skipped: features.length - lines.length
      };
    }
  }, options);
}

/**
 * Write all leaf meshes for one layer as b3dm files and assemble tileset.json.
 *
 * @param {string} layerId
 * @param {[number, number, number, number]} bbox
 * @param {Array<{ bbox: [number, number, number, number], count: number }>} leaves
 * @param {string} outRoot
 * @param {Record<string, any> | null} style
 * @param {{ readMesh?: Function, readMeshes?: Function }} source
 * @param {any} options
 * @returns {Promise<any>}
 */
async function exportLayerTiles(layerId, bbox, leaves, outRoot, style, source, options) {
  const outDir = join(outRoot, layerId);
  const tilesDir = join(outDir, 'tiles');
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(tilesDir, { recursive: true });

  const children = [];
  const tileBboxes = [];
  let writtenTiles = 0;
  let skippedTiles = 0;
  let outputBytes = 0;
  let maxHeight = layerId === 'buildings' ? options.defaultHeight : 1;

  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const result = source.readMeshes ? await source.readMeshes(leaf) : source.readMesh(leaf);
    const meshes = result.meshes ?? [{ id: 'main', mesh: result.mesh, color: colorFactorForLayer(style, layerId) }];
    const validMeshes = meshes.filter((entry) => entry.mesh);
    if (validMeshes.length === 0) {
      skippedTiles++;
      continue;
    }

    for (const entry of validMeshes) {
      const mesh = entry.mesh;
      const glb = buildGlbFromMesh(mesh, {
        color: entry.color ?? colorFactorForLayer(style, layerId),
        generator: `map-zero 3dtiles ${layerId}${entry.id ? ` ${entry.id}` : ''}`,
        ...glbOptionsForLayer(layerId)
      });
      const b3dm = buildB3dm(glb, { rtcCenter: mesh.rtcCenter });
      const tileName = entry.id === 'main'
        ? `tile-${writtenTiles}.b3dm`
        : `tile-${writtenTiles}-${entry.id}.b3dm`;
      await fs.writeFile(join(tilesDir, tileName), b3dm);
      outputBytes += b3dm.length;
      writtenTiles++;
      maxHeight = Math.max(maxHeight, mesh.maxHeight);
      tileBboxes.push(mesh.bbox);
      children.push(buildContentNode({
        bbox: mesh.bbox,
        maxHeight: mesh.maxHeight,
        uri: `tiles/${tileName}`
      }));
    }

    if (result.skipped > 0) {
      console.warn(`3D Tiles: skipped ${result.skipped} invalid ${layerId} geometries in leaf ${i + 1}`);
    }
    options.onProgress?.({
      phase: 'leaf',
      layerId,
      leafIndex: options.progressOffset + i + 1,
      leafCount: options.progressOffset + leaves.length,
      featureCount: result.featureCount,
      writtenTiles: options.writtenTiles + writtenTiles,
      skippedTiles: options.skippedTiles + skippedTiles
    });
  }

  if (children.length === 0) {
    return null;
  }

  const tileset = buildTileset({ bbox: mergeBboxes(tileBboxes) ?? bbox, maxHeight, children });
  const tilesetPath = join(outDir, 'tileset.json');
  await fs.writeFile(tilesetPath, `${JSON.stringify(tileset, null, 2)}\n`);
  outputBytes += Buffer.byteLength(JSON.stringify(tileset));

  return {
    tilesetPath,
    leafCount: leaves.length,
    writtenTiles,
    skippedTiles,
    outputBytes
  };
}

/**
 * Recursively split a layer bbox until each leaf is small enough to mesh.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {any} metadata
 * @param {[number, number, number, number]} bbox
 * @param {{ maxFeatures: number, maxDepth: number, count: Function }} options
 * @returns {Array<{ bbox: [number, number, number, number], count: number }>}
 */
function buildLeafPlan(db, metadata, bbox, options) {
  const leaves = [];
  splitNode(bbox, 0);
  return leaves;

  /**
   * @param {[number, number, number, number]} nodeBbox
   * @param {number} depth
   */
  function splitNode(nodeBbox, depth) {
    const count = options.count(db, metadata, nodeBbox);
    if (count === 0) {
      return;
    }

    if (count <= options.maxFeatures || depth >= options.maxDepth) {
      leaves.push({ bbox: nodeBbox, count });
      return;
    }

    for (const child of splitBbox(nodeBbox)) {
      splitNode(child, depth + 1);
    }
  }
}

/**
 * Split a geographic bbox into four quadrants.
 *
 * @param {[number, number, number, number]} bbox
 * @returns {Array<[number, number, number, number]>}
 */
function splitBbox(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const midLon = (minLon + maxLon) / 2;
  const midLat = (minLat + maxLat) / 2;
  return [
    [minLon, minLat, midLon, midLat],
    [midLon, minLat, maxLon, midLat],
    [minLon, midLat, midLon, maxLat],
    [midLon, midLat, maxLon, maxLat]
  ];
}

/**
 * Merge multiple lon/lat bounding boxes.
 *
 * @param {Array<[number, number, number, number]>} bboxes
 * @returns {[number, number, number, number] | null}
 */
function mergeBboxes(bboxes) {
  if (bboxes.length === 0) {
    return null;
  }

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const bbox of bboxes) {
    minLon = Math.min(minLon, bbox[0]);
    minLat = Math.min(minLat, bbox[1]);
    maxLon = Math.max(maxLon, bbox[2]);
    maxLat = Math.max(maxLat, bbox[3]);
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Normalize CLI layer input and reject unsupported 3D export layers.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
function normalizeLayers(value) {
  if (!value) {
    return [...DEFAULT_3D_LAYERS];
  }
  const layers = Array.isArray(value) ? value : String(value).split(',');
  const normalized = layers.map((layer) => normalizeLayerId(String(layer).trim())).filter(Boolean);
  const supported = new Set(SUPPORTED_3D_LAYERS);
  const unsupported = normalized.filter((layer) => !supported.has(layer));
  if (unsupported.length > 0) {
    throw new Error(`unsupported 3D layer(s): ${unsupported.join(', ')}`);
  }
  return normalized.length > 0 ? normalized : [...DEFAULT_3D_LAYERS];
}

/**
 * Map user-facing layer aliases to canonical exporter layer IDs.
 *
 * @param {string} layerId
 * @returns {string}
 */
function normalizeLayerId(layerId) {
  return LAYER_ALIASES[layerId] ?? layerId;
}

/**
 * Return whether a layer ID represents aeronautical data.
 *
 * @param {string} layerId
 * @returns {boolean}
 */
function isAipLayer(layerId) {
  return layerId === 'aip' || layerId === 'aviation';
}

/**
 * Validate the manifest fields required by static 3D Tiles export.
 *
 * @param {Record<string, unknown>} manifest
 */
function validateManifest(manifest) {
  if (manifest.format !== 'mapzero') {
    throw new Error('manifest format must be mapzero');
  }

  if (!validBbox(manifest.bbox)) {
    throw new Error('manifest bbox is required for 3D Tiles export');
  }
}

/**
 * Persist the 3D Tiles entry back to manifest.json.
 *
 * @param {string} manifestPath
 * @param {Record<string, any>} manifest
 * @param {Record<string, string>} tilesets
 * @param {[number, number, number, number]} bbox
 */
async function updateManifest3dTiles(manifestPath, manifest, tilesets, bbox) {
  delete manifest.cesium;
  const firstEntry = Object.entries(tilesets)[0];
  manifest.tiles3d = {
    format: '3dtiles',
    url: firstEntry?.[1],
    layers: Object.keys(tilesets),
    tilesets
  };
  if (!sameBbox(bbox, manifest.bbox)) {
    manifest.tiles3d.bbox = bbox;
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Load the package default style. Missing or invalid styles are treated as null
 * so exports can still complete with fallback colors and widths.
 *
 * @param {string} packageDir
 * @param {Record<string, any>} manifest
 * @returns {Promise<Record<string, any> | null>}
 */
async function readDefaultStyle(packageDir, manifest) {
  const styleUrl = manifest.styles?.default;
  if (typeof styleUrl !== 'string') {
    return null;
  }

  try {
    return JSON.parse(await fs.readFile(join(packageDir, styleUrl), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Convert a map-zero style rule to a glTF baseColorFactor.
 *
 * @param {Record<string, any> | null} style
 * @param {string} layerId
 * @returns {[number, number, number, number]}
 */
function colorFactorForLayer(style, layerId) {
  const rule = style?.layers?.[layerId] ?? style?.layers?.[styleLayerAlias(layerId)] ?? {};
  if (layerId === 'buildings') {
    const color = buildingSolidColor(rule);
    return [...hexToRgb(color), 1];
  }
  const color = rule.fill ?? rule.body?.color ?? rule.stroke ?? '#00ffff';
  const opacity = Number(rule.fillOpacity ?? rule.body?.opacity ?? rule.strokeOpacity ?? 0.8);
  return [...hexToRgb(color), Math.max(0.05, Math.min(1, Number.isFinite(opacity) ? opacity : 0.8))];
}

/**
 * Convert 2D style stroke/body width to an approximate world-space line width.
 *
 * @param {string} layerId
 * @param {Record<string, any> | null} style
 * @returns {number}
 */
function lineWidthMeters(layerId, style) {
  const rule = style?.layers?.[layerId] ?? style?.layers?.[styleLayerAlias(layerId)] ?? {};
  const width = Number(rule.body?.width ?? rule.strokeWidth);
  if (Number.isFinite(width) && width > 0) {
    return Math.max(1.5, width * 2.2);
  }
  if (layerId === 'roads') return 6;
  if (isAipLayer(layerId)) return 14;
  if (layerId === 'railways') return 3;
  if (layerId === 'boundaries') return 20;
  return 2;
}

/**
 * Return the alternate style key for layers whose data and style IDs differ.
 *
 * @param {string} layerId
 * @returns {string}
 */
function styleLayerAlias(layerId) {
  if (layerId === 'aip') return 'aviation';
  if (layerId === 'aviation') return 'aip';
  return LAYER_ALIASES[layerId] ?? layerId;
}

/**
 * Roads use their line width as the full surface body width.
 *
 * @param {Record<string, any> | null} style
 * @returns {number}
 */
function roadBodyWidthMeters(style) {
  const width = lineWidthMeters('roads', style);
  return Math.max(5, width);
}

/**
 * Assign z offsets for flat polygon surfaces to reduce z-fighting between
 * layers in Cesium.
 *
 * @param {string} layerId
 * @returns {number}
 */
function polygonSurfaceHeight(layerId) {
  if (isAipLayer(layerId)) return 8;
  if (layerId === 'water') return 4;
  if (layerId === 'landuse') return 2;
  return 3;
}

/**
 * Assign z offsets for line surfaces so roads, railways, boundaries, and AIP
 * remain visually separated.
 *
 * @param {string} layerId
 * @returns {number}
 */
function lineSurfaceHeight(layerId) {
  if (isAipLayer(layerId)) return 9;
  if (layerId === 'roads') return 10;
  if (layerId === 'railways') return 11;
  if (layerId === 'boundaries') return 12;
  return 10;
}

/**
 * Extract all valid line coordinate arrays from a feature list.
 *
 * @param {Array<{ geometry?: any }>} features
 * @returns {Array<Array<[number, number]>>}
 */
function linesFromFeatures(features) {
  const lines = [];
  for (const feature of features) {
    lines.push(...linesFromGeometry(feature.geometry));
  }
  return lines.map(cleanLine).filter((line) => line.length >= 2);
}

/**
 * Extract line coordinate arrays from GeoJSON LineString/MultiLineString.
 *
 * @param {any} geometry
 * @returns {Array<Array<[number, number]>>}
 */
function linesFromGeometry(geometry) {
  if (geometry?.type === 'LineString' && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry?.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

/**
 * Normalize a line to finite lon/lat pairs.
 *
 * @param {Array<[number, number]>} line
 * @returns {Array<[number, number]>}
 */
function cleanLine(line) {
  return line
    .map((point) => [Number(point?.[0]), Number(point?.[1])])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

/**
 * @param {{ geometry?: any }} feature
 * @returns {boolean}
 */
function hasLineGeometry(feature) {
  return feature.geometry?.type === 'LineString' || feature.geometry?.type === 'MultiLineString';
}

/**
 * @param {{ geometry?: any }} feature
 * @returns {boolean}
 */
function hasPolygonGeometry(feature) {
  return feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon';
}

/**
 * Decide which aviation points should become visible 3D disks.
 *
 * @param {{ geometry?: any, properties?: Record<string, unknown> }} feature
 * @returns {boolean}
 */
function isVisibleAviationPointFeature(feature) {
  if (feature.geometry?.type !== 'Point' && feature.geometry?.type !== 'MultiPoint') {
    return false;
  }
  const aeroway = String(feature.properties?.aeroway ?? '').toLowerCase();
  return aeroway === 'helipad' || aeroway === 'aerodrome';
}

/**
 * Convert point features into small polygon disks for flat 3D export.
 *
 * @param {Array<{ geometry?: any, properties?: Record<string, unknown> }>} features
 * @param {number} radiusMeters
 * @param {number} segments
 * @returns {Array<{ type: 'Feature', properties: any, geometry: { type: 'Polygon', coordinates: Array<Array<[number, number]>> } }>}
 */
function pointDiskFeatures(features, radiusMeters, segments) {
  const out = [];
  for (const feature of features) {
    for (const point of pointsFromGeometry(feature.geometry)) {
      const disk = pointDiskPolygon(point, radiusMeters, segments);
      if (disk) {
        out.push({
          type: 'Feature',
          properties: feature.properties,
          geometry: {
            type: 'Polygon',
            coordinates: [disk]
          }
        });
      }
    }
  }
  return out;
}

/**
 * Extract point coordinate arrays from GeoJSON Point/MultiPoint.
 *
 * @param {any} geometry
 * @returns {Array<[number, number]>}
 */
function pointsFromGeometry(geometry) {
  if (geometry?.type === 'Point' && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry?.type === 'MultiPoint' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

/**
 * Approximate a lon/lat point as a small circular polygon in local meters.
 *
 * @param {[number, number]} point
 * @param {number} radiusMeters
 * @param {number} segments
 * @returns {Array<[number, number]> | null}
 */
function pointDiskPolygon(point, radiusMeters, segments) {
  const lon = Number(point?.[0]);
  const lat = Number(point?.[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null;
  }
  const clampedSegments = Math.max(8, Math.min(32, Math.floor(segments)));
  const metersPerLon = Math.max(1, 111320 * Math.cos(lat * Math.PI / 180));
  const metersPerLat = 110540;
  const ring = [];
  for (let i = 0; i < clampedSegments; i++) {
    const angle = i / clampedSegments * Math.PI * 2;
    ring.push([
      lon + Math.cos(angle) * radiusMeters / metersPerLon,
      lat + Math.sin(angle) * radiusMeters / metersPerLat
    ]);
  }
  ring.push(ring[0]);
  return ring;
}

/**
 * Convert a CSS hex color to normalized RGB floats.
 *
 * @param {string} value
 * @returns {[number, number, number]}
 */
function hexToRgb(value) {
  const color = /^#?([0-9a-f]{6})$/i.exec(String(value));
  const hex = color?.[1] ?? '00ffff';
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255
  ];
}

/**
 * Pick the stable 3D building color. A style can override it with
 * cesium.color, tiles3d.color, or material.color.
 *
 * @param {Record<string, any>} rule
 * @returns {string}
 */
function buildingSolidColor(rule) {
  const explicit = rule?.cesium?.color ?? rule?.tiles3d?.color ?? rule?.material?.color;
  if (typeof explicit === 'string' && isHexColor(explicit)) {
    return explicit;
  }
  return '#8a3f82';
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * Return GLB material/attribute options for the layer.
 *
 * Buildings carry normals and use lit, double-sided materials so blocks read as
 * volumes in Cesium. Flat cartographic layers stay unlit and smaller.
 *
 * @param {string} layerId
 * @returns {{ includeNormals: boolean, quantizeNormals: boolean, doubleSided: boolean, unlit: boolean }}
 */
function glbOptionsForLayer(layerId) {
  const buildings = layerId === 'buildings';
  return {
    includeNormals: buildings,
    quantizeNormals: buildings,
    doubleSided: buildings,
    unlit: !buildings
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function validBbox(value) {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((part) => Number.isFinite(Number(part))) &&
    Number(value[0]) < Number(value[2]) &&
    Number(value[1]) < Number(value[3]);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameBbox(a, b) {
  return Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === 4 &&
    b.length === 4 &&
    a.every((value, index) => Math.abs(Number(value) - Number(b[index])) < 1e-9);
}
