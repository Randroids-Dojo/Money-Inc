// Packs the Vite build into ONE self-contained page for hosts that wrap pages in their own
// <!doctype>/<head>/<body> skeleton: inline CSS (with the Latin font files embedded as data
// URIs), inline JS, no other files.
//   npx vite build && node scripts/artifact-page.mjs   ->  dist/money-inc.html
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const cssPath = html.match(/href="\.\/(assets\/[^"]+\.css)"/)[1];
const jsPath = html.match(/src="\.\/(assets\/[^"]+\.js)"/)[1];
let css = readFileSync(`dist/${cssPath}`, 'utf8');
const js = readFileSync(`dist/${jsPath}`, 'utf8');

// keep only the basic-Latin font faces, embedded
css = css.replace(/@font-face\{[^}]*\}/g, (block) => {
  const m = block.match(/url\(\.\/([^)]+?-latin-\d+-normal-[^)]+?\.woff2)\)/);
  if (!m) return '';
  const data = readFileSync(`dist/assets/${m[1]}`).toString('base64');
  return block.replace(/src:[^;}]+/, `src:url(data:font/woff2;base64,${data}) format("woff2")`);
});
if (/url\(\.\//.test(css)) throw new Error('CSS still references external files');
if (js.includes('</script')) throw new Error('bundle contains a closing script tag');

const pick = (re) => [...html.matchAll(re)].map((m) => m[0]);
const page = [
  ...pick(/<title>[\s\S]*?<\/title>/g),
  ...pick(/<meta name="(description|theme-color)"[^>]*>/g),
  ...pick(/<link rel="icon"[^>]*>/g),
  `<style>${css}</style>`,
  '<div id="app"></div>',
  `<script type="module">${js}</script>`,
].join('\n');
writeFileSync('dist/money-inc.html', page + '\n');
console.log(`dist/money-inc.html: ${(page.length / 1024).toFixed(0)} KB`);
