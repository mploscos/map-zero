/** Shared label selection and styling; no renderer dependency. */
export const LABEL_SOURCE_LAYERS = ['roads', 'aip', 'aviation', 'pois'];
export const ROAD_SOURCE_LAYER = 'roads';
export const AIP_SOURCE_LAYERS = new Set(['aip', 'aviation']);
export const POI_SOURCE_LAYER = 'pois';

const MAJOR_ROADS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']);
const SECONDARY_ROADS = new Set(['secondary', 'secondary_link']);
const LOCAL_ROADS = new Set(['residential', 'living_street', 'unclassified']);
const DISABLED_ROADS = new Set(['service', 'track', 'path', 'footway', 'cycleway', 'steps', 'corridor', 'platform']);
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
const DEFAULT_POI_CLASSES = {
  amenity: [
    'hospital',
    'police',
    'fire_station',
    'bus_station',
    'ferry_terminal',
    'shelter',
    'townhall',
    'courthouse',
    'prison',
    'ranger_station',
    'research_institute',
    'airport',
    'railway_station',
    'train_station',
    'subway_station',
    'communications_tower',
    'bunker',
    'checkpoint',
    'depot',
    'warehouse'
  ],
  tourism: ['information'],
  shop: [],
  leisure: ['nature_reserve'],
  railway: ['station'],
  public_transport: ['station'],
  station: ['subway'],
  aeroway: ['aerodrome', 'airport'],
  power: ['plant', 'substation', 'generator', 'tower', 'transformer', 'line'],
  man_made: ['communications_tower', 'mast', 'antenna'],
  'tower:type': ['communication'],
  military: ['barracks', 'bunker', 'checkpoint', 'airbase', 'naval_base', 'range', 'training_area', 'base', 'airfield', 'danger_area', 'ammunition_dump'],
  emergency: ['ambulance_station', 'siren', 'assembly_point', 'disaster_response'],
  office: ['government'],
  government: ['yes', 'public_safety', 'border_control', 'customs', 'ministry', 'aerospace'],
  boundary: ['protected_area'],
  industrial: ['refinery', 'depot', 'storage', 'logistics'],
  landuse: ['industrial']
};



export function activeLabelLayerIdsForZoom(orderedLayers, styleDocument, layerVisibility, zoom) {
  const labels = labelConfigRoot(styleDocument);
  if (!labels || labels.enabled === false) {
    return [];
  }

  return LABEL_SOURCE_LAYERS.filter((layerId) => {
    const rule = labelRuleForSource(styleDocument, layerId);
    if (!rule || rule.enabled === false) {
      return false;
    }

    if (!orderedLayers.some((layer) => layer.id === layerId) || !layerVisibility.get(layerId)) {
      return false;
    }

    return zoomInRule(zoom, rule);
  });
}

export function hasEnabledLabels(styleDocument) {
  const labels = labelConfigRoot(styleDocument);
  return Boolean(labels && labels.enabled !== false && LABEL_SOURCE_LAYERS.some((layerId) => {
    const rule = labelRuleForSource(styleDocument, layerId);
    return rule && rule.enabled !== false;
  }));
}

export function isPoiLikeFeature(feature) {
  return [
    'poi_category',
    'amenity',
    'tourism',
    'shop',
    'leisure',
    'railway',
    'public_transport',
    'station',
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
  ].some((property) => cleanText(feature.get(property)));
}

export function isSelectedPoiCandidate(feature, rule) {
  const className = cleanText(feature.get('class'));
  if (!className || ['clinic', 'pharmacy', 'fuel', 'charging_station', 'fire_hydrant', 'defibrillator', 'fire_extinguisher', 'restaurant', 'cafe', 'bar', 'fast_food', 'pub'].includes(className)) {
    return false;
  }

  const selected = objectRule(rule.classes) ?? DEFAULT_POI_CLASSES;
  return Object.values(selected).some((values) => Array.isArray(values) && values.map(String).includes(className));
}

export function roadLabel(feature, highway, zoom, rule) {
  if (!highway || DISABLED_ROADS.has(highway)) {
    return null;
  }

  const local = objectRule(rule.local);
  if (LOCAL_ROADS.has(highway) && local?.enabled !== true) {
    return null;
  }

  const ref = cleanText(feature.get('ref'));
  const name = cleanText(feature.get('name'));

  if (MAJOR_ROADS.has(highway)) {
    const minZoom = Number(rule.majorMinZoom ?? 12);
    if (zoom < minZoom || !isMeaningfulLabel(ref)) return null;
    return { text: ref, priorityClass: 'important', zIndex: 820 };
  }

  if (SECONDARY_ROADS.has(highway)) {
    const minZoom = Number(rule.secondaryMinZoom ?? 16);
    if (zoom < minZoom || !isMeaningfulLabel(ref)) return null;
    return { text: ref, priorityClass: 'normal', zIndex: 700 };
  }

  if (LOCAL_ROADS.has(highway)) {
    const minZoom = Number(local?.minZoom ?? 17);
    if (zoom < minZoom || !isMeaningfulLabel(name)) return null;
    return { text: name, priorityClass: 'low', zIndex: 400 };
  }

  return null;
}

