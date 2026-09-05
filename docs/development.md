# Development

Use Node 22+ for the repository and Cesium integration.

```bash
git clone https://github.com/mploscos/map-zero.git
cd map-zero
npm ci
npm run check
npm test
```

Run the local CLI with `node src/cli.js`. For example:

```bash
node src/cli.js bbox-ui --output-root ./generated
node src/cli.js serve ./generated/madrid.mapzero --port 8080
```

Browser checks require Chromium and a generated demo package. Set `CHROMIUM_PATH` when needed:

```bash
npm run test:browser -- generated/readme-demo.mapzero
```

See [recording instructions](media/README.md) to reproduce the README GIFs, [architecture](architecture.md) for the module layout, and [performance](performance.md) for measured behavior and remaining work.

The npm packages are `map-zero`, `@map-zero/core`, `@map-zero/ol`, and `@map-zero/cesium`. Publish the shared core before the integration packages, which depend on the matching core version. The root CLI includes its own browser integration sources.
