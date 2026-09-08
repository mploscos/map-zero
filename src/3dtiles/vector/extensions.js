/** Internal Technology Preview contract. Re-audit on every Cesium upgrade. */
export const VECTOR_FORMAT = Object.freeze({
  cesium: '1.145.0',
  content: '3DTILES_content_gltf_vector',
  restart: 'KHR_mesh_primitive_restart',
  polygon: 'EXT_mesh_polygon',
  features: 'EXT_mesh_features',
  metadata: 'EXT_structural_metadata',
  restartIndex: 0xffffffff,
  specs: Object.freeze({
    content: 'c48ebdc8db43dc00917b4f200eff5e2131d7e493',
    polygon: 'c1a035499b70aeb5d8281470101423e5e285dfe3',
    restart: '9811e8407d4533500cfc6b10e3bc408345035a6f'
  })
});

/** Keep draft declarations out of the spatial writer. Never mix ordinary
 * building contents in this tileset: Cesium 1.145 dispatches globally.
 * clip is deliberately omitted: 1.145 does not implement the draft flag.
 */
export function declareVectorTileset(tileset) {
  tileset.asset.version = '1.1';
  delete tileset.asset.gltfUpAxis; // New GLBs use the standard glTF Y-up frame.
  tileset.extensionsUsed = [...new Set([...(tileset.extensionsUsed ?? []), VECTOR_FORMAT.content])];
  const visit = node => {
    for (const content of node.contents ?? (node.content ? [node.content] : [])) {
      content.extensions = { ...content.extensions, [VECTOR_FORMAT.content]: { vector: true } };
    }
    node.children?.forEach(visit);
  };
  visit(tileset.root);
  return tileset;
}
