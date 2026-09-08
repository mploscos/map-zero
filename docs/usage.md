# Command-line workflows

Install with `npm install --global map-zero`. The commands below assume you are using the published CLI.

The source-building commands (`build`, `from-bbox`, `bbox-ui`) import OSM. To define other datasets, use the [custom data JavaScript API](custom-data.md), then run `map-zero pmtiles ./dataset.mapzero --min-zoom 4 --max-zoom 14` to export their GeoPackage.

## CLI Workflows

### Build from a bbox

Use the non-interactive equivalent of the bbox UI when the area is already known:

```bash
map-zero from-bbox \
  --bbox -3.9,40.3,-3.5,40.6 \
  --out ./madrid.mapzero
```

This runs the same pipeline as `bbox-ui`. By default it exports PMTiles at zooms 8-16, 3D Tiles, and `madrid.mapzero.zip`. Use `--no-pmtiles`, `--no-3dtiles`, or `--no-zip` to omit an output; use `--include-gpkg` to retain the source GeoPackage in the ZIP.

### Build from a local PBF

Use `build` when an `.osm.pbf` extract is already available:

```bash
map-zero build ./data/madrid.osm.pbf \
  --out ./madrid.mapzero
```

`build` infers the PBF extent and extracts all supported layers. Crop a larger input with `--bbox`:

```bash
map-zero build ./data/spain.osm.pbf \
  --bbox -3.9,40.3,-3.5,40.6 \
  --out ./madrid.mapzero
```

### Preview and dynamic MVT

```bash
map-zero serve ./madrid.mapzero --port 8080 --open
```

`serve` provides a local OpenLayers viewer, a Cesium viewer at `/cesium`, and a readonly HTTP API. It also generates MVT dynamically from `data.gpkg` when PMTiles are absent. It is useful for local inspection, but not required to deploy exported PMTiles or 3D Tiles.

### Export or update assets

```bash
# Static vector tiles
map-zero pmtiles ./madrid.mapzero --minzoom 8 --maxzoom 16

# Cesium-ready 3D Tiles
map-zero 3dtiles ./madrid.mapzero

# Portable ZIP; data.gpkg is excluded unless requested
map-zero package ./madrid.mapzero --include-gpkg

# Write a bundled full preset or compact theme
map-zero style ./madrid.mapzero --preset neon-dark
map-zero style ./madrid.mapzero --theme neon-dark
```

For larger regional PMTiles exports, lower the maximum zoom or use more workers:

```bash
map-zero pmtiles ./andalucia.mapzero --minzoom 8 --maxzoom 12 --workers 4
```

## Package Structure

The base `build` command writes `data.gpkg`, `manifest.json`, and the default style. Additional commands update the manifest as they add static assets:

| Path inside `madrid.mapzero/` | Contents | Created by |
| --- | --- | --- |
| `data.gpkg` | Source features in GeoPackage format | `build` |
| `manifest.json` | Layers, bounds, styles and tile asset locations | `build`; updated by exports |
| `styles/neon-dark.json` | Default cartographic style | `build` |
| `tiles.pmtiles` | Vector tiles for 2D and native 3D context | `pmtiles` |
| `3dtiles/<layer>/tileset.json` | Spatial hierarchy and tile references per layer | `3dtiles` |
| `3dtiles/` | Vector GLBs and extruded meshes with feature/label metadata | `3dtiles` |

`bbox-ui` and `from-bbox` run these stages together for the selected outputs.

`package` writes `madrid.mapzero.zip` beside the folder. The archive includes the manifest, referenced styles, PMTiles, and 3D Tiles; it excludes `data.gpkg` by default because static OpenLayers and Cesium consumers do not need it.

PMTiles is a single static file served with HTTP range requests. It can be deployed to static hosting, object storage, nginx, or a CDN that supports range requests. 3D Tiles are likewise static files that Cesium can load from a normal web server.


## Styles And Themes

Styles are JSON files outside the GeoPackage, allowing the same data to be rendered differently without rebuilding source data or PMTiles. Use a bundled full preset with `--preset`, or a compact theme with `--theme`.

```bash
map-zero style ./madrid.mapzero --preset neon-dark
map-zero style ./madrid.mapzero --theme neon-dark
```

Most users should edit compact theme JSON rather than full renderer-ready style presets. See [styles and themes](styles.md) and [cartography and POIs](cartography.md).


Run `map-zero --help` or `map-zero <command> --help` for all options.

Vector context zoom coverage can be selected with `3dtiles --min-zoom 8 --max-zoom 16`.
For conventional mesh context use `--context-format mesh`. See the
[Cesium guide](cesium.md) for hosting and terrain options.
