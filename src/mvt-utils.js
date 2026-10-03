export {
  geometryBbox,
  labelAnchorForGeometry,
  visitCoordinates
} from '../packages/core/src/geometry.js';

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
    .map((feature, order) => ({ feature, order, priority: priority(feature) }))
    .sort((a, b) => b.priority - a.priority || a.order - b.order)
    .slice(0, maxFeatures)
    .map((entry) => entry.feature);
}
