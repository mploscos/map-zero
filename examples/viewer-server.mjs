import { promises as fs } from 'node:fs';

import { createMapZeroServer } from '@map-zero/cli/src/server.js';

import { createCesiumViewerHtml, createViewerHtml } from './shared/viewer-templates.js';

/**
 * Compose the data-only CLI server with the optional renderer packages for
 * development, documentation recordings and browser smoke tests.
 *
 * @param {{ packageDir: string }} options
 */
export async function createViewerExampleServer(options) {
  const app = await createMapZeroServer(options);
  const assetVersion = String(Date.now());

  app.get('/openlayers', async (request, reply) => {
    reply.header('cache-control', 'no-store').type('text/html; charset=utf-8')
      .send(createViewerHtml({ assetVersion }));
  });
  app.get('/cesium', async (request, reply) => {
    reply.header('cache-control', 'no-store').type('text/html; charset=utf-8')
      .send(createCesiumViewerHtml({ assetVersion }));
  });

  app.get('/map-zero-ol.js', async (request, reply) => {
    const source = await readPackageSource('ol', 'index.js');
    reply.header('cache-control', 'no-store').type('text/javascript; charset=utf-8')
      .send(rewriteCoreImports(source).replace(
        "from './labels.js';",
        `from './labels.js?v=${encodeURIComponent(assetVersion)}';`
      ));
  });
  for (const name of ['labels.js', 'pmtiles.js']) {
    app.get(`/${name}`, async (request, reply) => {
      const source = await readPackageSource('ol', name);
      reply.header('cache-control', 'no-store').type('text/javascript; charset=utf-8')
        .send(rewriteCoreImports(source));
    });
  }
  app.get('/zoom.js', async (request, reply) => {
    reply.header('cache-control', 'no-store').type('text/javascript; charset=utf-8')
      .send(await readPackageSource('ol', 'zoom.js'));
  });

  for (const [route, name] of [['/map-zero-cesium.js', 'index.js'], ['/static-style.js', 'static-style.js'], ['/cesium-labels.js', 'cesium-labels.js']]) {
    app.get(route, async (request, reply) => {
      const source = rewriteCoreImports(await readPackageSource('cesium', name))
        .replace(/import\s*\{([^}]+)\}\s*from 'cesium';/g, 'const {$1} = globalThis.Cesium;');
      reply.header('cache-control', 'no-store').type('text/javascript; charset=utf-8').send(source);
    });
  }

  for (const [route, directory, allowed] of [
    ['/map-zero-core/:name', '', ['style.js', 'labels.js', 'manifest.js']],
    ['/map-zero-core/shared/:name', 'shared/', ['cache.js', 'layers.js']]
  ]) {
    app.get(route, async (request, reply) => {
      const name = String(request.params.name ?? '');
      if (!allowed.includes(name)) return reply.code(404).send({ error: 'not found' });
      const source = await fs.readFile(new URL(`../packages/core/src/${directory}${name}`, import.meta.url), 'utf8');
      return reply.header('cache-control', 'no-store').type('text/javascript; charset=utf-8').send(source);
    });
  }

  app.get('/vendor/pmtiles.js', async (request, reply) => {
    const source = await fs.readFile(new URL(import.meta.resolve('pmtiles')), 'utf8');
    reply.header('cache-control', 'public, max-age=31536000, immutable')
      .type('text/javascript; charset=utf-8').send(source);
  });
  app.get('/vendor/fflate.js', async (request, reply) => {
    const source = await fs.readFile(new URL('./browser.js', import.meta.resolve('fflate')), 'utf8');
    reply.header('cache-control', 'public, max-age=31536000, immutable')
      .type('text/javascript; charset=utf-8').send(source);
  });

  return app;
}

function readPackageSource(packageName, name) {
  return fs.readFile(new URL(`../packages/${packageName}/src/${name}`, import.meta.url), 'utf8');
}

function rewriteCoreImports(source) {
  return source.replaceAll("from '@map-zero/core/", "from '/map-zero-core/");
}
