import earcut from 'earcut';

import { cleanRing, wgs84SurfaceNormal, wgs84ToEcef } from './extrude.js';
import { localizeEcefPositions } from './precision.js';

/**
 * @typedef {{
 *   positions: Float32Array,
 *   normals: Float32Array,
 *   indices: Uint16Array,
 *   min: [number, number, number],
 *   max: [number, number, number],
 *   rtcCenter: [number, number, number],
 *   bbox: [number, number, number, number],
 *   maxHeight: number,
 *   featureCount: number
 * }} FlatMesh
 */

const DEFAULT_RIBBON_JOIN = 'round';
const DEFAULT_RIBBON_CAP = 'round';
const DEFAULT_MITER_LIMIT = 3.5;

/**
 * @param {string} layerId
 * @param {Array<{ geometry: Record<string, unknown>, properties: Record<string, unknown> }>} features
 * @param {{
 *   height?: number,
 *   lineWidthMeters?: number,
 *   join?: 'miter' | 'bevel' | 'round',
 *   cap?: 'butt' | 'round',
 *   roundSegments?: number,
 *   miterLimit?: number
 * }} options
 * @returns {FlatMesh | null}
 */
export function buildFlatLayerMesh(layerId, features, options = {}) {
  if (lineLayer(layerId)) {
    return buildLineRibbonMesh(features, {
      height: options.height ?? 0.8,
      widthMeters: options.lineWidthMeters ?? defaultLineWidth(layerId),
      join: options.join ?? defaultJoin(layerId),
      cap: options.cap ?? defaultCap(layerId),
      roundSegments: options.roundSegments ?? defaultRoundSegments(layerId),
      miterLimit: options.miterLimit ?? DEFAULT_MITER_LIMIT
    });
  }

  return buildPolygonSurfaceMesh(features, {
    height: options.height ?? 0.2
  });
}

/**
 * @param {Array<{ geometry: Record<string, unknown> }>} features
 * @param {{
 *   height: number,
 *   widthMeters: number,
 *   join: 'miter' | 'bevel' | 'round',
 *   cap: 'butt' | 'round',
 *   roundSegments: number,
 *   miterLimit: number
 * }} options
 * @returns {FlatMesh | null}
 */
export function buildLineRibbonMesh(features, options) {
  const positions = [];
  const normals = [];
  const bboxes = [];
  let featureCount = 0;

  for (const feature of features) {
    const lines = linesFromGeometry(feature.geometry);
    for (const line of lines) {
      const clean = cleanLine(line);
      if (clean.length < 2) {
        continue;
      }

      const ribbon = buildContinuousRibbon(clean, options);
      if (!ribbon) {
        continue;
      }
      addRibbonPolygon(positions, normals, ribbon, options.height);

      bboxes.push(expandBboxMeters(lineBbox(clean), options.widthMeters / 2));
      featureCount++;
    }
  }

  return finishMesh(positions, normals, bboxes, options.height, featureCount);
}

/**
 * @param {Array<{ geometry: Record<string, unknown> }>} features
 * @param {{ height: number }} options
 * @returns {FlatMesh | null}
 */
export function buildPolygonSurfaceMesh(features, options) {
  const positions = [];
  const normals = [];
  const indices = [];
  const bboxes = [];
  let featureCount = 0;

  for (const feature of features) {
    const polygons = polygonsFromGeometry(feature.geometry);
    for (const polygon of polygons) {
      const ring = cleanRing(polygon[0] ?? []);
      if (ring.length < 3) {
        continue;
      }

      const centroid = polygonCentroid(ring);
      const rings = [ring, ...polygon.slice(1).map(cleanRing).filter((hole) => hole.length >= 3)];
      const holes = [];
      let vertexCount = ring.length;
      for (const hole of rings.slice(1)) { holes.push(vertexCount); vertexCount += hole.length; }
      const points = rings.flat();
      const projected = projectRing(points, centroid);
      const triangles = earcut(projected.flat, holes, 2);
      if (triangles.length === 0) {
        continue;
      }

      const normal = wgs84SurfaceNormal(centroid[0], centroid[1]);
      const ecef = points.map(([lon, lat]) => wgs84ToEcef(lon, lat, options.height));
      const vertexOffset = positions.length / 3;
      for (const point of ecef) {
        positions.push(...point);
        normals.push(...normal);
      }
      for (const index of triangles) {
        indices.push(vertexOffset + index);
      }
      bboxes.push(lineBbox(ring));
      featureCount++;
    }
  }

  return finishMesh(positions, normals, bboxes, options.height, featureCount, indices);
}

/**
 * @param {number[]} positions
 * @param {number[]} normals
 * @param {[number, number][]} ribbon
 * @param {number} height
 */
