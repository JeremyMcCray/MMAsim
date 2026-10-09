// Loads the game in headless Chromium, starts a practice fight and screenshots it.
//   node tools/browser-test.js [seconds=20] [outdir=/tmp/shots]
// NOTE: turn the referee off before taking reference pictures, so he isn't in the frame or blocking the fighters:
//   await page.evaluate(() => window.CageRules.renderer.setRefVisible(false));  (any time after page load; it sticks across fights)
// or untick Options > Show referee (saved as localStorage cr_ref = '0').
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const seconds = parseFloat(process.argv[2] || '20');
const outdir = process.argv[3] || '/tmp/shots';
fs.mkdirSync(outdir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`http://localhost:${port}/index.html?auto=1`);
  await page.waitForTimeout(1500);
  // wait for physics
  const physOk = await page.evaluate(() => new Promise((res) => {
    if (window.MMAPhys && MMAPhys.ready()) return res(true);
    window.addEventListener('mmaphys', (e) => res(e.detail.ok), { once: true });
    setTimeout(() => res(false), 20000);
  }));
  console.log('physics ready:', physOk);
  await page.screenshot({ path: path.join(outdir, '00-menu.png') });
  await page.click('#btnPractice');
  await page.waitForTimeout(300);
  await page.evaluate(() => { const s = document.querySelector('#selDiff'); s.value = '0.9'; s.dispatchEvent(new Event('change')); });
  await page.click('#btnReady');
  await page.waitForTimeout(500);
  const t0 = Date.now();
  let shot = 1, lastPhase = '', lastFeed = '';
  while (Date.now() - t0 < seconds * 1000) {
    // software GL presents very slowly here, so advance the simulation by hand: one fight-second per loop
    await page.evaluate(() => window.CageRules.tick(20));
    await page.waitForTimeout(100);
    const info = await page.evaluate(() => {
      const hud = document.querySelector('#hud');
      const feed = [...document.querySelectorAll('#feed div')].map(d => d.textContent);
      const A = window.CageRules, S = A.state, f = S.f;
      return { clock: document.querySelector('#clock').textContent, round: document.querySelector('#roundLbl').textContent, phase: S.phase, ground: S.ground ? S.ground.pos : null, phys: !!(A.sim && A.sim.phys), pose: !!(f[0].pose), feed: feed.slice(0, 2), hp: [f[0].dmg.head.toFixed(0), f[1].dmg.head.toFixed(0)], pos: [f[0].x.toFixed(2), f[0].z.toFixed(2), f[1].x.toFixed(2), f[1].z.toFixed(2)], fps: window.__fps };
    });
    if (info.phase !== lastPhase || info.feed[0] !== lastFeed) console.log(JSON.stringify(info));
    lastPhase = info.phase; lastFeed = info.feed[0];
    if (info.phase === 'fight' && !info.ground && shot < 14) { await page.screenshot({ path: path.join(outdir, `${String(shot).padStart(2, '0')}-standing.png`) }); shot++; }
    if (info.phase === 'over') { await page.evaluate(() => window.CageRules.tick(150)); await page.waitForTimeout(200); await page.screenshot({ path: path.join(outdir, '98-over.png') }); break; }
  }
  await page.screenshot({ path: path.join(outdir, '99-final.png') });
  console.log('console errors/warnings:', errors.length ? errors.slice(0, 20) : 'none');
  await browser.close();
  server.close();
})();
