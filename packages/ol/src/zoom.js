const WEB_MERCATOR_RESOLUTION_AT_ZOOM_0 = 156543.03392804097;

/**
 * The WebGL style compiler exposes resolution in all supported render paths.
 * Convert the standard Web Mercator zoom thresholds used by map-zero styles.
 *
 * @param {number} zoom
 * @returns {number}
 */
export function resolutionForZoom(zoom) {
  return WEB_MERCATOR_RESOLUTION_AT_ZOOM_0 / (2 ** zoom);
}

/** @param {number} zoom @returns {unknown[]} */
export function minZoomExpression(zoom) {
  return ['<=', ['resolution'], resolutionForZoom(zoom)];
}

/** @param {number} zoom @returns {unknown[]} */
export function maxZoomExpression(zoom) {
  return ['>=', ['resolution'], resolutionForZoom(zoom)];
}

/**
 * @param {Array<[number, number]>} stops
 * @returns {unknown[] | null}
 */
export function zoomInterpolateExpression(stops) {
  const entries = stops
    .filter(([zoom, value]) => Number.isFinite(zoom) && Number.isFinite(value))
    .map(([zoom, value]) => ({ resolution: resolutionForZoom(zoom), value }))
    .sort((left, right) => left.resolution - right.resolution);

  if (entries.length < 2) return null;
  return ['interpolate', ['linear'], ['resolution'], ...entries.flatMap(({ resolution, value }) => [resolution, value])];
}
