# AIP airport and runway catalogs

The `aip` layer is both cartographic data and the source for a small,
application-facing airport catalog. When an OSM build includes `aip`, map-zero
automatically writes `aip/airports.json` and declares it in `manifest.json`:

```json
{
  "aip": {
    "airports": {
      "format": "mapzero-aip-airports",
      "version": 1,
      "url": "aip/airports.json"
    }
  }
}
```

The bbox builder can write a standalone `airports.json`: choose **Airport
catalog** as the output type, draw the region and generate the file. The local
builder can be closed afterwards; applications load the JSON as one of their
own static resources and require no map-zero server.

The equivalent non-interactive command is:

```bash
map-zero airports \
  --bbox=-4.2,40.1,-3.3,40.7 \
  --out ./airports.json
```

For discontinuous coverage, select the Geofabrik extracts explicitly. For
example, mainland Spain and its islands are split between two extracts:

```bash
map-zero airports \
  --bbox=-18.3,27.5,4.5,43.9 \
  --extracts=spain,canary-islands \
  --out ./airports.json
```

Run `map-zero extracts --bbox=<west,south,east,north>` to discover the IDs for
another area; no download of the PBF extracts is performed by that command.

Map packages that include the `aip` layer still contain the same catalog. It
can be regenerated from an existing package with:

```bash
map-zero aip-airports ./madrid.mapzero
```

## Catalog contract

The catalog groups directional runway thresholds under their airport. Runway
designators and true headings are separate values: a designator such as `32R`
is not a 32-degree heading.

```json
{
  "format": "mapzero-aip-airports",
  "version": 1,
  "bbox": [-3.61, 40.44, -3.51, 40.55],
  "source": {
    "type": "osm",
    "name": "OpenStreetMap",
    "attribution": "© OpenStreetMap contributors",
    "license": "ODbL-1.0"
  },
  "summary": {
    "airports": 1,
    "physicalRunways": 4,
    "runwayDirections": 8,
    "mappedThresholds": 8,
    "estimatedThresholds": 0,
    "unresolvedRunways": 0
  },
  "airports": [{
    "id": "LEMD",
    "name": "Aeropuerto Adolfo Suárez Madrid-Barajas",
    "icao": "LEMD",
    "iata": "MAD",
    "longitude": -3.55064582,
    "latitude": 40.4655042,
    "altitudeM": 610,
    "runways": [{
      "id": "14L",
      "name": "Runway 14L",
      "designator": "14L",
      "physicalRunway": "14L/32R",
      "headingTrueDeg": 142.33,
      "threshold": {
        "longitude": -3.5578341,
        "latitude": 40.4948859,
        "altitudeM": 610,
        "elevationSource": "airport"
      },
      "quality": "mapped-threshold"
    }]
  }]
}
```

`mapped-threshold` means that the horizontal threshold comes from an explicit
source feature. `estimated` means that map-zero used the corresponding runway
line endpoint. `threshold.elevationSource` distinguishes threshold, runway,
airport fallback and normalized source elevations.

The OSM adapter preserves `icao`, `iata` and `ele`, pairs
`aeroway=threshold` points with referenced `aeroway=runway` lines, and computes
the true WGS84 bearing between opposite thresholds. Airports without usable
runway directions are omitted from this application catalog but remain in the
renderable AIP layer.

## Other aviation sources

The catalog builder is not tied to OSM. `createAipAirportCatalog` is public from
`@map-zero/core/aip.js`; it is browser-safe and has no renderer or Node
dependencies. GeoPackage reading and artifact writing remain responsibilities
of the map-zero build tool. A map-zero GeoPackage may provide separate
normalized layers instead of the raw `aip` layer:

- `airports`: Point features with `id`, `ident` or `icao`, optional `name` and
  `elevationM`.
- `runways`: directional Point features with `id`, `airportId`,
  `runwayDesignator`, `headingDeg` and optional `elevationM`.

This boundary lets an ARINC 424 adapter own parsing and semantic extraction
while map-zero owns GeoPackage storage, catalogs, PMTiles, 3D Tiles and browser
rendering. It does not require map-zero to parse ARINC records or the ARINC
adapter to implement another rendering engine.

Airport data generated from community or third-party sources is intended for
simulation, visualization and analysis. It is not certified navigation data.
