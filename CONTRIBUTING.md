# Contributing

`map-zero` is an early alpha project. Contributions should keep the package format and CLI behavior stable unless a change is explicitly discussed.

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run check
```

## Guidelines

- Keep core behavior stable.
- Prefer small, focused changes.
- Do not commit generated packages, GeoPackages, PMTiles, 3D Tiles, or OSM PBF extracts.
- Put detailed user documentation in `docs/`; keep `README.md` concise.
- Keep styles external and declarative.
