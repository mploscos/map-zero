/**
 * Minimal Batched 3D Model (b3dm) container writer.
 *
 * map-zero currently emits one GLB per tile and does not use batch IDs or per
 * feature metadata, so the feature table only declares BATCH_LENGTH and an
 * optional RTC_CENTER for high precision rendering in Cesium.
 *
 * Wrap a GLB buffer in a minimal valid B3DM container.
 *
 * @param {Buffer} glb
 * @param {{ rtcCenter?: [number, number, number] }} [options]
 * @returns {Buffer}
 */
export function buildB3dm(glb, options = {}) {
  const featureTable = { BATCH_LENGTH: 0 };
  if (options.rtcCenter) {
    featureTable.RTC_CENTER = options.rtcCenter;
  }
  const featureTableJson = padJsonForSection(featureTable, 28);
  const header = Buffer.alloc(28);
  header.write('b3dm', 0, 4, 'ascii');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(28 + featureTableJson.length + glb.length, 8);
  header.writeUInt32LE(featureTableJson.length, 12);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(0, 20);
  header.writeUInt32LE(0, 24);
  return Buffer.concat([header, featureTableJson, glb]);
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
