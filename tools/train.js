#!/usr/bin/env node
// Evolve neural fighter brains (js/brain.js) by self-play.
//
//   node tools/train.js [--minutes 300] [--pop 32] [--workers N] [--fresh] [--out brains]
//                       [--gens N] [--matches 3] [--rounds 1] [--len 180] [--checkpoints 10] [--seed 1]
//
// Every generation each genome fights `matches` other genomes from the population (random archetypes,
// random seeds), one scripted CPU (js/ai.js) and, once some exist, one earlier champion from the hall of
// fame. Fitness is the mean shaped score (win/loss + damage dealt vs taken + knockdowns, takedowns...).
// The best genomes survive unchanged, the rest of the next generation is bred from tournament-selected
// parents with crossover and gaussian mutation.
//
// Checkpoints: `checkpoints` snapshots of the reigning champion are written to <out>/gen-NNNN.json at
// evenly spaced points of the run (by time, or by generation if --gens is given), each scored against the
// scripted CPU at all three levels so the index shows how skill grew. <out>/index.json lists them (the game
// reads it), <out>/population.json holds the whole population so the next run resumes where this one ended.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// ---------------- worker ----------------
if (!isMainThread) {
  const A = require('./arena.js');
  let pop = [], hof = [];
  A.init().then(() => {
    parentPort.on('message', (msg) => {
      if (msg.type === 'pop') { pop = msg.pop; hof = msg.hof; parentPort.postMessage({ type: 'ok' }); return; }
      if (msg.type === 'matches') {
        const out = [];
        for (const m of msg.matches) {
          const spec = (s) => s.type === 'nn' ? { type: 'nn', arch: msg.arch, w: pop[s.i] } : s.type === 'hof' ? { type: 'nn', arch: hof[s.i].arch, w: hof[s.i].w } : s;
          try {
            const r = A.runMatch({ seed: m.seed, brains: [spec(m.a), spec(m.b)], fighters: m.fighters, rounds: msg.rounds, roundLen: msg.len });
            out.push({ id: m.id, winner: r.winner, method: r.method, score: r.score, ticks: r.ticks });
          } catch (e) { out.push({ id: m.id, error: String(e && e.stack || e) }); }
        }
        parentPort.postMessage({ type: 'results', results: out });
      }
    });
    parentPort.postMessage({ type: 'ready' });
  });
  return;
}

