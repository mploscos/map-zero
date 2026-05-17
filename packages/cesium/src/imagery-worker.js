import Feature from 'ol/Feature.js';
import MVT from 'ol/format/MVT.js';
import { PMTiles } from 'pmtiles';

const DEFAULT_CONTEXT_LAYERS = ['roads', 'railways', 'water', 'landuse', 'boundaries', 'aviation', 'pois'];
const WEB_MERCATOR_MAX = 20037508.342789244;
const LABEL_SOURCE_LAYERS = new Set(['roads', 'aip', 'aviation', 'pois']);
const MAJOR_ROADS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']);
const SECONDARY_ROADS = new Set(['secondary', 'secondary_link']);
const LOCAL_ROADS = new Set(['residential', 'living_street', 'unclassified']);
const DISABLED_ROADS = new Set(['service', 'track', 'path', 'footway', 'cycleway', 'steps', 'corridor', 'platform']);
const GENERIC_LABEL_VALUES = new Set(['yes', 'no', 'true', 'false', 'unknown', 'none', 'station', 'airport', 'aerodrome']);

let state = null;

self.addEventListener('message', (event) => {
  handleMessage(event.data).catch((error) => {
    if (event.data?.id != null) {
      self.postMessage({ type: 'tile', id: event.data.id, error: error.message, metrics: state?.metrics });
    } else {
      self.postMessage({ type: 'error', error: error.message, metrics: state?.metrics });
    }
  });
});

async function handleMessage(message) {
  if (message?.type === 'init') {
    state = createState(message.options);
    return;
  }

  if (!state) {
    throw new Error('map-zero imagery worker was not initialized');
  }

  if (message?.type === 'visibility') {
    state.layerVisibility.set(sourceLayerFor(message.layerId), Boolean(message.visible));
    state.layerVisibility.set(layerAlias(message.layerId), Boolean(message.visible));
    return;
  }

  if (message?.type === 'render') {
    const image = await renderTile(message.x, message.y, message.z);
    self.postMessage({ type: 'tile', id: message.id, image, metrics: state.metrics }, [image]);
  }
}

function createState(options) {
  const manifest = options.manifest;
  const styleDocument = options.styleDocument ?? {};
  const layerIds = normalizeContextLayers(options.layers);
  return {
    manifest,
    manifestUrl: options.manifestUrl,
    styleDocument,
    tileSize: Number(options.tileSize ?? 512),
    pixelRatio: clampNumber(options.pixelRatio ?? 1, 1, 2),
    sourceMaximumLevel: Number(options.sourceMaximumLevel ?? pmtilesInfo(manifest).maxZoom ?? 18),
    edgeGuardPixels: clampInteger(options.edgeGuardPixels ?? 0, 0, 8),
    layerIds,
    layerVisibility: new Map(layerIds.map((layerId) => [layerId, true])),
    orderedLayers: orderManifestLayers(manifest, styleDocument)
      .filter((layer) => layerIds.includes(layer.id) || layerIds.includes(layerAlias(layer.id))),
    format: new MVT({ featureClass: Feature }),
    archive: new PMTiles(resolveRelativeUrl(String(options.source ?? pmtilesInfo(manifest).url ?? 'tiles.pmtiles'), options.manifestUrl)),
    sourceTileCache: new Map(),
    metrics: createMetrics()
  };
}

async function renderTile(x, y, z) {
  return renderTileBitmap(x, y, z);
}

async function renderTileBitmap(x, y, z) {
  const started = performance.now();
  state.metrics.requested++;
  addMetricCount(state.metrics.requestLevels, z);

  const sourceTile = sourceTileForRequest(x, y, z, state.sourceMaximumLevel);
  let canvas;
  if (sourceTile.z !== z) {
    state.metrics.overzoomed++;
    addMetricCount(state.metrics.sourceLevels, sourceTile.z);
    canvas = await renderOverzoomedTile(sourceTile, x, y, z);
  } else {
    canvas = await renderSourceTile(sourceTile, tileMercatorExtent(x, y, z), z, state.tileSize);
  }

  recordMetricTime(state.metrics, 'renderMs', performance.now() - started);
  return canvas.transferToImageBitmap();
}

