import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('0.7 packages keep CLI, Core and renderer dependency boundaries explicit', async () => {
  const [root, cli, core, ol, cesium, lock] = await Promise.all([
    readJson('../package.json'),
    readJson('../packages/cli/package.json'),
    readJson('../packages/core/package.json'),
    readJson('../packages/ol/package.json'),
    readJson('../packages/cesium/package.json'),
    readJson('../package-lock.json')
  ]);

  assert.equal(root.private, true);
  assert.deepEqual(root.workspaces, ['packages/*']);
  assert.deepEqual([cli.version, core.version, ol.version, cesium.version], Array(4).fill('0.7.0'));

  assert.equal(cli.dependencies['@map-zero/core'], '^0.7.0');
  assert.equal(cli.dependencies.ol, undefined);
  assert.equal(cli.dependencies.cesium, undefined);
  assert.equal(cli.exports['./ol'], undefined);
  assert.ok(!cli.files.includes('packages'));

  assert.equal(ol.dependencies['@map-zero/core'], '^0.7.0');
  assert.equal(ol.peerDependencies.ol, '^10.10.0');
  assert.equal(cesium.dependencies['@map-zero/core'], '^0.7.0');
  assert.equal(cesium.peerDependencies.cesium, '^1.145.0');

  assert.equal(lock.packages['node_modules/better-sqlite3'], undefined);
  assert.deepEqual(
    Object.entries(lock.packages).filter(([, pkg]) => pkg.hasInstallScript).map(([path]) => path),
    []
  );
});
