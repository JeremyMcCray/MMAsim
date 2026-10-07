// Close-ups of the fighter model in its stance from the front, side, 3/4 back and a head close-up.
//   node tools/model-shots.js [outdir=/tmp/model]
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); const outdir = process.argv[2] || '/tmp/model'; fs.mkdirSync(outdir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]); let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(r => server.listen(0, r)); const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const W = 420, H = 720;
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = []; page.on('pageerror', (e) => errors.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/ERR_/.test(m.text())) errors.push(m.text()); });
  await page.route('**cdnjs.cloudflare.com/**', r => r.abort());
  await page.goto(`http://localhost:${port}/index.html`); await page.waitForTimeout(800);
  await page.evaluate(() => new Promise((res) => { if (window.MMAPhys && MMAPhys.ready()) return res(true); window.addEventListener('mmaphys', (e) => res(e.detail.ok), { once: true }); setTimeout(() => res(false), 20000); }));
  await page.click('#btnPractice'); await page.waitForTimeout(200); await page.click('#btnReady'); await page.waitForTimeout(300);
  await page.evaluate(() => {
    const A = window.CageRules; A.brain = null; A.playing = false; A.state = null;
    for (const el of document.querySelectorAll('#hud, #controlsHint')) if (el) el.style.display = 'none';
    while (A.sim.state.phase !== 'fight') { A.sim.acc = 0; A.sim.step(1 / 60); } A.sim.drainEvents();
    const S = A.sim.state; S.f[0].x = -0.9; S.f[0].z = 0; S.f[1].x = 0.9; S.f[1].z = 0; A.sim.phys.place(S.f[0], S.f[1]);
    for (let k = 0; k < 40; k++) { A.sim.setInput(0, 0, 0); A.sim.setInput(1, 0, 0); A.sim.acc = 0; A.sim.step(1 / 60); A.sim.drainEvents(); A.renderer.update(A.sim.state, 1 / 60, [0, 0]); }
  });
  const shot = async (name, dx, dy, dz, ly, who) => {
    await page.evaluate(([dx, dy, dz, ly, who, W, H]) => {
      const A = window.CageRules, R = A.renderer, m = R.models[who], o = R.models[1 - who];
      const fx = o.px - m.px, fz = o.pz - m.pz, L = Math.hypot(fx, fz) || 1, ux = fx / L, uz = fz / L;
      const cx = m.px + ux * dz + uz * dx, cz = m.pz + uz * dz - ux * dx;
      R.camera.aspect = W / H; R.camera.updateProjectionMatrix();
      R.camera.position.set(cx, dy, cz); R.camera.lookAt(m.px, ly, m.pz); R.renderer.render(R.scene, R.camera);
    }, [dx, dy, dz, ly, who, W, H]);
    await page.screenshot({ path: path.join(outdir, name + '.png') }); console.log(name);
  };
  await shot('m1-front', 1.3, 1.3, 2.2, 1.0, 0);
  await shot('m2-side', 2.6, 1.3, 0.2, 1.0, 0);
  await shot('m3-back34', -1.6, 1.4, -2.0, 1.0, 0);
  await shot('m4-head', 0.6, 1.8, 0.8, 1.72, 0);
  await shot('m5-opp-front', -1.3, 1.3, 2.2, 1.0, 1);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close(); server.close();
})();
