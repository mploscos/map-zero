import earcut from 'earcut';
import { minMaxVec3 } from '../precision.js';
import { VECTOR_FORMAT as E, declareVectorTileset } from './extensions.js';
import { encodeMetadata } from './metadata.js';

/** Generic internal content input. Coordinates are WGS84 degrees/metres.
 * All GeoJSON point/line/polygon and multipart types are accepted. Vertical
 * semantics are source metadata; only coordinate[2] is a geometric altitude.
 * @typedef {{id?:string|number,layerId?:string,geometry:object,properties?:object,
 * minZoom?:number,maxZoom?:number,vertical?:object}} SpatialFeature
 */

/** Native vector GLB writer based on the pinned public draft specifications.
 * No Cesium module, MVT dependency, ion service or ribbon tessellation.
 * @param {SpatialFeature[]} features
 * @param {{bbox?:number[]}} [options]
 * @returns {{bytes:Buffer,extension:string,bbox:number[],maxHeight:number,count:number}[]}
 */
export function encodeVectorContent(features, options = {}) {
  if (!features.length) return [];
  if (features.length > 2 ** 24) throw new Error('Vector tile exceeds exact FLOAT feature ID range');
  const all = features.flatMap(f => coordinates(f.geometry.coordinates));
  if (!all.length) return [];
  if (all.some(p => p.length < 2 || !p.every(Number.isFinite) || Math.abs(p[1]) > 90)) throw new Error('Invalid vector coordinates');
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let minHeight = Infinity, maxHeight = -Infinity;
  for (const p of all) {
    bbox[0] = Math.min(bbox[0], p[0]); bbox[1] = Math.min(bbox[1], p[1]);
    bbox[2] = Math.max(bbox[2], p[0]); bbox[3] = Math.max(bbox[3], p[1]);
    minHeight = Math.min(minHeight, p[2] ?? 0); maxHeight = Math.max(maxHeight, p[2] ?? 0);
  }
  const frame = options.bbox ?? bbox;
  const origin = ecef([(frame[0] + frame[2]) / 2, (frame[1] + frame[3]) / 2]);
  const chunks = [], bufferViews = [], accessors = [], meshes = [], nodes = [], rows = [];
  let byteLength = 0, usesRestart = false, usesPolygons = false;
  const warnings = {degeneratePolygons:0, collapsedHoles:0};
  function addView(array, alignment = 4, target) {
    const pad = (alignment - byteLength % alignment) % alignment;
    if (pad) { chunks.push(Buffer.alloc(pad)); byteLength += pad; }
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const index = bufferViews.length;
    // A zero-length STRING values stream still needs a valid nonempty view.
    const stored = bytes.length ? bytes : Buffer.alloc(1);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: stored.length, ...(target ? { target } : {}) });
    chunks.push(stored); byteLength += stored.length;
    return index;
  }
  function accessor(array, type = 'SCALAR', target) {
    const componentType = array instanceof Float32Array ? 5126 : 5125;
    const index = accessors.length;
    accessors.push({ bufferView: addView(array, 4, target), componentType, count: array.length / (type === 'VEC3' ? 3 : 1), type,
      ...(type === 'VEC3' ? minMaxVec3(array) : {}) });
    return index;
  }
  const layers = new Map();
  for (const feature of features) {
    const id = feature.layerId ?? feature.properties?.mapzero_layer ?? feature.properties?._layer ?? 'features';
    if (!layers.has(id)) layers.set(id, []);
    layers.get(id).push(feature);
  }
  for (const [layerId, layerFeatures] of layers) {
    const groups = new Map([0, 3, 4].map(mode => [mode, { positions: [], ids: [], indices: [], loops: [], loopOffsets: [], triangleOffsets: [] }]));
    for (const feature of layerFeatures) {
      const type = feature.geometry.type, c = feature.geometry.coordinates;
      if (!['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(type)) throw new Error(`Unsupported vector geometry: ${type}`);
      const featureId = rows.length;
      const props = { ...feature.properties };
      if (feature.id !== undefined && props.id === undefined) props.id = feature.id;
      if (feature.minZoom !== undefined) props.mapzero_minzoom = feature.minZoom;
      if (feature.maxZoom !== undefined) props.mapzero_maxzoom = feature.maxZoom;
      if (feature.vertical !== undefined) props.mapzero_vertical = feature.vertical;
      rows.push({ ...props, _layer: layerId, mapzero_layer: layerId, mapzero_geometry: type,
        mapzero_properties_json: JSON.stringify(feature.properties ?? {}) });
      function vertex(group, p) {
        const index = group.positions.length / 3;
        const world = ecef(p);
        const local = world.map((n, i) => n - origin[i]);
        group.positions.push(local[0], local[2], -local[1]); group.ids.push(featureId);
        return index;
      }
      if (type.includes('Point')) {
        const group = groups.get(0);
        for (const p of type === 'Point' ? [c] : c) vertex(group, p);
      } else if (type.includes('LineString')) {
        const group = groups.get(3);
        for (const line of type === 'LineString' ? [c] : c) {
          if (line.length < 2) continue;
          if (group.indices.length) { group.indices.push(E.restartIndex); usesRestart = true; }
          for (const p of line) group.indices.push(vertex(group, p));
        }
      } else {
        const group = groups.get(4);
        for (const polygon of type === 'Polygon' ? [c] : c) {
          let rings = polygon.map(stripClosing);
          if (!rings[0] || rings[0].length < 3 || signedArea(rings[0].map(project)) === 0) {warnings.degeneratePolygons++;continue;}
          rings = rings.filter((r, i) => {const keep=r.length>=3 && signedArea(r.map(project))!==0;if(!keep && i)warnings.collapsedHoles++;return keep;});
          // Normalize exterior CCW, interior CW in a Mercator tangent chart.
          let projected = rings.map(r => r.map(project));
          for (let i = 0; i < rings.length; i++) if ((signedArea(projected[i]) > 0) !== (i === 0)) {
            rings[i].reverse(); projected[i].reverse();
          }
          let triangles;
          // Quantized/simplified source polygons may have collapsed holes.
          // Remove only rings Earcut cannot retain as a loop, re-triangulate,
          // and report every such repair; never emit invalid draft topology.
          while (true) {
            const holes = []; let n = 0;
            rings.forEach((ring, i) => { if (i) holes.push(n); n += ring.length; });
            triangles = earcut(projected.flat().flat(), holes, 2);
            const used = new Set(triangles); let offset = 0;
            const keep = rings.map(ring => {const count=ring.reduce((sum,_,i)=>sum+Number(used.has(offset+i)),0);offset+=ring.length;return count>=3;});
            if (!keep[0]) {triangles=[];warnings.degeneratePolygons++;break;}
            if (keep.every(Boolean)) break;
            warnings.collapsedHoles += keep.filter(k=>!k).length;
            rings = rings.filter((_,i)=>keep[i]); projected = projected.filter((_,i)=>keep[i]);
          }
          if (!triangles.length) continue;
          if (group.loops.length) group.loops.push(E.restartIndex);
          group.loopOffsets.push(group.loops.length); group.triangleOffsets.push(group.indices.length);
          // Earcut removes redundant/collinear vertices. The draft requires
          // every loop index to occur in the triangle index stream.
          const used = new Set(triangles), remap = new Map();
          let relative = 0, emittedLoops = 0;
          rings.forEach(ring => {
            const loop = [];
            for (const p of ring) {
              if (used.has(relative)) {
                const index = vertex(group, p);
                remap.set(relative, index); loop.push(index);
              }
              relative++;
            }
            if (!loop.length) return;
            if (emittedLoops++) group.loops.push(E.restartIndex);
            group.loops.push(...loop);
          });
          for (const index of triangles) group.indices.push(remap.get(index));
          usesPolygons = true;
          if (group.loops.includes(E.restartIndex)) usesRestart = true;
        }
      }
    }
    const primitives = [];
    for (const [mode, group] of groups) {
      if (!group.positions.length) continue;
      const primitive = { mode, attributes: {
        POSITION: accessor(new Float32Array(group.positions), 'VEC3', 34962),
        _FEATURE_ID_0: accessor(new Float32Array(group.ids), 'SCALAR', 34962)
      }, extensions: { [E.features]: { featureIds: [{ featureCount: 0, attribute: 0, propertyTable: 0 }] } } };
      if (mode !== 0) primitive.indices = accessor(new Uint32Array(group.indices), 'SCALAR', 34963);
      if (mode === 4) primitive.extensions[E.polygon] = {
        count: group.loopOffsets.length,
        indicesOffsets: accessor(new Uint32Array(group.triangleOffsets)),
        loopIndices: accessor(new Uint32Array(group.loops)),
        loopIndicesOffsets: accessor(new Uint32Array(group.loopOffsets))
      };
      primitives.push(primitive);
    }
    if (primitives.length) { nodes.push({ name: layerId, mesh: meshes.length, translation: [origin[0],origin[2],-origin[1]] }); meshes.push({ primitives }); }
  }
  if (!meshes.length) return [];
  for (const mesh of meshes) for (const primitive of mesh.primitives) primitive.extensions[E.features].featureIds[0].featureCount = rows.length;
  const metadata = encodeMetadata(rows, addView);
  const extensionsUsed = [E.features, E.metadata, ...(usesPolygons ? [E.polygon] : []), ...(usesRestart ? [E.restart] : [])];
  const json = { asset: { version: '2.0', generator: 'map-zero 0.5.0 vector (CesiumJS 1.145)' }, scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors, bufferViews, buffers: [{ byteLength }],
    extensionsUsed, ...(usesRestart ? { extensionsRequired: [E.restart] } : {}), extensions: { [E.metadata]: metadata } };
  return [{ bytes: packGlb(json, Buffer.concat(chunks)), extension: 'glb', bbox, minHeight, maxHeight, count: rows.length, warnings }];
}
encodeVectorContent.declareTileset = declareVectorTileset;
encodeVectorContent.metadata = E.metadata;

function coordinates(c) { return !c?.length ? [] : typeof c[0] === 'number' ? [c] : c.flatMap(coordinates); }
function stripClosing(ring) {
  ring = ring.filter((p, i) => i === 0 || !p.every((n, axis) => n === ring[i-1][axis]));
  return ring.length > 1 && ring[0].every((n, i) => n === ring.at(-1)[i]) ? ring.slice(0, -1) : ring.slice();
}
function project(p) { return [p[0] * Math.PI / 180, Math.asinh(Math.tan(p[1] * Math.PI / 180))]; }
function signedArea(ring) { let area = 0; const [x,y]=ring[0]??[0,0]; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0]-x) * (ring[i][1]-y) - (ring[i][0]-x) * (ring[j][1]-y); return area / 2; }
function ecef([longitude, latitude, height = 0]) {
  const lon = longitude * Math.PI / 180, lat = latitude * Math.PI / 180;
  const normal = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const squaredRadii = [6378137 ** 2, 6378137 ** 2, 6356752.3142451793 ** 2];
  const k = normal.map((n, i) => n * squaredRadii[i]);
  const gamma = Math.sqrt(normal.reduce((sum, n, i) => sum + n * k[i], 0));
  return k.map((n, i) => n / gamma + normal[i] * height);
}
function packGlb(json, bin) {
  const text = Buffer.from(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4, binLength = Math.ceil(bin.length / 4) * 4;
  const result = Buffer.alloc(28 + jsonLength + binLength);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonLength, 12); result.writeUInt32LE(0x4e4f534a, 16); result.fill(32, 20, 20 + jsonLength); text.copy(result, 20);
  result.writeUInt32LE(binLength, 20 + jsonLength); result.writeUInt32LE(0x004e4942, 24 + jsonLength); bin.copy(result, 28 + jsonLength);
  return result;
}
