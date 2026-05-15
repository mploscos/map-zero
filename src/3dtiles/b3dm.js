/**
 * Wrap a GLB buffer in a minimal valid B3DM container.
 *
 * @param {Buffer} glb
 * @returns {Buffer}
 */
export function buildB3dm(glb) {
  const featureTableJson = padJsonForSection({ BATCH_LENGTH: 0 }, 28);
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
 * @param {number} value
 * @param {number} alignment
 * @returns {number}
 */
function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
