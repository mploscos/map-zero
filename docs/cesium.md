# Cesium Integration

The Cesium helper adds exported 3D Tiles to an existing Cesium viewer. It does not create or own the viewer.

```js
import { Viewer } from 'cesium';
import { addMapZeroToCesium } from '@map-zero/cesium';

const viewer = new Viewer('cesiumContainer');

const controller = await addMapZeroToCesium(viewer, {
  id: 'huelva',
  manifestUrl: './huelva.mapzero/manifest.json',
  style: 'cesium'
});
```

## Export 3D Tiles

```bash
node src/cli.js 3dtiles ./huelva.mapzero
```

By default, the exporter writes all supported 3D layers:

- `buildings`
- `landuse`
- `water`
- `aip`
- `railways`
- `roads`
- `boundaries`

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
  style: 'cesium',
  applyDefaultSceneStyle: true
});
```

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
