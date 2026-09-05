import { LruCache } from '../../core/src/shared/cache.js';
import Feature from 'ol/Feature.js';
import MVT from 'ol/format/MVT.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import Fill from 'ol/style/Fill.js';
import Stroke from 'ol/style/Stroke.js';
import Style from 'ol/style/Style.js';
import Text from 'ol/style/Text.js';

import {
  activeLabelLayerIdsForZoom,
  hasEnabledLabels,
  isPoiLikeFeature,
  isSelectedPoiCandidate,
  roadLabel,
  aviationLabel,
  isSelectedPoi,
  poiLabelText,
  priorityClassFromNumber,
  poiPriorityClass,
  poiZIndex,
  labelFont,
  priorityClassRule,
  labelOpacityForZoom,
  cleanText,
  isMeaningfulLabel,
  isExplicitAviationLabel,
  labelRuleForSource,
  zoomInRule,
  resolutionToZoom,
  rgba,
  LABEL_SOURCE_LAYERS,
  ROAD_SOURCE_LAYER,
  POI_SOURCE_LAYER
} from '../../core/src/labels.js';
export { activeLabelLayerIdsForZoom, hasEnabledLabels } from '../../core/src/labels.js';

export function createMapZeroLabelLayer(options) {
  // The geometry layer already decodes every map layer. Labels only need these
  // source layers, so do not create Canvas features for buildings, water or
  // other non-label data a second time.
  const format = new MVT({ featureClass: Feature, layers: LABEL_SOURCE_LAYERS });
  const source = new VectorTileSource({
    format,
    maxZoom: 22,
    ...(options.sourceOptions ?? {}),
    cacheSize: 512,
    transition: 0,
    wrapX: false,
    tileUrlFunction: options.tileUrlFunction,
    tileLoadFunction: (tile) => {
      tile.setLoader((extent, resolution, projection) => {
        const tileCoord = tile.getTileCoord();
        const url = options.tileUrlFunction(tileCoord);
        if (!url) {
          tile.setFeatures([]);
          return;
        }

        options.loadTileData(tileCoord, url)
          .then((data) => {
            if (!data) {
              tile.setFeatures([]);
              return;
            }

            tile.setFeatures(format.readFeatures(data, {
              extent,
              featureProjection: projection
            }));
          })
          .catch(() => {
            tile.setFeatures([]);
          });
      });
    }
  });

  if (options.onTileLoadStart) source.on('tileloadstart', options.onTileLoadStart);
  if (options.onTileLoadEnd) source.on('tileloadend', options.onTileLoadEnd);
  if (options.onTileLoadError) source.on('tileloaderror', options.onTileLoadError);

  const styleCache = new LruCache(2048);
  const layer = new VectorTileLayer({
    source,
    declutter: true,
    updateWhileAnimating: false,
    updateWhileInteracting: false,
    style: (feature, resolution) => labelStyle(feature, resolution, options.styleDocument, styleCache)
  });
  if (typeof layer.set === 'function' && options.instanceId) {
    layer.set('mapzero:id', options.instanceId);
    layer.set('mapzero:role', 'labels');
    layer.set('mapzero:sourceLayerIds', LABEL_SOURCE_LAYERS.map((layerId) => `${options.instanceId}:${layerId}`));
  }

  return {
    layer,
    source,
    attachMap() {},
    detachMap() {},
    refresh() {
      source.setTileUrlFunction(options.tileUrlFunction, String(Date.now()));
      source.clear();
      styleCache.clear();
      layer.changed();
    },
    destroy() {
      styleCache.clear();
      source.clear();
      layer.dispose();
    }
  };
}

function labelStyle(feature, resolution, styleDocument, styleCache) {
  const zoom = resolutionToZoom(resolution);
  const sourceLayer = cleanText(feature.get('sourceLayer'));
  if (sourceLayer && cleanText(feature.get('text'))) {
    return candidateLabelStyle(feature, sourceLayer, zoom, styleDocument, styleCache);
  }

  if (feature.get('highway')) {
    return roadLabelStyle(feature, zoom, styleDocument, styleCache);
  }

  if (feature.get('aeroway')) {
    return aviationLabelStyle(feature, zoom, styleDocument, styleCache);
  }

  if (isPoiLikeFeature(feature)) {
    return poiLabelStyle(feature, zoom, styleDocument, styleCache);
  }

  return null;
}

