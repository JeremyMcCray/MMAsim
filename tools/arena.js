// Shared headless match runner for the training tools (Node only).
//   const { init, runMatch } = require('./arena.js');
//   await init();
//   runMatch({ seed, brains: [specA, specB], fighters: ['striker', 'wrestler'], rounds: 1, roundLen: 120 })
// A brain spec is { type: 'cpu', diff } (scripted js/ai.js) or { type: 'nn', w, arch } (js/brain.js genome).
const RAPIER = require('./rapier.js');
const P = require('../js/physics.js');
let M, AI, B;

async function init() {
  if (M) return;
  await P.init(RAPIER);
  M = require('../js/sim.js');
  AI = require('../js/ai.js');
  B = require('../js/brain.js');
}

function makeBrain(idx, spec, rng) {
  if (spec.type === 'cpu') { const b = new AI.CpuBrain(idx, spec.diff == null ? 0.6 : spec.diff); if (rng) b.rng = rng; return b; }
  return new B.NeuralBrain(idx, spec);
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Returns per-fighter tallies and the winner (0 / 1 / null). `score` is a shaped fitness signal from each side's
// point of view: win/loss plus damage dealt vs taken, so even a lost fight tells a brain something.
function runMatch(opts) {
  const seed = opts.seed | 0;
  const rounds = opts.rounds || 1, roundLen = opts.roundLen || 120;
  const fighters = opts.fighters || ['striker', 'wrestler'];
  const players = [{ fighter: fighters[0] }, { fighter: fighters[1] }];
  const sim = new M.Sim({ seed, rounds, roundLen, players, grappling: opts.grappling !== false });
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const brains = [makeBrain(0, opts.brains[0], rng), makeBrain(1, opts.brains[1], rng)];
  const S = sim.state;
  const tally = [{ landed: 0, dmg: 0, kd: 0, td: 0, thrown: 0, ctrl: 0 }, { landed: 0, dmg: 0, kd: 0, td: 0, thrown: 0, ctrl: 0 }];
  const maxTicks = 60 * (rounds * (roundLen + 12) + 20);
  let ticks = 0;
  while (S.phase !== 'over' && ticks < maxTicks) {
    for (let i = 0; i < 2; i++) { const o = brains[i].update(S, 1 / 60); sim.setInput(i, o.held, o.pressed); }
    sim.acc = 0; sim.step(1 / 60); ticks++;
    for (const ev of sim.drainEvents()) {
      if (ev.k === 'hit') { tally[ev.i].landed++; tally[ev.i].dmg += ev.dmg; }
      else if (ev.k === 'kd') { if (ev.i != null) tally[ev.i].kd++; }
      else if (ev.k === 'td') { if (ev.i != null) tally[ev.i].td++; }
    }
  }
  const R = S.result;
  const winner = R ? R.winner : null;
  for (let i = 0; i < 2; i++) { tally[i].thrown = S.f[i].ts.thrown + S.f[i].rs.thrown; tally[i].ctrl = S.f[i].ts.ctrl + S.f[i].rs.ctrl; }
  const score = [0, 0];
  for (let i = 0; i < 2; i++) {
    const me = S.f[i], op = S.f[1 - i];
    const dealt = op.dmg.head + op.dmg.body * 0.6 + op.dmg.legs * 0.5;
    const taken = me.dmg.head + me.dmg.body * 0.6 + me.dmg.legs * 0.5;
    let s = (dealt - taken) / 100;
    s += tally[i].kd * 0.4 + tally[i].td * 0.1 + Math.min(tally[i].landed, 60) * 0.004;
    s -= Math.max(0, tally[i].thrown - tally[i].landed * 2) * 0.002; // whiffing / swinging at nothing
    s += (me.stamMax - 30) / 70 * 0.25; // a tank that is still there at the end: pacing pays
    if (winner === i) s += 1.5 + (R.method.indexOf('Decision') < 0 ? 0.5 : 0);
    else if (winner === 1 - i) s -= 1.5;
    score[i] = s;
  }
  const out = { seed, winner, method: R ? R.method : 'none', round: R ? R.round : null, ticks, score, tally, dmg: S.f.map(f => ({ head: Math.round(f.dmg.head), body: Math.round(f.dmg.body), legs: Math.round(f.dmg.legs) })) };
  sim.destroy();
  return out;
}

module.exports = { init, runMatch, makeBrain, mulberry32 };