async function renderOverzoomedTile(sourceTile, x, y, z) {
  const { canvas, ctx } = createRenderCanvas(state.tileSize, state.pixelRatio);
  if (!ctx) return canvas;

  const sourceData = await readSourceTile(sourceTile);
  if (!sourceData) return canvas;
  drawSourceData(ctx, sourceData, tileMercatorExtent(x, y, z), z, state.tileSize);
  clearCanvasBorder(ctx, state.tileSize, state.tileSize, state.edgeGuardPixels);
  return canvas;
}

async function renderSourceTile(sourceTile, renderExtent, z, size) {
  const { canvas, ctx } = createRenderCanvas(size, state.pixelRatio);
  if (!ctx) return canvas;

  const sourceData = await readSourceTile(sourceTile);
  if (!sourceData) return canvas;
  drawSourceData(ctx, sourceData, renderExtent, z, size);
  clearCanvasBorder(ctx, size, size, state.edgeGuardPixels);
  return canvas;
}

function createRenderCanvas(size, pixelRatio) {
  const ratio = clampNumber(pixelRatio, 1, 2);
  const canvas = new OffscreenCanvas(Math.round(size * ratio), Math.round(size * ratio));
  const ctx = canvas.getContext('2d');
  if (ctx && ratio !== 1) ctx.scale(ratio, ratio);
  return { canvas, ctx };
}

async function readSourceTile(tile) {
  const key = `${tile.z}/${tile.x}/${tile.y}`;
  const cached = state.sourceTileCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const started = performance.now();
    const result = await state.archive.getZxy(tile.z, tile.x, tile.y);
    if (!result) return null;
    addMetricCount(state.metrics.sourceLevels, tile.z);
    const features = state.format.readFeatures(result.data, {
      extent: tileMercatorExtent(tile.x, tile.y, tile.z),
      featureProjection: 'EPSG:3857'
    });
    state.metrics.decoded++;
    state.metrics.features += features.length;
    recordMetricTime(state.metrics, 'decodeMs', performance.now() - started);
    return {
      features,
      byLayer: groupFeaturesByLayer(features)
    };
  })();
  state.sourceTileCache.set(key, promise);
  return promise;
}

function drawSourceData(ctx, sourceData, renderExtent, z, size) {
  const { features, byLayer } = sourceData;
  for (const layer of state.orderedLayers) {
    if (!isLayerVisible(state.layerVisibility, layer.id) || !zoomMatchesRule(z, getLayerRule(state.styleDocument, layer))) continue;
    const layerFeatures = byLayer.get(sourceLayerFor(layer.id)) ?? byLayer.get(layer.id) ?? [];
    drawLayer(ctx, layerFeatures, layer, getLayerRule(state.styleDocument, layer), renderExtent, size, z);
  }
  drawLabels(ctx, features, state.styleDocument, renderExtent, size, z, state.layerVisibility);
}

function drawLayer(ctx, features, layer, rule, extent, size, zoom) {
  for (const feature of features) {
    const geometry = feature.getGeometry?.();
    if (!geometry) continue;
    const featureRule = mergeFeatureRule(rule, feature);
    if (featureRule.visible === false) continue;
    const type = geometry.getType();
    if (layer.id === 'boundaries' && (type === 'Polygon' || type === 'MultiPolygon')) {
      drawGeometry(ctx, geometry, { ...featureRule, stroke: null, strokeOpacity: 0, glow: { enabled: false }, casing: { enabled: false } }, extent, size, layer.id, zoom);
    } else if (isAipLayer(layer.id) && (type === 'LineString' || type === 'MultiLineString')) {
      drawGeometry(ctx, geometry, { ...featureRule, fill: null, fillOpacity: 0 }, extent, size, layer.id, zoom);
    } else {
      drawGeometry(ctx, geometry, featureRule, extent, size, layer.id, zoom);
    }
  }
}

