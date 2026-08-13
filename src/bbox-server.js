import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import Fastify from 'fastify';

import { createPackageFromBbox } from './from-bbox.js';
import { LAYER_ALIASES, SUPPORTED_LAYERS } from './layers.js';
import { parseBbox, parseLayerList } from './utils.js';

/**
 * Serve an OpenLayers bbox builder that starts local map-zero generation jobs.
 *
 * @param {{
 *   host?: string,
 *   port?: number,
 *   outputRoot?: string,
 *   cacheDir?: string,
 *   providerIndexUrl?: string
 * }} options
 * @returns {Promise<{ app: import('fastify').FastifyInstance, url: string }>}
 */
export async function serveBboxBuilder(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8090;
  const outputRoot = resolve(options.outputRoot ?? process.cwd());
  const app = Fastify({ logger: false });
  const jobs = new Map();

  app.get('/', async (request, reply) => {
    reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(createBboxBuilderHtml());
  });

  app.get('/api/layers', async () => ({
    layers: SUPPORTED_LAYERS,
    aliases: LAYER_ALIASES
  }));

  app.post('/api/jobs', async (request, reply) => {
    const buildOptions = parseBuildRequest(request.body, {
      outputRoot,
      cacheDir: options.cacheDir,
      providerIndexUrl: options.providerIndexUrl
    });
    const id = randomUUID();
    const job = {
      id,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logs: [],
      options: {
        bbox: buildOptions.bbox,
        out: buildOptions.out,
        layers: buildOptions.layers,
        pmtiles: buildOptions.pmtiles,
        tiles3d: buildOptions.tiles3d,
        zip: buildOptions.zip
      },
      result: null,
      error: null
    };
    jobs.set(id, job);
    runBuildJob(job, buildOptions);
    reply.code(202).send({ id });
  });

  app.get('/api/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) {
      reply.code(404).send({ error: 'unknown job' });
      return;
    }
    return job;
  });

  app.setErrorHandler((error, request, reply) => {
    reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 400).send({
      error: error.message
    });
  });

  const address = await app.listen({ host, port });
  return { app, url: address };
}

function runBuildJob(job, options) {
  const log = (message) => {
    job.logs.push({ at: new Date().toISOString(), message });
    job.updatedAt = new Date().toISOString();
  };

  createPackageFromBbox({
    ...options,
    onStage: log,
    onBuildProgress(progress) {
      const message = formatBuildProgress(progress);
      if (message) log(message);
    },
    onPmtilesProgress(progress) {
      const message = formatPmtilesProgress(progress);
      if (message) log(message);
    },
    on3dTilesProgress(progress) {
      const message = format3dTilesProgress(progress);
      if (message) log(message);
    }
  }).then((result) => {
    job.status = 'completed';
    job.result = {
      outDir: result.outDir,
      source: result.source,
      sources: result.sources,
      counts: result.counts,
      pmtiles: result.pmtiles ? {
        outPath: result.pmtiles.outPath,
        outputBytes: result.pmtiles.outputBytes
      } : null,
      tiles3d: result.tiles3d ? {
        tilesetPath: result.tiles3d.tilesetPath,
        outputBytes: result.tiles3d.outputBytes
      } : null,
      zip: result.zip ? {
        outPath: result.zip.outPath,
        outputBytes: result.zip.outputBytes
      } : null
    };
    log(`Built ${result.outDir}`);
  }).catch((error) => {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    log(`Failed: ${job.error}`);
  });
}

function formatBuildProgress(event) {
  if (!event) return '';
  if (event.phase === 'stage' || event.phase === 'summary') {
    return event.message ?? event.label ?? event.step;
  }
  const label = event.label ?? event.step ?? 'build';
  const percent = progressPercent(event);
  if (percent !== null) {
    return `${label}: ${percent}%`;
  }
  return label;
}

function formatPmtilesProgress(event) {
  if (!event) return '';
  if (event.phase === 'estimate') {
    return `PMTiles estimate: ${formatInteger(event.tileCount ?? 0)} tiles`;
  }
  if (event.phase === 'zoom-progress') {
    return `PMTiles z${event.zoom}: ${formatInteger(event.completedTiles ?? 0)}/${formatInteger(event.totalTiles ?? event.tileCount ?? 0)} tiles`;
  }
  if (event.phase === 'zoom') {
    return `PMTiles z${event.zoom}: ${formatInteger(event.writtenTiles ?? 0)} written, ${formatInteger(event.skippedEmptyTiles ?? 0)} empty`;
  }
  if (event.phase === 'done') {
    return `PMTiles size: ${formatBytes(event.outputBytes ?? 0)}`;
  }
  return '';
}

function format3dTilesProgress(event) {
  if (!event) return '';
  if (event.phase === 'estimate') {
    const layer = event.layerId ? `${event.layerId}: ` : '';
    return `3D Tiles plan: ${layer}${formatInteger(event.leafCount ?? 0)} leaves`;
  }
  if (event.phase === 'leaf') {
    return `3D Tiles: ${formatInteger(event.leafIndex ?? 0)}/${formatInteger(event.leafCount ?? 0)} leaves`;
  }
  if (event.phase === 'done') {
    return `3D Tiles size: ${formatBytes(event.outputBytes ?? 0)}`;
  }
  return '';
}

