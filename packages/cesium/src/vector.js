import { createCesiumLabels } from './cesium-labels.js';
import { BoundingSphere, Cartesian3, Cesium3DTileStyle, Color, HeightReference, MVTDataProvider, Rectangle } from 'cesium';
import { getLayerRule, mergeFeatureRule, styleWidth, zoomMatchesRule } from '../../core/src/style.js';

const POLYGON_LAYERS = new Set(['landuse', 'terrain', 'water', 'buildings']);

/** Keep Cesium's eager runtime hierarchy bounded before allocating tile nodes. */
export function vectorZoomRange(bbox, minZoom = 8, maxZoom = 16, maxNodes = 20000) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)
    || bbox[0] >= bbox[2] || bbox[1] >= bbox[3] || bbox[0] < -180 || bbox[2] > 180
    || bbox[1] < -85.05112878 || bbox[3] > 85.05112878) {
    throw new Error('Native vector rendering requires a valid Web Mercator manifest bbox');
  }
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom < 0 || maxZoom > 22 || minZoom > maxZoom) {
    throw new Error('Native vector zoom range must satisfy 0 <= minZoom <= maxZoom <= 22');
  }
  const tileY = (lat, n) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
  let nodes = 0;
  let effectiveMaxZoom = minZoom;
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z;
    const columns = Math.floor((bbox[2] + 180) / 360 * n) - Math.floor((bbox[0] + 180) / 360 * n) + 1;
    const rows = Math.floor(tileY(bbox[1], n)) - Math.floor(tileY(bbox[3], n)) + 1;
    if (nodes + columns * rows > maxNodes) {
      if (z === minZoom) throw new Error('Native vector extent is too large at minZoom; use a smaller package or lower minZoom');
      break;
    }
    nodes += columns * rows;
    effectiveMaxZoom = z;
  }
  return { minZoom, maxZoom: effectiveMaxZoom, estimatedNodes: nodes };
}

/** Translate the shared map-zero theme into native per-feature Cesium styling.
 * Labels, glow, dashes and multi-pass road casings are not supported by MVTDataProvider.
 */
export function createNativeVectorStyle(styleDocument, options = {}) {
  const zoom = options.zoom ?? 16;
  const visibility = options.visibility ?? new Map();
  const opacities = options.opacities ?? new Map();
  const excludedLayers = options.excludedLayers ?? new Set();
  const rules = new WeakMap();
  const describe = (feature) => {
    if (rules.has(feature)) return rules.get(feature);
    const layer = String(feature.getProperty('_layer') ?? feature.getProperty('layer') ?? '');
    const id = layer === 'aviation' ? 'aip' : layer;
    const rule = mergeFeatureRule(getLayerRule(styleDocument, { id }), { get: (key) => feature.getProperty(key) });
    const geometry = String(feature.getProperty('mapzero_geometry') ?? '');
    const polygon = geometry ? geometry.includes('Polygon') : POLYGON_LAYERS.has(id) || id === 'boundaries';
    const point = geometry ? geometry.includes('Point') : id === 'pois';
    const info = { id, rule, polygon, point };
    rules.set(feature, info);
    return info;
  };
  const evaluateColor = (feature, result) => {
    const { id, rule, polygon, point } = describe(feature);
    const css = polygon || point ? rule.fill ?? rule.stroke : rule.stroke ?? rule.fill;
    const color = Color.fromCssColorString(String(css ?? '#00ffff'), result) ?? Color.clone(Color.CYAN, result);
    const alpha = polygon ? (rule.fill ? rule.fillOpacity ?? 1 : 0) : point ? rule.fillOpacity ?? 1 : rule.strokeOpacity ?? 1;
    color.alpha *= Math.max(0, Math.min(1, Number(alpha) * (opacities.get(id) ?? options.opacity ?? 1)));
    return color;
  };
  return new Cesium3DTileStyle({
    show: { evaluate(feature) {
      const { id, rule } = describe(feature);
      return !excludedLayers.has(id) && visibility.get(id) !== false && zoomMatchesRule(zoom, rule);
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
}

/** Native MVT rendering, using the public Cesium 1.145 provider API. */
export async function createMapZeroVectorContext(viewer, options) {
  if (!options.vectorTilesUrl) throw new Error('Native vector rendering requires vectorTilesUrl with /{z}/{x}/{y}.mvt');
  const template = new URL(options.vectorTilesUrl, new URL(options.manifestUrl, globalThis.location?.href ?? 'http://localhost/')).href
    .replaceAll('%7B', '{').replaceAll('%7D', '}');
  if (!['{z}', '{x}', '{y}'].every((token) => template.includes(token))) throw new Error('vectorTilesUrl must include {z}, {x}, and {y}');
  const range = vectorZoomRange(options.manifest.bbox,
    options.manifest.tiles?.minZoom ?? 8, Math.min(options.vectorMaxZoom ?? options.manifest.tiles?.maxZoom ?? 16, options.manifest.tiles?.maxZoom ?? 16));
  const provider = await MVTDataProvider.fromUrl(template, {
    minZoom: range.minZoom,
    maxZoom: range.maxZoom,
    extent: Rectangle.fromDegrees(...options.manifest.bbox),
    heightReference: options.vectorHeightReference ?? HeightReference.CLAMP_TO_TERRAIN,
    scene: viewer.scene
  });
  const visibility = new Map();
  const opacities = new Map();
  const excludedLayers = new Set(options.excludedLayers ?? []);
  let zoom;
  const bbox = options.manifest.bbox;
  const latitude = (bbox[1] + bbox[3]) / 2;
  const center = new BoundingSphere(Cartesian3.fromDegrees((bbox[0] + bbox[2]) / 2, latitude), 1);
  const getZoom = () => {
    const resolution = viewer.camera.getPixelSize(center, viewer.scene.canvas.clientWidth, viewer.scene.canvas.clientHeight);
    return Math.max(0, Math.min(22, Math.round(Math.log2(156543.033928 * Math.cos(latitude * Math.PI / 180) / Math.max(0.001, resolution)))));
  };
  const refresh = () => {
    const nextZoom = getZoom();
    zoom = nextZoom;
    provider.tileset.style = createNativeVectorStyle(options.styleDocument ?? {}, {
      zoom, visibility, opacities, excludedLayers, opacity: options.contextOpacity ?? options.opacity ?? 1
    });
    viewer.scene.requestRender?.();
  };
  provider.tileset.maximumScreenSpaceError = 8;
  provider.tileset.cacheBytes = 128 * 1024 * 1024;
  provider.tileset.maximumCacheOverflowBytes = 64 * 1024 * 1024;
  provider.tileset.preloadWhenHidden = false;
  let labels;
  try {
    labels = createCesiumLabels(viewer, provider.tileset, {
      ...options, styleDocument: options.styleDocument ?? {}, visibility, opacities, getZoom,
      opacity: options.contextOpacity ?? options.opacity ?? 1
    });
  } catch (error) {
    provider.destroy();
    throw error;
  }
  refresh();
  const removeCameraListener = viewer.camera?.moveEnd?.addEventListener(() => refresh());
  return {
    provider,
    range,
    labels,
    setVisible(id, visible) { visibility.set(id === 'aviation' ? 'aip' : id, Boolean(visible)); refresh(); },
    setOpacity(id, opacity) { opacities.set(id === 'aviation' ? 'aip' : id, Math.max(0, Math.min(1, Number(opacity)))); refresh(); },
    destroy() { removeCameraListener?.(); labels.destroy(); }
  };
}
