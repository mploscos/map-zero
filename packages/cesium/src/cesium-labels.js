import {
  Cartesian2, Cartesian3, Color, EllipsoidalOccluder, HeightReference,
  HorizontalOrigin, LabelCollection, LabelStyle, SceneMode, SceneTransforms, VerticalOrigin
} from 'cesium';
import { LruCache } from '../../core/src/shared/cache.js';
import { describeLabel } from '../../core/src/labels.js';
import { getLayerRule, zoomMatchesRule } from '../../core/src/style.js';

/** Deterministic priority placement; bounds the visible label count and overlap checks. */
export function selectLabels(candidates, maxLabels) {
  const selected = [];
  const ids = new Set();
  candidates.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
  for (const candidate of candidates) {
    if (ids.has(candidate.key)) continue;
    ids.add(candidate.key);
    const a = candidate.box;
    if (selected.some(({ box: b }) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1])) continue;
    selected.push(candidate);
    if (selected.length >= maxLabels) break;
  }
  return selected;
}

/** Labels share the native provider's loaded tiles; no extra requests or MVT decode. */
export function createCesiumLabels(viewer, tileset, options) {
  const maxLabels = options.maxLabels ?? 150;
  if (!Number.isInteger(maxLabels) || maxLabels < 1 || maxLabels > 1000) {
    throw new Error('maxLabels must be an integer between 1 and 1000');
  }
  const scene = viewer.scene;
  const collection = scene.primitives.add(new LabelCollection({ scene, show: options.labels !== false }));
  const cache = new WeakMap();
  const visible = new Set();
  const active = new Map();
  const widths = new LruCache(1024);
  const measure = document.createElement('canvas').getContext('2d');
  const occluder = new EllipsoidalOccluder(scene.globe?.ellipsoid);
  let destroyed = false;

  function candidatesFor(content) {
    if (cache.has(content)) return cache.get(content);
    const candidates = [];
    // Cesium 1.145 vector content has one feature table per MVT source layer.
    const tables = content.batchTables ?? [];
    for (let table = 0; table < tables.length; table++) {
      for (let i = 0; i < tables[table].featuresLength; i++) {
        const feature = content.getFeature(i, table);
        if (!feature) continue;
        const lon = feature.getProperty('mapzero_label_lon');
        const lat = feature.getProperty('mapzero_label_lat');
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
        const source = String(feature.getProperty('_layer') ?? feature.getProperty('layer') ?? '');
        const layer = source === 'aviation' ? 'aip' : source;
        const properties = Object.fromEntries(feature.getPropertyIds().map((key) => [key, feature.getProperty(key)]));
        const adapter = { get: (key) => properties[key] };
        // Keep data independent of the feature lifetime. Eligibility is evaluated
        // again at the current zoom, so zoom limits in custom themes still apply.
        const id = properties.id ?? properties.fid ?? `${lon},${lat}`;
        candidates.push({ key: `${layer}:${id}`, layer, adapter, position: Cartesian3.fromDegrees(lon, lat) });
      }
    }
    cache.set(content, candidates);
    return candidates;
  }

  function update() {
    if (destroyed || !collection.show) return;
    const candidates = [];
    const zoom = options.getZoom();
    const width = scene.canvas.clientWidth, height = scene.canvas.clientHeight;
    const layerRules = new Map();
    occluder.cameraPosition = viewer.camera.positionWC;
    for (const content of visible) {
      for (const candidate of candidatesFor(content)) {
        const { layer, adapter, position } = candidate;
        if (!layerRules.has(layer)) layerRules.set(layer, getLayerRule(options.styleDocument, { id: layer }));
        if (options.visibility.get(layer) === false || !zoomMatchesRule(zoom, layerRules.get(layer))) continue;
        const opacity = options.opacities.get(layer) ?? options.opacity ?? 1;
        if (opacity <= 0) continue;
        if (candidate.zoom !== zoom) {
          candidate.zoom = zoom;
          candidate.descriptor = describeLabel(adapter, layer, zoom, options.styleDocument);
          if (candidate.descriptor?.text.length > 64) {
            candidate.descriptor.text = candidate.descriptor.text.slice(0, 61).trimEnd() + '…';
          }
        }
        const descriptor = candidate.descriptor;
        if (!descriptor) continue;
        if (scene.mode === SceneMode.SCENE3D && !occluder.isPointVisible(position)) continue;
        const point = SceneTransforms.worldToWindowCoordinates(scene, position);
        if (!point || point.x < 0 || point.x > width || point.y < 0 || point.y > height) continue;
        const measureKey = `${descriptor.font}:${descriptor.text}`;
        let textWidth = widths.get(measureKey);
        if (textWidth === undefined) {
          measure.font = descriptor.font;
          textWidth = measure.measureText(descriptor.text).width;
          widths.set(measureKey, textWidth);
        }
        const halfWidth = textWidth / 2 + descriptor.haloWidth + 6;
        const labelHeight = (Number(/([\d.]+)px/.exec(descriptor.font)?.[1]) || 12) + 2 * descriptor.haloWidth + 6;
        candidates.push({ ...candidate, ...descriptor, opacity,
          box: [point.x - halfWidth, point.y - labelHeight - 6, point.x + halfWidth, point.y - 6] });
      }
    }
    const selected = selectLabels(candidates, maxLabels);
    const keys = new Set(selected.map((label) => label.key));
    let changed = false;
    for (const [key, value] of active) {
      if (!keys.has(key)) { collection.remove(value.label); active.delete(key); changed = true; }
    }
    for (const candidate of selected) {
      const signature = JSON.stringify([candidate.text, candidate.font, candidate.fill, candidate.halo, candidate.haloWidth, candidate.opacity]);
      const previous = active.get(candidate.key);
      if (previous?.signature === signature) continue;
      const fillColor = Color.fromCssColorString(candidate.fill);
      const outlineColor = Color.fromCssColorString(candidate.halo);
      fillColor.alpha *= candidate.opacity; outlineColor.alpha *= candidate.opacity;
      const properties = {
        id: { mapZeroLayer: candidate.layer, mapZeroLabel: candidate.key },
        position: candidate.position, text: candidate.text, font: candidate.font,
        fillColor, outlineColor, outlineWidth: candidate.haloWidth,
        style: LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -6),
        heightReference: HeightReference.CLAMP_TO_TERRAIN, disableDepthTestDistance: Number.POSITIVE_INFINITY
      };
      const label = previous?.label ?? collection.add(properties);
      if (previous) Object.assign(label, properties);
      active.set(candidate.key, { signature, label }); changed = true;
    }
    if (changed) scene.requestRender();
  }
  const removers = [
    scene.preRender.addEventListener(() => visible.clear()),
    tileset.tileVisible.addEventListener((tile) => visible.add(tile.content)),
    // Mutate primitives only after traversal; an unchanged layout requests no frame.
    scene.postRender.addEventListener(() => queueMicrotask(update))
  ];
  return {
    collection,
    setVisible(visible) { collection.show = Boolean(visible); scene.requestRender(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removers.forEach((remove) => remove());
      visible.clear(); active.clear(); widths.clear();
      scene.primitives.remove(collection);
    }
  };
}
