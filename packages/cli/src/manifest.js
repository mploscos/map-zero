import { packageNameFromPath } from './utils.js';
import { resolveManifestLayers } from '@map-zero/core/manifest.js';

export { resolveManifestLayers, isLayerInZoomRange, isFeatureInZoomRange } from '@map-zero/core/manifest.js';

/**
 * Create a map-zero package manifest.
 *
 * @param {{ outDir: string, bbox: [number, number, number, number], layers: Array<string | import('@map-zero/core/manifest.js').ManifestLayerInput> }} options
 * @returns {Record<string, unknown>}
 */
export function createManifest(options) {
  const descriptors = resolveManifestLayers(options);
  return {
    format: 'mapzero',
    version: 1,
    name: packageNameFromPath(options.outDir),
    bbox: options.bbox,
    data: 'data.gpkg',
    styles: {
      default: 'styles/neon-dark.json',
      'neon-dark': 'styles/neon-dark.json'
    },
    layers: options.layers.map((layer, index) => typeof layer === 'string' ? layer : descriptors[index])
  };
}
