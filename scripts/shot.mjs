// Usage: node scripts/shot.mjs <url> <out.png> [width] [height] [waitMs] [clickSelector...]
// Takes a screenshot with the pre-installed Chromium.
import { chromium } from 'playwright-core';

const [url, out, w = '1400', h = '900', waitMs = '1500', ...clicks] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(+waitMs);
for (const sel of clicks) {
  await page.click(sel).catch((e) => logs.push(`[click-fail] ${sel}: ${e.message}`));
  await page.waitForTimeout(400);
}
await page.screenshot({ path: out });
await browser.close();
if (logs.length) console.log(logs.join('\n'));
console.log('saved', out);
