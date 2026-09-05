# HTTP API

`map-zero serve` starts a readonly local server for one `.mapzero` package.

```bash
node src/cli.js serve ./madrid.mapzero --port 8080 --open
```

The HTTP API is only required for dynamic GeoPackage-backed serving and local inspection. If you export `tiles.pmtiles` or `3dtiles/`, those artifacts can be served as static files without the map-zero Node server. Native Cesium MVT context additionally requires an XYZ endpoint; the built-in server provides `/api/vector-tiles/{z}/{x}/{y}.mvt`.

## Viewer Routes

```text
GET /
GET /cesium
```

## Package Routes

```text
GET /manifest.json
GET /styles/:name
GET /tiles.pmtiles
GET /3dtiles/:layer/tileset.json
GET /3dtiles/:layer/tiles/:tile.b3dm
```

`tiles.pmtiles` is served with range request support.

## Metadata Routes

```text
GET /api/info
GET /api/layers
```

Examples:

```bash
curl http://127.0.0.1:8080/api/info
curl http://127.0.0.1:8080/api/layers
```

## Dynamic MVT Routes

Combined layers:

```text
GET /api/tiles/:z/:x/:y.mvt?layers=roads,water
```

Single layer:

```text
GET /api/tiles/:layer/:z/:x/:y.mvt
```

Example:

```bash
curl 'http://127.0.0.1:8080/api/tiles/14/8030/6165.mvt?layers=roads,water'
```

The dynamic tile path validates layers against the package manifest and uses the same MVT generation logic as PMTiles export.

`aip` is the canonical aeronautical/AIP layer name. `aviation` remains accepted as a compatibility alias for older packages.

## Bbox Builder

`map-zero bbox-ui` starts a local OpenLayers UI for drawing a WGS84 bbox and
launching a complete `from-bbox` build.

```bash
node src/cli.js bbox-ui --port 8090 --output-root ./generated
```

Routes:

```text
GET /
GET /api/layers
POST /api/jobs
GET /api/jobs/:id
```

`POST /api/jobs` accepts `bbox`, `out`, `layers`, `minZoom`, `maxZoom`,
`pmtiles`, `tiles3d`, `zip`, and `includeGpkg`. Jobs are kept in memory for the
current server process.

## Native Cesium MVT endpoint

`GET /api/vector-tiles/:z/:x/:y.mvt` returns decoded MVT bytes from the package's PMTiles archive. Empty tiles return HTTP 204; invalid XYZ coordinates return HTTP 400. No geometry is regenerated when PMTiles exists. Packages without PMTiles redirect to the existing dynamic MVT endpoint.

This readonly adapter supplies the XYZ URLs required by Cesium 1.145 `MVTDataProvider`, while OpenLayers continues to read the same archive with range requests.
