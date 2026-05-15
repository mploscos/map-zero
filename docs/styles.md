# Styles And Themes

Styles are external JSON documents. They are intentionally stored outside `data.gpkg` so the same package data can be rendered by OpenLayers, Cesium, or other clients.

There are three style-related concepts:

- **Full preset**: renderer-ready JSON under `styles/presets/`.
- **Compact theme**: small user-editable JSON under `styles/themes/`.
- **Package style**: generated or copied JSON inside `package.mapzero/styles/`, referenced by `manifest.json`.

## Commands

Apply a full preset:

```bash
node src/cli.js style ./madrid.mapzero --preset neon-dark
```

List presets:

```bash
node src/cli.js style ./madrid.mapzero --list-presets
```

Apply a bundled theme:

```bash
node src/cli.js style ./madrid.mapzero --theme neon-dark
```

Apply a local theme file:

```bash
node src/cli.js style ./madrid.mapzero --theme ./my.theme.json
```

## Compact Theme Example

```json
{
  "name": "my-neon",
  "base": "neon-dark",
  "colors": {
    "background": "#03000a",
    "roads": "#4fcfe3",
    "roadsMajor": "#b8f7ff",
    "buildings": "#ff00ff",
    "water": "#0066ff",
    "landuse": "#0f3d2e",
    "labels": "#d9fbff",
    "critical": "#ffcc33"
  },
  "intensity": {
    "roads": 0.9,
    "buildings": 0.8,
    "labels": 0.85
  }
}
```

Most users should start with a compact theme. Full presets are useful when you need detailed control over layer rules.

## Full Style Rules

Layer rules can contain:

- `visibility`: `visible`, `minZoom`, `maxZoom`
- `body`: `color`, `width`, `opacity`, `widthScale`, `lineCap`, `lineJoin`
- `casing`: optional outer stroke
- `center`: optional center stroke
- `glow`: optional outer stroke
- `labels`: top-level label rules
- `bridge`, `tunnel`, `oneway`, `construction`, `restrictedAccess`: road semantic overlays
- `byProperty`: property-specific overrides such as `highway`, `admin_level`, or `aeroway`
- `categories` and `classes`: POI filtering rules

Aeronautical rules live under the `aip` layer key. The OSM property name remains `aeroway`.

Example:

```json
{
  "visibility": { "visible": true, "minZoom": 8, "maxZoom": 22 },
  "body": {
    "color": "#4fcfe3",
    "width": 1.1,
    "opacity": 1,
    "lineCap": "round",
    "lineJoin": "round",
    "widthScale": {
      "stops": [[8, 0.18], [14, 1], [18, 2]]
    }
  },
  "casing": {
    "enabled": true,
    "color": "#063a46",
    "width": 1.9,
    "opacity": 1
  }
}
```

Style-only changes do not require rebuilding `data.gpkg`. Regenerate PMTiles or 3D Tiles only when tile content, filtering, or geometry generation changes.
