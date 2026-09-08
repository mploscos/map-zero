/**
 * @typedef {{
 *   id: string,
 *   table?: string,
 *   geometryType?: string,
 *   minZoom?: number,
 *   maxZoom?: number,
 *   source?: string,
 *   tileProperties?: string[],
 *   tiles3d?: { strategy?: 'extruded'|'surface'|'line'|'points'|'mixed', height?: number, widthMeters?: number },
 *   featureZoom?: { minColumn?: string, maxColumn?: string }
 * }} ManifestLayerInput
 * @typedef {ManifestLayerInput & { table: string }} ManifestLayer
 */

/**
 * Resolve legacy string layers and descriptors without changing the manifest.
 * Public ids and storage table names are independent; omitted tables use id.
 * This module has no Node or renderer dependencies.
 *
 * @param {{ layers?: Array<string | ManifestLayerInput> }} manifest
 * @returns {ManifestLayer[]}
 */
export function resolveManifestLayers(manifest) {
  const layers = manifest.layers === undefined ? [] : manifest.layers;
  if (!Array.isArray(layers)) {
    throw new Error('manifest must contain a layers array');
  }
  const ids = new Set();
  return layers.map((value) => {
    const layer = typeof value === 'string' ? { id: value } : value;
    if (!layer || typeof layer !== 'object' || Array.isArray(layer) || !validName(layer.id)) {
      throw new Error('manifest layer must be a string or descriptor with a non-empty id');
    }
    if (ids.has(layer.id)) {
      throw new Error(`duplicate manifest layer id: ${layer.id}`);
    }
    ids.add(layer.id);
    const table = layer.table === undefined ? layer.id : layer.table;
    if (!validName(table)) {
      throw new Error(`invalid manifest table for layer: ${layer.id}`);
    }
    for (const key of ['geometryType', 'source']) {
      if (layer[key] !== undefined && !validName(layer[key])) {
        throw new Error(`invalid manifest ${key} for layer: ${layer.id}`);
      }
    }
    for (const key of ['minZoom', 'maxZoom']) {
      if (layer[key] !== undefined && (!Number.isFinite(layer[key]) || layer[key] < 0)) {
        throw new Error(`invalid manifest ${key} for layer: ${layer.id}`);
      }
    }
    if (layer.minZoom !== undefined && layer.maxZoom !== undefined && layer.minZoom > layer.maxZoom) {
      throw new Error(`manifest minZoom exceeds maxZoom for layer: ${layer.id}`);
    }
    if (layer.tileProperties !== undefined && (!Array.isArray(layer.tileProperties) ||
        !layer.tileProperties.every(validName))) {
      throw new Error(`invalid manifest tileProperties for layer: ${layer.id}`);
    }
    if (layer.tiles3d !== undefined) {
      const config = layer.tiles3d;
      if (!config || typeof config !== 'object' || Array.isArray(config) ||
          (config.strategy !== undefined && !['extruded', 'surface', 'line', 'points', 'mixed'].includes(config.strategy))) {
        throw new Error(`invalid manifest tiles3d strategy for layer: ${layer.id}`);
      }
      for (const key of ['height', 'widthMeters']) {
        if (config[key] !== undefined && (!Number.isFinite(config[key]) || config[key] < 0)) {
          throw new Error(`invalid manifest tiles3d ${key} for layer: ${layer.id}`);
        }
      }
    }
    if (layer.featureZoom !== undefined) {
      const fields = layer.featureZoom;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
          !Object.keys(fields).length || Object.keys(fields).some((key) =>
            !['minColumn', 'maxColumn'].includes(key) || !validName(fields[key]))) {
        throw new Error(`invalid manifest featureZoom for layer: ${layer.id}`);
      }
    }
    return { ...layer, table };
  });
}

/**
 * Check the optional inclusive vector zoom limits of a resolved layer.
 *
 * @param {{ minZoom?: number, maxZoom?: number }} layer
 * @param {number} zoom
 * @returns {boolean}
 */
export function isLayerInZoomRange(layer, zoom) {
  return (layer.minZoom === undefined || zoom >= layer.minZoom)
    && (layer.maxZoom === undefined || zoom <= layer.maxZoom);
}

/** @param {unknown} value @returns {boolean} */
function validName(value) {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

/** Test optional per-feature bounds in addition to the coarse layer range.
 * Missing/null values are unbounded, just as in the GeoPackage SQL reader.
 * @param {ManifestLayerInput} layer @param {(key:string)=>unknown} get
 * @param {number} zoom @returns {boolean}
 */
export function isFeatureInZoomRange(layer, get, zoom) {
  if (!isLayerInZoomRange(layer, zoom)) return false;
  const min = layer.featureZoom?.minColumn ? get(layer.featureZoom.minColumn) : null;
  const max = layer.featureZoom?.maxColumn ? get(layer.featureZoom.maxColumn) : null;
  return (min == null || zoom >= Number(min)) && (max == null || zoom <= Number(max));
}
