import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createMapZeroServer } from '../src/server.js';

const app = await createMapZeroServer({ packageDir: process.argv[2] ?? 'generated/readme-demo.mapzero' });
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: process.env.SOFTWARE_GL === '1' ? ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--no-sandbox', '--enable-unsafe-swiftshader']
});
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 720 } });
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('server responded with a status of 404')) { console.log('BROWSER ERROR:', message.text()); errors.push(message.text()); } });
  page.on('pageerror', (error) => { console.log('PAGE ERROR:', error.message); errors.push(error.message); });
  page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) errors.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(`${request.url()}: ${request.failure()?.errorText}`);
  });
  const paths = process.argv[3] === '3d' ? ['/cesium'] : ['/?lon=-3.703&lat=40.417&zoom=16', '/cesium'];
  for (const path of paths) {
    await page.goto(url + path, { timeout: 60000 });
    if (path.startsWith('/cesium')) {
      await page.waitForFunction(() => globalThis.mapZeroController && Object.values(mapZeroController.tilesets).every((tileset) => tileset.tilesLoaded), null, { timeout: 60000 });
      await page.waitForFunction(() => mapZeroController.vectorProvider.tileset.tilesLoaded && mapZeroController.vectorProvider.tileset.statistics.numberOfFeaturesLoaded > 0, null, { timeout: 60000 });
      await page.waitForFunction(() => mapZeroController.labelCollection.length > 0, null, { timeout: 30000 });
      console.log('Native labels:', await page.evaluate(() => mapZeroController.labelCollection.length));
      assert.ok(await page.evaluate(() => mapZeroController.labelCollection.length <= 150));
      await page.evaluate(() => mapZeroController.setLabelsVisible(false));
      assert.equal(await page.evaluate(() => mapZeroController.labelCollection.show), false);
      await page.evaluate(() => mapZeroController.setLabelsVisible(true));
      await page.waitForTimeout(3000);
      await page.evaluate(() => {
        globalThis.renderedFrames = 0;
        viewer.scene.postRender.addEventListener(() => renderedFrames++);
      });
      await page.waitForTimeout(1500);
      const frames = await page.evaluate(() => renderedFrames);
      console.log('Cesium idle frames over 1.5s:', frames);
      assert.ok(frames < 10, `Expected idle rendering to stop; got ${frames} frames`);
      await page.evaluate(() => mapZeroController.setOpacity('buildings', 0.6));
      await page.waitForTimeout(300);
      console.log('scene state:', await page.evaluate(() => ({ frames: renderedFrames, renderLoop: viewer.useDefaultRenderLoop, error: document.querySelector('.cesium-widget-errorPanel')?.innerText })));
      await page.screenshot({ path: '/tmp/map-zero-3d.png', timeout: 10000 });
      console.log('render errors:', errors);
      await page.waitForFunction(() => renderedFrames > 0, null, { timeout: 10000 });
      await page.evaluate(() => {
        mapZeroController.setVisible('roads', false);
        mapZeroController.setVisible('roads', true);
      });
      await page.evaluate(() => mapZeroController.setVisible('pois', false));
      await page.waitForTimeout(300);
      assert.ok(await page.evaluate(() => {
        const labels = mapZeroController.labelCollection;
        return Array.from({ length: labels.length }, (_, i) => labels.get(i)).every((label) => label.id.mapZeroLayer !== 'pois');
      }));
      await page.evaluate(() => mapZeroController.setVisible('pois', true));
      await page.waitForTimeout(300);
      await page.evaluate(() => mapZeroController.setOpacity('pois', 0));
      await page.waitForTimeout(300);
      assert.ok(await page.evaluate(() => {
        const labels = mapZeroController.labelCollection;
        return Array.from({ length: labels.length }, (_, i) => labels.get(i)).every((label) => label.id.mapZeroLayer !== 'pois');
      }));
      await page.evaluate(() => mapZeroController.setOpacity('pois', 1));
      await page.waitForTimeout(1000);
    } else {
      await page.waitForFunction(() => document.querySelectorAll('#layers input').length > 0);
      await page.waitForTimeout(8000);
    }
    console.log(path, await page.locator('#status').innerText());
    await page.screenshot({ path: `/tmp/map-zero-${path.startsWith('/cesium') ? '3d' : '2d'}.png` });
    if (path.startsWith('/cesium')) {
      const remaining = await page.evaluate(() => {
        const labels = mapZeroController.labelCollection;
        const expected = viewer.scene.primitives.length - 2 - new Set(Object.values(mapZeroController.tilesets)).size;
        mapZeroController.destroy();
        return { expected, actual: viewer.scene.primitives.length, labelsDestroyed: labels.isDestroyed() };
      });
      assert.equal(remaining.actual, remaining.expected);
      assert.equal(remaining.labelsDestroyed, true);
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await app.close();
}