function drawGeometry(ctx, geometry, rule, extent, size, layerId, zoom) {
  const type = geometry.getType();
  const draw = (style) => {
    if (type === 'Polygon') return drawPolygons(ctx, [geometry.getCoordinates()], style, extent, size);
    if (type === 'MultiPolygon') return drawPolygons(ctx, geometry.getCoordinates(), style, extent, size);
    if (type === 'LineString') return drawLines(ctx, [geometry.getCoordinates()], style, extent, size);
    if (type === 'MultiLineString') return drawLines(ctx, geometry.getCoordinates(), style, extent, size);
    if (type === 'Point') return drawPoints(ctx, [geometry.getCoordinates()], style, extent, size);
    if (type === 'MultiPoint') return drawPoints(ctx, geometry.getCoordinates(), style, extent, size);
    return undefined;
  };
  for (const style of canvasStyleParts(rule, geometryTypeKind(type), layerId, zoom)) draw(style);
}

function canvasStyleParts(rule, kind, layerId, zoom) {
  const parts = [];
  if (rule.glow?.enabled && rule.stroke) parts.push({ stroke: colorWithOpacity(String(rule.glow.color || rule.stroke), opacity(rule.glow.opacity, 0.2)), width: styleWidth(rule.glow.width ?? rule.glowWidth, 4, layerId, zoom), lineCap: rule.lineCap, lineJoin: rule.lineJoin });
  if (rule.casing?.enabled && rule.stroke && kind !== 'point') parts.push({ stroke: colorWithOpacity(String(rule.casing.color || rule.stroke), opacity(rule.casing.opacity, 0.35)), width: styleWidth(rule.casing.width ?? rule.casingWidth, Number(rule.strokeWidth ?? 1) + 1, layerId, zoom), lineCap: rule.lineCap, lineJoin: rule.lineJoin });
  const base = {};
  if (rule.fill && kind !== 'line') base.fill = colorWithOpacity(String(rule.fill), opacity(rule.fillOpacity, 1));
  if (rule.stroke && kind !== 'polygon-fill-only') {
    base.stroke = colorWithOpacity(String(rule.stroke), opacity(rule.strokeOpacity, 1));
    base.width = styleWidth(rule.strokeWidth, 1, layerId, zoom);
    base.lineCap = rule.lineCap;
    base.lineJoin = rule.lineJoin;
  }
  if (kind === 'point') {
    base.radius = styleWidth(rule.radius ?? rule.circleRadius, 4, layerId, zoom);
    base.fill = colorWithOpacity(String(rule.fill || rule.stroke || '#ffffff'), opacity(rule.fillOpacity ?? rule.strokeOpacity, 1));
    if (rule.stroke) {
      base.stroke = colorWithOpacity(String(rule.stroke), opacity(rule.strokeOpacity, 1));
      base.width = styleWidth(rule.strokeWidth, 1, layerId, zoom);
    }
  }
  parts.push(base);
  if (rule.centerLine?.enabled && rule.stroke && kind !== 'point') parts.push({ stroke: colorWithOpacity(String(rule.centerLine.color || rule.stroke), opacity(rule.centerLine.opacity, 0.5)), width: styleWidth(rule.centerLine.width, 0.5, layerId, zoom), lineCap: rule.lineCap, lineJoin: rule.lineJoin });
  return parts;
}

