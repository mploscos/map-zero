import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { isLayerInZoomRange } from './manifest.js';
import { getOsmLayerPolicy } from './mvt-osm-policy.js';
import { geometryBbox, tileSpanForBbox, topFeatures, visitCoordinates } from './mvt-utils.js';

export { labelAnchorForGeometry } from './mvt-utils.js';

/**
 * Hooks are optional; omitted hooks use generic behavior. Functions live in
 * JavaScript, while serializable layer metadata stays in the manifest.
 * aliases are fallback source IDs, consulted only after an exact match.
 * sourceLayer names a reader layer for derived output layers. Read contexts
 * contain its resolved descriptor and buffered EPSG:4326 query bbox.
 * featureLimit is a per-layer budget; featurePriority sorts descending with
 * stable ties. toleranceScale multiplies the shared zoom/detail tolerance.
 * minFeatureSize is a bbox span in 4096-unit tile coordinates (default 0).
 * prepareFeatures runs after selection and before simplification/clipping.
 * The default resolver is getOsmLayerPolicy; returning undefined from a custom
 * resolver selects generic behavior, including for a built-in OSM ID.
 *
 * @typedef {Record<string, unknown>} MvtFeature
 * @typedef {{
 *   getLayers: () => Array<Record<string, unknown>>,
 *   getTileFeatures: (layerId: string, bbox: [number, number, number, number], filters?: import('./gpkg-read.js').TileQueryFilters) => MvtFeature[]
 * }} MvtReader
 * @typedef {{
 *   layerId: string,
 *   sourceLayer: string,
 *   descriptor: Record<string, unknown>,
 *   bbox: [number, number, number, number],
 *   z: number,
 *   style: Record<string, unknown> | null,
 *   debugLabels: boolean
 * }} MvtReadContext
 * @typedef {{
 *   aliases?: string[],
 *   sourceLayer?: string,
 *   readFeatures?: (reader: MvtReader, context: MvtReadContext) => { features: MvtFeature[], originalFeatureCount: number },
 *   featureLimit?: (z: number) => number,
 *   featurePriority?: (feature: MvtFeature, z: number) => number,
 *   toleranceScale?: (geometryType: string, z: number) => number,
 *   minFeatureSize?: (geometryType: string, z: number) => number,
 *   prepareFeatures?: (features: MvtFeature[]) => MvtFeature[]
 * }} MvtLayerPolicy
 * @typedef {(layerId: string, descriptor: Record<string, unknown> | undefined) => MvtLayerPolicy | undefined} MvtLayerPolicyResolver
 * @typedef {{
 *   detail?: string,
 *   maxFeatures?: number,
 *   style?: Record<string, unknown> | null,
 *   debugLabels?: boolean,
 *   getLayerPolicy?: MvtLayerPolicyResolver
 * }} MvtOptions
 * @typedef {{ layerId: string, descriptor: Record<string, unknown>, requestedDescriptor?: Record<string, unknown>, policy: MvtLayerPolicy }} ResolvedMvtLayer
 * @typedef {ResolvedMvtLayer & { features: MvtFeature[], originalFeatureCount: number }} MvtLayerBatch
 */

const TILE_EXTENT = 4096;
const TILE_QUERY_BUFFER_UNITS = 128;
const MAX_ZOOM = 22;
const DEFAULT_MAX_FEATURES = 12000;
const TILE_DETAIL_LEVELS = new Set(['overview', 'normal', 'full']);

/**
 * @typedef {{
 *   originalVertexCount: number,
 *   simplifiedVertexCount: number,
 *   droppedSmallFeatures: number,
 *   simplificationTolerance: number
 * }} GeneralizationStats
 */

/**
 * Encode one logical layer as a Mapbox Vector Tile.
 *
 * @param {{
 *   getLayers: () => Array<Record<string, unknown>>,
 *   getTileFeatures: (layerId: string, bbox: [number, number, number, number], filters?: import('./gpkg-read.js').TileQueryFilters) => Array<Record<string, unknown>>
 * }} reader
 * @param {string} layerId
 * @param {string | number} zValue
 * @param {string | number} xValue
 * @param {string | number} yValue
 * @param {MvtOptions} [options]
 * @returns {Buffer}
 */
export function encodeMvtTile(reader, layerId, zValue, xValue, yValue, options = {}) {
  return encodeMvtTileWithStats(reader, layerId, zValue, xValue, yValue, options).buffer;
}

