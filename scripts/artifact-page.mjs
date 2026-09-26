// Turns the Vite build (dist/index.html) into a page fragment for hosts that supply their own
// <!doctype>/<head>/<body> skeleton, and lists the asset files that must be published with it.
//   npx vite build && node scripts/artifact-page.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const pick = (re) => [...html.matchAll(re)].map((m) => m[0]);
const title = pick(/<title>[\s\S]*?<\/title>/g);
const metas = pick(/<meta name="(description|theme-color)"[^>]*>/g);
const icons = pick(/<link rel="icon"[^>]*>/g);
const styles = pick(/<link rel="stylesheet"[^>]*>/g).map((s) => s.replace('href="./', 'href="'));
const scripts = pick(/<script type="module"[^>]*><\/script>/g).map((s) => s.replace('src="./', 'src="'));
const page = [...title, ...metas, ...icons, ...styles, '<div id="app"></div>', ...scripts].join('\n') + '\n';
writeFileSync('dist/money-inc.html', page);
const files = Object.fromEntries(readdirSync('dist/assets').map((f) => [`assets/${f}`, `dist/assets/${f}`]));
writeFileSync('dist/artifact-files.json', JSON.stringify(files, null, 1));
console.log(page);
console.log(Object.keys(files).length, 'asset files');
