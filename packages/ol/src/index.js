import MVT from 'ol/format/MVT.js';
import TileLayer from 'ol/layer/Tile.js';
import WebGLVectorTileLayer from 'ol/layer/WebGLVectorTile.js';
import WebGLVectorTileLayerRenderer from 'ol/renderer/webgl/VectorTileLayer.js';
import ImageTileSource from 'ol/source/ImageTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import { createXYZ } from 'ol/tilegrid.js';
import { PMTiles } from 'pmtiles';

import {
  activeLabelLayerIdsForZoom,
  createMapZeroLabelLayer,
  hasEnabledLabels
} from './labels.js';

let autoInstanceCounter = 0;

/**
 * @typedef {{
 *   id?: string,
 *   manifestUrl: string,
 *   manifest?: Record<string, unknown>,
 *   style?: string | Record<string, unknown>,
 *   visibleLayers?: string[] | Set<string>,
 *   source?: 'auto' | 'pmtiles' | 'dynamic',
 *   renderMode?: 'vector' | 'raster-worker',
 *   workerUrl?: string | URL,
 *   rasterWorkerUrl?: string | URL,
 *   rasterPixelRatio?: number,
 *   overzoomLevels?: number,
 *   edgeGuardPixels?: number,
 *   apiBaseUrl?: string,
 *   zIndexBase?: number,
 *   onTileLoadStart?: () => void,
 *   onTileLoadEnd?: () => void,
 *   onTileLoadError?: () => void
 * }} MapZeroOpenLayersOptions
 */

/**
 * Load a map-zero manifest.
 *
 * @param {string} manifestUrl
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadMapZeroManifest(manifestUrl) {
  return fetchJson(resolveUrl(manifestUrl, documentBaseUrl()));
}

/**
 * Load a standalone map-zero style JSON document.
 *
 * The returned object can be reused across multiple package instances. Helpers
 * treat style objects as readonly and keep package-specific state elsewhere.
 *
 * @param {string} styleUrl
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadMapZeroStyle(styleUrl) {
  return fetchJson(resolveUrl(styleUrl, documentBaseUrl()));
}

/**
 * Create OpenLayers layers for a map-zero package without adding them to a map.
 *
 * @param {MapZeroOpenLayersOptions} options
 * @returns {Promise<{
 *   id: string,
 *   manifest: Record<string, unknown>,
 *   style: Record<string, unknown>,
 *   layers: WebGLVectorTileLayer[],
 *   attachMap?: (map: unknown) => void,
 *   detachMap?: () => void,
 *   setVisible: (layerId: string, visible: boolean) => void,
 *   setOpacity: (layerId: string, opacity: number) => void,
 *   destroy: () => void
 * }>}
 */
export async function createMapZeroOpenLayersLayers(options) {
  const manifestUrl = resolveUrl(options.manifestUrl, documentBaseUrl());
  const manifestBaseUrl = new URL('.', manifestUrl).href;
  const manifest = options.manifest ?? await loadMapZeroManifest(manifestUrl);
  const instanceId = createInstanceId(options.id, manifest, manifestUrl);
  const styleDocument = await loadStyleDocument(manifest, manifestBaseUrl, options.style ?? 'default');
  const orderedLayers = orderManifestLayers(manifest, styleDocument);
  const layerVisibility = createLayerVisibility(orderedLayers, styleDocument, options.visibleLayers);
  const layerOpacity = new Map(orderedLayers.map((layer) => [layer.id, 1]));
  const context = {
    instanceId,
    manifest,
    manifestUrl,
    manifestBaseUrl,
    styleDocument,
    orderedLayers,
    layerVisibility,
    layerOpacity,
    sourceMode: resolveSourceMode(manifest, options.source ?? 'auto'),
    apiBaseUrl: resolveApiBaseUrl(options.apiBaseUrl, manifestUrl),
    onTileLoadStart: options.onTileLoadStart,
    onTileLoadEnd: options.onTileLoadEnd,
    onTileLoadError: options.onTileLoadError
  };

  if (options.renderMode === 'raster-worker') {
    return createRasterWorkerController(context, options);
  }

  patchWebGlVectorTileRenderer();

  const source = createTileSource(context);
  const layer = new WebGLVectorTileLayer({
    source,
    preload: 0,
    useInterimTilesOnError: false,
    style: createWebGlStyles(context)
  });
  tagOpenLayersLayer(layer, instanceId, orderedLayers.map((item) => item.id), 'geometry');
  const labelController = hasEnabledLabels(styleDocument)
    ? createMapZeroLabelLayer({
        instanceId,
        tileUrlFunction: createLabelTileUrlFunction(context),
        loadTileData: createLabelTileDataLoader(context),
        sourceOptions: createVectorTileSourceZoomOptions(context),
        styleDocument,
        onTileLoadStart: options.onTileLoadStart,
        onTileLoadEnd: options.onTileLoadEnd,
        onTileLoadError: options.onTileLoadError
      })
    : null;

  applyLayerZIndex(layer, orderedLayers, styleDocument, options.zIndexBase);
  if (labelController) {
    tagOpenLayersLayer(labelController.layer, instanceId, orderedLayers.map((item) => item.id), 'labels');
    labelController.layer.setZIndex(layer.getZIndex() + 100);
  }

  const refresh = () => {
    layer.setStyle(createWebGlStyles(context));
    source.setTileUrlFunction(createTileUrlFunction(context), String(Date.now()));
    labelController?.refresh();
    layer.changed();
  };

  return {
    id: instanceId,
    manifest,
    style: styleDocument,
    layers: labelController ? [layer, labelController.layer] : [layer],
    attachMap(map) {
      labelController?.attachMap(/** @type {Parameters<typeof labelController.attachMap>[0]} */ (map));
    },
    detachMap() {
      labelController?.detachMap();
    },
    setVisible(layerId, visible) {
      if (!layerVisibility.has(layerId)) {
        throw new Error(`unknown map-zero layer: ${layerId}`);
      }

      layerVisibility.set(layerId, Boolean(visible));
      refresh();
    },
    setOpacity(layerId, opacity) {
      if (!layerOpacity.has(layerId)) {
        throw new Error(`unknown map-zero layer: ${layerId}`);
      }

      layerOpacity.set(layerId, clamp(Number(opacity), 0, 1));
      layer.setStyle(createWebGlStyles(context));
      layer.changed();
    },
    destroy() {
      source.clear();
      labelController?.destroy();
      layer.dispose();
    }
  };
}

/**
 * @param {{
 *   instanceId: string,
 *   manifest: Record<string, unknown>,
 *   manifestUrl: string,
 *   styleDocument: Record<string, unknown>,
 *   orderedLayers: Array<{ id: string, type?: string, style?: string }>,
 *   layerVisibility: Map<string, boolean>,
 *   layerOpacity: Map<string, number>
 * }} context
 * @param {MapZeroOpenLayersOptions} options
 * @returns {{
 *   id: string,
 *   manifest: Record<string, unknown>,
 *   style: Record<string, unknown>,
 *   layers: TileLayer[],
 *   setVisible: (layerId: string, visible: boolean) => void,
 *   setOpacity: (layerId: string, opacity: number) => void,
 *   destroy: () => void
 * }}
 */