/**
 * Encode one logical layer as a Mapbox Vector Tile and return lightweight timing stats.
 *
 * @param {{
 *   getLayers: () => Array<Record<string, unknown>>,
 *   getTileFeatures: (layerId: string, bbox: [number, number, number, number], filters?: import('./gpkg-read.js').TileQueryFilters) => Array<Record<string, unknown>>
 * }} reader
 * @param {string} layerId
 * @param {string | number} zValue
 * @param {string | number} xValue
 * @param {string | number} yValue
 * @param {MvtOptions} [options]
 * @returns {{ buffer: Buffer, featureCount: number, originalFeatureCount: number, encodedFeatureCount: number, droppedFeatureCount: number, bbox: [number, number, number, number], layerNames: string[], emptyReason: string, originalVertexCount: number, simplifiedVertexCount: number, droppedSmallFeatures: number, simplificationTolerance: number }}
 */
export function encodeMvtTileWithStats(reader, layerId, zValue, xValue, yValue, options = {}) {
  const { z, x, y } = parseTileParams(zValue, xValue, yValue);
  const bbox = tileToBbox(z, x, y);
  const queryBbox = tileQueryBbox(z, x, y);
  const detail = normalizeDetail(options.detail, z);
  const layer = resolveMvtLayer(reader.getLayers(), layerId, options.getLayerPolicy ?? getOsmLayerPolicy);
  const layerFeatures = readRequestedLayerFeatures(reader, layer, queryBbox, z, options);
  const limited = applyFeatureLimit([layerFeatures], maxFeaturesForZoom(z, options.maxFeatures), z);
  const layerTile = createLayerTile(limited.layers[0]?.features ?? [], bbox, z, x, y, layer.policy, detail, layer.requestedDescriptor ?? layer.descriptor);
  const tile = layerTile.tile;
  const encodedFeatureCount = tile.features.length;
  const droppedFeatureCount = limited.droppedFeatureCount + layerTile.stats.droppedSmallFeatures;

  return {
    buffer: Buffer.from(vtpbf.fromGeojsonVt({ [layerId]: tile }, {
      extent: TILE_EXTENT,
      version: 2
    })),
    featureCount: encodedFeatureCount,
    originalFeatureCount: layerFeatures.originalFeatureCount,
    encodedFeatureCount,
    droppedFeatureCount,
    bbox,
    layerNames: [layerId],
    emptyReason: emptyReasonForTile(layerFeatures.originalFeatureCount, encodedFeatureCount, droppedFeatureCount, limited.layers),
    originalVertexCount: layerTile.stats.originalVertexCount,
    simplifiedVertexCount: layerTile.stats.simplifiedVertexCount,
    droppedSmallFeatures: layerTile.stats.droppedSmallFeatures,
    simplificationTolerance: layerTile.stats.simplificationTolerance
  };
}

/**
 * Encode all readable logical layers as one Mapbox Vector Tile.
 *
 * @param {{
 *   getLayers: () => Array<Record<string, unknown>>,
 *   getTileFeatures: (layerId: string, bbox: [number, number, number, number], filters?: import('./gpkg-read.js').TileQueryFilters) => Array<Record<string, unknown>>
 * }} reader
 * @param {string | number} zValue
 * @param {string | number} xValue
 * @param {string | number} yValue
 * @param {string[]} [layerIds]
 * @param {MvtOptions} [options]
 * @returns {Buffer}
 */
export function encodeMvtTileSet(reader, zValue, xValue, yValue, layerIds, options = {}) {
  return encodeMvtTileSetWithStats(reader, zValue, xValue, yValue, layerIds, options).buffer;
}

/**
 * Encode all requested logical layers as one Mapbox Vector Tile and return lightweight timing stats.
 *
 * @param {{
 *   getLayers: () => Array<Record<string, unknown>>,
 *   getTileFeatures: (layerId: string, bbox: [number, number, number, number], filters?: import('./gpkg-read.js').TileQueryFilters) => Array<Record<string, unknown>>
 * }} reader
 * @param {string | number} zValue
 * @param {string | number} xValue
 * @param {string | number} yValue
 * @param {string[]} [layerIds]
 * @param {MvtOptions} [options]
 * @returns {{ buffer: Buffer, featureCount: number, originalFeatureCount: number, encodedFeatureCount: number, droppedFeatureCount: number, bbox: [number, number, number, number], layerNames: string[], emptyReason: string, originalVertexCount: number, simplifiedVertexCount: number, droppedSmallFeatures: number, simplificationTolerance: number }}
 */
