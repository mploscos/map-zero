/** Generic feature partitioning. Source owns extraction; emit owns encoding
 * and persistence. Half-open spatial ownership belongs to the source query.
 * Bounds are propagated from emitted geometry, never guessed from cell bounds.
 * The same tree is used for mesh and vector content.
 */
export async function partitionFeatures({source, bounds, maxFeatures, maxDepth, emit, onDepth = () => {}}) {
  async function partition(box, depth) {
    const count = source.count(box);
    if (!count) return null;
    onDepth(depth);
    const nodes = [];
    if (count > maxFeatures && depth < maxDepth) {
      const [w,s,e,n] = box, x = (w+e)/2, y = (s+n)/2;
      for (const child of [[w,s,x,y],[x,s,e,y],[w,y,x,n],[x,y,e,n]]) {
        const node = await partition(child, depth+1);
        if (node) nodes.push(node);
      }
    } else {
      let features = [];
      for (const feature of source.features(box)) {
        features.push(feature);
        if (features.length >= maxFeatures) { nodes.push(...await emit(features)); features = []; }
      }
      if (features.length) nodes.push(...await emit(features));
    }
    return !nodes.length ? null : nodes.length === 1 ? nodes[0] : groupNodes(nodes);
  }
  return partition(bounds, 0);
}

/** A spatial hierarchy with geometry bounds propagated through every ancestor. */
function groupNodes(children) {
  const regions = children.map(child => child.boundingVolume.region);
  const region = Array.from({length:6},(_,i) => (i<2 || i===4 ? Math.min : Math.max)(...regions.map(r=>r[i])));
  return {boundingVolume:{region},geometricError:Math.max(region[2]-region[0],region[3]-region[1])*6378137,
    refine:'ADD',children};
}
