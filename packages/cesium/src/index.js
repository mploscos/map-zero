import { createCesiumLabels } from './cesium-labels.js';
import { createStaticTileStyle, createStaticTileStyleFactory } from './static-style.js';
import {
  BoundingSphere, Cartesian3,
  Cesium3DTileColorBlendMode,
  Cesium3DTileStyle,
  Cesium3DTileset, HeightReference
} from 'cesium';


export { createStaticTileStyle } from './static-style.js';

let autoInstanceCounter = 0;

/**
 * @typedef {{
 *   id?: string,
 *   format?: string,
 *   version?: number,
 *   name?: string,
 *   bbox?: [number, number, number, number],
 *   styles?: Record<string, string>,
 *   tiles3d?: { format?: string, url?: string, layers?: string[], tilesets?: Record<string,string>, representations?: Record<string,{minZoom?:number,maxZoom?:number}> },
 *   layers?: Array<string | import('../../core/src/manifest.js').ManifestLayerInput>
 * }} MapZeroManifest
 */

/**
 * Load a map-zero manifest.
 *
 * @param {string} manifestUrl
 * @returns {Promise<MapZeroManifest>}
 */
export async function loadMapZeroManifest(manifestUrl) {
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`failed to load map-zero manifest: ${response.status}`);
  }

  return response.json();
}

/**
 * Load a style document.
 *
 * Supported forms:
 * - loadMapZeroStyle('./styles/neon-dark.json')
 * - loadMapZeroStyle(manifest, { manifestUrl, style: 'default' })
 *
 * @param {string | MapZeroManifest} input
 * @param {{ manifestUrl?: string, style?: string }} [options]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function loadMapZeroStyle(input, options = {}) {
  if (typeof input === 'string') {
    const response = await fetch(resolveRelativeUrl(input, globalThis.location?.href ?? 'http://localhost/'));
    if (!response.ok) {
      throw new Error(`failed to load map-zero style: ${response.status}`);
    }

    return response.json();
  }

  const manifest = input;
  const key = options.style ?? 'default';
  const stylePath = manifest.styles?.[key] ?? manifest.styles?.default;
  if (!stylePath) {
    return null;
  }

  const response = await fetch(resolveRelativeUrl(stylePath, options.manifestUrl ?? globalThis.location?.href ?? 'http://localhost/'));
  if (!response.ok) {
    throw new Error(`failed to load map-zero style: ${response.status}`);
  }

  return response.json();
}

/**
 * Create Cesium 3D Tiles primitives for a map-zero package.
 *
 * @param {{
 *   id?: string,
 *   manifestUrl: string,
 *   manifest?: MapZeroManifest,
 *   style?: string | Record<string, unknown>,
 *   styleJson?: Record<string, unknown> | null,
 *   opacity?: number,
 *   tilesetOpacity?: number,
 *   buildingsOpacity?: number,
 *   buildings3d?: boolean,
 *   clampToTerrain?: boolean,
 *   scene?: import('cesium').Scene,
 *   tilesetMaximumScreenSpaceError?: number,
 *   tilesetCacheBytes?: number,
 *   tilesetMaximumCacheOverflowBytes?: number
 * }} options
 * @returns {Promise<{ id: string, manifest: MapZeroManifest, style: Record<string, unknown> | null, tilesets: Record<string, Cesium3DTileset> }>}
 */
