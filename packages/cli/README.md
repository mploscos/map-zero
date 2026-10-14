# @map-zero/cli

Build portable GeoPackage, PMTiles and static 3D Tiles datasets from OpenStreetMap
or application-defined geospatial data.

```bash
npm install --global @map-zero/cli
map-zero --help
```

The CLI requires Node.js 24.2 or newer and uses Node's built-in SQLite. It does
not install OpenLayers or Cesium. Renderer integrations are published separately
as `@map-zero/ol` and `@map-zero/cesium`.

See the [main repository](https://github.com/mploscos/map-zero) for usage,
architecture and custom-data documentation.