export function aviationLabel(feature, aeroway, zoom) {
  if (!aeroway) {
    return null;
  }

  const ref = cleanText(feature.get('ref'));
  const name = cleanText(feature.get('name'));

  if (aeroway === 'aerodrome' || aeroway === 'heliport') {
    const text = name || aviationRefText(ref) || aviationFallbackText(aeroway);
    return isRenderableAviationText(text, aeroway) && zoom >= 9
      ? { text, placement: 'point', priorityClass: 'critical', zIndex: 980 }
      : null;
  }

  if (aeroway === 'runway') {
    const text = aviationRefText(ref) || name || 'RWY';
    return isRenderableAviationText(text, aeroway) && zoom >= 11 ? { text, placement: 'line', priorityClass: 'important', zIndex: 900 } : null;
  }

  if (aeroway === 'terminal' || aeroway === 'apron') {
    const text = name || ref || aviationFallbackText(aeroway);
    return isMeaningfulLabel(text) && zoom >= 14 ? { text, placement: 'point', priorityClass: 'normal', zIndex: 720 } : null;
  }

  if (aeroway === 'helipad') {
    const text = aviationRefText(ref) || name || 'H';
    return isRenderableAviationText(text, aeroway) && zoom >= 12 ? { text, placement: 'point', priorityClass: 'critical', zIndex: 980 } : null;
  }

  return null;
}

export function aviationFallbackText(aeroway) {
  if (aeroway === 'aerodrome') return 'Aerodrome';
  if (aeroway === 'heliport') return 'Heliport';
  if (aeroway === 'terminal') return 'Terminal';
  if (aeroway === 'apron') return 'Apron';
  return cleanText(aeroway).replace(/_/g, ' ');
}

export function isSelectedPoi(feature, rule) {
  const categories = objectRule(rule.categories);
  const category = poiCategoryForFeature(feature);
  if (category && categories?.[category] === false) {
    return false;
  }

  const matchesClass = matchesSelectedPoiClass(feature, rule);
  return matchesClass;
}

export function matchesSelectedPoiClass(feature, rule) {
  const selected = objectRule(rule.classes) ?? DEFAULT_POI_CLASSES;
  for (const property of [
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
  ]) {
    const value = String(feature.get(property) ?? '');
    const allowed = Array.isArray(selected[property]) ? /** @type {unknown[]} */ (selected[property]).map(String) : [];
    if (value && allowed.includes(value)) {
      return true;
    }
  }
  return false;
}

export function poiLabelText(feature) {
  for (const field of LABEL_TEXT_FIELDS) {
    const text = cleanText(feature.get(field));
    if (isMeaningfulLabel(text)) {
      return text;
    }
  }

  return poiFallbackLabel(feature);
}

export function poiFallbackLabel(feature) {
  const candidates = [
    ['military', {
      airbase: 'Airbase',
      airfield: 'Airfield',
      barracks: 'Barracks',
      bunker: 'Bunker',
      checkpoint: 'Checkpoint',
      naval_base: 'Naval base',
      range: 'Range',
      training_area: 'Training area',
      danger_area: 'Danger area',
      ammunition_dump: 'Ammunition dump',
      base: 'Base'
    }],
    ['emergency', {
      ambulance_station: 'Ambulance station',
      siren: 'Siren',
      assembly_point: 'Assembly point',
      disaster_response: 'Disaster response'
    }],
    ['amenity', {
      hospital: 'Hospital',
      police: 'Police',
      fire_station: 'Fire station',
      shelter: 'Shelter',
      bunker: 'Bunker',
      checkpoint: 'Checkpoint',
      depot: 'Depot',
      warehouse: 'Warehouse',
      prison: 'Prison',
      courthouse: 'Courthouse',
      townhall: 'Town hall',
      bus_station: 'Bus station',
      ferry_terminal: 'Ferry terminal'
    }],
    ['power', {
      plant: 'Power plant',
      substation: 'Substation',
      generator: 'Generator',
      tower: 'Power tower',
      transformer: 'Transformer',
      line: 'Power line'
    }],
    ['man_made', {
      communications_tower: 'Comms tower',
      mast: 'Mast',
      antenna: 'Antenna'
    }],
    ['boundary', {
      protected_area: 'Protected area'
    }],
    ['landuse', {
      industrial: 'Industrial'
    }],
    ['industrial', {
      refinery: 'Refinery',
      depot: 'Depot',
      storage: 'Storage',
      logistics: 'Logistics'
    }]
  ];

  for (const [property, labels] of candidates) {
    const value = cleanText(feature.get(property));
    if (value && labels[value]) {
      return labels[value];
    }
  }

  const category = poiCategoryForFeature(feature);
  return category === 'consumer' ? '' : titleCase(category);
}

