// Per-tick trace of one kick in the live sim: where the kicking knee and foot actually are (fighter frame: hips at
// the origin, +Z toward the opponent, +X the kicker's left, metres), where the kneecap and the toes point, and
// where the two gloves are, so the authored keyframes can be checked against what the motors deliver.
//   node tools/kick-track.js [strike=hkick]
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); const name = process.argv[2] || 'hkick';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]); let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(r => server.listen(0, r)); const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  await page.route('**cdnjs.cloudflare.com/**', r => r.abort());
  await page.goto(`http://localhost:${port}/index.html`); await page.waitForTimeout(800);
  await page.evaluate(() => new Promise((res) => { if (window.MMAPhys && MMAPhys.ready()) return res(true); window.addEventListener('mmaphys', (e) => res(e.detail.ok), { once: true }); setTimeout(() => res(false), 20000); }));
  await page.click('#btnPractice'); await page.waitForTimeout(200); await page.click('#btnReady'); await page.waitForTimeout(300);
  await page.evaluate(() => { const A = window.CageRules; A.brain = null; A.playing = false; A.state = null; while (A.sim.state.phase !== 'fight') { A.sim.acc = 0; A.sim.step(1 / 60); } A.sim.drainEvents(); });
  const IN = await page.evaluate(() => window.MMASim.IN);
  const MODBIT = { overhand: IN.MOD3, lkick: IN.MOD3, hook: IN.MOD1, bkick: IN.MOD1, straight: IN.MOD2, hkick: IN.MOD2, uppercut: 0, knee: 0, teep: 0 };
  const lead = name[0] === 'l' && name !== 'lkick'; const kind = lead ? name.slice(1) : name;
  const held = MODBIT[kind] || 0, press = (kind === 'hkick' || kind === 'bkick' || kind === 'lkick' || kind === 'knee' || kind === 'teep') ? (lead ? IN.LLEG : IN.RLEG) : (lead ? IN.LHAND : IN.RHAND);
  const side = lead ? 'l' : 'r';
  const range = await page.evaluate(([kind, lead]) => { const S = window.MMASim.STRIKES; for (const k in S) if (S[k].kind === kind && S[k].limb[0] === (lead ? 'l' : 'r')) return S[k].range || 1.0; return 1.0; }, [kind, lead]);
  await page.evaluate((dist) => { const A = window.CageRules, S = A.sim.state; S.f[0].x = -dist / 2; S.f[0].z = 0; S.f[1].x = dist / 2; S.f[1].z = 0; A.sim.phys.place(S.f[0], S.f[1]); }, range - 0.1);
  const step = (n, held, pressed) => page.evaluate(([n, held, pressed, side]) => {
    const A = window.CageRules, sim = A.sim, out = [];
    const F = sim.phys.fighters ? sim.phys.fighters[0] : sim.phys.world.fighters[0];
    for (let k = 0; k < n; k++) {
      sim.setInput(0, held, k === 0 ? pressed : 0); sim.setInput(1, 0, 0); sim.acc = 0; sim.step(1 / 60);
      for (const ev of sim.drainEvents()) if (ev.k === 'hit' || ev.k === 'miss' || ev.k === 'block') out.push({ ev: JSON.stringify(ev) });
      const f = sim.state.f[0]; if (f.act.type !== 'strike') { if (out.length) break; else continue; }
      const B = F.bodies, O = (sim.phys.fighters || sim.phys.world.fighters)[1].bodies;
      const p0 = B.pelvis.translation(), p1 = O.pelvis.translation();
      const fx = p1.x - p0.x, fz = p1.z - p0.z, L = Math.hypot(fx, fz), ux = fx / L, uz = fz / L; // +Z toward the opponent
      const loc = (p) => { const dx = p.x - p0.x, dz = p.z - p0.z; return [dx * uz - dz * ux, p.y - p0.y, dx * ux + dz * uz]; };
      const rot = (q, v) => { // quaternion rotate
        const x = q.x, y = q.y, z = q.z, w = q.w; const ix = w * v.x + y * v.z - z * v.y, iy = w * v.y + z * v.x - x * v.z, iz = w * v.z + x * v.y - y * v.x, iw = -x * v.x - y * v.y - z * v.z;
        return { x: ix * w + iw * -x + iy * -z - iz * -y, y: iy * w + iw * -y + iz * -x - ix * -z, z: iz * w + iw * -z + ix * -y - iy * -x }; };
      const sh = B[side + 'Shin'], sp = sh.translation(), sq = sh.rotation();
      const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
      const knee = add(sp, rot(sq, { x: 0, y: 0.24, z: 0 })), foot = add(sp, rot(sq, { x: 0, y: -0.25, z: 0.05 }));
      const face = rot(sq, { x: 0, y: 0, z: 1 }), a = F.ankle[side], toes = rot(sq, { x: 0, y: -Math.sin(a), z: Math.cos(a) });
      const dir = (v) => [v.x * uz - v.z * ux, v.y, v.x * ux + v.z * uz];
      const fist = (s) => { const b = B[s + 'Forearm']; return loc(add(b.translation(), rot(b.rotation(), { x: 0, y: -0.19, z: 0 }))); };
      const thigh = B[side + 'Thigh'], tq = thigh.rotation(), tcen = thigh.translation();
      const hip = add(tcen, rot(tq, { x: 0, y: 0.24, z: 0 }));
      out.push({ t: f.act.t, knee: loc(knee), foot: loc(foot), face: dir(face), toes: dir(toes), hip: loc(hip), rFist: fist('r'), lFist: fist('l'), oHead: loc(O.head.translation()) });
    }
    return out;
  }, [n, held, pressed, side]);
  await step(30, 0, 0);
  const rows = await step(70, held, press);
  const D = (v) => '(' + v.map(x => (x >= 0 ? ' ' : '') + x.toFixed(2)).join(',') + ')';
  for (const r of rows) if (r.ev) console.log('EVENT ' + r.ev); else console.log(`t=${r.t.toFixed(2)} hip${D(r.hip)} knee${D(r.knee)} foot${D(r.foot)} face${D(r.face)} toes${D(r.toes)} rFist${D(r.rFist)} lFist${D(r.lFist)} oHead${D(r.oHead)}`);
  await browser.close(); server.close();
})();
