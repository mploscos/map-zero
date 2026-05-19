import Feature from 'ol/Feature.js';
import MVT from 'ol/format/MVT.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import Fill from 'ol/style/Fill.js';
import Stroke from 'ol/style/Stroke.js';
import Style from 'ol/style/Style.js';
import Text from 'ol/style/Text.js';

const LABEL_SOURCE_LAYERS = ['roads', 'aip', 'aviation', 'pois'];
const ROAD_SOURCE_LAYER = 'roads';
const AIP_SOURCE_LAYERS = new Set(['aip', 'aviation']);
const POI_SOURCE_LAYER = 'pois';

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

/**
 * Tiny full-label bitmap atlas kept for future point-label experiments.
 */
export class LabelAtlas {
  constructor() {
    this.map = new Map();
  }
}

/**
 * Create a standard OpenLayers vector tile label layer.
 *
 * Geometry rendering stays on the existing WebGLVectorTileLayer. This layer is
 * only for labels, using OpenLayers text placement and decluttering.
 *
 * @param {{
 *   instanceId?: string,
 *   tileUrlFunction: (tileCoord: number[] | null) => string | undefined,
 *   loadTileData: (tileCoord: number[], url: string | undefined) => Promise<ArrayBuffer | Uint8Array | null>,
 *   sourceOptions?: Record<string, unknown>,
 *   styleDocument: Record<string, unknown>,
 *   onTileLoadStart?: () => void,
 *   onTileLoadEnd?: () => void,
 *   onTileLoadError?: () => void
 * }} options
 * @returns {{ layer: VectorTileLayer, source: VectorTileSource, attachMap: () => void, detachMap: () => void, refresh: () => void, destroy: () => void }}
 */
export function createMapZeroLabelLayer(options) {
  const format = new MVT({ featureClass: Feature });
  const source = new VectorTileSource({
    format,
    maxZoom: 22,
    ...(options.sourceOptions ?? {}),
    cacheSize: 512,
    transition: 0,
    wrapX: false,
    tileUrlFunction: options.tileUrlFunction,
    tileLoadFunction: (tile) => {
      tile.setLoader((extent, resolution, projection) => {
        const tileCoord = tile.getTileCoord();
        const url = options.tileUrlFunction(tileCoord);
        if (!url) {
          tile.setFeatures([]);
          return;
        }

        options.loadTileData(tileCoord, url)
          .then((data) => {
            if (!data) {
              tile.setFeatures([]);
              return;
            }

            tile.setFeatures(format.readFeatures(data, {
              extent,
              featureProjection: projection
            }));
          })
          .catch(() => {
            tile.setFeatures([]);
          });
      });
    }
  });

  if (options.onTileLoadStart) source.on('tileloadstart', options.onTileLoadStart);
  if (options.onTileLoadEnd) source.on('tileloadend', options.onTileLoadEnd);
  if (options.onTileLoadError) source.on('tileloaderror', options.onTileLoadError);

  const styleCache = new Map();
  const layer = new VectorTileLayer({
    source,
    declutter: true,
    updateWhileAnimating: false,
    updateWhileInteracting: false,
    style: (feature, resolution) => labelStyle(feature, resolution, options.styleDocument, styleCache)
  });
  if (typeof layer.set === 'function' && options.instanceId) {
    layer.set('mapzero:id', options.instanceId);
    layer.set('mapzero:role', 'labels');
    layer.set('mapzero:sourceLayerIds', LABEL_SOURCE_LAYERS.map((layerId) => `${options.instanceId}:${layerId}`));
  }

  return {
    layer,
    source,
    attachMap() {},
    detachMap() {},
    refresh() {
      source.setTileUrlFunction(options.tileUrlFunction, String(Date.now()));
      source.clear();
      styleCache.clear();
      layer.changed();
    },
    destroy() {
      source.clear();
      layer.dispose();
    }
  };
}

/**
 * Return source MVT layer ids needed by the label renderer.
 *
 * @param {Array<{ id: string, type?: string, style?: string }>} orderedLayers
 * @param {Record<string, unknown>} styleDocument
 * @param {Map<string, boolean>} layerVisibility
 * @param {number} zoom
 * @returns {string[]}
 */
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

/**
 * @param {Record<string, unknown>} styleDocument
 * @returns {boolean}
 */
export function hasEnabledLabels(styleDocument) {
  const labels = labelConfigRoot(styleDocument);
  return Boolean(labels && labels.enabled !== false && LABEL_SOURCE_LAYERS.some((layerId) => {
    const rule = labelRuleForSource(styleDocument, layerId);
    return rule && rule.enabled !== false;
  }));
}