function addRibbonPolygon(positions, normals, ribbon, height) {
  if (ribbon.length < 3) {
    return;
  }

  const centroid = polygonCentroid(ribbon);
  const projected = projectRing(ribbon, centroid);
  const triangles = earcut(projected.flat, null, 2);
  if (triangles.length === 0) {
    return;
  }

  const normal = wgs84SurfaceNormal(centroid[0], centroid[1]);
  const ecef = ribbon.map(([lon, lat]) => wgs84ToEcef(lon, lat, height));
  for (let i = 0; i < triangles.length; i += 3) {
    addTriangle(
      positions,
      normals,
      ecef[triangles[i]],
      ecef[triangles[i + 1]],
      ecef[triangles[i + 2]],
      normal
    );
  }
}

function addTriangle(positions, normals, a, b, c, normal) {
  positions.push(...a, ...b, ...c);
  normals.push(...normal, ...normal, ...normal);
}

function finishMesh(positions, normals, bboxes, height, featureCount, indices = []) {
  if (positions.length === 0 || featureCount === 0) {
    return null;
  }

  const localized = localizeEcefPositions(positions);
  const normalArray = new Float32Array(normals);
  const indexArray = indices.length > 0
    ? localized.positions.length / 3 > 65535
      ? new Uint32Array(indices)
      : new Uint16Array(indices)
    : new Uint16Array(0);
  return {
    positions: localized.positions,
    normals: normalArray,
    indices: indexArray,
    min: localized.min,
    max: localized.max,
    rtcCenter: localized.rtcCenter,
    bbox: mergeBboxes(bboxes),
    maxHeight: height,
    featureCount
  };
}

function linesFromGeometry(geometry) {
  if (geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates[0] ?? []];
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.map((polygon) => polygon[0] ?? []);
  }
  return [];
}