export function encodeMvtTileSetWithStats(reader, zValue, xValue, yValue, layerIds, options = {}) {
  const { z, x, y } = parseTileParams(zValue, xValue, yValue);
  const bbox = tileToBbox(z, x, y);
  const queryBbox = tileQueryBbox(z, x, y);
  const detail = normalizeDetail(options.detail, z);
  /** @type {Record<string, { features: unknown[] }>} */
  const layers = {};
  let originalFeatureCount = 0;
  let encodedFeatureCount = 0;
  /** @type {GeneralizationStats} */
  const generalizationStats = emptyGeneralizationStats();
  const requested = layerIds ? new Set(layerIds) : null;
  const metadata = reader.getLayers();

  const layerFeatureBatches = [];
  for (const layerId of requestedLayerIds(metadata, requested)) {
    const layer = resolveMvtLayer(metadata, layerId, options.getLayerPolicy ?? getOsmLayerPolicy);
    if (!layer.descriptor.exists || !layer.descriptor.rtree) {
      if (requested) throw httpError(400, `layer is not tile-readable: ${layerId}`);
      continue;
    }
    const layerFeatures = readRequestedLayerFeatures(reader, layer, queryBbox, z, options);
    originalFeatureCount += layerFeatures.originalFeatureCount;
    layerFeatureBatches.push(layerFeatures);
  }

  const limited = applyFeatureLimit(layerFeatureBatches, maxFeaturesForZoom(z, options.maxFeatures), z);
  for (const layerFeatures of limited.layers) {
    const layerTile = createLayerTile(layerFeatures.features, bbox, z, x, y, layerFeatures.policy, detail, layerFeatures.requestedDescriptor ?? layerFeatures.descriptor);
    layers[layerFeatures.layerId] = layerTile.tile;
    addGeneralizationStats(generalizationStats, layerTile.stats);
    encodedFeatureCount += layers[layerFeatures.layerId].features.length;
  }
  const droppedFeatureCount = limited.droppedFeatureCount + generalizationStats.droppedSmallFeatures;

  return {
    buffer: Buffer.from(vtpbf.fromGeojsonVt(layers, {
      extent: TILE_EXTENT,
      version: 2
    })),
    featureCount: encodedFeatureCount,
    originalFeatureCount,
    encodedFeatureCount,
    droppedFeatureCount,
    bbox,
    layerNames: limited.layers.map((layer) => layer.layerId),
    emptyReason: emptyReasonForTile(originalFeatureCount, encodedFeatureCount, droppedFeatureCount, limited.layers),
    originalVertexCount: generalizationStats.originalVertexCount,
    simplifiedVertexCount: generalizationStats.simplifiedVertexCount,
    droppedSmallFeatures: generalizationStats.droppedSmallFeatures,
    simplificationTolerance: generalizationStats.simplificationTolerance
  };
}

/**
 * @param {Array<Record<string, unknown>>} metadata
 * @param {Set<string> | null} requested
 * @returns {string[]}
 */
function requestedLayerIds(metadata, requested) {
  if (requested) {
    return [...requested];
  }

  return metadata.map((layer) => String(layer.id));
}

/**
 * @param {MvtLayerBatch[]} layers
 * @param {number} maxFeatures
 * @param {number} z
 * @returns {{ layers: MvtLayerBatch[], droppedFeatureCount: number }}
 */
function applyFeatureLimit(layers, maxFeatures, z) {
  let droppedFeatureCount = 0;
  const layerLimited = layers.map((layer) => {
    const limited = limitLayerFeatures(layer, layer.policy.featureLimit?.(z) ?? Number.MAX_SAFE_INTEGER, z);
    droppedFeatureCount += layer.features.length - limited.features.length;
    return limited;
  });

  const total = layerLimited.reduce((sum, layer) => sum + layer.features.length, 0);
  if (total <= maxFeatures) {
    return {
      layers: layerLimited,
      droppedFeatureCount
    };
  }

  const limited = limitAcrossLayers(layerLimited, maxFeatures, z);
  return {
    layers: limited.layers,
    droppedFeatureCount: droppedFeatureCount + limited.droppedFeatureCount
  };
}

/**
 * @param {number} originalFeatureCount
 * @param {number} encodedFeatureCount
 * @param {number} droppedFeatureCount
 * @param {MvtLayerBatch[]} layers
 * @returns {string}
 */
