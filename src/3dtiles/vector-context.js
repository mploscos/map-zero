import { join } from 'node:path';
import { openGeoPackageReader } from '../gpkg-read.js';
import { encodeMvtTileSetWithStats, tileToBbox } from '../mvt.js';
import { createSparseTilePlan } from '../pmtiles-plan.js';
import { labelAnchorForGeometry } from '../mvt-utils.js';
import { getLayerRule, mergeFeatureRule } from '../../packages/core/src/style.js';
import { createCesiumTileset } from './create-tileset.js';
import { encodeVectorContent } from './vector/encode-vector-gltf.js';
import decodeMvt from './mvt/decode.js';
import { decodedFeatures } from './mvt/features.js';

/** Export the shared, occupied context hierarchy using the existing MVT policy.
 * MVT bytes are an in-memory build intermediate, never a runtime requirement.
 * @param {{packageDir:string,manifest:object,layers:object[],out:string,style:object,
 * minZoom:number,maxZoom:number,onProgress?:Function}} options
 */
export async function exportVectorContext({packageDir,manifest,layers,out,style,minZoom,maxZoom,onProgress}) {
  const reader = openGeoPackageReader({gpkgPath:join(packageDir,manifest.data ?? 'data.gpkg'),manifest});
  const byId = new Map(layers.map(layer=>[layer.id,layer]));
  const ids = [...byId.keys()], summary = {};
  const rules = new Map(layers.map(layer=>[layer.id,getLayerRule(style,layer)]));
  const planner = {...reader,getLayers:()=>reader.getLayers().filter(layer=>byId.has(layer.id))};
  let candidates = 0, empty = 0;
  async function* source() {
    for(let z=minZoom;z<=maxZoom;z++) {
      const plan = createSparseTilePlan(planner,z,tileRange(manifest.bbox,z),(bbox,zoom)=>tileRange(bbox,zoom,1));
      onProgress?.({phase:'zoom',zoom:z,candidates:plan.tileCount});
      for(const range of plan.ranges) for(let x=range.minX;x<=range.maxX;x++) for(let y=range.minY;y<=range.maxY;y++) {
        candidates++;
        const encoded=encodeMvtTileSetWithStats(reader,z,x,y,ids,{style});
        if(!encoded.encodedFeatureCount){empty++;continue;}
        const features=decodedFeatures(decodeMvt(Uint8Array.from(encoded.buffer).buffer),z,x,y);
        for(const feature of features) {
          const layer=byId.get(feature.layerId),props=feature.properties;
          const rule=mergeFeatureRule(rules.get(layer.id),{get:key=>props[key]});
          const first=layer.featureZoom?.minColumn,last=layer.featureZoom?.maxColumn;
          props.mapzero_minzoom=Math.max(layer.minZoom??0,rule.minZoom??0,first ? props[first]??0 : 0);
          props.mapzero_maxzoom=Math.min(layer.maxZoom??24,rule.maxZoom??24,last ? props[last]??24 : 24);
          const anchor=labelAnchorForGeometry(feature.geometry);
          if(anchor && ['name','ref','iata','icao','operator','official_name','short_name'].some(key=>props[key])) {
            props.mapzero_label_lon=anchor[0];props.mapzero_label_lat=anchor[1];
          }
          const stats=summary[layer.id]??={encoding:'vector',featureCount:0,tiles:0,minZoom:24,maxZoom:0};
          stats.featureCount++;stats.minZoom=Math.min(stats.minZoom,props.mapzero_minzoom);
          stats.maxZoom=Math.max(stats.maxZoom,props.mapzero_maxzoom);
        }
        for(const id of new Set(features.map(f=>f.layerId)))summary[id].tiles++;
        yield {z,x,y,features,bbox:tileToBbox(z,x,y)};
      }
    }
  }
  const warnings={};
  try {
    // A valid empty selection must not leave a broken tileset reference.
    const iterator=source()[Symbol.asyncIterator](),first=await iterator.next();
    if(first.done)return {summary,writtenTiles:0,outputBytes:0,skippedTiles:empty};
    async function* nonempty(){try{yield first.value;for(;;){const next=await iterator.next();if(next.done)break;yield next.value;}}finally{await iterator.return?.();}}
    const result=await createCesiumTileset({source:nonempty(),contentEncoder:encodeVectorContent,out,minZoom,maxZoom,
      onTile:(_tile,contents)=>{for(const content of contents)for(const [key,count] of Object.entries(content.warnings??{}))if(count)warnings[key]=(warnings[key]??0)+count;}});
    return {...result,summary,skippedTiles:empty,candidates,warnings};
  } finally {reader.close();}
}

/** Web Mercator XYZ coverage, clamped to the valid latitude range. */
function tileRange([west,south,east,north],z,margin=0) {
  const size=2**z,clamp=n=>Math.max(0,Math.min(size-1,n));
  const x=lon=>Math.floor((lon+180)/360*size);
  const y=lat=>Math.floor((1-Math.asinh(Math.tan(Math.max(-85.05112878,Math.min(85.05112878,lat))*Math.PI/180))/Math.PI)/2*size);
  const minX=clamp(x(west)-margin),maxX=clamp(x(east)+margin),minY=clamp(y(north)-margin),maxY=clamp(y(south)+margin);
  return {minX,maxX,minY,maxY,tileCount:(maxX-minX+1)*(maxY-minY+1)};
}
