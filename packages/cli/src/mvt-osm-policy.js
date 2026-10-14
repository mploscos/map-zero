import { SUPPORTED_LAYERS } from './layers.js';
import { geometryBbox, labelAnchorForGeometry, tileSpanForBbox, topFeatures } from './mvt-utils.js';

const TILE_EXTENT = 4096;
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
 * Map-zero's default OSM cartography. Unknown IDs use the encoder's generic
 * defaults. Callers can delegate here when extending the built-in policies.
 *
 * @param {string} layerId
 * @returns {import('./mvt.js').MvtLayerPolicy | undefined}
 */
export function getOsmLayerPolicy(layerId) {
  if (!SUPPORTED_LAYERS.includes(layerId) && !isAipLayer(layerId) && !isLabelLayerId(layerId)) {
    return undefined;
  }
  const sourceLayer = LABEL_LAYERS[layerId]?.sourceLayer;
  const sourceId = sourceLayer ?? layerId;
  return {
    sourceLayer,
    aliases: isAipLayer(sourceId) ? [sourceId === 'aip' ? 'aviation' : 'aip'] : [],
    readFeatures: (reader, { bbox, z, style, debugLabels }) => isLabelLayerId(layerId)
      ? readLabelLayerFeatures(reader, layerId, bbox, z, style, debugLabels)
      : readLayerFeatures(reader, layerId, bbox, z, style),
    featureLimit: (z) => layerFeatureLimit(layerId, z),
    featurePriority: (feature, z) => featurePriority(layerId, feature, z),
    toleranceScale: (geometryType, z) => layerToleranceScale(layerId, geometryType, z),
    minFeatureSize: (geometryType, z) => minFeatureSizeTileUnits(layerId, geometryType, z),
    prepareFeatures: ['roads', 'pois', 'aip', 'aviation'].includes(layerId) ? addLabelAnchors : undefined
  };
}

/**
 * Original, unclipped anchors stay identical across tile and LOD borders.
 * @param {Array<Record<string, unknown>>} features
 * @returns {Array<Record<string, unknown>>}
 */
function addLabelAnchors(features) {
  return features.map((feature) => {
    const anchor = labelAnchorForGeometry(feature.geometry ?? {});
    if (!anchor) return feature;
    return {
      ...feature,
      properties: {
        ...feature.properties,
        mapzero_label_lon: Number(anchor[0]),
        mapzero_label_lat: Number(anchor[1])
      }
    };
  });
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
    features: topFeatures(candidates, labelFeatureLimit(layerId, z), (feature) => featurePriority(layerId, feature, z)),
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
 * @param {string} layerId
 * @returns {boolean}
 */
function isLabelLayerId(layerId) {
  return Object.hasOwn(LABEL_LAYERS, layerId);
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