// ---------------- main ----------------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = process.argv[i + 1]; if (v == null || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } }
}
const num = (k, d) => args[k] != null ? parseFloat(args[k]) : d;
const OPT = {
  minutes: num('minutes', 300), gens: num('gens', 0), pop: num('pop', 32) | 0, matches: num('matches', 3) | 0,
  rounds: num('rounds', 1) | 0, len: num('len', 180) | 0, checkpoints: num('checkpoints', 10) | 0,
  workers: num('workers', Math.max(1, os.cpus().length)) | 0, seed: num('seed', Date.now() % 1e9) | 0,
  out: args.out || path.join(__dirname, '..', 'brains'), fresh: !!args.fresh, keep: num('keep', 40) | 0,
  elite: num('elite', 4) | 0, top: num('top', 3) | 0, mutRate: num('mut', 0.06), mutSigma: num('sigma', 0.12), bench: num('bench', 24) | 0
};
const FIGHTERS = ['striker', 'wrestler', 'grappler', 'balanced'];
const LEVELS = [0.3, 0.6, 0.9];
const { mulberry32 } = require('./arena.js');
const B = require('../js/brain.js');
const ARCH = B.ARCH;
const rng = mulberry32(OPT.seed);
const gauss = () => { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const pick = (arr) => arr[(rng() * arr.length) | 0];

fs.mkdirSync(OPT.out, { recursive: true });
const popFile = path.join(OPT.out, 'population.json');
const indexFile = path.join(OPT.out, 'index.json');
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

// ---- population ----
let gen = 0, population = [], history = [];
const saved = OPT.fresh ? null : readJSON(popFile, null);
if (saved && saved.arch && saved.arch.join() === ARCH.join() && Array.isArray(saved.pop) && saved.pop.length) {
  gen = saved.gen | 0;
  population = saved.pop.map(w => ({ w: Float32Array.from(w), fit: 0, age: 0 }));
  history = saved.history || [];
  console.log(`resuming from ${popFile}: generation ${gen}, ${population.length} genomes`);
  while (population.length < OPT.pop) population.push({ w: mutate(pick(population).w, 2), fit: 0, age: 0 });
  population.length = Math.min(population.length, OPT.pop);
} else {
  if (saved) console.log('saved population is incompatible with the current brain architecture — starting fresh');
  population = Array.from({ length: OPT.pop }, () => ({ w: B.NeuralBrain.randomWeights(ARCH, rng), fit: 0, age: 0 }));
  console.log(`fresh population of ${OPT.pop} (${B.paramCount(ARCH)} weights each)`);
}
let index = readJSON(indexFile, { brains: [] });
if (!Array.isArray(index.brains)) index = { brains: [] };
// hall of fame: champions of earlier checkpoints (loaded from disk)
const hof = [];
for (const e of index.brains) { const g = readJSON(path.join(OPT.out, e.file), null); if (g && g.w && g.arch && g.arch.join() === ARCH.join()) hof.push({ arch: g.arch, w: g.w, name: e.name }); }
if (hof.length) console.log(`hall of fame: ${hof.length} earlier champion(s)`);

function mutate(w, strength) {
  const s = strength || 1;
  const out = Float32Array.from(w);
  for (let i = 0; i < out.length; i++) if (rng() < OPT.mutRate * s) out[i] += gauss() * OPT.mutSigma * s;
  if (rng() < 0.1) { const i = (rng() * out.length) | 0; out[i] = (rng() * 2 - 1) * 0.5; } // the odd big jump
  return out;
}
function crossover(a, b) {
  const out = new Float32Array(a.length);
  // block crossover: contiguous runs from one parent or the other (keeps whole neurons together more often)
  let from = rng() < 0.5 ? a : b, next = 0;
  for (let i = 0; i < a.length; i++) {
    if (i >= next) { from = rng() < 0.5 ? a : b; next = i + 8 + ((rng() * 56) | 0); }
    out[i] = from[i];
  }
  return out;
}
function tournament(k) { let best = null; for (let i = 0; i < k; i++) { const c = pick(population); if (!best || c.fit > best.fit) best = c; } return best; }

// ---- workers ----
const workers = [];
function spawnWorkers() {
  return Promise.all(Array.from({ length: OPT.workers }, () => new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: {} });
    w.once('message', (m) => { if (m.type === 'ready') { workers.push(w); resolve(); } });
    w.once('error', reject);
  })));
}
function ask(w, msg) { return new Promise((resolve) => { w.once('message', resolve); w.postMessage(msg); }); }
async function runMatches(matches) {
  const popW = population.map(p => Array.from(p.w));
  await Promise.all(workers.map(w => ask(w, { type: 'pop', pop: popW, hof: hof.map(h => ({ arch: h.arch, w: h.w })) })));
  const chunks = workers.map(() => []);
  matches.forEach((m, i) => chunks[i % workers.length].push(m));
  const res = await Promise.all(workers.map((w, i) => chunks[i].length ? ask(w, { type: 'matches', matches: chunks[i], arch: ARCH, rounds: OPT.rounds, len: OPT.len }) : { results: [] }));
  const out = [];
  for (const r of res) for (const x of r.results) { if (x.error) { console.error('match failed:', x.error); continue; } out.push(x); }
  return out;
}