function drawPolygons(ctx, polygons, style, extent, size) {
  if (!style.fill && !style.stroke) return;
  ctx.save();
  clipCanvas(ctx, size);
  ctx.beginPath();
  for (const polygon of polygons) for (const ring of polygon) traceLine(ctx, ring, extent, size, true);
  if (style.fill) {
    ctx.fillStyle = style.fill;
    ctx.fill('evenodd');
  }
  if (style.stroke && style.width > 0) {
    applyStroke(ctx, style);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLines(ctx, lines, style, extent, size) {
  if (!style.stroke || !(style.width > 0)) return;
  ctx.save();
  clipCanvas(ctx, size);
  applyStroke(ctx, style);
  ctx.beginPath();
  for (const line of lines) traceLine(ctx, line, extent, size);
  ctx.stroke();
  ctx.restore();
}

function drawPoints(ctx, points, style, extent, size) {
  const radius = Number(style.radius ?? 4);
  if (!style.fill && !style.stroke) return;
  ctx.save();
  clipCanvas(ctx, size);
  for (const point of points) {
    const [px, py] = projectPoint(point, extent, size);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    if (style.fill) {
      ctx.fillStyle = style.fill;
      ctx.fill();
    }
    if (style.stroke && style.width > 0) {
      applyStroke(ctx, style);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawLabels(ctx, features, styleDocument, extent, size, zoom, layerVisibility) {
  if (styleDocument.labels?.enabled === false) return;
  const labels = [];
  for (const feature of features) {
    const layer = sourceLayerFor(String(feature.get('layer') ?? ''));
    if (!LABEL_SOURCE_LAYERS.has(layer) || layerVisibility.get(layer) === false) continue;
    const label = labelForFeature(feature, layer, zoom);
    const point = label ? labelPoint(feature.getGeometry?.()) : null;
    if (label && point) labels.push({ ...label, point });
  }
  labels.sort((a, b) => a.priority - b.priority);
  const occupied = [];
  for (const label of labels.slice(-160)) {
    const [x, y] = projectPoint(label.point, extent, size);
    const fontSize = zoom >= 17 ? 12 : zoom >= 15 ? 11 : 10;
    ctx.save();
    ctx.font = `600 ${fontSize}px sans-serif`;
    const width = ctx.measureText(label.text).width;
    const box = [x - width / 2 - 3, y - fontSize / 2 - 3, x + width / 2 + 3, y + fontSize / 2 + 3];
    if (occupied.some((other) => boxesOverlap(box, other))) {
      ctx.restore();
      continue;
    }
    occupied.push(box);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,16,20,0.92)';
    ctx.lineWidth = 3;
    ctx.strokeText(label.text, x, y);
    ctx.fillStyle = 'rgba(217,251,255,0.9)';
    ctx.fillText(label.text, x, y);
    ctx.restore();
  }
}

function labelForFeature(feature, layer, zoom) {
  if (layer === 'roads') {
    const highway = String(feature.get('highway') ?? '');
    if (DISABLED_ROADS.has(highway)) return null;
    const ref = cleanText(feature.get('ref'));
    const name = cleanText(feature.get('name'));
    if (MAJOR_ROADS.has(highway) && zoom >= 12 && isMeaningfulLabel(ref)) return { text: ref, priority: 820 };
    if (SECONDARY_ROADS.has(highway) && zoom >= 16 && isMeaningfulLabel(ref)) return { text: ref, priority: 700 };
    if (LOCAL_ROADS.has(highway) && zoom >= 17 && isMeaningfulLabel(name)) return { text: name, priority: 400 };
  } else if (isAipLayer(layer)) {
    const aeroway = String(feature.get('aeroway') ?? '');
    const ref = cleanText(feature.get('ref'));
    const name = cleanText(feature.get('name'));
    if ((aeroway === 'aerodrome' || aeroway === 'heliport') && zoom >= 11 && zoom < 15) return meaningfulLabel(name || ref, 980);
    if (aeroway === 'runway' && zoom >= 12) return meaningfulLabel(ref || name || 'RWY', 900);
    if ((aeroway === 'terminal' || aeroway === 'apron') && zoom >= 15) return meaningfulLabel(name || ref, 720);
    if (aeroway === 'helipad' && zoom >= 14) return meaningfulLabel(ref || name || 'H', 980);
  } else if (layer === 'pois' && zoom >= 13) {
    return meaningfulLabel(cleanText(feature.get('name') ?? feature.get('ref') ?? feature.get('operator')), 620);
  }
  return null;
}

function getLayerRule(styleDocument, layer) {
  const layers = styleDocument.layers && typeof styleDocument.layers === 'object' ? styleDocument.layers : {};
  const id = layer.style || layer.id;
  return normalizeStyleRule(layers[id] || layers[layerAlias(id)] || {});
}

function normalizeStyleRule(rule) {
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
  }
  if (center) {
    normalized.fill = center.color ?? normalized.fill;
    normalized.fillOpacity = center.opacity ?? normalized.fillOpacity;
  }
  if (!normalized.lineCap) normalized.lineCap = 'round';
  if (!normalized.lineJoin) normalized.lineJoin = 'round';
  return normalized;
}

function mergeFeatureRule(rule, feature) {
  let merged = { ...rule };
  const byProperty = objectRule(rule.byProperty);
  if (!byProperty) return merged;
  for (const [property, values] of Object.entries(byProperty)) {
    const override = objectRule(values?.[String(feature.get(property) ?? '')]);
    if (override) merged = normalizeStyleRule({ ...merged, ...override });
  }
  return merged;
}

function orderManifestLayers(manifest, styleDocument) {
  const layers = Array.isArray(manifest.layers) ? manifest.layers.map(manifestLayer) : [];
  const drawOrder = Array.isArray(styleDocument.drawOrder) ? styleDocument.drawOrder : layers.map((layer) => layer.id);
  return [...layers].sort((a, b) => {
    const ai = drawOrder.indexOf(a.id);
    const bi = drawOrder.indexOf(b.id);
    const ao = Number(getLayerRule(styleDocument, a).order ?? 0);
    const bo = Number(getLayerRule(styleDocument, b).order ?? 0);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || ao - bo;
  });
}

function manifestLayer(layerId) {
  return { id: String(layerId), style: String(layerId) };
}

function groupFeaturesByLayer(features) {
  const groups = new Map();
  for (const feature of features) {
    const layer = sourceLayerFor(String(feature.get('layer') ?? ''));
    if (!groups.has(layer)) groups.set(layer, []);
    groups.get(layer).push(feature);
  }
  return groups;
}

function zoomMatchesRule(zoom, rule) {
  if (Number.isFinite(rule.minZoom) && zoom < Number(rule.minZoom)) return false;
  if (Number.isFinite(rule.maxZoom) && zoom > Number(rule.maxZoom)) return false;
  return rule.visible !== false;
}

function styleWidth(value, fallback, layerId, zoom) {
  const width = Number(Array.isArray(value) ? fallback : value);
  const base = Number.isFinite(width) && width > 0 ? width : fallback;
  const scale = layerId === 'roads' ? Math.max(0.65, Math.min(1.35, 0.72 + zoom * 0.035)) : 1;
  return Math.max(0, base * scale);
}

function traceLine(ctx, line, extent, size, close = false) {
  let first = true;
  for (const point of line) {
    const [px, py] = projectPoint(point, extent, size);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      first = true;
    } else if (first) {
      ctx.moveTo(px, py);
      first = false;
    } else {
      ctx.lineTo(px, py);
    }
  }
  if (close) ctx.closePath();
}

function labelPoint(geometry) {
  if (!geometry) return null;
  const type = geometry.getType();
  if (type === 'Point') return geometry.getCoordinates();
  if (type === 'MultiPoint') return geometry.getCoordinates()[0] ?? null;
  if (type === 'LineString') return middlePoint(geometry.getCoordinates());
  if (type === 'MultiLineString') return middlePoint(geometry.getCoordinates()[0] ?? []);
  if (type === 'Polygon') return ringCenter(geometry.getCoordinates()[0] ?? []);
  if (type === 'MultiPolygon') return ringCenter(geometry.getCoordinates()[0]?.[0] ?? []);
  return null;
}

function middlePoint(line) {
  return line[Math.max(0, Math.floor(line.length / 2))] ?? null;
}

function ringCenter(ring) {
  if (!ring.length) return null;
  let x = 0;
  let y = 0;
  for (const point of ring) {
    x += point[0];
    y += point[1];
  }
  return [x / ring.length, y / ring.length];
}

function clipCanvas(ctx, size) {
  ctx.beginPath();
  ctx.rect(0, 0, size, size);
  ctx.clip();
}

function applyStroke(ctx, style) {
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = Math.max(0, Number(style.width ?? 1));
  ctx.lineCap = String(style.lineCap || 'round');
  ctx.lineJoin = String(style.lineJoin || 'round');
}

function clearCanvasBorder(ctx, width, height, pixels) {
  if (!(pixels > 0)) return;
  ctx.clearRect(0, 0, width, pixels);
  ctx.clearRect(0, height - pixels, width, pixels);
  ctx.clearRect(0, 0, pixels, height);
  ctx.clearRect(width - pixels, 0, pixels, height);
}

function boxesOverlap(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function projectPoint(point, extent, size) {
  const [minX, minY, maxX, maxY] = extent;
  return [((point[0] - minX) / (maxX - minX)) * size, ((maxY - point[1]) / (maxY - minY)) * size];
}

function geometryTypeKind(type) {
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon';
  return 'line';
}

function tileMercatorExtent(x, y, z) {
  const span = (WEB_MERCATOR_MAX * 2) / 2 ** z;
  const minX = -WEB_MERCATOR_MAX + x * span;
  const maxX = minX + span;
  const maxY = WEB_MERCATOR_MAX - y * span;
  const minY = maxY - span;
  return [minX, minY, maxX, maxY];
}

function sourceTileForRequest(x, y, z, maxZoom) {
  const sourceZ = Math.min(z, maxZoom);
  if (sourceZ === z) return { x, y, z };
  const shift = z - sourceZ;
  return { x: Math.floor(x / 2 ** shift), y: Math.floor(y / 2 ** shift), z: sourceZ };
}

function normalizeContextLayers(layers) {
  const values = Array.isArray(layers) && layers.length > 0 ? layers : DEFAULT_CONTEXT_LAYERS;
  return values.map((layer) => sourceLayerFor(String(layer)));
}

function isLayerVisible(layerVisibility, layer) {
  const direct = layerVisibility.get(layer);
  if (direct != null) return direct;
  const source = layerVisibility.get(sourceLayerFor(layer));
  if (source != null) return source;
  return layerVisibility.get(layerAlias(layer)) === true;
}

function sourceLayerFor(layer) {
  return layer === 'aviation' ? 'aip' : layer;
}

function layerAlias(layer) {
  if (layer === 'aip') return 'aviation';
  if (layer === 'aviation') return 'aip';
  return layer;
}

function isAipLayer(layer) {
  return layer === 'aip' || layer === 'aviation';
}

function colorWithOpacity(color, alpha) {
  if (color.startsWith('rgba(') || color.startsWith('hsla(')) return color;
  const rgb = parseHexColor(color);
  return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : color;
}

function parseHexColor(color) {
  const match = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].split('').map((char) => char + char).join('') : match[1];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function opacity(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isMeaningfulLabel(text) {
  const normalized = cleanText(text);
  return normalized.length >= 2 && !GENERIC_LABEL_VALUES.has(normalized.toLowerCase().replace(/\s+/g, '_'));
}

function meaningfulLabel(text, priority) {
  return isMeaningfulLabel(text) ? { text: cleanText(text), priority } : null;
}

function objectRule(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function pmtilesInfo(manifest) {
  const tiles = manifest.tiles && typeof manifest.tiles === 'object' ? manifest.tiles : {};
  return tiles.format === 'pmtiles' || tiles.type === 'mvt' ? tiles : {};
}

function clampInteger(value, min, max) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}

function resolveRelativeUrl(url, baseUrl) {
  return new URL(url, new URL(baseUrl, self.location.href)).toString();
}

function createMetrics() {
  return {
    requested: 0,
    cacheHits: 0,
    decoded: 0,
    features: 0,
    overzoomed: 0,
    requestLevels: {},
    sourceLevels: {},
    renderMs: { total: 0, max: 0 },
    decodeMs: { total: 0, max: 0 }
  };
}

function recordMetricTime(metrics, key, value) {
  metrics[key].total += value;
  metrics[key].max = Math.max(metrics[key].max, value);
}

function addMetricCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}
