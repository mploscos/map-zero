export const SUPPORTED_LAYERS = [
  'roads',
  'buildings',
  'water',
  'terrain',
  'coastline',
  'cliffs',
  'landuse',
  'railways',
  'boundaries',
  'pois',
  'aip'
];

export const LAYER_ALIASES = {
  aviation: 'aip'
};

export const LAYER_DEFINITIONS = {
  roads: {
    type: 'line',
    gpkgGeometryType: 'LINESTRING',
    columns: ['id', 'name', 'ref', 'highway', 'layer', 'bridge', 'tunnel', 'oneway', 'junction', 'construction', 'service', 'access']
  },
  buildings: {
    type: 'polygon',
    gpkgGeometryType: 'MULTIPOLYGON',
    columns: ['id', 'name', 'building', 'height', 'min_height', 'building:levels']
  },
  water: {
    type: 'polygon',
    gpkgGeometryType: 'MULTIPOLYGON',
    columns: ['id', 'name', 'natural', 'waterway', 'landuse']
  },
  terrain: {
    type: 'polygon',
    gpkgGeometryType: 'MULTIPOLYGON',
    columns: ['id', 'name', 'natural']
  },
  coastline: {
    type: 'line',
    gpkgGeometryType: 'GEOMETRY',
    columns: ['id', 'name', 'natural']
  },
  cliffs: {
    type: 'line',
    gpkgGeometryType: 'GEOMETRY',
    columns: ['id', 'name', 'natural']
  },
  landuse: {
    type: 'polygon',
    gpkgGeometryType: 'MULTIPOLYGON',
    columns: ['id', 'name', 'landuse', 'leisure', 'natural']
  },
  railways: {
    type: 'line',
    gpkgGeometryType: 'LINESTRING',
    columns: ['id', 'name', 'railway']
  },
  boundaries: {
    type: 'line',
    gpkgGeometryType: 'GEOMETRY',
    columns: ['id', 'name', 'admin_level']
  },
  pois: {
    type: 'point',
    gpkgGeometryType: 'POINT',
    columns: [
      'id',
      'name',
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
    ]
  },
  aip: {
    type: 'mixed',
    gpkgGeometryType: 'GEOMETRY',
    columns: ['id', 'name', 'aeroway', 'ref', 'surface', 'width', 'length']
  }
};

/**
 * Normalize public layer aliases to the canonical map-zero layer id.
 *
 * @param {string} layerId
 * @returns {string}
 */
export function normalizeLayerId(layerId) {
  return LAYER_ALIASES[layerId] ?? layerId;
}

/**
 * Find logical way layers for an OSM tag set.
 *
 * @param {Record<string, string>} tags
 * @param {Set<string>} selectedLayers
 * @returns {string[]}
 */
export function layersForWay(tags, selectedLayers) {
  /** @type {string[]} */
  const layers = [];

  if (selectedLayers.has('roads') && tags.highway) {
    layers.push('roads');
  }

  if (selectedLayers.has('buildings') && tags.building) {
    layers.push('buildings');
  }

  if (selectedLayers.has('water') && isWater(tags)) {
    layers.push('water');
  }

  if (selectedLayers.has('terrain') && isTerrain(tags)) {
    layers.push('terrain');
  }

  if (selectedLayers.has('coastline') && tags.natural === 'coastline') {
    layers.push('coastline');
  }

  if (selectedLayers.has('cliffs') && tags.natural === 'cliff') {
    layers.push('cliffs');
  }

  if (selectedLayers.has('landuse') && isLanduse(tags)) {
    layers.push('landuse');
  }

  if (selectedLayers.has('railways') && tags.railway) {
    layers.push('railways');
  }

  if (selectedLayers.has('boundaries') && tags.boundary === 'administrative') {
    layers.push('boundaries');
  }

  if (selectedLayers.has('aip') && tags.aeroway) {
    layers.push('aip');
  }

  if (selectedLayers.has('pois') && isPoi(tags)) {
    layers.push('pois');
  }

  return layers;
}

/**
 * Find logical relation layers for an OSM tag set.
 *
 * @param {Record<string, string>} tags
 * @param {Set<string>} selectedLayers
 * @returns {string[]}
 */
export function layersForRelation(tags, selectedLayers) {
  /** @type {string[]} */
  const layers = [];

  if (selectedLayers.has('buildings') && tags.building) {
    layers.push('buildings');
  }

  if (selectedLayers.has('water') && isWater(tags)) {
    layers.push('water');
  }

  if (selectedLayers.has('terrain') && isTerrain(tags)) {
    layers.push('terrain');
  }

  if (selectedLayers.has('coastline') && tags.natural === 'coastline') {
    layers.push('coastline');
  }

  if (selectedLayers.has('cliffs') && tags.natural === 'cliff') {
    layers.push('cliffs');
  }

  if (selectedLayers.has('landuse') && isLanduse(tags)) {
    layers.push('landuse');
  }

  if (selectedLayers.has('boundaries') && tags.boundary === 'administrative') {
    layers.push('boundaries');
  }

  if (selectedLayers.has('aip') && tags.aeroway) {
    layers.push('aip');
  }

  if (selectedLayers.has('pois') && isPoi(tags)) {
    layers.push('pois');
  }

  return layers;
}

