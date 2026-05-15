import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LAYERS } from './layers.js';
import { filterStyleLayers, readStylePreset } from './style-presets.js';

export const THEMES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'themes');
const THEME_NAME_PATTERN = /^[a-z0-9-]+$/;
const COLOR_PATCHES = {
  background: [{ path: ['background'] }],
  roads: [
    { path: ['layers', 'roads', 'stroke'] },
    { path: ['layers', 'roads', 'body', 'color'] }
  ],
  roadsMajor: [
    { path: ['layers', 'roads', 'byProperty', 'highway', 'motorway', 'stroke'] },
    { path: ['layers', 'roads', 'byProperty', 'highway', 'motorway', 'body', 'color'] },
    { path: ['layers', 'roads', 'byProperty', 'highway', 'trunk', 'stroke'] },
    { path: ['layers', 'roads', 'byProperty', 'highway', 'trunk', 'body', 'color'] },
    { path: ['layers', 'roads', 'byProperty', 'highway', 'primary', 'stroke'] },
    { path: ['layers', 'roads', 'byProperty', 'highway', 'primary', 'body', 'color'] }
  ],
  roadsCasing: [
    { path: ['layers', 'roads', 'casing', 'color'] },
    { path: ['layers', 'roads', 'byProperty', 'highway', 'motorway', 'casing', 'color'] },
    { path: ['layers', 'roads', 'byProperty', 'highway', 'trunk', 'casing', 'color'] },
    { path: ['layers', 'roads', 'byProperty', 'highway', 'primary', 'casing', 'color'] }
  ],
  buildings: [
    { path: ['layers', 'buildings', 'stroke'] },
    { path: ['layers', 'buildings', 'body', 'color'] },
    { path: ['layers', 'buildings', 'glow', 'color'] }
  ],
  water: [
    { path: ['layers', 'water', 'stroke'] },
    { path: ['layers', 'water', 'body', 'color'] },
    { path: ['layers', 'water', 'glow', 'color'] }
  ],
  landuse: [
    { path: ['layers', 'landuse', 'stroke'] },
    { path: ['layers', 'landuse', 'body', 'color'] },
    { path: ['layers', 'landuse', 'glow', 'color'] }
  ],
  labels: [
    { path: ['labels', 'roads', 'fill'] },
    { path: ['labels', 'aip', 'fill'] },
    { path: ['labels', 'pois', 'fill'] },
    { path: ['labels', 'priorityClasses', 'important', 'fill'] },
    { path: ['labels', 'priorityClasses', 'normal', 'fill'] }
  ],
  critical: [
    { path: ['labels', 'priorityClasses', 'critical', 'fill'] }
  ]
};
const INTENSITY_PATCHES = {
  roads: [
    ['layers', 'roads', 'strokeOpacity'],
    ['layers', 'roads', 'body', 'opacity']
  ],
  buildings: [
    ['layers', 'buildings', 'strokeOpacity'],
    ['layers', 'buildings', 'body', 'opacity'],
    ['layers', 'buildings', 'glow', 'opacity']
  ],
  labels: [
    ['labels', 'roads', 'opacity'],
    ['labels', 'aip', 'opacity'],
    ['labels', 'pois', 'opacity'],
    ['labels', 'priorityClasses', 'important', 'opacity'],
    ['labels', 'priorityClasses', 'normal', 'opacity']
  ]
};

/**
 * @typedef {{
 *   name?: string,
 *   base?: string,
 *   colors?: Record<string, string>,
 *   intensity?: Record<string, number>,
 *   overrides?: Record<string, unknown>
 * }} StyleTheme
 */

/**
 * List bundled compact style themes.
 *
 * @returns {string[]}
 */
export function listStyleThemes() {
  return readdirSync(THEMES_DIR)
    .filter((file) => file.endsWith('.theme.json'))
    .map((file) => file.slice(0, -'.theme.json'.length))
    .sort();
}

/**
 * Read a bundled theme name or a local theme JSON file.
 *
 * @param {string} theme
 * @returns {StyleTheme}
 */
export function readStyleTheme(theme) {
  const filePath = theme.endsWith('.json') || theme.includes('/') || theme.includes('\\')
    ? resolve(theme)
    : bundledThemePath(theme);
  const document = JSON.parse(readFileSync(filePath, 'utf8'));
  validateTheme(document, theme);
  return /** @type {StyleTheme} */ (document);
}

/**
 * Expand a compact theme into a full map-zero style document.
 *
 * @param {StyleTheme | string} theme
 * @param {string[]} selectedLayers
 * @returns {Record<string, unknown>}
 */
export function createStyleFromTheme(theme, selectedLayers = SUPPORTED_LAYERS) {
  const themeDocument = typeof theme === 'string' ? readStyleTheme(theme) : theme;
  validateTheme(themeDocument, themeDocument.name ?? 'theme');
  const base = readStylePreset(themeDocument.base ?? 'neon-dark');
  const style = structuredClone(base);
  style.name = themeDocument.name ?? base.name ?? 'theme';

  applyThemeColors(style, themeDocument.colors ?? {});
  applyThemeIntensity(style, themeDocument.intensity ?? {});
  if (themeDocument.overrides && typeof themeDocument.overrides === 'object') {
    mergeObject(style, themeDocument.overrides);
  }

  return filterStyleLayers(style, selectedLayers);
}

/**
 * @param {string} themeName
 * @returns {string}
 */
function bundledThemePath(themeName) {
  if (!THEME_NAME_PATTERN.test(themeName)) {
    throw new Error(`invalid style theme name: ${themeName}`);
  }

  return join(THEMES_DIR, `${themeName}.theme.json`);
}

/**
 * @param {unknown} value
 * @param {string} source
 */
function validateTheme(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`style theme must be a JSON object: ${source}`);
  }
}

/**
 * @param {Record<string, unknown>} style
 * @param {Record<string, string>} colors
 */
function applyThemeColors(style, colors) {
  for (const [key, color] of Object.entries(colors)) {
    if (typeof color !== 'string') {
      continue;
    }

    for (const patch of COLOR_PATCHES[key] ?? []) {
      setPathIfPresent(style, patch.path, color);
    }
  }
}

/**
 * @param {Record<string, unknown>} style
 * @param {Record<string, number>} intensity
 */
function applyThemeIntensity(style, intensity) {
  for (const [key, value] of Object.entries(intensity)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      continue;
    }

    const opacity = Math.max(0, Math.min(1, numeric));
    for (const path of INTENSITY_PATCHES[key] ?? []) {
      setPathIfPresent(style, path, opacity);
    }
  }
}

/**
 * @param {Record<string, unknown>} target
 * @param {string[]} path
 * @param {unknown} value
 */
function setPathIfPresent(target, path, value) {
  let current = /** @type {Record<string, unknown> | undefined} */ (target);
  for (const segment of path.slice(0, -1)) {
    const next = current?.[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      return;
    }
    current = /** @type {Record<string, unknown>} */ (next);
  }

  const key = path.at(-1);
  if (current && key && Object.hasOwn(current, key)) {
    current[key] = value;
  }
}

/**
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 */
function mergeObject(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeObject(
        /** @type {Record<string, unknown>} */ (target[key]),
        /** @type {Record<string, unknown>} */ (value)
      );
    } else {
      target[key] = structuredClone(value);
    }
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
