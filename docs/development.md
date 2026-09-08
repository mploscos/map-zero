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
node src/cli.js 3dtiles generated/madrid.mapzero
npm run test:browser -- generated/madrid.mapzero
npm run test:browser:static -- generated/madrid.mapzero
```

See [recording instructions](media/README.md) to reproduce the README GIFs, [architecture](architecture.md) for the module layout, and [performance](performance.md) for measured behavior and remaining work.

The npm packages are `map-zero`, `@map-zero/core`, `@map-zero/ol`, and `@map-zero/cesium`. Publish the shared core before the integration packages, which depend on the matching core version. The root CLI includes its own browser integration sources.

## Cesium validation

Run `npm test`, `npm run check`, `npm run test:browser` and
`npm run test:browser:static`. Browser checks use a normally exported Madrid
package (`generated/bbox.mapzero` by default); an alternate package path may be
passed to either script. Current GIF recording instructions are in
[media/README.md](media/README.md). See [format notes](cesium-format.md) for
runtime compatibility checks required when upgrading Cesium.
