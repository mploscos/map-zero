import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { createCesiumViewerHtml } from '../src/html.js';

/** Materialize application assets, then serve ordinary files with no data APIs. */
export async function createStaticCesiumServer(packageDir) {
  const root = await fs.mkdtemp(join(tmpdir(),'mapzero-static-host-'));
  const packagePath = resolve(packageDir);
  await fs.copyFile(join(packagePath,'manifest.json'),join(root,'manifest.json'));
  for (const name of ['3dtiles','styles']) await fs.symlink(join(packagePath,name),join(root,name),'dir');
  await fs.symlink(new URL('../node_modules/cesium/Build/Cesium',import.meta.url),join(root,'Cesium'),'dir');
  await fs.cp(new URL('../packages/core/src',import.meta.url),join(root,'map-zero-core'),{recursive:true});
  for (const [source,target] of [['index.js','map-zero-cesium.js'],['static-style.js','static-style.js'],['cesium-labels.js','cesium-labels.js']]) {
    const code = (await fs.readFile(new URL(`../packages/cesium/src/${source}`,import.meta.url),'utf8'))
      .replaceAll('../../core/src/','/map-zero-core/')
      .replace(/import\s*\{([^}]+)\}\s*from 'cesium';/g,'const {$1} = globalThis.Cesium;');
    await fs.writeFile(join(root,target),code);
  }
  await fs.writeFile(join(root,'index.html'),createCesiumViewerHtml().replaceAll('https://cesium.com/downloads/cesiumjs/releases/1.145/Build/Cesium/','/Cesium/'));
  const requests = [];
  const server = createServer(async (req,res) => {
    const path = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    requests.push(path);
    const file = resolve(root, '.' + (path === '/cesium' || path === '/' ? '/index.html' : path));
    try {
      if (!file.startsWith(root+'/')) throw new Error('invalid path');
      const bytes = await fs.readFile(file);
      res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm'})[extname(file)]??'application/octet-stream');
      res.setHeader('content-length',bytes.length);res.end(bytes);
    }catch{res.statusCode=404;res.end('Not found');}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,root,requests,
    async close(){await new Promise(resolve => server.close(resolve));await fs.rm(root,{recursive:true,force:true});}};
}