export async function createMapZeroCesiumTilesets(options) {
  const manifest = options.manifest ?? await loadMapZeroManifest(options.manifestUrl);
  const instanceId = createInstanceId(options.id, manifest, options.manifestUrl);
  const styleJson = options.styleJson ?? (
    options.style && typeof options.style === 'object'
      ? options.style
      : await loadMapZeroStyle(manifest, {
          manifestUrl: options.manifestUrl,
          style: typeof options.style === 'string' ? options.style : undefined
        })
  );

  const tilesetEntries = manifestTilesetEntries(manifest, {
    buildings3d: options.buildings3d
  });
  if (tilesetEntries.length === 0) {
    return {
      id: instanceId,
      manifest,
      style: styleJson,
      tilesets: {}
    };
  }

  /** @type {Record<string, Cesium3DTileset>} */
  const tilesets = {};
  const byUrl = new Map();
  try {
    for (const entry of tilesetEntries) {
      const url = resolveRelativeUrl(entry.url, options.manifestUrl);
      if(byUrl.has(url)){tilesets[entry.layerId]=byUrl.get(url);continue;}
      const tileset = await Cesium3DTileset.fromUrl(url, {
        heightReference:options.clampToTerrain ? HeightReference.CLAMP_TO_TERRAIN : HeightReference.NONE,
        scene:options.scene
      });
      byUrl.set(url,tileset);
      tagCesiumTileset(tileset, instanceId, entry.layerId);
      configureCesiumTilesetStreaming(tileset, entry.layerId, options);
      configureCesiumTilesetColor(tileset, entry.layerId);
      tileset.style = createStaticTileStyle(styleJson ?? {}, {
        layerId: entry.layerId,
        manifest,
        zoom: 16,
        opacity: tilesetOpacityForLayer(entry.layerId, options)
      });
      tilesets[entry.layerId] = tileset;
    }
  } catch (error) {
    for (const tileset of byUrl.values()) tileset.destroy();
    throw error;
  }

  return {
    id: instanceId,
    manifest,
    style: styleJson,
    tilesets
  };
}

/**
 * Add map-zero 3D Tiles to an existing Cesium Viewer.
 *
 * The helper does not create or own the viewer. It only adds map-zero
 * primitives and returns a small controller.
 *
 * @param {{ scene: { primitives: { add: (primitive: unknown) => unknown, remove: (primitive: unknown) => boolean } } }} viewer
 * @param {{
 *   id?: string,
 *   manifestUrl: string,
 *   style?: string | Record<string, unknown>,
 *   opacity?: number,
 *   tilesetOpacity?: number,
 *   buildingsOpacity?: number,
 *   labels?: boolean,
 *   maxLabels?: number,
 *   buildings3d?: boolean,
 *   clampToTerrain?: boolean,
 *   tilesetMaximumScreenSpaceError?: number,
 *   tilesetCacheBytes?: number,
 *   tilesetMaximumCacheOverflowBytes?: number,
 *   zoomTo?: boolean,
 *   applyDefaultSceneStyle?: boolean,
 *   sceneStyle?: Record<string, unknown>,
 *   configureScene?: (viewer: unknown) => void
 * }} options
 * @returns {Promise<{
 *   id: string,
 *   manifest: MapZeroManifest,
 *   style: Record<string, unknown> | null,
 *   tilesets: Record<string, Cesium3DTileset>,
 *   labelCollection?: import('cesium').LabelCollection,
 *   setLabelsVisible: (visible: boolean) => void,
 *   setVisible: (layerId: string, visible: boolean) => void,
 *   setOpacity: (layerId: string, opacity: number) => void,
 *   destroy: () => void
 * }>}
 */
