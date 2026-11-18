#!/usr/bin/env node
/**
 * Bundle budget check (owner: build-engineer). Run after `npm run build`: `npm run size`.
 *
 * "Initial" = everything dist/index.html loads before the game can start: module scripts, modulepreload links,
 * stylesheets, and assets they reference by URL in dist/ (fonts, images, etc. found in the initial JS/CSS text).
 * Lazy chunks reached only via dynamic import() are not counted as initial.
 *
 * Budgets (gzip, level 9):
 *   initial JS        < 1.5 MB
 *   initial download  < 15 MB
 * Exits 1 when a budget is exceeded or dist/ is missing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const MB = 1024 * 1024;
const BUDGET_INITIAL_JS = 1.5 * MB;
const BUDGET_INITIAL_TOTAL = 15 * MB;

const dist = resolve(process.argv[2] ?? 'dist');
const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`[size] ${relative(process.cwd(), indexPath)} not found. Run \`npm run build\` first.`);
  process.exit(1);
}

const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const fmt = (n) => (n >= MB ? `${(n / MB).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

const html = readFileSync(indexPath);
const htmlText = html.toString('utf8');

/** dist-relative path for a URL found in HTML/JS/CSS, or null if it is external or not a file in dist/. */
function toDistFile(url) {
  if (/^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('data:')) return null;
  const clean = url.split(/[?#]/)[0].replace(/^\.?\//, '');
  const file = join(dist, clean);
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

const initial = new Set();
const queue = [];
const add = (file) => {
  if (file && !initial.has(file)) {
    initial.add(file);
    queue.push(file);
  }
};

for (const m of htmlText.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
  const tag = m[0];
  if (/<link/i.test(tag) && !/rel=["'](?:stylesheet|modulepreload|preload|icon|manifest)["']/i.test(tag)) continue;
  add(toDistFile(m[1]));
}

// Follow static references from initial JS/CSS: static `import ... from "./x.js"`, CSS url(), and asset URLs that
// Vite inlines as string literals (e.g. "/assets/foo-abc123.png"). Dynamic import("./x.js") does not match the
// static-import pattern, so lazy chunks stay out.
const assetsDir = join(dist, 'assets');
const assetNames = new Set((existsSync(assetsDir) ? readdirSync(assetsDir, { withFileTypes: true }) : []).filter((d) => d.isFile()).map((d) => d.name));
while (queue.length) {
  const file = queue.shift();
  if (!/\.(?:js|mjs|css)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
    const name = m[1].split('/').pop();
    if (assetNames.has(name)) add(join(dist, 'assets', name));
  }
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const name = m[1].split(/[?#]/)[0].split('/').pop();
    if (assetNames.has(name)) add(join(dist, 'assets', name));
  }
  for (const m of text.matchAll(/["'`](?:\.{0,2}\/)?(?:assets\/)?([\w.-]+\.(?:png|jpe?g|webp|avif|ktx2|glb|gltf|bin|woff2?|ttf|svg|ogg|mp3|m4a|wav|json))["'`]/g)) {
    if (assetNames.has(m[1])) add(join(dist, 'assets', m[1]));
  }
}

let jsGz = 0;
let totalGz = gz(html);
const rows = [['index.html', html.length, gz(html)]];
for (const file of [...initial].sort()) {
  const buf = readFileSync(file);
  const g = gz(buf);
  totalGz += g;
  if (/\.m?js$/.test(file)) jsGz += g;
  rows.push([relative(dist, file), buf.length, g]);
}

const w = Math.max(...rows.map((r) => r[0].length));
console.log(`[size] initial files in ${relative(process.cwd(), dist) || '.'}/ (raw / gzip):`);
for (const [name, raw, g] of rows) console.log(`  ${name.padEnd(w)}  ${fmt(raw).padStart(10)}  ${fmt(g).padStart(10)}`);

let failed = false;
const check = (label, value, budget) => {
  const ok = value <= budget;
  failed ||= !ok;
  console.log(`[size] ${label}: ${fmt(value)} gzip / budget ${fmt(budget)} (${((value / budget) * 100).toFixed(1)}%) ${ok ? 'OK' : 'OVER BUDGET'}`);
};
check('initial JS', jsGz, BUDGET_INITIAL_JS);
check('initial download', totalGz, BUDGET_INITIAL_TOTAL);
process.exit(failed ? 1 : 0);
