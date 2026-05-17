import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createStyleFromPreset,
  createStyleFromTheme,
  listStylePresets,
  listStyleThemes,
  readStyleTheme
} from './style.js';

/**
 * Rewrite a package style file without touching data.gpkg or tiles.pmtiles.
 *
 * @param {{ packageDir: string, preset?: string, theme?: string }} options
 * @returns {Promise<{ stylePath: string, styleUrl: string, name: string, sourceType: 'preset' | 'theme' }>}
 */
export async function writePackageStyle(options) {
  const packageDir = resolve(options.packageDir);
  if (options.preset && options.theme) {
    throw new Error('use either --preset or --theme, not both');
  }

  const manifestPath = join(packageDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.format !== 'mapzero' || !Array.isArray(manifest.layers)) {
    throw new Error('manifest must be a mapzero package with layers');
  }

  const selectedLayers = manifest.layers.map(String);
  const sourceType = options.theme ? 'theme' : 'preset';
  const styleDocument = options.theme
    ? createStyleFromTheme(options.theme, selectedLayers)
    : createStyleFromPreset(options.preset ?? 'neon-dark', selectedLayers);
  const name = String(styleDocument.name ?? (options.theme ? readStyleTheme(options.theme).name : options.preset) ?? 'style');
  const styleFile = `${safeStyleFileName(name)}.json`;
  const styleUrl = `styles/${styleFile}`;
  const stylePath = join(packageDir, 'styles', styleFile);
  await fs.mkdir(join(packageDir, 'styles'), { recursive: true });
  await fs.writeFile(stylePath, `${JSON.stringify(styleDocument, null, 2)}\n`);

  manifest.styles = {
    ...(manifest.styles && typeof manifest.styles === 'object' ? manifest.styles : {}),
    default: styleUrl,
    [name]: styleUrl
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    stylePath,
    styleUrl,
    name,
    sourceType
  };
}

/**
 * @returns {string[]}
 */
export function availableStylePresets() {
  return listStylePresets();
}

/**
 * @returns {string[]}
 */
export function availableStyleThemes() {
  return listStyleThemes();
}

/**
 * @param {string} name
 * @returns {string}
 */
function safeStyleFileName(name) {
  const safe = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'style';
}
