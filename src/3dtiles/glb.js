/**
 * Minimal glTF/GLB writer used by the 3D Tiles exporter.
 *
 * It receives already-built mesh buffers and writes a single-scene, single-mesh
 * GLB. The writer intentionally stays small: no animations, textures, feature
 * tables, or material variants. Cesium styling is applied outside the GLB when
 * possible.
 *
 * @typedef {{
 *   positions: Float32Array,
 *   normals?: Float32Array,
 *   indices: Uint16Array | Uint32Array,
 *   min: [number, number, number],
 *   max: [number, number, number]
 * }} Mesh
 */

/**
 * Build a minimal GLB for one merged mesh.
 *
 * @param {Mesh} mesh
 * @param {{ color?: [number, number, number, number], generator?: string, includeNormals?: boolean, quantizeNormals?: boolean, doubleSided?: boolean, unlit?: boolean }} [options]
 * @returns {Buffer}
 */
export function buildGlbFromMesh(mesh, options = {}) {
  const binBuilder = { chunks: [], byteLength: 0 };
  const bufferViews = [];
  const accessors = [];
  const attributes = {};

  const positionView = appendBuffer(binBuilder, bufferFromTypedArray(mesh.positions), 4);
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
    const normals = options.quantizeNormals === false
      ? mesh.normals
      : quantizeNormals(mesh.normals);
    const normalView = appendBuffer(binBuilder, bufferFromTypedArray(normals), 4);
    bufferViews.push({ buffer: 0, byteOffset: normalView.byteOffset, byteLength: normalView.byteLength, target: 34962 });
    attributes.NORMAL = accessors.length;
    accessors.push({
      bufferView: bufferViews.length - 1,
      byteOffset: 0,
      componentType: normals instanceof Float32Array ? 5126 : 5120,
      count: normals.length / 3,
      type: 'VEC3',
      ...(normals instanceof Float32Array ? {} : { normalized: true })
    });
  }

  const hasIndices = mesh.indices.length > 0;
  let indexAccessor = null;
  if (hasIndices) {
    const indexView = appendBuffer(binBuilder, bufferFromTypedArray(mesh.indices), 4);
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

  const bin = Buffer.concat(binBuilder.chunks);
  const primitive = {
    attributes,
    material: 0
  };
  if (indexAccessor !== null) {
    primitive.indices = indexAccessor;
  }

  const unlit = options.unlit !== false;
  const material = {
    pbrMetallicRoughness: {
      baseColorFactor: options.color ?? [0, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 1
    },
    doubleSided: options.doubleSided === true
  };
  if (unlit) {
    material.extensions = {
      KHR_materials_unlit: {}
    };
  }

  const gltf = {
    asset: {
      version: '2.0',
      generator: options.generator ?? 'map-zero'
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [primitive]
    }],
    materials: [material],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors
  };
  if (unlit) {
    gltf.extensionsUsed = ['KHR_materials_unlit'];
  }

  return buildGlb(gltf, bin);
}

/**
 * Convert any typed array view into a Buffer over the same underlying memory.
 *
 * @param {ArrayBufferView} typedArray
 * @returns {Buffer}
 */
function bufferFromTypedArray(typedArray) {
  return Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
}

/**
 * Store unit normals as normalized signed bytes. This keeps the lighting
 * direction while cutting the normal attribute from 12 bytes to 3 bytes per
 * vertex, which matters for dense building tiles.
 *
 * @param {Float32Array} normals
 * @returns {Int8Array}
 */
function quantizeNormals(normals) {
  const quantized = new Int8Array(normals.length);
  for (let i = 0; i < normals.length; i++) {
    const value = Math.max(-1, Math.min(1, Number.isFinite(normals[i]) ? normals[i] : 0));
    quantized[i] = Math.round(value * 127);
  }
  return quantized;
}

/**
 * Serialize a glTF JSON document and binary payload into GLB v2 layout.
 *
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
 * Append one binary buffer to the BIN chunk with the requested alignment.
 *
 * Tracking byteLength avoids repeatedly scanning all previous chunks while
 * assembling large city tiles.
 *
 * @param {{ chunks: Buffer[], byteLength: number }} builder
 * @param {Buffer} buffer
 * @param {number} alignment
 * @returns {{ byteOffset: number, byteLength: number }}
 */
function appendBuffer(builder, buffer, alignment) {
  const byteOffset = builder.byteLength;
  const paddedOffset = align(byteOffset, alignment);
  if (paddedOffset > byteOffset) {
    const padding = Buffer.alloc(paddedOffset - byteOffset);
    builder.chunks.push(padding);
    builder.byteLength += padding.length;
  }

  builder.chunks.push(buffer);
  builder.byteLength += buffer.length;
  return {
    byteOffset: paddedOffset,
    byteLength: buffer.length
  };
}

/**
 * Pad a GLB chunk to the required byte alignment.
 *
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
 * Round a byte length up to the next multiple of alignment.
 *
 * @param {number} value
 * @param {number} alignment
 * @returns {number}
 */
function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
