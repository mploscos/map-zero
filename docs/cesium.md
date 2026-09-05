# Cesium Integration

The Cesium helper adds exported 3D Tiles to an existing Cesium viewer. It does not create or own the viewer.

```js
import { Viewer } from 'cesium';
import { addMapZeroToCesium } from '@map-zero/cesium';

const viewer = new Viewer('cesiumContainer');

const controller = await addMapZeroToCesium(viewer, {
  id: 'huelva',
  manifestUrl: './huelva.mapzero/manifest.json',
  vectorTilesUrl: 'https://maps.example.com/huelva/{z}/{x}/{y}.mvt',
  style: 'default'
});
```

## Native vectors in Cesium 1.145

The built-in `/cesium` viewer uses native MVT context by default, with exported 3D Tiles for buildings. It reads the **same vector tiles** as OpenLayers; the server extracts them from PMTiles through an XYZ endpoint without rasterizing or regenerating them.

```js
import { HeightReference, Viewer } from 'cesium';
import { addMapZeroToCesium } from '@map-zero/cesium';

const viewer = new Viewer('cesiumContainer', {
  baseLayer: false,
  requestRenderMode: true,
  maximumRenderTimeChange: Infinity
});
const controller = await addMapZeroToCesium(viewer, {
  manifestUrl: 'http://localhost:8080/manifest.json',
  vectorTilesUrl: 'http://localhost:8080/api/vector-tiles/{z}/{x}/{y}.mvt',
  vectorHeightReference: HeightReference.CLAMP_TO_TERRAIN
});
controller.setVisible('roads', false);
controller.setOpacity('water', 0.5);
```

Use `HeightReference.CLAMP_TO_GROUND` to drape polygons and lines onto terrain **and 3D Tiles**, using the new 1.145 API. `CLAMP_TO_TERRAIN` keeps road context on the ground. `HeightReference.NONE` draws geometry on the ellipsoid.

`vectorTilesUrl` is required for native context. The raster-worker path and its options were removed in 0.4.0. Static applications need an XYZ MVT service, or can use `contextOverlay: false` to display only exported 3D Tiles.

The native provider is available as `controller.vectorProvider`, and the effective zoom range as `controller.vectorRange`. `vectorMaxZoom` can reduce detail and initialization cost. The helper limits the estimated runtime hierarchy to 20,000 nodes. Package bounds are required.

Cesium's native MVT API is experimental. Base colors, feature overrides, widths, visibility and opacity share the map-zero theme, with native text labels using shared selection rules. Polygon outlines, glow, casings and dashes still differ from OpenLayers. New archives contain `mapzero_geometry` for styling mixed layers; re-export older archives for the most accurate classification. See the [performance review](performance.md) for measurements and limitations.

Cesium 1.145 requires Node 22+ in consuming build environments. OpenLayers remains on 10.10.0.

## Export 3D Tiles

```bash
node src/cli.js 3dtiles ./huelva.mapzero
```

By default, the exporter writes the building 3D Tiles layer:

- `buildings`

The default tiling uses `--max-depth 8 --max-features 1500`, which keeps dense
city exports split into smaller b3dm files so Cesium can stream and cull them
instead of parsing a few very large tiles.

Use `--layers` to export additional flat meshes:

```bash
node src/cli.js 3dtiles ./huelva.mapzero --layers buildings,roads
```

Buildings are extruded. Heights use `height`, then `building:levels * 3`, then the configured default height.

Non-building layers are exported as flat cartographic meshes:

- roads, railways, and boundaries become buffered/dissolved line surfaces
- landuse, water, and AIP/aeronautical polygons become flat indexed surfaces
- AIP points such as helipads can become small flat markers

Terrain edge overlays (`terrain`, `coastline`, `cliffs`) are rendered through native MVT. They are not exported as 3D Tiles geometry.

## Scene Configuration

The helper does not change global Cesium scene settings by default. Applications control terrain, fog, atmosphere, lighting, and background.

Optional tactical defaults:

```js
await addMapZeroToCesium(viewer, {
  manifestUrl: './huelva.mapzero/manifest.json',
  vectorTilesUrl: 'https://maps.example.com/huelva/{z}/{x}/{y}.mvt',
  style: 'default',
  applyDefaultSceneStyle: true
});
```

You can also provide your own scene hook:

```js
await addMapZeroToCesium(viewer, {
  manifestUrl: './huelva.mapzero/manifest.json',
  vectorTilesUrl: 'https://maps.example.com/huelva/{z}/{x}/{y}.mvt',
  configureScene(viewer) {
    viewer.scene.fog.enabled = false;
  }
});
```

## Multiple Packages

```js
const madrid = await addMapZeroToCesium(viewer, {
  id: 'madrid',
  manifestUrl: './madrid.mapzero/manifest.json',
  vectorTilesUrl: 'https://maps.example.com/madrid/{z}/{x}/{y}.mvt'
});

const huelva = await addMapZeroToCesium(viewer, {
  id: 'huelva',
  manifestUrl: './huelva.mapzero/manifest.json',
  vectorTilesUrl: 'https://maps.example.com/huelva/{z}/{x}/{y}.mvt'
});

madrid.setVisible('buildings', false);
huelva.destroy();
```

Each controller owns only its package primitives.

## Controller

```js
controller.setVisible('buildings', true);
controller.setOpacity('buildings', 0.7);
controller.setLabelsVisible(false);
controller.destroy();
```

The module exports:

- `loadMapZeroManifest`
- `loadMapZeroStyle`
- `createMapZeroCesiumTilesets`
- `addMapZeroToCesium`
- `applyMapZeroCesiumSceneStyle`
- `createMapZeroCesiumStyle`

## Labels

Labels are enabled by default and rendered by a native Cesium `LabelCollection`. They reuse the MVT tiles already loaded by the native provider, with no additional tile requests or geometry decoding. Names, road references, POI selection, zoom thresholds, font, halo and priority come from the same theme rules as OpenLayers.

Names longer than 64 characters are abbreviated with an ellipsis. The controller deduplicates labels across tile and zoom boundaries and rejects overlapping screen rectangles, keeping at most `maxLabels` (default 150, configurable from 1 to 1,000). Layer visibility and opacity also apply to labels. Road labels are placed at a stable midpoint, aligned with the screen; they do not curve along roads as in OpenLayers. Labels clamp to terrain and draw above nearby geometry for readability, with horizon culling in 3D.

```js
const controller = await addMapZeroToCesium(viewer, {
  manifestUrl: '/manifest.json',
  vectorTilesUrl: '/api/vector-tiles/{z}/{x}/{y}.mvt',
  labels: true,
  maxLabels: 150
});
controller.setLabelsVisible(false);
```

The built-in viewer has a **labels** checkbox; `?labels=0` starts with labels hidden. The label collection is available as `controller.labelCollection`. `destroy()` removes the collection and its frame listeners.

Existing PMTiles remain readable but need re-exporting with 0.4.0 for Cesium labels. New tiles contain `mapzero_label_lon` and `mapzero_label_lat`, computed before clipping and simplification. Re-run `map-zero pmtiles <package>` using your desired zoom range; the GeoPackage and 3D Tiles can be reused. Dynamic MVT includes these fields automatically.
