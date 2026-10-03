# @map-zero/core

Shared layer descriptors, zoom visibility, styles, label selection and bounded caches for OpenLayers and Cesium integrations. No renderer dependencies.

```js
import { resolveManifestLayers, isLayerInZoomRange, isFeatureInZoomRange } from '@map-zero/core/manifest.js';

const layers = resolveManifestLayers({
  layers: [{ id: 'observations', table: 'survey_points', minZoom: 4, maxZoom: 14 }]
});
```

See the [custom data guide](https://github.com/mploscos/map-zero/blob/main/docs/custom-data.md) for storage schemas, manifest descriptors and a complete GeoPackage/PMTiles example. The Node writer and exporter are provided by the `map-zero` package.

Application-facing AIP catalogs use the renderer-independent core contract:

```js
import {
  AIP_AIRPORT_CATALOG_FORMAT,
  createAipAirportCatalog
} from '@map-zero/core/aip.js';
```

The builder can feed it raw OSM AIP features or normalized `airports` and
`runways` features from sources such as ARINC 424. Applications consume the
generated JSON as an ordinary static resource; Core does not require or own a
runtime map server.
