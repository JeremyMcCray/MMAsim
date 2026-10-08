// Career loop through the gym: book from the computer, train on the whiteboard, fight, come back to the gym.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..'); const outdir = process.argv[2] || '/tmp/gymshots'; fs.mkdirSync(outdir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => { const url = decodeURIComponent(req.url.split('?')[0]); let file = path.join(ROOT, url === '/' ? 'index.html' : url); if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res); });
(async () => {
  await new Promise(r => server.listen(0, r)); const port = server.address().port;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const errors = []; page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + e.stack));
  await page.goto(`http://localhost:${port}/index.html`); await page.waitForTimeout(2000);
  await page.evaluate(() => { try { localStorage.removeItem('cr_career'); } catch (_) {} });
  await page.click('#btnCareer'); await page.waitForTimeout(300); await page.fill('#careerName', 'Testy'); await page.click('#btnCareerStart'); await page.waitForTimeout(1000);
  const st = () => page.evaluate(() => { const A = window.CageRules, G = A.gym; return { mode: A.mode, active: !!(G && G.active), hud: !document.querySelector('#gymHud').classList.contains('hidden'), career: !document.querySelector('#career').classList.contains('hidden'), end: !document.querySelector('#end').classList.contains('hidden') }; });
  const go = async (x, z) => { await page.evaluate(([x, z]) => { const G = window.CageRules.gym; G.player.x = x; G.player.z = z; }, [x, z]); await page.waitForTimeout(400); await page.keyboard.press('Enter'); await page.waitForTimeout(400); };
  await go(-5.6, -3.0); await page.click('#tabOffers button[data-offer]'); await page.waitForTimeout(200); await page.click('#btnCareerGym'); await page.waitForTimeout(300);
  await go(-1.9, -3.9);
  for (let i = 0; i < 12; i++) { if (await page.evaluate(() => !!document.querySelector('#btnCareerFight'))) break; await page.click('#tabCamp .train'); await page.waitForTimeout(120); }
  await page.click('#btnCareerGym'); await page.waitForTimeout(300);
  await go(-5.6, -3.0);
  console.log('computer on fight week:', await page.evaluate(() => document.querySelector('#cStation').textContent), 'fight button:', await page.evaluate(() => !!document.querySelector('#btnCareerFight')));
  await page.click('#btnCareerFight'); await page.waitForTimeout(300);
  const physOk = await page.evaluate(() => new Promise((res) => { if (window.MMAPhys && MMAPhys.ready()) return res(true); window.addEventListener('mmaphys', (e) => res(e.detail.ok), { once: true }); setTimeout(() => res(false), 30000); }));
  await page.waitForTimeout(1000);
  console.log('physics', physOk, 'in fight:', JSON.stringify(await st()));
  console.log('dbg', await page.evaluate(() => { const A = window.CageRules; return JSON.stringify({ sim: !!A.sim, playing: A.playing, phase: A.state && A.state.phase, t: A.state && A.state.t, phys: !!(A.sim && A.sim.phys), paused: A.paused, names: A.state && A.state.f.map(f => f.name) }); }));
  await page.evaluate(() => window.CageRules.tick(100));
  console.log('dbg2', await page.evaluate(() => { const A = window.CageRules; return JSON.stringify({ phase: A.state.phase, t: A.state.t, phaseT: A.state.phaseT }); }));
  let ph = '';
  for (let k = 0; k < 140 && ph !== 'over'; k++) { ph = await page.evaluate(() => { window.CageRules.tick(300); return window.CageRules.state.phase; }); }
  console.log('phase', ph, 'result', await page.evaluate(() => JSON.stringify(window.CageRules.state.result)));
  await page.waitForTimeout(4500);
  console.log('end screen:', JSON.stringify(await st()), await page.evaluate(() => document.querySelector('#endDetail').textContent), '|', await page.evaluate(() => document.querySelector('#btnRematch').textContent));
  await page.evaluate(() => document.querySelector('#btnRematch').click()); await page.waitForTimeout(1500);
  console.log('after fight:', JSON.stringify(await st()), 'banner:', await page.evaluate(() => document.querySelector('#gResult').textContent.slice(0, 90)), 'frames:', await page.evaluate(() => window.CageRules.gym.frames.filter(f => f.f.visible).length));
  await page.screenshot({ path: path.join(outdir, '12-after-fight.png') });
  await page.click('#btnGymResultOk'); await page.waitForTimeout(200);
  console.log('errors:', errors.length ? errors.join('\n') : 'none');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