function polygonsFromGeometry(geometry) {
  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

function cleanLine(line) {
  return line
    .map((point) => [Number(point?.[0]), Number(point?.[1])])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

function lineLayer(layerId) {
  return layerId === 'roads' || layerId === 'railways' || layerId === 'boundaries';
}

function defaultLineWidth(layerId) {
  if (layerId === 'roads') return 6;
  if (layerId === 'railways') return 3;
  return 2;
}

function defaultJoin(layerId) {
  return layerId === 'boundaries' ? 'bevel' : DEFAULT_RIBBON_JOIN;
}

function defaultCap(layerId) {
  return layerId === 'boundaries' ? 'butt' : DEFAULT_RIBBON_CAP;
}

function defaultRoundSegments(layerId) {
  if (layerId === 'roads') return 5;
  if (layerId === 'railways') return 4;
  return 0;
}

/**
 * @param {[number, number][]} line
 * @param {{
 *   widthMeters: number,
 *   join: 'miter' | 'bevel' | 'round',
 *   cap: 'butt' | 'round',
 *   roundSegments: number,
 *   miterLimit: number
 * }} options
 * @returns {[number, number][] | null}
 */
function buildContinuousRibbon(line, options) {
  const local = toLocalLine(line);
  const closed = local.closed;
  const points = local.points;
  if (points.length < 2) {
    return null;
  }

  const half = options.widthMeters / 2;
  /** @type {Array<[number, number]>} */
  const left = [];
  /** @type {Array<[number, number]>} */
  const right = [];
  const count = points.length;

  for (let i = 0; i < count; i++) {
    const current = points[i];
    const prev = i > 0 ? points[i - 1] : closed ? points[count - 1] : null;
    const next = i < count - 1 ? points[i + 1] : closed ? points[0] : null;

    if (!prev || !next) {
      const direction = next ? normalize2(sub2(next, current)) : normalize2(sub2(current, prev));
      const normal = leftNormal(direction);
      left.push(add2(current, scale2(normal, half)));
      right.push(add2(current, scale2(normal, -half)));
      continue;
    }

    const join = ribbonJoinPoints(prev, current, next, half, options);
    left.push(...join.left);
    right.push(...join.right);
  }

  if (!closed && options.cap === 'round' && options.roundSegments >= 3) {
    const startArc = capArc(points[0], points[1], half, options.roundSegments, true);
    const endArc = capArc(points[count - 1], points[count - 2], half, options.roundSegments, false);
    return localPointsToLonLat([...left, ...endArc, ...right.reverse(), ...startArc], local);
  }

  return localPointsToLonLat([...left, ...right.reverse()], local);
}

function ribbonJoinPoints(prev, current, next, half, options) {
  const inDir = normalize2(sub2(current, prev));
  const outDir = normalize2(sub2(next, current));
  if (length2(inDir) === 0 || length2(outDir) === 0) {
    return {
      left: [[current[0], current[1] + half]],
      right: [[current[0], current[1] - half]]
    };
  }

  const inNormal = leftNormal(inDir);
  const outNormal = leftNormal(outDir);
  const leftPrev = add2(current, scale2(inNormal, half));
  const leftNext = add2(current, scale2(outNormal, half));
  const rightPrev = add2(current, scale2(inNormal, -half));
  const rightNext = add2(current, scale2(outNormal, -half));

  const leftMiter = lineIntersection(leftPrev, inDir, leftNext, outDir);
  const rightMiter = lineIntersection(rightPrev, inDir, rightNext, outDir);
  const maxMiter = half * options.miterLimit;
  const mild = leftMiter && rightMiter &&
    distance2(leftMiter, current) <= maxMiter &&
    distance2(rightMiter, current) <= maxMiter;

  if (options.join === 'miter' || (options.join === 'round' && mild)) {
    if (mild) {
      return { left: [leftMiter], right: [rightMiter] };
    }
  }

  if (options.join === 'round' && options.roundSegments >= 3) {
    return {
      left: arcAround(current, leftPrev, leftNext, options.roundSegments),
      right: arcAround(current, rightNext, rightPrev, options.roundSegments)
    };
  }

  return {
    left: [leftPrev, leftNext],
    right: [rightNext, rightPrev]
  };
}

function capArc(endpoint, neighbor, half, segments, start) {
  const dir = normalize2(sub2(endpoint, neighbor));
  const normal = leftNormal(dir);
  const a = add2(endpoint, scale2(normal, start ? -half : half));
  const b = add2(endpoint, scale2(normal, start ? half : -half));
  return arcAround(endpoint, a, b, Math.max(3, segments));
}

function arcAround(center, from, to, segments) {
  const start = Math.atan2(from[1] - center[1], from[0] - center[0]);
  let end = Math.atan2(to[1] - center[1], to[0] - center[0]);
  while (end < start) {
    end += Math.PI * 2;
  }
  if (end - start > Math.PI) {
    end -= Math.PI * 2;
  }

  const steps = Math.max(1, Math.ceil(Math.abs(end - start) / Math.PI * segments));
  const radius = distance2(from, center);
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = start + (end - start) * t;
    points.push([
      center[0] + Math.cos(angle) * radius,
      center[1] + Math.sin(angle) * radius
    ]);
  }
  return points;
}

function toLocalLine(line) {
  const closed = line.length > 2 && samePoint(line[0], line[line.length - 1]);
  const points = closed ? line.slice(0, -1) : line;
  const origin = polygonCentroid(points);
  const meanLat = origin[1] * Math.PI / 180;
  const metersPerLon = Math.max(1, 111320 * Math.cos(meanLat));
  const metersPerLat = 110540;
  return {
    origin,
    metersPerLon,
    metersPerLat,
    closed,
    points: points.map(([lon, lat]) => [
      (lon - origin[0]) * metersPerLon,
      (lat - origin[1]) * metersPerLat
    ])
  };
}

function localPointsToLonLat(points, local) {
  return points.map(([x, y]) => [
    local.origin[0] + x / local.metersPerLon,
    local.origin[1] + y / local.metersPerLat
  ]);
}

function lineIntersection(pointA, dirA, pointB, dirB) {
  const cross = cross2(dirA, dirB);
  if (Math.abs(cross) < 1e-6) {
    return null;
  }

  const diff = sub2(pointB, pointA);
  const t = cross2(diff, dirB) / cross;
  return add2(pointA, scale2(dirA, t));
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
}

function add2(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function sub2(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function scale2(a, scale) {
  return [a[0] * scale, a[1] * scale];
}

function length2(a) {
  return Math.hypot(a[0], a[1]);
}

function distance2(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function normalize2(a) {
  const length = length2(a);
  return length > 0 ? [a[0] / length, a[1] / length] : [0, 0];
}

function leftNormal(direction) {
  return [-direction[1], direction[0]];
}

function cross2(a, b) {
  return a[0] * b[1] - a[1] * b[0];
}

function projectRing(points, centroid) {
  const meanLat = centroid[1] * Math.PI / 180;
  const metersPerLon = Math.max(1, 111320 * Math.cos(meanLat));
  const metersPerLat = 110540;
  const flat = [];
  for (const [lon, lat] of points) {
    flat.push((lon - centroid[0]) * metersPerLon, (lat - centroid[1]) * metersPerLat);
  }
  return { flat };
}

function polygonCentroid(points) {
  let lon = 0;
  let lat = 0;
  for (const point of points) {
    lon += point[0];
    lat += point[1];
  }
  return [lon / points.length, lat / points.length];
}

function lineBbox(points) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

function expandBboxMeters(bbox, meters) {
  const meanLat = ((bbox[1] + bbox[3]) / 2) * Math.PI / 180;
  const metersPerLon = Math.max(1, 111320 * Math.cos(meanLat));
  const lonPad = meters / metersPerLon;
  const latPad = meters / 110540;
  return [
    bbox[0] - lonPad,
    bbox[1] - latPad,
    bbox[2] + lonPad,
    bbox[3] + latPad
  ];
}

function mergeBboxes(bboxes) {
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
