# Development

Use Node 24.2+ for the repository. The CLI uses Node's built-in SQLite and has
no native dependency build step.

```bash
git clone https://github.com/mploscos/map-zero.git
cd map-zero
npm ci
npm run check
npm test
```

Run the local CLI through its workspace. For example:

```bash
npm run dev -- --help
node packages/cli/src/cli.js bbox-ui --output-root ./generated
node packages/cli/src/cli.js serve ./generated/madrid.mapzero --port 8080
```

Browser checks require Chromium and a generated demo package. Set `CHROMIUM_PATH` when needed:

```bash
node packages/cli/src/cli.js 3dtiles generated/madrid.mapzero
npm run test:browser -- generated/madrid.mapzero
npm run test:browser:static -- generated/madrid.mapzero
```

See [recording instructions](media/README.md) to reproduce the README GIFs, [architecture](architecture.md) for the module layout, and [performance](performance.md) for measured behavior and remaining work.

The repository root is private. The publishable workspaces are `@map-zero/cli`,
`@map-zero/core`, `@map-zero/ol`, and `@map-zero/cesium`. Publish Core first;
CLI, OL and Cesium depend on its compatible 0.7 release. Viewer composition is
kept under `examples/` and is not included in the CLI package.

```bash
npm publish --workspace @map-zero/core --access public
npm publish --workspace @map-zero/cli --access public
npm publish --workspace @map-zero/ol --access public
npm publish --workspace @map-zero/cesium --access public
```

The packages start aligned at 0.7.0 but can be versioned independently after
this release. Update only the dependants whose declared Core range no longer
accepts a new Core version.

## Cesium validation

Run `npm test`, `npm run check`, `npm run test:browser` and
`npm run test:browser:static`. Browser checks use a normally exported Madrid
package (`generated/bbox.mapzero` by default); an alternate package path may be
passed to either script. Current GIF recording instructions are in
[media/README.md](media/README.md). See [format notes](cesium-format.md) for
runtime compatibility checks required when upgrading Cesium.
