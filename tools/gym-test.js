// Loads the game in headless Chromium, starts a career, walks around the gym, hits the bag,
// opens every station and screenshots the room at every upgrade tier.
//   node tools/gym-test.js [outdir=/tmp/gymshots]
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const outdir = process.argv[2] || '/tmp/gymshots';
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
  const page = await browser.newPage({ viewport: { width: 1120, height: 630 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + e.stack));
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForTimeout(2500);
  const shot = async (n) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(outdir, n + '.png') }); console.log('shot', n); };

  await page.evaluate(() => { try { localStorage.removeItem('cr_career'); } catch (_) {} });
  await page.click('#btnCareer');
  await page.waitForTimeout(300);
  await page.fill('#careerName', 'Testy');
  await page.click('#btnCareerStart');
  await page.waitForTimeout(1500);
  const st = async () => page.evaluate(() => { const A = window.CageRules, G = A.gym; return { mode: A.mode, active: G && G.active, paused: G && G.paused, x: G && G.player.x.toFixed(2), z: G && G.player.z.toFixed(2), hits: G && G.session.hits, prompt: G && G.prompt, hud: !document.querySelector('#gymHud').classList.contains('hidden'), career: !document.querySelector('#career').classList.contains('hidden') }; });
  console.log('after start', JSON.stringify(await st()));
  await shot('01-gym-spawn');

  // walk forward (into the room) for a second
  await page.keyboard.down('KeyW'); await page.waitForTimeout(900); await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyA'); await page.waitForTimeout(500); await page.keyboard.up('KeyA');
  console.log('after walk', JSON.stringify(await st()));
  // go to the bag and hit it with everything
  await page.evaluate(() => { const G = window.CageRules.gym; G.teleport(0.75, 0.45, Math.PI); });
  await page.waitForTimeout(600);
  // deterministic 60 Hz strikes through the dev hook: every limb, every modifier
  const IN = { LHAND: 16, RHAND: 32, LLEG: 64, RLEG: 128, MOD1: 256, MOD2: 512, MOD3: 1024 };
  const res = [];
  for (const mod of [0, IN.MOD1, IN.MOD2, IN.MOD3]) for (const limb of [IN.LHAND, IN.RHAND, IN.LLEG, IN.RLEG]) {
    res.push(await page.evaluate(([mod, limb]) => {
      const A = window.CageRules, G = A.gym;
      G.teleport(0.75, 0.45, Math.PI);
      const before = G.session.hits;
      A.gymTick(1, mod, limb); const name = G.player.act.name; A.gymTick(70, mod, 0);
      const out = name + ':' + (G.session.hits - before) + (G.session.last ? '@' + G.session.last.speed.toFixed(1) + 'm/s' : '');
      if (G.sim) G.sim.phys.fighters[1].teleport(); return out;
    }, [mod, limb]));
  }
  console.log('strike hits', res.join('  '));
  const keys = ['KeyI', 'KeyU', 'KeyI', 'KeyK', 'KeyJ'];
  for (let round = 0; round < 1; round++) for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(650); }
  await page.keyboard.down('KeyQ'); await page.keyboard.press('KeyI'); await page.waitForTimeout(700); await page.keyboard.press('KeyK'); await page.waitForTimeout(900); await page.keyboard.up('KeyQ');
  await page.keyboard.down('KeyE'); await page.keyboard.press('KeyU'); await page.waitForTimeout(300); await page.keyboard.press('KeyI'); await page.waitForTimeout(700); await page.keyboard.press('KeyK'); await page.waitForTimeout(1000); await page.keyboard.up('KeyE');
  await page.keyboard.down('KeyR'); await page.keyboard.press('KeyI'); await page.waitForTimeout(700); await page.keyboard.press('KeyJ'); await page.waitForTimeout(1000); await page.keyboard.up('KeyR');
  const bag = await page.evaluate(() => { const G = window.CageRules.gym; return { session: G.session, bag: G.sim && G.sim.phys.fighters[1].rotation(), bagEl: document.querySelector('#gBag').textContent }; });
  console.log('bag', JSON.stringify(bag));
  await page.keyboard.press('KeyI'); await page.waitForTimeout(150);
  await shot('02-bag-hit');
  await page.waitForTimeout(800);
  await page.keyboard.down('KeyL'); await page.waitForTimeout(300); await shot('03-guard'); await page.keyboard.up('KeyL');

  // stations
  const stations = [['computer', -5.6, -3.0], ['board', -1.9, -3.9], ['desk', 5.5, 2.6], ['fame', 5.8, -1.2]];
  for (const [id, x, z] of stations) {
    await page.evaluate(([x, z]) => { const G = window.CageRules.gym; G.teleport(x, z); }, [x, z]);
    await page.waitForTimeout(700);
    const s = await st(); console.log(id, 'prompt:', s.prompt, 'hud prompt:', await page.evaluate(() => document.querySelector('#gPrompt').textContent));
    await shot('04-' + id);
    await page.keyboard.press('Enter'); await page.waitForTimeout(500);
    const s2 = await st(); console.log(id, 'opened:', s2.career, 'paused:', s2.paused, 'title:', await page.evaluate(() => document.querySelector('#cStation').textContent));
    if (id === 'computer') await shot('05-computer-panel');
    if (id === 'desk') {
      // buy a couple of upgrades with some test money and make sure the room changes
      await page.evaluate(() => { const A = window.CageRules; const C = A.gymC || null; });
      await page.evaluate(() => { const C = JSON.parse(localStorage.getItem('cr_career')); });
    }
    await page.click('#btnCareerGym'); await page.waitForTimeout(400);
    console.log(id, 'closed:', JSON.stringify(await st()));
  }

  // accept an offer through the computer panel
  await page.evaluate(() => { const G = window.CageRules.gym; G.teleport(-5.6, -3.0); });
  await page.waitForTimeout(500); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  const nOffers = await page.evaluate(() => document.querySelectorAll('#tabOffers button[data-offer]').length);
  console.log('offers on screen', nOffers);
  if (nOffers) { await page.click('#tabOffers button[data-offer]'); await page.waitForTimeout(300); }
  await page.click('#btnCareerGym'); await page.waitForTimeout(500);
  await shot('06-booked');
  console.log('kpis', await page.evaluate(() => document.querySelector('#gKpis').textContent));

  // upgrade tiers: hand the fighter money and buy everything step by step, screenshot each tier
  const tiers = [[1, 'tier1'], [3, 'tier2'], [5, 'tier3']];
  for (const [lvl, name] of tiers) {
    await page.evaluate((lvl) => {
      const A = window.CageRules, G = A.gym; const C = G.C; const Career = window.MMACareer;
      C.money = 5e7;
      for (const f of Career.FACILITIES) while ((C.gym[f.id] || 0) < lvl) Career.buyUpgrade(C, f.id);
      Career.save(C);
      G.refresh(C);
    }, lvl);
    await page.evaluate(() => { const G = window.CageRules.gym; G.teleport(3.0, 3.4, Math.PI); G.cam.init = false; });
    await page.waitForTimeout(900);
    await shot('07-' + name + '-a');
    await page.evaluate(() => { const G = window.CageRules.gym; G.teleport(-3.5, -2.0, Math.PI * 0.8); G.cam.init = false; });
    await page.waitForTimeout(900);
    await shot('07-' + name + '-b');
    console.log(name, await page.evaluate(() => { const G = window.CageRules.gym; return G.tierName(G.C) + ' total ' + G.totalLevel(G.C) + ' obstacles ' + G.obstacles.length; }));
  }
  // the whole loop: train on the whiteboard until fight week, fight from the computer, come back to the gym
  await page.evaluate(() => { const G = window.CageRules.gym; G.teleport(-1.9, -3.9); });
  await page.waitForTimeout(500); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  for (let i = 0; i < 12; i++) {
    const ready = await page.evaluate(() => !!document.querySelector('#btnCareerFight'));
    if (ready) break;
    await page.click('#tabCamp .train'); await page.waitForTimeout(150);
  }
  console.log('fight ready:', await page.evaluate(() => !!document.querySelector('#btnCareerFight')), 'week', await page.evaluate(() => window.CageRules.gym.C.week));
  await page.click('#btnCareerGym'); await page.waitForTimeout(500);
  await shot('10-fight-week');
  console.log('prompt at computer:', await page.evaluate(() => { const G = window.CageRules.gym; G.teleport(-5.6, -3.0); return G._promptFor(window.MMAGym.STATIONS[0], G.C); }));
  await page.waitForTimeout(400); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  await page.click('#btnCareerFight');
  await page.waitForTimeout(500);
  const physOk = await page.evaluate(() => new Promise((res) => { if (window.MMAPhys && MMAPhys.ready()) return res(true); window.addEventListener('mmaphys', (e) => res(e.detail.ok), { once: true }); setTimeout(() => res(false), 30000); }));
  await page.waitForTimeout(1500);
  console.log('physics', physOk, 'in fight:', JSON.stringify(await st()), 'playing', await page.evaluate(() => window.CageRules.playing));
  await shot('11-fight');
  for (let k = 0; k < 140; k++) { await page.evaluate(() => window.CageRules.tick(300)); const ph = await page.evaluate(() => window.CageRules.state && window.CageRules.state.phase); if (ph === 'over') break; }
  await page.evaluate(() => window.CageRules.tick(200)); await page.waitForTimeout(4500);
  console.log('end screen:', await page.evaluate(() => !document.querySelector('#end').classList.contains('hidden')), await page.evaluate(() => document.querySelector('#endWinner').textContent), await page.evaluate(() => document.querySelector('#btnRematch').textContent));
  await page.click('#btnRematch'); await page.waitForTimeout(1200);
  console.log('after fight:', JSON.stringify(await st()), 'result banner:', await page.evaluate(() => document.querySelector('#gResult').textContent.slice(0, 80)));
  await shot('12-after-fight');
  await page.click('#btnGymResultOk'); await page.waitForTimeout(200);

  // leave to the menu and come back
  await page.click('#btnGymMenu'); await page.waitForTimeout(600);
  console.log('menu', JSON.stringify(await st()));
  await shot('08-menu');
  await page.click('#btnCareer'); await page.waitForTimeout(1200);
  console.log('back', JSON.stringify(await st()));
  await shot('09-back-in-gym');
  const perf = await page.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 > 2000) r(n / 2); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
  console.log('fps (swiftshader)', perf.toFixed(1));
  console.log('errors:', errors.length ? errors.join('\n') : 'none');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
