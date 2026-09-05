# Changelog

## 0.4.0

- Updated Cesium to 1.145.0; OpenLayers remains at 10.10.0. Aligned all map-zero package versions and derive CLI version from package metadata.
- Added native Cesium MVT rendering with 1.145 terrain/3D Tiles draping, shared theme styling, and a readonly XYZ endpoint backed by the same PMTiles archive as OpenLayers. Both viewers use vector rendering; removed raster-worker modes, imagery provider, worker routes and `@map-zero/raster`. Shared rules and caches now live in `@map-zero/core`.
- Fixed browser dependency asset resolution when the CLI is installed from npm.
- Enabled explicit rendering in the built-in Cesium viewer and corrected per-layer opacity, visibility and primitive cleanup.
- Bounded OL label/style caches, shared PMTiles reads and retries after failed tile loads.
- Added native Cesium labels using the loaded MVT tiles, shared theme rules, stable anchors, priority decluttering, per-layer controls and a labels toggle. Re-export existing PMTiles for the new anchor fields.
- Compressed PMTiles payloads and directories, bounded root directory size, corrected clustered metadata and fixed pending-write accounting in parallel exports.
- Removed duplicate 3D features across leaves and implicit truncation in dense flat layers; preserved individual tileset URLs for multi-layer exports.
- Reduced GLB index overhead and corrected quantized normal alignment and extension declarations.
- Added export/rendering regression tests, browser smoke checks, a performance review, and reproducible README GIFs of generation and 2D/3D viewers.

## 0.3.2

- Updated OpenLayers to 10.10.0 and aligned browser imports with its published
  ESM dependency graph.
- Restored reliable WebGL vector rendering while keeping labels in a dedicated
  text layer; label tiles now decode only their required MVT source layers.
- Added an optional OpenLayers `hitDetection: false` setting and use it in the
  built-in viewer to avoid unused WebGL hit-detection buffers.
- Refreshed the README around the bbox builder workflow.

## 0.3.1

- Added a `wget` fallback for Geofabrik index and `.osm.pbf` downloads.
- Added explicit network timeouts and clearer download error messages.

## 0.3.0

- Moved the PMTiles/MVT raster worker to shared `@map-zero/raster`.
- Unified Cesium and OpenLayers worker asset configuration on `workerUrl`.
- Added an OpenLayers `bbox-ui` command for drawing a bbox and launching a full
  local `from-bbox` build job.
- Improved Geofabrik bbox extract selection for border-crossing areas, smaller
  sibling extract combinations, and cached PBF reuse.
- Added subtle 2D terrain edge overlays for OSM `natural=coastline`,
  `natural=beach`, `natural=sand`, and `natural=cliff`.

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
