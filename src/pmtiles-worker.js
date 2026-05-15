import { parentPort, workerData } from 'node:worker_threads';

import { openGeoPackageReader } from './gpkg-read.js';
import { encodeMvtTileSetWithStats } from './mvt.js';
import { createHiddenFilters } from './style-filters.js';

if (!parentPort) {
  throw new Error('pmtiles worker must run inside worker_threads');
}

const reader = openGeoPackageReader({
  gpkgPath: workerData.gpkgPath,
  manifest: workerData.manifest,
  hiddenFilters: createHiddenFilters(workerData.manifest, workerData.defaultStyle)
});

parentPort.on('message', (job) => {
  if (job?.type === 'close') {
    reader.close();
    parentPort.postMessage({ type: 'closed' });
    return;
  }

  try {
    const result = encodeMvtTileSetWithStats(reader, job.z, job.x, job.y, job.layerIds, {
      detail: job.detail,
      style: workerData.defaultStyle
    });

    if (result.encodedFeatureCount === 0) {
      parentPort.postMessage({
        type: 'tile',
        id: job.id,
        z: job.z,
        x: job.x,
        y: job.y,
        tileId: job.tileId,
        empty: true,
        stats: result
      });
      return;
    }

    const transferable = result.buffer.buffer.slice(
      result.buffer.byteOffset,
      result.buffer.byteOffset + result.buffer.byteLength
    );
    parentPort.postMessage({
      type: 'tile',
      id: job.id,
      z: job.z,
      x: job.x,
      y: job.y,
      tileId: job.tileId,
      empty: false,
      buffer: transferable,
      stats: {
        ...result,
        buffer: undefined
      }
    }, [transferable]);
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      id: job.id,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }
});
