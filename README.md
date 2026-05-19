# map-zero

Offline vector map packages from OpenStreetMap, ready for GeoPackage, PMTiles, and 3D Tiles.

`map-zero` turns an OSM PBF extract into a portable `.mapzero` folder. The package keeps source data in GeoPackage, can export static PMTiles for fast web delivery, and can export Cesium 3D Tiles for 3D visualization. It is designed for local-first workflows: no API tokens, no hosted map service, no external data service at runtime.

When you export PMTiles or 3D Tiles, the map can be hosted serverlessly as static files. The dynamic Node server is only needed for on-demand MVT generation from `data.gpkg` or for local inspection.

> Early alpha. The format and APIs are usable, but still evolving.

## What It Does

- Builds offline map packages from `.osm.pbf`
- Stores normalized OSM layers in `data.gpkg`
- Serves dynamic MVT tiles locally
- Exports static vector `tiles.pmtiles`
- Exports Cesium `3dtiles/`
- Includes a minimal OpenLayers viewer
- Includes a minimal Cesium viewer
- Provides framework-agnostic OpenLayers and Cesium helpers
- Uses external JSON styles and compact themes

Supported logical layers include `roads`, `buildings`, `water`, `terrain`, `coastline`, `cliffs`, `landuse`, `railways`, `boundaries`, `pois`, and `aip` for aeronautical/AIP-style data. Older `aviation` layer names are still accepted as compatibility aliases.

## Why

Most map stacks assume online tiles, external APIs, or a heavier database/server setup. `map-zero` is for small-to-medium offline packages that should be easy to build, inspect, host, and embed:

- one folder per map
- GeoPackage as the editable/source container
- PMTiles for static, serverless 2D vector maps
- 3D Tiles for static, serverless Cesium scenes
- OpenLayers and Cesium integration without owning your app

## Quick Start

Install dependencies:

```bash
npm install
```

Download an OSM PBF extract:

```bash
mkdir -p data
wget https://download.geofabrik.de/europe/spain/madrid-latest.osm.pbf \
  -O data/madrid.osm.pbf
```

Build a package:

```bash
node src/cli.js build ./data/madrid.osm.pbf --out ./madrid.mapzero
```

Or build the complete static package directly from a bbox:

```bash
node src/cli.js from-bbox \
  --bbox -3.9,40.3,-3.5,40.6 \
  --out ./madrid.mapzero
```

`from-bbox` downloads and caches the smallest suitable Geofabrik `.osm.pbf`
extract for the bbox, then runs `build`, `pmtiles`, `3dtiles`, and `package`.
The selector avoids administrative extracts that only partially cover border
areas by combining smaller sibling extracts when together they cover the bbox,
and can reuse an already cached broader extract when it is still a reasonable
fit. The source PBF cache defaults to `~/.cache/map-zero/osm`.

For an interactive bbox workflow, start the OpenLayers bbox builder:

```bash
node src/cli.js bbox-ui --output-root ./generated
```

Open the printed URL, draw a rectangle, choose layers/export options, and start
the build job. The UI calls the same `from-bbox` pipeline and writes the
generated `.mapzero` folder under `--output-root`.

Serve it:

```bash
node src/cli.js serve ./madrid.mapzero --port 8080 --open
```

Open:

```text
http://localhost:8080
```

`serve` is mainly a local preview and inspection command. It is also useful when you want dynamic MVT generated directly from `data.gpkg`. It is not required to deploy a map after exporting PMTiles or 3D Tiles.

By default, `build` infers the PBF bbox and extracts every supported layer. For a cropped package:

```bash
node src/cli.js build ./data/spain.osm.pbf \
  --bbox -3.9,40.3,-3.5,40.6 \
  --out ./madrid.mapzero
```

## Package Structure

```text
madrid.mapzero/
  data.gpkg             # normalized OSM features
  manifest.json         # package metadata
  tiles.pmtiles         # optional static MVT archive
  3dtiles/              # optional Cesium 3D Tiles
  styles/
    neon-dark.json
```

`data.gpkg` is the source for dynamic MVT, PMTiles export, and 3D Tiles export. Styles are JSON files outside the GeoPackage so the same data can be rendered by different viewers.