function createRasterWorkerController(context, options) {
  if (!isPmtilesManifest(context.manifest)) {
    throw new Error('raster-worker render mode requires vector PMTiles');
  }

  const worker = new MapZeroRasterTileWorker({
    manifest: context.manifest,
    manifestUrl: context.manifestUrl,
    styleDocument: context.styleDocument,
    layers: context.orderedLayers.map((layer) => layer.id),
    workerUrl: options.rasterWorkerUrl ?? options.workerUrl ?? new URL('@map-zero/cesium/imagery-worker.js', import.meta.url),
    rasterPixelRatio: options.rasterPixelRatio,
    overzoomLevels: options.overzoomLevels,
    edgeGuardPixels: options.edgeGuardPixels
  });
  worker.setVisibleLayers(context.layerVisibility);
  const range = pmtilesZoomRange(context.manifest);
  const maxZoom = range.maxZoom + clampInteger(options.overzoomLevels ?? 0, 0, 4);
  const rasterPixelRatio = clampNumber(options.rasterPixelRatio ?? 2, 1, 2);
  const source = new ImageTileSource({
    minZoom: range.minZoom,
    maxZoom,
    tileGrid: createXYZ({
      minZoom: range.minZoom,
      maxZoom,
      tileSize: 512
    }),
    tileSize: 512,
    transition: 0,
    interpolate: true,
    zDirection: preferNearestZoomLevel,
    wrapX: false,
    loader: (z, x, y) => worker.render(z, x, y)
  });
  source.getTilePixelRatio = () => rasterPixelRatio;
  const layer = new TileLayer({
    source,
    cacheSize: 4096,
    preload: 0,
    useInterimTilesOnError: false
  });
  tagOpenLayersLayer(layer, context.instanceId, context.orderedLayers.map((item) => item.id), 'raster');
  applyLayerZIndex(layer, context.orderedLayers, context.styleDocument, options.zIndexBase);

  const refresh = () => {
    worker.setVisibleLayers(context.layerVisibility);
    source.clear();
    layer.changed();
  };

  return {
    id: context.instanceId,
    manifest: context.manifest,
    style: context.styleDocument,
    layers: [layer],
    setVisible(layerId, visible) {
      if (!context.layerVisibility.has(layerId)) {
        throw new Error(`unknown map-zero layer: ${layerId}`);
      }

      context.layerVisibility.set(layerId, Boolean(visible));
      refresh();
    },
    setOpacity(layerId, opacity) {
      if (!context.layerOpacity?.has?.(layerId)) {
        throw new Error(`unknown map-zero layer: ${layerId}`);
      }

      layer.setOpacity(clamp(Number(opacity), 0, 1));
    },
    destroy() {
      source.clear();
      worker.destroy();
      layer.dispose();
    }
  };
}

class MapZeroRasterTileWorker {
  /**
   * @param {{
   *   manifest: Record<string, unknown>,
   *   manifestUrl: string,
   *   styleDocument: Record<string, unknown>,
   *   layers: string[],
 *   workerUrl: string | URL,
 *   rasterPixelRatio?: number,
 *   overzoomLevels?: number,
 *   edgeGuardPixels?: number
   * }} options
   */
  constructor(options) {
    assertRasterWorkerSupport();
    this.#rasterPixelRatio = clampNumber(options.rasterPixelRatio ?? 2, 1, 2);
    this.worker = new Worker(options.workerUrl, { type: 'module' });
    this.worker.addEventListener('message', (event) => this.#handleMessage(event.data));
    this.worker.addEventListener('error', (event) => this.#rejectAll(new Error(event.message || 'map-zero OpenLayers raster worker failed')));
    this.worker.postMessage({
      type: 'init',
      options: {
        manifest: options.manifest,
        manifestUrl: resolveUrl(options.manifestUrl, documentBaseUrl()),
        styleDocument: options.styleDocument,
        layers: options.layers,
        tileSize: 512,
        pixelRatio: this.#rasterPixelRatio,
        sourceMaximumLevel: pmtilesZoomRange(options.manifest).maxZoom,
        overzoomLevels: clampInteger(options.overzoomLevels ?? 0, 0, 4),
        edgeGuardPixels: clampInteger(options.edgeGuardPixels ?? 0, 0, 8),
        source: String(pmtilesInfo(options.manifest).url ?? 'tiles.pmtiles')
      }
    });
  }

  /**
   * @param {number} z
   * @param {number} x
   * @param {number} y
   * @returns {Promise<ImageBitmap | HTMLCanvasElement>}
   */
  render(z, x, y) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'render', id, x, y, z });
    }).catch(() => emptyCanvas(512 * this.#rasterPixelRatio, 512 * this.#rasterPixelRatio));
  }

  /**
   * @param {Map<string, boolean>} visibility
   */
  setVisibleLayers(visibility) {
    for (const [layerId, visible] of visibility) {
      this.worker.postMessage({ type: 'visibility', layerId, visible });
    }
  }

  destroy() {
    this.#rejectAll(new Error('map-zero OpenLayers raster worker destroyed'));
    this.worker.terminate();
  }

  /**
   * @param {any} message
   */
  #handleMessage(message) {
    if (message?.type !== 'tile') {
      return;
    }

    const pending = this.#pending.get(message.id);
    if (!pending) {
      message.image?.close?.();
      return;
    }

    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve(message.image ?? emptyCanvas(512, 512));
  }

  /**
   * @param {Error} error
   */
  #rejectAll(error) {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /** @type {Worker} */
  worker;
  #rasterPixelRatio = 2;
  #nextId = 1;
  /** @type {Map<number, { resolve: (image: ImageBitmap | HTMLCanvasElement) => void, reject: (error: Error) => void }>} */
  #pending = new Map();
}

/**
 * Add map-zero layers to an existing OpenLayers map.
 *
 * The helper does not create or own the map. It only adds map-zero layers.
 *
 * @param {{ addLayer: (layer: WebGLVectorTileLayer) => void, removeLayer: (layer: WebGLVectorTileLayer) => void }} map
 * @param {MapZeroOpenLayersOptions} options
 * @returns {Promise<{
 *   id: string,
 *   manifest: Record<string, unknown>,
 *   style: Record<string, unknown>,
 *   layers: WebGLVectorTileLayer[],
 *   setVisible: (layerId: string, visible: boolean) => void,
 *   setOpacity: (layerId: string, opacity: number) => void,
 *   destroy: () => void
 * }>}
 */
export async function addMapZeroToOpenLayers(map, options) {
  const controller = await createMapZeroOpenLayersLayers(options);

  for (const layer of controller.layers) {
    map.addLayer(layer);
  }
  controller.attachMap?.(map);

  return {
    ...controller,
    destroy() {
      controller.detachMap?.();
      for (const layer of controller.layers) {
        map.removeLayer(layer);
      }

      controller.destroy();
    }
  };
}

/**
 * @param {string | undefined} id
 * @param {Record<string, unknown>} manifest
 * @param {string} manifestUrl
 * @returns {string}
 */
function createInstanceId(id, manifest, manifestUrl) {
  if (id) {
    return safeInstanceId(id);
  }

  const name = typeof manifest.name === 'string' && manifest.name.trim()
    ? manifest.name
    : new URL(manifestUrl).pathname.split('/').filter(Boolean).at(-2) ?? 'mapzero';
  autoInstanceCounter += 1;
  return `${safeInstanceId(name)}-${autoInstanceCounter}`;
}

/**
 * @param {string} id
 * @returns {string}
 */
