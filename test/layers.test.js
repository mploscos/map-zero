import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAYER_DEFINITIONS,
  SUPPORTED_LAYERS,
  layersForRelation,
  layersForWay
} from '../src/layers.js';

test('terrain edge layers are supported OSM layers', () => {
  assert.ok(SUPPORTED_LAYERS.includes('terrain'));
  assert.ok(SUPPORTED_LAYERS.includes('coastline'));
  assert.ok(SUPPORTED_LAYERS.includes('cliffs'));
  assert.equal(LAYER_DEFINITIONS.terrain.gpkgGeometryType, 'MULTIPOLYGON');
  assert.equal(LAYER_DEFINITIONS.coastline.gpkgGeometryType, 'GEOMETRY');
  assert.equal(LAYER_DEFINITIONS.cliffs.gpkgGeometryType, 'GEOMETRY');
});

test('terrain edge tags map to cartographic overlay layers', () => {
  const selected = new Set(SUPPORTED_LAYERS);
  assert.deepEqual(layersForWay({ natural: 'coastline' }, selected), ['coastline']);
  assert.deepEqual(layersForWay({ natural: 'cliff' }, selected), ['cliffs']);
  assert.deepEqual(layersForWay({ natural: 'beach' }, selected), ['terrain']);
  assert.deepEqual(layersForWay({ natural: 'sand' }, selected), ['terrain']);
  assert.deepEqual(layersForRelation({ natural: 'beach' }, selected), ['terrain']);
});
