import { drawSourceData } from '../canvas-renderer.js';

export class Canvas2DTileRenderer {
  constructor() {
    this.backend = 'canvas2d';
  }

  async render(sourceData, renderExtent, z, size, state) {
    const { canvas, ctx } = createRenderCanvas(size, state.pixelRatio);
    if (!ctx || !sourceData) return canvas;
    this.draw(ctx, sourceData, renderExtent, z, size, state);
    clearCanvasBorder(ctx, size, size, state.edgeGuardPixels);
    return canvas;
  }

  draw(ctx, sourceData, renderExtent, z, size, state) {
    drawSourceData(ctx, sourceData, renderExtent, z, size, state);
  }

  destroy() {}
}

function createRenderCanvas(size, pixelRatio) {
  const ratio = Math.max(1, Math.min(2, Number(pixelRatio) || 1));
  const canvas = new OffscreenCanvas(Math.round(size * ratio), Math.round(size * ratio));
  const ctx = canvas.getContext('2d');
  if (ctx && ratio !== 1) ctx.scale(ratio, ratio);
  return { canvas, ctx };
}

function clearCanvasBorder(ctx, width, height, pixels) {
  if (!(pixels > 0)) return;
  ctx.clearRect(0, 0, width, pixels);
  ctx.clearRect(0, height - pixels, width, pixels);
  ctx.clearRect(0, 0, pixels, height);
  ctx.clearRect(width - pixels, 0, pixels, height);
}
