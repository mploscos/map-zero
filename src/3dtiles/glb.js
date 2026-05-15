/**
 * @typedef {{
 *   positions: Float32Array,
 *   normals?: Float32Array,
 *   indices: Uint16Array | Uint32Array,
 *   min: [number, number, number],
 *   max: [number, number, number]
 * }} Mesh
 */

/**
 * Build a minimal unlit GLB for one merged mesh.
 *
 * @param {Mesh} mesh
 * @param {{ color?: [number, number, number, number], generator?: string, includeNormals?: boolean }} [options]
 * @returns {Buffer}
 */
export function buildGlbFromMesh(mesh, options = {}) {
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  const attributes = {};

  const positionView = appendBuffer(chunks, bufferFromTypedArray(mesh.positions), 4);
  bufferViews.push({ buffer: 0, byteOffset: positionView.byteOffset, byteLength: positionView.byteLength, target: 34962 });
  attributes.POSITION = accessors.length;
  accessors.push({
    bufferView: bufferViews.length - 1,
    byteOffset: 0,
    componentType: 5126,
    count: mesh.positions.length / 3,
    type: 'VEC3',
    min: mesh.min,
    max: mesh.max
  });

  const includeNormals = options.includeNormals === true
    && mesh.normals
    && mesh.normals.length === mesh.positions.length;
  if (includeNormals) {
    const normalView = appendBuffer(chunks, bufferFromTypedArray(mesh.normals), 4);
    bufferViews.push({ buffer: 0, byteOffset: normalView.byteOffset, byteLength: normalView.byteLength, target: 34962 });
    attributes.NORMAL = accessors.length;
    accessors.push({
      bufferView: bufferViews.length - 1,
      byteOffset: 0,
      componentType: 5126,
      count: mesh.normals.length / 3,
      type: 'VEC3'
    });
  }

  const hasIndices = mesh.indices.length > 0;
  let indexAccessor = null;
  if (hasIndices) {
    const indexView = appendBuffer(chunks, bufferFromTypedArray(mesh.indices), 4);
    bufferViews.push({ buffer: 0, byteOffset: indexView.byteOffset, byteLength: indexView.byteLength, target: 34963 });
    indexAccessor = accessors.length;
    accessors.push({
      bufferView: bufferViews.length - 1,
      byteOffset: 0,
      componentType: mesh.indices instanceof Uint32Array ? 5125 : 5123,
      count: mesh.indices.length,
      type: 'SCALAR'
    });
  }

  const bin = Buffer.concat(chunks);
  const primitive = {
    attributes,
    material: 0
  };
  if (indexAccessor !== null) {
    primitive.indices = indexAccessor;
  }

  const gltf = {
    asset: {
      version: '2.0',
      generator: options.generator ?? 'map-zero'
    },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [primitive]
    }],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: options.color ?? [0, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 1
      },
      extensions: {
        KHR_materials_unlit: {}
      },
      doubleSided: true
    }],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors
  };

  return buildGlb(gltf, bin);
}

/**
 * @param {ArrayBufferView} typedArray
 * @returns {Buffer}
 */
function bufferFromTypedArray(typedArray) {
  return Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
}

/**
 * @param {Record<string, unknown>} gltf
 * @param {Buffer} binBuffer
 * @returns {Buffer}
 */
export function buildGlb(gltf, binBuffer) {
  const jsonChunk = padBuffer(Buffer.from(JSON.stringify(gltf), 'utf8'), 4, 0x20);
  const binChunk = padBuffer(binBuffer, 4, 0);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

/**
 * @param {Buffer[]} chunks
 * @param {Buffer} buffer
 * @param {number} alignment
 * @returns {{ byteOffset: number, byteLength: number }}
 */
function appendBuffer(chunks, buffer, alignment) {
  const byteOffset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const paddedOffset = align(byteOffset, alignment);
  if (paddedOffset > byteOffset) {
    chunks.push(Buffer.alloc(paddedOffset - byteOffset));
  }

  chunks.push(buffer);
  return {
    byteOffset: paddedOffset,
    byteLength: buffer.length
  };
}

/**
 * @param {Buffer} buffer
 * @param {number} alignment
 * @param {number} fill
 * @returns {Buffer}
 */
function padBuffer(buffer, alignment, fill) {
  const targetLength = align(buffer.length, alignment);
  return targetLength === buffer.length
    ? buffer
    : Buffer.concat([buffer, Buffer.alloc(targetLength - buffer.length, fill)]);
}

/**
 * @param {number} value
 * @param {number} alignment
 * @returns {number}
 */
function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
