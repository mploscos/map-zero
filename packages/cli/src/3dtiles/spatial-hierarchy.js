import { tileToBbox } from '../mvt.js';
const coarseError = 2 * Math.PI * 6378137 / 256;

/** Link occupied XYZ nodes and required empty ancestors; no global bbox tree.
 * REPLACE prevents rendering duplicate zoom representations simultaneously.
 */
export function buildSpatialHierarchy(occupied, minZoom, maxZoom, errorScale = 1) {
  const error = coarseError * errorScale;
  const nodes = new Map();
  const ensure = (z,x,y) => {
    const key=`${z}/${x}/${y}`;
    if(!nodes.has(key)) nodes.set(key,{
      boundingVolume:{region:[...tileToBbox(z,x,y).map(v=>v*Math.PI/180),-1000,10000]},
      geometricError:z<maxZoom?error/(2**z):0, refine:'REPLACE',children:[],extras:{z,x,y}
    });
    return nodes.get(key);
  };
  for(const {z,x,y,uri,region} of occupied) {
    const node=ensure(z,x,y);node.content={uri};
    if(region)node.boundingVolume.region=region.slice();
    for(let level=z-1;level>=minZoom;level--)ensure(level,Math.floor(x/2**(z-level)),Math.floor(y/2**(z-level)));
  }
  const roots=[];
  for(const node of nodes.values()){
    const {z,x,y}=node.extras;
    if(z===minZoom)roots.push(node);
    else ensure(z-1,x>>1,y>>1).children.push(node);
  }
  const finish=node=>{
    node.children.sort((a,b)=>a.extras.y-b.extras.y||a.extras.x-b.extras.x);
    node.children.forEach(finish);
    if(!node.content && node.children.length)node.boundingVolume.region=node.children[0].boundingVolume.region.slice();
    for(const child of node.children)union(node.boundingVolume.region,child.boundingVolume.region);
    if(!node.children.length){delete node.children;node.geometricError=0;}
    return node;
  };
  roots.sort((a,b)=>a.extras.y-b.extras.y||a.extras.x-b.extras.x);
  roots.forEach(finish);
  if(!roots.length)throw new Error('No occupied vector tiles');
  const region=roots[0].boundingVolume.region.slice();
  roots.slice(1).forEach(node=>union(region,node.boundingVolume.region));
  return {asset:{version:'1.1',gltfUpAxis:'Z'},geometricError:error,root:{boundingVolume:{region},geometricError:error,refine:'REPLACE',children:roots}};
}
function union(target,source){for(let i=0;i<6;i++)target[i]=(i<2||i===4?Math.min:Math.max)(target[i],source[i]);}