/**
 * Check whether OSM entity tags should become a POI.
 *
 * @param {Record<string, string>} tags
 * @returns {boolean}
 */
export function isPoi(tags) {
  return Boolean(
    tags.amenity ||
    tags.tourism ||
    tags.shop ||
    tags.leisure ||
    isRailwayPoi(tags.railway) ||
    isPublicTransportPoi(tags.public_transport) ||
    isAerowayPoi(tags.aeroway) ||
    tags.power ||
    tags.man_made ||
    tags.military ||
    tags.emergency ||
    tags.office ||
    tags.government ||
    tags.boundary === 'protected_area' ||
    tags.protect_class ||
    tags.landuse === 'industrial' ||
    tags.industrial
  );
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isRailwayPoi(value) {
  return ['station', 'halt', 'tram_stop', 'subway_entrance', 'stop'].includes(String(value));
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isPublicTransportPoi(value) {
  return ['station', 'stop_area'].includes(String(value));
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isAerowayPoi(value) {
  return ['aerodrome', 'airport', 'heliport', 'helipad', 'terminal'].includes(String(value));
}

/**
 * Build the table properties for a logical layer.
 *
 * @param {string} layer
 * @param {{ id: string | number, type: string, tags: Record<string, string> }} entity
 * @returns {Record<string, string | null>}
 */
export function propertiesForLayer(layer, entity) {
  const definition = LAYER_DEFINITIONS[layer];
  const tags = entity.tags;
  /** @type {Record<string, string | null>} */
  const properties = {};

  for (const column of definition.columns) {
    if (column === 'id') {
      properties[column] = `${entity.type}/${entity.id}`;
    } else if (column === 'poi_category') {
      properties[column] = layer === 'pois' ? poiCategory(tags) : null;
    } else {
      properties[column] = tags[column] ?? null;
    }
  }

  return properties;
}

/**
 * Classify operational POIs into broad infrastructure categories.
 *
 * @param {Record<string, string>} tags
 * @returns {string}
 */
function poiCategory(tags) {
  const amenity = tags.amenity;
  const tourism = tags.tourism;
  const shop = tags.shop;
  const leisure = tags.leisure;
  const railway = tags.railway;
  const publicTransport = tags.public_transport;
  const station = tags.station;
  const aeroway = tags.aeroway;
  const power = tags.power;
  const manMade = tags.man_made;
  const towerType = tags['tower:type'];
  const military = tags.military;
  const emergency = tags.emergency;
  const office = tags.office;
  const government = tags.government;
  const boundary = tags.boundary;
  const protectClass = tags.protect_class;
  const landuse = tags.landuse;
  const industrial = tags.industrial;

  if (
    ['railway_station', 'train_station', 'subway_station', 'bus_station', 'ferry_terminal'].includes(String(amenity)) ||
    railway === 'station' ||
    publicTransport === 'station' ||
    station === 'subway' ||
    aeroway === 'aerodrome' ||
    aeroway === 'airport' ||
    amenity === 'airport'
  ) {
    return 'transport';
  }

  if (['hospital', 'police', 'fire_station', 'shelter'].includes(String(amenity)) || isOperationalEmergency(emergency)) {
    return 'emergency';
  }

  if (['townhall', 'courthouse', 'prison', 'embassy'].includes(String(amenity)) || office === 'government' || government) {
    return 'government';
  }

  if (power) {
    return 'energy';
  }

  if (
    amenity === 'communications_tower' ||
    manMade === 'communications_tower' ||
    manMade === 'mast' ||
    manMade === 'antenna' ||
    towerType === 'communication' ||
    tags.radar
  ) {
    return 'communications';
  }

  if (boundary === 'protected_area' || leisure === 'nature_reserve' || tourism === 'national_park' || protectClass) {
    return 'protected';
  }

  if (landuse === 'industrial' || industrial || ['depot', 'warehouse'].includes(String(amenity))) {
    return 'industrial';
  }

  if (military || ['bunker', 'checkpoint'].includes(String(amenity))) {
    return 'military';
  }

  if (shop || tourism || leisure || ['restaurant', 'cafe', 'bar', 'fast_food', 'pub'].includes(String(amenity))) {
    return 'consumer';
  }

  return 'operational';
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isOperationalEmergency(value) {
  return ['ambulance_station', 'siren', 'assembly_point', 'disaster_response'].includes(String(value));
}

/**
 * @param {Record<string, string>} tags
 * @returns {boolean}
 */
function isWater(tags) {
  return tags.natural === 'water' || tags.waterway === 'riverbank' || tags.landuse === 'reservoir';
}

/**
 * @param {Record<string, string>} tags
 * @returns {boolean}
 */
function isTerrain(tags) {
  return tags.natural === 'beach' || tags.natural === 'sand';
}

/**
 * @param {Record<string, string>} tags
 * @returns {boolean}
 */
function isLanduse(tags) {
  return Boolean(tags.landuse || tags.leisure === 'park' || tags.natural === 'wood');
}
