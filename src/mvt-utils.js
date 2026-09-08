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
  // Limit work for very detailed polygons; every chosen interval is inside.
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
 * @param {{ type?: string, coordinates?: unknown }} geometry
 * @returns {[number, number, number, number] | null}
 */
export function geometryBbox(geometry) {
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
export function visitCoordinates(coordinates, callback) {
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
 * @param {[number, number, number, number]} bbox
 * @returns {number}
 */
export function tileSpanForBbox(bbox) {
  return Math.max(Math.abs(bbox[2] - bbox[0]), Math.abs(bbox[3] - bbox[1]));
}

/**
 * @param {Array<Record<string, unknown>>} features
 * @param {number} maxFeatures
 * @param {(feature: Record<string, unknown>) => number} priority
 * @returns {Array<Record<string, unknown>>}
 */
export function topFeatures(features, maxFeatures, priority) {
  return features
    .map((feature, order) => ({
      feature,
      order,
      priority: priority(feature)
    }))
    .sort((a, b) => b.priority - a.priority || a.order - b.order)
    .slice(0, maxFeatures)
    .map((entry) => entry.feature);
}
