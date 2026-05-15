# Examples

Examples are intentionally lightweight for now. The fastest way to try `map-zero` is to build a local package from an OSM PBF extract:

```bash
node src/cli.js build ./data/madrid.osm.pbf --out ./madrid.mapzero
node src/cli.js serve ./madrid.mapzero --port 8080 --open
```

Generated `.mapzero` packages are ignored by Git.
