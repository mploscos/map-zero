/**
 * Minimal Batched 3D Model (b3dm) container writer.
 *
 * Features use standard batch-table properties and glTF _BATCHID attributes.
 * RTC_CENTER keeps geometry localized for high precision rendering in Cesium.
 *
 * Wrap a GLB buffer in a minimal valid B3DM container.
 *
 * @param {Buffer} glb
 * @param {{ rtcCenter?: [number, number, number], properties?: Record<string, unknown>[] }} [options]
 * @returns {Buffer}
 */
export function buildB3dm(glb, options = {}) {
  const featureTable = { BATCH_LENGTH: options.properties?.length ?? 0 };
  if (options.rtcCenter) {
    featureTable.RTC_CENTER = options.rtcCenter;
  }
  const featureTableJson = padJsonForSection(featureTable, 28);
  const batchJson = options.properties?.length ? padJsonForSection(batchTable(options.properties), 28 + featureTableJson.length) : Buffer.alloc(0);
  const header = Buffer.alloc(28);
  header.write('b3dm', 0, 4, 'ascii');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(28 + featureTableJson.length + batchJson.length + glb.length, 8);
  header.writeUInt32LE(featureTableJson.length, 12);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(batchJson.length, 20);
  header.writeUInt32LE(0, 24);
  return Buffer.concat([header, featureTableJson, batchJson, glb]);
}

/**
 * Serialize and pad feature/batch table JSON so the following section starts on
 * an 8-byte boundary, as required by the b3dm container.
 *
 * @param {unknown} value
 * @param {number} sectionOffset
 * @returns {Buffer}
 */
function padJsonForSection(value, sectionOffset) {
  const buffer = Buffer.from(JSON.stringify(value), 'utf8');
  const targetLength = align(sectionOffset + buffer.length, 8) - sectionOffset;
  return Buffer.concat([buffer, Buffer.alloc(targetLength - buffer.length, 0x20)]);
}

/**
 * Round a byte length up to the next multiple of alignment.
 *
 * @param {number} value
 * @param {number} alignment
 * @returns {number}
 */
function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

/** Columnar standard batch table; preserve scalar properties and NULLs. */
export function batchTable(properties) {
  const keys = new Set(properties.flatMap((row) => Object.keys(row)));
  return Object.fromEntries([...keys].map((key) => [key, properties.map((row) => row[key] ?? null)]));
}
