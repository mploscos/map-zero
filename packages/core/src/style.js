import { layerAlias } from './shared/layers.js';
import { resolveManifestLayers } from './manifest.js';

export function getLayerRule(styleDocument, layer) {
  const layers = styleDocument.layers && typeof styleDocument.layers === 'object' ? styleDocument.layers : {};
  const id = layer.style || layer.id;
  return normalizeStyleRule(layers[id] || layers[layerAlias(id)] || {});
}

export function normalizeStyleRule(rule) {
  const normalized = { ...rule };
  const visibility = objectRule(rule.visibility);
  const body = objectRule(rule.body);
  const center = objectRule(rule.center);
  if (visibility) {
    normalized.visible = visibility.visible ?? normalized.visible;
    normalized.minZoom = visibility.minZoom ?? normalized.minZoom;
    normalized.maxZoom = visibility.maxZoom ?? normalized.maxZoom;
  }
  if (body) {
    normalized.stroke = body.color ?? normalized.stroke;
    normalized.strokeWidth = body.width ?? normalized.strokeWidth;
    normalized.strokeOpacity = body.opacity ?? normalized.strokeOpacity;
    normalized.lineCap = body.lineCap ?? normalized.lineCap;
    normalized.lineJoin = body.lineJoin ?? normalized.lineJoin;
    normalized.widthScale = body.widthScale ?? normalized.widthScale;
  }
  if (center) {
    normalized.fill = center.color ?? normalized.fill;
    normalized.fillOpacity = center.opacity ?? normalized.fillOpacity;
  }
  if (!normalized.lineCap) normalized.lineCap = 'round';
  if (!normalized.lineJoin) normalized.lineJoin = 'round';
  return normalized;
}

export function mergeFeatureRule(rule, feature) {
  let merged = { ...rule };
  const byProperty = objectRule(rule.byProperty);
  if (!byProperty) return merged;
  for (const [property, values] of Object.entries(byProperty)) {
    const override = objectRule(values?.[String(feature.get(property) ?? '')]);
    if (override) merged = normalizeStyleRule({ ...merged, ...override });
  }
  return merged;
}

export function orderManifestLayers(manifest, styleDocument) {
  const layers = resolveManifestLayers(manifest).map((layer) => ({ ...layer, style: layer.id }));
  const drawOrder = Array.isArray(styleDocument.drawOrder) ? styleDocument.drawOrder : layers.map((layer) => layer.id);
  return [...layers].sort((a, b) => {
    const ai = drawOrder.indexOf(a.id);
    const bi = drawOrder.indexOf(b.id);
    const ao = Number(getLayerRule(styleDocument, a).order ?? 0);
    const bo = Number(getLayerRule(styleDocument, b).order ?? 0);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || ao - bo;
  });
}

export function zoomMatchesRule(zoom, rule) {
  if (Number.isFinite(rule.minZoom) && zoom < Number(rule.minZoom)) return false;
  if (Number.isFinite(rule.maxZoom) && zoom > Number(rule.maxZoom)) return false;
  return rule.visible !== false;
}

export function styleWidth(value, fallback, layerId, zoom) {
  const width = Number(Array.isArray(value) ? fallback : value);
  const base = Number.isFinite(width) && width > 0 ? width : fallback;
  const scale = layerId === 'roads' ? Math.max(0.65, Math.min(1.35, 0.72 + zoom * 0.035)) : 1;
  return Math.max(0, base * scale);
}

export function objectRule(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
