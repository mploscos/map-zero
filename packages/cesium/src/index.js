import {
  Cesium3DTileStyle,
  Cesium3DTileset
} from 'cesium';

let autoInstanceCounter = 0;

/**
 * @typedef {{
 *   id?: string,
 *   format?: string,
 *   version?: number,
 *   name?: string,
 *   bbox?: [number, number, number, number],
 *   styles?: Record<string, string>,
 *   tiles3d?: { format?: string, url?: string, layers?: string[] },
 *   cesium?: { tilesets?: Record<string, string>, bbox?: [number, number, number, number], focusBbox?: [number, number, number, number] },
 *   layers?: Array<{ id: string, table?: string, style?: string }>
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
 *   opacity?: number
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

  const tilesetEntries = manifestTilesetEntries(manifest);
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
  for (const entry of tilesetEntries) {
    const url = resolveRelativeUrl(entry.url, options.manifestUrl);
    const tileset = await Cesium3DTileset.fromUrl(url);
    tagCesiumTileset(tileset, instanceId, entry.layerId);
    tileset.style = createMapZeroCesiumStyle(styleJson, {
      layerId: entry.layerId,
      visibleLayers: new Set([entry.layerId]),
      opacity: options.opacity ?? 1
    });
    tilesets[entry.layerId] = tileset;
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
 *   zoomTo?: boolean,
 *   applyDefaultSceneStyle?: boolean,
 *   configureScene?: (viewer: unknown) => void
 * }} options
 * @returns {Promise<{
 *   id: string,
 *   manifest: MapZeroManifest,
 *   style: Record<string, unknown> | null,
 *   tilesets: Record<string, Cesium3DTileset>,
 *   setVisible: (layerId: string, visible: boolean) => void,
 *   setOpacity: (layerId: string, opacity: number) => void,
 *   destroy: () => void
 * }>}
 */
export async function addMapZeroToCesium(viewer, options) {
  if (options.applyDefaultSceneStyle) {
    applyMapZeroCesiumSceneStyle(viewer);
  }
  if (typeof options.configureScene === 'function') {
    options.configureScene(viewer);
  }

  const result = await createMapZeroCesiumTilesets(options);
  const uniqueTilesets = [...new Set(Object.values(result.tilesets))];
  const visibleLayers = new Set(Object.keys(result.tilesets));
  let opacity = options.opacity ?? 1;

  for (const tileset of uniqueTilesets) {
    viewer.scene.primitives.add(tileset);
  }
  if (options.zoomTo !== false && typeof viewer.zoomTo === 'function') {
    const firstTileset = uniqueTilesets[0];
    if (firstTileset) {
      await viewer.zoomTo(firstTileset);
    }
  }

  return {
    manifest: result.manifest,
    id: result.id,
    style: result.style,
    tilesets: result.tilesets,
    setVisible(layerId, visible) {
      const tileset = result.tilesets[layerId];
      if (tileset) {
        if (visible) {
          visibleLayers.add(layerId);
        } else {
          visibleLayers.delete(layerId);
        }
        applyStyleToTilesetMap(result.tilesets, result.style, {
          opacity,
          visibleLayers
        });
      }
    },
    setOpacity(layerId, nextOpacity) {
      if (!result.tilesets[layerId]) return;
      opacity = clamp01(Number(nextOpacity));
      applyStyleToTilesetMap(result.tilesets, result.style, {
        opacity,
        visibleLayers
      });
    },
    destroy() {
      for (const tileset of uniqueTilesets) {
        viewer.scene.primitives.remove(tileset);
      }
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
 */
export function applyMapZeroCesiumSceneStyle(viewer) {
  const Cesium = globalThis.Cesium;
  const scene = viewer?.scene;
  if (!scene || !Cesium) {
    return;
  }

  scene.backgroundColor = Cesium.Color.BLACK;
  if (scene.globe) {
    scene.globe.baseColor = Cesium.Color.BLACK;
    scene.globe.enableLighting = false;
    scene.globe.depthTestAgainstTerrain = false;
  }
  if (scene.fog) scene.fog.enabled = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
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
 * Cesium material cannot show that outline, so building solids use the body or
 * stroke color instead of the dark fill.
 *
 * @param {Record<string, any> | null} rule
 * @param {string} layerId
 * @returns {{ color: string, opacity: number }}
 */
function cesiumLayerMaterial(rule, layerId) {
  if (layerId === 'buildings') {
    return {
      color: String(rule?.body?.color ?? rule?.stroke ?? rule?.fill ?? '#ff00ff'),
      opacity: clamp01(Number(rule?.body?.opacity ?? rule?.strokeOpacity ?? rule?.fillOpacity ?? 0.8))
    };
  }

  return {
    color: String(rule?.fill ?? rule?.body?.color ?? rule?.stroke ?? '#00ffff'),
    opacity: clamp01(Number(rule?.fillOpacity ?? rule?.body?.opacity ?? rule?.strokeOpacity ?? 0.8))
  };
}

/**
 * @param {Record<string, Cesium3DTileset>} tilesets
 * @param {Record<string, unknown> | null} style
 * @param {{ opacity: number, visibleLayers: Set<string> }} options
 */
function applyStyleToTilesetMap(tilesets, style, options) {
  for (const [layerId, tileset] of Object.entries(tilesets)) {
    tileset.style = createMapZeroCesiumStyle(style, {
      layerId,
      opacity: options.opacity,
      visibleLayers: options.visibleLayers
    });
  }
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
 * @returns {Array<{ layerId: string, url: string }>}
 */
function manifestTilesetEntries(manifest) {
  const cesiumTilesets = manifest.cesium?.tilesets;
  if (cesiumTilesets && typeof cesiumTilesets === 'object') {
    return Object.entries(cesiumTilesets)
      .filter(([, url]) => typeof url === 'string' && url.length > 0)
      .map(([layerId, url]) => ({ layerId, url }));
  }

  if (manifest.tiles3d?.format === '3dtiles' && typeof manifest.tiles3d.url === 'string') {
    const layers = Array.isArray(manifest.tiles3d.layers) && manifest.tiles3d.layers.length > 0
      ? manifest.tiles3d.layers.map(String)
      : ['buildings'];
    return layers.map((layerId) => ({
      layerId,
      url: /** @type {string} */ (manifest.tiles3d?.url)
    }));
  }

  return [];
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
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
}
