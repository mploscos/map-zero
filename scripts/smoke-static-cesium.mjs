import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createStaticCesiumServer } from './static-cesium-server.mjs';

const host = await createStaticCesiumServer(process.argv[2] ?? 'generated/bbox.mapzero');
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
try {
  const page=await browser.newPage({viewport:{width:1120,height:720}});
  await page.route('**/*',route => route.request().url().startsWith(host.url+'/') ? route.continue() : route.abort());
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('/favicon.ico'))errors.push(`${response.status()} ${response.url()}`);});
  await page.goto(host.url+'/cesium');
  await page.waitForFunction(()=>globalThis.mapZeroController,null,{timeout:60000});
  await page.waitForFunction(()=>Object.values(mapZeroController.tilesets).filter(t=>t.show).every(t=>t.tilesLoaded),null,{timeout:60000});
  // Inspect labels at street zoom, including packages with no major-road refs.
  await page.evaluate(()=>{const b=mapZeroController.manifest.bbox;viewer.camera.setView({destination:Cesium.Cartesian3.fromDegrees((b[0]+b[2])/2,(b[1]+b[3])/2,500),orientation:{heading:0,pitch:-Math.PI/2,roll:0}});});
  await page.waitForFunction(()=>mapZeroController.labelCollection.length>0,null,{timeout:30000});
  assert.ok(await page.evaluate(()=>mapZeroController.labelCollection.length<=150));
  assert.equal(await page.evaluate(()=>viewer.entities.values.length),0);
  assert.ok(await page.evaluate(()=>[...new Set(Object.values(mapZeroController.tilesets))].every(t=>t.heightReference===Cesium.HeightReference.NONE)));
  assert.ok(await page.evaluate(()=>mapZeroController.tilesets.roads===mapZeroController.tilesets.pois));
  await page.waitForFunction(()=>mapZeroController.tilesets.pois?.statistics.numberOfFeaturesLoaded>0,null,{timeout:30000});
  for(const id of ['roads','pois']) {
    await page.evaluate(id=>mapZeroController.setVisible(id,false),id);
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(id=>Array.from({length:mapZeroController.labelCollection.length},(_,i)=>mapZeroController.labelCollection.get(i)).every(l=>l.id.mapZeroLayer!==id),id));
    await page.evaluate(id=>mapZeroController.setVisible(id,true),id);
    await page.evaluate(id=>mapZeroController.setOpacity(id,0),id);
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(id=>Array.from({length:mapZeroController.labelCollection.length},(_,i)=>mapZeroController.labelCollection.get(i)).every(l=>l.id.mapZeroLayer!==id),id));
    await page.evaluate(id=>mapZeroController.setOpacity(id,1),id);
  }
  await page.evaluate(()=>mapZeroController.setLabelsVisible(false));
  assert.equal(await page.evaluate(()=>mapZeroController.labelCollection.show),false);
  await page.evaluate(()=>mapZeroController.setLabelsVisible(true));
  await page.waitForTimeout(2000);
  await page.evaluate(()=>{globalThis.idleFrames=0;viewer.scene.postRender.addEventListener(()=>idleFrames++);});
  await page.waitForTimeout(1500);
  const idle=await page.evaluate(()=>idleFrames);assert.ok(idle<10,`idle frames: ${idle}`);
  const stats=await page.evaluate(()=>Object.fromEntries(Object.entries(mapZeroController.tilesets).map(([id,t])=>[id,{loaded:t.statistics.numberOfTilesWithContentReady,features:t.statistics.numberOfFeaturesLoaded}])));
  // Force loaded content out of view, trim the cache, and verify unload events.
  await page.evaluate(()=>{
    globalThis.unloaded=0;
    for(const t of new Set(Object.values(mapZeroController.tilesets)))t.tileUnload.addEventListener(()=>unloaded++);
    viewer.camera.setView({destination:Cesium.Cartesian3.fromDegrees(100,-35,2000)});
    for(const t of new Set(Object.values(mapZeroController.tilesets)))t.trimLoadedTiles();
    viewer.scene.requestRender();
  });
  await page.waitForFunction(()=>unloaded>0,null,{timeout:15000});
  const unloaded=await page.evaluate(()=>globalThis.unloaded);
  const destroyed=await page.evaluate(()=>{
    const controller=mapZeroController,labels=controller.labelCollection,tilesets=Object.values(controller.tilesets);
    controller.destroy();controller.destroy();
    return labels.isDestroyed()&&tilesets.every(t=>t.isDestroyed());
  });assert.ok(destroyed);
  assert.deepEqual(errors,[]);
  assert.ok(!host.requests.some(url=>/\.pmtiles|\.gpkg|\.mvt|\/api\//.test(url)));
  assert.ok(host.requests.some(url=>url.endsWith('.glb')));
  console.log(JSON.stringify({staticOnly:true,idleFrames:idle,unloaded,stats},null,2));
}finally{await browser.close();await host.close();}
