// Assembles src-tauri/local-server/ -- the folder the offline edition's installer carries:
//   local-server/node.exe            the Node runtime (so the church PC needs nothing installed)
//   local-server/server/src/*.js     the sync server (server/src, without tests)
//   local-server/server/package.json
//
//   node scripts/prepare-offline.mjs --download-windows-node     (CI: fetches the newest Node 22 for Windows)
//   node scripts/prepare-offline.mjs --node /path/to/node        (use a Node you already have, for trying it out)
//
// The server has no npm dependencies of its own (it uses Node's built-in SQLite), so there is no
// node_modules to bundle.
import { cpSync, mkdirSync, rmSync, existsSync, copyFileSync, writeFileSync, readFileSync, readdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src-tauri', 'local-server');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'server'), { recursive: true });
cpSync(join(root, 'server', 'src'), join(out, 'server', 'src'), { recursive: true });
copyFileSync(join(root, 'server', 'package.json'), join(out, 'server', 'package.json'));

if (flag('--download-windows-node')) {
  const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
  const newest = index.filter((r) => r.version.startsWith('v22.')).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!newest) throw new Error('no Node 22 release found');
  const name = `node-${newest.version}-win-x64`;
  console.log(`Downloading ${name}…`);
  const zip = join(tmpdir(), `${name}.zip`);
  const res = await fetch(`https://nodejs.org/dist/${newest.version}/${name}.zip`);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(zip));
  const dest = join(tmpdir(), `${name}-extracted`);
  rmSync(dest, { recursive: true, force: true }); mkdirSync(dest, { recursive: true });
  // Windows 10+ ships bsdtar, which reads zip files; elsewhere `unzip` does.
  if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', dest]); else execFileSync('unzip', ['-q', zip, '-d', dest]);
  copyFileSync(join(dest, name, 'node.exe'), join(out, 'node.exe'));
} else if (value('--node')) {
  copyFileSync(value('--node'), join(out, process.platform === 'win32' ? 'node.exe' : 'node'));
} else {
  console.error('Say where Node comes from: --download-windows-node  or  --node <path>');
  process.exit(2);
}

const files = [];
(function walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } })(out);
console.log(`Staged ${files.length} files in src-tauri/local-server/`);
for (const need of ['server/src/local.js', 'server/src/index.js', 'server/src/backup.js']) {
  if (!existsSync(join(out, need))) throw new Error(`missing ${need}`);
}
