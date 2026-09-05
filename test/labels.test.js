import assert from 'node:assert/strict';
import test from 'node:test';
import { labelAnchorForGeometry } from '../src/mvt.js';
import { describeLabel } from '../packages/core/src/labels.js';
import { selectLabels } from '../packages/cesium/src/cesium-labels.js';

const feature = (properties) => ({ get: (key) => properties[key] });
const theme = { labels: { enabled: true, roads: { enabled: true, minZoom: 12 }, pois: { enabled: true, minZoom: 16 } } };

test('label anchors use length, longest parts and polygon interiors outside holes', () => {
  assert.deepEqual(labelAnchorForGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 0], [10, 0]] }), [5, 0]);
  assert.deepEqual(labelAnchorForGeometry({ type: 'MultiLineString', coordinates: [[[0, 2], [2, 2]], [[0, 0], [10, 0]]] }), [5, 0]);
  const anchor = labelAnchorForGeometry({ type: 'Polygon', coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]
  ] });
  assert.ok(anchor[0] > 0 && anchor[0] < 10 && anchor[1] > 0 && anchor[1] < 10);
  assert.ok(!(anchor[0] > 2 && anchor[0] < 8 && anchor[1] > 2 && anchor[1] < 8));
  assert.equal(labelAnchorForGeometry({ type: 'Polygon', coordinates: [] }), null);
});

test('shared labels respect zoom, meaningful road refs, selected POIs and disabled themes', () => {
  const road = feature({ highway: 'primary', ref: 'A-5' });
  assert.equal(describeLabel(road, 'roads', 11, theme), null);
  assert.equal(describeLabel(road, 'roads', 16, theme).text, 'A-5');
  assert.equal(describeLabel(feature({ highway: 'service', ref: 'A-5' }), 'roads', 18, theme), null);
  assert.equal(describeLabel(feature({ amenity: 'cafe', name: 'Coffee' }), 'pois', 18, theme), null);
  const hospital = feature({ amenity: 'hospital', name: 'Hospital Central' });
  assert.equal(describeLabel(hospital, 'pois', 15, theme), null);
  assert.equal(describeLabel(hospital, 'pois', 16, theme).text, 'Hospital Central');
  assert.equal(describeLabel(hospital, 'pois', 18, { labels: { ...theme.labels, enabled: false } }), null);
});

test('decluttering prefers priority, deduplicates tile/LOD copies and bounds the result', () => {
  const candidate = (key, priority, box) => ({ key, priority, box });
  const values = [candidate('low', 1, [0, 0, 100, 20]), candidate('high', 10, [0, 0, 100, 20]),
    candidate('high', 10, [110, 0, 210, 20]), candidate('next', 5, [110, 0, 210, 20]), candidate('last', 0, [220, 0, 320, 20])];
  assert.deepEqual(selectLabels(values, 2).map(({ key }) => key), ['high', 'next']);
});
