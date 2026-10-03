/**
 * Return a stable representative coordinate for a GeoJSON geometry.
 *
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
    return lineMidpoint(longestLine(/** @type {number[][][]} */ (geometry.coordinates)));
  }
  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    return polygonAnchor(/** @type {number[][][]} */ (geometry.coordinates));
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return polygonAnchor(largestPolygon(/** @type {number[][][][]} */ (geometry.coordinates)));
  }
  return null;
}

/**
 * Calculate a bbox for a GeoJSON-like geometry.
 *
 * @param {{ type?: string, coordinates?: unknown }} geometry
 * @returns {[number, number, number, number] | null}
 */
export function geometryBbox(geometry) {
  /** @type {[number, number, number, number] | null} */
  let bbox = null;
  visitCoordinates(geometry?.coordinates, (coordinate) => {
    const x = Number(coordinate[0]);
    const y = Number(coordinate[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
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
 * Visit all coordinates in a GeoJSON coordinate tree.
 *
 * @param {unknown} coordinates
 * @param {(coordinate: [number, number]) => void} callback
 */
export function visitCoordinates(coordinates, callback) {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    callback(/** @type {[number, number]} */ (coordinates));
    return;
  }
  for (const item of coordinates) visitCoordinates(item, callback);
}

/**
 * Check whether a point is inside a polygon ring.
 *
 * @param {[number, number]} point
 * @param {Array<[number, number]>} ring
 * @returns {boolean}
 */
export function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function isCoordinate(coordinate) {
  return Array.isArray(coordinate)
    && coordinate.length >= 2
    && Number.isFinite(Number(coordinate[0]))
    && Number.isFinite(Number(coordinate[1]));
}

function lineMidpoint(coordinates) {
  if (!coordinates.length) return null;
  if (coordinates.length === 1) return isCoordinate(coordinates[0]) ? coordinates[0] : null;
  const lengths = [];
  let total = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const from = coordinates[index];
    const to = coordinates[index + 1];
    const length = isCoordinate(from) && isCoordinate(to)
      ? Math.hypot(Number(to[0]) - Number(from[0]), Number(to[1]) - Number(from[1]))
      : 0;
    lengths.push(length);
    total += length;
  }
  if (total <= 0) return coordinates.find(isCoordinate) ?? null;
  const target = total / 2;
  let accumulated = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (target <= accumulated + length || index === lengths.length - 1) {
      const from = coordinates[index];
      const to = coordinates[index + 1];
      if (!isCoordinate(from) || !isCoordinate(to) || length <= 0) {
        return isCoordinate(from) ? from : null;
      }
      const ratio = Math.max(0, Math.min(1, (target - accumulated) / length));
      return [
        Number(from[0]) + (Number(to[0]) - Number(from[0])) * ratio,
        Number(from[1]) + (Number(to[1]) - Number(from[1])) * ratio
      ];
    }
    accumulated += length;
  }
  return null;
}

function longestLine(lines) {
  return [...lines].sort((a, b) => lineLength(b) - lineLength(a))[0] ?? [];
}

function lineLength(line) {
  let length = 0;
  for (let index = 1; index < line.length; index += 1) {
    const from = line[index - 1];
    const to = line[index];
    if (isCoordinate(from) && isCoordinate(to)) {
      length += Math.hypot(Number(to[0]) - Number(from[0]), Number(to[1]) - Number(from[1]));
    }
  }
  return length;
}

function polygonAnchor(polygon) {
  const ring = polygon?.[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  const ys = [...new Set(ring.filter(isCoordinate).map((point) => Number(point[1])))]
    .sort((a, b) => a - b);
  if (ys.length < 2) return ring.find(isCoordinate) ?? null;
  const scans = [(ys[0] + ys.at(-1)) / 2];
  for (let index = 1; index < ys.length; index += 1) {
    scans.push((ys[index - 1] + ys[index]) / 2);
  }
  let best = null;
  let width = -1;
  const stride = Math.max(1, Math.ceil(scans.length / 32));
  for (let scan = 0; scan < scans.length; scan += stride) {
    const y = scans[scan];
    const xs = [];
    for (const outline of polygon) {
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i, i += 1) {
        const from = outline[j];
        const to = outline[i];
        if (!isCoordinate(from) || !isCoordinate(to) || (from[1] > y) === (to[1] > y)) continue;
        xs.push(Number(from[0]) + (y - from[1]) * (to[0] - from[0]) / (to[1] - from[1]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let index = 0; index + 1 < xs.length; index += 2) {
      if (xs[index + 1] - xs[index] > width) {
        width = xs[index + 1] - xs[index];
        best = [(xs[index] + xs[index + 1]) / 2, y];
      }
    }
  }
  return best;
}

function largestPolygon(polygons) {
  return [...polygons].sort((a, b) => Math.abs(ringArea(b?.[0] ?? [])) - Math.abs(ringArea(a?.[0] ?? [])))[0] ?? [];
}

function ringArea(ring) {
  let area = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const from = ring[index - 1];
    const to = ring[index];
    if (isCoordinate(from) && isCoordinate(to)) {
      area += Number(from[0]) * Number(to[1]) - Number(to[0]) * Number(from[1]);
    }
  }
  return area / 2;
}
