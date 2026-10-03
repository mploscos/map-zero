import { geometryBbox, labelAnchorForGeometry, pointInRing } from './geometry.js';

export const AIP_AIRPORT_CATALOG_FORMAT = 'mapzero-aip-airports';
export const AIP_AIRPORT_CATALOG_VERSION = 1;

const MaximumNearestAirportMeters = 25000;

/**
 * Build the source-neutral airport/runway catalog used by instructor and
 * scenario applications. Input features may be raw OSM AIP features or the
 * normalized airport/runway features produced by another aviation source.
 *
 * @param {Array<{layer?: string, geometry: object, properties: Record<string, unknown>}>} features
 * @param {{bbox: [number, number, number, number], source?: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
export function createAipAirportCatalog(features, options) {
  const airports = features
    .filter(isAirportFeature)
    .map(createAirport)
    .filter(Boolean);
  const airportIndex = createAirportIndex(airports);
  const runwayFeatures = features.filter(isRunwayFeature);
  const thresholdFeatures = features.filter(isThresholdFeature);
  const thresholdsByAirport = new Map(airports.map((airport) => [airport.id, []]));

  for (const feature of thresholdFeatures) {
    const airport = findAirport(feature, airports, airportIndex);
    if (airport) thresholdsByAirport.get(airport.id).push(feature);
  }

  const physicalRunways = new Set();
  let unresolvedRunways = 0;
  for (const feature of runwayFeatures) {
    const catalogCandidate = feature.layer === 'runways'
      || runwayDesignators(feature.properties.ref).length > 0;
    if (!catalogCandidate) continue;
    const airport = findAirport(feature, airports, airportIndex);
    if (!airport) {
      unresolvedRunways += 1;
      continue;
    }

    const directions = normalizedRunwayDirections(feature, airport)
      ?? osmRunwayDirections(feature, airport, thresholdsByAirport.get(airport.id));
    if (!directions.length) {
      unresolvedRunways += 1;
      continue;
    }

    physicalRunways.add(String(feature.properties.id ?? `${airport.id}:${directions[0].physicalRunway}`));
    for (const direction of directions) {
      const current = airport.runwayMap.get(direction.designator);
      if (!current || qualityRank(direction.quality) > qualityRank(current.quality)) {
        airport.runwayMap.set(direction.designator, direction);
      }
    }
  }

  const outputAirports = airports
    .map(({ geometry, bbox, sourceId, runwayMap, ...airport }) => ({
      ...airport,
      runways: [...runwayMap.values()].sort(compareRunways)
    }))
    .filter((airport) => airport.runways.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const runwayDirections = outputAirports.flatMap((airport) => airport.runways);
  const mappedThresholds = runwayDirections.filter((runway) => runway.quality !== 'estimated').length;

  return {
    format: AIP_AIRPORT_CATALOG_FORMAT,
    version: AIP_AIRPORT_CATALOG_VERSION,
    bbox: options.bbox,
    source: options.source ?? { type: 'unknown' },
    summary: {
      airports: outputAirports.length,
      physicalRunways: physicalRunways.size,
      runwayDirections: runwayDirections.length,
      mappedThresholds,
      estimatedThresholds: runwayDirections.length - mappedThresholds,
      unresolvedRunways
    },
    airports: outputAirports
  };
}

function createAirport(feature) {
  const properties = feature.properties;
  const coordinate = labelAnchorForGeometry(feature.geometry);
  if (!coordinate) return null;
  const sourceId = String(properties.id);
  const icao = text(properties.icao);
  const iata = text(properties.iata);
  const ident = icao ?? text(properties.ident) ?? iata ?? text(properties.ref) ?? sourceId;
  const elevationM = parseElevation(properties.elevationM ?? properties.ele);
  return {
    id: ident,
    name: text(properties.name) ?? ident,
    ...(icao ? { icao } : {}),
    ...(iata ? { iata } : {}),
    longitude: roundCoordinate(coordinate[0]),
    latitude: roundCoordinate(coordinate[1]),
    ...(elevationM === undefined ? {} : { altitudeM: roundElevation(elevationM) }),
    geometry: feature.geometry,
    bbox: geometryBbox(feature.geometry),
    sourceId,
    runwayMap: new Map()
  };
}

function normalizedRunwayDirections(feature, airport) {
  if (feature.layer !== 'runways' || feature.geometry.type !== 'Point') return null;
  const properties = feature.properties;
  const designator = normalizeDesignator(properties.runwayDesignator ?? properties.designator ?? properties.ref);
  const heading = finiteNumber(properties.headingTrueDeg ?? properties.headingDeg);
  const coordinate = /** @type {number[]} */ (feature.geometry.coordinates);
  if (!designator || heading === undefined) return [];
  const altitudeM = parseElevation(properties.elevationM ?? properties.ele ?? airport.altitudeM);
  return [createRunwayDirection({
    designator,
    physicalRunway: designator,
    heading,
    coordinate,
    altitudeM,
    elevationSource: altitudeM === undefined ? undefined : 'source',
    quality: 'source'
  })];
}

