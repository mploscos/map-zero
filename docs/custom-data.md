# Custom geospatial data

map-zero accepts application-defined layers through its public JavaScript API.
Define schemas and features in your application or source adapter, write a
GeoPackage, then describe its layers in `manifest.json` and export PMTiles.
You do not need to edit map-zero or register layers in `LAYER_DEFINITIONS`.
Those definitions belong to the OSM adapter.

Install the published package with Node.js 22 or newer:

```bash
npm install map-zero
```

## Where definitions live

| Definition | Where it belongs | Purpose |
| --- | --- | --- |
| Storage schema | Your code, passed to `map-zero/gpkg` | Creates SQL tables, geometry declarations and property columns |
| Features | Your adapter, passed to the writer | Supplies EPSG:4326 geometries and typed properties |
| Layer descriptors | `manifest.json`, created with `map-zero/manifest` | Maps public layer IDs to tables and defines visibility and tile properties |
| Rendering style | Your viewer/application | Defines the appearance of custom layers |

The storage descriptor's `id` is the physical table name. The manifest's `id`
is the public name used by MVT source layers, PMTiles metadata, queries and
viewer controls. Its `table` points to the storage name and defaults to `id`.
The example deliberately uses different names to show this distinction.

## Complete example

Save this as `build-survey.mjs` and run `node build-survey.mjs`. It creates
`survey.mapzero/data.gpkg`, `manifest.json` and one `tiles.pmtiles` archive.

```js
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openGeoPackageWriter } from 'map-zero/gpkg';
import { openGeoPackageReader } from 'map-zero/gpkg-read';
import { createManifest } from 'map-zero/manifest';
import { exportPmtiles } from 'map-zero/export-pmtiles';

const packageDir = './survey.mapzero';
const bbox = [-3.71, 40.41, -3.69, 40.43]; // west, south, east, north
await mkdir(packageDir, { recursive: true });

const schema = {
  id: 'survey_points',
  geometryType: 'POINT',
  columns: {
    id: 'TEXT', name: 'TEXT', elevationM: 'REAL', quality: 'INTEGER',
    first_zoom: 'INTEGER', last_zoom: 'INTEGER'
  }
};
const writer = openGeoPackageWriter(join(packageDir, 'data.gpkg'), [schema], bbox, {
  lastChange: '2026-01-01T00:00:00.000Z'
});
try {
  writer.transaction(() => {
    writer.insertFeature(schema.id, {
      geometry: { type: 'Point', coordinates: [-3.703, 40.417] },
      properties: {
        id: 'station-a', name: 'Station A', elevationM: 651.5, quality: 2,
        first_zoom: 6, last_zoom: 10
      }
    });
    writer.insertFeature(schema.id, {
      geometry: { type: 'Point', coordinates: [-3.700, 40.420] },
      properties: {
        id: 'station-b', name: 'Station B', elevationM: 655.25, quality: 3,
        first_zoom: 9, last_zoom: 14
      }
    });
  });
  console.log(writer.counts()); // { survey_points: 2 }
} finally {
  writer.close();
}

const manifest = {
  ...createManifest({
    outDir: packageDir, bbox,
    layers: [{
      id: 'observations', table: schema.id, geometryType: schema.geometryType,
      minZoom: 4, maxZoom: 14, source: 'survey',
      featureZoom: { minColumn: 'first_zoom', maxColumn: 'last_zoom' },
      tileProperties: ['id', 'name', 'elevationM', 'quality']
    }]
  }),
  // createManifest supplies OSM style URLs by default. This dataset has no
  // bundled style files; the consuming application supplies its own style.
  styles: {}
};
await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const reader = openGeoPackageReader({ gpkgPath: join(packageDir, 'data.gpkg'), manifest });
try {
  console.log(reader.getTileFeatures('observations', bbox, { zoom: 8 })
    .map(feature => feature.properties.id)); // ['station-a']
  console.log(reader.getLayerStats()); // counts and RTree verification
} finally {
  reader.close();
}

const result = await exportPmtiles({ packageDir, minZoom: 4, maxZoom: 14, workers: 1 });
console.log(result.outPath, result.writtenTiles, result.outputBytes);
```

The manifest remains format `mapzero`, version `1`; package version `0.5.0`
is a separate concept. The exporter updates the manifest's `tiles` entry.
It reads features from the closed GeoPackage, without needing the original
feature objects. Subsequent exports can use the CLI:

```bash
npx map-zero pmtiles ./survey.mapzero --min-zoom 4 --max-zoom 14
```

## Storage and feature contract

