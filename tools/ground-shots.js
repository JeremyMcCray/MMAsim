// Screenshots of the ground-game panel: starts a practice fight, puts it on the mat and captures the compass in
// its states (my options, an incoming move to read, my own move, a locked submission).
//   node tools/ground-shots.js [outdir=/tmp/ground]
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const outdir = process.argv[2] || '/tmp/ground';
fs.mkdirSync(outdir, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Users/Keems/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined, args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && m.text().indexOf('ERR_') < 0) errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/index.html?auto=1`);
  await page.waitForTimeout(2000);
  await page.evaluate(() => new Promise((res) => { if (window.MMAPhys && MMAPhys.ready()) return res(true); window.addEventListener('mmaphys', () => res(true), { once: true }); setTimeout(() => res(false), 20000); }));
  await page.click('#btnPractice');
  await page.waitForTimeout(300);
  await page.click('#btnReady');
  await page.waitForTimeout(800);
  // let the bell ring, then put the human (idx 0) on top in closed guard
  await page.evaluate(() => { const A = window.CageRules; A.tick(90); A.sim._enterGround(A.state.f[0], A.state.f[1], 'td', 'guard'); A.tick(40); });
  await page.waitForTimeout(300);
  const snap = async (name) => { await page.waitForTimeout(150); await page.screenshot({ path: path.join(outdir, name + '.png') }); const t = await page.evaluate(() => document.querySelector('#grapple').innerText.replace(/\n+/g, ' | ')); console.log(name + ': ' + t); };
  await snap('01-top-guard-options');
  // the CPU on the bottom will try something: tick until a move by idx 1 is up and still readable
  await page.evaluate(() => { const A = window.CageRules; for (let k = 0; k < 600; k++) { A.tick(1); const G = A.state.ground; if (G && G.trans && G.trans.by === 1 && G.trans.t < G.trans.win * 0.5) break; } });
  await snap('02-incoming-read');
  // read it: hold the takedown key + the move's direction, then let it resolve
  await page.evaluate(() => { const A = window.CageRules, IN = window.MMASim.IN, G = A.state.ground; if (G && G.trans) { A.held = IN.GRAPPLE | IN[G.trans.dir]; A.tick(8); } });
  await snap('03-guessed');
  await page.evaluate(() => { const A = window.CageRules; A.tick(30); A.held = 0; });
  await snap('04-after-read');
  // my own move: forward + grapple from wherever we are now
  await page.evaluate(() => { const A = window.CageRules, IN = window.MMASim.IN; const G = A.state.ground; if (!G) A.sim._enterGround(A.state.f[0], A.state.f[1], 'td', 'guard'); A.tick(20); A.held = IN.FWD; A.pressed = IN.GRAPPLE; A.tick(6); A.held = 0; });
  await snap('05-my-move');
  await page.evaluate(() => { const A = window.CageRules; A.tick(40); });
  await snap('06-my-move-resolved');
  // a locked submission (me attacking from mount)
  await page.evaluate(() => { const A = window.CageRules, S = A.state; if (!S.ground) A.sim._enterGround(S.f[0], S.f[1], 'td', 'mount'); else { S.ground.top = 0; S.ground.bottom = 1; S.f[0].ground = 'top'; S.f[1].ground = 'bottom'; S.ground.pos = 'mount'; S.ground.trans = null; S.f[0].act = { type: 'idle', name: '', t: 0, dur: 0, hit: false }; S.f[1].act = { type: 'idle', name: '', t: 0, dur: 0, hit: false }; } A.sim._startSub(S.f[0], S.f[1], 'top', 'armbar'); A.held = window.MMASim.IN.GRAPPLE; A.tick(30); A.pressed = window.MMASim.IN.LEFT; A.tick(5); });
  await snap('07-submission-crank');
  await page.evaluate(() => { const A = window.CageRules; A.tick(120); A.held = 0; });
  await snap('08-submission-later');
  // the CPU attacking me: bottom, caught
  await page.evaluate(() => { const A = window.CageRules, S = A.state; if (S.ground) { S.ground.sub = null; } else A.sim._enterGround(S.f[1], S.f[0], 'td', 'mount'); S.ground.top = 1; S.ground.bottom = 0; S.f[1].ground = 'top'; S.f[0].ground = 'bottom'; S.ground.pos = 'mount'; S.ground.trans = null; S.f[0].act = { type: 'idle', name: '', t: 0, dur: 0, hit: false }; S.f[1].act = { type: 'idle', name: '', t: 0, dur: 0, hit: false }; A.sim._startSub(S.f[1], S.f[0], 'top', 'arm triangle'); for (let k = 0; k < 400; k++) { A.tick(1); const G = S.ground; if (G && G.sub && G.sub.crank && G.sub.crank.t < G.sub.crank.win * 0.5) break; } });
  await snap('09-defending-crank');
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  server.close();
})();