function emptyReasonForTile(originalFeatureCount, encodedFeatureCount, droppedFeatureCount, layers) {
  if (encodedFeatureCount > 0) {
    return 'none';
  }

  if (originalFeatureCount === 0) {
    return 'no_features';
  }

  const remainingFeatureCount = layers.reduce((sum, layer) => sum + layer.features.length, 0);
  if ((remainingFeatureCount === 0 || droppedFeatureCount > 0) && droppedFeatureCount > 0) {
    return 'filtered';
  }

  return 'no_tile_geometry';
}

/**
 * @param {MvtLayerBatch} layer
 * @param {number} maxFeatures
 * @param {number} z
 * @returns {MvtLayerBatch}
 */
function limitLayerFeatures(layer, maxFeatures, z) {
  if (layer.features.length <= maxFeatures) {
    return layer;
  }

  return {
    ...layer,
    features: topFeatures(layer.features, maxFeatures, (feature) => layer.policy.featurePriority?.(feature, z) ?? 100)
  };
}

/**
 * @param {MvtLayerBatch[]} layers
 * @param {number} maxFeatures
 * @param {number} z
 * @returns {{ layers: MvtLayerBatch[], droppedFeatureCount: number }}
 */
function limitAcrossLayers(layers, maxFeatures, z) {
  const total = layers.reduce((sum, layer) => sum + layer.features.length, 0);
  const entries = [];
  let order = 0;
  for (const layer of layers) {
    for (const feature of layer.features) {
      entries.push({
        layerId: layer.layerId,
        feature,
        priority: layer.policy.featurePriority?.(feature, z) ?? 100,
        order
      });
      order += 1;
    }
  }

  entries.sort((a, b) => b.priority - a.priority || a.order - b.order);
  const selected = entries.slice(0, maxFeatures);
  const selectedByLayer = new Map();
  for (const entry of selected) {
    const layerFeatures = selectedByLayer.get(entry.layerId) ?? [];
    layerFeatures.push(entry.feature);
    selectedByLayer.set(entry.layerId, layerFeatures);
  }

  return {
    layers: layers.map((layer) => ({
      ...layer,
      features: selectedByLayer.get(layer.layerId) ?? []
    })),
    droppedFeatureCount: total - selected.length
  };
}

/**
 * @param {number} z
 * @param {number | undefined} configured
 * @returns {number}
 */
function maxFeaturesForZoom(z, configured) {
  const requested = Number.isInteger(configured) && Number(configured) > 0
    ? Number(configured)
    : DEFAULT_MAX_FEATURES;

  return Math.min(requested, defaultMaxFeaturesForZoom(z));
}

/**
 * @param {number} z
 * @returns {number}
 */
function defaultMaxFeaturesForZoom(z) {
  if (z <= 10) {
    return 6500;
  }

  if (z === 11) {
    return 10000;
  }

  if (z === 12) {
    return 12500;
  }

  if (z === 13) {
    return 12000;
  }

  return 30000;
}

/**
 * Convert XYZ tile coordinates to an EPSG:4326 bbox.
 *
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {[number, number, number, number]}
 */
