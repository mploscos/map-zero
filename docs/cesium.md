# Cesium: static 3D Tiles

Build and display your map with CesiumJS 1.145.0. Map context uses native vector
3D Tiles; buildings use extruded meshes. Both load from ordinary static files,
with feature styling, layer controls and streamed labels.

## Build and host

```bash
npm install --global map-zero
map-zero 3dtiles ./madrid.mapzero
map-zero serve ./madrid.mapzero --port 8080
```

Open `http://127.0.0.1:8080/cesium`. For static hosting, serve `manifest.json`,
`styles/` and `3dtiles/` with their relative paths intact. Cesium does not request
GeoPackage, PMTiles or a vector-tile API. A cross-origin host needs normal CORS
headers. Host Cesium's assets locally too when offline operation is required.

Select layers and vector detail:

```bash
map-zero 3dtiles ./madrid.mapzero --layers roads,buildings,water,pois --min-zoom 8 --max-zoom 16
```

Zoom defaults come from `manifest.tiles`, or 8–16 if absent. Feature and layer
zoom limits further restrict visibility. `--max-features` and `--max-depth`
control mesh partitioning; `--default-height` supplies missing building heights.
To produce conventional mesh context instead, use `--context-format mesh`.

## Add to your application

```bash
npm install @map-zero/cesium cesium@1.145.0
```

```js
import { addMapZeroToCesium } from '@map-zero/cesium';

const controller = await addMapZeroToCesium(viewer, {
  manifestUrl: 'https://maps.example.com/madrid/manifest.json',
  labels: true,
  maxLabels: 150,
  zoomTo: false
});

controller.setVisible('roads', false);
controller.setOpacity('water', 0.6);
controller.setLabelsVisible(false);
controller.destroy();
```

Use `requestRenderMode: true` and `maximumRenderTimeChange: Infinity` on your
Cesium Viewer. Bundle/host Cesium Workers, Assets and Widgets as usual.
The helper owns only its own tilesets, labels and listeners.

The default is **no terrain clamping** (`HeightReference.NONE`). For a scene
where context must follow terrain, pass `clampToTerrain: true` to
`addMapZeroToCesium`. Clamping adds rendering work and can reduce responsiveness.
Applications calling `createMapZeroCesiumTilesets` directly must also pass their
`scene` when enabling clamping. Buildings retain their baked geometry.

## Layers, styling and labels

`controller.tilesets` is keyed by public layer ID. Context layers can share the
same Cesium tileset instance; use the controller's visibility/opacity methods to
control them independently. Destroying the controller removes each primitive once.

Native lines use the theme's stroke color and width; points use its color and
size; polygons use its fill and opacity. Properties support classification rules.
Labels are selected from visible content, respect layer/feature zoom limits and
are capped at 150 by default (up to 1,000). No global label file is required.
Changing baked geometry or exported zoom coverage requires another export.

Labels use larger text and opaque theme colors with a stronger outline for
contrast over 3D geometry. Layer opacity controls still fade the labels.
Customize their appearance in your style JSON without re-exporting tiles:

```json
{
  "labels": {
    "cesium": {
      "fontScale": 1.3,
      "opacity": 1,
      "haloOpacity": 1,
      "haloWidth": 4
    }
  }
}
```

Merge this section into the existing style, retaining its label rules. These
settings only affect Cesium; label colors and priorities come from the theme.

The Cesium view does not reproduce every OpenLayers paint effect: road casings,
glow and dash patterns are not separate rendering passes. Supply styles for
custom layer IDs. Use `style` when creating the controller to select a manifest
style or provide a style object.

Streaming options are `tilesetMaximumScreenSpaceError`, `tilesetCacheBytes` and
`tilesetMaximumCacheOverflowBytes`. Defaults for vector context are SSE 8,
192 MiB cache and 32 MiB overflow. Budgets belong to unique tilesets, not every
logical layer referencing them. See [technical limits](cesium-format.md) before
relying on the vector renderer's memory accounting or enabling clamping.

## Custom data and output

Custom layers accept point, line, polygon and multipart geometries. Descriptors
with `tiles3d: {strategy: 'extruded'}` produce separate solid mesh tilesets;
other layers enter the vector context. Extruded solids use feature height,
building levels where applicable, then the export default.

Mesh-specific `height` and `widthMeters` settings apply to mesh output; native
vector line widths come from the theme. The vector context uses the existing
MVT cartographic selection at build time, in EPSG:4326 source coordinates;
this is a map surface workflow, not a conversion of arbitrary volumetric data.

A typical manifest references shared context and separate buildings:

```json
{
  "tiles3d": {
    "format": "3dtiles",
    "url": "3dtiles/context/tileset.json",
    "layers": ["roads", "pois", "buildings"],
    "tilesets": {
      "roads": "3dtiles/context/tileset.json",
      "pois": "3dtiles/context/tileset.json",
      "buildings": "3dtiles/buildings/tileset.json"
    }
  }
}
```

`tiles3d.representations` records per-layer counts and visibility ranges. Vector
feature counts include representations across exported LODs; `sourceFeatures`
counts GeoPackage rows. `tiles3d.warnings` reports degenerate polygon parts or
holes collapsed during quantization. `map-zero package` includes all referenced
GLBs and meshes. Source GeoPackage inclusion is optional.
