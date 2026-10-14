import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['packages', 'scripts', 'examples'];
const files = roots.flatMap(listJavaScriptFiles).sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);

function listJavaScriptFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJavaScriptFiles(path));
    } else if (['.js', '.mjs'].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}
