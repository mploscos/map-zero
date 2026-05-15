/**
 * @param {[number, number, number, number]} bbox
 * @param {number} minZ
 * @param {number} maxZ
 * @returns {[number, number, number, number, number, number]}
 */
export function bboxToRegion(bbox, minZ, maxZ) {
  return [
    degToRad(bbox[0]),
    degToRad(bbox[1]),
    degToRad(bbox[2]),
    degToRad(bbox[3]),
    minZ,
    maxZ
  ];
}

/**
 * @param {{
 *   bbox: [number, number, number, number],
 *   maxHeight: number,
 *   children: Array<Record<string, unknown>>
 * }} options
 * @returns {Record<string, unknown>}
 */
export function buildTileset(options) {
  const region = bboxToRegion(options.bbox, 0, Math.max(1, options.maxHeight));
  const geometricError = rootGeometricError(options.bbox);

  return {
    asset: {
      version: '1.0',
      gltfUpAxis: 'Z',
      generator: 'map-zero'
    },
    geometricError,
    root: {
      boundingVolume: { region },
      geometricError,
      refine: 'ADD',
      children: options.children
    }
  };
}

/**
 * @param {{ bbox: [number, number, number, number], maxHeight: number, uri: string }} options
 * @returns {Record<string, unknown>}
 */
export function buildContentNode(options) {
  return {
    boundingVolume: {
      region: bboxToRegion(options.bbox, 0, Math.max(1, options.maxHeight))
    },
    geometricError: 0,
    refine: 'ADD',
    content: {
      uri: options.uri
    }
  };
}

/**
 * @param {[number, number, number, number]} bbox
 * @returns {number}
 */
function rootGeometricError(bbox) {
  const lonSpan = Math.max(0.0001, bbox[2] - bbox[0]);
  const latSpan = Math.max(0.0001, bbox[3] - bbox[1]);
  return Math.max(50, Math.max(lonSpan, latSpan) * 111000);
}

function degToRad(value) {
  return value * Math.PI / 180;
}
