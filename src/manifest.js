import { packageNameFromPath } from './utils.js';

/**
 * Create a map-zero package manifest.
 *
 * @param {{ outDir: string, bbox: [number, number, number, number], layers: string[] }} options
 * @returns {Record<string, unknown>}
 */
export function createManifest(options) {
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
    layers: options.layers
  };
}
