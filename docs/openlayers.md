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

You can force a source mode:

```js
await addMapZeroToOpenLayers(map, {
  manifestUrl: './madrid.mapzero/manifest.json',
  source: 'pmtiles' // 'auto', 'pmtiles', or 'dynamic'
});
```

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
