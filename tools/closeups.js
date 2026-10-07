// Close-up screenshots of specific poses (high guard, closed guard, half guard, mount, ground and pound)
// from fixed cameras, for checking poses after tuning. Needs playwright (npm i -D playwright).
//   node tools/closeups.js [outdir=/tmp/shots]
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); const outdir = process.argv[2] || '/tmp/shots'; fs.mkdirSync(outdir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]); let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(r => server.listen(0, r)); const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = []; page.on('pageerror', (e) => errors.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**cdnjs.cloudflare.com/**', r => r.abort()); // use the vendored libs
  await page.goto(`http://localhost:${port}/index.html`); await page.waitForTimeout(1000);
  await page.evaluate(() => new Promise((res) => { if (window.MMAPhys && MMAPhys.ready()) return res(true); window.addEventListener('mmaphys', (e) => res(e.detail.ok), { once: true }); setTimeout(() => res(false), 20000); }));
  await page.click('#btnPractice'); await page.waitForTimeout(200); await page.click('#btnReady'); await page.waitForTimeout(300);
  await page.evaluate(() => { const A = window.CageRules; A.brain = null; A.playing = false; A.state = null; document.querySelector('#hud').style.display = 'none'; while (A.sim.state.phase !== 'fight') { A.sim.acc = 0; A.sim.step(1 / 60); } A.sim.drainEvents(); });
  const IN = await page.evaluate(() => window.MMASim.IN);
  const tick = (n, held, pressed) => page.evaluate(([n, held, pressed]) => {
    const A = window.CageRules, sim = A.sim;
    for (let k = 0; k < n; k++) { sim.setInput(0, held, k === 0 ? pressed : 0); sim.setInput(1, held, 0); sim.acc = 0; sim.step(1 / 60); sim.drainEvents(); }
    for (let k = 0; k < 40; k++) A.renderer.update(sim.state, 1 / 30, [held, held]);
  }, [n, held, pressed]);
  // render from a camera placed (dx, dy, dz) from the fighter of interest (the bottom fighter on the ground), looking at height ly
  const snap = async (name, who, dx, dy, dz, ly) => {
    await page.evaluate(([who, dx, dy, dz, ly]) => {
      const A = window.CageRules, R = A.renderer, S = A.sim.state, g = S.ground;
      const m = R.models[g ? g.bottom : who];
      R.camera.position.set(m.px + dx, dy, m.pz + dz); R.camera.lookAt(m.px, ly, m.pz); R.renderer.render(R.scene, R.camera);
    }, [who, dx, dy, dz, ly]);
    await page.waitForTimeout(100); await page.screenshot({ path: path.join(outdir, name + '.png') }); console.log(name);
  };
  await tick(30, 0, 0);
  await tick(40, IN.BLOCK, 0);
  await snap('c1-guard-front', 0, 0.0, 1.5, 1.9, 1.3);
  await snap('c2-guard-side', 0, 1.9, 1.5, 0.3, 1.3);
  await page.evaluate(() => { const S = window.CageRules.sim; S._enterGround(S.state.f[0], S.state.f[1], 'td', 'guard'); S.state.f[1].act = { type: 'idle', name: '', t: 0, dur: 0 }; });
  await tick(40, 0, 0);
  await snap('c3-closed-guard-side', 0, 2.2, 1.2, 0.0, 0.4);
  await snap('c4-closed-guard-side2', 0, -2.2, 1.2, 0.0, 0.4);
  await snap('c5-closed-guard-high', 0, 1.4, 2.4, 1.4, 0.3);
  await page.evaluate(() => { window.CageRules.sim.state.ground.pos = 'half'; });
  await tick(40, 0, 0); await snap('c6-half-side', 0, 2.2, 1.2, 0.0, 0.4);
  await page.evaluate(() => { window.CageRules.sim.state.ground.pos = 'mount'; });
  await tick(40, 0, 0); await snap('c7-mount-side', 0, 2.2, 1.2, 0.0, 0.4);
  await page.evaluate(() => { window.CageRules.sim.state.ground.pos = 'guard'; });
  await tick(40, 0, 0); await tick(8, 0, IN.RHAND); await tick(10, 0, 0); await snap('c8-guard-gnp', 0, 2.2, 1.2, 0.0, 0.4);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close(); server.close();
})();
