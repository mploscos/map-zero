# Architecture

`map-zero` separates the data pipeline from the rendering helpers:

- OSM PBF is parsed into a normalized GeoPackage.
- Dynamic MVT, PMTiles export, and 3D Tiles export read from that GeoPackage.
- Styles live outside the GeoPackage as JSON.
- OpenLayers and Cesium helpers add map-zero packages to existing viewers without owning the application.

## Core Pipeline

- `src/cli.js`: command wiring, argument parsing, terminal progress output.
- `src/build.js`: package build orchestration and output folder creation.
- `src/osm.js`: streamed OSM PBF scan, temporary SQLite build store, geometry extraction.
- `src/layers.js`: logical layer definitions, OSM tag matching, layer property normalization, including subtle 2D terrain edge overlays for coastline, beach/sand, and cliffs.
- `src/gpkg.js`: GeoPackage creation and incremental feature writes.
- `src/gpkg-read.js`: readonly GeoPackage metadata and tile feature queries.
- `src/geometry-read.js`: GeoPackage binary geometry decoding.

## 2D Tile Pipeline

- `src/mvt.js`: shared MVT generation, server-side filtering, detail policy, generalization.
- `src/server.js`: readonly Fastify API, dynamic MVT routes, cache and viewer assets.
- `src/tile-cache.js`: in-memory LRU cache and in-flight tile request coalescing support.
- `src/export-pmtiles.js`: PMTiles export orchestration and progress.
- `src/pmtiles-worker.js`: worker-thread tile generation for PMTiles export.
- `src/pmtiles.js`: PMTiles archive writer utilities.

Dynamic serving and PMTiles export both call the same `src/mvt.js` tile generation functions.

## 3D Tiles Pipeline

- `src/3dtiles/export.js`: 3D Tiles export orchestration.
- `src/3dtiles/gpkg-buildings.js`: readonly building queries and height extraction.
- `src/3dtiles/gpkg-features.js`: readonly feature queries for non-building layers.
- `src/3dtiles/extrude.js`: building footprint extrusion.
- `src/3dtiles/clipper-surfaces.js`: buffered/dissolved line surfaces for cartographic layers.
- `src/3dtiles/flat.js`: flat polygon and point-derived surfaces.
- `src/3dtiles/glb.js`: minimal unlit GLB generation.
- `src/3dtiles/b3dm.js`: B3DM wrapper.
- `src/3dtiles/tileset.js`: tileset JSON generation.

The Cesium export currently favors top-down cartographic fidelity over street-level realism. Roads and other line layers are converted to flat surfaces rather than GPU-only line primitives so the output is portable 3D Tiles geometry.

Terrain edge overlays (`terrain`, `coastline`, `cliffs`) remain in the 2D cartographic context pipeline and are intentionally not part of 3D Tiles export.

## Style And Rendering

- `src/style-presets.js`: full preset loading and layer filtering.
- `src/style-themes.js`: compact theme expansion into full style JSON.
- `src/style.js`: compatibility re-export for style APIs.
- `src/style-command.js`: `map-zero style` command implementation.
- `styles/presets/*.json`: full renderer-ready style presets.
- `styles/themes/*.theme.json`: compact user-editable themes.
- `packages/ol/src/index.js`: framework-agnostic OpenLayers layer helper.
- `packages/ol/src/labels.js`: optional OpenLayers text label layer.
- `packages/cesium/src/index.js`: framework-agnostic Cesium helper.
- `packages/raster/src/imagery-worker.js`: shared PMTiles/MVT raster worker used by Cesium overlays and OpenLayers raster mode.
- `src/html.js`: built-in OpenLayers and Cesium viewer shells.

## Package Layout

```text
example.mapzero/
  data.gpkg
  manifest.json
  tiles.pmtiles
  3dtiles/
  styles/
```

`data.gpkg` is the source of truth after build. PMTiles and 3D Tiles can be regenerated from it without rebuilding from OSM.

## Serving Modes

`map-zero` supports two deployment models:

- **Dynamic local server**: Node reads `data.gpkg` and generates MVT on demand.
- **Static/serverless hosting**: exported `tiles.pmtiles` and `3dtiles/` are served as static files.

PMTiles and 3D Tiles do not require a map-zero runtime server after export. The local server remains useful for inspection, development, and dynamic GeoPackage-backed tiles.

## Refactor Notes

- `src/mvt.js`: tile filtering, generalization and encoding are still coupled. A future refactor can split query filters, generalization and MVT encoding.
- `src/osm.js`: streamed parser and disk-backed build pipeline are coupled. A future refactor can split temp-store access and geometry builders.
- `src/export-pmtiles.js`: export planning, worker scheduling and PMTiles staging are coupled. A future refactor can split estimation/progress from worker orchestration.
- `packages/ol/src/index.js`: source creation, style interpretation and layer creation are coupled. A future refactor can split source adapters from WebGL style generation.

These are implementation notes, not public API.
