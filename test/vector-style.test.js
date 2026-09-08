import assert from 'node:assert/strict';
import test from 'node:test';
import { Color } from 'cesium';
import { createStaticTileStyle, createStaticTileStyleFactory } from '../packages/cesium/src/static-style.js';
import { buildGlbFromMesh } from '../src/3dtiles/glb.js';

const feature = (values) => ({ getProperty: (key) => values[key] });

test('static 3D styles share theme overrides and independent layer controls', () => {
  const document = { layers: { roads: { stroke: '#ff0000', strokeWidth: 2, byProperty: { highway: { primary: { stroke: '#00ff00', strokeWidth: 4 } } } }, buildings: {} } };
  const style = createStaticTileStyle(document, { zoom: 16, opacities: new Map([['roads', 0.5]]), excludedLayers: new Set(['buildings']) });
  const road = feature({ _layer: 'roads', highway: 'primary' });
  const color = style.color.evaluate(road, new Color());
  assert.equal(color.green, 1);
  assert.equal(color.alpha, 0.5);
  assert.equal(style.lineWidth.evaluate(road), 5.12);
  assert.equal(style.show.evaluate(feature({ _layer: 'buildings' })), false);
  assert.equal(style.show.evaluate(road), true);
});

test('static feature zoom metadata restricts visibility', () => {
  const style = createStaticTileStyle({}, { zoom: 10 });
  assert.equal(style.show.evaluate(feature({mapzero_layer:'custom',mapzero_minzoom:11})), false);
  assert.equal(style.show.evaluate(feature({mapzero_layer:'custom',mapzero_maxzoom:9})), false);
  assert.equal(style.show.evaluate(feature({mapzero_layer:'custom',mapzero_minzoom:10,mapzero_maxzoom:10})), true);
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
  const style = createStaticTileStyle({ layers: {
    boundaries: { fill: '#220044', fillOpacity: 0.06, stroke: '#8844ff', strokeOpacity: 0.45 },
    pois: { fill: '#ffff00', stroke: '#000000' }
  } });
  const polygon = feature({ _layer: 'boundaries', mapzero_geometry: 'Polygon' });
  const line = feature({ _layer: 'boundaries', mapzero_geometry: 'LineString' });
  assert.equal(style.color.evaluate(polygon, new Color()).alpha, 0.06);
  assert.equal(style.color.evaluate(line, new Color()).alpha, 0.45);
  assert.equal(style.color.evaluate(feature({ _layer: 'pois', mapzero_geometry: 'Point' }), new Color()).red, 1);
});

test('aviation aliases use shared colors while retaining public control identity',()=>{
  const style=createStaticTileStyle({layers:{aip:{fill:'#ff0000'}}},{opacities:new Map([['aviation',0.5]])});
  const item=feature({mapzero_layer:'aviation',mapzero_geometry:'Point'});
  assert.equal(style.color.evaluate(item,new Color()).alpha,0.5);
  assert.equal(style.color.evaluate(item,new Color()).red,1);
});

