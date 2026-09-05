import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

const TILE_EXTENT = 4096;
const TILE_QUERY_BUFFER_UNITS = 128;
const MAX_ZOOM = 22;
const DEFAULT_MAX_FEATURES = 12000;
const TILE_DETAIL_LEVELS = new Set(['overview', 'normal', 'full']);
const ROAD_ZOOM_CLASSES = {
  major: ['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link'],
  mid: ['tertiary', 'tertiary_link', 'primary_link', 'secondary_link', 'busway'],
  city: ['residential', 'unclassified', 'living_street'],
  minor: [
    'service',
    'track',
    'path',
    'footway',
    'cycleway',
    'steps',
    'pedestrian',
    'corridor',
    'platform',
    'construction',
    'proposed',
    'road'
  ]
};
const LANDUSE_OVERVIEW_FILTERS = [
  { column: 'landuse', include: ['residential', 'industrial', 'commercial', 'retail', 'forest', 'farmland', 'military', 'reservoir'] },
  { column: 'leisure', include: ['park', 'golf_course', 'recreation_ground'] },
  { column: 'natural', include: ['wood', 'water', 'scrub', 'heath'] }
];
const TERRAIN_CLASSES = ['beach', 'sand'];
const AVIATION_OVERVIEW_CLASSES = ['runway', 'taxiway', 'apron', 'stopway', 'taxilane'];
const AVIATION_MID_CLASSES = [...AVIATION_OVERVIEW_CLASSES, 'terminal', 'helipad', 'hangar', 'aerodrome', 'heliport'];
const OPERATIONAL_POI_CATEGORIES = [
  'transport',
  'emergency',
  'government',
  'energy',
  'communications',
  'protected',
  'industrial',
  'military',
  'operational'
];
const POI_CATEGORY_FILTER_COLUMNS = [
  'poi_category',
  'amenity',
  'tourism',
  'shop',
  'leisure',
  'railway',
  'public_transport',
  'station',
  'aeroway',
  'power',
  'man_made',
  'tower:type',
  'military',
  'emergency',
  'office',
  'government',
  'boundary',
  'protect_class',
  'landuse',
  'industrial'
];
const LABEL_LAYERS = {
  road_labels: {
    sourceLayer: 'roads',
    minZoom: 13
  },
  aip_labels: {
    sourceLayer: 'aip',
    minZoom: 12
  },
  aviation_labels: {
    sourceLayer: 'aviation',
    minZoom: 12
  },
  poi_labels: {
    sourceLayer: 'pois',
    minZoom: 17
  }
};

function isAipLayer(layerId) {
  return layerId === 'aip' || layerId === 'aviation';
}

function isAipLabelLayer(layerId) {
  return layerId === 'aip_labels' || layerId === 'aviation_labels';
}
const LABEL_TEXT_FIELDS = ['name', 'ref', 'iata', 'icao', 'operator', 'official_name', 'short_name'];
const GENERIC_LABEL_VALUES = new Set([
  'yes',
  'no',
  'true',
  'false',
  'unknown',
  'none',
  'generator',
  'tower',
  'line',
  'plant',
  'substation',
  'transformer',
  'mast',
  'antenna',
  'station',
  'airport',
  'aerodrome',
  'runway',
  'taxiway',
  'terminal',
  'apron',
  'pharmacy',
  'fuel',
  'charging_station',
  'hospital',
  'clinic',
  'police',
  'fire_station',
  'fire_hydrant',
  'defibrillator',
  'fire_extinguisher',
  'shelter',
  'railway_station',
  'train_station',
  'subway_station',
  'bus_station',
  'ferry_terminal',
  'townhall',
  'courthouse',
  'prison',
  'bunker',
  'checkpoint',
  'communications_tower',
  'protected_area',
  'nature_reserve',
  'restaurant',
  'cafe',
  'bar',
  'fast_food',
  'pub',
  'shop',
  'retail',
  'commercial',
  'tourism',
  'attraction',
  'hotel',
  'transport',
  'emergency',
  'government',
  'energy',
  'communications',
  'protected',
  'industrial',
  'military',
  'operational',
  'consumer'
]);

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
 * @param {{ detail?: string, maxFeatures?: number, style?: Record<string, unknown> | null }} [options]
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
 * @param {{ detail?: string, maxFeatures?: number }} [options]
 * @returns {{ buffer: Buffer, featureCount: number, originalFeatureCount: number, encodedFeatureCount: number, droppedFeatureCount: number, bbox: [number, number, number, number], layerNames: string[], emptyReason: string, originalVertexCount: number, simplifiedVertexCount: number, droppedSmallFeatures: number, simplificationTolerance: number }}
 */