export async function addMapZeroToCesium(viewer, options) {
  if (options.applyDefaultSceneStyle) {
    applyMapZeroCesiumSceneStyle(viewer, options.sceneStyle);
  }
  if (typeof options.configureScene === 'function') {
    options.configureScene(viewer);
  }

  const result = await createMapZeroCesiumTilesets({...options,scene:viewer.scene});
  const uniqueTilesets = [...new Set(Object.values(result.tilesets))];
  if (!uniqueTilesets.length) throw new Error('No static 3D Tiles in manifest; export the GeoPackage with map-zero 3dtiles first');
  const visibility = new Map(), opacities = new Map();
  const bbox = result.manifest.bbox;
  const latitude = (bbox[1]+bbox[3])/2;
  const center = new BoundingSphere(Cartesian3.fromDegrees((bbox[0]+bbox[2])/2,latitude),1);
  const getZoom = () => {
    const resolution = viewer.camera.getPixelSize(center,viewer.scene.canvas.clientWidth,viewer.scene.canvas.clientHeight);
    return Math.max(0,Math.min(24,Math.log2(156543.033928*Math.cos(latitude*Math.PI/180)/Math.max(0.001,resolution))));
  };
  const createStyle = createStaticTileStyleFactory(result.style ?? {}, { manifest: result.manifest });
  let zoom = -1, destroyed = false;
  const refresh = () => {
    zoom = Math.round(getZoom()*4)/4;
    for (const tileset of uniqueTilesets) {
      const ids=Object.keys(result.tilesets).filter(id=>result.tilesets[id]===tileset);
      tileset.show=ids.some(id=>{
        const range=result.manifest.tiles3d?.representations?.[id]??{};
        return zoom>=(range.minZoom??0)&&zoom<=(range.maxZoom??24)&&visibility.get(id)!==false&&(opacities.get(id)??tilesetOpacityForLayer(id,options))>0;
      });
      tileset.style = createStyle({
        zoom,visibility,opacities,opacity:tilesetOpacityForLayer(ids[0],options)
      });
    }
    viewer.scene.requestRender?.();
  };
  for (const tileset of uniqueTilesets) viewer.scene.primitives.add(tileset);
  let labels;
  try {
    labels = createCesiumLabels(viewer,uniqueTilesets,{
      ...options,manifest:result.manifest,styleDocument:result.style ?? {},visibility,opacities,getZoom,
      opacity:options.opacity ?? 1
    });
  } catch (error) {
    for (const tileset of uniqueTilesets) viewer.scene.primitives.remove(tileset);
    throw error;
  }
  refresh();
  const removeCamera = viewer.scene.preRender.addEventListener(() => {
    if (Math.round(getZoom()*4)/4 !== zoom) refresh();
  });
  if (options.zoomTo !== false && typeof viewer.zoomTo === 'function') await viewer.zoomTo(uniqueTilesets[0]);
  return {
    ...result,labelCollection:labels.collection,
    setLabelsVisible: (visible) => labels.setVisible(visible),
    setVisible(layerId,visible) { visibility.set(layerId,Boolean(visible)); refresh(); },
    setOpacity(layerId,value) { opacities.set(layerId,clamp01(Number(value))); refresh(); },
    destroy() {
      if (destroyed) return;
      destroyed = true; removeCamera(); labels.destroy();
      for (const tileset of uniqueTilesets) viewer.scene.primitives.remove(tileset);
      viewer.scene.requestRender?.();
    }
  };
}

/**
 * Apply optional tactical scene defaults for the built-in map-zero viewer.
 *
 * This is intentionally opt-in. External applications should keep full control
 * of their Cesium Viewer and call this helper only when they want the map-zero
 * black-background tactical look.
 *
 * @param {any} viewer
 * @param {Record<string, unknown>} [options]
 */
export function applyMapZeroCesiumSceneStyle(viewer, options = {}) {
  const Cesium = globalThis.Cesium;
  const scene = viewer?.scene;
  if (!scene || !Cesium) {
    return;
  }

  const backgroundColor = colorFromOption(Cesium, options.backgroundColor, Cesium.Color.BLACK);
  const globeBaseColor = colorFromOption(Cesium, options.globeBaseColor, backgroundColor);
  scene.backgroundColor = backgroundColor;
  if (scene.globe) {
    scene.globe.baseColor = globeBaseColor;
    scene.globe.enableLighting = Boolean(options.enableLighting ?? false);
    scene.globe.depthTestAgainstTerrain = Boolean(options.depthTestAgainstTerrain ?? false);
  }
  if (scene.fog) scene.fog.enabled = Boolean(options.fog ?? false);
  if (scene.skyBox) scene.skyBox.show = Boolean(options.skyBox ?? false);
  if (scene.sun) scene.sun.show = Boolean(options.sun ?? false);
  if (scene.moon) scene.moon.show = Boolean(options.moon ?? false);
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = Boolean(options.skyAtmosphere ?? false);
  scene.requestRender?.();
}

/**
 * Convert a map-zero layer style to a Cesium 3D Tiles style.
 *
 * @param {Record<string, unknown> | null} styleJson
 * @param {{ layerId: string, opacity?: number, visibleLayers?: Set<string> }} options
 * @returns {Cesium3DTileStyle}
 */
