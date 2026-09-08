import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SUPPORTED_LAYERS, geoPackageLayersForOsm } from '../../src/layers.js';
import { writeGeoPackage } from '../../src/gpkg.js';
import { openGeoPackageReader } from '../../src/gpkg-read.js';
import { tileToBbox } from '../../src/mvt.js';

// Exercise SQL selection, layer/global budgets, labels, size filtering and
// simplification with deterministic features scaled to each tested tile.
export async function osmFixture(z) {
  const dir = await mkdtemp(join(tmpdir(), 'map-zero-osm-mvt-'));
  const x = 2 ** (z - 1), y = x - 1;
  const bbox = tileToBbox(z, x, y);
  const coordinate = (a, b) => [bbox[0] + a * (bbox[2] - bbox[0]), bbox[1] + b * (bbox[3] - bbox[1])];
  const geometry = (type, i) => {
    const a = 0.15 + (i % 11) * 0.02, b = 0.15 + (i % 13) * 0.02;
    const size = [0.3, 0.04, 0.008, 0.002, 0.0002][i % 5];
    const line = [coordinate(a, b), coordinate(a + size / 2, b + size / 3), coordinate(a + size, b + size)];
    const ring = [coordinate(a, b), coordinate(a + size, b), coordinate(a + size, b + size), coordinate(a, b + size), coordinate(a, b)];
    if (type === 'POINT') return { type: 'Point', coordinates: coordinate(a, b) };
    if (type === 'LINESTRING') return { type: 'LineString', coordinates: line };
    if (type === 'MULTIPOLYGON') return { type: 'MultiPolygon', coordinates: [[ring]] };
    return [
      { type: 'Point', coordinates: coordinate(a, b) },
      { type: 'LineString', coordinates: line },
      { type: 'Polygon', coordinates: [ring] },
      { type: 'MultiLineString', coordinates: [line] },
      { type: 'MultiPolygon', coordinates: [[ring]] }
    ][i % 5];
  };
  const classes = {
    roads: ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'footway'],
    aip: ['runway', 'taxiway', 'apron', 'terminal', 'helipad', 'hangar', 'aerodrome'],
    pois: ['hospital', 'police', 'restaurant', 'fire_station', 'bus_station', 'townhall'],
    landuse: ['forest', 'residential', 'commercial', 'grass', 'industrial']
  };
  const schemas = geoPackageLayersForOsm(SUPPORTED_LAYERS);
  const data = Object.fromEntries(schemas.map((schema) => [schema.id, Array.from({
    length: schema.id === 'roads' ? 5200 : schema.id === 'buildings' ? 1200 : schema.id === 'pois' ? 220 : 35
  }, (_, i) => ({
    geometry: geometry(schema.geometryType, i),
    properties: {
      id: `${schema.id}-${i}`, name: i % 9 ? `Place ${i}` : 'yes', ref: i % 7 ? `R${i}` : '',
      highway: classes.roads[i % classes.roads.length], building: i % 2 ? 'yes' : 'industrial',
      height: String(i % 60), 'building:levels': String(i % 8),
      aeroway: classes.aip[i % classes.aip.length], amenity: classes.pois[i % classes.pois.length],
      landuse: classes.landuse[i % classes.landuse.length],
      natural: schema.id === 'coastline' ? 'coastline' : schema.id === 'cliffs' ? 'cliff' : ['water', 'beach', 'sand', 'wood'][i % 4],
      railway: 'rail', admin_level: String(2 + i % 9)
    }
  }))]));
  const gpkgPath = join(dir, 'data.gpkg');
  writeGeoPackage(gpkgPath, data, schemas, bbox);
  const reader = openGeoPackageReader({ gpkgPath, manifest: { layers: SUPPORTED_LAYERS } });
  return { reader, z, x, y, async close() { reader.close(); await rm(dir, { recursive: true, force: true }); } };
}

export const osmCases = [
  ...[7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((z) => ({ name: `default-${z}`, z })),
  { name: 'overview-budget', z: 12, options: { detail: 'overview', maxFeatures: 37 } },
  { name: 'full-budget', z: 14, options: { detail: 'full', maxFeatures: 37 } },
  ...[12, 13, 15, 17, 18].map((z) => ({ name: `labels-${z}`, z, layers: ['road_labels', 'aip_labels', 'poi_labels'] })),
  { name: 'aviation-aliases', z: 14, layers: ['aviation', 'aviation_labels'] },
  { name: 'poi-style', z: 17, layers: ['pois', 'poi_labels'], options: { style: {
    layers: { pois: { categories: { consumer: true, emergency: false }, classes: { amenity: ['restaurant', 'bus_station'] } } }
  } } }
];

export function osmSnapshot(encode, fixture, scenario) {
  const queries = [];
  const reader = {
    getLayers: () => fixture.reader.getLayers(),
    getTileFeatures(id, bbox, filters) {
      queries.push({ id, bbox, filters });
      return fixture.reader.getTileFeatures(id, bbox, filters);
    }
  };
  const { buffer, ...stats } = encode(reader, fixture.z, fixture.x, fixture.y, scenario.layers, scenario.options);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  return { tile: hash(buffer), queries: hash(JSON.stringify(queries)), stats };
}