export function encodeMvtTileWithStats(reader, layerId, zValue, xValue, yValue, options = {}) {
  const { z, x, y } = parseTileParams(zValue, xValue, yValue);
  const bbox = tileToBbox(z, x, y);
  const queryBbox = tileQueryBbox(z, x, y);
  const detail = normalizeDetail(options.detail, z);
  validateRequestedLayers(reader.getLayers(), new Set([layerId]));
  const layerFeatures = readRequestedLayerFeatures(reader, layerId, queryBbox, z, options.style ?? null, Boolean(options.debugLabels));
  const limited = applyFeatureLimit([layerFeatures], maxFeaturesForZoom(z, options.maxFeatures), z);
  const layerTile = createLayerTile(limited.layers[0]?.features ?? [], bbox, z, x, y, layerId, detail);
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
 * @param {{ detail?: string, maxFeatures?: number, style?: Record<string, unknown> | null }} [options]
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
 * @param {{ detail?: string, maxFeatures?: number }} [options]
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

  if (requested) {
    validateRequestedLayers(metadata, requested);
  }

  const layerFeatureBatches = [];
  for (const layerId of requestedLayerIds(metadata, requested)) {
    if (!isLabelLayerId(layerId)) {
      const layer = metadata.find((item) => String(item.id) === layerId);
      if (!layer?.exists || !layer.rtree) {
        if (requested) {
          throw httpError(400, `layer is not tile-readable: ${layerId}`);
        }
        continue;
      }
    }

    const layerFeatures = readRequestedLayerFeatures(reader, layerId, queryBbox, z, options.style ?? null, Boolean(options.debugLabels));
    originalFeatureCount += layerFeatures.originalFeatureCount;
    layerFeatureBatches.push(layerFeatures);
  }

  const limited = applyFeatureLimit(layerFeatureBatches, maxFeaturesForZoom(z, options.maxFeatures), z);
  for (const layerFeatures of limited.layers) {
    const layerTile = createLayerTile(layerFeatures.features, bbox, z, x, y, layerFeatures.layerId, detail);
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
 * @param {Set<string>} requested
 */
function validateRequestedLayers(metadata, requested) {
  const knownLayerIds = new Set(metadata.map((layer) => String(layer.id)));
  for (const layerId of [...knownLayerIds]) {
    if (isAipLayer(layerId)) {
      knownLayerIds.add(layerId === 'aip' ? 'aviation' : 'aip');
    }
  }
  for (const layerId of requested) {
    if (!knownLayerIds.has(layerId) && !isReadableLabelLayer(metadata, layerId)) {
      throw httpError(404, `unknown layer: ${layerId}`);
    }
  }
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
 * @param {Array<Record<string, unknown>>} metadata
 * @param {string} layerId
 * @returns {boolean}
 */
function isReadableLabelLayer(metadata, layerId) {
  const definition = LABEL_LAYERS[layerId];
  if (!definition) {
    return false;
  }

  const source = metadata.find((layer) => String(layer.id) === definition.sourceLayer ||
    (isAipLayer(String(layer.id)) && isAipLayer(definition.sourceLayer)));
  return Boolean(source?.exists && source?.rtree);
}

/**
 * @param {string} layerId
 * @returns {boolean}
 */
function isLabelLayerId(layerId) {
  return Boolean(LABEL_LAYERS[layerId]);
}

/**
 * @param {{
 *   getTileFeatures: (layerId: string, bbox: [number, number, number, number], filters?: import('./gpkg-read.js').TileQueryFilters) => Array<Record<string, unknown>>
 * }} reader
 * @param {string} layerId
 * @param {[number, number, number, number]} bbox
 * @param {number} z
 * @param {Record<string, unknown> | null} style
 * @param {boolean} debugLabels
 * @returns {{ layerId: string, features: Array<Record<string, unknown>>, originalFeatureCount: number }}
 */
function readRequestedLayerFeatures(reader, layerId, bbox, z, style, debugLabels) {
  return isLabelLayerId(layerId)
    ? readLabelLayerFeatures(reader, layerId, bbox, z, style, debugLabels)
    : readLayerFeatures(reader, layerId, bbox, z, style);
}

/**
 * @param {{
 *   getTileFeatures: (layerId: string, bbox: [number, number, number, number], filters?: import('./gpkg-read.js').TileQueryFilters) => Array<Record<string, unknown>>
 * }} reader
 * @param {string} layerId
 * @param {[number, number, number, number]} bbox
 * @param {number} z
 * @param {Record<string, unknown> | null} style
 * @returns {{ layerId: string, features: Array<Record<string, unknown>>, originalFeatureCount: number }}
 */
function readLayerFeatures(reader, layerId, bbox, z, style) {
  if (!shouldReadLayerAtZoom(layerId, z)) {
    return {
      layerId,
      features: [],
      originalFeatureCount: 0
    };
  }

  const filters = tileQueryFiltersForLayer(layerId, z, style, bbox);
  const rawFeatures = reader.getTileFeatures(layerId, bbox, filters);
  const features = layerId === 'pois'
    ? filterPoiFeatures(enrichPoiFeatures(rawFeatures), style)
    : rawFeatures;
  return {
    layerId,
    features,
    originalFeatureCount: rawFeatures.length
  };
}

/**
 * @param {{
 *   getTileFeatures: (layerId: string, bbox: [number, number, number, number], filters?: import('./gpkg-read.js').TileQueryFilters) => Array<Record<string, unknown>>
 * }} reader
 * @param {string} layerId
 * @param {[number, number, number, number]} bbox
 * @param {number} z
 * @param {Record<string, unknown> | null} style
 * @param {boolean} debugLabels
 * @returns {{ layerId: string, features: Array<Record<string, unknown>>, originalFeatureCount: number }}
 */
function readLabelLayerFeatures(reader, layerId, bbox, z, style, debugLabels) {
  const definition = LABEL_LAYERS[layerId];
  if (!definition || z < definition.minZoom) {
    return {
      layerId,
      features: [],
      originalFeatureCount: 0
    };
  }

  const sourceLayer = definition.sourceLayer;
  if (!shouldReadLayerAtZoom(sourceLayer, z)) {
    return {
      layerId,
      features: [],
      originalFeatureCount: 0
    };
  }

  const rawSourceFeatures = reader.getTileFeatures(sourceLayer, bbox, tileQueryFiltersForLayer(sourceLayer, z, style, bbox));
  const sourceFeatures = sourceLayer === 'pois'
    ? filterPoiFeatures(enrichPoiFeatures(rawSourceFeatures), style)
    : rawSourceFeatures;
  const candidates = buildLabelCandidates(layerId, sourceLayer, sourceFeatures, z, debugLabels);
  return {
    layerId,
    features: topFeatures(layerId, candidates, labelFeatureLimit(layerId, z), z),
    originalFeatureCount: candidates.length
  };
}

/**
 * @param {string} layerId
 * @param {number} z
 * @returns {boolean}
 */
function shouldReadLayerAtZoom(layerId, z) {
  if (layerId === 'buildings') {
    return z >= 12;
  }

  if (layerId === 'pois') {
    return z >= 16;
  }

  if (isAipLayer(layerId)) {
    return z >= 10;
  }

  return true;
}

/**
 * @param {string} layerId
 * @param {number} z
 * @param {Record<string, unknown> | null} style
 * @param {[number, number, number, number]} bbox
 * @returns {import('./gpkg-read.js').TileQueryFilters}
 */
function tileQueryFiltersForLayer(layerId, z, style, bbox) {
  if (layerId === 'roads') {
    return {
      all: [
        {
          column: 'highway',
          include: roadClassesForZoom(z)
        }
      ]
    };
  }

  if (layerId === 'landuse' && z < 12) {
    return {
      any: LANDUSE_OVERVIEW_FILTERS
    };
  }

  if (layerId === 'terrain') {
    return {
      all: [
        {
          column: 'natural',
          include: TERRAIN_CLASSES
        }
      ]
    };
  }

  if (layerId === 'coastline') {
    return {
      all: [
        {
          column: 'natural',
          include: ['coastline']
        }
      ]
    };
  }

  if (layerId === 'cliffs') {
    return {
      all: [
        {
          column: 'natural',
          include: ['cliff']
        }
      ]
    };
  }

  if (layerId === 'boundaries' && z < 12) {
    return {
      all: [
        {
          column: 'admin_level',
          maxNumber: 7
        }
      ]
    };
  }

  if (isAipLayer(layerId)) {
    return {
      all: [
        {
          column: 'aeroway',
          include: z < 13 ? AVIATION_OVERVIEW_CLASSES : AVIATION_MID_CLASSES
        }
      ]
    };
  }

  if (layerId === 'pois') {
    return poiTileQueryFilters(style);
  }

  if (layerId === 'buildings' && z < 15) {
    return {
      minRtreeSpan: buildingMinRtreeSpan(bbox, z)
    };
  }

  return {};
}

/**
 * Filter tiny building footprints in SQLite before geometry decoding. This is
 * deliberately stronger than the final screen-size filter at z12/z13 because
 * dense urban tiles can otherwise decode tens of thousands of buildings that
 * will be dropped later.
 *
 * @param {[number, number, number, number]} bbox
 * @param {number} z
 * @returns {number}
 */
function buildingMinRtreeSpan(bbox, z) {
  const tileSpan = tileSpanForBbox(bbox);
  if (z <= 12) {
    return (tileSpan / TILE_EXTENT) * 60;
  }

  if (z === 13) {
    return (tileSpan / TILE_EXTENT) * 34;
  }

  if (z === 14) {
    return (tileSpan / TILE_EXTENT) * 12;
  }

  return 0;
}

/**
 * @param {Record<string, unknown> | null} style
 * @returns {import('./gpkg-read.js').TileQueryFilters}
 */
function poiTileQueryFilters(style) {
  const categories = poiCategoryVisibility(style);
  if (categories.consumer === true) {
    return {};
  }

  const enabledCategories = enabledPoiCategories(categories);
  if (enabledCategories.length === 0) {
    return {
      all: [
        {
          column: 'amenity',
          include: []
        }
      ]
    };
  }

  return {
    any: poiCategorySqlFilters(enabledCategories, style)
  };
}

/**
 * @param {string[]} enabledCategories
 * @param {Record<string, unknown> | null} style
 * @returns {Array<{ column: string, include: string[] }>}
 */
function poiCategorySqlFilters(enabledCategories, style) {
  const directlyVisibleCategories = enabledCategories.filter((category) => category !== 'operational' && category !== 'consumer');
  const filters = directlyVisibleCategories.length > 0
    ? [{ column: 'poi_category', include: directlyVisibleCategories }]
    : [];
  const poiRules = [
    objectRule(objectRule(style?.layers)?.pois),
    objectRule(objectRule(style?.labels)?.pois)
  ].filter(Boolean);

  const configuredClasses = poiRules
    .map((rule) => objectRule(rule?.classes))
    .find(Boolean);
  if (configuredClasses) {
    filters.push(...propertyFiltersFromClassConfig(configuredClasses));
    return filters;
  }

  filters.push(...defaultPoiClassFilters(enabledCategories));
  return filters;
}

/**
 * @param {Record<string, unknown>} classes
 * @returns {Array<{ column: string, include: string[] }>}
 */
function propertyFiltersFromClassConfig(classes) {
  const filters = [];
  for (const column of POI_CATEGORY_FILTER_COLUMNS) {
    if (column === 'poi_category') {
      continue;
    }
    const values = Array.isArray(classes[column])
      ? /** @type {unknown[]} */ (classes[column]).map(String).filter(Boolean)
      : [];
    if (values.length > 0) {
      filters.push({ column, include: values });
    }
  }
  return filters;
}

/**
 * @param {string[]} enabledCategories
 * @returns {Array<{ column: string, include: string[] }>}
 */
function defaultPoiClassFilters(enabledCategories) {
  const filters = [];
  const add = (column, include) => {
    if (include.length > 0) {
      filters.push({ column, include });
    }
  };

  if (enabledCategories.includes('transport')) {
    add('amenity', ['bus_station', 'ferry_terminal', 'airport', 'railway_station', 'train_station', 'subway_station']);
    add('railway', ['station']);
    add('public_transport', ['station']);
    add('station', ['subway']);
    add('aeroway', ['aerodrome', 'airport']);
  }

  if (enabledCategories.includes('emergency')) {
    add('amenity', ['hospital', 'police', 'fire_station', 'shelter']);
    add('emergency', ['ambulance_station', 'siren', 'assembly_point', 'disaster_response']);
  }

  if (enabledCategories.includes('government')) {
    add('amenity', ['townhall', 'courthouse', 'prison', 'embassy', 'research_institute']);
    add('office', ['government']);
    add('government', ['yes', 'public_safety', 'border_control', 'customs', 'ministry', 'aerospace']);
  }

  if (enabledCategories.includes('energy')) {
    add('power', ['plant', 'substation', 'generator', 'tower', 'transformer', 'line']);
  }

  if (enabledCategories.includes('communications')) {
    add('amenity', ['communications_tower']);
    add('man_made', ['communications_tower', 'mast', 'antenna']);
    add('tower:type', ['communication']);
  }

  if (enabledCategories.includes('protected')) {
    add('boundary', ['protected_area']);
    add('leisure', ['nature_reserve']);
    add('tourism', ['national_park']);
  }

  if (enabledCategories.includes('industrial')) {
    add('landuse', ['industrial']);
    add('industrial', ['refinery', 'depot', 'storage', 'logistics']);
    add('amenity', ['depot', 'warehouse']);
  }

  if (enabledCategories.includes('military')) {
    add('amenity', ['bunker', 'checkpoint']);
    add('military', ['barracks', 'bunker', 'checkpoint', 'airbase', 'naval_base', 'range', 'training_area', 'base', 'airfield', 'danger_area', 'ammunition_dump']);
  }

  return filters;
}

/**
 * @param {Array<Record<string, unknown>>} features
 * @returns {Array<Record<string, unknown>>}
 */
function enrichPoiFeatures(features) {
  return features.map((feature) => {
    const properties = /** @type {Record<string, unknown>} */ (feature.properties ?? {});
    const category = poiCategoryForProperties(properties);
    return {
      ...feature,
      properties: {
        ...properties,
        poi_category: category
      }
    };
  });
}

/**
 * @param {Array<Record<string, unknown>>} features
 * @param {Record<string, unknown> | null} style
 * @returns {Array<Record<string, unknown>>}
 */
function filterPoiFeatures(features, style) {
  const visibility = poiCategoryVisibility(style);
  const classFilters = poiClassFilters(style, enabledPoiCategories(visibility));
  return features.filter((feature) => {
    const properties = /** @type {Record<string, unknown>} */ (feature.properties ?? {});
    const category = String(properties.poi_category ?? poiCategoryForProperties(properties));
    if (visibility[category] !== true) {
      return false;
    }

    return matchesAnyPoiClassFilter(properties, classFilters);
  });
}

/**
 * @param {Record<string, unknown> | null} style
 * @param {string[]} enabledCategories
 * @returns {Array<{ column: string, include: string[] }>}
 */
function poiClassFilters(style, enabledCategories) {
  const poiRules = [
    objectRule(objectRule(style?.layers)?.pois),
    objectRule(objectRule(style?.labels)?.pois)
  ].filter(Boolean);
  const configuredClasses = poiRules
    .map((rule) => objectRule(rule?.classes))
    .find(Boolean);
  return configuredClasses
    ? propertyFiltersFromClassConfig(configuredClasses)
    : defaultPoiClassFilters(enabledCategories);
}

/**
 * @param {Record<string, unknown>} properties
 * @param {Array<{ column: string, include: string[] }>} filters
 * @returns {boolean}
 */
function matchesAnyPoiClassFilter(properties, filters) {
  for (const filter of filters) {
    const value = String(properties[filter.column] ?? '');
    if (value && filter.include.includes(value)) {
      return true;
    }
  }

  return false;
}

/**
 * @param {Record<string, unknown> | null} style
 * @returns {Record<string, boolean>}
 */
function poiCategoryVisibility(style) {
  const defaults = Object.fromEntries(OPERATIONAL_POI_CATEGORIES.map((category) => [category, true]));
  defaults.consumer = false;

  const ruleCategories = [
    objectRule(objectRule(style?.layers)?.pois)?.categories,
    objectRule(objectRule(style?.labels)?.pois)?.categories
  ].map(objectRule).filter(Boolean);

  for (const categories of ruleCategories) {
    for (const [category, visible] of Object.entries(categories)) {
      defaults[category] = visible === true;
    }
  }

  return /** @type {Record<string, boolean>} */ (defaults);
}

/**
 * @param {Record<string, boolean>} visibility
 * @returns {string[]}
 */
function enabledPoiCategories(visibility) {
  return Object.entries(visibility)
    .filter(([, visible]) => visible === true)
    .map(([category]) => category);
}

/**
 * @param {Record<string, unknown>} properties
 * @returns {string}
 */
function poiCategoryForProperties(properties) {
  const existing = String(properties.poi_category ?? '').trim();
  if (existing) {
    return existing;
  }

  const amenity = String(properties.amenity ?? '');
  const tourism = String(properties.tourism ?? '');
  const shop = String(properties.shop ?? '');
  const leisure = String(properties.leisure ?? '');
  const railway = String(properties.railway ?? '');
  const publicTransport = String(properties.public_transport ?? '');
  const station = String(properties.station ?? '');
  const aeroway = String(properties.aeroway ?? '');
  const power = String(properties.power ?? '');
  const manMade = String(properties.man_made ?? '');
  const towerType = String(properties['tower:type'] ?? '');
  const military = String(properties.military ?? '');
  const emergency = String(properties.emergency ?? '');
  const office = String(properties.office ?? '');
  const government = String(properties.government ?? '');
  const boundary = String(properties.boundary ?? '');
  const protectClass = String(properties.protect_class ?? '');
  const landuse = String(properties.landuse ?? '');
  const industrial = String(properties.industrial ?? '');

  if (
    ['railway_station', 'train_station', 'subway_station', 'bus_station', 'ferry_terminal', 'airport'].includes(amenity) ||
    railway === 'station' ||
    publicTransport === 'station' ||
    station === 'subway' ||
    aeroway === 'aerodrome' ||
    aeroway === 'airport'
  ) {
    return 'transport';
  }

  if (['hospital', 'police', 'fire_station', 'shelter'].includes(amenity) || ['ambulance_station', 'siren', 'assembly_point', 'disaster_response'].includes(emergency)) {
    return 'emergency';
  }

  if (['townhall', 'courthouse', 'prison', 'embassy'].includes(amenity) || office === 'government' || government) {
    return 'government';
  }

  if (power) {
    return 'energy';
  }

  if (amenity === 'communications_tower' || manMade === 'communications_tower' || manMade === 'mast' || manMade === 'antenna' || towerType === 'communication') {
    return 'communications';
  }

  if (boundary === 'protected_area' || leisure === 'nature_reserve' || tourism === 'national_park' || protectClass) {
    return 'protected';
  }

  if (landuse === 'industrial' || industrial || ['depot', 'warehouse'].includes(amenity)) {
    return 'industrial';
  }

  if (military || ['bunker', 'checkpoint'].includes(amenity)) {
    return 'military';
  }

  if (shop || tourism || leisure || ['restaurant', 'cafe', 'bar', 'fast_food', 'pub'].includes(amenity)) {
    return 'consumer';
  }

  return 'operational';
}

/**
 * @param {unknown} rule
 * @returns {Record<string, unknown> | null}
 */
function objectRule(rule) {
  return rule && typeof rule === 'object' ? /** @type {Record<string, unknown>} */ (rule) : null;
}

/**
 * @param {number} z
 * @returns {string[]}
 */
function roadClassesForZoom(z) {
  if (z <= 11) {
    return ROAD_ZOOM_CLASSES.major;
  }

  if (z <= 13) {
    return [...ROAD_ZOOM_CLASSES.major, ...ROAD_ZOOM_CLASSES.mid];
  }

  if (z === 14) {
    return [...ROAD_ZOOM_CLASSES.major, ...ROAD_ZOOM_CLASSES.mid, ...ROAD_ZOOM_CLASSES.city];
  }

  return [
    ...ROAD_ZOOM_CLASSES.major,
    ...ROAD_ZOOM_CLASSES.mid,
    ...ROAD_ZOOM_CLASSES.city,
    ...ROAD_ZOOM_CLASSES.minor
  ];
}

/**
 * @param {string} labelLayerId
 * @param {string} sourceLayer
 * @param {Array<Record<string, unknown>>} features
 * @param {number} z
 * @param {boolean} debugLabels
 * @returns {Array<Record<string, unknown>>}
 */
function buildLabelCandidates(labelLayerId, sourceLayer, features, z, debugLabels) {
  const candidates = [];
  for (const feature of features) {
    const candidate = labelCandidateForFeature(labelLayerId, sourceLayer, feature, z, debugLabels);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * @param {string} labelLayerId
 * @param {string} sourceLayer
 * @param {Record<string, unknown>} feature
 * @param {number} z
 * @param {boolean} debugLabels
 * @returns {Record<string, unknown> | null}
 */
function labelCandidateForFeature(labelLayerId, sourceLayer, feature, z, debugLabels) {
  const properties = /** @type {Record<string, unknown>} */ (feature.properties ?? {});
  const geometry = /** @type {{ type?: string, coordinates?: unknown }} */ (feature.geometry ?? {});

  if (labelLayerId === 'road_labels') {
    const highway = String(properties.highway ?? '');
    if (!shouldLabelRoadClass(highway, z)) {
      return null;
    }

    const text = firstMeaningfulText(properties, ['ref', 'name']);
    if (!text) {
      debugRejectedLabel(debugLabels, labelLayerId, properties, 'missing meaningful road ref/name');
      return null;
    }

    return createLabelFeature({
      sourceLayer,
      sourceId: properties.id,
      text,
      className: highway,
      priority: roadLabelPriority(highway, properties, z),
      minZoom: roadLabelMinZoom(highway),
      coordinate: labelAnchorForGeometry(geometry)
    });
  }

  if (isAipLabelLayer(labelLayerId)) {
    const aeroway = String(properties.aeroway ?? '');
    if (!shouldLabelAviationClass(aeroway, z)) {
      return null;
    }

    const text = aviationLabelText(properties, aeroway);
    if (!text) {
      debugRejectedLabel(debugLabels, labelLayerId, properties, 'missing meaningful aviation label');
      return null;
    }

    return createLabelFeature({
      sourceLayer,
      sourceId: properties.id,
      text,
      className: aeroway,
      aeroway,
      priority: aviationLabelPriority(aeroway),
      minZoom: aviationLabelMinZoom(aeroway),
      coordinate: labelAnchorForGeometry(geometry)
    });
  }

  if (labelLayerId === 'poi_labels') {
    const text = poiLabelText(properties);
    if (!text) {
      debugRejectedLabel(debugLabels, labelLayerId, properties, 'missing meaningful POI label');
      return null;
    }

    return createLabelFeature({
      sourceLayer,
      sourceId: properties.id,
      text,
      className: firstText(properties, ['amenity', 'railway', 'public_transport', 'aeroway', 'power', 'man_made', 'military', 'emergency', 'industrial', 'poi_category']) || 'poi',
      priority: poiLabelPriority(properties),
      minZoom: 16,
      coordinate: labelAnchorForGeometry(geometry)
    });
  }

  return null;
}

/**
 * @param {Record<string, unknown>} properties
 * @returns {string}
 */
function poiLabelText(properties) {
  return firstMeaningfulText(properties, LABEL_TEXT_FIELDS);
}

/**
 * @param {Record<string, unknown>} properties
 * @param {string} aeroway
 * @returns {string}
 */
function aviationLabelText(properties, aeroway) {
  const ref = String(properties.ref ?? '').replace(/\s+/g, ' ').trim();
  if (ref && !/^(yes|no|true|false|0|1)$/i.test(ref)) {
    return ref;
  }

  const text = firstMeaningfulText(properties, ['ref', 'name', 'iata', 'icao', 'operator']);
  if (text) {
    return text;
  }

  if (aeroway === 'runway') {
    return 'RWY';
  }

  return aeroway === 'helipad' || aeroway === 'heliport' ? 'H' : '';
}

/**
 * @param {{
 *   sourceLayer: string,
 *   sourceId: unknown,
 *   text: string,
 *   className: string,
 *   aeroway?: string,
 *   priority: number,
 *   minZoom: number,
 *   coordinate: number[] | null
 * }} options
 * @returns {Record<string, unknown> | null}
 */
function createLabelFeature(options) {
  if (!options.coordinate) {
    return null;
  }

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: options.coordinate
    },
    properties: {
      text: options.text,
      class: options.className,
      aeroway: options.aeroway ?? null,
      priority: options.priority,
      minZoom: options.minZoom,
      sourceLayer: options.sourceLayer,
      sourceId: options.sourceId ?? null
    }
  };
}

/**
 * @param {Record<string, unknown>} properties
 * @param {string[]} fields
 * @returns {string}
 */
function firstText(properties, fields) {
  for (const field of fields) {
    const text = String(properties[field] ?? '').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

/**
 * @param {Record<string, unknown>} properties
 * @param {string[]} fields
 * @returns {string}
 */
function firstMeaningfulText(properties, fields) {
  for (const field of fields) {
    const text = String(properties[field] ?? '').replace(/\s+/g, ' ').trim();
    if (isMeaningfulLabel(text)) {
      return text;
    }
  }

  return '';
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isMeaningfulLabel(text) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length < 2) {
    return false;
  }

  const key = normalized.toLowerCase().replace(/\s+/g, '_');
  if (GENERIC_LABEL_VALUES.has(key)) {
    return false;
  }

  if (/^(yes|no|true|false|0|1)$/i.test(normalized)) {
    return false;
  }

  return true;
}

/**
 * @param {boolean} enabled
 * @param {string} labelLayerId
 * @param {Record<string, unknown>} properties
 * @param {string} reason
 */
function debugRejectedLabel(enabled, labelLayerId, properties, reason) {
  if (!enabled) {
    return;
  }

  const id = properties.id ? ` id=${properties.id}` : '';
  const name = properties.name ? ` name=${JSON.stringify(properties.name)}` : '';
  const ref = properties.ref ? ` ref=${JSON.stringify(properties.ref)}` : '';
  console.error(`map-zero label rejected ${labelLayerId}:${id}${name}${ref} ${reason}`);
}

/**
 * @param {string} highway
 * @param {number} z
 * @returns {boolean}
 */
function shouldLabelRoadClass(highway, z) {
  if (!highway) {
    return false;
  }

  if (z < 13) {
    return false;
  }

  if (z <= 14) {
    return ROAD_ZOOM_CLASSES.major.includes(highway) || ROAD_ZOOM_CLASSES.mid.includes(highway);
  }

  if (z <= 16) {
    return [
      ...ROAD_ZOOM_CLASSES.major,
      ...ROAD_ZOOM_CLASSES.mid,
      ...ROAD_ZOOM_CLASSES.city
    ].includes(highway);
  }

  return !['path', 'footway', 'cycleway', 'steps', 'corridor', 'platform'].includes(highway);
}

/**
 * @param {string} highway
 * @returns {number}
 */
function roadLabelMinZoom(highway) {
  if (['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link'].includes(highway)) {
    return 13;
  }

  if (['tertiary', 'tertiary_link', 'primary_link', 'secondary_link'].includes(highway)) {
    return 14;
  }

  return 16;
}

/**
 * @param {string} highway
 * @param {Record<string, unknown>} properties
 * @param {number} z
 * @returns {number}
 */
function roadLabelPriority(highway, properties, z) {
  const hasRef = Boolean(String(properties.ref ?? '').trim());
  return roadPriority(highway) + (hasRef ? 80 : 0) + (z >= 15 ? 20 : 0);
}

/**
 * @param {string} aeroway
 * @param {number} z
 * @returns {boolean}
 */
function shouldLabelAviationClass(aeroway, z) {
  if (!aeroway || z < 12) {
    return false;
  }

  if (z < 14) {
    return ['runway', 'taxiway', 'apron', 'terminal'].includes(aeroway);
  }

  return ['runway', 'taxiway', 'apron', 'terminal', 'helipad', 'hangar', 'aerodrome', 'heliport'].includes(aeroway);
}

/**
 * @param {string} aeroway
 * @returns {number}
 */
function aviationLabelMinZoom(aeroway) {
  return ['runway', 'taxiway', 'apron', 'terminal'].includes(aeroway) ? 12 : 14;
}

/**
 * @param {string} aeroway
 * @returns {number}
 */
function aviationLabelPriority(aeroway) {
  if (aeroway === 'helipad' || aeroway === 'heliport') return 980;
  if (aeroway === 'runway') return 930;
  if (aeroway === 'terminal') return 880;
  if (aeroway === 'apron') return 820;
  if (aeroway === 'taxiway') return 760;
  return 680;
}

/**
 * @param {Record<string, unknown>} properties
 * @returns {number}
 */
function poiLabelPriority(properties) {
  const category = poiCategoryForProperties(properties);
  const amenity = String(properties.amenity ?? '');
  if (category === 'emergency' || category === 'military') return 920;
  if (['transport', 'energy', 'communications', 'government'].includes(category)) return 820;
  if (amenity === 'hospital' || amenity === 'university') return 650;
  return 500;
}

/**
 * @param {string} layerId
 * @param {number} z
 * @returns {number}
 */
function labelFeatureLimit(layerId, z) {
  if (layerId === 'road_labels') {
    if (z <= 13) return 48;
    if (z <= 15) return 96;
    return 160;
  }

  if (isAipLabelLayer(layerId)) {
    return z <= 13 ? 40 : 80;
  }

  if (layerId === 'poi_labels') {
    return z <= 17 ? 50 : 120;
  }

  return 80;
}

/**
 * @param {{ type?: string, coordinates?: unknown }} geometry
 * @returns {number[] | null}
 */
export function labelAnchorForGeometry(geometry) {
  if (geometry.type === 'Point' && isCoordinate(geometry.coordinates)) {
    return /** @type {number[]} */ (geometry.coordinates);
  }

  if (geometry.type === 'MultiPoint' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.find(isCoordinate) ?? null;
  }

  if (geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
    return lineMidpoint(/** @type {number[][]} */ (geometry.coordinates));
  }

  if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
    const lines = /** @type {number[][][]} */ (geometry.coordinates);
    return lineMidpoint(longestLine(lines));
  }

  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    return polygonAnchor(/** @type {number[][][]} */ (geometry.coordinates));
  }

  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    const polygons = /** @type {number[][][][]} */ (geometry.coordinates);
    return polygonAnchor(largestPolygon(polygons));
  }

  return null;
}

/**
 * @param {unknown} coordinate
 * @returns {coordinate is number[]}
 */
function isCoordinate(coordinate) {
  return Array.isArray(coordinate) &&
    coordinate.length >= 2 &&
    Number.isFinite(Number(coordinate[0])) &&
    Number.isFinite(Number(coordinate[1]));
}

/**
 * @param {number[][]} coords
 * @returns {number[] | null}
 */
function lineMidpoint(coords) {
  if (!Array.isArray(coords) || coords.length === 0) {
    return null;
  }

  if (coords.length === 1) {
    return isCoordinate(coords[0]) ? coords[0] : null;
  }

  const lengths = [];
  let total = 0;
  for (let index = 0; index < coords.length - 1; index += 1) {
    const a = coords[index];
    const b = coords[index + 1];
    if (!isCoordinate(a) || !isCoordinate(b)) {
      lengths.push(0);
      continue;
    }
    const length = Math.hypot(Number(b[0]) - Number(a[0]), Number(b[1]) - Number(a[1]));
    lengths.push(length);
    total += length;
  }

  if (total <= 0) {
    return coords.find(isCoordinate) ?? null;
  }

  const target = total / 2;
  let accumulated = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    const next = accumulated + length;
    if (target <= next || index === lengths.length - 1) {
      const a = coords[index];
      const b = coords[index + 1];
      if (!isCoordinate(a) || !isCoordinate(b) || length <= 0) {
        return isCoordinate(a) ? a : null;
      }
      const t = Math.max(0, Math.min(1, (target - accumulated) / length));
      return [
        Number(a[0]) + (Number(b[0]) - Number(a[0])) * t,
        Number(a[1]) + (Number(b[1]) - Number(a[1])) * t
      ];
    }
    accumulated = next;
  }

  return null;
}

