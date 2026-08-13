# map-zero

**Turn OpenStreetMap data into portable, self-contained map packages for 2D, 3D, and offline applications.**

`map-zero` builds normalized GeoPackage source data, vector PMTiles for OpenLayers, and Cesium 3D Tiles from one workflow. A package can also include external JSON styles, a `manifest.json`, and an optional portable ZIP. It runs without API keys, hosted map APIs, or external map infrastructure at runtime.

`map-zero` packages standard GIS and web formats into one directory. It is intended for local-first applications, offline deployments, static hosting, and projects that need both 2D and 3D map outputs from the same OpenStreetMap data.

> Early alpha. The package layout and APIs are usable, but still evolving.

## Quick Start

The easiest way to build a package is to select an area on a map:

```bash
npm install
node src/cli.js bbox-ui --output-root ./generated
```

Open the printed local URL, draw or enter a bounding box, choose layers and outputs, then select **Build map-zero**. The UI downloads suitable OpenStreetMap data, builds the package, and can export PMTiles, 3D Tiles, and a ZIP in the same job.

## What You Get

Each map is a self-contained `.mapzero` package composed of standard files:

```text
my-area.mapzero/
  data.gpkg             # normalized OpenStreetMap source data
  manifest.json         # package metadata and asset locations
  tiles.pmtiles         # optional vector tiles for 2D maps
  3dtiles/              # optional Cesium 3D Tiles
  styles/               # external JSON cartographic styles
```

`data.gpkg` is the source for dynamic MVT, PMTiles, and 3D Tiles. `manifest.json` connects the data, styles, and generated assets. Static consumers can use PMTiles and 3D Tiles without running the map-zero server.

```text
             OpenStreetMap
                   |
          bbox or local OSM PBF
                   |
                   v
               map-zero
                   |
        +----------+----------+
        |          |          |
        v          v          v
    GeoPackage   PMTiles    3D Tiles
        |          |          |
        v          v          v
   source/MVT  OpenLayers   Cesium
```

## How It Works

For a bounding box, `bbox-ui` and `from-bbox` use the same pipeline:

```text
bbox
  -> find suitable Geofabrik extracts
  -> download or reuse cached OSM PBF files
  -> build normalized GeoPackage data
  -> export PMTiles and/or 3D Tiles
  -> create a portable map-zero package and optional ZIP
```

`from-bbox` can combine smaller sibling extracts when a bbox crosses an administrative boundary, and can reuse a cached broader extract when appropriate. The default source cache is `~/.cache/map-zero/osm`.

## Why map-zero

- Local-first: one folder per map, with data and generated assets kept together.
- No API keys or hosted map services are required to render exported map data at runtime.
- Static deployment is possible for exported PMTiles and 3D Tiles.
- GeoPackage remains available as a portable source container for inspection and dynamic MVT.
- The same package can feed OpenLayers in 2D and Cesium in 3D.
- Outputs use established formats: GeoPackage, MVT, PMTiles, 3D Tiles, and JSON.

Supported logical layers are `roads`, `buildings`, `water`, `terrain`, `coastline`, `cliffs`, `landuse`, `railways`, `boundaries`, `pois`, and `aip`. The older `aviation` name remains an alias for `aip`.

## CLI Workflows

### Build from a bbox

Use the non-interactive equivalent of the bbox UI when the area is already known:

```bash
node src/cli.js from-bbox \
  --bbox -3.9,40.3,-3.5,40.6 \
  --out ./madrid.mapzero
```

This runs the same pipeline as `bbox-ui`. By default it exports PMTiles at zooms 8-16, 3D Tiles, and `madrid.mapzero.zip`. Use `--no-pmtiles`, `--no-3dtiles`, or `--no-zip` to omit an output; use `--include-gpkg` to retain the source GeoPackage in the ZIP.

### Build from a local PBF

Use `build` when an `.osm.pbf` extract is already available:

```bash
node src/cli.js build ./data/madrid.osm.pbf \
  --out ./madrid.mapzero
```

`build` infers the PBF extent and extracts all supported layers. Crop a larger input with `--bbox`:

```bash
node src/cli.js build ./data/spain.osm.pbf \
  --bbox -3.9,40.3,-3.5,40.6 \
  --out ./madrid.mapzero
```

### Preview and dynamic MVT

```bash
node src/cli.js serve ./madrid.mapzero --port 8080 --open
```

`serve` provides a local OpenLayers viewer, a Cesium viewer at `/cesium`, and a readonly HTTP API. It also generates MVT dynamically from `data.gpkg` when PMTiles are absent. It is useful for local inspection, but not required to deploy exported PMTiles or 3D Tiles.

