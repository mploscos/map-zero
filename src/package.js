import { createWriteStream, promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { once } from 'node:events';

const ZIP_VERSION = 20;
const STORE_METHOD = 0;
const MAX_ZIP_UINT32 = 0xffffffff;
const DOS_TIME_ZERO = 0;
const DOS_DATE_1980_01_01 = 33;

/**
 * Create a portable zip for copying a generated map-zero package into an app.
 *
 * The archive includes manifest.json, styles, PMTiles, and 3D Tiles. The source
 * GeoPackage is intentionally excluded unless requested because it is large and
 * not needed by static OpenLayers/Cesium consumers.
 *
 * @param {{ packageDir: string, out?: string, includeGpkg?: boolean }} options
 * @returns {Promise<{ outPath: string, fileCount: number, inputBytes: number, outputBytes: number, includedGpkg: boolean }>}
 */
export async function packageMapZero(options) {
  const packageDir = resolve(options.packageDir);
  const manifestPath = join(packageDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  validateManifest(manifest);

  const packageBaseName = basename(packageDir);
  const outPath = resolve(options.out ?? join(dirname(packageDir), `${packageBaseName}.zip`));
  const entries = await collectPackageEntries(packageDir, manifest, {
    includeGpkg: Boolean(options.includeGpkg),
    zipRoot: packageBaseName
  });

  const result = await writeZip(outPath, entries);
  return {
    outPath,
    fileCount: entries.length,
    inputBytes: result.inputBytes,
    outputBytes: result.outputBytes,
    includedGpkg: Boolean(options.includeGpkg)
  };
}

/**
 * @param {string} packageDir
 * @param {Record<string, any>} manifest
 * @param {{ includeGpkg: boolean, zipRoot: string }} options
 * @returns {Promise<Array<{ filePath: string, zipPath: string, size: number }>>}
 */
async function collectPackageEntries(packageDir, manifest, options) {
  /** @type {Array<{ filePath: string, zipPath: string, size: number }>} */
  const entries = [];
  const seen = new Set();
  const addFile = async (relativePath, required = true) => {
    const normalized = safePackageRelativePath(relativePath);
    if (!normalized) {
      if (required) throw new Error(`invalid package path: ${relativePath}`);
      return;
    }

    const filePath = join(packageDir, normalized);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if (required) throw new Error(`required package file is missing: ${normalized}`);
      return;
    }
    if (!stat.isFile()) {
      if (required) throw new Error(`package path is not a file: ${normalized}`);
      return;
    }
    if (stat.size > MAX_ZIP_UINT32) {
      throw new Error(`file is too large for non-Zip64 output: ${normalized}`);
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    entries.push({
      filePath,
      zipPath: `${options.zipRoot}/${normalized}`,
      size: stat.size
    });
  };

  await addFile('manifest.json');
  await addManifestStyles(manifest, addFile);

  const pmtilesUrl = manifest.tiles?.format === 'pmtiles' ? manifest.tiles.url : null;
  if (typeof pmtilesUrl === 'string') {
    await addFile(pmtilesUrl);
  }

  const tiles3dUrls = manifest.tiles3d?.format === '3dtiles'
    ? [...Object.values(manifest.tiles3d.tilesets ?? {}), manifest.tiles3d.url].filter(url => typeof url === 'string')
    : [];
  for (const tiles3dUrl of new Set(tiles3dUrls)) {
    const tiles3dDir = dirname(safePackageRelativePath(tiles3dUrl) ?? '');
    if (!tiles3dDir || tiles3dDir === '.') {
      throw new Error(`invalid 3D Tiles URL in manifest: ${tiles3dUrl}`);
    }
    await addDirectory(packageDir, tiles3dDir, options.zipRoot, entries, seen);
  }

  if (options.includeGpkg) {
    await addFile(String(manifest.data ?? 'data.gpkg'));
  }

  return entries.sort((a, b) => a.zipPath.localeCompare(b.zipPath));
}

/**
 * @param {Record<string, any>} manifest
 * @param {(relativePath: string, required?: boolean) => Promise<void>} addFile
 */
async function addManifestStyles(manifest, addFile) {
  const styles = manifest.styles && typeof manifest.styles === 'object' ? manifest.styles : {};
  const stylePaths = new Set(Object.values(styles).filter((value) => typeof value === 'string'));
  for (const stylePath of stylePaths) {
    await addFile(stylePath);
  }
}

/**
 * @param {string} packageDir
 * @param {string} relativeDir
 * @param {string} zipRoot
 * @param {Array<{ filePath: string, zipPath: string, size: number }>} entries
 * @param {Set<string>} seen
 */
async function addDirectory(packageDir, relativeDir, zipRoot, entries, seen) {
  const normalizedDir = safePackageRelativePath(relativeDir);
  if (!normalizedDir) {
    throw new Error(`invalid package directory: ${relativeDir}`);
  }

  const dirPath = join(packageDir, normalizedDir);
  let stat;
  try {
    stat = await fs.stat(dirPath);
  } catch (error) {
    throw new Error(`required package directory is missing: ${normalizedDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`package path is not a directory: ${normalizedDir}`);
  }

  for (const item of await listFiles(dirPath)) {
    const normalized = relative(packageDir, item).split(sep).join('/');
    if (seen.has(normalized)) continue;
    const itemStat = await fs.stat(item);
    if (itemStat.size > MAX_ZIP_UINT32) {
      throw new Error(`file is too large for non-Zip64 output: ${normalized}`);
    }
    seen.add(normalized);
    entries.push({
      filePath: item,
      zipPath: `${zipRoot}/${normalized}`,
      size: itemStat.size
    });
  }
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFiles(dir) {
  const out = [];
  const items = await fs.readdir(dir, { withFileTypes: true });
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    const itemPath = join(dir, item.name);
    if (item.isDirectory()) {
      out.push(...await listFiles(itemPath));
    } else if (item.isFile()) {
      out.push(itemPath);
    }
  }
  return out;
}

/**
 * @param {string} outPath
 * @param {Array<{ filePath: string, zipPath: string, size: number }>} entries
 * @returns {Promise<{ inputBytes: number, outputBytes: number }>}
 */
async function writeZip(outPath, entries) {
  if (entries.length > 0xffff) {
    throw new Error('zip has too many files for non-Zip64 output');
  }

  await fs.mkdir(dirname(outPath), { recursive: true });
  const stream = createWriteStream(outPath);
  const centralDirectory = [];
  let offset = 0;
  let inputBytes = 0;

  try {
    for (const entry of entries) {
      const data = await fs.readFile(entry.filePath);
      const crc = crc32(data);
      const name = Buffer.from(entry.zipPath, 'utf8');
      const localHeader = createLocalHeader(name, crc, data.length);
      const entryOffset = offset;
      await writeBuffer(stream, localHeader);
      await writeBuffer(stream, data);
      offset += localHeader.length + data.length;
      inputBytes += data.length;
      if (offset > MAX_ZIP_UINT32) {
        throw new Error('zip output is too large for non-Zip64 output');
      }
      centralDirectory.push(createCentralDirectoryHeader(name, crc, data.length, entryOffset));
    }

    const centralStart = offset;
    for (const header of centralDirectory) {
      await writeBuffer(stream, header);
      offset += header.length;
    }
    const centralSize = offset - centralStart;
    if (offset > MAX_ZIP_UINT32 || centralSize > MAX_ZIP_UINT32) {
      throw new Error('zip output is too large for non-Zip64 output');
    }
    await writeBuffer(stream, createEndOfCentralDirectory(entries.length, centralSize, centralStart));
    offset += 22;
  } catch (error) {
    stream.destroy();
    await fs.rm(outPath, { force: true }).catch(() => undefined);
    throw error;
  }

  stream.end();
  await once(stream, 'finish');
  return {
    inputBytes,
    outputBytes: offset
  };
}

/**
 * @param {import('node:fs').WriteStream} stream
 * @param {Buffer} buffer
 * @returns {Promise<void>}
 */
async function writeBuffer(stream, buffer) {
  if (!stream.write(buffer)) {
    await once(stream, 'drain');
  }
}

function createLocalHeader(name, crc, size) {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(STORE_METHOD, 8);
  header.writeUInt16LE(DOS_TIME_ZERO, 10);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function createCentralDirectoryHeader(name, crc, size, offset) {
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(ZIP_VERSION, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(STORE_METHOD, 10);
  header.writeUInt16LE(DOS_TIME_ZERO, 12);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  name.copy(header, 46);
  return header;
}

function createEndOfCentralDirectory(entryCount, centralSize, centralStart) {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(entryCount, 8);
  header.writeUInt16LE(entryCount, 10);
  header.writeUInt32LE(centralSize, 12);
  header.writeUInt32LE(centralStart, 16);
  header.writeUInt16LE(0, 20);
  return header;
}

/**
 * @param {Buffer} data
 * @returns {number}
 */
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) {
    c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

/**
 * @param {Record<string, unknown>} manifest
 */
function validateManifest(manifest) {
  if (manifest.format !== 'mapzero') {
    throw new Error('manifest format must be mapzero');
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function safePackageRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized) || normalized.includes('..')) {
    return null;
  }
  return normalized;
}
