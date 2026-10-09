// Low-kick check: holding CHECK cuts a landed low kick to 10% and the kicker eats 15% to his own legs.   node tools/check-test.js
const RAPIER = require('./rapier.js');
const P = require('../js/physics.js');
(async () => {
  await P.init(RAPIER);
  const { Sim, describe, IN } = require('../js/sim.js');
  for (const check of [false, true]) {
    let n = 0, oppLegs = 0, selfLegs = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const sim = new Sim({ seed, players: [{ fighter: 'striker' }, { fighter: 'striker' }] });
      const S = sim.state, f = S.f;
      const dist = () => Math.hypot(f[1].x - f[0].x, f[1].z - f[0].z);
      const def1 = check ? IN.CHECK : 0;
      const tick = (h0, p0) => { sim.setInput(0, h0, p0); sim.setInput(1, def1, 0); sim.step(1 / 60); };
      while (S.phase !== 'fight') tick(0, 0);
      // stop at 1.4 m (settles to ~1.15): any closer and the kick passes under the lifted, checking knee and whiffs
      for (let i = 0; i < 300 && dist() > 1.4; i++) tick(IN.FWD, 0);
      for (let i = 0; i < 20; i++) tick(0, 0);
      const l0 = f[1].dmg.legs, s0 = f[0].dmg.legs;
      tick(IN.MOD3 | IN.RLEG, IN.RLEG);
      for (let i = 0; i < 60; i++) tick(IN.MOD3, 0);
      const evs = sim.drainEvents().filter(e => (e.k === 'hit' || e.k === 'block') && e.i === 0);
      if (evs.length) { n++; oppLegs += f[1].dmg.legs - l0; selfLegs += f[0].dmg.legs - s0; }
      if (seed === 1) console.log('  ', evs.map(e => describe(e, S)).join(' | '), 'checking:', sim.phys.fighters[1].check);
      sim.destroy();
    }
    console.log(`check=${check} landed=${n}/12 avg defender legs +${(oppLegs / Math.max(1, n)).toFixed(2)} avg kicker legs +${(selfLegs / Math.max(1, n)).toFixed(2)}`);
  }
})();