export function createMapZeroCesiumStyle(styleJson, options) {
  const visibleLayers = options.visibleLayers ?? new Set([options.layerId]);
  if (!visibleLayers.has(options.layerId)) {
    return new Cesium3DTileStyle({
      show: false
    });
  }

  const rule = layerStyle(styleJson, options.layerId);
  const { color, opacity } = cesiumLayerMaterial(rule, options.layerId);
  return new Cesium3DTileStyle({
    color: `color('${safeCssColor(color)}', ${clamp01(Number(options.opacity ?? 1) * opacity).toFixed(3)})`,
    show: true
  });
}

/**
 * Pick a single material color from a map-zero style rule.
 *
 * In 2D, buildings commonly use a dark fill plus a bright stroke. A single
 * Cesium material cannot show that outline, so building solids use the fill:
 * it keeps the mass quiet while avoiding translucent sorting artifacts.
 *
 * @param {Record<string, any> | null} rule
 * @param {string} layerId
 * @returns {{ color: string, opacity: number }}
 */
function cesiumLayerMaterial(rule, layerId) {
  if (layerId === 'buildings') {
    return {
      color: buildingSolidColor(rule),
      opacity: 1
    };
  }

  return {
    color: String(rule?.fill ?? rule?.body?.color ?? rule?.stroke ?? '#00ffff'),
    opacity: clamp01(Number(rule?.fillOpacity ?? rule?.body?.opacity ?? rule?.strokeOpacity ?? 0.8))
  };
}

/**
 * @param {string} layerId
 * @param {{ opacity?: number, tilesetOpacity?: number, buildingsOpacity?: number }} options
 * @returns {number}
 */
function tilesetOpacityForLayer(layerId, options) {
  if (layerId === 'buildings' && Number.isFinite(Number(options.buildingsOpacity))) {
    return Number(options.buildingsOpacity);
  }
  if (Number.isFinite(Number(options.tilesetOpacity))) {
    return Number(options.tilesetOpacity);
  }
  return Number(options.opacity ?? 1);
}

/**
 * @param {Record<string, unknown> | null} styleJson
 * @param {string} layerId
 * @returns {Record<string, any> | null}
 */
function layerStyle(styleJson, layerId) {
  const layers = /** @type {{ layers?: Record<string, unknown> } | null} */ (styleJson)?.layers;
  return /** @type {Record<string, any> | null} */ (layers?.[layerId] ?? null);
}

/**
 * @param {MapZeroManifest} manifest
 * @param {{ buildings3d?: boolean }} [options]
 * @returns {Array<{ layerId: string, url: string }>}
 */
function manifestTilesetEntries(manifest, options = {}) {
  if (manifest.tiles3d?.format === '3dtiles' && manifest.tiles3d.tilesets) {
    return Object.entries(manifest.tiles3d.tilesets)
      .filter(([layerId, url]) => typeof url === 'string' && isAllowedCesiumTilesetLayer(layerId, options))
      .map(([layerId, url]) => ({ layerId, url }));
  }
  if (manifest.tiles3d?.format === '3dtiles' && typeof manifest.tiles3d.url === 'string') {
    const layers = Array.isArray(manifest.tiles3d.layers) && manifest.tiles3d.layers.length > 0
      ? manifest.tiles3d.layers.map(String)
      : ['buildings'];
    return layers
      .filter((layerId) => isAllowedCesiumTilesetLayer(layerId, options))
      .map((layerId) => ({
        layerId,
        url: /** @type {string} */ (manifest.tiles3d?.url)
      }));
  }

  return [];
}

/**
 * @param {string} layerId
 * @param {{ buildings3d?: boolean }} options
 * @returns {boolean}
 */
function isAllowedCesiumTilesetLayer(layerId, options) {
  return layerId !== 'buildings' || options.buildings3d !== false;
}


/**
 * @param {Cesium3DTileset} tileset
 * @param {string} layerId
 * @param {{ tilesetMaximumScreenSpaceError?: number, tilesetCacheBytes?: number, tilesetMaximumCacheOverflowBytes?: number }} options
 */
