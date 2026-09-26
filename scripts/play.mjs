// Scripted playtest: open the game, run it, click things, take screenshots.
//   node scripts/play.mjs <out-prefix> [steps-json]
import { chromium } from 'playwright-core';
const [prefix, stepsJson = '[]', w = '1440', h = '900'] = process.argv.slice(2);
const steps = JSON.parse(stepsJson);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
let n = 0;
for (const s of steps) {
  if (s.goto) await page.goto(s.goto, { waitUntil: 'load' });
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.eval) { const r = await page.evaluate(s.eval); if (r !== undefined) console.log('eval:', typeof r === 'string' ? r : JSON.stringify(r)); }
  if (s.click) await page.click(s.click).catch((e) => logs.push(`[click-fail] ${s.click}: ${e.message}`));
  if (s.mouse) { await page.mouse.click(s.mouse[0], s.mouse[1]); }
  if (s.key) await page.keyboard.press(s.key);
  if (s.shot) { const f = `${prefix}-${s.shot}.png`; await page.screenshot({ path: f }); console.log('saved', f); n++; }
}
await browser.close();
if (logs.length) console.log(logs.slice(0, 30).join('\n'));
