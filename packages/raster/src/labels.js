import { boxesOverlap, projectPoint } from './shared/geo.js';
import { isAipLayer, sourceLayerFor } from './shared/layers.js';

const LABEL_SOURCE_LAYERS = new Set(['roads', 'aip', 'aviation', 'pois']);
const MAJOR_ROADS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']);
const SECONDARY_ROADS = new Set(['secondary', 'secondary_link']);
const LOCAL_ROADS = new Set(['residential', 'living_street', 'unclassified']);
const DISABLED_ROADS = new Set(['service', 'track', 'path', 'footway', 'cycleway', 'steps', 'corridor', 'platform']);
const GENERIC_LABEL_VALUES = new Set(['yes', 'no', 'true', 'false', 'unknown', 'none', 'station', 'airport', 'aerodrome']);

export function drawLabels(ctx, features, styleDocument, extent, size, zoom, layerVisibility) {
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