function safeInstanceId(id) {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'mapzero';
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {string} manifestBaseUrl
 * @param {string | Record<string, unknown>} style
 * @returns {Promise<Record<string, unknown>>}
 */
async function loadStyleDocument(manifest, manifestBaseUrl, style) {
  if (style && typeof style === 'object') {
    return style;
  }

  const styleName = String(style || 'default');
  const styles = manifest.styles && typeof manifest.styles === 'object'
    ? /** @type {Record<string, string>} */ (manifest.styles)
    : {};
  const styleUrl = styles[styleName] ?? styleName;
  return fetchJson(resolveUrl(styleUrl, manifestBaseUrl));
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {Record<string, unknown>} styleDocument
 * @returns {Array<{ id: string, type?: string, style?: string }>}
 */
function orderManifestLayers(manifest, styleDocument) {
  const layers = Array.isArray(manifest.layers)
    ? /** @type {string[]} */ (manifest.layers).map(manifestLayer)
    : [];
  const drawOrder = Array.isArray(styleDocument.drawOrder)
    ? /** @type {string[]} */ (styleDocument.drawOrder)
    : layers.map((layer) => layer.id);

  return [...layers].sort((a, b) => {
    const ai = drawOrder.indexOf(a.id);
    const bi = drawOrder.indexOf(b.id);
    const ao = getLayerRule(styleDocument, a).order ?? 0;
    const bo = getLayerRule(styleDocument, b).order ?? 0;
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || Number(ao) - Number(bo);
  });
}

/**
 * @param {string} layerId
 * @returns {{ id: string, type?: string, style?: string }}
 */
function manifestLayer(layerId) {
  return {
    id: layerId,
    type: layerType(layerId),
    style: layerId
  };
}

/**
 * @param {string} layerId
 * @returns {string}
 */
function layerType(layerId) {
  if (layerId === 'buildings' || layerId === 'water' || layerId === 'landuse') return 'polygon';
  if (layerId === 'pois') return 'point';
  if (layerId === 'aip' || layerId === 'aviation') return 'mixed';
  return 'line';
}

/**
 * @param {Array<{ id: string, type?: string, style?: string }>} orderedLayers
 * @param {Record<string, unknown>} styleDocument
 * @param {string[] | Set<string> | undefined} visibleLayers
 * @returns {Map<string, boolean>}
 */
function createLayerVisibility(orderedLayers, styleDocument, visibleLayers) {
  const selected = visibleLayers ? new Set(visibleLayers) : null;
  const visibility = new Map();

  for (const layer of orderedLayers) {
    const rule = getLayerRule(styleDocument, layer);
    visibility.set(layer.id, (selected ? selected.has(layer.id) : true) && rule.visible !== false);
  }

  return visibility;
}

/**
 * @param {WebGLVectorTileLayer} layer
 * @param {Array<{ id: string, type?: string, style?: string }>} orderedLayers
 * @param {Record<string, unknown>} styleDocument
 * @param {number | undefined} zIndexBase
 */
function applyLayerZIndex(layer, orderedLayers, styleDocument, zIndexBase) {
  const maxOrder = orderedLayers.reduce((max, item) => {
    const order = Number(getLayerRule(styleDocument, item).order);
    return Number.isFinite(order) ? Math.max(max, order) : max;
  }, 0);
  layer.setZIndex((Number.isFinite(Number(zIndexBase)) ? Number(zIndexBase) : 0) + maxOrder);
}

/**
 * @param {unknown} layer
 * @param {string} instanceId
 * @param {string[]} layerIds
 * @param {'geometry' | 'labels' | 'raster'} role
 */
function tagOpenLayersLayer(layer, instanceId, layerIds, role) {
  const namespacedLayerIds = layerIds.map((layerId) => namespaceLayerId(instanceId, layerId));
  if (typeof layer?.set === 'function') {
    layer.set('mapzero:id', instanceId);
    layer.set('mapzero:role', role);
    layer.set('mapzero:layerIds', namespacedLayerIds);
  }
}

/**
 * @param {string} instanceId
 * @param {string} layerId
 * @returns {string}
 */
function namespaceLayerId(instanceId, layerId) {
  return `${instanceId}:${layerId}`;
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {'auto' | 'pmtiles' | 'dynamic'} source
 * @returns {'pmtiles' | 'dynamic'}
 */
function resolveSourceMode(manifest, source) {
  if (source === 'dynamic') {
    return 'dynamic';
  }

  const hasPmtiles = isPmtilesManifest(manifest);
  if (source === 'pmtiles') {
    if (!hasPmtiles) {
      throw new Error('manifest does not define vector PMTiles');
    }

    return 'pmtiles';
  }

  return hasPmtiles ? 'pmtiles' : 'dynamic';
}

/**
 * @param {string | undefined} apiBaseUrl
 * @param {string} manifestUrl
 * @returns {string}
 */
function resolveApiBaseUrl(apiBaseUrl, manifestUrl) {
  if (apiBaseUrl) {
    return resolveUrl(apiBaseUrl, manifestUrl).replace(/\/$/, '');
  }

  return new URL('/api', manifestUrl).href.replace(/\/$/, '');
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {boolean}
 */
function isPmtilesManifest(manifest) {
  const tiles = manifest.tiles;
  return Boolean(
    tiles &&
    typeof tiles === 'object' &&
    tiles.format === 'pmtiles' &&
    tiles.type === 'mvt' &&
    typeof tiles.url === 'string'
  );
}

/**
 * @param {{
 *   instanceId: string,
 *   manifest: Record<string, unknown>,
 *   manifestBaseUrl: string,
 *   styleDocument: Record<string, unknown>,
 *   orderedLayers: Array<{ id: string, type?: string, style?: string }>,
 *   layerVisibility: Map<string, boolean>,
 *   sourceMode: 'pmtiles' | 'dynamic',
 *   apiBaseUrl: string,
 *   onTileLoadStart?: () => void,
 *   onTileLoadEnd?: () => void,
 *   onTileLoadError?: () => void
 * }} context
 * @returns {VectorTileSource}
 */
function createTileSource(context) {
  const format = new MVT();
  const sourceOptions = {
    format,
    ...createVectorTileSourceZoomOptions(context),
    cacheSize: 1024,
    transition: 0,
    wrapX: false,
    tileUrlFunction: createTileUrlFunction(context)
  };

  if (context.sourceMode === 'pmtiles') {
    sourceOptions.tileLoadFunction = createPmtilesTileLoadFunction(format, createPmtilesArchive(context));
  }

  const source = new VectorTileSource(sourceOptions);
  if (context.onTileLoadStart) {
    source.on('tileloadstart', context.onTileLoadStart);
  }
  if (context.onTileLoadEnd) {
    source.on('tileloadend', context.onTileLoadEnd);
  }
  if (context.onTileLoadError) {
    source.on('tileloaderror', context.onTileLoadError);
  }

  return source;
}

/**
 * @param {{ sourceMode: 'pmtiles' | 'dynamic', manifest: Record<string, unknown> }} context
 * @returns {{ minZoom?: number, maxZoom: number, tileGrid?: unknown }}
 */
function createVectorTileSourceZoomOptions(context) {
  if (context.sourceMode !== 'pmtiles') {
    return { maxZoom: 22 };
  }

  const range = pmtilesZoomRange(context.manifest);
  return {
    minZoom: range.minZoom,
    maxZoom: range.maxZoom,
    tileGrid: createXYZ({
      minZoom: range.minZoom,
      maxZoom: range.maxZoom,
      tileSize: 512
    })
  };
}

/**
 * @param {{ sourceMode: 'pmtiles' | 'dynamic' }} context
 * @returns {(tileCoord: number[] | null) => string | undefined}
 */
function createTileUrlFunction(context) {
  return context.sourceMode === 'pmtiles'
    ? createPmtilesTileUrlFunction(context)
    : createDynamicTileUrlFunction(context);
}

/**
 * @param {{
 *   instanceId: string,
 *   manifest: Record<string, unknown>,
 *   manifestBaseUrl: string,
 *   orderedLayers: Array<{ id: string, type?: string, style?: string }>,
 *   styleDocument: Record<string, unknown>,
 *   layerVisibility: Map<string, boolean>
 * }} context
 * @returns {(tileCoord: number[] | null) => string | undefined}
 */
function createPmtilesTileUrlFunction(context) {
  const { minZoom, maxZoom } = pmtilesZoomRange(context.manifest);

  return (tileCoord) => {
    if (!tileCoord) {
      return undefined;
    }

    const [z, x, y] = tileCoord;
    if (!isValidTileCoord(z, x, y) || z < minZoom || z > maxZoom) {
      return undefined;
    }

    if (activeLayerIdsForZoom(context.orderedLayers, context.styleDocument, context.layerVisibility, z).length === 0) {
      return undefined;
    }

    return 'pmtiles://' + encodeURIComponent(context.instanceId) + '/' + z + '/' + x + '/' + y;
  };
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {{ minZoom: number, maxZoom: number }}
 */
function pmtilesZoomRange(manifest) {
  const tiles = /** @type {{ minZoom?: unknown, maxZoom?: unknown } | undefined} */ (manifest.tiles);
  const minZoom = Number.isInteger(Number(tiles?.minZoom)) ? clamp(Number(tiles?.minZoom), 0, 22) : 0;
  const maxZoom = Number.isInteger(Number(tiles?.maxZoom)) ? clamp(Number(tiles?.maxZoom), minZoom, 22) : 22;
  return { minZoom, maxZoom };
}

/**
 * @param {{
 *   apiBaseUrl: string,
 *   manifest: Record<string, unknown>,
 *   orderedLayers: Array<{ id: string, type?: string, style?: string }>,
 *   styleDocument: Record<string, unknown>,
 *   layerVisibility: Map<string, boolean>
 * }} context
 * @returns {(tileCoord: number[] | null) => string | undefined}
 */
function createDynamicTileUrlFunction(context) {
  return (tileCoord) => {
    if (!tileCoord) {
      return undefined;
    }

    const [z, x, y] = tileCoord;
    if (!isValidTileCoord(z, x, y)) {
      return undefined;
    }

    // Do not clip dynamic requests to manifest.bbox here. The package bbox is
    // the extraction extent, but stored OSM features can cross that edge. The
    // GeoPackage RTree is the authoritative source for whether a tile has data.
    const layers = activeLayerIdsForZoom(context.orderedLayers, context.styleDocument, context.layerVisibility, z);
    if (layers.length === 0) {
      return undefined;
    }

    return context.apiBaseUrl + '/tiles/' + z + '/' + x + '/' + y + '.mvt?layers=' +
      encodeURIComponent(layers.join(',')) + '&detail=' + detailForZoom(z);
  };
}

/**
 * @param {{
 *   sourceMode: 'pmtiles' | 'dynamic',
 *   apiBaseUrl: string,
 *   manifest: Record<string, unknown>,
 *   orderedLayers: Array<{ id: string, type?: string, style?: string }>,
 *   styleDocument: Record<string, unknown>,
 *   layerVisibility: Map<string, boolean>
 * }} context
 * @returns {(tileCoord: number[] | null) => string | undefined}
 */
function createLabelTileUrlFunction(context) {
  return (tileCoord) => {
    if (!tileCoord) {
      return undefined;
    }

    const [z, x, y] = tileCoord;
    if (!isValidTileCoord(z, x, y)) {
      return undefined;
    }

    // Labels use the same dynamic tile behavior as geometry: avoid client-side
    // bbox clipping so labels for features crossing the extraction edge can load.
    const labelLayers = activeLabelLayerIdsForZoom(
      context.orderedLayers,
      context.styleDocument,
      context.layerVisibility,
      z
    );
    if (labelLayers.length === 0) {
      return undefined;
    }

    if (context.sourceMode === 'pmtiles') {
      return 'pmtiles://' + encodeURIComponent(context.instanceId) + '/' + z + '/' + x + '/' + y;
    }

    return context.apiBaseUrl + '/tiles/' + z + '/' + x + '/' + y + '.mvt?layers=' +
      encodeURIComponent(labelLayers.join(',')) + '&detail=' + detailForZoom(z);
  };
}

/**
 * @param {{
 *   sourceMode: 'pmtiles' | 'dynamic',
 *   manifest: Record<string, unknown>,
 *   manifestBaseUrl: string
 * }} context
 * @returns {(tileCoord: number[], url: string | undefined) => Promise<ArrayBuffer | Uint8Array | null>}
 */
function createLabelTileDataLoader(context) {
  if (context.sourceMode === 'pmtiles') {
    const archive = createPmtilesArchive(context);
    return async (tileCoord) => {
      const [z, x, y] = tileCoord;
      const result = await archive.getZxy(z, x, y);
      return result?.data ?? null;
    };
  }

  return async (tileCoord, url) => {
    if (!url) {
      return null;
    }

    const response = await fetch(url);
    return response.ok ? response.arrayBuffer() : null;
  };
}

/**
 * @param {{ manifest: Record<string, unknown>, manifestBaseUrl: string }} context
 * @returns {PMTiles}
 */
function createPmtilesArchive(context) {
  const tiles = /** @type {{ url: string }} */ (context.manifest.tiles);
  return new PMTiles(resolveUrl(tiles.url, context.manifestBaseUrl));
}

/**
 * @param {MVT} format
 * @param {PMTiles} archive
 * @returns {(tile: { getTileCoord: () => number[], setLoader: (loader: Function) => void }) => void}
 */
function createPmtilesTileLoadFunction(format, archive) {
  return (tile) => {
    tile.setLoader((extent, resolution, projection) => {
      const [z, x, y] = tile.getTileCoord();
      archive.getZxy(z, x, y)
        .then((result) => {
          if (!result) {
            tile.setFeatures([]);
            return;
          }

          const features = format.readFeatures(result.data, {
            extent,
            featureProjection: projection
          });
          tile.setFeatures(features);
        })
        .catch(() => {
          tile.setFeatures([]);
        });
    });
  };
}

/**
 * @param {number} zoom
 * @returns {'overview' | 'normal' | 'full'}
 */
function detailForZoom(zoom) {
  if (zoom <= 11) {
    return 'overview';
  }

  if (zoom <= 14) {
    return 'normal';
  }

  return 'full';
}

/**
 * @param {Array<{ id: string, type?: string, style?: string }>} orderedLayers
 * @param {Record<string, unknown>} styleDocument
 * @param {Map<string, boolean>} layerVisibility
 * @param {number} zoom
 * @returns {string[]}
 */
function activeLayerIdsForZoom(orderedLayers, styleDocument, layerVisibility, zoom) {
  return orderedLayers
    .filter((layer) => layerVisibility.get(layer.id) && zoomMatchesRule(zoom, getLayerRule(styleDocument, layer)))
    .map((layer) => layer.id);
}

/**
 * @param {number} zoom
 * @param {Record<string, unknown>} rule
 * @returns {boolean}
 */
function zoomMatchesRule(zoom, rule) {
  if (Number.isFinite(rule.minZoom) && zoom < Number(rule.minZoom)) {
    return false;
  }

  if (Number.isFinite(rule.maxZoom) && zoom > Number(rule.maxZoom)) {
    return false;
  }

  return true;
}

/**
 * @param {{
 *   orderedLayers: Array<{ id: string, type?: string, style?: string }>,
 *   styleDocument: Record<string, unknown>,
 *   layerVisibility: Map<string, boolean>,
 *   layerOpacity: Map<string, number>
 * }} context
 * @returns {Array<{ filter: unknown[], style: Record<string, unknown> }>}
 */
function createWebGlStyles(context) {
  const styles = [];

  for (const layer of context.orderedLayers) {
    if (!context.layerVisibility.get(layer.id)) {
      continue;
    }

    const rule = getLayerRule(context.styleDocument, layer);
    const filter = createLayerFilter(layer.id, rule);
    const styleParts = layer.id === 'roads'
      ? createRoadStyleRules(filter, rule, context.layerOpacity)
      : layer.id === 'boundaries'
      ? createBoundaryStyleRules(filter, rule, context.layerOpacity)
      : isAipLayer(layer.id)
      ? createGeometryAwareStyleRules(filter, rule, layer.id, context.layerOpacity)
      : createLayerStyleRules(filter, rule, layer.type || 'line', layer.id, context.layerOpacity);
    for (const style of styleParts) {
      styles.push({
        filter: style.filter,
        style: style.style
      });
    }
  }

  return styles;
}

/**
 * @param {unknown[]} filter
 * @param {Record<string, unknown>} rule
 * @param {Map<string, number>} layerOpacity
 * @returns {Array<{ filter: unknown[], style: Record<string, unknown> }>}
 */
function createRoadStyleRules(filter, rule, layerOpacity) {
  return [
    ...createRoadSemanticUnderlayRules(filter, rule, layerOpacity),
    ...createLayerStyleRules(filter, rule, 'line', 'roads', layerOpacity),
    ...createRoadSemanticOverlayRules(filter, rule, layerOpacity)
  ];
}

/**
 * @param {unknown[]} filter
 * @param {Record<string, unknown>} rule
 * @param {Map<string, number>} layerOpacity
 * @returns {Array<{ filter: unknown[], style: Record<string, unknown> }>}
 */
function createRoadSemanticUnderlayRules(filter, rule, layerOpacity) {
  const bridge = semanticRule(rule, 'bridge');
  if (!semanticEnabled(bridge)) {
    return [];
  }

  const casingWidth = widthStyleValue(rule, 'casingWidth', Number(rule.casing?.width) || 5, 'roads');
  const shadowStyle = {
    'stroke-color': colorWithOpacity(String(bridge.shadow || '#000000'), layerOpacityModifier('roads', layerOpacity, 0.9)),
    'stroke-width': ['+', casingWidth, 1.4],
    'stroke-line-cap': 'round',
    'stroke-line-join': 'round'
  };

  return [{
    filter: bridgeFilter(filter),
    style: shadowStyle
  }];
}

/**
 * @param {unknown[]} filter
 * @param {Record<string, unknown>} rule
 * @param {Map<string, number>} layerOpacity
 * @returns {Array<{ filter: unknown[], style: Record<string, unknown> }>}
 */
function createRoadSemanticOverlayRules(filter, rule, layerOpacity) {
  const styles = [];
  const bodyWidth = widthStyleValue(rule, 'strokeWidth', Number(rule.strokeWidth ?? 1), 'roads');
  const bodyColor = String(rule.stroke || '#ffffff');
  const casingColor = String(rule.casing?.color || rule.stroke || '#ffffff');

  const bridge = semanticRule(rule, 'bridge');
  if (semanticEnabled(bridge)) {
    styles.push({
      filter: bridgeFilter(filter),
      style: {
        'stroke-color': colorWithOpacity(String(bridge.casing || casingColor), layerOpacityModifier('roads', layerOpacity, 0.85)),
        'stroke-width': ['+', bodyWidth, 0.8],
        'stroke-line-cap': 'round',
        'stroke-line-join': 'round'
      }
    });
    styles.push({
      filter: bridgeFilter(filter),
      style: {
        'stroke-color': colorWithOpacity(String(bridge.body || bodyColor), layerOpacityModifier('roads', layerOpacity, 0.95)),
        'stroke-width': ['*', bodyWidth, 0.85],
        'stroke-line-cap': 'round',
        'stroke-line-join': 'round'
      }
    });
  }

  const tunnel = semanticRule(rule, 'tunnel');
  if (semanticEnabled(tunnel)) {
    styles.push({
      filter: tunnelFilter(filter),
      style: dashedStrokeStyle(
        String(tunnel.color || casingColor),
        Number(tunnel.opacity ?? 0.72),
        ['*', bodyWidth, 0.9],
        Array.isArray(tunnel.dash) ? tunnel.dash : [10, 7],
        layerOpacity
      )
    });
  }

  const construction = semanticRule(rule, 'construction');
  if (semanticEnabled(construction)) {
    styles.push({
      filter: constructionFilter(filter),
      style: dashedStrokeStyle(
        String(construction.color || '#d9a520'),
        Number(construction.opacity ?? 0.95),
        ['*', bodyWidth, 0.85],
        Array.isArray(construction.dash) ? construction.dash : [7, 5],
        layerOpacity
      )
    });
  }

  const restrictedAccess = semanticRule(rule, 'restrictedAccess');
  if (semanticEnabled(restrictedAccess)) {
    styles.push({
      filter: minZoomFilter(restrictedAccessFilter(filter), Number(restrictedAccess.minZoom ?? 15)),
      style: dashedStrokeStyle(
        String(restrictedAccess.color || casingColor),
        Number(restrictedAccess.opacity ?? 0.75),
        ['*', bodyWidth, 0.7],
        Array.isArray(restrictedAccess.dash) ? restrictedAccess.dash : [5, 5],
        layerOpacity
      )
    });
  }

  const oneway = semanticRule(rule, 'oneway');
  if (semanticEnabled(oneway)) {
    styles.push({
      filter: minZoomFilter(onewayFilter(filter), Number(oneway.minZoom ?? 15)),
      style: dashedStrokeStyle(
        String(oneway.color || bodyColor),
        Number(oneway.opacity ?? 0.85),
        ['*', bodyWidth, 0.22],
        Array.isArray(oneway.dash) ? oneway.dash : [1.2, 9],
        layerOpacity
      )
    });
  }

  return styles;
}

/**
 * @param {Record<string, unknown>} rule
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function semanticRule(rule, name) {
  const semantics = rule.semantics && typeof rule.semantics === 'object'
    ? /** @type {Record<string, Record<string, unknown>>} */ (rule.semantics)
    : {};
  return semantics[name] || {};
}

/**
 * @param {Record<string, unknown>} rule
 * @returns {boolean}
 */
function semanticEnabled(rule) {
  return rule.enabled !== false;
}

/**
 * @param {string} color
 * @param {number} opacity
 * @param {unknown} width
 * @param {unknown[]} dash
 * @param {Map<string, number>} layerOpacity
 * @returns {Record<string, unknown>}
 */
function dashedStrokeStyle(color, opacity, width, dash, layerOpacity) {
  return {
    'stroke-color': colorWithOpacity(color, layerOpacityModifier('roads', layerOpacity, opacity)),
    'stroke-width': width,
    'stroke-line-cap': 'butt',
    'stroke-line-join': 'round',
    'stroke-line-dash': dash
  };
}

/**
 * @param {unknown[]} filter
 * @returns {unknown[]}
 */
function bridgeFilter(filter) {
  return ['all', filter, ['any', propertyEquals('bridge', 'yes'), propertyIn('layer', ['1', '2', '3', '4', '5'])]];
}

/**
 * @param {unknown[]} filter
 * @returns {unknown[]}
 */
function tunnelFilter(filter) {
  return ['all', filter, propertyEquals('tunnel', 'yes')];
}

/**
 * @param {unknown[]} filter
 * @returns {unknown[]}
 */
function constructionFilter(filter) {
  return ['all', filter, ['any', propertyEquals('highway', 'construction'), propertyNotEmpty('construction')]];
}

/**
 * @param {unknown[]} filter
 * @returns {unknown[]}
 */
function restrictedAccessFilter(filter) {
  return ['all', filter, ['any', propertyNotEmpty('service'), propertyIn('access', ['private', 'no', 'destination', 'customers', 'delivery'])]];
}

/**
 * @param {unknown[]} filter
 * @returns {unknown[]}
 */
function onewayFilter(filter) {
  return ['all', filter, propertyIn('oneway', ['yes', 'true', '1'])];
}

/**
 * @param {unknown[]} filter
 * @param {number} zoom
 * @returns {unknown[]}
 */
function minZoomFilter(filter, zoom) {
  return Number.isFinite(zoom) ? ['all', filter, ['>=', ['zoom'], zoom]] : filter;
}

/**
 * @param {string} property
 * @param {string} value
 * @returns {unknown[]}
 */
function propertyEquals(property, value) {
  return ['==', ['get', property, 'string'], value];
}

/**
 * @param {string} property
 * @param {string[]} values
 * @returns {unknown[]}
 */
function propertyIn(property, values) {
  if (values.length === 0) {
    return false;
  }

  if (values.length === 1) {
    return propertyEquals(property, values[0]);
  }

  return ['any', ...values.map((value) => propertyEquals(property, value))];
}

/**
 * @param {string} property
 * @returns {unknown[]}
 */
function propertyNotEmpty(property) {
  return ['!=', ['get', property, 'string'], ''];
}

/**
 * @param {unknown[]} filter
 * @param {Record<string, unknown>} rule
 * @param {string} layerType
 * @param {string} layerId
 * @param {Map<string, number>} layerOpacity
 * @returns {Array<{ filter: unknown[], style: Record<string, unknown> }>}
 */
function createLayerStyleRules(filter, rule, layerType, layerId, layerOpacity) {
  const visibleFilter = createPropertyVisibilityFilter(filter, rule);
  return createLayerStyleParts(rule, layerType, layerId, layerOpacity).map((style) => ({
    filter: visibleFilter,
    style
  }));
}

/**
 * @param {unknown[]} filter
 * @param {Record<string, unknown>} rule
 * @returns {unknown[]}
 */
function createPropertyVisibilityFilter(filter, rule) {
  const byProperty = rule.byProperty;
  if (!byProperty || typeof byProperty !== 'object') {
    return filter;
  }

  const hidden = [];
  for (const [propertyName, values] of Object.entries(byProperty)) {
    if (!values || typeof values !== 'object') {
      continue;
    }

    for (const [value, overrides] of Object.entries(values)) {
      if (styleOverrideVisible(overrides) === false) {
        hidden.push(['!=', ['get', propertyName, 'string'], value]);
      }
    }
  }

  return hidden.length > 0 ? ['all', filter, ...hidden] : filter;
}

/**
 * @param {unknown[]} filter
 * @param {Record<string, unknown>} rule
 * @param {Map<string, number>} layerOpacity
 * @returns {Array<{ filter: unknown[], style: Record<string, unknown> }>}
 */
function createBoundaryStyleRules(filter, rule, layerOpacity) {
  const polygonFilter = ['all', filter, ['==', ['geometry-type'], 'Polygon']];
  const lineFilter = ['all', filter, ['==', ['geometry-type'], 'LineString']];
  const polygonRule = {
    ...rule,
    stroke: null,
    strokeOpacity: 0,
    strokeWidth: 0,
    glow: {
      ...rule.glow,
      enabled: false
    },
    casing: {
      ...rule.casing,
      enabled: false
    },
    centerLine: {
      ...rule.centerLine,
      enabled: false
    }
  };
  const lineRule = {
    ...rule,
    fill: null,
    fillOpacity: 0
  };

  return [
    ...createLayerStyleRules(polygonFilter, polygonRule, 'polygon', 'boundaries', layerOpacity),
    ...createLayerStyleRules(lineFilter, lineRule, 'line', 'boundaries', layerOpacity)
  ];
}

/**
 * @param {unknown[]} filter
 * @param {Record<string, unknown>} rule
 * @param {string} layerId
 * @param {Map<string, number>} layerOpacity
 * @returns {Array<{ filter: unknown[], style: Record<string, unknown> }>}
 */
function createGeometryAwareStyleRules(filter, rule, layerId, layerOpacity) {
  const polygonFilter = ['all', filter, ['==', ['geometry-type'], 'Polygon']];
  const lineFilter = ['all', filter, ['==', ['geometry-type'], 'LineString']];
  const pointFilter = ['all', filter, ['==', ['geometry-type'], 'Point']];
  const lineRule = {
    ...rule,
    fill: null,
    fillOpacity: 0
  };

  const rules = [
    ...createLayerStyleRules(polygonFilter, rule, 'polygon', layerId, layerOpacity),
    ...createLayerStyleRules(lineFilter, lineRule, 'line', layerId, layerOpacity)
  ];

  if (isAipLayer(layerId)) {
    rules.push(...createLayerStyleRules(pointFilter, rule, 'point', layerId, layerOpacity));
  }

  return rules;
}

/**
 * @param {Record<string, unknown>} rule
 * @param {string} layerType
 * @param {string} layerId
 * @param {Map<string, number>} layerOpacity
 * @returns {Array<Record<string, unknown>>}
 */
function createLayerStyleParts(rule, layerType, layerId, layerOpacity) {
  const styles = [];

  if (rule.glow?.enabled && rule.stroke) {
    const glowWidth = widthStyleValue(rule, 'glowWidth', Number(rule.glow.width) || 4, layerId);
    const glowStyle = layerType === 'point'
      ? {
          'circle-radius': glowWidth,
          'circle-fill-color': colorStyleValue(rule, 'glowColor', 'glowOpacity', String(rule.glow.color || rule.fill || rule.stroke), Number(rule.glow.opacity ?? 0.2), layerId, layerOpacity)
        }
      : {
          'stroke-color': colorStyleValue(rule, 'glowColor', 'glowOpacity', String(rule.glow.color || rule.stroke), Number(rule.glow.opacity ?? 0.2), layerId, layerOpacity),
          'stroke-width': glowWidth
        };
    applyStrokeLineOptions(glowStyle, rule);
    styles.push(glowStyle);
  }

  if (rule.casing?.enabled && rule.stroke && layerType !== 'point') {
    const casingStyle = {
      'stroke-color': colorStyleValue(
        rule,
        'casingColor',
        'casingOpacity',
        String(rule.casing.color || rule.stroke),
        Number(rule.casing.opacity ?? 0.2),
        layerId,
        layerOpacity
      ),
      'stroke-width': widthStyleValue(rule, 'casingWidth', Number(rule.casing.width) || Math.max(1, Number(rule.strokeWidth ?? 1) + 1), layerId)
    };
    applyStrokeLineOptions(casingStyle, rule);
    styles.push(casingStyle);
  }

  const baseStyle = {};
  if (rule.fill) {
    baseStyle['fill-color'] = colorStyleValue(rule, 'fill', 'fillOpacity', String(rule.fill), Number(rule.fillOpacity ?? 1), layerId, layerOpacity);
  }
  if (rule.stroke) {
    baseStyle['stroke-color'] = colorStyleValue(rule, 'stroke', 'strokeOpacity', String(rule.stroke), Number(rule.strokeOpacity ?? 1), layerId, layerOpacity);
    baseStyle['stroke-width'] = widthStyleValue(rule, 'strokeWidth', Number(rule.strokeWidth ?? 1), layerId);
    applyStrokeLineOptions(baseStyle, rule);
  }
  if (layerType === 'point') {
    baseStyle['circle-radius'] = 4;
    baseStyle['circle-fill-color'] = colorStyleValue(
      rule,
      'fill',
      'fillOpacity',
      String(rule.fill || rule.stroke || '#ffffff'),
      Number(rule.fillOpacity ?? rule.strokeOpacity ?? 1),
      layerId,
      layerOpacity
    );
    if (rule.stroke) {
      baseStyle['circle-stroke-color'] = colorStyleValue(rule, 'stroke', 'strokeOpacity', String(rule.stroke), Number(rule.strokeOpacity ?? 1), layerId, layerOpacity);
      baseStyle['circle-stroke-width'] = numberStyleValue(rule, 'strokeWidth', Math.max(0.5, Number(rule.strokeWidth ?? 1)));
    }
  }

  styles.push(baseStyle);

  if (rule.centerLine && rule.stroke && layerType !== 'point') {
    const centerWidth = rule.centerLine.enabled ? Number(rule.centerLine.width ?? 0.5) : 0;
    const centerOpacity = rule.centerLine.enabled ? Number(rule.centerLine.opacity ?? 0.5) : 0;
    const centerStyle = {
      'stroke-color': colorStyleValue(
        rule,
        'centerLineColor',
        'centerLineOpacity',
        String(rule.centerLine.color || rule.stroke),
        centerOpacity,
        layerId,
        layerOpacity
      ),
      'stroke-width': widthStyleValue(rule, 'centerLineWidth', centerWidth, layerId)
    };
    applyStrokeLineOptions(centerStyle, rule);
    styles.push(centerStyle);
  }

  return styles;
}

/**
 * @param {Record<string, unknown>} style
 * @param {Record<string, unknown>} rule
 */
function applyStrokeLineOptions(style, rule) {
  if (rule.lineCap) {
    style['stroke-line-cap'] = rule.lineCap;
  }

  if (rule.lineJoin) {
    style['stroke-line-join'] = rule.lineJoin;
  }

  if (Number.isFinite(Number(rule.miterLimit))) {
    style['stroke-miter-limit'] = Number(rule.miterLimit);
  }
}

/**
 * @param {string} layerId
 * @param {Record<string, unknown>} rule
 * @returns {unknown[]}
 */
function createLayerFilter(layerId, rule) {
  const filters = [
    ['==', ['get', 'layer'], layerId]
  ];

  if (Number.isFinite(rule.minZoom)) {
    filters.push(['>=', ['zoom'], Number(rule.minZoom)]);
  }

  if (Number.isFinite(rule.maxZoom)) {
    filters.push(['<=', ['zoom'], Number(rule.maxZoom)]);
  }

  if (layerId === 'pois') {
    filters.push(createPoiSelectionFilter(rule));
  }

  return filters.length === 1 ? filters[0] : ['all', ...filters];
}

/**
 * @param {Record<string, unknown>} rule
 * @returns {unknown[]}
 */
function createPoiSelectionFilter(rule) {
  return ['!=', ['get', 'poi_category', 'string'], 'consumer'];
}

/**
 * @param {Record<string, unknown>} styleDocument
 * @param {{ id: string, style?: string }} layer
 * @returns {Record<string, unknown>}
 */
function getLayerRule(styleDocument, layer) {
  const layers = styleDocument.layers && typeof styleDocument.layers === 'object'
    ? /** @type {Record<string, Record<string, unknown>>} */ (styleDocument.layers)
    : {};
  const id = layer.style || layer.id;
  return normalizeStyleRule(layers[id] || layers[layerAlias(id)] || {});
}

/**
 * @param {string} layerId
 * @returns {boolean}
 */
function isAipLayer(layerId) {
  return layerId === 'aip' || layerId === 'aviation';
}

/**
 * @param {string} layerId
 * @returns {string}
 */
function layerAlias(layerId) {
  if (layerId === 'aip') return 'aviation';
  if (layerId === 'aviation') return 'aip';
  return layerId;
}

/**
 * Normalize the public declarative style schema to the internal style keys.
 *
 * @param {Record<string, unknown>} rule
 * @returns {Record<string, unknown>}
 */
function normalizeStyleRule(rule) {
  const normalized = { ...rule };
  const visibility = rule.visibility && typeof rule.visibility === 'object'
    ? /** @type {Record<string, unknown>} */ (rule.visibility)
    : null;
  const body = rule.body && typeof rule.body === 'object'
    ? /** @type {Record<string, unknown>} */ (rule.body)
    : null;
  const center = rule.center && typeof rule.center === 'object'
    ? /** @type {Record<string, unknown>} */ (rule.center)
    : null;

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
    const centerLine = {
      ...(normalized.centerLine && typeof normalized.centerLine === 'object' ? normalized.centerLine : {})
    };
    for (const key of ['enabled', 'color', 'width', 'opacity']) {
      if (key in center) {
        centerLine[key] = center[key];
      }
    }
    normalized.centerLine = centerLine;
  }

  const semantics = normalized.semantics && typeof normalized.semantics === 'object'
    ? { .../** @type {Record<string, unknown>} */ (normalized.semantics) }
    : {};
  for (const key of ['bridge', 'tunnel', 'oneway', 'construction', 'restrictedAccess']) {
    if (rule[key] && typeof rule[key] === 'object' && !semantics[key]) {
        semantics[key] = rule[key];
      }
  }
  if (Object.keys(semantics).length > 0) {
    normalized.semantics = semantics;
  }

  return normalized;
}

/**
 * @param {Record<string, unknown>} rule
 * @param {string} property
 * @param {number} fallback
 * @returns {unknown}
 */
function numberStyleValue(rule, property, fallback) {
  const byProperty = rule.byProperty;
  if (!byProperty || typeof byProperty !== 'object') {
    return fallback;
  }

  for (const [propertyName, values] of Object.entries(byProperty)) {
    if (!values || typeof values !== 'object') {
      continue;
    }

    const match = [['get', propertyName, 'string']];
    for (const [value, overrides] of Object.entries(values)) {
      const override = styleOverrideValue(overrides, property);
      if (Number.isFinite(Number(override))) {
        match.push(value, Number(override));
      }
    }

    if (match.length > 1) {
      match.push(fallback);
      return ['match', ...match];
    }
  }

  return fallback;
}

/**
 * @param {Record<string, unknown>} rule
 * @param {string} property
 * @param {number} fallback
 * @param {string} layerId
 * @returns {unknown}
 */
function widthStyleValue(rule, property, fallback, layerId) {
  if (layerId !== 'roads') {
    return numberStyleValue(rule, property, fallback);
  }

  const byProperty = rule.byProperty;
  const defaultScale = zoomWidthScale(rule);
  const defaultWidth = defaultScale ? ['*', fallback, defaultScale] : fallback;

  if (!byProperty || typeof byProperty !== 'object') {
    return defaultWidth;
  }

  for (const [propertyName, values] of Object.entries(byProperty)) {
    if (!values || typeof values !== 'object') {
      continue;
    }

    const match = [['get', propertyName, 'string']];
    for (const [value, overrides] of Object.entries(values)) {
      if (!overrides || typeof overrides !== 'object') {
        continue;
      }

      const override = styleOverrideValue(overrides, property);
      const width = Number.isFinite(Number(override)) ? Number(override) : fallback;
      const scale = zoomWidthScale(overrides) ?? defaultScale;
      match.push(value, scale ? ['*', width, scale] : width);
    }

    if (match.length > 1) {
      match.push(defaultWidth);
      return ['match', ...match];
    }
  }

  return defaultWidth;
}

/**
 * @param {Record<string, unknown>} rule
 * @returns {unknown[] | null}
 */
function zoomWidthScale(rule) {
  const body = rule.body && typeof rule.body === 'object'
    ? /** @type {Record<string, unknown>} */ (rule.body)
    : null;
  const widthScale = rule.widthScale ?? body?.widthScale;
  const stops = widthScale && typeof widthScale === 'object' ? widthScale.stops : null;
  if (!Array.isArray(stops)) {
    return null;
  }

  const expression = ['interpolate', ['linear'], ['zoom']];
  for (const stop of stops) {
    if (!Array.isArray(stop) || stop.length < 2) {
      continue;
    }

    const zoom = Number(stop[0]);
    const scale = Number(stop[1]);
    if (Number.isFinite(zoom) && Number.isFinite(scale) && scale >= 0) {
      expression.push(zoom, scale);
    }
  }

  return expression.length > 4 ? expression : null;
}

/**
 * @param {Record<string, unknown>} rule
 * @param {string} property
 * @param {number} fallback
 * @param {string} layerId
 * @param {Map<string, number>} layerOpacity
 * @returns {unknown}
 */
function opacityStyleValue(rule, property, fallback, layerId, layerOpacity) {
  return layerOpacityModifier(layerId, layerOpacity, roadOpacityModifiers(layerId, numberStyleValue(rule, property, fallback)));
}

/**
 * @param {Record<string, unknown>} rule
 * @param {string} colorProperty
 * @param {string} opacityProperty
 * @param {string} fallbackColor
 * @param {number} fallbackOpacity
 * @param {string} layerId
 * @param {Map<string, number>} layerOpacity
 * @returns {unknown}
 */
function colorStyleValue(rule, colorProperty, opacityProperty, fallbackColor, fallbackOpacity, layerId, layerOpacity) {
  const byProperty = rule.byProperty;
  if (!byProperty || typeof byProperty !== 'object') {
    return colorWithOpacity(fallbackColor, opacityStyleValue(rule, opacityProperty, fallbackOpacity, layerId, layerOpacity));
  }

  for (const [propertyName, values] of Object.entries(byProperty)) {
    if (!values || typeof values !== 'object') {
      continue;
    }

    const match = [['get', propertyName, 'string']];
    for (const [value, overrides] of Object.entries(values)) {
      if (!overrides || typeof overrides !== 'object') {
        continue;
      }

      const color = styleOverrideValue(overrides, colorProperty);
      const opacity = styleOverrideValue(overrides, opacityProperty);
      if (color || Number.isFinite(Number(opacity))) {
        match.push(
          value,
          colorWithOpacity(
            String(color || fallbackColor),
            layerOpacityModifier(
              layerId,
              layerOpacity,
              roadOpacityModifiers(layerId, Number.isFinite(Number(opacity)) ? Number(opacity) : fallbackOpacity)
            )
          )
        );
      }
    }

    if (match.length > 1) {
      match.push(colorWithOpacity(fallbackColor, opacityStyleValue(rule, opacityProperty, fallbackOpacity, layerId, layerOpacity)));
      return ['match', ...match];
    }
  }

  return colorWithOpacity(fallbackColor, opacityStyleValue(rule, opacityProperty, fallbackOpacity, layerId, layerOpacity));
}

/**
 * @param {unknown} overrides
 * @param {string} property
 * @returns {unknown}
 */
function styleOverrideValue(overrides, property) {
  if (!overrides || typeof overrides !== 'object') {
    return undefined;
  }

  const body = overrides.body && typeof overrides.body === 'object' ? overrides.body : null;
  const center = overrides.center && typeof overrides.center === 'object' ? overrides.center : null;

  if (property === 'stroke') {
    return body?.color ?? overrides.bodyColor ?? overrides.stroke;
  }

  if (property === 'strokeWidth') {
    return body?.width ?? overrides.bodyWidth ?? overrides.strokeWidth;
  }

  if (property === 'strokeOpacity') {
    return body?.opacity ?? overrides.bodyOpacity ?? overrides.strokeOpacity;
  }

  if (property === 'glowWidth') {
    return overrides.glow?.width ?? overrides.glowWidth;
  }

  if (property === 'glowOpacity') {
    return overrides.glow?.opacity ?? overrides.glowOpacity;
  }

  if (property === 'glowColor') {
    return overrides.glow?.color ?? overrides.glowColor;
  }

  if (property === 'casingWidth') {
    return overrides.casing?.width ?? overrides.casingWidth;
  }

  if (property === 'casingOpacity') {
    return overrides.casing?.opacity ?? overrides.casingOpacity;
  }

  if (property === 'casingColor') {
    return overrides.casing?.color ?? overrides.casingColor;
  }

  if (property === 'centerLineWidth') {
    return center?.width ?? overrides.centerLine?.width ?? overrides.centerLineWidth;
  }

  if (property === 'centerLineOpacity') {
    return center?.opacity ?? overrides.centerLine?.opacity ?? overrides.centerLineOpacity;
  }

  if (property === 'centerLineColor') {
    return center?.color ?? overrides.centerLine?.color ?? overrides.centerLineColor;
  }

  return overrides[property];
}

/**
 * @param {unknown} overrides
 * @returns {boolean | undefined}
 */
function styleOverrideVisible(overrides) {
  if (!overrides || typeof overrides !== 'object') {
    return undefined;
  }

  const visibility = overrides.visibility && typeof overrides.visibility === 'object'
    ? overrides.visibility
    : null;
  return visibility?.visible ?? overrides.visible;
}

/**
 * @param {string} layerId
 * @param {unknown} opacity
 * @returns {unknown}
 */
function roadOpacityModifiers(layerId, opacity) {
  return opacity;
}

/**
 * @param {string} layerId
 * @param {Map<string, number>} layerOpacity
 * @param {unknown} opacity
 * @returns {unknown}
 */
function layerOpacityModifier(layerId, layerOpacity, opacity) {
  const value = layerOpacity.get(layerId) ?? 1;
  return value === 1 ? opacity : ['*', opacity, value];
}

/**
 * @param {string} hex
 * @param {unknown} opacity
 * @returns {unknown}
 */
function colorWithOpacity(hex, opacity) {
  if (!hex || !hex.startsWith('#') || (hex.length !== 7 && hex.length !== 4)) {
    return hex || '#ffffff';
  }

  const expanded = hex.length === 4
    ? '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
    : hex;
  const r = parseInt(expanded.slice(1, 3), 16);
  const g = parseInt(expanded.slice(3, 5), 16);
  const b = parseInt(expanded.slice(5, 7), 16);
  return ['color', r, g, b, opacity];
}

/**
 * @param {string} path
 * @param {string} baseUrl
 * @returns {string}
 */
function resolveUrl(path, baseUrl) {
  return new URL(path, baseUrl).href;
}

/**
 * @returns {string}
 */
function documentBaseUrl() {
  return globalThis.document?.baseURI || globalThis.location?.href || 'http://localhost/';
}

/**
 * @param {string} url
 * @returns {Promise<Record<string, unknown>>}
 */
async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || response.statusText);
  }
  return body;
}

