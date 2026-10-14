import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LAYERS } from './layers.js';

export const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'presets');
const PRESET_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Load a portable JSON style preset and filter it to the selected package layers.
 *
 * @param {string} preset
 * @param {string[]} selectedLayers
 * @returns {Record<string, unknown>}
 */
export function createStyleFromPreset(preset = 'neon-dark', selectedLayers = SUPPORTED_LAYERS) {
  const style = readStylePreset(preset);
  return filterStyleLayers(style, selectedLayers);
}

/**
 * Backward-compatible default style factory.
 *
 * @param {string[]} selectedLayers
 * @returns {Record<string, unknown>}
 */
export function createNeonDarkStyle(selectedLayers = SUPPORTED_LAYERS) {
  return createStyleFromPreset('neon-dark', selectedLayers);
}

/**
 * List bundled JSON style presets.
 *
 * @returns {string[]}
 */
export function listStylePresets() {
  return readdirSync(PRESETS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

/**
 * Read one bundled style preset from styles/presets.
 *
 * @param {string} preset
 * @returns {Record<string, unknown>}
 */
export function readStylePreset(preset) {
  if (!PRESET_NAME_PATTERN.test(preset)) {
    throw new Error(`invalid style preset name: ${preset}`);
  }

  const filePath = join(PRESETS_DIR, `${preset}.json`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const available = listStylePresets().join(', ');
    throw new Error(`unknown style preset: ${preset}${available ? `; available presets: ${available}` : ''}`);
  }
}

/**
 * Return a style containing only selected layers.
 *
 * @param {Record<string, unknown>} style
 * @param {string[]} selectedLayers
 * @returns {Record<string, unknown>}
 */
export function filterStyleLayers(style, selectedLayers = SUPPORTED_LAYERS) {
  const selected = new Set(selectedLayers);
  const layers = style.layers && typeof style.layers === 'object'
    ? /** @type {Record<string, unknown>} */ (style.layers)
    : {};
  const drawOrder = Array.isArray(style.drawOrder)
    ? style.drawOrder.map(String).filter((layer) => selected.has(layer))
    : Object.keys(layers).filter((layer) => selected.has(layer));

  /** @type {Record<string, unknown>} */
  const filteredLayers = {};
  for (const layer of drawOrder) {
    if (layers[layer]) {
      filteredLayers[layer] = layers[layer];
    }
  }

  return {
    ...structuredClone(style),
    drawOrder,
    layers: filteredLayers
  };
}
