// Headless CPU-vs-CPU fight for balancing and regression checks (no browser needed).
//   node tools/headless.js [fights=1] [seed=1337] [verbose=0]
// Prints the event feed (verbose) and a summary: hits by region, average damage per landed
// strike, block / whiff rates, takedowns, ground time and how the fight ended.
const RAPIER = require('./rapier.js');
const P = require('../js/physics.js');
const fights = parseInt(process.argv[2] || '1', 10);
const seed0 = parseInt(process.argv[3] || '1337', 10);
const verbose = process.argv[4] === '1';
const legacy = process.argv[5] === 'legacy'; // run the old swept-tip striking model for comparison

(async () => {
  await P.init(RAPIER);
  const { Sim, describe, ROSTER } = require('../js/sim.js');
  const { CpuBrain } = require('../js/ai.js');
  const keys = Object.keys(ROSTER);
  const agg = { fights: 0, finishes: {}, finishRound: [], hits: 0, dmg: 0, blocks: 0, passive: 0, misses: 0, thrown: 0, head: 0, body: 0, legs: 0, kd: 0, td: 0, tdAtt: 0, vn: [], ms: 0, ticks: 0, parts: {} };
  for (let n = 0; n < fights; n++) {
    const seed = seed0 + n;
    const players = [{ fighter: keys[n % 4] }, { fighter: keys[(n + 1 + (n >> 2)) % 4] }];
    const sim = new Sim({ seed, rounds: 3, roundLen: 180, players, physics: !legacy });
    const brains = [new CpuBrain(0, 0.6), new CpuBrain(1, 0.6)];
    const S = sim.state;
    let t0 = Date.now(), ticks = 0;
    const log = (s) => { if (verbose) console.log(`[R${S.round} ${(S.roundLen - S.clock).toFixed(1).padStart(5)}] ${s}`); };
    while (S.phase !== 'over' && ticks < 60 * 60 * 12) {
      for (let i = 0; i < 2; i++) { const o = brains[i].update(S, 1 / 60); sim.setInput(i, o.held, o.pressed); }
      sim.step(1 / 60); ticks++;
      for (const ev of sim.drainEvents()) {
        const txt = describe(ev, S);
        if (ev.k === 'hit') { agg.hits++; agg.dmg += ev.dmg; agg[ev.part]++; if (ev.vn) agg.vn.push(ev.vn); agg.parts[ev.name] = (agg.parts[ev.name] || 0) + 1; }
        if (ev.k === 'block') { agg.blocks++; if (ev.passive) agg.passive++; }
        if (ev.k === 'miss') agg.misses++;
        if (ev.k === 'kd') agg.kd++;
        if (ev.k === 'td') agg.td++;
        if (ev.k === 'shoot') agg.tdAtt++;
        if (txt && (verbose || ['kd', 'ko', 'tap', 'td', 'end', 'rocked', 'sub', 'standup'].includes(ev.k))) log((ev.k === 'hit' ? `${ev.dmg.toFixed(1)} ${ev.part} vn${ev.vn} ` : '') + txt);
      }
      // cooldown a little after the end so the finish plays out
    }
    // run the 'over' phase briefly (KO collapse) to make sure nothing throws
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    const ms = Date.now() - t0;
    agg.ms += ms; agg.ticks += ticks; agg.fights++;
    const R = S.result;
    const method = R ? R.method.replace(/\(.*\)/, '').trim() : 'timeout';
    agg.finishes[method] = (agg.finishes[method] || 0) + 1;
    agg.finishRound.push(R ? R.round + (R.time ? ' ' + R.time : '') : '?');
    for (const f of S.f) { agg.thrown += f.ts.thrown + f.rs.thrown; }
    const totals = S.f.map(f => `${f.name}: head ${f.dmg.head.toFixed(0)} body ${f.dmg.body.toFixed(0)} legs ${f.dmg.legs.toFixed(0)} stam ${f.stam.toFixed(0)}/${f.stamMax.toFixed(0)} landed ${f.ts.landed + f.rs.landed}/${f.ts.thrown + f.rs.thrown} td ${f.ts.td + f.rs.td}`);
    console.log(`fight ${n + 1} seed ${seed}: ${R ? R.method + ' R' + R.round + ' ' + (R.time || '') + ' winner ' + (R.winner == null ? 'none' : S.f[R.winner].name) : 'no result'}  (${ticks} ticks, ${ms} ms, ${(ms / ticks * 1000).toFixed(0)} us/tick)`);
    console.log('   ' + totals.join(' | '));
    sim.destroy();
  }
  const avgVn = agg.vn.length ? agg.vn.reduce((a, b) => a + b, 0) / agg.vn.length : 0;
  console.log('\n== summary over', agg.fights, 'fight(s)');
  console.log('finishes', JSON.stringify(agg.finishes), 'rounds', agg.finishRound.join(', '));
  console.log(`strikes thrown ${agg.thrown}, landed ${agg.hits} (${(100 * agg.hits / Math.max(1, agg.thrown)).toFixed(0)}%), blocked ${agg.blocks} (${agg.passive} by stray arms), whiffed ${agg.misses}`);
  console.log(`regions: head ${agg.head} body ${agg.body} legs ${agg.legs}; avg dmg/hit ${(agg.dmg / Math.max(1, agg.hits)).toFixed(2)}, avg impact ${avgVn.toFixed(1)} m/s; KD ${agg.kd}; TD ${agg.td}/${agg.tdAtt}`);
  console.log('by strike:', Object.entries(agg.parts).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', '));
  console.log(`speed: ${(agg.ms / agg.ticks * 1000).toFixed(0)} us per 60 Hz tick (budget 16667)`);
})();
