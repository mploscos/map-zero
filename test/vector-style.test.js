import assert from 'node:assert/strict';
import test from 'node:test';
import { Color } from 'cesium';
import { createNativeVectorStyle, vectorZoomRange } from '../packages/cesium/src/vector.js';
import { buildGlbFromMesh } from '../src/3dtiles/glb.js';

const feature = (values) => ({ getProperty: (key) => values[key] });

test('native vector styles share theme overrides and independent layer controls', () => {
  const document = { layers: { roads: { stroke: '#ff0000', strokeWidth: 2, byProperty: { highway: { primary: { stroke: '#00ff00', strokeWidth: 4 } } } }, buildings: {} } };
  const style = createNativeVectorStyle(document, { zoom: 16, opacities: new Map([['roads', 0.5]]), excludedLayers: new Set(['buildings']) });
  const road = feature({ _layer: 'roads', highway: 'primary' });
  const color = style.color.evaluate(road, new Color());
  assert.equal(color.green, 1);
  assert.equal(color.alpha, 0.5);
  assert.ok(style.lineWidth.evaluate(road) > 4);
  assert.equal(style.show.evaluate(feature({ _layer: 'buildings' })), false);
  assert.equal(style.show.evaluate(road), true);
});

test('native provider bounds regional hierarchy allocation without requesting nonexistent zooms', () => {
  const city = vectorZoomRange([-3.71, 40.41, -3.69, 40.43], 8, 16);
  assert.equal(city.maxZoom, 16);
  const region = vectorZoomRange([-10, 35, 5, 44], 8, 16);
  assert.ok(region.maxZoom < 16);
  assert.ok(region.estimatedNodes <= 20000);
  assert.throws(() => vectorZoomRange(undefined), /bbox/);
  assert.throws(() => vectorZoomRange([-180, -85, 180, 85], 16, 16), /too large/);
});

test('GLB omits redundant indices and declares aligned quantized normals', () => {
  const glb = buildGlbFromMesh({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint16Array([0, 1, 2]), min: [0, 0, 0], max: [1, 1, 0] }, { includeNormals: true });
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  assert.equal(json.meshes[0].primitives[0].indices, undefined);
  assert.ok(json.extensionsRequired.includes('KHR_mesh_quantization'));
  const normal = json.accessors[json.meshes[0].primitives[0].attributes.NORMAL];
  assert.equal(normal.count, 3);
  assert.equal(json.bufferViews[normal.bufferView].byteStride, 4);
});


test('mixed-layer polygons use fill opacity and POIs use their fill color', () => {
  const style = createNativeVectorStyle({ layers: {
    boundaries: { fill: '#220044', fillOpacity: 0.06, stroke: '#8844ff', strokeOpacity: 0.45 },
    pois: { fill: '#ffff00', stroke: '#000000' }
  } });
  const polygon = feature({ _layer: 'boundaries', mapzero_geometry: 'Polygon' });
  const line = feature({ _layer: 'boundaries', mapzero_geometry: 'LineString' });
  assert.equal(style.color.evaluate(polygon, new Color()).alpha, 0.06);
  assert.equal(style.color.evaluate(line, new Color()).alpha, 0.45);
  assert.equal(style.color.evaluate(feature({ _layer: 'pois', mapzero_geometry: 'Point' }), new Color()).red, 1);
});
