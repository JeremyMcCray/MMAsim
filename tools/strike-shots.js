// Filmstrips of individual standing strikes: P1 throws one strike at a stationary opponent and a frame is
// grabbed every few sim ticks from a fixed side camera and a fixed 3/4 front camera, then tiled into one PNG
// per strike so the whole motion can be read at a glance.
//   node tools/strike-shots.js [outdir=/tmp/strikes] [strike,strike,...]
// Strike names: overhand, hook, straight, uppercut, hkick, bkick, lkick, knee, teep (rear side), prefix 'l' for lead.
// NOTE: turn the referee off before taking reference pictures, so he isn't in the frame or blocking the fighters:
//   await page.evaluate(() => window.CageRules.renderer.setRefVisible(false));  (any time after page load; it sticks across fights)
// or untick Options > Show referee (saved as localStorage cr_ref = '0').
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); const outdir = process.argv[2] || '/tmp/strikes'; fs.mkdirSync(outdir, { recursive: true });
const want = (process.argv[3] || 'overhand,hook,hkick,straight,uppercut,bkick,lkick,knee,teep').split(',');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]); let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(r => server.listen(0, r)); const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const W = 300, H = 420, COLS = 8;
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = []; page.on('pageerror', (e) => errors.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**cdnjs.cloudflare.com/**', r => r.abort());
  await page.goto(`http://localhost:${port}/index.html`); await page.waitForTimeout(800);
  const ok = await page.evaluate(() => new Promise((res) => { if (window.MMAPhys && MMAPhys.ready()) return res(true); window.addEventListener('mmaphys', (e) => res(e.detail.ok), { once: true }); setTimeout(() => res(false), 20000); }));
  console.log('physics ready:', ok);
  await page.click('#btnPractice'); await page.waitForTimeout(200); await page.click('#btnReady'); await page.waitForTimeout(300);
  await page.evaluate(() => {
    const A = window.CageRules; A.brain = null; A.playing = false; A.state = null; // stop the page's own rAF loop from rendering over our cameras
    for (const el of document.querySelectorAll('#hud, #controlsHelp, .overlay, #announce')) if (el) el.style.display = 'none';
    while (A.sim.state.phase !== 'fight') { A.sim.acc = 0; A.sim.step(1 / 60); } A.sim.drainEvents();
  });
  const IN = await page.evaluate(() => window.MMASim.IN);
  const MODBIT = { overhand: IN.MOD3, lkick: IN.MOD3, hook: IN.MOD1, bkick: IN.MOD1, straight: IN.MOD2, hkick: IN.MOD2, uppercut: 0, knee: 0, teep: 0 };
  const LIMB = (k, lead) => (k === 'hkick' || k === 'bkick' || k === 'lkick' || k === 'knee' || k === 'teep') ? (lead ? IN.LLEG : IN.RLEG) : (lead ? IN.LHAND : IN.RHAND);
  const step = (n, held, pressed) => page.evaluate(([n, held, pressed]) => {
    const A = window.CageRules, sim = A.sim;
    for (let k = 0; k < n; k++) { sim.setInput(0, held, k === 0 ? pressed : 0); sim.setInput(1, 0, 0); sim.acc = 0; sim.step(1 / 60); sim.drainEvents(); A.renderer.update(sim.state, 1 / 60, [held, 0]); }
    const f = sim.state.f[0]; return f.act.type + ':' + (f.act.name || '') + ' t=' + f.act.t.toFixed(2);
  }, [n, held, pressed]);
  const frames = [];
  const cell = async (col, row, dx, dy, dz, ly) => {
    await page.evaluate(([dx, dy, dz, ly, W, H]) => {
      const A = window.CageRules, R = A.renderer, m = R.models[0];
      const o = R.models[1]; const fx = o.px - m.px, fz = o.pz - m.pz, L = Math.hypot(fx, fz) || 1, ux = fx / L, uz = fz / L;
      const cx = m.px + ux * dz - uz * dx, cz = m.pz + uz * dz + ux * dx; // dx = his right: (-uz, ux)
      R.camera.aspect = W / H; R.camera.updateProjectionMatrix();
      R.camera.position.set(cx, dy, cz); R.camera.lookAt(m.px + ux * 0.25, ly, m.pz + uz * 0.25);
      R.renderer.render(R.scene, R.camera);
    }, [dx, dy, dz, ly, W, H]);
    frames.push({ col, row, buf: await page.screenshot() });
  };
  const clear = async () => { frames.length = 0; };
  const flush = (name) => { fs.mkdirSync(path.join(outdir, name), { recursive: true }); for (const f of frames) fs.writeFileSync(path.join(outdir, name, `${f.row}-${f.col}.png`), f.buf); };
  // put P1 at the strike's range from a stationary opponent (both re-placed before every strike)
  const place = (dist) => page.evaluate((dist) => {
    const A = window.CageRules, S = A.sim.state; S.f[0].x = -dist / 2; S.f[0].z = 0; S.f[1].x = dist / 2; S.f[1].z = 0;
    A.sim.phys.place(S.f[0], S.f[1]);
  }, dist);
  for (const name of want) {
    const lead = name[0] === 'l' && name !== 'lkick'; const kind = lead ? name.slice(1) : name;
    const held = MODBIT[kind] || 0, press = LIMB(kind, lead);
    const range = await page.evaluate(([kind, lead]) => { const S = window.MMASim.STRIKES; for (const k in S) if (S[k].kind === kind && S[k].limb[0] === (lead ? 'l' : 'r')) return S[k].range || 1.0; return 1.0; }, [kind, lead]);
    await place(range - 0.1); await step(30, 0, 0);
    await clear();
    // frames: COLS cells spread evenly over the strike's windup + active + recovery (60 Hz ticks)
    const dur = await page.evaluate(([kind, lead]) => { const S = window.MMASim.STRIKES; for (const k in S) if (S[k].kind === kind && (S[k].limb[0] === (lead ? 'l' : 'r'))) return S[k].w + S[k].a + S[k].r; return 0.6; }, [kind, lead]);
    const per = Math.max(2, Math.round(dur * 60 / (COLS - 1)));
    let info = await step(1, held, press); const infos = [info];
    await cell(0, 0, 3.0, 1.35, 0.3, 0.9); await cell(0, 1, -1.9, 1.5, 2.4, 0.9);
    for (let c = 1; c < COLS; c++) {
      info = await step(per, held, 0); infos.push(info);
      await cell(c, 0, 3.0, 1.35, 0.3, 0.9); await cell(c, 1, -1.9, 1.5, 2.4, 0.9);
    }
    flush(name);
    console.log(name.padEnd(9), 'dur', dur.toFixed(2), 'per', per, 'ticks |', infos.join(' | '));
    await step(30, 0, 0);
  }
  console.log('errors:', errors.length ? errors.slice(0, 10) : 'none');
  await browser.close(); server.close();
})();
