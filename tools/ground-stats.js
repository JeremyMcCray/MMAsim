// Ground-game balance report: CPU-vs-CPU fights, counting what happens on the mat.
//   node tools/ground-stats.js [fights=12] [seed=1337] [difficulty=0.6]
// Prints transitions (landed / denied / wrong guesses), submission entries, locks, cranks, escapes and taps,
// time spent on the ground per trip, referee stand-ups and how the fights ended.
const RAPIER = require('./rapier.js');
const P = require('../js/physics.js');
const fights = parseInt(process.argv[2] || '12', 10);
const seed0 = parseInt(process.argv[3] || '1337', 10);
const diff = parseFloat(process.argv[4] || '0.6');

(async () => {
  await P.init(RAPIER);
  const { Sim, ROSTER, mulberry32 } = require('../js/sim.js');
  const { CpuBrain } = require('../js/ai.js');
  const keys = Object.keys(ROSTER);
  const A = { fights: 0, finishes: {}, trips: 0, groundT: 0, att: 0, land: 0, denied: 0, wrong: 0, flips: 0, stands: 0, subTry: 0, subDenied: 0, locks: 0, cranks: 0, cranksRead: 0, escapes: 0, taps: 0, ref: 0, refWarn: 0, letup: 0, gHits: 0, gBlocked: 0, lockT: [] };
  for (let n = 0; n < fights; n++) {
    const seed = seed0 + n;
    const players = [{ fighter: keys[n % 4] }, { fighter: keys[(n + 1 + (n >> 2)) % 4] }];
    const sim = new Sim({ seed, rounds: 3, roundLen: 180, players });
    const brains = [new CpuBrain(0, diff, mulberry32(seed * 2 + 1)), new CpuBrain(1, diff, mulberry32(seed * 2 + 2))];
    const S = sim.state;
    let ticks = 0, wasGround = false, lockAt = 0;
    while (S.phase !== 'over' && ticks < 60 * 60 * 12) {
      for (let i = 0; i < 2; i++) { const o = brains[i].update(S, 1 / 60); sim.setInput(i, o.held, o.pressed); }
      sim.step(1 / 60); ticks++;
      if (S.ground) A.groundT += 1 / 60;
      if (!!S.ground !== wasGround) { wasGround = !!S.ground; if (wasGround) A.trips++; }
      for (const ev of sim.drainEvents()) {
        switch (ev.k) {
          case 'gattempt': if (ev.sub) A.subTry++; else A.att++; break;
          case 'gread': if (!ev.sub) { if (ev.res === 'land') A.land++; else if (ev.res === 'denied') A.denied++; else A.wrong++; } else if (ev.res === 'denied') A.subDenied++; break;
          case 'gresult': if (ev.ok && ev.flip) A.flips++; if (ev.ok && ev.stand) A.stands++; break;
          case 'sub': A.locks++; lockAt = S.t; break;
          case 'subcrank': A.cranks++; if (!ev.ok) A.cranksRead++; break;
          case 'subescape': A.escapes++; A.lockT.push(S.t - lockAt); break;
          case 'tap': A.taps++; A.lockT.push(S.t - lockAt); break;
          case 'standup': if (ev.reason === 'ref') A.ref++; else if (ev.reason === 'letup') A.letup++; break;
          case 'refwarn': A.refWarn++; break;
          case 'hit': if (ev.ground) A.gHits++; break;
          case 'block': if (!ev.kind) A.gBlocked++; break;
        }
      }
    }
    const R = S.result;
    const method = R ? R.method.replace(/\(.*\)/, '').trim() : 'timeout';
    A.finishes[method] = (A.finishes[method] || 0) + 1;
    A.fights++;
    console.log(`fight ${n + 1} seed ${seed}: ${R ? R.method + ' R' + R.round + ' ' + (R.time || '') + ' winner ' + (R.winner == null ? 'none' : S.f[R.winner].name) : 'no result'}`);
    sim.destroy();
  }
  const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-';
  console.log('\n== ground report over', A.fights, 'fight(s), difficulty', diff);
  console.log('finishes', JSON.stringify(A.finishes));
  console.log(`trips to the mat ${A.trips}, ${(A.groundT / Math.max(1, A.trips)).toFixed(1)} s each, ${(A.groundT / A.fights).toFixed(0)} s per fight`);
  console.log(`transitions ${A.att}: landed ${A.land} (${A.wrong} on a wrong guess), denied ${A.denied} (${(100 * A.denied / Math.max(1, A.att)).toFixed(0)}%); reversals ${A.flips}, stand-ups ${A.stands}`);
  console.log(`submissions: entries ${A.subTry}, denied ${A.subDenied}, locked ${A.locks}, cranks ${A.cranks} (${A.cranksRead} read), escapes ${A.escapes}, taps ${A.taps}, avg hold ${avg(A.lockT)} s`);
  console.log(`ground strikes landed ${A.gHits}, covered ${A.gBlocked}; referee warnings ${A.refWarn}, stand-ups ${A.ref}, let-ups ${A.letup}`);
})();
