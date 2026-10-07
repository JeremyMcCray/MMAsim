// Visual regression helper: loads the game headless, starts a practice fight and screenshots specific
// situations (high guard, knockdown lying / rising, closed guard, half guard, mount).
//   node tools/scene-shots.js [outdir=/tmp/shots]
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const outdir = process.argv[2] || '/tmp/shots';
fs.mkdirSync(outdir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
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
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.route('**cdnjs.cloudflare.com/**', r => r.abort()); // vendored fallbacks in lib/ load instead
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForTimeout(1500);
  const physOk = await page.evaluate(() => new Promise((res) => {
    if (window.MMAPhys && MMAPhys.ready()) return res(true);
    window.addEventListener('mmaphys', (e) => res(e.detail.ok), { once: true });
    setTimeout(() => res(false), 20000);
  }));
  console.log('physics ready:', physOk);
  await page.click('#btnPractice');
  await page.waitForTimeout(300);
  // CPU corner: a fixed opponent (CPU_PICK env, default wrestler) so the shots are reproducible
  await page.evaluate((pick) => { window.CageRules.lobby.cpuPick = pick; }, process.env.CPU_PICK || 'wrestler');
  await page.click('#btnReady');
  await page.waitForTimeout(500);
  // the human model loads asynchronously after the fight starts
  await page.waitForFunction(() => { const R = window.CageRules && window.CageRules.renderer; return R && R.models.length === 2 && R.models.every(m => m.human || m.procedural); }, null, { timeout: 30000 }).catch(() => console.log('warning: fighter models did not finish loading'));
  // helpers run in the page: tick the sim with given inputs for P1, render a few frames, screenshot
  const tick = (n, held, pressed) => page.evaluate(([n, held, pressed]) => {
    const A = window.CageRules, sim = A.sim; A.brain = null; // CPU off: we script both
    for (let k = 0; k < n; k++) { sim.setInput(0, held, k === 0 ? pressed : 0); sim.setInput(1, 0, 0); sim.acc = 0; sim.step(1 / 60); const evs = sim.drainEvents(); if (evs.length) A.renderer.handleEvent && evs.forEach(e => A.renderer.handleEvent(e, sim.state)); }
    for (let k = 0; k < 30; k++) A.renderer.update(sim.state, 1 / 30, [held, 0]);
  }, [n, held, pressed]);
  const shot = async (name, info) => { await page.waitForTimeout(150); await page.screenshot({ path: path.join(outdir, name + '.png'), timeout: 180000 }); console.log(name, info || ''); };
  const state = () => page.evaluate(() => { const S = window.CageRules.state; return { phase: S.phase, f: S.f.map(f => f.act.type + ':' + (f.act.name || '') + ' rocked ' + f.rocked.toFixed(1)), ground: S.ground && S.ground.pos }; });
  const IN = await page.evaluate(() => window.MMASim.IN);
  // wait for the bell
  await page.evaluate(() => { const A = window.CageRules; while (A.sim.state.phase !== 'fight') { A.sim.acc = 0; A.sim.step(1 / 60); } A.sim.drainEvents(); });
  await tick(50, IN.FWD, 0);
  await tick(40, IN.BLOCK, 0); await shot('01-guard', await state());
  // knockdown
  await page.evaluate(() => { const S = window.CageRules.sim; S._knockdown(S.state.f[0], S.state.f[1]); });
  await tick(70, 0, 0); await shot('02-kd-lying', await state());
  await tick(90, 0, 0); await shot('03-kd-still-down', await state());
  // opponent gets up
  await page.evaluate(() => { const A = window.CageRules; A.sim.setInput(1, 0, 1); A.sim.acc = 0; A.sim.step(1 / 60); });
  await tick(30, 0, 0); await shot('04-kd-rising', await state());
  await tick(60, 0, 0); await shot('05-kd-up', await state());
  // knockdown again, dive on him
  await page.evaluate(() => { const S = window.CageRules.sim; S._knockdown(S.state.f[0], S.state.f[1]); });
  await tick(80, 0, 0);
  await tick(5, 0, IN.GRAPPLE); await shot('06-dive', await state());
  // ground positions
  for (const pos of ['guard', 'half', 'side', 'mount']) {
    await page.evaluate((pos) => { const S = window.CageRules.sim.state; S.ground.pos = pos; S.ground.idleT = 0; S.f[S.ground.top].act = { type: 'idle', name: '', t: 0, dur: 0 }; S.f[S.ground.bottom].act = { type: 'idle', name: '', t: 0, dur: 0 }; }, pos);
    await tick(30, 0, 0); await shot('07-' + pos, await state());
  }
  await page.evaluate(() => { const S = window.CageRules.sim.state; S.ground.pos = 'guard'; });
  await tick(30, 0, 0); await tick(5, 0, IN.RHAND); await tick(12, 0, 0); await shot('08-guard-top-punch', await state());
  console.log('console errors/warnings:', errors.length ? errors.slice(0, 20) : 'none');
  await browser.close();
  server.close();
})();
