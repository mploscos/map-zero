import { canvasStyleParts } from './canvas-style.js';
import { drawLabels } from './labels.js';
import { geometryTypeKind, projectPoint } from './shared/geo.js';
import { isAipLayer, isLayerVisible, sourceLayerFor } from './shared/layers.js';
import {
  getLayerRule,
  mergeFeatureRule,
  zoomMatchesRule
} from './style.js';

export function drawSourceData(ctx, sourceData, renderExtent, z, size, state) {
  const { features, byLayer } = sourceData;
  for (const layer of state.orderedLayers) {
    if (!isLayerVisible(state.layerVisibility, layer.id) || !zoomMatchesRule(z, getLayerRule(state.styleDocument, layer))) continue;
    const layerFeatures = byLayer.get(sourceLayerFor(layer.id)) ?? byLayer.get(layer.id) ?? [];
    drawLayer(ctx, layerFeatures, layer, getLayerRule(state.styleDocument, layer), renderExtent, size, z);
  }
  drawLabels(ctx, features, state.styleDocument, renderExtent, size, z, state.layerVisibility);
}

export function drawLayer(ctx, features, layer, rule, extent, size, zoom) {
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
