/**
 * Return the OpenLayers WebGL vector tile viewer HTML.
 *
 * @param {{ assetVersion?: string }} [options]
 * @returns {string}
 */
export function createViewerHtml(options = {}) {
  const assetVersion = encodeURIComponent(options.assetVersion ?? String(Date.now()));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>map-zero</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ol@10.10.0/ol.css">
    <style>
      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #000;
        color: #d7fbff;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #app {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
        width: 100%;
        height: 100%;
      }

      #panel {
        box-sizing: border-box;
        border-right: 1px solid rgba(0, 255, 255, 0.22);
        background: #050505;
        padding: 16px;
        overflow: auto;
      }

      #map {
        min-width: 0;
        min-height: 0;
        background: #000;
      }

      h1 {
        margin: 0 0 18px;
        color: #fff;
        font-size: 18px;
        font-weight: 650;
        letter-spacing: 0;
      }

      .layer-list {
        display: grid;
        gap: 10px;
      }

      .layer-row {
        display: flex;
        align-items: center;
        gap: 10px;
        color: #d7fbff;
        font-size: 14px;
      }

      .layer-row input {
        width: 16px;
        height: 16px;
        accent-color: #00ffff;
      }

      #status {
        margin-top: 18px;
        border-top: 1px solid rgba(255, 255, 255, 0.12);
        padding-top: 12px;
        color: #9bb7bd;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-line;
      }

      @media (max-width: 720px) {
        #app {
          grid-template-columns: 1fr;
          grid-template-rows: auto minmax(0, 1fr);
        }

        #panel {
          border-right: 0;
          border-bottom: 1px solid rgba(0, 255, 255, 0.22);
          max-height: 220px;
        }
      }
    </style>
    <script type="importmap">
      {
        "imports": {
          "ol/": "https://cdn.jsdelivr.net/npm/ol@10.10.0/",
          "rbush": "https://cdn.jsdelivr.net/npm/rbush@4.0.1/+esm",
          "pbf": "https://cdn.jsdelivr.net/npm/pbf@5.1.2/+esm",
          "earcut": "https://cdn.jsdelivr.net/npm/earcut@3.0.2/+esm",
          "pmtiles": "/vendor/pmtiles.js",
          "fflate": "/vendor/fflate.js"
        }
      }
    </script>
  </head>
  <body>
    <div id="app">
      <aside id="panel">
        <h1 id="title">map-zero</h1>
        <div id="layers" class="layer-list"></div>
        <div id="status">Loading MVT tiles</div>
      </aside>
      <main id="map"></main>
    </div>

    <script type="module">
      import OLMap from 'ol/Map.js';
      import View from 'ol/View.js';
      import {fromLonLat} from 'ol/proj.js';
      import {addMapZeroToOpenLayers, loadMapZeroManifest} from '/map-zero-ol.js?v=${assetVersion}';

      const statusEl = document.getElementById('status');
      const layersEl = document.getElementById('layers');
      const titleEl = document.getElementById('title');
      const layerStatus = new globalThis.Map();
      let loadingTiles = 0;
      let tileErrors = 0;

      start().catch((error) => {
        statusEl.textContent = error.message;
      });

      async function start() {
        const manifest = await loadMapZeroManifest('/manifest.json');
        titleEl.textContent = manifest.name || 'map-zero';

        const bbox = normalizeBbox(manifest.bbox);
        const initialView = readInitialView(bbox);
        const map = new OLMap({
          target: 'map',
          layers: [],
          view: new View({
            center: fromLonLat(initialView.center),
            zoom: initialView.zoom
          })
        });

        const controller = await addMapZeroToOpenLayers(map, {
          manifestUrl: '/manifest.json',
          manifest,
          style: 'default',
          hitDetection: false,
          ...readRenderOptions(),
          onTileLoadStart() {
            loadingTiles += 1;
            updateStatus();
          },
          onTileLoadEnd() {
            loadingTiles = Math.max(0, loadingTiles - 1);
            updateStatus();
          },
          onTileLoadError() {
            loadingTiles = Math.max(0, loadingTiles - 1);
            tileErrors += 1;
            updateStatus();
          }
        });

        document.body.style.background = controller.style.background || '#000000';

        for (const layerId of controller.manifest.layers || []) {
          addLayerToggle(String(layerId), controller);
        }

        updateStatus();
      }

      function addLayerToggle(layerId, controller) {
        const rule = controller.style.layers?.[layerId] || {};
        const label = document.createElement('label');
        label.className = 'layer-row';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = rule.visible !== false;
        input.addEventListener('change', () => {
          controller.setVisible(layerId, input.checked);
          layerStatus.set(layerId, input.checked ? 'visible' : 'hidden');
          updateStatus();
        });

        const text = document.createElement('span');
        text.textContent = layerId;

        layerStatus.set(layerId, input.checked ? 'visible' : 'hidden');
        label.append(input, text);
        layersEl.append(label);
      }

      function updateStatus() {
        const tileStatus = loadingTiles > 0
          ? 'tiles: loading ' + loadingTiles
          : tileErrors > 0
            ? 'tiles: ' + tileErrors + ' errors'
            : 'tiles: ready';
        const layerLines = [...layerStatus.entries()].map(([layer, status]) => layer + ': ' + status);
        statusEl.textContent = [tileStatus, ...layerLines].join('\\n');
      }

      function readRenderOptions() {
        const params = new URLSearchParams(window.location.search);
        const render = params.get('render');
        const options = {};
        if (render === 'raster' || render === 'raster-worker') {
          options.renderMode = 'raster-worker';
        }
        return options;
      }

      function centerOfBbox(bbox) {
        if (!bbox) {
          return [0, 0];
        }

        return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
      }

      function readInitialView(bbox) {
        const params = new URLSearchParams(window.location.search);
        const hasExplicitView = params.has('lon') && params.has('lat') && params.has('zoom');
        const lon = Number(params.get('lon'));
        const lat = Number(params.get('lat'));
        const zoom = Number(params.get('zoom'));

        if (hasExplicitView && Number.isFinite(lon) && Number.isFinite(lat) && Number.isFinite(zoom)) {
          return {
            center: [lon, lat],
            zoom,
            fromUrl: true
          };
        }

        return {
          center: centerOfBbox(bbox),
          zoom: initialZoomForBbox(bbox),
          fromUrl: false
        };
      }

      function initialZoomForBbox(bbox) {
        if (!bbox) {
          return 12;
        }

        const lonSpan = Math.abs(bbox[2] - bbox[0]);
        const latSpan = Math.abs(bbox[3] - bbox[1]);
        const span = Math.max(lonSpan, latSpan);
        if (span > 6) return 8;
        if (span > 1) return 10;
        if (span > 0.25) return 12;
        return 14;
      }

      function normalizeBbox(bbox) {
        if (!Array.isArray(bbox) || bbox.length !== 4) {
          return null;
        }

        const values = bbox.map(Number);
        if (
          values.some((value) => !Number.isFinite(value)) ||
          values[0] >= values[2] ||
          values[1] >= values[3]
        ) {
          return null;
        }

        return values;
      }
    </script>
  </body>