export function poiCategoryForFeature(feature) {
  const existing = cleanText(feature.get('poi_category'));
  if (existing) {
    return existing;
  }

  const amenity = cleanText(feature.get('amenity'));
  const tourism = cleanText(feature.get('tourism'));
  const shop = cleanText(feature.get('shop'));
  const leisure = cleanText(feature.get('leisure'));
  const railway = cleanText(feature.get('railway'));
  const publicTransport = cleanText(feature.get('public_transport'));
  const station = cleanText(feature.get('station'));
  const aeroway = cleanText(feature.get('aeroway'));
  const power = cleanText(feature.get('power'));
  const manMade = cleanText(feature.get('man_made'));
  const towerType = cleanText(feature.get('tower:type'));
  const military = cleanText(feature.get('military'));
  const emergency = cleanText(feature.get('emergency'));
  const office = cleanText(feature.get('office'));
  const government = cleanText(feature.get('government'));
  const boundary = cleanText(feature.get('boundary'));
  const protectClass = cleanText(feature.get('protect_class'));
  const landuse = cleanText(feature.get('landuse'));
  const industrial = cleanText(feature.get('industrial'));

  if (['railway_station', 'train_station', 'subway_station', 'bus_station', 'ferry_terminal', 'airport'].includes(amenity) ||
    railway === 'station' || publicTransport === 'station' || station === 'subway' || aeroway === 'aerodrome' || aeroway === 'airport') {
    return 'transport';
  }
  if (['hospital', 'police', 'fire_station', 'shelter'].includes(amenity) || ['ambulance_station', 'siren', 'assembly_point', 'disaster_response'].includes(emergency)) return 'emergency';
  if (['townhall', 'courthouse', 'prison', 'embassy'].includes(amenity) || office === 'government' || government) return 'government';
  if (power) return 'energy';
  if (amenity === 'communications_tower' || manMade === 'communications_tower' || manMade === 'mast' || manMade === 'antenna' || towerType === 'communication') return 'communications';
  if (boundary === 'protected_area' || leisure === 'nature_reserve' || tourism === 'national_park' || protectClass) return 'protected';
  if (landuse === 'industrial' || industrial || ['depot', 'warehouse'].includes(amenity)) return 'industrial';
  if (military || ['bunker', 'checkpoint'].includes(amenity)) return 'military';
  if (shop || tourism || leisure || ['restaurant', 'cafe', 'bar', 'fast_food', 'pub'].includes(amenity)) return 'consumer';
  return 'operational';
}

export function priorityClassFromNumber(priority) {
  if (priority >= 900) return 'critical';
  if (priority >= 760) return 'important';
  if (priority >= 500) return 'normal';
  return 'low';
}

export function poiPriorityClass(feature) {
  const category = String(feature.get('poi_category') ?? '');
  if (category === 'emergency' || category === 'military') {
    return 'critical';
  }
  if (['transport', 'energy', 'communications', 'government'].includes(category)) {
    return 'important';
  }

  const amenity = String(feature.get('amenity') ?? '');
  if (amenity === 'hospital' || amenity === 'police' || amenity === 'fire_station') {
    return 'critical';
  }
  return 'normal';
}

export function poiZIndex(feature) {
  const priority = poiPriorityClass(feature);
  if (priority === 'critical') return 920;
  if (priority === 'important') return 820;
  return 620;
}

export function labelFont(rule, priorityRule, zoom) {
  const configured = String(priorityRule.font ?? rule.font ?? '').trim();
  if (configured) {
    return configured;
  }

  const weight = String(priorityRule.weight ?? rule.weight ?? 600);
  const size = zoom >= 17 ? 12 : zoom >= 15 ? 11 : 10;
  return `${weight} ${size}px sans-serif`;
}

export function priorityClassRule(styleDocument, className) {
  const labels = labelConfigRoot(styleDocument);
  const classes = labels?.priorityClasses && typeof labels.priorityClasses === 'object'
    ? /** @type {Record<string, unknown>} */ (labels.priorityClasses)
    : {};
  const rule = classes[className];
  return rule && typeof rule === 'object' ? /** @type {Record<string, unknown>} */ (rule) : {};
}