/**
 * @param {number[][][]} lines
 * @returns {number[][]}
 */
function longestLine(lines) {
  let best = [];
  let bestLength = -1;
  for (const line of lines) {
    const length = lineLength(line);
    if (length > bestLength) {
      best = line;
      bestLength = length;
    }
  }
  return best;
}

/**
 * @param {number[][]} line
 * @returns {number}
 */
function lineLength(line) {
  let length = 0;
  for (let index = 0; index < line.length - 1; index += 1) {
    const a = line[index];
    const b = line[index + 1];
    if (isCoordinate(a) && isCoordinate(b)) {
      length += Math.hypot(Number(b[0]) - Number(a[0]), Number(b[1]) - Number(a[1]));
    }
  }
  return length;
}

/**
 * @param {number[][][]} polygon
 * @returns {number[] | null}
 */
function polygonAnchor(polygon) {
  const ring = polygon?.[0];
  if (!Array.isArray(ring) || ring.length === 0) {
    return null;
  }

  // Find the widest interior interval on horizontal scanlines. The even/odd
  // rule includes concave outlines and subtracts holes, unlike vertex averages.
  const ys = [...new Set(ring.filter(isCoordinate).map((p) => Number(p[1])))].sort((a, b) => a - b);
  if (ys.length < 2) return ring.find(isCoordinate) ?? null;
  const scans = [(ys[0] + ys.at(-1)) / 2];
  for (let i = 1; i < ys.length; i++) scans.push((ys[i - 1] + ys[i]) / 2);
  let best = null;
  let width = -1;
  // Limit work for very detailed OSM polygons; every chosen interval is inside.
  const stride = Math.max(1, Math.ceil(scans.length / 32));
  for (let scan = 0; scan < scans.length; scan += stride) {
    const y = scans[scan];
    const xs = [];
    for (const outline of polygon) {
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        const a = outline[j], b = outline[i];
        if (!isCoordinate(a) || !isCoordinate(b) || (a[1] > y) === (b[1] > y)) continue;
        xs.push(Number(a[0]) + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > width) {
        width = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, y];
      }
    }
  }
  return best;

}