## PMTiles

Export static vector tiles:

```bash
node src/cli.js pmtiles ./madrid.mapzero
```

For large regional packages, keep max zoom lower:

```bash
node src/cli.js pmtiles ./andalucia.mapzero --minzoom 8 --maxzoom 12 --workers 4
```

When `tiles.pmtiles` is present in `manifest.json`, the built-in OpenLayers viewer uses it automatically. Without PMTiles, the server falls back to dynamic MVT generation from `data.gpkg`.

PMTiles is a single static file with HTTP range requests. It can be served from static hosting, object storage, nginx, GitHub Pages-style hosting, or any CDN that supports range requests.

Use `map-zero serve` to preview the package locally; use your normal static hosting stack to publish the generated PMTiles package.

## 3D Tiles

Export Cesium-ready 3D Tiles:

```bash
node src/cli.js 3dtiles ./madrid.mapzero
```

Buildings are extruded into streamed Cesium tiles. The default subdivision is tuned for dense cities like Madrid; use `--max-depth` and `--max-features` only when you need coarser or finer tiles. Roads, railways, boundaries, water, landuse, and AIP/aeronautical features are exported as flat cartographic meshes when requested with `--layers`. Terrain edge overlays (`terrain`, `coastline`, `cliffs`) stay as 2D cartographic context and are not part of 3D Tiles export. The Cesium viewer is available at:

```text
http://localhost:8080/cesium
```

3D Tiles are also static files. Once exported, they do not need the map-zero Node server; Cesium can load them from any normal static web server.

The PMTiles raster overlay used by Cesium and OpenLayers uses the shared
`@map-zero/raster/imagery-worker.js` module worker plus `OffscreenCanvas`;
there is no main-thread rasterization fallback. Use `workerUrl` in either
viewer helper when your app copies that worker to a fingerprinted asset URL.

Use `map-zero serve` to preview the Cesium output locally; use static hosting to publish the exported `3dtiles/` folder.

## Portable ZIP

Create a zip ready to copy into an app:

```bash
node src/cli.js package ./madrid.mapzero
```

By default this writes `madrid.mapzero.zip` next to the package and includes `manifest.json`, the styles referenced by the manifest, `tiles.pmtiles`, and `3dtiles/`. The source GeoPackage is excluded because static OpenLayers/Cesium consumers do not need it.

Include `data.gpkg` explicitly when you want to keep the source package data in the archive:

```bash
node src/cli.js package ./madrid.mapzero --include-gpkg
```

## OpenLayers Usage

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

The helper reuses the same MVT + WebGL rendering path as the built-in viewer. It supports dynamic HTTP MVT, static vector PMTiles, and optional shared-worker raster rendering.

See [docs/openlayers.md](docs/openlayers.md).

## Cesium Usage

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

The helper does not take over your Cesium scene. Lighting, terrain, atmosphere, fog, and background remain under application control unless you explicitly opt into map-zero scene defaults.

See [docs/cesium.md](docs/cesium.md).

## Styles And Themes

Apply a bundled preset:

```bash
node src/cli.js style ./madrid.mapzero --preset neon-dark
```

Apply a compact theme:

```bash
node src/cli.js style ./madrid.mapzero --theme neon-dark
```

Most users should edit compact theme JSON instead of full renderer-ready style presets.

See [docs/styles.md](docs/styles.md) and [docs/cartography.md](docs/cartography.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Styles and themes](docs/styles.md)
- [Cartography and POIs](docs/cartography.md)
- [OpenLayers integration](docs/openlayers.md)
- [Cesium integration](docs/cesium.md)
- [HTTP API](docs/api.md)

## Current Limitations

- Early alpha package format and APIs
- Readonly packages; editing OSM data is not supported
- Labels are available in the OpenLayers path but are still limited
- PMTiles export is supported; MBTiles export is not
- Cesium export is focused on extruded buildings and flat cartographic context layers
- 3D Tiles labels, terrain clamping, advanced metadata, and regional LOD optimization are still future work
- The built-in viewers still load OpenLayers/Cesium from public CDNs, although map data and PMTiles dependencies are local

## License

MIT
