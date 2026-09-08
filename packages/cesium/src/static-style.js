import { Cesium3DTileStyle, Color } from 'cesium';
import { getLayerRule, mergeFeatureRule, objectRule, styleWidth, zoomMatchesRule } from '../../core/src/style.js';
import { resolveManifestLayers, isLayerInZoomRange } from '../../core/src/manifest.js';
const POLYGON_LAYERS = new Set(['landuse', 'terrain', 'water', 'buildings']);

/**
 * @typedef {{
 *   zoom?: number,
 *   visibility?: Map<string, boolean>,
 *   opacities?: Map<string, number>,
 *   excludedLayers?: Set<string>,
 *   opacity?: number
 * }} StaticStyleOptions
 */

/** Translate the shared theme into native per-feature Cesium styling.
 * @param {Record<string, unknown>} styleDocument
 * @param {StaticStyleOptions & {manifest?: object}} [options]
 */
export function createStaticTileStyle(styleDocument, options = {}) {
  return createStaticTileStyleFactory(styleDocument, options)(options);
}

/** Reuse immutable theme/feature resolution across zoom and control updates.
 * Create a new factory when replacing the theme, manifest or feature metadata.
 * Features are weakly held so unloading tiles releases their cached descriptions.
 * @param {Record<string, unknown>} styleDocument
 * @param {{manifest?: {layers?: Array<string | import('../../core/src/manifest.js').ManifestLayerInput>}}} [options]
 * @returns {(options?: StaticStyleOptions) => Cesium3DTileStyle}
 */
export function createStaticTileStyleFactory(styleDocument, options = {}) {
  const layers = new Map(resolveManifestLayers(options.manifest ?? {}).map(layer => [layer.id, layer]));
  const features = new WeakMap(), layerRules = new Map(), colors = new Map();
  const describe = feature => {
    const cached = features.get(feature);
    if (cached) return cached;
    const id = String(feature.getProperty('mapzero_layer') ?? feature.getProperty('_layer') ?? feature.getProperty('layer') ?? '');
    let layer = layerRules.get(id);
    if (!layer) {
      const rule = getLayerRule(styleDocument, { id });
      layer = {
        descriptor: layers.get(id) ?? layers.get(id === 'aip' ? 'aviation' : id) ?? { id },
        rule, classifiers: Object.entries(objectRule(rule.byProperty) ?? {}), variants: new Map()
      };
      layerRules.set(id, layer);
    }
    // Unknown property values all share the fallback; IDs/names do not create
    // unbounded rule variants when no corresponding override exists.
    const values = layer.classifiers.map(([key]) => String(feature.getProperty(key) ?? ''));
    const signature = JSON.stringify(values.map((value, i) => objectRule(layer.classifiers[i][1]?.[value]) ? value : null));
    let variant = layer.variants.get(signature);
    if (!variant) {
      const properties = new Map(layer.classifiers.map(([key], i) => [key, values[i]]));
      variant = { rule: mergeFeatureRule(layer.rule, { get: key => properties.get(key) }), paints: new Map() };
      layer.variants.set(signature, variant);
    }
    const geometry = String(feature.getProperty('mapzero_geometry') ?? layer.descriptor.geometryType ?? '').toUpperCase();
    const polygon = geometry ? geometry.includes('POLYGON') : POLYGON_LAYERS.has(id) || id === 'boundaries';
    const point = geometry ? geometry.includes('POINT') : id === 'pois';
    const kind = polygon ? 'polygon' : point ? 'point' : 'line';
    let paint = variant.paints.get(kind);
    if (!paint) {
      const rule = variant.rule;
      const css = String((id === 'buildings' ? rule.cesium?.color ?? rule.tiles3d?.color ?? rule.material?.color ?? '#8a3f82'
        : polygon || point ? rule.fill ?? rule.stroke : rule.stroke ?? rule.fill) ?? '#00ffff');
      let color = colors.get(css);
      if (!color) {
        color = Color.fromCssColorString(css) ?? Color.clone(Color.CYAN);
        colors.set(css, color);
      }
      const alpha = Number(id === 'buildings' ? 1 : polygon ? (rule.fill ? rule.fillOpacity ?? 1 : 0)
        : point ? rule.fillOpacity ?? 1 : rule.strokeOpacity ?? 1);
      paint = { color, alpha };
      variant.paints.set(kind, paint);
    }
    const info = { id, rule: variant.rule, descriptor: layer.descriptor, ...paint,
      minZoom: feature.getProperty('mapzero_minzoom') ?? 0,
      maxZoom: feature.getProperty('mapzero_maxzoom') ?? 24 };
    features.set(feature, info);
    return info;
  };
  return (options = {}) => {
    const zoom = options.zoom ?? 16;
    const visibility = options.visibility ?? new Map();
    const opacities = options.opacities ?? new Map();
    const excludedLayers = options.excludedLayers ?? new Set();
    const evaluateColor = (feature, result) => {
      const info = describe(feature);
      const color = Color.clone(info.color, result);
      color.alpha *= Math.max(0, Math.min(1, info.alpha * (opacities.get(info.id) ?? options.opacity ?? 1)));
      return color;
    };
    return new Cesium3DTileStyle({
      show: { evaluate(feature) {
        const { id, rule, descriptor, minZoom, maxZoom } = describe(feature);
        return !excludedLayers.has(id) && visibility.get(id) !== false
          && isLayerInZoomRange(descriptor, zoom) && zoomMatchesRule(zoom, rule)
          && zoom >= minZoom && zoom <= maxZoom;
      } },
      color: { evaluate: evaluateColor, evaluateColor },
      lineWidth: { evaluate(feature) {
        const { id, rule } = describe(feature);
        return styleWidth(rule.strokeWidth, 1, id, zoom);
      } },
      pointSize: { evaluate(feature) {
        const { id, rule } = describe(feature);
        return 2 * styleWidth(rule.radius ?? rule.circleRadius, 3, id, zoom);
      } }
    });
  };
}