/**
 * @param {unknown} bbox
 * @returns {[number, number, number, number] | null}
 */
function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return null;
  }

  const values = bbox.map(Number);
  if (values.some((value) => !Number.isFinite(value)) || values[0] >= values[2] || values[1] >= values[3]) {
    return null;
  }

  return /** @type {[number, number, number, number]} */ (values);
}

/**
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function isValidTileCoord(z, x, y) {
  if (!Number.isInteger(z) || z < 0 || z > 22) {
    return false;
  }

  const maxIndex = 2 ** z;
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < maxIndex && y < maxIndex;
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {{ url?: string, minZoom?: unknown, maxZoom?: unknown }}
 */
function pmtilesInfo(manifest) {
  const tiles = manifest.tiles && typeof manifest.tiles === 'object' ? manifest.tiles : {};
  return /** @type {{ url?: string, minZoom?: unknown, maxZoom?: unknown }} */ (tiles);
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement}
 */
function emptyCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function assertRasterWorkerSupport() {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    throw new Error('map-zero OpenLayers raster-worker mode requires Worker, OffscreenCanvas, and createImageBitmap');
  }
}

/**
 * Choose the raster tile zoom at the midpoint in zoom space instead of always
 * forcing the parent or child tile. This keeps fractional zooms sharp without
 * holding low-resolution tiles for too long.
 *
 * @param {number} value
 * @param {number} high
 * @param {number} low
 * @returns {number}
 */
