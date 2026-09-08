import { resolveManifestLayers } from '../manifest.js';

export const DEFAULT_CONTEXT_LAYERS = ['landuse', 'terrain', 'water', 'coastline', 'cliffs', 'railways', 'roads', 'boundaries', 'aviation', 'pois'];

export function normalizeContextLayers(layers) {
  const values = Array.isArray(layers) && layers.length > 0 ? layers : DEFAULT_CONTEXT_LAYERS;
  return values.map((layer) => sourceLayerFor(String(layer)));
}

export function isLayerVisible(layerVisibility, layer) {
  const direct = layerVisibility.get(layer);
  if (direct != null) return direct;
  const source = layerVisibility.get(sourceLayerFor(layer));
  if (source != null) return source;
  return layerVisibility.get(layerAlias(layer)) === true;
}

export function sourceLayerFor(layer) {
  return layer === 'aviation' ? 'aip' : layer;
}

export function layerAlias(layer) {
  if (layer === 'aip') return 'aviation';
  if (layer === 'aviation') return 'aip';
  return layer;
}

export function isAipLayer(layer) {
  return layer === 'aip' || layer === 'aviation';
}

export function manifestLayer(layer) {
  const [descriptor] = resolveManifestLayers({ layers: [layer] });
  return { ...descriptor, style: descriptor.id };
}
