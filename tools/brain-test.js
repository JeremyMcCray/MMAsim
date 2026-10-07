// Loads the game in headless Chromium, starts an AI vs AI fight between an evolved brain (brains/index.json)
// and the scripted CPU, runs it for a while and screenshots it. Checks that the lobby lists the brains and
// that both corners are driven by the right brain class.
//   node tools/brain-test.js [fight-seconds=40] [outdir=/tmp/shots]
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const seconds = parseFloat(process.argv[2] || '40');
const outdir = process.argv[3] || '/tmp/shots';
fs.mkdirSync(outdir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`http://localhost:${port}/index.html`);
  const physOk = await page.evaluate(() => new Promise((res) => {
    if (window.MMAPhys && MMAPhys.ready()) return res(true);
    window.addEventListener('mmaphys', (e) => res(e.detail.ok), { once: true });
    setTimeout(() => res(false), 20000);
  }));
  console.log('physics ready:', physOk);
  await page.click('#btnWatch');
  await page.waitForTimeout(800);
  const options = await page.evaluate(() => [...document.querySelectorAll('#brainPick1 option')].map(o => o.value + ' | ' + o.textContent));
  console.log('brain options:', options);
  const brains = options.map(o => o.split(' | ')[0]).filter(v => v.endsWith('.json'));
  if (!brains.length) { console.log('no evolved brains in brains/index.json — nothing to test'); await browser.close(); server.close(); return; }
  await page.screenshot({ path: path.join(outdir, '10-watch-lobby.png') });
  // red corner: latest brain, blue corner: scripted CPU (champion level), blue fighter: wrestler
  await page.selectOption('#brainPick0', brains[brains.length - 1]);
  await page.waitForTimeout(200);
  await page.selectOption('#cpuPick', 'wrestler');
  await page.evaluate(() => { const s = document.querySelector('#selDiff'); s.value = '0.9'; s.dispatchEvent(new Event('change')); });
  await page.click('#btnReady');
  await page.waitForTimeout(1500);
  const who = await page.evaluate(() => { const A = window.CageRules; return { p0: A.autoPilot && A.autoPilot.constructor.name, p1: A.brain && A.brain.constructor.name, names: A.state.f.map(f => f.name), tags: [document.querySelector('#fp0 .tag').textContent, document.querySelector('#fp1 .tag').textContent] }; });
  console.log('drivers:', JSON.stringify(who));
  const t0 = Date.now();
  let shot = 1, lastFeed = '';
  while (Date.now() - t0 < seconds * 1000) {
    await page.evaluate(() => window.CageRules.tick(30));
    await page.waitForTimeout(60);
    const info = await page.evaluate(() => {
      const S = window.CageRules.state, f = S.f;
      return { clock: document.querySelector('#clock').textContent, phase: S.phase, ground: S.ground ? S.ground.pos : null, feed: [...document.querySelectorAll('#feed div')].map(d => d.textContent).slice(0, 1), hp: [f[0].dmg.head.toFixed(0), f[1].dmg.head.toFixed(0)], landed: f.map(x => x.ts.landed + x.rs.landed) };
    });
    if (info.feed[0] !== lastFeed) console.log(JSON.stringify(info));
    lastFeed = info.feed[0];
    if (info.phase === 'fight' && shot < 4) { await page.screenshot({ path: path.join(outdir, `1${shot}-watch.png`) }); shot++; }
    if (info.phase === 'over') { await page.evaluate(() => window.CageRules.tick(250)); await page.waitForTimeout(4200); await page.screenshot({ path: path.join(outdir, '19-watch-over.png') }); break; }
  }
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