/**
 * @param {Feature} feature
 * @param {number} resolution
 * @param {Record<string, unknown>} styleDocument
 * @param {Map<string, Style>} styleCache
 * @returns {Style | null}
 */
function labelStyle(feature, resolution, styleDocument, styleCache) {
  const zoom = resolutionToZoom(resolution);
  const sourceLayer = cleanText(feature.get('sourceLayer'));
  if (sourceLayer && cleanText(feature.get('text'))) {
    return candidateLabelStyle(feature, sourceLayer, zoom, styleDocument, styleCache);
  }

  if (feature.get('highway')) {
    return roadLabelStyle(feature, zoom, styleDocument, styleCache);
  }

  if (feature.get('aeroway')) {
    return aviationLabelStyle(feature, zoom, styleDocument, styleCache);
  }

  if (isPoiLikeFeature(feature)) {
    return poiLabelStyle(feature, zoom, styleDocument, styleCache);
  }

  return null;
}

/**
 * @param {Feature} feature
 * @returns {boolean}
 */
function isPoiLikeFeature(feature) {
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

/**
 * @param {Feature} feature
 * @param {string} sourceLayer
 * @param {number} zoom
 * @param {Record<string, unknown>} styleDocument
 * @param {Map<string, Style>} styleCache
 * @returns {Style | null}
 */
function candidateLabelStyle(feature, sourceLayer, zoom, styleDocument, styleCache) {
  const rule = labelRuleForSource(styleDocument, sourceLayer);
  const minZoom = Number(feature.get('minZoom') ?? rule?.minZoom ?? 0);
  const text = cleanText(feature.get('text'));
  if (!rule || rule.enabled === false || !zoomInRule(zoom, rule) || zoom < minZoom) {
    return null;
  }

  if (!isMeaningfulLabel(text) && !isExplicitAviationLabel(feature, sourceLayer, text)) {
    return null;
  }

  if (sourceLayer === POI_SOURCE_LAYER && !isSelectedPoiCandidate(feature, rule)) {
    return null;
  }

  return textStyle({
    cache: styleCache,
    styleDocument,
    rule,
    text,
    placement: 'point',
    priorityClass: priorityClassFromNumber(Number(feature.get('priority') ?? 0)),
    zIndex: Number(feature.get('priority') ?? 0),
    zoom
  });
}

/**
 * @param {Feature} feature
 * @param {Record<string, unknown>} rule
 * @returns {boolean}
 */
function isSelectedPoiCandidate(feature, rule) {
  const className = cleanText(feature.get('class'));
  if (!className || ['clinic', 'pharmacy', 'fuel', 'charging_station', 'fire_hydrant', 'defibrillator', 'fire_extinguisher', 'restaurant', 'cafe', 'bar', 'fast_food', 'pub'].includes(className)) {
    return false;
  }

  const selected = objectRule(rule.classes) ?? DEFAULT_POI_CLASSES;
  return Object.values(selected).some((values) => Array.isArray(values) && values.map(String).includes(className));
}

/**
 * @param {Feature} feature
 * @param {number} zoom
 * @param {Record<string, unknown>} styleDocument
 * @param {Map<string, Style>} styleCache
 * @returns {Style | null}
 */
function roadLabelStyle(feature, zoom, styleDocument, styleCache) {
  const rule = labelRuleForSource(styleDocument, ROAD_SOURCE_LAYER);
  if (!rule || rule.enabled === false || !zoomInRule(zoom, rule)) {
    return null;
  }

  const highway = String(feature.get('highway') ?? '');
  const label = roadLabel(feature, highway, zoom, rule);
  if (!label) {
    return null;
  }

  return textStyle({
    cache: styleCache,
    styleDocument,
    rule,
    text: label.text,
    placement: 'line',
    priorityClass: label.priorityClass,
    zIndex: label.zIndex,
    zoom
  });
}

/**
 * @param {Feature} feature
 * @param {number} zoom
 * @param {Record<string, unknown>} styleDocument
 * @param {Map<string, Style>} styleCache
 * @returns {Style | null}
 */
function aviationLabelStyle(feature, zoom, styleDocument, styleCache) {
  const rule = labelRuleForSource(styleDocument, 'aip');
  if (!rule || rule.enabled === false || !zoomInRule(zoom, rule)) {
    return null;
  }

  const aeroway = String(feature.get('aeroway') ?? '');
  const label = aviationLabel(feature, aeroway, zoom);
  if (!label) {
    return null;
  }

  return textStyle({
    cache: styleCache,
    styleDocument,
    rule,
    text: label.text,
    placement: label.placement,
    priorityClass: label.priorityClass,
    zIndex: label.zIndex,
    zoom
  });
}

/**
 * @param {Feature} feature
 * @param {number} zoom
 * @param {Record<string, unknown>} styleDocument
 * @param {Map<string, Style>} styleCache
 * @returns {Style | null}
 */
function poiLabelStyle(feature, zoom, styleDocument, styleCache) {
  const rule = labelRuleForSource(styleDocument, POI_SOURCE_LAYER);
  if (!rule || rule.enabled === false || !zoomInRule(zoom, rule) || !isSelectedPoi(feature, rule)) {
    return null;
  }

  const text = poiLabelText(feature);
  if (!text) {
    return null;
  }

  return textStyle({
    cache: styleCache,
    styleDocument,
    rule,
    text,
    placement: 'point',
    priorityClass: poiPriorityClass(feature),
    zIndex: poiZIndex(feature),
    zoom
  });
}

/**
 * @param {Feature} feature
 * @param {string} highway
 * @param {number} zoom
 * @param {Record<string, unknown>} rule
 * @returns {{ text: string, priorityClass: string, zIndex: number } | null}
 */
function roadLabel(feature, highway, zoom, rule) {
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

/**
 * @param {Feature} feature
 * @param {string} aeroway
 * @param {number} zoom
 * @returns {{ text: string, placement: 'line' | 'point', priorityClass: string, zIndex: number } | null}
 */
function aviationLabel(feature, aeroway, zoom) {
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

function aviationFallbackText(aeroway) {
  if (aeroway === 'aerodrome') return 'Aerodrome';
  if (aeroway === 'heliport') return 'Heliport';
  if (aeroway === 'terminal') return 'Terminal';
  if (aeroway === 'apron') return 'Apron';
  return cleanText(aeroway).replace(/_/g, ' ');
}

/**
 * @param {{
 *   cache: Map<string, Style>,
 *   styleDocument: Record<string, unknown>,
 *   rule: Record<string, unknown>,
 *   text: string,
 *   placement: 'line' | 'point',
 *   priorityClass: string,
 *   zIndex: number,
 *   zoom: number
 * }} options
 * @returns {Style}
 */
function textStyle(options) {
  const priorityRule = priorityClassRule(options.styleDocument, options.priorityClass);
  const opacity = labelOpacityForZoom(options.zoom, Number(priorityRule.opacity ?? options.rule.opacity ?? 0.82));
  const font = labelFont(options.rule, priorityRule, options.zoom);
  const fill = rgba(String(priorityRule.fill ?? options.rule.fill ?? '#d9fbff'), opacity);
  const halo = rgba(String(priorityRule.halo ?? options.rule.halo ?? '#001014'), Math.min(1, opacity + 0.12));
  const haloWidth = Number(priorityRule.haloWidth ?? options.rule.haloWidth ?? 3);
  const key = [
    options.text,
    options.placement,
    font,
    fill,
    halo,
    haloWidth,
    options.zIndex
  ].join('|');

  if (options.cache.has(key)) {
    return /** @type {Style} */ (options.cache.get(key));
  }

  const style = new Style({
    zIndex: options.zIndex,
    text: new Text({
      text: options.text,
      placement: options.placement,
      font,
      fill: new Fill({ color: fill }),
      stroke: new Stroke({ color: halo, width: haloWidth }),
      overflow: false,
      maxAngle: Math.PI / 5
    })
  });
  options.cache.set(key, style);
  return style;
}

/**
 * @param {Feature} feature
 * @param {Record<string, unknown>} rule
 * @returns {boolean}
 */
function isSelectedPoi(feature, rule) {
  const categories = objectRule(rule.categories);
  const category = poiCategoryForFeature(feature);
  if (category && categories?.[category] === false) {
    return false;
  }

  const matchesClass = matchesSelectedPoiClass(feature, rule);
  return matchesClass;
}

/**
 * @param {Feature} feature
 * @param {Record<string, unknown>} rule
 * @returns {boolean}
 */
function matchesSelectedPoiClass(feature, rule) {
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

/**
 * @param {Feature} feature
 * @returns {string}
 */
function poiLabelText(feature) {
  for (const field of LABEL_TEXT_FIELDS) {
    const text = cleanText(feature.get(field));
    if (isMeaningfulLabel(text)) {
      return text;
    }
  }

  return poiFallbackLabel(feature);
}

function poiFallbackLabel(feature) {
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

/**
 * @param {Feature} feature
 * @returns {string}
 */
function poiCategoryForFeature(feature) {
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

/**
 * @param {number} priority
 * @returns {string}
 */
function priorityClassFromNumber(priority) {
  if (priority >= 900) return 'critical';
  if (priority >= 760) return 'important';
  if (priority >= 500) return 'normal';
  return 'low';
}

/**
 * @param {Feature} feature
 * @returns {string}
 */
function poiPriorityClass(feature) {
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

/**
 * @param {Feature} feature
 * @returns {number}
 */
function poiZIndex(feature) {
  const priority = poiPriorityClass(feature);
  if (priority === 'critical') return 920;
  if (priority === 'important') return 820;
  return 620;
}

/**
 * @param {Record<string, unknown>} rule
 * @param {Record<string, unknown>} priorityRule
 * @param {number} zoom
 * @returns {string}
 */
function labelFont(rule, priorityRule, zoom) {
  const configured = String(priorityRule.font ?? rule.font ?? '').trim();
  if (configured) {
    return configured;
  }

  const weight = String(priorityRule.weight ?? rule.weight ?? 600);
  const size = zoom >= 17 ? 12 : zoom >= 15 ? 11 : 10;
  return `${weight} ${size}px sans-serif`;
}

/**
 * @param {Record<string, unknown>} styleDocument
 * @param {string} className
 * @returns {Record<string, unknown>}
 */
function priorityClassRule(styleDocument, className) {
  const labels = labelConfigRoot(styleDocument);
  const classes = labels?.priorityClasses && typeof labels.priorityClasses === 'object'
    ? /** @type {Record<string, unknown>} */ (labels.priorityClasses)
    : {};
  const rule = classes[className];
  return rule && typeof rule === 'object' ? /** @type {Record<string, unknown>} */ (rule) : {};
}

/**
 * @param {number} zoom
 * @param {number} base
 * @returns {number}
 */
function labelOpacityForZoom(zoom, base) {
  if (zoom < 12.5) return base * 0.6;
  if (zoom < 14) return base * 0.76;
  return base;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function titleCase(value) {
  return cleanText(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isMeaningfulLabel(text) {
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

/**
 * @param {Feature} feature
 * @param {string} sourceLayer
 * @param {string} text
 * @returns {boolean}
 */
function isExplicitAviationLabel(feature, sourceLayer, text) {
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

/**
 * @param {string} ref
 * @returns {string}
 */
function aviationRefText(ref) {
  return ref && !/^(yes|no|true|false|0|1)$/i.test(ref) ? ref : '';
}

/**
 * @param {string} text
 * @param {string} aeroway
 * @returns {boolean}
 */
function isRenderableAviationText(text, aeroway) {
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

/**
 * @param {Record<string, unknown>} styleDocument
 * @returns {Record<string, unknown> | null}
 */
function labelConfigRoot(styleDocument) {
  return styleDocument.labels && typeof styleDocument.labels === 'object'
    ? /** @type {Record<string, unknown>} */ (styleDocument.labels)
    : null;
}

/**
 * @param {Record<string, unknown>} styleDocument
 * @param {string} sourceLayer
 * @returns {Record<string, unknown> | null}
 */
function labelRuleForSource(styleDocument, sourceLayer) {
  const labels = labelConfigRoot(styleDocument);
  const rule = labels?.[sourceLayer] ?? labels?.[labelSourceAlias(sourceLayer)];
  return rule && typeof rule === 'object' ? /** @type {Record<string, unknown>} */ (rule) : null;
}

/**
 * @param {string} sourceLayer
 * @returns {string}
 */
function labelSourceAlias(sourceLayer) {
  if (sourceLayer === 'aip') return 'aviation';
  if (sourceLayer === 'aviation') return 'aip';
  return sourceLayer;
}

/**
 * @param {unknown} rule
 * @returns {Record<string, unknown> | null}
 */
function objectRule(rule) {
  return rule && typeof rule === 'object' ? /** @type {Record<string, unknown>} */ (rule) : null;
}

/**
 * @param {number} zoom
 * @param {Record<string, unknown>} rule
 * @returns {boolean}
 */
function zoomInRule(zoom, rule) {
  const minZoom = Number(rule.minZoom ?? 0);
  const maxZoom = Number(rule.maxZoom ?? 22);
  return (!Number.isFinite(minZoom) || zoom >= minZoom) && (!Number.isFinite(maxZoom) || zoom <= maxZoom);
}

/**
 * @param {number} resolution
 * @returns {number}
 */
function resolutionToZoom(resolution) {
  const initialResolution = 156543.03392804097;
  return Math.log2(initialResolution / Number(resolution));
}

/**
 * @param {string} color
 * @param {number} opacity
 * @returns {string}
 */
function rgba(color, opacity) {
  const rgb = hexToRgb(color);
  if (!rgb) {
    return color;
  }
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(opacity, 0, 1)})`;
}

/**
 * @param {string} color
 * @returns {[number, number, number] | null}
 */
function hexToRgb(color) {
  const match = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
