// Stand-up balance report: CPU-vs-CPU fights, measuring how the brain spends its stamina.
//   node tools/ai-stats.js [fights=8] [seed=1337] [difficulty=0.6] [difficultyB=difficulty]
const RAPIER = require('./rapier.js');
const P = require('../js/physics.js');
const fights = parseInt(process.argv[2] || '8', 10);
const seed0 = parseInt(process.argv[3] || '1337', 10);
const diffA = parseFloat(process.argv[4] || '0.6');
const diffB = parseFloat(process.argv[5] || String(diffA));

(async () => {
  await P.init(RAPIER);
  const { Sim, ROSTER, mulberry32 } = require('../js/sim.js');
  const { CpuBrain } = require('../js/ai.js');
  const keys = Object.keys(ROSTER);
  const mk = () => ({ thrown: 0, hit: 0, miss: 0, blocked: 0, slips: 0, pushes: 0, dashes: 0, checks: 0, tds: 0, tdOk: 0, kds: 0, wins: 0, stamSum: 0, ticks: 0, lowT: 0, emptyT: 0, blockT: 0, restHiT: 0, maxLoss: 0, repeatPen: 0, dmg: 0 });
  const T = [mk(), mk()];
  const finishes = {};
  for (let n = 0; n < fights; n++) {
    const seed = seed0 + n;
    const players = [{ fighter: keys[n % 4] }, { fighter: keys[(n + 1 + (n >> 2)) % 4] }];
    const sim = new Sim({ seed, rounds: 3, roundLen: 180, players });
    const brains = [new CpuBrain(0, diffA, mulberry32(seed * 2 + 1)), new CpuBrain(1, diffB, mulberry32(seed * 2 + 2))];
    const S = sim.state;
    let ticks = 0;
    const lastStrike = ['', ''], rep = [0, 0];
    while (S.phase !== 'over' && ticks < 60 * 60 * 12) {
      for (let i = 0; i < 2; i++) {
        const o = brains[i].update(S, 1 / 60); sim.setInput(i, o.held, o.pressed);
        if (o.held & 1 << 17) T[i].checks += 1 / 60;
        if (o.pressed & 8192) T[i].dashes++;
      }
      sim.step(1 / 60); ticks++;
      if (S.phase === 'fight' && !S.ground) for (let i = 0; i < 2; i++) {
        const f = S.f[i], t = T[i];
        t.ticks++; t.stamSum += f.stam;
        if (f.stam < 15) t.lowT += 1 / 60;
        if (f.stam < 3) t.emptyT += 1 / 60;
        if (f.blocking) t.blockT += 1 / 60;
        if (f.restT > 2.4) t.restHiT += 1 / 60;
        t.maxLoss = Math.max(t.maxLoss, 100 - f.stamMax);
      }
      for (const ev of sim.drainEvents()) {
        switch (ev.k) {
          case 'hit': if (!ev.ground) { T[ev.i].hit++; T[ev.i].dmg += ev.dmg; } break;
          case 'miss': T[ev.i].miss++; break;
          case 'block': if (ev.kind) T[ev.j != null ? ev.j : 1 - ev.i].blocked++; break;
          case 'slip': T[ev.i].slips++; break;
          case 'push': T[ev.i].pushes++; break;
          case 'shoot': T[ev.i].tds++; break;
          case 'td': T[ev.i].tdOk++; break;
          case 'kd': T[ev.i].kds++; break;
        }
      }
      for (let i = 0; i < 2; i++) { const f = S.f[i]; if (f.act.type === 'strike' && f.act.t === 0) {} }
    }
    for (let i = 0; i < 2; i++) { T[i].thrown += S.f[i].rs.thrown; }
    const R = S.result;
    const method = R ? R.method.replace(/\(.*\)/, '').trim() : 'timeout';
    finishes[method] = (finishes[method] || 0) + 1;
    if (R && R.winner != null) T[R.winner].wins++;
    console.log(`fight ${n + 1} seed ${seed} ${players[0].fighter} v ${players[1].fighter}: ${R ? R.method + ' R' + R.round + ' ' + (R.time || '') + ' winner ' + (R.winner == null ? 'none' : S.f[R.winner].name) : 'no result'}`);
    sim.destroy();
  }
  console.log('\n== stand-up report over', fights, 'fight(s), difficulty', diffA, 'v', diffB);
  console.log('finishes', JSON.stringify(finishes));
  for (let i = 0; i < 2; i++) {
    const t = T[i], per = x => (x / fights).toFixed(1);
    const standT = t.ticks / 60;
    console.log(`[${i}] diff ${i ? diffB : diffA} wins ${t.wins}: thrown ${per(t.thrown)}/fight, landed ${per(t.hit)} (${(100 * t.hit / Math.max(1, t.thrown)).toFixed(0)}%), missed ${per(t.miss)}, blocked ${per(t.blocked)}, dmg ${per(t.dmg)}`);
    console.log(`     avg stam ${(t.stamSum / Math.max(1, t.ticks)).toFixed(0)}, under 15: ${(100 * t.lowT / standT).toFixed(0)}% of stand-up time, empty: ${(100 * t.emptyT / standT).toFixed(0)}%, blocking ${(100 * t.blockT / standT).toFixed(0)}%, rested(>2.4s) ${(100 * t.restHiT / standT).toFixed(0)}%, max-stam lost up to ${t.maxLoss.toFixed(0)}`);
    console.log(`     slips ${per(t.slips)}, pushes ${per(t.pushes)}, dashes ${per(t.dashes)}, checking ${per(t.checks)}s, shots ${per(t.tds)} (${per(t.tdOk)} ok), KDs ${per(t.kds)}`);
  }
})();
