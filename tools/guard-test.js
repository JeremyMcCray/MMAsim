// Guard test: fighter 1 stands and holds BLOCK, fighter 0 walks into range and throws a strike over and over.
// Prints, per strike, how many landed clean on the head / body vs were taken on the arms.
//   node tools/guard-test.js [strikes=lh_straight,...] [low]     ('low': the dummy holds BLOCK + MOD3, the body guard)
const RAPIER = require('./rapier.js');
const P = require('../js/physics.js');
(async () => {
  await P.init(RAPIER);
  const { Sim, IN, STRIKES } = require('../js/sim.js');
  const list = (process.argv[2] || 'lh_straight,rh_straight,lh_hook,rh_hook,rl_hkick,ll_hkick,rh_uppercut,lh_overhand').split(',');
  for (const key of list) {
    const st = STRIKES[key];
    const tally = { head: 0, body: 0, legs: 0, arms: 0, miss: 0, dmgClean: 0, dmgBlocked: 0 };
    for (const seed of [1, 2, 3, 4]) {
      const sim = new Sim({ seed, players: [{ fighter: 'striker' }, { fighter: 'striker' }] });
      const S = sim.state, f = S.f;
      const dist = () => Math.hypot(f[1].x - f[0].x, f[1].z - f[0].z);
      const guardBits = IN.BLOCK | (process.argv[3] === 'low' ? IN.MOD3 : 0);
      const tick = (h0, p0) => { sim.setInput(0, h0, p0); sim.setInput(1, guardBits, 0); sim.step(1 / 60); };
      while (S.phase !== 'fight') tick(0, 0);
      const want = st.range - (parseFloat(process.env.CLOSE) || 0.05); // CLOSE=0.2 to have him step in deeper
      for (let n = 0; n < 25 && S.phase === 'fight'; n++) {
        for (let i = 0; i < 180 && Math.abs(dist() - want) > 0.04; i++) tick(dist() > want ? IN.FWD : IN.BACK, 0);
        for (let i = 0; i < 240 && !(f[1].act.type === 'idle' && f[1].blocking && f[0].act.type === 'idle'); i++) tick(0, 0); // let him settle back into the guard
        const mod = key.indexOf('straight') > 0 || key.indexOf('hkick') > 0 ? IN.MOD2 : key.indexOf('hook') > 0 || key.indexOf('bkick') > 0 ? IN.MOD1 : key.indexOf('overhand') > 0 ? IN.MOD3 : 0;
        const limb = key.startsWith('lh') ? IN.LHAND : key.startsWith('rh') ? IN.RHAND : key.startsWith('ll') ? IN.LLEG : IN.RLEG;
        tick(mod, limb);
        for (let i = 0; i < 70; i++) tick(mod, 0);
        for (const ev of sim.drainEvents()) {
          if (ev.i !== 0) continue;
          if (ev.k === 'hit') { tally[ev.part]++; tally.dmgClean += ev.dmg; }
          else if (ev.k === 'block') { tally.arms++; }
          else if (ev.k === 'miss') tally.miss++;
        }
        f[1].dmg.head = 0; f[1].dmg.body = 0; f[1].rocked = 0; f[1].stam = 100; f[0].stam = 100; // keep the dummy fresh
      }
      sim.destroy();
    }
    console.log(`${(st.name).padEnd(16)} clean: head ${String(tally.head).padStart(3)} body ${String(tally.body).padStart(3)} legs ${String(tally.legs).padStart(3)} | blocked ${String(tally.arms).padStart(3)} | miss ${String(tally.miss).padStart(3)} | clean dmg ${tally.dmgClean.toFixed(1)}`);
  }
})();