function progressPercent(event) {
  if (Number.isFinite(event.bytesRead) && Number.isFinite(event.totalBytes) && Number(event.totalBytes) > 0) {
    return Math.min(100, Math.floor((Number(event.bytesRead) / Number(event.totalBytes)) * 100));
  }
  if (Number.isFinite(event.itemsDone) && Number.isFinite(event.totalItems) && Number(event.totalItems) > 0) {
    return Math.min(100, Math.floor((Number(event.itemsDone) / Number(event.totalItems)) * 100));
  }
  return null;
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let current = bytes / 1024;
  for (const unit of units) {
    if (current < 1024 || unit === units.at(-1)) {
      return `${current.toFixed(current >= 100 ? 0 : 1)} ${unit}`;
    }
    current /= 1024;
  }
  return `${bytes} B`;
}

function parseBuildRequest(body, defaults) {
  const input = body && typeof body === 'object' ? body : {};
  const bbox = Array.isArray(input.bbox)
    ? parseBbox(input.bbox.join(','))
    : parseBbox(String(input.bbox ?? ''));
  const outName = safeOutputName(String(input.out ?? 'bbox.mapzero'));
  const layers = Array.isArray(input.layers)
    ? parseLayerList(input.layers.join(','), SUPPORTED_LAYERS, LAYER_ALIASES)
    : parseLayerList(String(input.layers || SUPPORTED_LAYERS.join(',')), SUPPORTED_LAYERS, LAYER_ALIASES);
  const minZoom = integerInRange(input.minZoom, 0, 22, 8);
  const maxZoom = integerInRange(input.maxZoom, 0, 22, 16);
  if (minZoom > maxZoom) {
    throw new Error('minZoom must be smaller than or equal to maxZoom');
  }

  return {
    bbox,
    out: resolve(defaults.outputRoot, outName),
    layers,
    minZoom,
    maxZoom,
    workers: integerInRange(input.workers, 1, 64, 1),
    forcePmtiles: Boolean(input.forcePmtiles),
    forceDownload: Boolean(input.forceDownload),
    pmtiles: input.pmtiles !== false,
    tiles3d: input.tiles3d !== false,
    zip: input.zip !== false,
    includeGpkg: Boolean(input.includeGpkg),
    cacheDir: typeof input.cacheDir === 'string' && input.cacheDir.trim()
      ? input.cacheDir.trim()
      : defaults.cacheDir,
    providerIndexUrl: typeof input.providerIndexUrl === 'string' && input.providerIndexUrl.trim()
      ? input.providerIndexUrl.trim()
      : defaults.providerIndexUrl
  };
}

function safeOutputName(value) {
  const trimmed = value.trim() || 'bbox.mapzero';
  const normalized = trimmed.endsWith('.mapzero') ? trimmed : `${trimmed}.mapzero`;
  if (normalized.includes('\0')) {
    throw new Error('output name is invalid');
  }
  return normalized;
}

function integerInRange(value, min, max, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) {
    return fallback;
  }
  return number;
}

function createBboxBuilderHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>map-zero bbox builder</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ol@10.10.0/ol.css">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #101318; color: #eef2f5; }
      #app { display: grid; grid-template-columns: 340px minmax(0, 1fr); width: 100%; height: 100%; }
      #panel { box-sizing: border-box; padding: 16px; overflow: auto; border-right: 1px solid #2b3440; background: #151a21; }
      #map { min-width: 0; min-height: 0; }
      h1 { margin: 0 0 16px; font-size: 18px; font-weight: 650; }
      label { display: grid; gap: 6px; margin: 10px 0; font-size: 13px; color: #c8d0d8; }
      input, button { box-sizing: border-box; width: 100%; border: 1px solid #394553; border-radius: 6px; background: #0f1318; color: #eef2f5; padding: 8px 10px; font: inherit; }
      button { cursor: pointer; background: #1f6feb; border-color: #2f81f7; font-weight: 650; }
      button.secondary { background: #252c35; border-color: #394553; }
      button:disabled { cursor: default; opacity: 0.55; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; margin: 8px 0 12px; }
      .checks label { display: flex; align-items: center; gap: 7px; margin: 0; }
      .checks input { width: 15px; height: 15px; padding: 0; }
      #status { margin-top: 14px; color: #aab6c2; font-size: 12px; line-height: 1.45; white-space: pre-wrap; }
      @media (max-width: 760px) { #app { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); } #panel { max-height: 48vh; border-right: 0; border-bottom: 1px solid #2b3440; } }
    </style>
    <script type="importmap">
      {"imports":{"ol/":"https://cdn.jsdelivr.net/npm/ol@10.10.0/","rbush":"https://cdn.jsdelivr.net/npm/rbush@4.0.1/+esm"}}
    </script>
  </head>
  <body>
    <div id="app">
      <aside id="panel">
        <h1>map-zero bbox builder</h1>
        <button id="drawButton" class="secondary">Draw bbox</button>
        <label>bbox<input id="bboxInput" placeholder="-3.9,40.3,-3.5,40.6"></label>
        <label>output<input id="outInput" value="bbox.mapzero"></label>
        <div class="grid">
          <label>min zoom<input id="minZoomInput" type="number" min="0" max="22" value="8"></label>
          <label>max zoom<input id="maxZoomInput" type="number" min="0" max="22" value="16"></label>
        </div>
        <div id="layerChecks" class="checks"></div>
        <div class="checks">
          <label><input id="pmtilesInput" type="checkbox" checked>PMTiles</label>
          <label><input id="tiles3dInput" type="checkbox" checked>3D Tiles</label>
          <label><input id="zipInput" type="checkbox" checked>ZIP</label>
          <label><input id="includeGpkgInput" type="checkbox">GPKG in ZIP</label>
        </div>
        <button id="buildButton">Build map-zero</button>
        <div id="status">Draw a rectangle or paste a bbox.</div>
      </aside>
      <main id="map"></main>
    </div>
    <script type="module">
      import Map from 'ol/Map.js';
      import View from 'ol/View.js';
      import Draw, {createBox} from 'ol/interaction/Draw.js';
      import Modify from 'ol/interaction/Modify.js';
      import TileLayer from 'ol/layer/Tile.js';
      import VectorLayer from 'ol/layer/Vector.js';
      import OSM from 'ol/source/OSM.js';
      import VectorSource from 'ol/source/Vector.js';
      import {fromLonLat, transformExtent} from 'ol/proj.js';

      const bboxInput = document.getElementById('bboxInput');
      const outInput = document.getElementById('outInput');
      const buildButton = document.getElementById('buildButton');
      const drawButton = document.getElementById('drawButton');
      const statusEl = document.getElementById('status');
      const layerChecks = document.getElementById('layerChecks');
      const source = new VectorSource();
      const vector = new VectorLayer({
        source,
        style: {
          'stroke-color': '#2f81f7',
          'stroke-width': 2,
          'fill-color': 'rgba(47,129,247,0.18)'
        }
      });
      const map = new Map({
        target: 'map',
        layers: [new TileLayer({ source: new OSM() }), vector],
        view: new View({ center: fromLonLat([-3.7, 40.42]), zoom: 10 })
      });
      const modify = new Modify({ source });
      map.addInteraction(modify);
      modify.on('modifyend', updateBboxFromFeature);
      let draw = null;
      let pollTimer = null;

      const layerResponse = await fetch('/api/layers').then((response) => response.json());
      for (const layer of layerResponse.layers) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = layer;
        input.checked = true;
        label.append(input, layer);
        layerChecks.append(label);
      }

      drawButton.addEventListener('click', startDraw);
      buildButton.addEventListener('click', startBuild);

      function startDraw() {
        if (draw) map.removeInteraction(draw);
        draw = new Draw({ source, type: 'Circle', geometryFunction: createBox() });
        draw.on('drawstart', () => source.clear());
        draw.on('drawend', (event) => {
          requestAnimationFrame(() => updateBbox(event.feature));
          map.removeInteraction(draw);
          draw = null;
        });
        map.addInteraction(draw);
        statusEl.textContent = 'Draw the bbox on the map.';
      }

      function updateBboxFromFeature() {
        updateBbox(source.getFeatures()[0]);
      }

      function updateBbox(feature) {
        if (!feature) return;
        const extent = feature.getGeometry().getExtent();
        const bbox = transformExtent(extent, 'EPSG:3857', 'EPSG:4326')
          .map((value) => Number(value.toFixed(7)));
        bboxInput.value = bbox.join(',');
      }

      async function startBuild() {
        buildButton.disabled = true;
        statusEl.textContent = 'Starting build job...';
        const payload = {
          bbox: bboxInput.value,
          out: outInput.value,
          layers: [...layerChecks.querySelectorAll('input:checked')].map((input) => input.value),
          minZoom: Number(document.getElementById('minZoomInput').value),
          maxZoom: Number(document.getElementById('maxZoomInput').value),
          pmtiles: document.getElementById('pmtilesInput').checked,
          tiles3d: document.getElementById('tiles3dInput').checked,
          zip: document.getElementById('zipInput').checked,
          includeGpkg: document.getElementById('includeGpkgInput').checked
        };
        const response = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const body = await response.json();
        if (!response.ok) {
          buildButton.disabled = false;
          statusEl.textContent = body.error || response.statusText;
          return;
        }
        pollJob(body.id);
      }

      async function pollJob(id) {
        clearTimeout(pollTimer);
        const job = await fetch('/api/jobs/' + encodeURIComponent(id)).then((response) => response.json());
        const lines = job.logs.map((entry) => entry.message);
        statusEl.textContent = '[' + job.status + '] ' + id + '\\n' + lines.slice(-14).join('\\n');
        if (job.status === 'running') {
          pollTimer = setTimeout(() => pollJob(id), 1500);
        } else {
          buildButton.disabled = false;
        }
      }
    </script>
  </body>
</html>`;
}