test('style updates reuse feature rules and parsed colors without freezing runtime controls', () => {
  let parses = 0, merges = 0, reads = 0;
  const original = Color.fromCssColorString;
  Color.fromCssColorString = (...args) => { parses++; return original(...args); };
  try {
    const makeStyle = createStaticTileStyleFactory({ layers: { custom: {
      byProperty: { kind: { main: { get fill() { merges++; return 'rgba(255,0,0,0.5)'; }, fillOpacity: 0.8 } } }
    } } }, { manifest: { layers: [{ id: 'custom', minZoom: 5, maxZoom: 15 }] } });
    const items = Array.from({ length: 100 }, (_, id) => ({ getProperty(key) {
      reads++;
      return { id, kind: 'main', mapzero_layer: 'custom', mapzero_geometry: 'Point', mapzero_minzoom: 8, mapzero_maxzoom: 12 }[key];
    } }));
    const visibility = new Map(), opacities = new Map();
    const scratch = new Color();
    const initial = makeStyle({ zoom: 10, visibility, opacities });
    for (const item of items) {
      assert.equal(initial.color.evaluateColor(item, scratch), scratch);
      assert.equal(scratch.alpha, 0.4);
      assert.equal(initial.show.evaluate(item), true);
      assert.equal(initial.pointSize.evaluate(item), 6);
    }
    assert.equal(parses, 1);
    assert.equal(merges, 1, 'classification rule merged once for all matching features');
    const initialReads = reads;
    for (const zoom of [7, 8, 12, 13, 16]) {
      const updated = makeStyle({ zoom, visibility, opacities });
      assert.equal(updated.show.evaluate(items[0]), zoom >= 8 && zoom <= 12);
      opacities.set('custom', 0.25);
      const color = updated.color.evaluate(items[0]);
      assert.equal(color.alpha, 0.1);
      color.red = 0; // Never mutate the cached color or accumulate alpha.
      assert.equal(updated.color.evaluate(items[0], scratch).red, 1);
      visibility.set('custom', false);
      assert.equal(updated.show.evaluate(items[0]), false);
      visibility.delete('custom');
    }
    assert.equal(reads, initialReads, 'no metadata reads when styling cached features at another zoom');
    assert.equal(parses, 1);
    assert.equal(merges, 1);
    assert.equal(makeStyle({ excludedLayers: new Set(['custom']) }).show.evaluate(items[0]), false);
    const fresh = createStaticTileStyle({ layers: { custom: { fill: '#0000ff' } } });
    assert.equal(fresh.color.evaluate(items[0]).blue, 1, 'a replacement theme has an independent cache');
  } finally {
    Color.fromCssColorString = original;
  }
});

test('classification cache preserves ordered overrides, missing values and fallback groups', () => {
  let fallbackReads = 0;
  const style = createStaticTileStyle({ layers: { custom: {
    get stroke() { fallbackReads++; return '#ff0000'; },
    byProperty: {
      kind: { '': { stroke: '#00ff00' }, primary: { body: { color: '#0000ff' } } },
      status: { closed: { body: { color: '#ffffff' }, visible: false } }
    }
  } } });
  const item = values => feature({ mapzero_layer: 'custom', mapzero_geometry: 'LineString', ...values });
  assert.equal(style.color.evaluate(item({ kind: 'unknown' })).red, 1);
  assert.equal(style.color.evaluate(item({ kind: 'another unknown' })).red, 1);
  assert.equal(style.color.evaluate(item({})).green, 1);
  assert.equal(style.color.evaluate(item({ kind: null })).green, 1);
  assert.equal(style.color.evaluate(item({ kind: 'primary' })).blue, 1);
  const closed = item({ kind: 'primary', status: 'closed' });
  assert.equal(style.color.evaluate(closed).red, 1);
  assert.equal(style.show.evaluate(closed), false);
  assert.equal(fallbackReads, 1, 'base layer rule is normalized once');
});

test('cached paints distinguish mixed geometries and preserve CSS alpha and invalid-color fallback', () => {
  const makeStyle = createStaticTileStyleFactory({ layers: { mixed: {
    fill: '#ff000080', fillOpacity: 0.5, stroke: 'invalid', strokeOpacity: 0.25
  } } });
  const style = makeStyle({ opacity: 0.5 });
  const point = feature({ mapzero_layer: 'mixed', mapzero_geometry: 'Point' });
  const polygon = feature({ mapzero_layer: 'mixed', mapzero_geometry: 'Polygon' });
  const line = feature({ mapzero_layer: 'mixed', mapzero_geometry: 'LineString' });
  assert.equal(style.color.evaluate(point).alpha, (128 / 255) * 0.25);
  assert.equal(style.color.evaluate(polygon).alpha, (128 / 255) * 0.25);
  assert.equal(style.color.evaluate(line).green, 1);
  assert.equal(style.color.evaluate(line).blue, 1);
  assert.equal(style.color.evaluate(line).alpha, 0.125);
});
