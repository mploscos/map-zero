import { VECTOR_FORMAT as E } from './extensions.js';

/** Focused writer invariants, not a replacement for a glTF validator that
 * understands these draft extensions. Also used by compatibility tests.
 */
export function inspectVectorGlb(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) throw new Error('Invalid GLB header');
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString());
  const bin = buffer.subarray(28 + jsonLength);
  const accessor = index => {
    const a = json.accessors[index], view = json.bufferViews[a.bufferView];
    const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const n = a.count * (a.type === 'VEC3' ? 3 : 1);
    return Array.from({length:n}, (_, i) => a.componentType === 5126 ? bin.readFloatLE(offset+i*4) : bin.readUInt32LE(offset+i*4));
  };
  return { json, bin, accessor };
}

export function validateVectorGlb(bytes) {
  const result = inspectVectorGlb(bytes), {json, bin, accessor} = result;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  check(!JSON.stringify(json).includes('CESIUM_mesh_vector'), 'Deprecated vector extension');
  for (const view of json.bufferViews) check(view.byteLength > 0 && (view.byteOffset ?? 0)+view.byteLength <= bin.length, 'Invalid buffer view');
  const count = json.extensions[E.metadata].propertyTables[0].count;
  const metadata = json.extensions[E.metadata];
  for (const [id, definition] of Object.entries(metadata.schema.classes.feature.properties)) {
    check(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id), 'Invalid metadata property identifier');
    if (definition.type === 'SCALAR') {
      const view = json.bufferViews[metadata.propertyTables[0].properties[id].values];
      for (let i=0;i<count;i++) check(Number.isFinite(bin.readDoubleLE(view.byteOffset+i*8)), 'Non-finite binary metadata');
    }
  }
  for (const mesh of json.meshes) for (const p of mesh.primitives) {
    const positions = accessor(p.attributes.POSITION), ids = accessor(p.attributes._FEATURE_ID_0);
    check(json.accessors[p.attributes._FEATURE_ID_0].componentType === 5126, 'Feature IDs must use a valid glTF vertex attribute type');
    check(ids.length * 3 === positions.length && positions.every(Number.isFinite), 'Invalid positions/feature IDs');
    check(ids.every(id => id >= 0 && id < count), 'Feature ID outside property table');
    check(p.extensions[E.features].featureIds[0].featureCount === count, 'Incorrect feature count');
    check([0,3,4].includes(p.mode), 'Unexpected primitive mode');
    if (p.mode === 0) continue;
    const indices = accessor(p.indices);
    check(indices.every(i => i < ids.length || (p.mode === 3 && i === E.restartIndex)), 'Invalid index');
    if (indices.includes(E.restartIndex)) {
      check(json.extensionsUsed.includes(E.restart) && json.extensionsRequired.includes(E.restart), 'Primitive restart must be required');
      check(indices[0] !== E.restartIndex && indices.at(-1) !== E.restartIndex, 'Empty endpoint line');
    }
    if (p.mode !== 4) continue;
    const topology = p.extensions[E.polygon];
    check(topology && json.extensionsUsed.includes(E.polygon), 'Missing polygon topology');
    const offsets = accessor(topology.indicesOffsets), loops = accessor(topology.loopIndices), starts = accessor(topology.loopIndicesOffsets);
    check(offsets.length === topology.count && starts.length === topology.count, 'Invalid polygon offsets');
    check(new Set(loops.filter(i=>i!==E.restartIndex)).size===ids.length, 'Polygon contains unused vertices');
    for (let n = 0; n < topology.count; n++) {
      const triangles = new Set(indices.slice(offsets[n], offsets[n+1] ?? indices.length));
      const loop = loops.slice(starts[n], starts[n+1] ?? loops.length);
      check(loop.every(i => i === E.restartIndex || triangles.has(i)), 'Loop vertex missing from triangulation');
      let seen = new Set();
      for (const i of loop) {
        if (i === E.restartIndex) { check(seen.size >= 3, 'Degenerate polygon ring'); seen = new Set(); }
        else { check(!seen.has(i), 'Repeated loop index'); seen.add(i); }
      }
    }
  }
  return result;
}
