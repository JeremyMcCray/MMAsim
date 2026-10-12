// Drives the striking tutorial end to end in a headless Chromium with the keyboard and screenshots the prompt and the step card.
//   node tools/tutorial-test.js [repo root = ..] [shots dir = tools/shots]
// Checks the first-run prompt rules (3 opens, the never-again box), then plays every drill, the spar round, the
// end screen and the SKIP / QUIT paths. CHROME_PATH overrides the browser (defaults to the cached chromium-1234 build).
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const OUT = path.resolve(process.argv[3] || path.join(__dirname, 'shots'));
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = require('playwright');
const CHROME = process.env.CHROME_PATH || 'C:/Users/Keems/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await new Promise(r => server.listen(0, r));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.addInitScript(() => { window.desktop = { quit() {}, toggleFullscreen() {}, version: '0.1.0' }; });
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  // ---- 1. first open: the prompt shows; stored count becomes 1
  await page.goto(url); await sleep(2500);
  const promptShown = await page.evaluate(() => !document.querySelector('#tutorPrompt').classList.contains('hidden'));
  const shownCount = await page.evaluate(() => localStorage.getItem('cr_tut_shown'));
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  log('prompt visible on first open:', promptShown, 'count:', shownCount, 'focused:', focused);
  await page.screenshot({ path: path.join(OUT, 'tut-prompt.png') });
  // NOT NOW with the checkbox ticked -> never again
  await page.click('#tutNever'); await page.click('#btnTutNo');
  log('after NOT NOW + never:', await page.evaluate(() => ({ hidden: document.querySelector('#tutorPrompt').classList.contains('hidden'), off: localStorage.getItem('cr_tut_off') })));
  await page.reload(); await sleep(1500);
  log('prompt on reload with never set (expect false):', await page.evaluate(() => !document.querySelector('#tutorPrompt').classList.contains('hidden')));
  // the 3-open rule: clear the flag, reload three more times
  await page.evaluate(() => { localStorage.removeItem('cr_tut_off'); localStorage.setItem('cr_tut_shown', '0'); });
  const seq = [];
  for (let k = 0; k < 4; k++) { await page.reload(); await sleep(1200); seq.push(await page.evaluate(() => !document.querySelector('#tutorPrompt').classList.contains('hidden'))); if (seq[k]) await page.keyboard.press('Escape'); }
  log('prompt over 4 opens (expect true,true,true,false):', seq.join(','));

  // ---- 2. start from the menu button and run the drills
  await page.evaluate(() => localStorage.setItem('cr_tut_shown', '0'));
  await page.reload(); await sleep(1500);
  log('menu button present:', await page.evaluate(() => !!document.querySelector('#btnTutorial')));
  await page.click('#btnTutYes');
  await page.waitForFunction(() => window.CageRules.sim && window.CageRules.state.phase === 'fight', null, { timeout: 60000 });
  log('fight phase reached, mode:', await page.evaluate(() => window.CageRules.mode), 'clock:', await page.evaluate(() => window.CageRules.state.clock));
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, 'tut-step1.png') });
  const stepIdx = () => page.evaluate(() => window.CageRules.tutor.i);
  const stepId = async () => page.evaluate(() => ['close', 'circle', 'out', 'straight', 'hook', 'uppercut', 'overhand', 'lowkick', 'bkick', 'hkick', 'teep', 'power', 'block', 'push', 'check', 'stance', 'spar'][window.CageRules.tutor.i]);
  const dist = () => page.evaluate(() => { const S = window.CageRules.state; return Math.hypot(S.f[1].x - S.f[0].x, S.f[1].z - S.f[0].z); });
  const cardText = () => page.evaluate(() => document.querySelector('#tutTitle').textContent + ' | ' + document.querySelector('#tutText').textContent.slice(0, 90) + ' | ' + document.querySelector('#tutCount').textContent);
  async function untilStep(target, ms, drive) {
    const t0 = Date.now();
    while (await stepIdx() < target) {
      if (Date.now() - t0 > ms) return false;
      await drive();
    }
    return true;
  }
  const results = {};
  // close: hold W
  log('step', await cardText());
  await page.keyboard.down('w'); results.close = await untilStep(1, 15000, () => sleep(50)); await page.keyboard.up('w');
  log('close ->', results.close, 'dist', (await dist()).toFixed(2), '|', await cardText());
  // circle: hold A
  await page.keyboard.down('a'); results.circle = await untilStep(2, 15000, () => sleep(50)); await page.keyboard.up('a');
  log('circle ->', results.circle, '|', await cardText());
  // out: hold S
  await page.keyboard.down('s'); results.out = await untilStep(3, 15000, () => sleep(50)); await page.keyboard.up('s');
  log('out ->', results.out, 'dist', (await dist()).toFixed(2));
  await page.screenshot({ path: path.join(OUT, 'tut-step4.png') });
  // strike drills: walk in when far, otherwise throw the strike for the step
  const STRIKE = { straight: ['e', ['u', 'i']], hook: ['q', ['u', 'i']], uppercut: [null, ['u', 'i']], overhand: ['r', ['u', 'i']], lowkick: ['r', ['j', 'k']], bkick: ['q', ['j', 'k']], hkick: ['e', ['j', 'k']], teep: [null, ['j', 'k']], power: ['e', ['u', 'i']] };
  for (let idx = 3; idx <= 11; idx++) {
    const id = await stepId(); if (!STRIKE[id]) { log('unexpected step', id); break; }
    const [mod, limbs] = STRIKE[id];
    let n = 0;
    const ok = await untilStep(idx + 1, 90000, async () => {
      const d = await dist();
      const near = id === 'uppercut' || id === 'teep' ? 0.95 : id.endsWith('kick') || id === 'lowkick' ? 1.25 : 1.05;
      if (d > near) { await page.keyboard.down('w'); await sleep(id === 'power' ? 260 : 120); if (id !== 'power') await page.keyboard.up('w'); }
      if (mod) await page.keyboard.down(mod);
      await page.keyboard.press(limbs[n++ % 2]);
      await sleep(80);
      if (mod) await page.keyboard.up(mod);
      await page.keyboard.up('w');
      await sleep(id === 'power' ? 900 : 520);
    });
    results[id] = ok;
    log(id, '->', ok, 'throws', n, '|', await cardText());
  }
  await page.screenshot({ path: path.join(OUT, 'tut-block.png') });
  // block: hold L
  await page.keyboard.down('l'); results.block = await untilStep(13, 40000, () => sleep(60)); await page.keyboard.up('l');
  log('block ->', results.block, '|', await cardText());
  // push: walk into arm's length, then double-tap L
  results.push = await untilStep(14, 60000, async () => {
    if (await dist() > 0.9) { await page.keyboard.down('w'); await sleep(120); await page.keyboard.up('w'); }
    await page.keyboard.press('l'); await sleep(120); await page.keyboard.press('l');
    await sleep(700);
  });
  log('push ->', results.push, 'dist', (await dist()).toFixed(2), '|', await cardText());
  // check: hold O (and stand still)
  await page.keyboard.down('o'); results.check = await untilStep(15, 60000, () => sleep(60)); await page.keyboard.up('o');
  log('check ->', results.check, '|', await cardText());
  await page.screenshot({ path: path.join(OUT, 'tut-check.png') });
  // stance: press X
  results.stance = await untilStep(16, 10000, async () => { await page.keyboard.press('x'); await sleep(400); });
  log('stance ->', results.stance, '|', await cardText());
  await sleep(500);
  log('spar: clock', await page.evaluate(() => window.CageRules.state.clock), 'brain mode', await page.evaluate(() => window.CageRules.brain.mode), 'done flag', await page.evaluate(() => localStorage.getItem('cr_tut_done')));
  await page.screenshot({ path: path.join(OUT, 'tut-spar.png') });
  // skip button hidden in spar; quit returns to the menu
  log('skip hidden in spar:', await page.evaluate(() => document.querySelector('#btnTutSkip').classList.contains('hidden')));
  await page.click('#btnTutQuit'); await sleep(300);
  log('after quit: menu visible', await page.evaluate(() => !document.querySelector('#menu').classList.contains('hidden')), 'card hidden', await page.evaluate(() => document.querySelector('#tutor').classList.contains('hidden')), 'playing', await page.evaluate(() => window.CageRules.playing), 'mode', await page.evaluate(() => window.CageRules.mode));
  // SKIP STEP path and the end screen after a spar KO-free timeout: start again, skip to spar, fast-forward the clock
  await page.click('#btnTutorial');
  await page.waitForFunction(() => window.CageRules.sim && window.CageRules.state.phase === 'fight', null, { timeout: 60000 });
  for (let k = 0; k < 16; k++) { await page.click('#btnTutSkip'); await sleep(30); }
  log('after 16 skips step:', await stepIdx(), 'clock', await page.evaluate(() => window.CageRules.state.clock));
  await page.evaluate(() => { window.CageRules.state.clock = 2; });
  await page.waitForFunction(() => !document.querySelector('#end').classList.contains('hidden'), null, { timeout: 30000 });
  log('end screen:', await page.evaluate(() => document.querySelector('#endMethod').textContent + ' / ' + document.querySelector('#endDetail').textContent + ' / ' + document.querySelector('#btnRematch').textContent));
  await page.screenshot({ path: path.join(OUT, 'tut-end.png') });
  await page.click('#btnMenu'); await sleep(300);
  log('results', JSON.stringify(results));
  log('errors', errors.length ? errors : 'none');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