// ---- a generation ----
async function generation() {
  const matches = []; let id = 0;
  const N = population.length;
  const specNN = (i) => ({ type: 'nn', i });
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < OPT.matches; k++) {
      let j = (rng() * N) | 0; if (j === i) j = (j + 1) % N;
      const swap = rng() < 0.5;
      matches.push({ id: id++, a: specNN(swap ? j : i), b: specNN(swap ? i : j), seed: (rng() * 1e9) | 0, fighters: [pick(FIGHTERS), pick(FIGHTERS)], kind: 'self' });
    }
    // one scripted CPU per genome: an objective yardstick, and a floor of competence early on
    const swap = rng() < 0.5, cpu = { type: 'cpu', diff: pick(LEVELS) };
    matches.push({ id: id++, a: swap ? cpu : specNN(i), b: swap ? specNN(i) : cpu, seed: (rng() * 1e9) | 0, fighters: [pick(FIGHTERS), pick(FIGHTERS)], kind: 'cpu' });
    if (hof.length) {
      const h = { type: 'hof', i: (rng() * hof.length) | 0 }, sw = rng() < 0.5;
      matches.push({ id: id++, a: sw ? h : specNN(i), b: sw ? specNN(i) : h, seed: (rng() * 1e9) | 0, fighters: [pick(FIGHTERS), pick(FIGHTERS)], kind: 'hof' });
    }
  }
  const byId = new Map(matches.map(m => [m.id, m]));
  const results = await runMatches(matches);
  const acc = population.map(() => ({ s: 0, n: 0, cpuW: 0, cpuN: 0 }));
  const finishes = {};
  let ticks = 0;
  for (const r of results) {
    const m = byId.get(r.id); ticks += r.ticks;
    finishes[r.method.replace(/\(.*\)/, '').trim()] = (finishes[r.method.replace(/\(.*\)/, '').trim()] || 0) + 1;
    const sides = [[m.a, 0], [m.b, 1]];
    for (const [spec, side] of sides) {
      if (spec.type !== 'nn') continue;
      const a = acc[spec.i]; a.s += r.score[side]; a.n++;
      if (m.kind === 'cpu') { a.cpuN++; if (r.winner === side) a.cpuW++; }
    }
  }
  let cpuW = 0, cpuN = 0;
  // survivors keep a running average: one lucky generation shouldn't crown a champion
  population.forEach((p, i) => { const f = acc[i].n ? acc[i].s / acc[i].n : -9; p.fit = p.age > 0 ? 0.6 * p.fit + 0.4 * f : f; p.age++; cpuW += acc[i].cpuW; cpuN += acc[i].cpuN; });
  population.sort((a, b) => b.fit - a.fit);
  const mean = population.reduce((s, p) => s + p.fit, 0) / population.length;
  return { best: population[0].fit, mean, cpuWinRate: cpuN ? cpuW / cpuN : 0, finishes, matches: results.length, ticks };
}
function breed() {
  const next = population.slice(0, OPT.elite).map(p => ({ w: p.w, fit: p.fit, age: p.age }));
  while (next.length < OPT.pop) {
    const a = tournament(3), b = tournament(3);
    const child = rng() < 0.7 ? crossover(a.w, b.w) : Float32Array.from(a.w);
    next.push({ w: mutate(child), fit: 0, age: 0 });
  }
  population = next;
}

// ---- benchmark a genome against the scripted CPU (both sides, all archetypes, all levels) ----
async function benchmark(w) {
  const matches = []; let id = 0;
  const seedBase = 777;
  for (let k = 0; k < OPT.bench; k++) {
    const level = LEVELS[k % LEVELS.length], swap = (k >> 1) & 1;
    const f = [FIGHTERS[k % 4], FIGHTERS[(k * 7 + 3) % 4]];
    matches.push({ id: id++, a: swap ? { type: 'cpu', diff: level } : { type: 'hof', i: 0 }, b: swap ? { type: 'hof', i: 0 } : { type: 'cpu', diff: level }, seed: seedBase + k, fighters: f, level, side: swap ? 1 : 0 });
  }
  const saveHof = hof.slice(); hof.length = 0; hof.push({ arch: ARCH, w: Array.from(w) });
  const results = await runMatches(matches);
  hof.length = 0; hof.push(...saveHof);
  const byId = new Map(matches.map(m => [m.id, m]));
  const by = {}; let wins = 0, losses = 0, draws = 0, score = 0;
  for (const r of results) {
    const m = byId.get(r.id); const L = String(m.level);
    by[L] = by[L] || { w: 0, l: 0, d: 0 };
    if (r.winner === m.side) { wins++; by[L].w++; } else if (r.winner == null) { draws++; by[L].d++; } else { losses++; by[L].l++; }
    score += r.score[m.side];
  }
  const n = results.length || 1;
  return { wins, losses, draws, winRate: wins / n, score: score / n, byLevel: by };
}