export function labelOpacityForZoom(zoom, base) {
  if (zoom < 12.5) return base * 0.6;
  if (zoom < 14) return base * 0.76;
  return base;
}

export function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function titleCase(value) {
  return cleanText(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function isMeaningfulLabel(text) {
  const normalized = cleanText(text);
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

export function isExplicitAviationLabel(feature, sourceLayer, text) {
  if (!AIP_SOURCE_LAYERS.has(sourceLayer)) {
    return false;
  }

  const aeroway = cleanText(feature.get('aeroway') || feature.get('class'));
  if (text === 'H') {
    return aeroway === 'helipad' || aeroway === 'heliport';
  }

  if (text === 'RWY') {
    return aeroway === 'runway';
  }

  return /^[A-Z]$/.test(text) && ['helipad', 'heliport', 'runway'].includes(aeroway);
}

export function aviationRefText(ref) {
  return ref && !/^(yes|no|true|false|0|1)$/i.test(ref) ? ref : '';
}

export function isRenderableAviationText(text, aeroway) {
  if (isMeaningfulLabel(text)) {
    return true;
  }

  if (text === 'H') {
    return aeroway === 'helipad' || aeroway === 'heliport';
  }

  if (text === 'RWY') {
    return aeroway === 'runway';
  }

  return /^[A-Z]$/.test(text) && ['helipad', 'heliport', 'runway'].includes(aeroway);
}

export function labelConfigRoot(styleDocument) {
  return styleDocument.labels && typeof styleDocument.labels === 'object'
    ? /** @type {Record<string, unknown>} */ (styleDocument.labels)
    : null;
}

export function labelRuleForSource(styleDocument, sourceLayer) {
  const labels = labelConfigRoot(styleDocument);
  const rule = labels?.[sourceLayer] ?? labels?.[labelSourceAlias(sourceLayer)];
  return rule && typeof rule === 'object' ? /** @type {Record<string, unknown>} */ (rule) : null;
}

export function labelSourceAlias(sourceLayer) {
  if (sourceLayer === 'aip') return 'aviation';
  if (sourceLayer === 'aviation') return 'aip';
  return sourceLayer;
}

export function objectRule(rule) {
  return rule && typeof rule === 'object' ? /** @type {Record<string, unknown>} */ (rule) : null;
}

export function zoomInRule(zoom, rule) {
  const minZoom = Number(rule.minZoom ?? 0);
  const maxZoom = Number(rule.maxZoom ?? 22);
  return (!Number.isFinite(minZoom) || zoom >= minZoom) && (!Number.isFinite(maxZoom) || zoom <= maxZoom);
}

export function resolutionToZoom(resolution) {
  const initialResolution = 156543.03392804097;
  return Math.log2(initialResolution / Number(resolution));
}

export function rgba(color, opacity) {
  const rgb = hexToRgb(color);
  if (!rgb) {
    return color;
  }
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(opacity, 0, 1)})`;
}

export function hexToRgb(color) {
  const match = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

/** A renderer-independent label descriptor, using the same policy as OL. */
export function describeLabel(feature, sourceLayer, zoom, styleDocument) {
  if (!hasEnabledLabels(styleDocument)) return null;
  const rule = labelRuleForSource(styleDocument, sourceLayer);
  if (!rule || rule.enabled === false || !zoomInRule(zoom, rule)) return null;
  let label;
  if (sourceLayer === 'roads') {
    label = roadLabel(feature, String(feature.get('highway') ?? ''), zoom, rule);
  } else if (sourceLayer === 'aip' || sourceLayer === 'aviation') {
    label = aviationLabel(feature, String(feature.get('aeroway') ?? ''), zoom);
  } else if (sourceLayer === 'pois' && isSelectedPoi(feature, rule)) {
    label = { text: poiLabelText(feature), priorityClass: poiPriorityClass(feature), zIndex: poiZIndex(feature) };
  }
  if (!label?.text) return null;
  const priority = priorityClassRule(styleDocument, label.priorityClass);
  const opacity = labelOpacityForZoom(zoom, Number(priority.opacity ?? rule.opacity ?? 0.82));
  return {
    text: label.text, priority: label.zIndex,
    font: labelFont(rule, priority, zoom),
    fill: rgba(String(priority.fill ?? rule.fill ?? '#d9fbff'), opacity),
    halo: rgba(String(priority.halo ?? rule.halo ?? '#001014'), Math.min(1, opacity + 0.12)),
    haloWidth: Number(priority.haloWidth ?? rule.haloWidth ?? 3)
  };
}
