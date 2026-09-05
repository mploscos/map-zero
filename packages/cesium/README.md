# @map-zero/cesium

Cesium integration helpers for map-zero 3D Tiles and context overlays.

See the main repository for documentation, examples, and release notes:

https://github.com/mploscos/map-zero


## Cesium 1.145 native vectors

Version 0.4.0 renders native MVT with an XYZ `vectorTilesUrl`, using Cesium 1.145 `MVTDataProvider` and surface draping. The built-in server exposes PMTiles data at `/api/vector-tiles/{z}/{x}/{y}.mvt`.

Native labels share the OpenLayers theme’s selection and priority rules, with deduplication and screen decluttering. Set `labels: false` or `maxLabels` (default 150), and toggle them with `controller.setLabelsVisible()`.

The raster worker has been removed. Cesium no longer requires OpenLayers or PMTiles as peer dependencies. Provide an MVT endpoint for context, or `contextOverlay: false` for a static 3D Tiles-only scene. Re-export old PMTiles for label anchor metadata. See [integration details](https://github.com/mploscos/map-zero/blob/v0.4.0/docs/cesium.md).

Requires Cesium 1.145.0 and Node 22+ for package consumers.
