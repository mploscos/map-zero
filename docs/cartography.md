# Cartography

`map-zero` currently ships with tactical/neon-oriented styles. The defaults prioritize infrastructure and operational context over consumer map content.

## Roads

Road styling uses `highway=*` plus related properties such as `bridge`, `tunnel`, `layer`, `service`, and `access`.

The default 2D style uses:

- mostly uniform road widths
- opaque casing/body strokes
- hierarchy through color, brightness, min zoom, and subtle casing differences
- limited major road labels

This keeps roads visually connected without topology merging.

## Terrain Edges

Terrain context is intentionally sparse and supports infrastructure readability rather than becoming a full terrain map.

- `coastline`: OSM `natural=coastline`, drawn as a thin cyan shoreline without labels.
- `terrain`: OSM `natural=beach` and `natural=sand`, drawn as low-opacity amber/gray fills to separate land and sea subtly.
- `cliffs`: OSM `natural=cliff`, drawn as a thin gray/cyan line for sharper coastal or terrain definition.

These overlays are included in GeoPackage, dynamic MVT, PMTiles and OpenLayers. Cesium receives them as buffered surfaces in static 3D Tiles.

## Labels

OpenLayers labels are optional and sparse by default:

- major road refs
- AIP/aeronautical names/refs
- selected operational POIs

Local street labels are disabled by default. Labels are filtered to avoid raw OSM taxonomy values such as `yes`, `generator`, `tower`, `pharmacy`, or `fuel` appearing as text.

## POI Categories

The default presets treat POIs as operational infrastructure rather than a consumer city guide.

Visible categories include:

- `transport`: rail, subway, bus, ferry, airport, fuel/charging infrastructure
- `emergency`: hospitals, clinics, police, fire stations, shelters
- `government`: town halls, courts, prisons, embassies, government offices
- `energy`: power plants, substations, generators, towers, transformers, lines
- `communications`: communications towers, masts, antennas, radar-style infrastructure
- `protected`: protected areas, nature reserves, national parks
- `industrial`: industrial, logistics, refinery, depot, storage infrastructure
- `military`: military-tagged sites, bunkers, barracks, checkpoints, airbases, naval bases

Hidden by default:

- restaurants, cafes, bars, pubs
- shops and generic commercial POIs
- hotels, attractions, generic tourism
- generic leisure and entertainment

Dynamic MVT serving applies POI category filtering before encoding. PMTiles exports use the same rules.

## AIP / Aeronautical Data

The `aip` layer extracts OSM `aeroway=*` nodes, ways, and simple polygon relations. It preserves:

- `id`
- `name`
- `aeroway`
- `ref`
- `surface`
- `width`
- `length`

Runways, taxiways, aprons, terminals, aerodromes, launchpads, and helipads are represented when present in OSM. Some OSM data lacks physical width tags; 3D export uses class-based fallback widths in those cases.

Dense operational point classes such as navigation aids, gates, thresholds, windsocks, and towers are hidden by default in the 2D style to avoid clutter.

`aviation` is still accepted as a compatibility alias for older packages and commands. The public layer name is now `aip`, which leaves room to merge richer aeronautical sources such as ARINC424-derived data into the same domain later.

## Boundaries

Boundary styling uses `admin_level` where available:

- national and regional boundaries are stronger
- local boundaries are subtle

In Cesium, boundaries are exported as flat contour surfaces rather than filled administrative polygons.
