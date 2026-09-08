# Migrating to 0.4.0

Remove `renderMode`, `contextRenderMode`, `workerUrl` and raster tuning options. `@map-zero/core` replaces `@map-zero/raster` as the shared integration dependency. OpenLayers continues to read PMTiles directly; Cesium context requires an XYZ MVT URL.

Re-export existing PMTiles to include stable label anchors for Cesium (no OSM import or 3D Tiles rebuild is needed):

```bash
map-zero pmtiles ./madrid.mapzero --minzoom 8 --maxzoom 16
map-zero serve ./madrid.mapzero --port 8080
# Open http://localhost:8080/cesium
```

Cesium labels are enabled by default. Use the viewer’s **labels** checkbox, `controller.setLabelsVisible(false)`, or `{ labels: false, maxLabels: 150 }` in your integration. [Label behavior and options](cesium.md#labels).

The Cesium integration requires Cesium 1.145.0 and Node 22+ in consuming build environments. The core CLI supports Node 20+. See [Cesium integration](cesium.md) for the current static 3D Tiles API and hosting requirements.