- Schema `geometryType`: `POINT`, `LINESTRING`, `MULTILINESTRING`, `POLYGON`,
  `MULTIPOLYGON`, or `GEOMETRY` for mixed tables. Feature geometry names use
  GeoJSON casing, such as `Point` or `MultiPolygon`.
- Coordinates: EPSG:4326 longitude/latitude in degrees, XY only. Convert other
  coordinate systems in your adapter. Supply valid geometries and a dataset
  bbox enclosing them. An optional feature `bbox` must also enclose its geometry.
- Columns: `TEXT`, `INTEGER`, `REAL`. Pass strings, integers and finite numbers
  respectively; missing/null properties become SQL NULL. SQLite affinity is
  not strict application-level type validation. Undeclared properties are not
  stored. Encode nested values intentionally as JSON TEXT if needed; convert
  booleans to an integer or string representation.
- The writer creates `fid` and `geom`; these and SQLite rowid aliases are reserved.
  Table names cannot start with `gpkg_`, `sqlite_` or `rtree_`.
- Deduplication uses `feature.properties.id` per table for the open writer's
  lifetime. Declare an `id` column to persist it. Non-empty IDs, including numeric
  zero, are deduplicated; top-level GeoJSON `feature.id` is not used for this.
- Opening the writer replaces the output file. Incremental insertion means
  batches within one open session, not reopening an existing file for append.
  Close it before reading/exporting so RTree registration is complete.
- `transaction(fn)` batches writes; `counts()` reports inserts. Abort the build
  after a failed transaction: in-memory IDs/counts are not restored on rollback.
- For small in-memory datasets, `writeGeoPackage(path, featuresByLayer, schemas,
  bbox, options)` is also exported; key `featuresByLayer` by storage schema ID.

The writer does not load source formats, infer schemas or reproject coordinates.
A fixed `lastChange`, stable input order and the same SQLite/software environment
allow reproducible GeoPackage generation.

## Manifest descriptor fields

| Field | Meaning |
| --- | --- |
| `id` | Required public layer name; unique within the manifest |
| `table` | GeoPackage table; defaults to `id` |
| `geometryType` | Optional geometry hint; the GeoPackage reader uses actual database metadata |
| `minZoom`, `maxZoom` | Optional inclusive layer range; omitted endpoints are unbounded |
| `source` | Optional descriptive string; does not select an importer or fetch a URL |
| `featureZoom` | Optional `{ minColumn, maxColumn }` mapping to INTEGER columns; either endpoint may be omitted |
| `tileProperties` | Optional array selecting properties for MVT/PMTiles; other properties remain in GeoPackage |

`id`, `mapzero_geometry` and mapped feature-zoom columns are retained in tiles
when `tileProperties` is supplied. Without a selection, generic layers retain
their scalar properties. PMTiles is a clipped/generalized delivery format;
GeoPackage remains the full spatial source.

`resolveManifestLayers(manifest)` normalizes descriptors and string entries.
For example, `'roads'` resolves to `{ id: 'roads', table: 'roads' }`. Existing
version 1 manifests and mixed arrays remain supported.

## Visibility and cartography

Layer ranges provide coarse visibility and PMTiles vector-layer metadata.
Feature ranges further restrict each row; NULL endpoints are unbounded and
comparisons are inclusive. In the example, Station A is visible at z6..10 and
Station B at z9..14, inside the layer's declared z4..14 range. Feature bounds
are applied in SQL before geometry decoding and during sparse tile planning.
Supply aggregate layer bounds yourself; the exporter does not derive them
from feature values.

Pass the archive's requested min/max zoom explicitly: exporter defaults are
z8..16. Export zooms are integers in 0..22; descriptors can express finite,
non-negative fractional bounds for viewer visibility.

Unknown layer IDs use the generic MVT policy. The standard exporter retains
OSM policies for known OSM IDs, including roads/buildings/POI filters and labels.
Use your own public IDs for unrelated datasets. Source metadata does not override
that policy selection. Generic geometry simplification and resource budgets
still apply; a visible feature is not guaranteed to occupy every intersecting tile.

For a custom OpenLayers application, use `createPmtilesVectorSource` from
`map-zero/ol/pmtiles` and supply your own styles. The source supports URLs and
local File/Blob archives. Use `withFeatureZoomVisibility` and invalidate styles
on view resolution changes to enforce feature visibility during overzoom; see
[OpenLayers PMTiles integration](../packages/ol/README.md#custom-pmtiles-cartography).

The same GeoPackage can also produce static Cesium context with `map-zero 3dtiles`.
See [Cesium](cesium.md) for geometry strategies, feature metadata and labels, and
[Architecture](architecture.md) for tile planning limits.
