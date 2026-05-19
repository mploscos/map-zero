export function pmtilesInfo(manifest) {
  const tiles = manifest.tiles && typeof manifest.tiles === 'object' ? manifest.tiles : {};
  if (tiles.format === 'pmtiles' || tiles.type === 'mvt') {
    return tiles;
  }
  const vector = manifest.vectorTiles && typeof manifest.vectorTiles === 'object' ? manifest.vectorTiles : {};
  const pmtiles = vector.pmtiles && typeof vector.pmtiles === 'object' ? vector.pmtiles : {};
  return pmtiles;
}