function thinIndex() {
  // keep at most OPT.keep checkpoints: drop the one closest to its predecessor (never the first or the newest)
  index.brains.sort((a, b) => a.gen - b.gen);
  while (index.brains.length > OPT.keep) {
    let worst = -1, gap = Infinity;
    for (let i = 1; i < index.brains.length - 1; i++) { const g = index.brains[i].gen - index.brains[i - 1].gen; if (g < gap) { gap = g; worst = i; } }
    const [dead] = index.brains.splice(worst, 1);
    try { fs.unlinkSync(path.join(OPT.out, dead.file)); } catch (_) {}
  }
}
async function checkpoint(n, total, elapsedMin) {
  // the fitness ranking is noisy (a handful of fights each): benchmark the top few and crown the one that
  // actually does best against the scripted CPU on fixed seeds
  let champ = population[0], bench = null;
  for (const cand of population.slice(0, OPT.top)) {
    const bm = await benchmark(cand.w);
    if (!bench || bm.winRate > bench.winRate || (bm.winRate === bench.winRate && bm.score > bench.score)) { champ = cand; bench = bm; }
  }
  const file = `gen-${String(gen).padStart(4, '0')}.json`;
  const name = `Gen ${gen}`;
  const genome = { name, gen, arch: ARCH, w: Array.from(champ.w, v => Math.round(v * 1e4) / 1e4), fitness: Math.round(champ.fit * 1000) / 1000, bench, date: new Date().toISOString(), run: { seed: OPT.seed, pop: OPT.pop, rounds: OPT.rounds, len: OPT.len } };
  fs.writeFileSync(path.join(OPT.out, file), JSON.stringify(genome));
  index.brains = index.brains.filter(e => e.file !== file);
  index.brains.push({ file, name, gen, date: genome.date, fitness: genome.fitness, winRate: Math.round(bench.winRate * 1000) / 1000, bench: { wins: bench.wins, losses: bench.losses, draws: bench.draws, byLevel: bench.byLevel }, params: champ.w.length });
  thinIndex();
  index.updated = genome.date; index.arch = ARCH;
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
  hof.push({ arch: ARCH, w: genome.w, name });
  savePopulation();
  console.log(`  >> checkpoint ${n}/${total}: ${file}  vs CPU ${bench.wins}-${bench.losses}-${bench.draws} (${(bench.winRate * 100).toFixed(0)}%)  ` + Object.entries(bench.byLevel).map(([l, v]) => `${l}: ${v.w}-${v.l}-${v.d}`).join('  ') + `  [${elapsedMin.toFixed(1)} min]`);
}
function savePopulation() {
  fs.writeFileSync(popFile, JSON.stringify({ gen, arch: ARCH, pop: population.map(p => Array.from(p.w, v => Math.round(v * 1e4) / 1e4)), history: history.slice(-2000), seed: OPT.seed, date: new Date().toISOString() }));
}

(async () => {
  console.log('options', JSON.stringify(OPT));
  await spawnWorkers();
  const t0 = Date.now(), gen0 = gen;
  const budgetMs = OPT.minutes * 60000;
  let done = 0;
  const total = OPT.checkpoints;
  for (;;) {
    gen++;
    const tg = Date.now();
    const g = await generation();
    const elapsed = Date.now() - t0;
    history.push({ gen, best: +g.best.toFixed(3), mean: +g.mean.toFixed(3), cpu: +g.cpuWinRate.toFixed(3), t: Math.round(elapsed / 1000) });
    console.log(`gen ${String(gen).padStart(4)}  best ${g.best.toFixed(2).padStart(6)}  mean ${g.mean.toFixed(2).padStart(6)}  vs CPU ${(g.cpuWinRate * 100).toFixed(0).padStart(3)}%  ${g.matches} fights ${Math.round((Date.now() - tg) / 1000)}s  ` + Object.entries(g.finishes).map(([k, v]) => k + ' ' + v).join(', '));
    // checkpoint schedule: evenly by time (or by generation when --gens is given)
    const frac = OPT.gens > 0 ? (gen - gen0) / OPT.gens : elapsed / budgetMs;
    const finished = OPT.gens > 0 ? gen - gen0 >= OPT.gens : elapsed >= budgetMs;
    const due = finished ? total : Math.floor(frac * total);
    if (due > done) { done++; await checkpoint(done, total, elapsed / 60000); }
    if (finished) break;
    breed();
    if (gen % 5 === 0) savePopulation();
  }
  savePopulation();
  console.log(`done: ${gen} generations, ${done} checkpoints in ${OPT.out}`);
  for (const w of workers) w.terminate();
})().catch(e => { console.error(e); process.exit(1); });
