export const WEB_MERCATOR_MAX = 20037508.342789244;
export const WEB_MERCATOR_MAX_LAT = 85.05112878;

export function tileMercatorExtent(x, y, z) {
  const span = (WEB_MERCATOR_MAX * 2) / 2 ** z;
  const minX = -WEB_MERCATOR_MAX + x * span;
  const maxX = minX + span;
  const maxY = WEB_MERCATOR_MAX - y * span;
  const minY = maxY - span;
  return [minX, minY, maxX, maxY];
}

export function sourceTileForRequest(x, y, z, maxZoom) {
  const sourceZ = Math.min(z, maxZoom);
  if (sourceZ === z) return { x, y, z };
  const shift = z - sourceZ;
  return { x: Math.floor(x / 2 ** shift), y: Math.floor(y / 2 ** shift), z: sourceZ };
}

export function projectPoint(point, extent, size) {
  const [minX, minY, maxX, maxY] = extent;
  return [((point[0] - minX) / (maxX - minX)) * size, ((maxY - point[1]) / (maxY - minY)) * size];
}

export function geometryTypeKind(type) {
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon';
  return 'line';
}

export function boxesOverlap(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