export function tileToBbox(z, x, y) {
  const n = 2 ** z;
  const minLon = (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;
  const maxLat = tileYToLat(y, n);
  const minLat = tileYToLat(y + 1, n);
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * @param {string | number} zValue
 * @param {string | number} xValue
 * @param {string | number} yValue
 * @returns {{ z: number, x: number, y: number }}
 */
function parseTileParams(zValue, xValue, yValue) {
  const z = Number(zValue);
  const x = Number(xValue);
  const y = Number(yValue);

  if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM) {
    throw httpError(400, `z must be an integer between 0 and ${MAX_ZOOM}`);
  }

  const maxIndex = 2 ** z;
  if (!Number.isInteger(x) || x < 0 || x >= maxIndex) {
    throw httpError(400, `x must be an integer between 0 and ${maxIndex - 1}`);
  }

  if (!Number.isInteger(y) || y < 0 || y >= maxIndex) {
    throw httpError(400, `y must be an integer between 0 and ${maxIndex - 1}`);
  }

  return { z, x, y };
}

/**
 * @param {number} y
 * @param {number} n
 * @returns {number}
 */
function tileYToLat(y, n) {
  const mercator = Math.PI * (1 - (2 * y) / n);
  return (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
}

/**
 * @param {number} z
 * @param {MvtLayerPolicy} policy
 * @param {string} geometryType
 * @param {string} detail
 * @returns {number}
 */
function toleranceForZoom(z, policy, geometryType, detail) {
  let tolerance;

  if (z <= 7) {
    tolerance = 14;
  } else if (z <= 9) {
    tolerance = 10;
  } else if (z <= 10) {
    tolerance = 8;
  } else if (z <= 11) {
    tolerance = 6;
  } else if (z <= 12) {
    tolerance = 4;
  } else if (z <= 13) {
    tolerance = 2.4;
  } else if (z <= 14) {
    tolerance = 1.2;
  } else if (z <= 15) {
    tolerance = 0.5;
  } else {
    tolerance = 0;
  }

  tolerance *= (policy.toleranceScale?.(geometryType, z) ?? (geometryType === 'Polygon' || geometryType === 'MultiPolygon' ? 0.75 : 0.65));

  if (detail === 'overview') {
    tolerance *= 1.1;
  } else if (detail === 'full') {
    tolerance *= 0.3;
  }

  return Math.max(0, Number(tolerance.toFixed(2)));
}

/**
 * Simplify geometries before MVT encoding so low zooms stay lightweight.
 *
 * @param {Array<Record<string, unknown>>} features
 * @param {[number, number, number, number]} bbox
 * @param {number} z
 * @param {MvtLayerPolicy} policy
 * @param {string} detail
 * @returns {{ features: Array<Record<string, unknown>>, stats: GeneralizationStats }}
 */
function simplifyFeatures(features, bbox, z, policy, detail) {
  const stats = emptyGeneralizationStats();
  const tileSpan = tileSpanForBbox(bbox);
  const generalized = [];

  for (const feature of features) {
    const geometry = /** @type {{ type?: string, coordinates?: unknown }} */ (feature.geometry);
    const originalVertexCount = countGeometryVertices(geometry);
    stats.originalVertexCount += originalVertexCount;

    if (isSmallFeature(geometry, bbox, z, policy)) {
      stats.droppedSmallFeatures += 1;
      continue;
    }

    const tolerance = simplifyToleranceDegrees(tileSpan, z, policy, String(geometry?.type ?? ''), detail);
    stats.simplificationTolerance = Math.max(stats.simplificationTolerance, tolerance);

    const simplifiedGeometry = tolerance > 0
      ? simplifyGeometry(geometry, tolerance)
      : geometry;

    if (!hasUsableGeometry(simplifiedGeometry)) {
      stats.droppedSmallFeatures += 1;
      continue;
    }

    stats.simplifiedVertexCount += countGeometryVertices(simplifiedGeometry);
    generalized.push({
      ...feature,
      geometry: simplifiedGeometry
    });
  }

  return {
    features: generalized,
    stats
  };
}

/**
 * @param {number} tileSpan
 * @param {number} z
 * @param {MvtLayerPolicy} policy
 * @param {string} geometryType
 * @param {string} detail
 * @returns {number}
 */
function simplifyToleranceDegrees(tileSpan, z, policy, geometryType, detail) {
  return (tileSpan / TILE_EXTENT) * toleranceForZoom(z, policy, geometryType, detail);
}

/**
 * @param {{ type?: string, coordinates?: unknown }} geometry
 * @param {number} tolerance
 * @returns {{ type?: string, coordinates?: unknown }}
 */
function simplifyGeometry(geometry, tolerance) {
  switch (geometry?.type) {
    case 'LineString':
      return {
        ...geometry,
        coordinates: simplifyLine(/** @type {Array<[number, number]>} */ (geometry.coordinates), tolerance, false)
      };

    case 'MultiLineString':
      return {
        ...geometry,
        coordinates: /** @type {Array<Array<[number, number]>>} */ (geometry.coordinates)
          .map((line) => simplifyLine(line, tolerance, false))
          .filter((line) => line.length >= 2)
      };

    case 'Polygon':
      return simplifyPolygonGeometry(geometry, tolerance);

    case 'MultiPolygon':
      return simplifyMultiPolygonGeometry(geometry, tolerance);

    default:
      return geometry;
  }
}

/**
 * @param {{ type?: string, coordinates?: unknown }} geometry
 * @param {number} tolerance
 * @returns {{ type?: string, coordinates?: unknown }}
 */
function simplifyPolygonGeometry(geometry, tolerance) {
  const rings = /** @type {Array<Array<[number, number]>>} */ (geometry.coordinates)
    .map((ring) => simplifyLine(ring, tolerance, true))
    .filter((ring) => ring.length >= 4);

  if (rings.length === 0) {
    return geometry;
  }

  return {
    ...geometry,
    coordinates: rings
  };
}

/**
 * @param {{ type?: string, coordinates?: unknown }} geometry
 * @param {number} tolerance
 * @returns {{ type?: string, coordinates?: unknown }}
 */
function simplifyMultiPolygonGeometry(geometry, tolerance) {
  const polygons = /** @type {Array<Array<Array<[number, number]>>>} */ (geometry.coordinates)
    .map((polygon) => polygon
      .map((ring) => simplifyLine(ring, tolerance, true))
      .filter((ring) => ring.length >= 4))
    .filter((polygon) => polygon.length > 0);

  if (polygons.length === 0) {
    return geometry;
  }

  return {
    ...geometry,
    coordinates: polygons
  };
}

/**
 * @param {Array<[number, number]>} coordinates
 * @param {number} tolerance
 * @param {boolean} closed
 * @returns {Array<[number, number]>}
 */
function simplifyLine(coordinates, tolerance, closed) {
  if (!Array.isArray(coordinates) || coordinates.length <= (closed ? 4 : 2)) {
    return coordinates;
  }

  const input = closed ? coordinates.slice(0, -1) : coordinates;
  const radial = simplifyRadialDistance(input, (tolerance * 0.5) ** 2);
  const simplified = douglasPeucker(radial, tolerance * tolerance);

  if (!closed) {
    return simplified.length >= 2 ? simplified : coordinates;
  }

  if (simplified.length < 3) {
    return coordinates;
  }

  const first = simplified[0];
  const last = simplified.at(-1);
  const ring = first && last && (first[0] !== last[0] || first[1] !== last[1])
    ? [...simplified, [first[0], first[1]]]
    : simplified;

  return ring.length >= 4 ? ring : coordinates;
}

/**
 * @param {Array<[number, number]>} coordinates
 * @param {number} toleranceSq
 * @returns {Array<[number, number]>}
 */
function simplifyRadialDistance(coordinates, toleranceSq) {
  if (coordinates.length <= 2 || toleranceSq <= 0) {
    return coordinates;
  }

  const simplified = [coordinates[0]];
  let previous = coordinates[0];

  for (let i = 1; i < coordinates.length - 1; i += 1) {
    const point = coordinates[i];
    if (distanceSq(point, previous) > toleranceSq) {
      simplified.push(point);
      previous = point;
    }
  }

  simplified.push(coordinates.at(-1));
  return simplified;
}

/**
 * @param {Array<[number, number]>} coordinates
 * @param {number} toleranceSq
 * @returns {Array<[number, number]>}
 */
function douglasPeucker(coordinates, toleranceSq) {
  if (coordinates.length <= 2) {
    return coordinates;
  }

  let maxDistanceSq = 0;
  let index = 0;
  const first = coordinates[0];
  const last = coordinates.at(-1);

  for (let i = 1; i < coordinates.length - 1; i += 1) {
    const distanceSq = pointSegmentDistanceSq(coordinates[i], first, last);
    if (distanceSq > maxDistanceSq) {
      maxDistanceSq = distanceSq;
      index = i;
    }
  }

  if (maxDistanceSq <= toleranceSq) {
    return [first, last];
  }

  const left = douglasPeucker(coordinates.slice(0, index + 1), toleranceSq);
  const right = douglasPeucker(coordinates.slice(index), toleranceSq);
  return left.slice(0, -1).concat(right);
}

/**
 * @param {[number, number]} point
 * @param {[number, number]} start
 * @param {[number, number]} end
 * @returns {number}
 */
function pointSegmentDistanceSq(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];

  if (dx === 0 && dy === 0) {
    return distanceSq(point, start);
  }

  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  return distanceSq(point, [start[0] + t * dx, start[1] + t * dy]);
}

/**
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number}
 */
function distanceSq(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/**
 * @returns {GeneralizationStats}
 */
function emptyGeneralizationStats() {
  return {
    originalVertexCount: 0,
    simplifiedVertexCount: 0,
    droppedSmallFeatures: 0,
    simplificationTolerance: 0
  };
}

/**
 * @param {GeneralizationStats} target
 * @param {GeneralizationStats} source
 */
function addGeneralizationStats(target, source) {
  target.originalVertexCount += source.originalVertexCount;
  target.simplifiedVertexCount += source.simplifiedVertexCount;
  target.droppedSmallFeatures += source.droppedSmallFeatures;
  target.simplificationTolerance = Math.max(target.simplificationTolerance, source.simplificationTolerance);
}

/**
 * @param {{ type?: string, coordinates?: unknown }} geometry
 * @param {[number, number, number, number]} tileBbox
 * @param {number} z
 * @param {MvtLayerPolicy} policy
 * @returns {boolean}
 */
function isSmallFeature(geometry, tileBbox, z, policy) {
  const minSize = policy.minFeatureSize?.(String(geometry?.type ?? ''), z) ?? 0;
  if (minSize <= 0) {
    return false;
  }

  const bbox = geometryBbox(geometry);
  if (!bbox) {
    return false;
  }

  const tileWidth = Math.abs(tileBbox[2] - tileBbox[0]);
  const tileHeight = Math.abs(tileBbox[3] - tileBbox[1]);
  if (tileWidth <= 0 || tileHeight <= 0) {
    return false;
  }

  const width = (Math.abs(bbox[2] - bbox[0]) / tileWidth) * TILE_EXTENT;
  const height = (Math.abs(bbox[3] - bbox[1]) / tileHeight) * TILE_EXTENT;
  return Math.max(width, height) < minSize;
}

/**
 * @param {{ type?: string, coordinates?: unknown }} geometry
 * @returns {boolean}
 */
function hasUsableGeometry(geometry) {
  switch (geometry?.type) {
    case 'Point':
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2;
    case 'LineString':
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2;
    case 'MultiLineString':
      return Array.isArray(geometry.coordinates)
        && geometry.coordinates.some((line) => Array.isArray(line) && line.length >= 2);
    case 'Polygon':
      return Array.isArray(geometry.coordinates)
        && geometry.coordinates.some((ring) => Array.isArray(ring) && ring.length >= 4);
    case 'MultiPolygon':
      return Array.isArray(geometry.coordinates)
        && geometry.coordinates.some((polygon) => Array.isArray(polygon)
          && polygon.some((ring) => Array.isArray(ring) && ring.length >= 4));
    default:
      return false;
  }
}

/**
 * @param {{ coordinates?: unknown }} geometry
 * @returns {number}
 */
function countGeometryVertices(geometry) {
  let count = 0;
  visitCoordinates(geometry?.coordinates, () => {
    count += 1;
  });
  return count;
}

/**
 * Build a single MVT layer tile. If simplification removes all geometry for a
 * tile that had candidate features, retry without the pre-simplification pass.
 *
 * @param {Array<Record<string, unknown>>} features
 * @param {[number, number, number, number]} bbox
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @param {MvtLayerPolicy} policy
 * @param {string} detail
 * @returns {{ tile: { features: unknown[] }, stats: GeneralizationStats }}
 */
function createLayerTile(features, bbox, z, x, y, policy, detail, descriptor = {}) {
  // Native Cesium styles need to distinguish polygons, lines and points in
  // mixed layers; OpenLayers obtains this directly from its decoded geometry.
  features = features.map((feature) => {
    const properties = { ...feature.properties, mapzero_geometry: feature.geometry?.type ?? '' };
    return { ...feature, properties };
  });
  features = policy.prepareFeatures?.(features) ?? features;
  if (descriptor.tileProperties) {
    const keys = new Set([...descriptor.tileProperties, 'id', 'mapzero_geometry',
      descriptor.featureZoom?.minColumn, descriptor.featureZoom?.maxColumn]);
    features = features.map((feature) => ({ ...feature,
      properties: Object.fromEntries(Object.entries(feature.properties).filter(([key]) => keys.has(key)))
    }));
  }
  const simplified = simplifyFeatures(features, bbox, z, policy, detail);
  const tile = tileFromFeatures(simplified.features, z, x, y);
  if (tile.features.length > 0 || features.length === 0) {
    return {
      tile,
      stats: simplified.stats
    };
  }

  const fallbackTile = tileFromFeatures(features, z, x, y);
  return {
    tile: fallbackTile.features.length > 0 ? fallbackTile : tile,
    stats: simplified.stats
  };
}

/**
 * @param {Array<Record<string, unknown>>} features
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {{ features: unknown[] }}
 */
function tileFromFeatures(features, z, x, y) {
  return createTileIndex(features, z).getTile(z, x, y) ?? { features: [] };
}

/**
 * @param {Array<Record<string, unknown>>} features
 * @param {number} z
 * @returns {ReturnType<typeof geojsonvt>}
 */
function createTileIndex(features, z) {
  return geojsonvt(
    {
      type: 'FeatureCollection',
      features
    },
    {
      extent: TILE_EXTENT,
      maxZoom: z,
      indexMaxZoom: z,
      buffer: TILE_QUERY_BUFFER_UNITS,
      // Geometries are already simplified in lon/lat before indexing.
      // Keep geojson-vt from applying a second aggressive simplification pass
      // that can erase small-but-valid low-zoom tile content.
      tolerance: 0
    }
  );
}

/**
 * Return the feature-query bbox for a tile, expanded by the same edge buffer
 * used during MVT clipping. Encoding still uses the exact tile bbox.
 *
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {[number, number, number, number]}
 */
function tileQueryBbox(z, x, y) {
  return expandBboxByTileUnits(tileToBbox(z, x, y), TILE_QUERY_BUFFER_UNITS);
}

/**
 * @param {[number, number, number, number]} bbox
 * @param {number} units
 * @returns {[number, number, number, number]}
 */
function expandBboxByTileUnits(bbox, units) {
  const xMargin = ((bbox[2] - bbox[0]) * units) / TILE_EXTENT;
  const yMargin = ((bbox[3] - bbox[1]) * units) / TILE_EXTENT;
  return [
    Math.max(-180, bbox[0] - xMargin),
    Math.max(-85.05112878, bbox[1] - yMargin),
    Math.min(180, bbox[2] + xMargin),
    Math.min(85.05112878, bbox[3] + yMargin)
  ];
}

/**
 * @param {string | undefined} detail
 * @param {number} z
 * @returns {string}
 */
function normalizeDetail(detail, z) {
  if (!detail) {
    return detailForZoom(z);
  }

  if (!TILE_DETAIL_LEVELS.has(detail)) {
    throw httpError(400, `detail must be one of: ${[...TILE_DETAIL_LEVELS].join(', ')}`);
  }

  return detail;
}

/**
 * @param {number} z
 * @returns {string}
 */
export function detailForZoom(z) {
  if (z <= 11) {
    return 'overview';
  }

  if (z <= 14) {
    return 'normal';
  }

  return 'full';
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

/**
 * Resolve public IDs and optional policy aliases against reader metadata.
 * The policy source controls reads; the requested ID controls MVT layer names.
 * @param {Array<Record<string, unknown>>} metadata
 * @param {string} layerId
 * @param {MvtLayerPolicyResolver} getLayerPolicy
 * @returns {ResolvedMvtLayer}
 */
function resolveMvtLayer(metadata, layerId, getLayerPolicy) {
  const declared = metadata.find((layer) => String(layer.id) === layerId);
  const policy = getLayerPolicy(layerId, declared) ?? {};
  const sourceId = policy.sourceLayer ?? layerId;
  const descriptor = metadata.find((layer) => String(layer.id) === sourceId) ??
    (policy.aliases ?? []).map((id) => metadata.find((layer) => String(layer.id) === id)).find(Boolean);
  if (!descriptor || (policy.sourceLayer && (!descriptor.exists || !descriptor.rtree))) {
    throw httpError(404, `unknown layer: ${layerId}`);
  }
  return { layerId, descriptor, requestedDescriptor: declared, policy };
}

/**
 * @param {MvtReader} reader
 * @param {ResolvedMvtLayer} layer
 * @param {[number, number, number, number]} bbox
 * @param {number} z
 * @param {MvtOptions} options
 * @returns {MvtLayerBatch}
 */
function readRequestedLayerFeatures(reader, layer, bbox, z, options) {
  if (!isLayerInZoomRange(layer.descriptor, z) ||
      (layer.requestedDescriptor && !isLayerInZoomRange(layer.requestedDescriptor, z))) {
    return { ...layer, features: [], originalFeatureCount: 0 };
  }
  const context = {
    layerId: layer.layerId,
    sourceLayer: String(layer.descriptor.id),
    descriptor: layer.descriptor,
    bbox, z,
    style: options.style ?? null,
    debugLabels: Boolean(options.debugLabels)
  };
  // Scope all policy reads to the current zoom, including alternate source
  // tables. Keep old readers/OSM query contracts untouched when not opted in.
  const zoomReader = reader.getLayers().some((metadata) => metadata.featureZoom) ? {
    ...reader,
    getTileFeatures(id, bounds, filters = {}) {
      return reader.getTileFeatures(id, bounds, { ...filters, zoom: z });
    }
  } : reader;
  const result = layer.policy.readFeatures?.(zoomReader, context);
  if (result) return { ...layer, features: result.features, originalFeatureCount: result.originalFeatureCount };
  const features = zoomReader.getTileFeatures(context.sourceLayer, bbox);
  return { ...layer, features, originalFeatureCount: features.length };
}
