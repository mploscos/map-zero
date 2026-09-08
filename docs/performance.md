# Performance and resource use

Map size, source density, exported zoom range and device capability affect build
and render times. Start with a small area and increase coverage after inspecting
its output.

## Export

PMTiles uses sparse RTree planning, skips empty tiles and reports candidate,
encoded and written tile counts. Higher maximum zooms increase storage and work.
The 3D exporter reuses the cartographic source selection for vector context;
buildings are exported as separate meshes. No MVT files are produced for Cesium.

## Viewer

The Cesium integration defaults to no terrain clamping. Enabling
`clampToTerrain` adds projection and rendering work. Use request-render mode to
avoid continual redraws while idle. Limit labels with `maxLabels` and use layer
controls to hide data you do not need.

Native vector GLBs preserve source metadata for styling and inspection, which
can be a substantial part of their size. Static hosting benefits from HTTP
compression and caching. Tile cache settings are per unique tileset; see the
[Cesium 1.145 limitations](cesium-format.md) before relying on automatic vector
memory accounting.

The main README recordings show the current product. Historical experimental
screenshots and benchmark outputs are not shipped. The
[technical note](cesium-format.md) retains the measured findings that informed
the current default, with their scope and limitations.
