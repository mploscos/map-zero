# Changelog

## 0.2.2

- Added Cesium 3D Tiles streaming options for building tilesets and raised the default building cache budget.

## 0.2.1

- Fixed OpenLayers map-zero z-index handling so map-zero layers behave as a single ordered group and labels no longer render above dynamic application layers.

## 0.2.0

- Simplified `.mapzero` manifests to use string layer lists, shared 2D/3D styles, and a single 3D buildings tileset.
- Added bbox-driven package generation and portable package zip export commands.
- Improved PMTiles exports, tile bounds handling, and large-area export guidance.
- Added Cesium context overlay rendering from vector PMTiles through a shared OffscreenCanvas worker.
- Added OpenLayers raster-worker rendering with HiDPI tiles for matching Cesium/OpenLayers visual output.
- Improved Cesium 3D building output with normals, material handling, clipping precision, and streaming defaults.
- Removed the legacy `neon-dark-3d` preset in favor of shared style presets.

## 0.1.0

Initial alpha release.

- Build `.mapzero` packages from OSM PBF extracts.
- Store normalized map data in GeoPackage.
- Serve dynamic MVT tiles locally.
- Export static vector PMTiles.
- Export Cesium 3D Tiles.
- Provide OpenLayers and Cesium integration helpers.
- Provide external JSON style presets and compact themes.