/**
 * @param {number[][][][]} polygons
 * @returns {number[][][]}
 */
function largestPolygon(polygons) {
  let best = [];
  let bestArea = -1;
  for (const polygon of polygons) {
    const area = Math.abs(ringArea(polygon?.[0] ?? []));
    if (area > bestArea) {
      best = polygon;
      bestArea = area;
    }
  }
  return best;
}

/**
 * @param {number[][]} ring
 * @returns {number}
 */
function ringArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const a = ring[index];
    const b = ring[index + 1];
    if (isCoordinate(a) && isCoordinate(b)) {
      area += Number(a[0]) * Number(b[1]) - Number(b[0]) * Number(a[1]);
    }
  }
  return area / 2;
}

/**
 * @param {Array<{ layerId: string, features: Array<Record<string, unknown>>, originalFeatureCount: number }>} layers
 * @param {number} maxFeatures
 * @param {number} z
 * @returns {{ layers: Array<{ layerId: string, features: Array<Record<string, unknown>>, originalFeatureCount: number }>, droppedFeatureCount: number }}
 */
function applyFeatureLimit(layers, maxFeatures, z) {
  let droppedFeatureCount = 0;
  const layerLimited = layers.map((layer) => {
    const limited = limitLayerFeatures(layer, layerFeatureLimit(layer.layerId, z), z);
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
 * @param {Array<{ layerId: string, features: Array<Record<string, unknown>>, originalFeatureCount: number }>} layers
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
 * @param {{ layerId: string, features: Array<Record<string, unknown>>, originalFeatureCount: number }} layer
 * @param {number} maxFeatures
 * @param {number} z
 * @returns {{ layerId: string, features: Array<Record<string, unknown>>, originalFeatureCount: number }}
 */
function limitLayerFeatures(layer, maxFeatures, z) {
  if (layer.features.length <= maxFeatures) {
    return layer;
  }

  return {
    ...layer,
    features: topFeatures(layer.layerId, layer.features, maxFeatures, z)
  };
}

/**
 * @param {Array<{ layerId: string, features: Array<Record<string, unknown>>, originalFeatureCount: number }>} layers
 * @param {number} maxFeatures
 * @param {number} z
 * @returns {{ layers: Array<{ layerId: string, features: Array<Record<string, unknown>>, originalFeatureCount: number }>, droppedFeatureCount: number }}
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
        priority: featurePriority(layer.layerId, feature, z),
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
 * @param {string} layerId
 * @param {Array<Record<string, unknown>>} features
 * @param {number} maxFeatures
 * @param {number} z
 * @returns {Array<Record<string, unknown>>}
 */
function topFeatures(layerId, features, maxFeatures, z) {
  return features
    .map((feature, order) => ({
      feature,
      order,
      priority: featurePriority(layerId, feature, z)
    }))
    .sort((a, b) => b.priority - a.priority || a.order - b.order)
    .slice(0, maxFeatures)
    .map((entry) => entry.feature);
}

/**
 * @param {string} layerId
 * @param {number} z
 * @returns {number}
 */
function layerFeatureLimit(layerId, z) {
  if (z <= 10) {
    const limits = {
      roads: 1800,
      landuse: 1600,
      water: 1200,
      aip: 500,
      aviation: 500,
      railways: 500,
      boundaries: 500,
      buildings: 0,
      pois: 0
    };
    return limits[layerId] ?? 500;
  }

  if (z === 11) {
    const limits = {
      roads: 3500,
      landuse: 2200,
      water: 1600,
      aip: 800,
      aviation: 800,
      railways: 800,
      boundaries: 700,
      buildings: 0,
      pois: 0
    };
    return limits[layerId] ?? 1000;
  }

  if (z === 12) {
    const limits = {
      roads: 5000,
      landuse: 2600,
      water: 1800,
      aip: 1000,
      aviation: 1000,
      railways: 1000,
      boundaries: 900,
      buildings: 300,
      pois: 0
    };
    return limits[layerId] ?? 1500;
  }

  if (z === 13) {
    const limits = {
      buildings: 900,
      pois: 0
    };
    return limits[layerId] ?? Number.MAX_SAFE_INTEGER;
  }

  if (z === 14) {
    const limits = {
      buildings: 4000,
      pois: 0
    };
    return limits[layerId] ?? Number.MAX_SAFE_INTEGER;
  }

  return Number.MAX_SAFE_INTEGER;
}

/**
 * @param {string} layerId
 * @param {Record<string, unknown>} feature
 * @param {number} z
 * @returns {number}
 */
function featurePriority(layerId, feature, z) {
  const properties = /** @type {Record<string, unknown>} */ (feature.properties ?? {});
  if (isLabelLayerId(layerId)) {
    return Number(properties.priority ?? 0);
  }

  if (layerId === 'roads') {
    return roadPriority(String(properties.highway ?? '')) + geometryImportance(feature, z);
  }

  if (layerId === 'boundaries') {
    return boundaryPriority(Number(properties.admin_level)) + geometryImportance(feature, z);
  }

  if (isAipLayer(layerId)) {
    return aviationPriority(String(properties.aeroway ?? '')) + geometryImportance(feature, z);
  }

  if (layerId === 'water') {
    return 860 + geometryImportance(feature, z);
  }

  if (layerId === 'coastline') {
    return 830 + geometryImportance(feature, z);
  }

  if (layerId === 'cliffs') {
    return 620 + geometryImportance(feature, z);
  }

  if (layerId === 'railways') {
    return 680 + geometryImportance(feature, z);
  }

  if (layerId === 'terrain') {
    return 540 + geometryImportance(feature, z);
  }

  if (layerId === 'landuse') {
    return landusePriority(properties, z) + geometryImportance(feature, z);
  }

  if (layerId === 'buildings') {
    return buildingPriority(feature, z);
  }

  if (layerId === 'pois') {
    return 60;
  }

  return 100;
}

/**
 * @param {string} highway
 * @returns {number}
 */
function roadPriority(highway) {
  const priorities = {
    motorway: 1000,
    trunk: 960,
    primary: 920,
    secondary: 880,
    motorway_link: 850,
    trunk_link: 830,
    primary_link: 780,
    tertiary: 740,
    secondary_link: 700,
    busway: 650,
    residential: 460,
    unclassified: 440,
    living_street: 420,
    service: 230,
    track: 210,
    cycleway: 190,
    path: 170,
    footway: 160,
    steps: 150
  };
  return priorities[highway] ?? 200;
}

/**
 * @param {number} adminLevel
 * @returns {number}
 */
function boundaryPriority(adminLevel) {
  if (!Number.isFinite(adminLevel)) {
    return 300;
  }

  return Math.max(100, 1000 - adminLevel * 70);
}

/**
 * @param {string} aeroway
 * @returns {number}
 */
function aviationPriority(aeroway) {
  const priorities = {
    runway: 870,
    heliport: 820,
    helipad: 800,
    taxiway: 720,
    apron: 680,
    stopway: 620,
    taxilane: 580,
    terminal: 520
  };
  return priorities[aeroway] ?? 240;
}

/**
 * @param {Record<string, unknown>} properties
 * @param {number} z
 * @returns {number}
 */
function landusePriority(properties, z) {
  const landuse = String(properties.landuse ?? '');
  const leisure = String(properties.leisure ?? '');
  const natural = String(properties.natural ?? '');
  if (['forest', 'reservoir'].includes(landuse) || ['wood', 'water'].includes(natural)) {
    return 520;
  }

  if (['residential', 'industrial', 'commercial', 'retail', 'military'].includes(landuse)) {
    return 430;
  }

  if (leisure === 'park' || landuse === 'farmland') {
    return 360;
  }

  return z < 12 ? 100 : 220;
}

/**
 * Keep early urban overview tiles useful by preferring larger building
 * footprints instead of arbitrary row order.
 *
 * @param {Record<string, unknown>} feature
 * @param {number} z
 * @returns {number}
 */
function buildingPriority(feature, z) {
  if (z >= 15) {
    return 90;
  }

  const geometry = /** @type {{ type?: string, coordinates?: unknown }} */ (feature.geometry);
  const bbox = geometryBbox(geometry);
  if (!bbox) {
    return 90;
  }

  const width = Math.max(0, bbox[2] - bbox[0]);
  const height = Math.max(0, bbox[3] - bbox[1]);
  return 90 + Math.min(260, Math.sqrt(width * height) * 30000);
}

/**
 * Give overview tiles a slight preference for larger polygons and longer lines.
 *
 * @param {Record<string, unknown>} feature
 * @param {number} z
 * @returns {number}
 */
function geometryImportance(feature, z) {
  if (z >= 13) {
    return 0;
  }

  const geometry = /** @type {{ type?: string, coordinates?: unknown }} */ (feature.geometry);
  const bbox = geometryBbox(geometry);
  if (!bbox) {
    return 0;
  }

  const width = Math.max(0, bbox[2] - bbox[0]);
  const height = Math.max(0, bbox[3] - bbox[1]);
  const score = geometry?.type?.includes('Polygon')
    ? Math.sqrt(width * height) * 15000
    : Math.hypot(width, height) * 900;

  return Math.min(180, score);
}

/**
 * @param {{ type?: string, coordinates?: unknown }} geometry
 * @returns {[number, number, number, number] | null}
 */
function geometryBbox(geometry) {
  let bbox = null;
  visitCoordinates(geometry?.coordinates, (coordinate) => {
    const x = Number(coordinate[0]);
    const y = Number(coordinate[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    if (!bbox) {
      bbox = [x, y, x, y];
      return;
    }

    bbox[0] = Math.min(bbox[0], x);
    bbox[1] = Math.min(bbox[1], y);
    bbox[2] = Math.max(bbox[2], x);
    bbox[3] = Math.max(bbox[3], y);
  });

  return bbox;
}

/**
 * @param {unknown} coordinates
 * @param {(coordinate: [number, number]) => void} callback
 */
function visitCoordinates(coordinates, callback) {
  if (!Array.isArray(coordinates)) {
    return;
  }

  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    callback(/** @type {[number, number]} */ (coordinates));
    return;
  }

  for (const item of coordinates) {
    visitCoordinates(item, callback);
  }
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
 * @param {string} layerId
 * @param {string} geometryType
 * @param {string} detail
 * @returns {number}
 */
function toleranceForZoom(z, layerId, geometryType, detail) {
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

  tolerance *= layerToleranceScale(layerId, geometryType, z);

  if (detail === 'overview') {
    tolerance *= 1.1;
  } else if (detail === 'full') {
    tolerance *= 0.3;
  }

  return Math.max(0, Number(tolerance.toFixed(2)));
}

/**
 * @param {string} layerId
 * @param {string} geometryType
 * @param {number} z
 * @returns {number}
 */
function layerToleranceScale(layerId, geometryType, z) {
  const polygon = geometryType === 'Polygon' || geometryType === 'MultiPolygon';

  if (layerId === 'roads') {
    return 0.45;
  }

  if (layerId === 'railways') {
    return 0.55;
  }

  if (isAipLayer(layerId)) {
    return 0.35;
  }

  if (layerId === 'water') {
    return polygon ? 0.65 : 0.55;
  }

  if (layerId === 'landuse') {
    return polygon ? 0.7 : 0.6;
  }

  if (layerId === 'boundaries') {
    return z <= 10 ? 0.95 : 0.75;
  }

  if (layerId === 'buildings') {
    return z <= 14 ? 0.45 : 0.25;
  }

  return polygon ? 0.75 : 0.65;
}

/**
 * Simplify geometries before MVT encoding so low zooms stay lightweight.
 *
 * @param {Array<Record<string, unknown>>} features
 * @param {[number, number, number, number]} bbox
 * @param {number} z
 * @param {string} layerId
 * @param {string} detail
 * @returns {{ features: Array<Record<string, unknown>>, stats: GeneralizationStats }}
 */
function simplifyFeatures(features, bbox, z, layerId, detail) {
  const stats = emptyGeneralizationStats();
  const tileSpan = tileSpanForBbox(bbox);
  const generalized = [];

  for (const feature of features) {
    const geometry = /** @type {{ type?: string, coordinates?: unknown }} */ (feature.geometry);
    const originalVertexCount = countGeometryVertices(geometry);
    stats.originalVertexCount += originalVertexCount;

    if (isSmallFeature(geometry, bbox, z, layerId)) {
      stats.droppedSmallFeatures += 1;
      continue;
    }

    const tolerance = simplifyToleranceDegrees(tileSpan, z, layerId, String(geometry?.type ?? ''), detail);
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
 * @param {string} layerId
 * @param {string} geometryType
 * @param {string} detail
 * @returns {number}
 */
function simplifyToleranceDegrees(tileSpan, z, layerId, geometryType, detail) {
  return (tileSpan / TILE_EXTENT) * toleranceForZoom(z, layerId, geometryType, detail);
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
 * @param {[number, number, number, number]} bbox
 * @returns {number}
 */
function tileSpanForBbox(bbox) {
  return Math.max(Math.abs(bbox[2] - bbox[0]), Math.abs(bbox[3] - bbox[1]));
}

/**
 * @param {{ type?: string, coordinates?: unknown }} geometry
 * @param {[number, number, number, number]} tileBbox
 * @param {number} z
 * @param {string} layerId
 * @returns {boolean}
 */
function isSmallFeature(geometry, tileBbox, z, layerId) {
  const minSize = minFeatureSizeTileUnits(layerId, String(geometry?.type ?? ''), z);
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
 * @param {string} layerId
 * @param {string} geometryType
 * @param {number} z
 * @returns {number}
 */
function minFeatureSizeTileUnits(layerId, geometryType, z) {
  if (z >= 15 || geometryType === 'Point') {
    return 0;
  }

  if (layerId === 'buildings') {
    if (z <= 12) return 18;
    if (z === 13) return 10;
    if (z === 14) return 5;
    return 0;
  }

  if (layerId === 'pois') {
    return z <= 14 ? 4 : 0;
  }

  if (layerId === 'boundaries') {
    return 0;
  }

  if (layerId === 'roads') {
    if (z <= 10) return 3;
    if (z <= 12) return 2;
    return 1;
  }

  if (layerId === 'railways' || isAipLayer(layerId) || layerId === 'coastline' || layerId === 'cliffs') {
    if (z <= 10) return 2;
    if (z <= 12) return 1.2;
    return 0.8;
  }

  if (layerId === 'water') {
    if (z <= 10) return 5;
    if (z <= 12) return 3;
    return 1.5;
  }

  if (layerId === 'landuse' || layerId === 'terrain') {
    if (z <= 10) return 6;
    if (z <= 12) return 4;
    return 2;
  }

  return z <= 10 ? 3 : 1;
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
 * @param {string} layerId
 * @param {string} detail
 * @returns {{ tile: { features: unknown[] }, stats: GeneralizationStats }}
 */
function createLayerTile(features, bbox, z, x, y, layerId, detail) {
  // Native Cesium styles need to distinguish polygons, lines and points in
  // mixed layers; OpenLayers obtains this directly from its decoded geometry.
  features = features.map((feature) => {
    const properties = { ...feature.properties, mapzero_geometry: feature.geometry?.type ?? '' };
    if (['roads', 'pois', 'aip', 'aviation'].includes(layerId)) {
      const anchor = labelAnchorForGeometry(feature.geometry ?? {});
      if (anchor) {
        // Original, unclipped anchors stay identical across tile and LOD borders.
        properties.mapzero_label_lon = Number(anchor[0]);
        properties.mapzero_label_lat = Number(anchor[1]);
      }
    }
    return { ...feature, properties };
  });
  const simplified = simplifyFeatures(features, bbox, z, layerId, detail);
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