function preferNearestZoomLevel(value, high, low) {
  return value - low * Math.sqrt(high / low);
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInteger(value, min, max) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}

/**
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {[number, number, number, number]}
 */
function tileToBbox(z, x, y) {
  const n = 2 ** z;
  const minLon = (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;
  const maxLat = tileYToLat(y, n);
  const minLat = tileYToLat(y + 1, n);
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * @param {number} y
 * @param {number} n
 * @returns {number}
 */
function tileYToLat(y, n) {
  const mercator = Math.PI * (1 - (2 * y) / n);
  return (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
}

/**
 * @param {[number, number, number, number]} a
 * @param {[number, number, number, number]} b
 * @returns {boolean}
 */
function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function patchWebGlVectorTileRenderer() {
  const prototype = WebGLVectorTileLayerRenderer?.prototype;
  if (!prototype || prototype.__mapZeroTileMaskPatch) {
    return;
  }

  const renderTileMask = prototype.renderTileMask;
  prototype.renderTileMask = function (tileRepresentation, tileZ, extent, depth) {
    const buffers = tileRepresentation?.buffers;
    if (!tileRepresentation?.ready || !buffers?.invertVerticesTransform) {
      return;
    }

    return renderTileMask.call(this, tileRepresentation, tileZ, extent, depth);
  };
  prototype.__mapZeroTileMaskPatch = true;
}