function configureCesiumTilesetStreaming(tileset, layerId, options = {}) {
  if(tileset.hasExtension?.('3DTILES_content_gltf_vector')) {
    tileset.maximumScreenSpaceError=finiteNumber(options.tilesetMaximumScreenSpaceError,8);
    tileset.skipLevelOfDetail=false;
    tileset.dynamicScreenSpaceError=false;
    tileset.preloadWhenHidden=false;
    tileset.cacheBytes=finiteNumber(options.tilesetCacheBytes,192*1024*1024);
    tileset.maximumCacheOverflowBytes=finiteNumber(options.tilesetMaximumCacheOverflowBytes,32*1024*1024);
    return;
  }
  tileset.maximumScreenSpaceError = finiteNumber(options.tilesetMaximumScreenSpaceError, 24);
  tileset.skipLevelOfDetail = true;
  tileset.baseScreenSpaceError = 1024;
  tileset.skipScreenSpaceErrorFactor = 16;
  tileset.skipLevels = 1;
  tileset.immediatelyLoadDesiredLevelOfDetail = false;
  tileset.loadSiblings = false;
  tileset.cullWithChildrenBounds = true;
  tileset.dynamicScreenSpaceError = true;
  tileset.dynamicScreenSpaceErrorDensity = 0.00278;
  tileset.dynamicScreenSpaceErrorFactor = 4;
  tileset.preloadWhenHidden = false;
  tileset.preloadFlightDestinations = false;
  tileset.cacheBytes = finiteNumber(options.tilesetCacheBytes, (layerId === 'buildings' ? 192 : 64) * 1024 * 1024);
  tileset.maximumCacheOverflowBytes = finiteNumber(options.tilesetMaximumCacheOverflowBytes, 32 * 1024 * 1024);
}

/**
 * @param {Cesium3DTileset} tileset
 * @param {string} layerId
 */
function configureCesiumTilesetColor(tileset, layerId) {
  if (layerId === 'buildings') {
    tileset.backFaceCulling = false;
    tileset.colorBlendMode = Cesium3DTileColorBlendMode.REPLACE;
    tileset.colorBlendAmount = 0.45;
    return;
  }
  tileset.colorBlendMode = Cesium3DTileColorBlendMode.REPLACE;
  tileset.colorBlendAmount = 1;
}

/**
 * @param {string | undefined} id
 * @param {MapZeroManifest} manifest
 * @param {string} manifestUrl
 * @returns {string}
 */
function createInstanceId(id, manifest, manifestUrl) {
  if (id) {
    return safeInstanceId(id);
  }

  const name = typeof manifest.name === 'string' && manifest.name.trim()
    ? manifest.name
    : new URL(manifestUrl, globalThis.location?.href ?? 'http://localhost/').pathname.split('/').filter(Boolean).at(-2) ?? 'mapzero';
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
 * @param {Cesium3DTileset} tileset
 * @param {string} instanceId
 * @param {string} layerId
 */
function tagCesiumTileset(tileset, instanceId, layerId) {
  tileset.mapZero = {
    id: instanceId,
    layerId,
    namespacedLayerId: `${instanceId}:${layerId}`
  };
}

/**
 * @param {string} path
 * @param {string} baseUrl
 * @returns {string}
 */
function resolveRelativeUrl(path, baseUrl) {
  const absoluteBase = new URL(baseUrl, globalThis.location?.href ?? 'http://localhost/').href;
  return new URL(path, absoluteBase).toString();
}

/**
 * @param {string} color
 * @returns {string}
 */
function safeCssColor(color) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#ff00ff';
}

/**
 * @param {Record<string, any> | null} rule
 * @returns {string}
 */
function buildingSolidColor(rule) {
  const explicit = rule?.cesium?.color ?? rule?.tiles3d?.color ?? rule?.material?.color;
  if (typeof explicit === 'string' && isHexColor(explicit)) {
    return explicit;
  }
  return '#8a3f82';
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * @param {any} Cesium
 * @param {unknown} value
 * @param {any} fallback
 * @returns {any}
 */
function colorFromOption(Cesium, value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  return Cesium.Color.fromCssColorString(value) ?? fallback;
}


/**
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
