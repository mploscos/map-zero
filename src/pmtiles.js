import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { Compression, TileType, zxyToTileId } from 'pmtiles';

const HEADER_SIZE_BYTES = 127;
const SPEC_VERSION = 3;
const COORDINATE_SCALE = 10_000_000;
const ROOT_LEAF_SIZE = 512;

/**
 * @typedef {{
 *   tileId: number,
 *   offset: number,
 *   length: number,
 *   runLength: number
 * }} PmtilesEntry
 */

/**
 * Convert XYZ tile coordinates to the PMTiles Hilbert tile id.
 *
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function tileIdForZxy(z, x, y) {
  return zxyToTileId(z, x, y);
}

/**
 * Write a PMTiles v3 archive with one root directory and uncompressed MVT tile data.
 *
 * @param {{
 *   outPath: string,
 *   tileDataPath: string,
 *   entries: PmtilesEntry[],
 *   metadata: Record<string, unknown>,
 *   minZoom: number,
 *   maxZoom: number,
 *   bbox: [number, number, number, number],
 *   centerZoom?: number
 * }} options
 * @returns {Promise<{ bytes: number, entries: number }>}
 */
export async function writePmtilesArchive(options) {
  const sortedEntries = [...options.entries].sort((a, b) => a.tileId - b.tileId);
  const directories = createDirectories(sortedEntries);
  const metadata = Buffer.from(`${JSON.stringify(options.metadata)}\n`);
  const tileDataStat = await fs.stat(options.tileDataPath);

  const rootDirectoryOffset = HEADER_SIZE_BYTES;
  const jsonMetadataOffset = rootDirectoryOffset + directories.root.length;
  const leafDirectoryOffset = jsonMetadataOffset + metadata.length;
  const tileDataOffset = leafDirectoryOffset + directories.leaves.length;
  const header = createHeader({
    rootDirectoryOffset,
    rootDirectoryLength: directories.root.length,
    jsonMetadataOffset,
    jsonMetadataLength: metadata.length,
    leafDirectoryOffset,
    leafDirectoryLength: directories.leaves.length,
    tileDataOffset,
    tileDataLength: tileDataStat.size,
    numAddressedTiles: sortedEntries.length,
    numTileEntries: sortedEntries.length,
    numTileContents: sortedEntries.length,
    minZoom: options.minZoom,
    maxZoom: options.maxZoom,
    bbox: options.bbox,
    centerZoom: options.centerZoom ?? options.minZoom
  });

  await fs.mkdir(dirname(options.outPath), { recursive: true });
  const tmpOut = `${options.outPath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs.open(tmpOut, 'w');
  try {
    await handle.write(header);
    await handle.write(directories.root);
    await handle.write(metadata);
    await handle.write(directories.leaves);
  } finally {
    await handle.close();
  }

  await pipeline(
    createReadStream(options.tileDataPath),
    createWriteStream(tmpOut, { flags: 'a' })
  );
  await fs.rename(tmpOut, options.outPath);
  const stat = await fs.stat(options.outPath);

  return {
    bytes: stat.size,
    entries: sortedEntries.length
  };
}

/**
 * @param {PmtilesEntry[]} entries
 * @returns {{ root: Buffer, leaves: Buffer }}
 */
function createDirectories(entries) {
  if (entries.length <= ROOT_LEAF_SIZE) {
    return {
      root: serializeDirectory(entries),
      leaves: Buffer.alloc(0)
    };
  }

  const rootEntries = [];
  const leafBuffers = [];
  let leafOffset = 0;
  for (let index = 0; index < entries.length; index += ROOT_LEAF_SIZE) {
    const leafEntries = entries.slice(index, index + ROOT_LEAF_SIZE);
    const leaf = serializeDirectory(leafEntries);
    rootEntries.push({
      tileId: leafEntries[0].tileId,
      offset: leafOffset,
      length: leaf.length,
      runLength: 0
    });
    leafBuffers.push(leaf);
    leafOffset += leaf.length;
  }

  return {
    root: serializeDirectory(rootEntries),
    leaves: Buffer.concat(leafBuffers)
  };
}

/**
 * @param {PmtilesEntry[]} entries
 * @returns {Buffer}
 */
function serializeDirectory(entries) {
  const chunks = [];
  pushVarint(chunks, entries.length);

  let lastTileId = 0;
  for (const entry of entries) {
    pushVarint(chunks, entry.tileId - lastTileId);
    lastTileId = entry.tileId;
  }

  for (const entry of entries) {
    pushVarint(chunks, entry.runLength);
  }

  for (const entry of entries) {
    pushVarint(chunks, entry.length);
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const previous = entries[index - 1];
    if (previous && entry.offset === previous.offset + previous.length) {
      pushVarint(chunks, 0);
    } else {
      pushVarint(chunks, entry.offset + 1);
    }
  }

  return Buffer.from(chunks);
}

/**
 * @param {number[]} chunks
 * @param {number} value
 */
function pushVarint(chunks, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`PMTiles varint value must be a safe non-negative integer: ${value}`);
  }

  let remaining = value;
  while (remaining >= 0x80) {
    chunks.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  chunks.push(remaining);
}

/**
 * @param {{
 *   rootDirectoryOffset: number,
 *   rootDirectoryLength: number,
 *   jsonMetadataOffset: number,
 *   jsonMetadataLength: number,
 *   leafDirectoryOffset: number,
 *   leafDirectoryLength: number,
 *   tileDataOffset: number,
 *   tileDataLength: number,
 *   numAddressedTiles: number,
 *   numTileEntries: number,
 *   numTileContents: number,
 *   minZoom: number,
 *   maxZoom: number,
 *   bbox: [number, number, number, number],
 *   centerZoom: number
 * }} options
 * @returns {Buffer}
 */
function createHeader(options) {
  const header = Buffer.alloc(HEADER_SIZE_BYTES);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(SPEC_VERSION, 7);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

  setUint64(view, 8, options.rootDirectoryOffset);
  setUint64(view, 16, options.rootDirectoryLength);
  setUint64(view, 24, options.jsonMetadataOffset);
  setUint64(view, 32, options.jsonMetadataLength);
  setUint64(view, 40, options.leafDirectoryOffset);
  setUint64(view, 48, options.leafDirectoryLength);
  setUint64(view, 56, options.tileDataOffset);
  setUint64(view, 64, options.tileDataLength);
  setUint64(view, 72, options.numAddressedTiles);
  setUint64(view, 80, options.numTileEntries);
  setUint64(view, 88, options.numTileContents);
  header.writeUInt8(1, 96);
  header.writeUInt8(Compression.None, 97);
  header.writeUInt8(Compression.None, 98);
  header.writeUInt8(TileType.Mvt, 99);
  header.writeUInt8(options.minZoom, 100);
  header.writeUInt8(options.maxZoom, 101);
  view.setInt32(102, scaledCoordinate(options.bbox[0]), true);
  view.setInt32(106, scaledCoordinate(options.bbox[1]), true);
  view.setInt32(110, scaledCoordinate(options.bbox[2]), true);
  view.setInt32(114, scaledCoordinate(options.bbox[3]), true);
  header.writeUInt8(options.centerZoom, 118);
  view.setInt32(119, scaledCoordinate((options.bbox[0] + options.bbox[2]) / 2), true);
  view.setInt32(123, scaledCoordinate((options.bbox[1] + options.bbox[3]) / 2), true);

  return header;
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @param {number} value
 */
function setUint64(view, offset, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`PMTiles header value must be a safe non-negative integer: ${value}`);
  }

  view.setBigUint64(offset, BigInt(value), true);
}

/**
 * @param {number} value
 * @returns {number}
 */
function scaledCoordinate(value) {
  return Math.round(value * COORDINATE_SCALE);
}
