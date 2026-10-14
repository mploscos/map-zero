import {mkdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {buildSpatialHierarchy} from './spatial-hierarchy.js';

/** Internal shared LOD writer. Source selects features (including zoom policy,
 * clipping and sparse occupancy); encoder has no hierarchy/file-system role.
 * The same source and occupied XYZ tree can be reused by either encoder.
 * errorScale=8 targets 256px map tiles with the default SSE=8 viewer;
 * this avoids selecting three zooms too coarse with tight height bounds.
 * Output must be a fresh directory. The caller owns staging/cleanup.
 * @param {{source:AsyncIterable<{z:number,x:number,y:number,features:object[],bbox?:number[],heightRange?:number[]}>,
 * contentEncoder:Function,out:string,minZoom:number,maxZoom:number,onTile?:Function,errorScale?:number}} options
 */
export async function createCesiumTileset({source,contentEncoder,out,minZoom,maxZoom,onTile,errorScale=8}) {
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom < 0 || maxZoom > 24 || minZoom > maxZoom || !Number.isFinite(errorScale) || errorScale <= 0) throw new Error('Invalid spatial LOD range or error scale');
  const occupied = [], seen = new Set();
  let outputBytes = 0, writtenTiles = 0, encodeMs = 0;
  for await (const tile of source) {
    const {z,x,y}=tile;
    if(!Number.isInteger(z)||z<minZoom||z>maxZoom||!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=2**z||y>=2**z)throw new Error('Invalid spatial tile coordinates');
    const key=`${z}/${x}/${y}`;if(seen.has(key))throw new Error(`Duplicate spatial tile: ${key}`);seen.add(key);
    const started = performance.now();
    const contents = await contentEncoder(tile.features, {bbox:tile.bbox});
    encodeMs += performance.now()-started;
    if (!contents.length) continue;
    const entries = [];
    for (const [i, content] of contents.entries()) {
      const uri = `${tile.z}/${tile.x}/${tile.y}${i ? `-${i}` : ''}.${content.extension}`;
      await mkdir(dirname(join(out,uri)),{recursive:true});
      await writeFile(join(out,uri),content.bytes);
      entries.push({uri}); outputBytes += content.bytes.length;
    }
    // Actual encoded geometry bounds, with float32/chord-sag allowance. The
    // map surface uses an ellipsoid; terrain height uncertainty belongs to the
    // source's optional heightRange, not a baked-in -1000..10000 m envelope.
    const west=Math.min(...contents.map(c=>c.bbox[0])),south=Math.min(...contents.map(c=>c.bbox[1]));
    const east=Math.max(...contents.map(c=>c.bbox[2])),north=Math.max(...contents.map(c=>c.bbox[3]));
    const span=Math.max(east-west,north-south)*111320;
    const heightRange=tile.heightRange??[Math.min(...contents.map(c=>c.minHeight??0)),Math.max(...contents.map(c=>c.maxHeight??0))];
    const region=[west*Math.PI/180-1e-7,south*Math.PI/180-1e-7,east*Math.PI/180+1e-7,north*Math.PI/180+1e-7,
      heightRange[0]-Math.max(2,span*span/(8*6378137)),heightRange[1]+2];
    occupied.push({z:tile.z,x:tile.x,y:tile.y,region,uri:entries[0].uri,contents:entries});
    writtenTiles++;
    await onTile?.(tile, contents);
  }
  const tree = buildSpatialHierarchy(occupied,minZoom,maxZoom,errorScale);
  const byKey = new Map(occupied.map(t=>[`${t.z}/${t.x}/${t.y}`,t]));
  const visit = node => {
    const tile = node.extras && byKey.get(`${node.extras.z}/${node.extras.x}/${node.extras.y}`);
    if(tile?.contents.length>1){delete node.content;node.contents=tile.contents;}
    node.children?.forEach(visit);
  };
  visit(tree.root); contentEncoder.declareTileset?.(tree);
  await writeFile(join(out,'tileset.json'),JSON.stringify(tree));
  return {writtenTiles,outputBytes,encodeMs,tileset:tree};
}
