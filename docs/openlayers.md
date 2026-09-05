# OpenLayers Integration

The OpenLayers helper adds a map-zero package to an existing map. It does not create or own the map.

```js
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import { addMapZeroToOpenLayers } from '@map-zero/ol';

const map = new Map({
  target: 'map',
  layers: [],
  view: new View({ center: [0, 0], zoom: 12 })
});

const controller = await addMapZeroToOpenLayers(map, {
  id: 'madrid',
  manifestUrl: './madrid.mapzero/manifest.json'
});
```

## Sources

The helper supports:

- PMTiles vector MVT when `manifest.tiles.format === "pmtiles"`
- dynamic MVT from the map-zero server otherwise

Geometry is rendered through `WebGLVectorTileLayer`. Labels use a separate
OpenLayers text layer so text attributes do not increase the WebGL geometry
buffer stride.

Set `hitDetection: false` when the application does not call
`map.forEachFeatureAtPixel()`. This skips WebGL hit-detection buffers; the
built-in viewer uses this setting because it has no feature-picking workflow.

You can force a source mode:

```js
await addMapZeroToOpenLayers(map, {
  manifestUrl: './madrid.mapzero/manifest.json',
  source: 'pmtiles' // 'auto', 'pmtiles', or 'dynamic'
});
```

## Rendering and memory in 0.4.0

Geometry and labels share one PMTiles reader and a bounded 128-entry tile-data cache. Their geometry decoding remains separate because labels use editable features and WebGL uses compact render features. Label styles are limited to 2,048 cached entries.

Version 0.4.0 removes raster-worker rendering and its worker options. Geometry uses WebGL and text uses OpenLayers’ native placement and decluttering. Cache limits count entries, not bytes.

Cesium 1.145 can now use the same MVT payloads natively. The shared theme provides common styling inputs, with renderer-specific cartographic differences documented in [Cesium integration](cesium.md).

## Multiple Packages

Each call creates an isolated package instance:

```js
const madrid = await addMapZeroToOpenLayers(map, {
  id: 'madrid',
  manifestUrl: './madrid.mapzero/manifest.json',
  zIndexBase: 1000
});

const huelva = await addMapZeroToOpenLayers(map, {
  id: 'huelva',
  manifestUrl: './huelva.mapzero/manifest.json',
  zIndexBase: 2000
});

madrid.setVisible('roads', false);
huelva.destroy();
```

Internal layer ids are namespaced by instance. The public controller still uses logical layer ids.

## Shared Styles

Style objects can be loaded once and reused:

```js
import { loadMapZeroStyle } from '@map-zero/ol';

const style = await loadMapZeroStyle('./styles/neon-dark.json');

await addMapZeroToOpenLayers(map, {
  id: 'madrid',
  manifestUrl: './madrid.mapzero/manifest.json',
  style
});

await addMapZeroToOpenLayers(map, {
  id: 'huelva',
  manifestUrl: './huelva.mapzero/manifest.json',
  style
});
```

Shared style objects are treated as readonly.

## Controller

```js
controller.setVisible('buildings', false);
controller.setOpacity('roads', 0.8);
controller.destroy();
```

The module exports:

- `loadMapZeroManifest`
- `loadMapZeroStyle`
- `createMapZeroOpenLayersLayers`
- `addMapZeroToOpenLayers`
