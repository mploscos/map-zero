import {
  Event,
  Rectangle,
  WebMercatorTilingScheme
} from 'cesium';

import { WEB_MERCATOR_MAX_LAT } from '../../raster/src/shared/geo.js';
import {
  DEFAULT_CONTEXT_LAYERS,
  layerAlias,
  normalizeContextLayers,
  sourceLayerFor
} from '../../raster/src/shared/layers.js';
import { pmtilesInfo } from '../../raster/src/shared/manifest.js';
import { clampInteger } from '../../raster/src/shared/math.js';

const DEFAULT_WORKER_URL = new URL('@map-zero/raster/imagery-worker.js', import.meta.url);
const TILE_SIZE = 512;

/**
 * Cesium ImageryProvider that rasterizes map-zero PMTiles/MVT tiles in a
 * dedicated worker. OffscreenCanvas is required by design so MVT decoding and
 * canvas drawing never block Cesium's main render thread.
 */
export class MapZeroCesiumImageryProvider {
  /**
   * @param {{
   *   manifest: Record<string, unknown>,
   *   manifestUrl: string,
   *   styleDocument?: Record<string, unknown> | null,
   *   layers?: string[],
   *   tileSize?: number,
   *   minimumLevel?: number,
   *   maximumLevel?: number,
   *   overzoomLevels?: number,
   *   edgeGuardPixels?: number,
   *   workerUrl?: string | URL
   * }} options
   */
  constructor(options) {
    assertWorkerRasterSupport();
    this.manifest = options.manifest;
    this.manifestUrl = resolveWorkerBaseUrl(options.manifestUrl);
    this.styleDocument = options.styleDocument ?? {};
    this.tileWidth = Number(options.tileSize ?? TILE_SIZE);
    this.tileHeight = Number(options.tileSize ?? TILE_SIZE);
    this.tilingScheme = new WebMercatorTilingScheme();
    this.rectangle = rectangleFromManifestBbox(
      this.manifest,
      /** @type {any} */ (this.manifest).bbox
    );
    this.minimumLevel = Number.isFinite(options.minimumLevel) ? Number(options.minimumLevel) : 0;
    this.sourceMaximumLevel = Number(pmtilesInfo(this.manifest).maxZoom ?? 18);
    const contextOverlay = contextOverlayConfig(this.manifest);
    this.overzoomLevels = clampInteger(options.overzoomLevels ?? contextOverlay?.overzoomLevels ?? 0, 0, 4);
    this.edgeGuardPixels = clampInteger(options.edgeGuardPixels ?? contextOverlay?.edgeGuardPixels ?? 0, 0, 8);
    this.maximumLevel = Number.isFinite(options.maximumLevel)
      ? Number(options.maximumLevel)
      : this.sourceMaximumLevel + this.overzoomLevels;
    this.ready = true;
    this.readyPromise = Promise.resolve(true);
    this.hasAlphaChannel = true;
    this.errorEvent = new Event();
    this.credit = undefined;
    this.proxy = undefined;

    this.layerIds = normalizeContextLayers(options.layers ?? contextOverlay?.layers ?? DEFAULT_CONTEXT_LAYERS);
    this.layerVisibility = new Map(this.layerIds.map((layerId) => [layerId, true]));
    this.cache = new Map();
    this.pending = new Map();
    this.nextRequestId = 1;
    this.metrics = createImageryMetrics();
    this.worker = new Worker(
      options.workerUrl ?? DEFAULT_WORKER_URL,
      { type: 'module' }
    );
    this.worker.addEventListener('message', (event) => this.#handleWorkerMessage(event.data));
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'map-zero imagery worker failed');
      this.errorEvent.raiseEvent(error);
      this.#rejectPending(error);
    });
    this.worker.postMessage({
      type: 'init',
      options: {
        manifest: this.manifest,
        manifestUrl: this.manifestUrl,
        styleDocument: this.styleDocument,
        layers: this.layerIds,
        tileSize: this.tileWidth,
        sourceMaximumLevel: this.sourceMaximumLevel,
        overzoomLevels: this.overzoomLevels,
        edgeGuardPixels: this.edgeGuardPixels,
        source: String(contextOverlay?.source ?? pmtilesInfo(this.manifest).url ?? 'tiles.pmtiles')
      }
    });
  }

  /**
   * @param {string} layerId
   * @param {boolean} visible
   */
  setLayerVisible(layerId, visible) {
    this.layerVisibility.set(sourceLayerFor(layerId), visible);
    this.layerVisibility.set(layerAlias(layerId), visible);
    this.cache.clear();
    this.worker.postMessage({
      type: 'visibility',
      layerId,
      visible
    });
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} level
   * @returns {Promise<HTMLCanvasElement>}
   */
  async requestImage(x, y, level) {
    const key = `${level}/${x}/${y}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.metrics.cacheHits++;
      return cached;
    }

    const id = this.nextRequestId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        type: 'render',
        id,
        x,
        y,
        z: level
      });
    }).catch((error) => {
      this.errorEvent.raiseEvent(error);
      return emptyCanvas(this.tileWidth, this.tileHeight);
    });
    this.cache.set(key, promise);
    return promise;
  }

  getTileCredits() {
    return undefined;
  }

  pickFeatures() {
    return undefined;
  }

  destroy() {
    this.#rejectPending(new Error('map-zero imagery provider destroyed'));
    this.worker.terminate();
    this.cache.clear();
  }

  #handleWorkerMessage(message) {
    if (message?.type === 'metrics') {
      mergeWorkerMetrics(this.metrics, message.metrics);
      return;
    }

    if (message?.type !== 'tile') {
      return;
    }

    if (message.metrics) {
      mergeWorkerMetrics(this.metrics, message.metrics);
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      message.image?.close?.();
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve(imageToCanvas(message.image, this.tileWidth, this.tileHeight));
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function assertWorkerRasterSupport() {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    throw new Error('map-zero Cesium context overlay requires Worker, OffscreenCanvas, and createImageBitmap');
  }
}

function createImageryMetrics() {
  const metrics = {
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
  const root = globalThis.__mapZeroCesiumMetrics ??= { imageryProviders: [] };
  root.imageryProviders.push(metrics);
  return metrics;
}

function mergeWorkerMetrics(target, patch) {
  if (!patch) return;
  for (const key of ['requested', 'cacheHits', 'decoded', 'features', 'overzoomed']) {
    target[key] = Number(patch[key] ?? target[key] ?? 0);
  }
  target.requestLevels = { ...patch.requestLevels };
  target.sourceLevels = { ...patch.sourceLevels };
  target.renderMs = { ...patch.renderMs };
  target.decodeMs = { ...patch.decodeMs };
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {{ type?: string, source?: string, layers?: string[], backend?: string, overzoomLevels?: number, edgeGuardPixels?: number } | null}
 */
export function contextOverlayConfig(manifest) {
  const pmtiles = pmtilesInfo(manifest);
  if (!pmtiles.url) return null;
  return {
    type: 'client-rasterized-pmtiles',
    source: pmtiles.url,
    layers: contextLayerIds(manifest)
  };
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {boolean}
 */
export function hasMapZeroContextOverlay(manifest) {
  const overlay = contextOverlayConfig(manifest);
  return Boolean(overlay?.source || pmtilesInfo(manifest).url);
}

function contextLayerIds(manifest) {
  const layers = Array.isArray(manifest.layers)
    ? manifest.layers.map(String).filter((layerId) => layerId !== 'buildings')
    : [];
  return layers.length > 0 ? layers : DEFAULT_CONTEXT_LAYERS;
}

function rectangleFromManifestBbox(manifest, bbox) {
  const padded = expandBboxByTileMargin(bbox, pmtilesInfo(manifest).minZoom);
  return rectangleFromBbox(padded);
}

function rectangleFromBbox(bbox) {
  if (Array.isArray(bbox) && bbox.length === 4) {
    return Rectangle.fromDegrees(Number(bbox[0]), Number(bbox[1]), Number(bbox[2]), Number(bbox[3]));
  }
  return Rectangle.MAX_VALUE;
}

function expandBboxByTileMargin(bbox, minZoom) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return bbox;
  const z = clampInteger(minZoom ?? 8, 0, 22);
  const margin = 360 / 2 ** z;
  return [
    Math.max(-180, Number(bbox[0]) - margin),
    Math.max(-WEB_MERCATOR_MAX_LAT, Number(bbox[1]) - margin),
    Math.min(180, Number(bbox[2]) + margin),
    Math.min(WEB_MERCATOR_MAX_LAT, Number(bbox[3]) + margin)
  ];
}

function emptyCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function imageToCanvas(image, width, height) {
  const canvas = emptyCanvas(width, height);
  if (!image) {
    return canvas;
  }

  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.drawImage(image, 0, 0, width, height);
  }
  image.close?.();
  return canvas;
}

function resolveWorkerBaseUrl(url) {
  return new URL(url, globalThis.location?.href ?? 'http://localhost/').toString();
}
