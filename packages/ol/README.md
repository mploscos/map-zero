# @map-zero/ol

OpenLayers integration helpers for map-zero packages.

See the main repository for documentation, examples, and release notes:

https://github.com/mploscos/map-zero


## Custom PMTiles cartography

`createPmtilesVectorSource({ input, manifest?, idProperty?, onFeatures? })` opens
an HTTP URL, File/Blob or PMTiles range Source. It returns an OpenLayers vector
tile `source`, archive/header/metadata, resolved layers, metrics and `destroy()`.
It shares the MVT tile loader with the standard renderer. Local files use PMTiles
FileSource slices; no complete archive buffer is required. The 256px tile grid
aligns archive z with conventional OpenLayers view z. String IDs come from `id`
by default and remain available as properties as well as `feature.getId()`.

Use `withFeatureZoomVisibility(style, {layers, getZoom})` with `getZoom` reading
the actual map view. Invalidate the layer on `change:resolution` so cached Canvas
replays update during overzoom. This filters the whole style, including labels.
The lightweight subpath is `@map-zero/ol/pmtiles` (or `map-zero/ol/pmtiles` in the
combined package); both helpers are also re-exported from the OL entry point.

New archives store normalized descriptors in `mapzero:layers` metadata, enabling
standalone local-file visibility. Supply a manifest for older archives that lack
these descriptors. Optional `tileProperties` on a descriptor selects rendering
properties while rich fields remain in GeoPackage. ID, geometry classification
and feature-zoom columns are retained automatically.
