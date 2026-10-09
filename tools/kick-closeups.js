// Big close-ups of one kick frozen at a few sim times, from three cameras (side, 3/4 front, behind the kicker),
// to check the arms, the knee turnover and the foot.
//   node tools/kick-closeups.js [outdir=/tmp/kickshots] [strike=hkick] [t,t,t...]
// NOTE: turn the referee off before taking reference pictures, so he isn't in the frame or blocking the fighters:
//   await page.evaluate(() => window.CageRules.renderer.setRefVisible(false));  (any time after page load; it sticks across fights)
// or untick Options > Show referee (saved as localStorage cr_ref = '0').
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); const outdir = process.argv[2] || '/tmp/kickshots'; fs.mkdirSync(outdir, { recursive: true });
const name = process.argv[3] || 'hkick';
const times = (process.argv[4] || '0.19,0.28,0.38,0.50').split(',').map(Number);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]); let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(r => server.listen(0, r)); const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const W = 520, H = 640;
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.route('**cdnjs.cloudflare.com/**', r => r.abort());
  await page.goto(`http://localhost:${port}/index.html`); await page.waitForTimeout(800);
  await page.evaluate(() => new Promise((res) => { if (window.MMAPhys && MMAPhys.ready()) return res(true); window.addEventListener('mmaphys', (e) => res(e.detail.ok), { once: true }); setTimeout(() => res(false), 20000); }));
  await page.click('#btnPractice'); await page.waitForTimeout(200); await page.click('#btnReady'); await page.waitForTimeout(300);
  await page.evaluate(() => {
    const A = window.CageRules; A.brain = null; A.playing = false; A.state = null;
    for (const el of document.querySelectorAll('#hud, #controlsHelp, .overlay, #announce')) if (el) el.style.display = 'none';
    while (A.sim.state.phase !== 'fight') { A.sim.acc = 0; A.sim.step(1 / 60); } A.sim.drainEvents();
  });
  const IN = await page.evaluate(() => window.MMASim.IN);
  const MODBIT = { overhand: IN.MOD3, lkick: IN.MOD3, hook: IN.MOD1, bkick: IN.MOD1, straight: IN.MOD2, hkick: IN.MOD2, uppercut: 0, knee: 0, teep: 0 };
  const lead = name[0] === 'l' && name !== 'lkick'; const kind = lead ? name.slice(1) : name;
  const held = MODBIT[kind] || 0, press = (kind === 'hkick' || kind === 'bkick' || kind === 'lkick' || kind === 'knee' || kind === 'teep') ? (lead ? IN.LLEG : IN.RLEG) : (lead ? IN.LHAND : IN.RHAND);
  const step = (n, held, pressed) => page.evaluate(([n, held, pressed]) => {
    const A = window.CageRules, sim = A.sim;
    for (let k = 0; k < n; k++) { sim.setInput(0, held, k === 0 ? pressed : 0); sim.setInput(1, 0, 0); sim.acc = 0; sim.step(1 / 60); sim.drainEvents(); A.renderer.update(sim.state, 1 / 60, [held, 0]); }
    const f = sim.state.f[0]; return f.act.type + ':' + (f.act.name || '') + ' t=' + f.act.t.toFixed(2);
  }, [n, held, pressed]);
  const range = await page.evaluate(([kind, lead]) => { const S = window.MMASim.STRIKES; for (const k in S) if (S[k].kind === kind && S[k].limb[0] === (lead ? 'l' : 'r')) return S[k].range || 1.0; return 1.0; }, [kind, lead]);
  await page.evaluate((dist) => { const A = window.CageRules, S = A.sim.state; S.f[0].x = -dist / 2; S.f[0].z = 0; S.f[1].x = dist / 2; S.f[1].z = 0; A.sim.phys.place(S.f[0], S.f[1]); }, range - 0.1);
  await step(30, 0, 0);
  // cameras: (dx = kicker's right, dy = height, dz = toward the opponent), looking at the kicker's chest
  const CAMS = { side: [3.2, 1.3, 0.2, 1.0], front34: [-2.0, 1.5, 2.4, 1.0], back: [1.6, 1.6, -2.6, 1.0] };
  const shot = async (tag, cam) => {
    const [dx, dy, dz, ly] = CAMS[cam];
    await page.evaluate(([dx, dy, dz, ly, W, H]) => {
      const A = window.CageRules, R = A.renderer, m = R.models[0], o = R.models[1];
      const fx = o.px - m.px, fz = o.pz - m.pz, L = Math.hypot(fx, fz) || 1, ux = fx / L, uz = fz / L;
      R.camera.aspect = W / H; R.camera.updateProjectionMatrix();
      R.camera.position.set(m.px + ux * dz + uz * dx, dy, m.pz + uz * dz - ux * dx); R.camera.lookAt(m.px + ux * 0.2, ly, m.pz + uz * 0.2);
      R.renderer.render(R.scene, R.camera);
    }, [dx, dy, dz, ly, W, H]);
    await page.screenshot({ path: path.join(outdir, `${tag}-${cam}.png`) });
  };
  let info = await step(1, held, press); let ticks = 1;
  for (const t of times) {
    const want = Math.round(t * 60); if (want > ticks) { info = await step(want - ticks, held, 0); ticks = want; }
    console.log('t=' + t, info);
    for (const cam of Object.keys(CAMS)) await shot('t' + t.toFixed(2), cam);
  }
  await browser.close(); server.close();
})();
