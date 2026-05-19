import Feature from 'ol/Feature.js';
import MVT from 'ol/format/MVT.js';
import { PMTiles } from 'pmtiles';

import { createTileRenderer } from './renderer/factory.js';
import { tileMercatorExtent, sourceTileForRequest } from './shared/geo.js';
import { layerAlias, normalizeContextLayers, sourceLayerFor } from './shared/layers.js';
import { clampInteger, clampNumber } from './shared/math.js';
import { pmtilesInfo } from './shared/manifest.js';
import { addMetricCount, createMetrics, recordMetricTime } from './shared/metrics.js';
import { orderManifestLayers } from './style.js';

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
    state = await createState(message.options);
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

async function createState(options) {
  const manifest = options.manifest;
  const styleDocument = options.styleDocument ?? {};
  const layerIds = normalizeContextLayers(options.layers);
  const renderer = await createTileRenderer();
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
    renderer,
    sourceTileCache: new Map(),
    metrics: createMetrics()
  };
}

async function renderTile(x, y, z) {
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
  const sourceData = await readSourceTile(sourceTile);
  return state.renderer.render(sourceData, tileMercatorExtent(x, y, z), z, state.tileSize, state);
}

async function renderSourceTile(sourceTile, renderExtent, z, size) {
  const sourceData = await readSourceTile(sourceTile);
  return state.renderer.render(sourceData, renderExtent, z, size, state);
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

function groupFeaturesByLayer(features) {
  const groups = new Map();
  for (const feature of features) {
    const layer = sourceLayerFor(String(feature.get('layer') ?? ''));
    if (!groups.has(layer)) groups.set(layer, []);
    groups.get(layer).push(feature);
  }
  return groups;
}

function resolveRelativeUrl(url, baseUrl) {
  return new URL(url, new URL(baseUrl, self.location.href)).toString();
}