</html>`;
}

/**
 * Return a minimal Cesium 3D Tiles viewer HTML.
 *
 * @param {{ assetVersion?: string }} [options]
 * @returns {string}
 */
export function createCesiumViewerHtml(options = {}) {
  const assetVersion = encodeURIComponent(options.assetVersion ?? String(Date.now()));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>map-zero Cesium</title>
    <script src="https://cesium.com/downloads/cesiumjs/releases/1.141/Build/Cesium/Cesium.js"></script>
    <link rel="stylesheet" href="https://cesium.com/downloads/cesiumjs/releases/1.141/Build/Cesium/Widgets/widgets.css">
    <script type="importmap">
      {
        "imports": {
          "ol/": "https://cdn.jsdelivr.net/npm/ol@10.10.0/",
          "rbush": "https://cdn.jsdelivr.net/npm/rbush@4.0.1/+esm",
          "pbf": "https://cdn.jsdelivr.net/npm/pbf@5.1.2/+esm",
          "earcut": "https://cdn.jsdelivr.net/npm/earcut@3.0.2/+esm",
          "pmtiles": "/vendor/pmtiles.js",
          "fflate": "/vendor/fflate.js"
        }
      }
    </script>
    <style>
      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #000;
        color: #d7fbff;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #app {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
        width: 100%;
        height: 100%;
      }

      #panel {
        box-sizing: border-box;
        border-right: 1px solid rgba(0, 255, 255, 0.22);
        background: #050505;
        padding: 16px;
        overflow: auto;
        z-index: 2;
      }

      #cesiumContainer {
        min-width: 0;
        min-height: 0;
        background: #000;
      }

      h1 {
        margin: 0 0 18px;
        color: #fff;
        font-size: 18px;
        font-weight: 650;
        letter-spacing: 0;
      }

      .control-list {
        display: grid;
        gap: 12px;
      }

      .control-row {
        display: grid;
        gap: 6px;
        color: #d7fbff;
        font-size: 14px;
      }

      .inline-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: #00ffff;
      }

      input[type="range"] {
        width: 100%;
        accent-color: #00ffff;
      }

      #status {
        margin-top: 18px;
        border-top: 1px solid rgba(255, 255, 255, 0.12);
        padding-top: 12px;
        color: #9bb7bd;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-line;
      }

      .cesium-widget-credits {
        display: none !important;
      }

      @media (max-width: 720px) {
        #app {
          grid-template-columns: 1fr;
          grid-template-rows: auto minmax(0, 1fr);
        }

        #panel {
          border-right: 0;
          border-bottom: 1px solid rgba(0, 255, 255, 0.22);
          max-height: 220px;
        }
      }
    </style>
  </head>
  <body>
    <div id="app">
      <aside id="panel">
        <h1 id="title">map-zero 3D</h1>
        <div class="control-list">
          <div id="layerControls"></div>
          <label class="control-row">
            <span>opacity</span>
            <input id="layerOpacity" type="range" min="0.15" max="1" step="0.05" value="1">
          </label>
        </div>
        <div id="status">Loading 3D Tiles</div>
      </aside>
      <main id="cesiumContainer"></main>
    </div>

    <script type="module">
      import {addMapZeroToCesium, loadMapZeroManifest} from '/map-zero-cesium.js?v=${assetVersion}';

      const statusEl = document.getElementById('status');
      const titleEl = document.getElementById('title');
      const layerControlsEl = document.getElementById('layerControls');
      const opacityEl = document.getElementById('layerOpacity');
      const params = new URLSearchParams(globalThis.location.search);

      start().catch((error) => {
        statusEl.textContent = error.message;
      });

      async function start() {
        if (!globalThis.Cesium) {
          throw new Error('Cesium failed to load');
        }

        statusEl.textContent = 'Loading manifest';
        const manifest = await loadMapZeroManifest('/manifest.json');
        titleEl.textContent = (manifest.name || 'map-zero') + ' 3D';
        if (!manifest.tiles3d) {
          throw new Error('This package does not define manifest.tiles3d. Run: map-zero 3dtiles <package.mapzero>');
        }
        const sourceLabel = manifest.tiles3d?.url || '3dtiles';

        statusEl.textContent = 'Creating Cesium viewer';
        const Cesium = globalThis.Cesium;
        Cesium.Ion.defaultAccessToken = '';
        const bbox = normalizeBbox(manifest.bbox);
        const tiles3dBbox = normalizeBbox(manifest.tiles3d?.bbox || manifest.bbox);
        const viewer = new Cesium.Viewer('cesiumContainer', {
          animation: false,
          baseLayer: false,
          baseLayerPicker: false,
          fullscreenButton: false,
          geocoder: false,
          homeButton: true,
          infoBox: true,
          navigationHelpButton: false,
          sceneModePicker: true,
          selectionIndicator: true,
          timeline: false,
          terrainProvider: new Cesium.EllipsoidTerrainProvider()
        });
        globalThis.viewer = viewer;
        viewer.imageryLayers.removeAll();

        statusEl.textContent = 'Loading 3D Tileset';
        const controller = await addMapZeroToCesium(viewer, {
          manifestUrl: '/manifest.json',
          style: 'default',
          opacity: Number(opacityEl.value),
          contextOverlay: params.get('overlay') !== '0',
          contextOverzoomLevels: params.has('overzoom') ? Number(params.get('overzoom')) : undefined,
          zoomTo: false,
          applyDefaultSceneStyle: true
        });
        globalThis.mapZeroController = controller;

        statusEl.textContent = 'Positioning camera';
        const firstTileset = Object.values(controller.tilesets)[0];
        if (tiles3dBbox) {
          const targetBbox = tiles3dBbox;
          const centerLon = (targetBbox[0] + targetBbox[2]) / 2;
          const centerLat = (targetBbox[1] + targetBbox[3]) / 2;
          const spanMeters = bboxDiagonalMeters(targetBbox);
          const altitude = Math.max(1000, Math.min(5000, spanMeters * 0.35));
          viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, altitude),
            orientation: {
              heading: 0,
              pitch: Cesium.Math.toRadians(-62),
              roll: 0
            }
          });
        } else if (firstTileset?.boundingSphere) {
          const radius = Math.max(2000, firstTileset.boundingSphere.radius * 1.8);
          viewer.camera.viewBoundingSphere(
            firstTileset.boundingSphere,
            new Cesium.HeadingPitchRange(0, -0.75, radius)
          );
          viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        } else if (bbox) {
          viewer.camera.setView({
            destination: Cesium.Rectangle.fromDegrees(bbox[0], bbox[1], bbox[2], bbox[3])
          });
        }

        const uniqueTilesets = [...new Set(Object.values(controller.tilesets))];
        let readyTilesets = 0;
        for (const tileset of uniqueTilesets) {
          addCesiumEventListener(tileset.readyEvent, () => {
            readyTilesets += 1;
            statusEl.textContent = [
              '3D Tiles: tileset ready',
              readyTilesets + '/' + uniqueTilesets.length,
              'source: ' + sourceLabel,
              'layers: ' + Object.keys(controller.tilesets).join(', ')
            ].join('\\n');
          });
          addCesiumEventListener(tileset.tileLoad, () => {
            statusEl.textContent = [
              '3D Tiles: tile loaded',
              'source: ' + sourceLabel,
              'layers: ' + Object.keys(controller.tilesets).join(', ')
            ].join('\\n');
          });
          addCesiumEventListener(tileset.tileFailed, (error) => {
            statusEl.textContent = [
              '3D Tiles: tile error',
              String(error?.message || error || 'unknown error'),
              String(error?.url || '')
            ].filter(Boolean).join('\\n');
          });
        }

        statusEl.textContent = [
          '3D Tiles: ready',
          'source: ' + sourceLabel,
          'layers: ' + Object.keys(controller.tilesets).join(', ')
        ].join('\\n');

        createLayerControls(layerControlsEl, controller);
        opacityEl.addEventListener('input', () => {
          for (const layerId of Object.keys(controller.tilesets)) {
            controller.setOpacity(layerId, Number(opacityEl.value));
          }
        });
      }

      function createLayerControls(container, controller) {
        container.textContent = '';
        for (const layerId of Object.keys(controller.tilesets)) {
          const label = document.createElement('label');
          label.className = 'control-row';

          const row = document.createElement('span');
          row.className = 'inline-row';

          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = true;
          input.addEventListener('change', () => {
            controller.setVisible(layerId, input.checked);
          });

          const text = document.createElement('span');
          text.textContent = layerId;

          row.append(input, text);
          label.append(row);
          container.append(label);
        }
      }

      function normalizeBbox(bbox) {
        if (!Array.isArray(bbox) || bbox.length !== 4) {
          return null;
        }

        const values = bbox.map(Number);
        if (
          values.some((value) => !Number.isFinite(value)) ||
          values[0] >= values[2] ||
          values[1] >= values[3]
        ) {
          return null;
        }

        return values;
      }

      function bboxDiagonalMeters(bbox) {
        const meanLat = ((bbox[1] + bbox[3]) / 2) * Math.PI / 180;
        const width = Math.abs(bbox[2] - bbox[0]) * 111320 * Math.cos(meanLat);
        const height = Math.abs(bbox[3] - bbox[1]) * 110540;
        return Math.hypot(width, height);
      }

      function addCesiumEventListener(event, listener) {
        if (event && typeof event.addEventListener === 'function') {
          event.addEventListener(listener);
        }
      }
    </script>
  </body>
</html>`;
}
