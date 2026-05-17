# Cesium Integration

The Cesium helper adds exported 3D Tiles to an existing Cesium viewer. It does not create or own the viewer.

```js
import { Viewer } from 'cesium';
import { addMapZeroToCesium } from '@map-zero/cesium';

const viewer = new Viewer('cesiumContainer');

const controller = await addMapZeroToCesium(viewer, {
  id: 'huelva',
  manifestUrl: './huelva.mapzero/manifest.json',
  style: 'default'
});
```

## Export 3D Tiles

```bash
node src/cli.js 3dtiles ./huelva.mapzero
```

By default, the exporter writes the building 3D Tiles layer:

- `buildings`

The default tiling uses `--max-depth 8 --max-features 1500`, which keeps dense
city exports split into smaller b3dm files so Cesium can stream and cull them
instead of parsing a few very large tiles.

Use `--layers` for a smaller export:

```bash
node src/cli.js 3dtiles ./huelva.mapzero --layers buildings,roads
```

Buildings are extruded. Heights use `height`, then `building:levels * 3`, then the configured default height.

Non-building layers are exported as flat cartographic meshes:

- roads, railways, and boundaries become buffered/dissolved line surfaces
- landuse, water, and AIP/aeronautical polygons become flat indexed surfaces
- AIP points such as helipads can become small flat markers

## Scene Configuration

The helper does not change global Cesium scene settings by default. Applications control terrain, fog, atmosphere, lighting, and background.

Optional tactical defaults:

```js
await addMapZeroToCesium(viewer, {
  manifestUrl: './huelva.mapzero/manifest.json',
  style: 'default',
  applyDefaultSceneStyle: true
});
```

The Cesium PMTiles context overlay rasterizes in a module worker with
`OffscreenCanvas`. Browsers must support `Worker`, `OffscreenCanvas`, and
`createImageBitmap`; there is no main-thread rasterization fallback.

The worker is exported as `@map-zero/cesium/imagery-worker.js`. Most bundlers
can copy or fingerprint that file and pass the final URL to the helper:

```js
await addMapZeroToCesium(viewer, {
  manifestUrl: './huelva.mapzero/manifest.json',
  contextWorkerUrl: new URL('@map-zero/cesium/imagery-worker.js', import.meta.url)
});
```

If your framework uses a different asset convention, resolve the worker however
that framework expects and pass the resulting URL as `contextWorkerUrl`.

You can also provide your own scene hook:

```js
await addMapZeroToCesium(viewer, {
  manifestUrl: './huelva.mapzero/manifest.json',
  configureScene(viewer) {
    viewer.scene.fog.enabled = false;
  }
});
```

## Multiple Packages

```js
const madrid = await addMapZeroToCesium(viewer, {
  id: 'madrid',
  manifestUrl: './madrid.mapzero/manifest.json'
});

const huelva = await addMapZeroToCesium(viewer, {
  id: 'huelva',
  manifestUrl: './huelva.mapzero/manifest.json'
});

madrid.setVisible('buildings', false);
huelva.destroy();
```

Each controller owns only its package primitives.

## Controller

```js
controller.setVisible('buildings', true);
controller.setOpacity('buildings', 0.7);
controller.destroy();
```

The module exports:

- `loadMapZeroManifest`
- `loadMapZeroStyle`
- `createMapZeroCesiumTilesets`
- `addMapZeroToCesium`
- `applyMapZeroCesiumSceneStyle`
- `createMapZeroCesiumStyle`