### Export or update assets

```bash
# Static vector tiles
node src/cli.js pmtiles ./madrid.mapzero --minzoom 8 --maxzoom 16

# Cesium-ready 3D Tiles
node src/cli.js 3dtiles ./madrid.mapzero

# Portable ZIP; data.gpkg is excluded unless requested
node src/cli.js package ./madrid.mapzero --include-gpkg

# Write a bundled full preset or compact theme
node src/cli.js style ./madrid.mapzero --preset neon-dark
node src/cli.js style ./madrid.mapzero --theme neon-dark
```

For larger regional PMTiles exports, lower the maximum zoom or use more workers:

```bash
node src/cli.js pmtiles ./andalucia.mapzero --minzoom 8 --maxzoom 12 --workers 4
```

## Package Structure

The base `build` command writes `data.gpkg`, `manifest.json`, and the default style. Additional commands update the manifest as they add static assets:

```text
madrid.mapzero/
  data.gpkg                       # GeoPackage source data
  manifest.json                   # layers, bbox, styles, tile asset metadata
  styles/
    neon-dark.json                # default external style
  tiles.pmtiles                   # written by `pmtiles` or `from-bbox`
  3dtiles/
    buildings/tileset.json        # written by `3dtiles` or `from-bbox`
```

`package` writes `madrid.mapzero.zip` beside the folder. The archive includes the manifest, referenced styles, PMTiles, and 3D Tiles; it excludes `data.gpkg` by default because static OpenLayers and Cesium consumers do not need it.

PMTiles is a single static file served with HTTP range requests. It can be deployed to static hosting, object storage, nginx, or a CDN that supports range requests. 3D Tiles are likewise static files that Cesium can load from a normal web server.

## OpenLayers

Use `@map-zero/ol` to add a package to an existing OpenLayers map:

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

controller.setVisible('buildings', false);
```

The helper selects vector PMTiles when `manifest.json` provides them and otherwise uses dynamic MVT from the map-zero server. Geometry uses `WebGLVectorTileLayer`; labels use a separate OpenLayers text layer so their attribute data does not affect WebGL geometry buffers. An optional `renderMode: 'raster-worker'` path is available for worker-based raster rendering.

See [OpenLayers integration](docs/openlayers.md).

## Cesium

Use `@map-zero/cesium` to add exported 3D Tiles to an existing Cesium viewer:

```js
import { Viewer } from 'cesium';
import { addMapZeroToCesium } from '@map-zero/cesium';

const viewer = new Viewer('cesiumContainer');

const controller = await addMapZeroToCesium(viewer, {
  id: 'huelva',
  manifestUrl: './huelva.mapzero/manifest.json',
  style: 'default'
});

controller.setOpacity('buildings', 0.8);
```

Buildings are extruded with `height`, `building:levels * 3`, or a configured fallback height. Roads, railways, boundaries, water, landuse, and AIP features can be exported as flat cartographic meshes. The helper leaves terrain, atmosphere, lighting, fog, and background under application control unless configured otherwise.

The optional Cesium context overlay rasterizes PMTiles in a module worker. It requires `Worker`, `OffscreenCanvas`, and `createImageBitmap`; there is no main-thread fallback.

See [Cesium integration](docs/cesium.md).

## Styles And Themes

Styles are JSON files outside the GeoPackage, allowing the same data to be rendered differently without rebuilding source data or PMTiles. Use a bundled full preset with `--preset`, or a compact theme with `--theme`.

```bash
node src/cli.js style ./madrid.mapzero --preset neon-dark
node src/cli.js style ./madrid.mapzero --theme neon-dark
```

Most users should edit compact theme JSON rather than full renderer-ready style presets. See [styles and themes](docs/styles.md) and [cartography and POIs](docs/cartography.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Styles and themes](docs/styles.md)
- [Cartography and POIs](docs/cartography.md)
- [OpenLayers integration](docs/openlayers.md)
- [Cesium integration](docs/cesium.md)
- [HTTP API](docs/api.md)

## Current Limitations

- The package format and public APIs are still early alpha.
- Packages are readonly; editing OpenStreetMap data is not supported.
- PMTiles export is supported; MBTiles export is not.
- Cesium export focuses on extruded buildings and flat cartographic context layers. Labels, terrain clamping, advanced metadata, and regional LOD optimization are still future work.
- The built-in viewers load OpenLayers and Cesium from public CDNs. Map data, PMTiles, and 3D Tiles remain local to the package.

## License

MIT
