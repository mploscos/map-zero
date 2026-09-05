// Captures real map-zero viewers and replays an actual CLI build log.
// node scripts/record-readme.mjs generated/readme-demo.mapzero docs/media/generation.log
import { chromium } from 'playwright-core';
import { mkdir, mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMapZeroServer } from '../src/server.js';

const packageDir = resolve(process.argv[2] ?? 'generated/readme-demo.mapzero');
const output = resolve('docs/media');
const logPath = process.argv[3] ?? join(output, 'generation.log');
const frames = await mkdtemp(join(tmpdir(), 'map-zero-gifs-'));
await mkdir(output, { recursive: true });
const app = await createMapZeroServer({ packageDir });
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1120, height: 680 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
async function frame(name, index) {
  await page.screenshot({ path: join(frames, `${name}-${String(index).padStart(3, '0')}.png`), timeout: 30000 });
}
async function encode(name, fps) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', join(frames, `${name}-%03d.png`), '-filter_complex', '[0:v]fps=4,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none', '-loop', '0', join(output, `${name}.gif`)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'ffmpeg failed');
  await copyFile(join(frames, `${name}-018.png`), join(output, `${name}.png`));
  console.log(`Recorded ${name}.gif`);
}
async function caption(kicker, title, detail) {
  await page.evaluate(({ kicker, title, detail }) => {
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:22px;bottom:22px;padding:18px 24px;border:1px solid #2d555b;border-radius:14px;background:#071218eb;color:#e4fbfa;z-index:9999;font:14px system-ui;box-shadow:0 12px 40px #0008;pointer-events:none';
    const small = document.createElement('div'); small.textContent = kicker;
    small.style.cssText = 'font-size:10px;letter-spacing:3px;color:#72e6d8;margin-bottom:7px';
    const heading = document.createElement('div'); heading.textContent = title;
    heading.style.cssText = 'font-weight:650;font-size:23px;margin-bottom:6px';
    const sub = document.createElement('div'); sub.textContent = detail; sub.style.color = '#9fb6bd';
    panel.append(small, heading, sub); document.body.append(panel);
  }, { kicker, title, detail });
}
try {
  if (!process.argv.includes('--3d-only')) {
  const log = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);
  await page.setContent(`<html><style>*{box-sizing:border-box}body{margin:0;background:#071018;color:#dceced;font:16px system-ui;padding:46px 58px}small{color:#70e2d3;letter-spacing:4px;font-size:11px}h1{font-size:42px;letter-spacing:-1.5px;margin:16px 0 8px}p{color:#91a9b5;margin:0 0 28px}section{height:410px;border:1px solid #28424c;border-radius:14px;background:#0b161e;overflow:hidden}header{background:#12232e;padding:13px 20px;color:#aec8cc;font-size:12px;border-bottom:1px solid #28424c}pre{padding:20px;margin:0;font:14px/1.7 monospace;white-space:pre-wrap;color:#9ee4d8}footer{display:flex;justify-content:space-between;margin-top:24px;color:#698592;font-size:12px}</style><small>MAP ZERO / 01 GENERATE</small><h1>From OpenStreetMap to your own map.</h1><p>One local workflow. Portable data for 2D and 3D.</p><section><header>● ● ● &nbsp; map-zero · Madrid, Spain · actual CLI output</header><pre id="log"></pre></section><footer><span>GeoPackage → PMTiles → 3D Tiles</span><span>Time-compressed build replay · v0.4.0</span></footer></html>`);
  for (let i = 0; i < 36; i++) {
    const end = Math.max(1, Math.ceil((i + 1) / 36 * log.length));
    await page.locator('#log').evaluate((el, text) => { el.textContent = text; }, log.slice(Math.max(0, end - 12), end).join('\n'));
    await frame('generate', i);
  }
  await encode('generate', 4);

  await page.goto(url + '/?lon=-3.703&lat=40.4175&zoom=17', { timeout: 60000 });
  await page.waitForFunction(() => globalThis.mapZeroMap && document.querySelector('#status').textContent.includes('ready'));
  await page.waitForTimeout(3000);
  await caption('MAP ZERO / 02 EXPLORE', 'The same data. In 2D.', 'OpenLayers · vector PMTiles · local data');
  for (let i = 0; i < 42; i++) {
    await page.evaluate((i) => {
      const view = mapZeroMap.getView();
      view.setZoom(17 + 0.55 * Math.sin(i / 41 * Math.PI));
      view.setRotation(0.09 * Math.sin(i / 41 * Math.PI * 2));
      mapZeroMap.renderSync();
    }, i);
    await page.waitForTimeout(100);
    await frame('openlayers-2d', i);
  }
  await encode('openlayers-2d', 6);
  }

  await page.goto(url + '/cesium', { timeout: 60000 });
  await page.waitForFunction(() => globalThis.mapZeroController?.vectorProvider && mapZeroController.vectorProvider.tileset.tilesLoaded);
  await page.evaluate(() => {
    viewer.camera.lookAt(Cesium.Cartesian3.fromDegrees(-3.703, 40.4175, 0),
      new Cesium.HeadingPitchRange(Cesium.Math.toRadians(-25), Cesium.Math.toRadians(-38), 850));
    viewer.scene.requestRender();
  });
  await page.waitForFunction(() => mapZeroController.labelCollection.length > 0 && mapZeroController.vectorProvider.tileset.tilesLoaded);
  await page.waitForTimeout(4000);
  await caption('MAP ZERO / 03 DISCOVER', 'The same data. In 3D.', 'Cesium 1.145 · native MVT · labels · 3D buildings');
  for (let i = 0; i < 48; i++) {
    await page.evaluate((i) => {
      const target = Cesium.Cartesian3.fromDegrees(-3.703, 40.4175, 0);
      viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(Cesium.Math.toRadians(-25 + i * 1.2), Cesium.Math.toRadians(-38), 850));
      viewer.scene.requestRender();
    }, i);
    await page.waitForTimeout(130);
    await frame('cesium-3d', i);
  }
  await encode('cesium-3d', 6);
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
  await app.close();
  await rm(frames, { recursive: true, force: true });
}
