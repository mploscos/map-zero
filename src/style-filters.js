/**
 * Build server/export-side filters for style rules hidden with byProperty.*.visible=false.
 *
 * @param {Record<string, unknown>} manifest
 * @param {Record<string, unknown> | null} style
 * @returns {import('./gpkg-read.js').HiddenFilters}
 */
export function createHiddenFilters(manifest, style) {
  const filters = new Map();
  const manifestLayers = Array.isArray(manifest.layers) ? manifest.layers : [];
  const styleLayers = /** @type {Record<string, unknown> | undefined} */ (style?.layers);

  if (!styleLayers || typeof styleLayers !== 'object') {
    return filters;
  }

  for (const layer of manifestLayers) {
    const layerId = String(layer);
    const styleId = layerId;
    const styleRule = /** @type {Record<string, unknown> | undefined} */ (styleLayers[styleId] ?? styleLayers[layerAlias(styleId)]);
    const byProperty = /** @type {Record<string, unknown> | undefined} */ (styleRule?.byProperty);

    if (!byProperty || typeof byProperty !== 'object') {
      continue;
    }

    const layerFilters = new Map();
    for (const [propertyName, values] of Object.entries(byProperty)) {
      if (!values || typeof values !== 'object') {
        continue;
      }

      for (const [value, overrides] of Object.entries(/** @type {Record<string, unknown>} */ (values))) {
        if (styleOverrideVisible(overrides) === false) {
          if (!layerFilters.has(propertyName)) {
            layerFilters.set(propertyName, new Set());
          }
          layerFilters.get(propertyName).add(value);
        }
      }
    }

    if (layerFilters.size > 0) {
      filters.set(layerId, layerFilters);
    }
  }

  return filters;
}

/**
 * @param {string} layerId
 * @returns {string}
 */
function layerAlias(layerId) {
  if (layerId === 'aip') return 'aviation';
  if (layerId === 'aviation') return 'aip';
  return layerId;
}

/**
 * @param {unknown} overrides
 * @returns {boolean | undefined}
 */
function styleOverrideVisible(overrides) {
  if (!overrides || typeof overrides !== 'object') {
    return undefined;
  }

  const record = /** @type {Record<string, unknown>} */ (overrides);
  const visibility = record.visibility && typeof record.visibility === 'object'
    ? /** @type {Record<string, unknown>} */ (record.visibility)
    : null;
  return /** @type {boolean | undefined} */ (visibility?.visible ?? record.visible);
}
