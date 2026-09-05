<div align="center">

# map-zero

### Your map. Your data. Anywhere.

**Draw an area. Build your map. Explore it in 2D and 3D.**

![Version 0.4.0](https://img.shields.io/badge/version-0.4.0-48d6bd)
[![npm](https://img.shields.io/npm/v/map-zero)](https://www.npmjs.com/package/map-zero)
[![MIT license](https://img.shields.io/badge/license-MIT-a9bbc9)](LICENSE)

[Get started](#quick-start) · [See it in action](#see-it-in-action) · [Documentation](#documentation)

</div>

Turn a selected area or a local OpenStreetMap extract into a portable map package. Keep your data on your own machine, share it as a ZIP, or serve it from your infrastructure. Explore the same map in **2D with OpenLayers** and **3D with Cesium**, without map API keys.

> **New in 0.4.0:** native vector maps and labels in Cesium, smaller exported files, and lower rendering activity while the 3D view is idle. [Release notes](CHANGELOG.md) · [Upgrading from 0.3.x](docs/migration-0.4.0.md)

## Quick Start

Use Node.js 22 or newer. Install the CLI and open the map builder:

```bash
npm install --global map-zero
map-zero bbox-ui --output-root ./generated
```

1. Open **http://127.0.0.1:8090**.
2. Click **Draw bbox** and mark your area, or paste its coordinates.
3. Name the output `madrid.mapzero`, choose layers and formats, then click **Build map-zero**.

The builder downloads suitable OpenStreetMap data, reuses cached downloads when available, and shows progress as it creates your package. Start with a small area; larger extracts and higher zoom levels take longer.

When the build finishes, open your map:

```bash
map-zero serve ./generated/madrid.mapzero --port 8080
```

- **2D:** http://127.0.0.1:8080
- **3D:** http://127.0.0.1:8080/cesium

Keep **3D Tiles** enabled when building to include extruded buildings in the 3D view. Generated files stay under the output directory you selected.

## See it in action

### 01 · Draw an area and build

Select your area **directly on a map** with `bbox-ui`: draw a rectangle, adjust its corners, choose layers and outputs, then click **Build map-zero**. The builder finds suitable OpenStreetMap extracts and generates your package locally, including PMTiles, 3D Tiles and a ZIP.

![The real bbox builder: drawing a rectangle over Madrid and choosing the package name and outputs](docs/media/bbox-builder.gif)

```bash
npx map-zero@0.4.0 bbox-ui --output-root ./generated
```

Open **http://127.0.0.1:8090**. You can also paste coordinates into the bbox field. The animation shows area selection and output configuration; build progress appears in the UI after submitting the job.

<details>
<summary>See the generation pipeline in the terminal</summary>

This animation replays **real CLI output**, with time compressed, from a local OSM extract through GeoPackage, PMTiles and 3D Tiles.

![Actual map-zero generation log, from local Madrid OSM data through GeoPackage, PMTiles and 3D Tiles](docs/media/generate.gif)

</details>

### 02 · Explore in 2D

Pan, zoom and style vector data in OpenLayers. Use layer controls, zoom and labels to explore your area.

![OpenLayers displaying the generated Madrid map with animated zoom and rotation](docs/media/openlayers-2d.gif)

### 03 · Discover in 3D

Explore the same area in 3D, with buildings, map features and labels.

![Cesium 1.145 orbiting Madrid with vector maps, labels and generated 3D buildings](docs/media/cesium-3d.gif)

*Real viewer captures using local OpenStreetMap data, © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). [Recording instructions and static previews](docs/media/README.md).*

## What You Get

One `.mapzero` folder contains your map data, styles and selected exports:

```mermaid
flowchart TD
    AREA["Draw an area<br/>or choose an OSM file"] --> BUILD["map-zero"]
    subgraph PACKAGE["Your portable map package"]
        DATA[("GeoPackage<br/>Source data")]
        VECTOR[("PMTiles<br/>Vector map")]
        BUILDINGS["3D Tiles<br/>Buildings"]
        DATA --> VECTOR
        DATA --> BUILDINGS
    end
    BUILD --> DATA
    VECTOR --> MAP2D["Explore in 2D<br/>OpenLayers"]
    VECTOR --> MAP3D["Explore in 3D<br/>Cesium"]
    BUILDINGS --> MAP3D
    classDef source fill:#132b38,stroke:#68a4ff,color:#eef7ff
    classDef build fill:#163d37,stroke:#48d6bd,color:#e8fff9
    classDef data fill:#172536,stroke:#7898b8,color:#edf4fc
    classDef viewer fill:#29203d,stroke:#b39aef,color:#f4efff
    class AREA source
    class BUILD build
    class DATA,VECTOR,BUILDINGS data
    class MAP2D,MAP3D viewer
```

| File or folder | What it gives you |
| --- | --- |
| `data.gpkg` | Source features in a standard GeoPackage |
| `tiles.pmtiles` | A single vector tile archive for your map |
| `3dtiles/` | Building geometry for 3D viewing |
| `styles/` | Map colors and appearance |
| `manifest.json` | Information connecting the package contents |

PMTiles and 3D Tiles are optional outputs. The optional ZIP contains the map assets; select **GPKG in ZIP** if you also want the source GeoPackage included.

Layers include roads, buildings, water, land use, railways, boundaries, points of interest, terrain outlines, coastlines, cliffs and aviation features. Availability depends on OpenStreetMap coverage in your chosen area.

## Other Ways to Build

Already know the coordinates? Build directly from a bounding box:

```bash
map-zero from-bbox --bbox -3.710,40.413,-3.696,40.422 --out ./madrid.mapzero
```

Already have an OSM file? Build locally, then export the map and buildings:

```bash
map-zero build ./area.osm.pbf --out ./area.mapzero
map-zero pmtiles ./area.mapzero
map-zero 3dtiles ./area.mapzero
```

[More CLI workflows and export options](docs/usage.md).

## Customize and Share

Change the map appearance with a bundled theme:

```bash
map-zero style ./madrid.mapzero --theme neon-dark
```

Share a portable ZIP, including the source data:

```bash
map-zero package ./madrid.mapzero --include-gpkg
```

You can also integrate packages into your own application using **[@map-zero/ol](docs/openlayers.md)** or **[@map-zero/cesium](docs/cesium.md)**. The integration guides cover installation, supported versions, hosting and examples.

## Before You Start

- This is an early alpha; package formats and integration APIs may change between releases.
- The tools create readonly maps. Editing OpenStreetMap data is outside their scope.
- The bbox builder needs internet access for its background map and new source downloads. The bundled viewers currently load their libraries from CDNs; fully offline applications must host those dependencies locally too.
- Large areas require more time, disk space and memory. Building heights depend on available OpenStreetMap attributes, with estimated heights where necessary.
- Upgrading an existing package? [Re-export its PMTiles to enable Cesium labels](docs/migration-0.4.0.md).

## Documentation

| I want to… | Guide |
| --- | --- |
| Build, export or package maps from the terminal | [CLI workflows](docs/usage.md) |
| Change colors, labels and visible features | [Styles and themes](docs/styles.md) · [Cartography](docs/cartography.md) |
| Add a map to my application | [OpenLayers](docs/openlayers.md) · [Cesium](docs/cesium.md) |
| Upgrade an existing installation | [Migration to 0.4.0](docs/migration-0.4.0.md) |
| Use the local server API | [HTTP API](docs/api.md) |
| Understand performance and technical limits | [Performance review](docs/performance.md) |
| Work on the project | [Development](docs/development.md) · [Architecture](docs/architecture.md) |

## License

[MIT](LICENSE). Map data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