function osmRunwayDirections(feature, airport, thresholds) {
  if (feature.geometry.type !== 'LineString' && feature.geometry.type !== 'MultiLineString') return [];
  const line = longestLine(feature.geometry);
  const endpoints = [line[0], line.at(-1)];
  if (!endpoints[0] || !endpoints[1]) return [];
  const ref = text(feature.properties.ref);
  const designators = runwayDesignators(ref);
  if (!designators.length) return [];

  return designators.map((designator) => {
    const threshold = nearestThreshold(designator, thresholds, endpoints);
    const coordinate = threshold
      ? /** @type {number[]} */ (threshold.geometry.coordinates)
      : endpointForDesignator(designator, endpoints);
    const oppositeThreshold = nearestThreshold(
      designators.find((value) => value !== designator),
      thresholds,
      endpoints
    );
    const target = oppositeThreshold
      ? /** @type {number[]} */ (oppositeThreshold.geometry.coordinates)
      : farthestEndpoint(coordinate, endpoints);
    const heading = bearingDegrees(coordinate, target);
    const elevation = threshold?.properties.ele !== null && threshold?.properties.ele !== undefined
      ? { value: threshold.properties.ele, source: 'threshold' }
      : feature.properties.ele !== null && feature.properties.ele !== undefined
        ? { value: feature.properties.ele, source: 'runway' }
        : { value: airport.altitudeM, source: 'airport' };
    const altitudeM = parseElevation(elevation.value);
    return createRunwayDirection({
      designator,
      physicalRunway: ref,
      heading,
      coordinate,
      altitudeM,
      elevationSource: altitudeM === undefined ? undefined : elevation.source,
      quality: threshold ? 'mapped-threshold' : 'estimated'
    });
  });
}

function createRunwayDirection(options) {
  return {
    id: options.designator,
    name: `Runway ${options.designator}`,
    designator: options.designator,
    physicalRunway: options.physicalRunway,
    headingTrueDeg: roundHeading(options.heading),
    threshold: {
      longitude: roundCoordinate(options.coordinate[0]),
      latitude: roundCoordinate(options.coordinate[1]),
      ...(options.altitudeM === undefined ? {} : {
        altitudeM: roundElevation(options.altitudeM),
        elevationSource: options.elevationSource
      })
    },
    quality: options.quality
  };
}

function createAirportIndex(airports) {
  const index = new Map();
  for (const airport of airports) {
    for (const value of [airport.id, airport.sourceId, airport.icao, airport.iata]) {
      if (value) index.set(String(value), airport);
    }
  }
  return index;
}

function findAirport(feature, airports, index) {
  const explicitId = text(feature.properties.airportId ?? feature.properties.airport_id);
  if (explicitId && index.has(explicitId)) return index.get(explicitId);
  const coordinate = labelAnchorForGeometry(feature.geometry);
  if (!coordinate) return null;
  const containing = airports
    .filter((airport) => geometryContainsPoint(airport.geometry, coordinate))
    .sort((a, b) => bboxArea(a.bbox) - bboxArea(b.bbox));
  if (containing.length) return containing[0];

  let nearest = null;
  let nearestDistance = Infinity;
  for (const airport of airports) {
    const distance = distanceMeters(coordinate, [airport.longitude, airport.latitude]);
    if (distance < nearestDistance) {
      nearest = airport;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= MaximumNearestAirportMeters ? nearest : null;
}

function geometryContainsPoint(geometry, point) {
  if (geometry.type === 'Polygon') return polygonContainsPoint(geometry.coordinates, point);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => polygonContainsPoint(polygon, point));
  }
  return false;
}

