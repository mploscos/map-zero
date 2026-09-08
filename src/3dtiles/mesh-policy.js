const STRATEGIES = new Set(['extruded', 'surface', 'line', 'points', 'mixed']);
// OSM defaults are adapter policy; unknown IDs use the geometry-driven path.
const DEFAULTS = {
  buildings: { strategy: 'extruded', height: 0 },
  landuse: { strategy: 'surface', height: 3 }, water: { strategy: 'mixed', height: 5 },
  roads: { strategy: 'line', height: 10, widthMeters: 6 },
  railways: { strategy: 'line', height: 11, widthMeters: 3 },
  boundaries: { strategy: 'line', height: 12, widthMeters: 20 },
  terrain: { strategy: 'line', height: 6, widthMeters: 3 },
  coastline: { strategy: 'line', height: 7, widthMeters: 3 },
  cliffs: { strategy: 'line', height: 8, widthMeters: 3 },
  pois: { strategy: 'points', height: 12 }, aip: { strategy: 'mixed', height: 9, widthMeters: 14 }
};

/** Existing OSM defaults and generic descriptor overrides, shared by exporters. */
export function resolveMeshPolicy(layer) {
  const policy = { strategy:'mixed', height:6, widthMeters:6,
    ...DEFAULTS[layer.id === 'aviation' ? 'aip' : layer.id], ...layer.tiles3d };
  if (!STRATEGIES.has(policy.strategy)) throw new Error(`unsupported 3D strategy: ${policy.strategy}`);
  for (const key of ['height','widthMeters']) if (!Number.isFinite(policy[key]) || policy[key] < 0) throw new Error(`invalid 3D ${key}`);
  return policy;
}
