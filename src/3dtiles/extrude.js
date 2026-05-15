import earcut from 'earcut';

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/**
 * @typedef {{ coordinates: Array<[number, number]>, height: number }} Footprint
 * @typedef {{
 *   positions: Float32Array,
 *   normals: Float32Array,
 *   indices: Uint16Array | Uint32Array,
 *   min: [number, number, number],
 *   max: [number, number, number],
 *   bbox: [number, number, number, number],
 *   maxHeight: number,
 *   featureCount: number
 * }} ExtrudedMesh
 */

/**
 * Build one merged mesh from building footprints.
 *
 * @param {Footprint[]} footprints
 * @param {{ baseHeight?: number }} [options]
 * @returns {ExtrudedMesh | null}
 */
export function buildMergedExtrudedPolygonMesh(footprints, options = {}) {
  const baseHeight = options.baseHeight ?? 0;
  const positions = [];
  const normals = [];
  const indices = [];
  const bboxes = [];
  let maxHeight = baseHeight;
  let featureCount = 0;

  for (const footprint of footprints) {
    const mesh = buildExtrudedPolygonMesh(footprint.coordinates, baseHeight, footprint.height);
    if (!mesh) {
      continue;
    }

    const vertexOffset = positions.length / 3;
    positions.push(...mesh.positions);
    normals.push(...mesh.normals);
    for (const index of mesh.indices) {
      indices.push(index + vertexOffset);
    }
    bboxes.push(mesh.bbox);
    maxHeight = Math.max(maxHeight, footprint.height);
    featureCount++;
  }

  if (featureCount === 0) {
    return null;
  }

  const positionArray = new Float32Array(positions);
  const normalArray = new Float32Array(normals);
  const indexArray = positionArray.length / 3 > 65535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);
  const bounds = minMaxVec3(positionArray);

  return {
    positions: positionArray,
    normals: normalArray,
    indices: indexArray,
    min: bounds.min,
    max: bounds.max,
    bbox: mergeBboxes(bboxes),
    maxHeight,
    featureCount
  };
}

/**
 * @param {Array<[number, number]>} ring
 * @param {number} baseHeight
 * @param {number} topHeight
 * @returns {{ positions: number[], normals: number[], indices: number[], bbox: [number, number, number, number] } | null}
 */
export function buildExtrudedPolygonMesh(ring, baseHeight, topHeight) {
  const clean = cleanRing(ring);
  if (clean.length < 3) {
    return null;
  }

  const centroid = polygonCentroid(clean);
  const up = normalize(wgs84SurfaceNormal(centroid[0], centroid[1]));
  const bottom = clean.map(([lon, lat]) => wgs84ToEcef(lon, lat, baseHeight));
  const top = clean.map(([lon, lat]) => wgs84ToEcef(lon, lat, topHeight));
  const positions = [];
  const normals = [];
  const indices = [];

  const addTriangle = (a, b, c, normal) => {
    const n = normal ?? triangleNormal(a, b, c);
    const index = positions.length / 3;
    positions.push(...a, ...b, ...c);
    normals.push(...n, ...n, ...n);
    indices.push(index, index + 1, index + 2);
  };

  const projected = projectRing(clean, centroid);
  const roofTriangles = earcut(projected.flat, null, 2);
  if (roofTriangles.length === 0) {
    return null;
  }

  for (let i = 0; i < roofTriangles.length; i += 3) {
    addTriangle(top[roofTriangles[i]], top[roofTriangles[i + 1]], top[roofTriangles[i + 2]], up);
  }

  const down = [-up[0], -up[1], -up[2]];
  for (let i = 0; i < roofTriangles.length; i += 3) {
    addTriangle(bottom[roofTriangles[i]], bottom[roofTriangles[i + 2]], bottom[roofTriangles[i + 1]], down);
  }

  for (let i = 0; i < clean.length; i++) {
    const next = (i + 1) % clean.length;
    const b0 = bottom[i];
    const b1 = bottom[next];
    const t0 = top[i];
    const t1 = top[next];
    const wallNormal = triangleNormal(b0, b1, t1);
    addTriangle(b0, b1, t1, wallNormal);
    addTriangle(b0, t1, t0, wallNormal);
  }

  return {
    positions,
    normals,
    indices,
    bbox: polygonBbox(clean)
  };
}

/**
 * @param {Array<[number, number]>} ring
 * @returns {Array<[number, number]>}
 */
export function cleanRing(ring) {
  const out = [];
  for (const point of ring) {
    const lon = Number(point?.[0]);
    const lat = Number(point?.[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      out.push([lon, lat]);
    }
  }

  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      out.pop();
    }
  }

  return out;
}

/**
 * @param {Array<[number, number]>} points
 * @param {[number, number]} centroid
 * @returns {{ flat: number[] }}
 */
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

/**
 * @param {Array<[number, number]>} points
 * @returns {[number, number]}
 */
function polygonCentroid(points) {
  let lon = 0;
  let lat = 0;
  for (const point of points) {
    lon += point[0];
    lat += point[1];
  }
  return [lon / points.length, lat / points.length];
}

/**
 * @param {Array<[number, number]>} points
 * @returns {[number, number, number, number]}
 */
function polygonBbox(points) {
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
  const pad = 0.00002;
  return [minLon - pad, minLat - pad, maxLon + pad, maxLat + pad];
}

/**
 * @param {Array<[number, number, number, number]>} bboxes
 * @returns {[number, number, number, number]}
 */
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

/**
 * @param {Float32Array} positions
 * @returns {{ min: [number, number, number], max: [number, number, number] }}
 */
function minMaxVec3(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    min[0] = Math.min(min[0], positions[i]);
    min[1] = Math.min(min[1], positions[i + 1]);
    min[2] = Math.min(min[2], positions[i + 2]);
    max[0] = Math.max(max[0], positions[i]);
    max[1] = Math.max(max[1], positions[i + 1]);
    max[2] = Math.max(max[2], positions[i + 2]);
  }
  return { min, max };
}

function triangleNormal(a, b, c) {
  return normalize(cross(subtract(b, a), subtract(c, a)));
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length === 0) {
    return [0, 0, 1];
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function wgs84SurfaceNormal(lonDeg, latDeg) {
  const lonRad = degToRad(lonDeg);
  const latRad = degToRad(latDeg);
  const cosLat = Math.cos(latRad);
  return [
    cosLat * Math.cos(lonRad),
    cosLat * Math.sin(lonRad),
    Math.sin(latRad)
  ];
}

export function wgs84ToEcef(lonDeg, latDeg, h) {
  const lonRad = degToRad(lonDeg);
  const latRad = degToRad(latDeg);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (n + h) * cosLat * cosLon,
    (n + h) * cosLat * sinLon,
    (n * (1 - WGS84_E2) + h) * sinLat
  ];
}

function degToRad(value) {
  return value * Math.PI / 180;
}