function polygonContainsPoint(rings, point) {
  return Array.isArray(rings) && rings.length > 0
    && pointInRing(point, rings[0])
    && !rings.slice(1).some((ring) => pointInRing(point, ring));
}

function nearestThreshold(designator, thresholds, endpoints) {
  if (!designator) return null;
  const matches = thresholds.filter((feature) => normalizeDesignator(feature.properties.ref) === designator);
  return matches.sort((a, b) => endpointDistance(a, endpoints) - endpointDistance(b, endpoints))[0] ?? null;
}

function endpointDistance(feature, endpoints) {
  const coordinate = feature.geometry.coordinates;
  return Math.min(...endpoints.map((endpoint) => distanceMeters(coordinate, endpoint)));
}

function endpointForDesignator(designator, endpoints) {
  const expected = expectedHeading(designator);
  if (expected === undefined) return endpoints[0];
  const forward = bearingDegrees(endpoints[0], endpoints[1]);
  const reverse = bearingDegrees(endpoints[1], endpoints[0]);
  return angularDifference(forward, expected) <= angularDifference(reverse, expected)
    ? endpoints[0]
    : endpoints[1];
}

function farthestEndpoint(coordinate, endpoints) {
  return distanceMeters(coordinate, endpoints[0]) >= distanceMeters(coordinate, endpoints[1])
    ? endpoints[0]
    : endpoints[1];
}

function longestLine(geometry) {
  if (geometry.type === 'LineString') return geometry.coordinates;
  return [...geometry.coordinates].sort((a, b) => lineLength(b) - lineLength(a))[0] ?? [];
}

function lineLength(coordinates) {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += distanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return length;
}

function isAirportFeature(feature) {
  return feature.layer === 'airports' || ['aerodrome', 'airport'].includes(String(feature.properties.aeroway));
}

function isRunwayFeature(feature) {
  return feature.layer === 'runways' || feature.properties.aeroway === 'runway';
}

function isThresholdFeature(feature) {
  return feature.properties.aeroway === 'threshold' && feature.geometry.type === 'Point';
}

function runwayDesignators(ref) {
  return String(ref ?? '').split(/[\/;]/).map(normalizeDesignator).filter(Boolean);
}

function normalizeDesignator(value) {
  const normalized = text(value)?.toUpperCase().replace(/^RWY\s*/, '');
  return normalized || null;
}

function expectedHeading(designator) {
  const match = String(designator).match(/^(\d{1,2})[LCRT]?$/);
  if (!match) return undefined;
  const number = Number(match[1]);
  return number === 36 ? 0 : number * 10;
}

function bearingDegrees(from, to) {
  const radians = Math.PI / 180;
  const lat1 = from[1] * radians;
  const lat2 = to[1] * radians;
  const deltaLon = (to[0] - from[0]) * radians;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) / radians + 360) % 360;
}

function distanceMeters(from, to) {
  const radians = Math.PI / 180;
  const lat1 = from[1] * radians;
  const lat2 = to[1] * radians;
  const deltaLat = (to[1] - from[1]) * radians;
  const deltaLon = (to[0] - from[0]) * radians;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseElevation(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*(m|ft)?$/i);
  if (!match) return undefined;
  const elevation = Number(match[1]);
  return match[2]?.toLowerCase() === 'ft' ? elevation * 0.3048 : elevation;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function roundCoordinate(value) {
  return Number(Number(value).toFixed(8));
}

function roundElevation(value) {
  return Number(Number(value).toFixed(2));
}

function roundHeading(value) {
  return Number(((value % 360 + 360) % 360).toFixed(2));
}

function angularDifference(a, b) {
  return Math.abs((a - b + 540) % 360 - 180);
}

function bboxArea(bbox) {
  return bbox ? (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) : Infinity;
}

function qualityRank(quality) {
  return quality === 'source' ? 3 : quality === 'mapped-threshold' ? 2 : 1;
}

function compareRunways(a, b) {
  return a.designator.localeCompare(b.designator, 'en', { numeric: true });
}
