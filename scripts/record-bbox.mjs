// Capture real bbox drawing and output configuration; this demo submits no build.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { serveBboxBuilder } from '../src/bbox-server.js';

const output = resolve('docs/media');
const frames = await mkdtemp(join(tmpdir(), 'map-zero-bbox-'));
await mkdir(output, { recursive: true });
const { app, url } = await serveBboxBuilder({ port: 0, outputRoot: resolve('generated') });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1120, height: 680 }, deviceScaleFactor: 1 });
  const errors = [];
  let mapTiles = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('tile.openstreetmap.org') && response.ok()) mapTiles++;
  });
  await page.goto(url, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('#layerChecks input').length > 0);
  for (let i = 0; i < 4; i++) {
    await page.locator('.ol-zoom-in').click();
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(2500);
  assert.ok(mapTiles > 0, 'The recording must show a loaded basemap');
  await page.evaluate(() => {
    const cursor = document.createElement('div');
    cursor.style.cssText = 'position:fixed;left:-30px;top:-30px;width:16px;height:16px;border:2px solid #fff;border-radius:50%;background:#2f81f799;box-shadow:0 0 0 2px #1f6feb;transform:translate(-50%,-50%);pointer-events:none;z-index:9999';
    document.body.append(cursor);
    document.addEventListener('pointermove', (event) => {
      cursor.style.left = event.clientX + 'px'; cursor.style.top = event.clientY + 'px';
    });
  });
  let index = 0;
  const frame = async (repeat = 1) => {
    const file = join(frames, `${String(index++).padStart(3, '0')}.png`);
    await page.screenshot({ path: file });
    for (let i = 1; i < repeat; i++) await copyFile(file, join(frames, `${String(index++).padStart(3, '0')}.png`));
  };
  await frame(3);
  await page.locator('#drawButton').click();
  await frame(2);
  const map = await page.locator('#map').boundingBox();
  const start = { x: map.x + 235, y: 210 };
  const end = { x: map.x + 545, y: 445 };
  await page.mouse.click(start.x, start.y);
  for (let i = 0; i <= 12; i++) {
    await page.mouse.move(start.x + (end.x - start.x) * i / 12, start.y + (end.y - start.y) * i / 12);
    await page.waitForTimeout(35);
    await frame();
  }
  await page.mouse.click(end.x, end.y);
  await page.waitForFunction(() => document.getElementById('bboxInput').value.split(',').length === 4);
  const bbox = (await page.locator('#bboxInput').inputValue()).split(',').map(Number);
  assert.ok(bbox.every(Number.isFinite) && bbox[0] < bbox[2] && bbox[1] < bbox[3]);
  await frame(4);
  await page.locator('#outInput').fill('madrid.mapzero');
  await page.locator('#outInput').blur();
  await frame(3);
  await page.locator('#includeGpkgInput').check();
  assert.equal(await page.locator('#pmtilesInput').isChecked(), true);
  assert.equal(await page.locator('#tiles3dInput').isChecked(), true);
  await frame(3);
  await page.locator('#buildButton').hover();
  await frame(8);
  assert.deepEqual(errors, []);
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '4',
    '-i', join(frames, '%03d.png'), '-filter_complex',
    '[0:v]scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none',
    '-loop', '0', join(output, 'bbox-builder.gif')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'ffmpeg failed');
  await copyFile(join(frames, `${String(index - 1).padStart(3, '0')}.png`), join(output, 'bbox-builder.png'));
  console.log(`Recorded bbox-builder.gif: ${index} frames; drawn bbox ${bbox.join(',')}`);
} finally {
  await browser?.close();
  await app.close();
  await rm(frames, { recursive: true, force: true });
}