function candidateLabelStyle(feature, sourceLayer, zoom, styleDocument, styleCache) {
  const rule = labelRuleForSource(styleDocument, sourceLayer);
  const minZoom = Number(feature.get('minZoom') ?? rule?.minZoom ?? 0);
  const text = cleanText(feature.get('text'));
  if (!rule || rule.enabled === false || !zoomInRule(zoom, rule) || zoom < minZoom) {
    return null;
  }

  if (!isMeaningfulLabel(text) && !isExplicitAviationLabel(feature, sourceLayer, text)) {
    return null;
  }

  if (sourceLayer === POI_SOURCE_LAYER && !isSelectedPoiCandidate(feature, rule)) {
    return null;
  }

  return textStyle({
    cache: styleCache,
    styleDocument,
    rule,
    text,
    placement: 'point',
    priorityClass: priorityClassFromNumber(Number(feature.get('priority') ?? 0)),
    zIndex: Number(feature.get('priority') ?? 0),
    zoom
  });
}

function roadLabelStyle(feature, zoom, styleDocument, styleCache) {
  const rule = labelRuleForSource(styleDocument, ROAD_SOURCE_LAYER);
  if (!rule || rule.enabled === false || !zoomInRule(zoom, rule)) {
    return null;
  }

  const highway = String(feature.get('highway') ?? '');
  const label = roadLabel(feature, highway, zoom, rule);
  if (!label) {
    return null;
  }

  return textStyle({
    cache: styleCache,
    styleDocument,
    rule,
    text: label.text,
    placement: 'line',
    priorityClass: label.priorityClass,
    zIndex: label.zIndex,
    zoom
  });
}

function aviationLabelStyle(feature, zoom, styleDocument, styleCache) {
  const rule = labelRuleForSource(styleDocument, 'aip');
  if (!rule || rule.enabled === false || !zoomInRule(zoom, rule)) {
    return null;
  }

  const aeroway = String(feature.get('aeroway') ?? '');
  const label = aviationLabel(feature, aeroway, zoom);
  if (!label) {
    return null;
  }

  return textStyle({
    cache: styleCache,
    styleDocument,
    rule,
    text: label.text,
    placement: label.placement,
    priorityClass: label.priorityClass,
    zIndex: label.zIndex,
    zoom
  });
}

function poiLabelStyle(feature, zoom, styleDocument, styleCache) {
  const rule = labelRuleForSource(styleDocument, POI_SOURCE_LAYER);
  if (!rule || rule.enabled === false || !zoomInRule(zoom, rule) || !isSelectedPoi(feature, rule)) {
    return null;
  }

  const text = poiLabelText(feature);
  if (!text) {
    return null;
  }

  return textStyle({
    cache: styleCache,
    styleDocument,
    rule,
    text,
    placement: 'point',
    priorityClass: poiPriorityClass(feature),
    zIndex: poiZIndex(feature),
    zoom
  });
}

function textStyle(options) {
  const priorityRule = priorityClassRule(options.styleDocument, options.priorityClass);
  const opacity = labelOpacityForZoom(options.zoom, Number(priorityRule.opacity ?? options.rule.opacity ?? 0.82));
  const font = labelFont(options.rule, priorityRule, options.zoom);
  const fill = rgba(String(priorityRule.fill ?? options.rule.fill ?? '#d9fbff'), opacity);
  const halo = rgba(String(priorityRule.halo ?? options.rule.halo ?? '#001014'), Math.min(1, opacity + 0.12));
  const haloWidth = Number(priorityRule.haloWidth ?? options.rule.haloWidth ?? 3);
  const key = [
    options.text,
    options.placement,
    font,
    fill,
    halo,
    haloWidth,
    options.zIndex
  ].join('|');

  if (options.cache.has(key)) {
    return /** @type {Style} */ (options.cache.get(key));
  }

  const style = new Style({
    zIndex: options.zIndex,
    text: new Text({
      text: options.text,
      placement: options.placement,
      font,
      fill: new Fill({ color: fill }),
      stroke: new Stroke({ color: halo, width: haloWidth }),
      overflow: false,
      maxAngle: Math.PI / 5
    })
  });
  options.cache.set(key, style);
  return style;
}
