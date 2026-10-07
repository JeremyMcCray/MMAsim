// Regression check for the double-tap-BLOCK push: single tap must not push, double tap shoves the opponent
// off (physics and legacy models), and a push from range whiffs.   node tools/push-test.js
const RAPIER = require('./rapier.js');
const P = require('../js/physics.js');
(async () => {
  await P.init(RAPIER);
  const { Sim, describe, IN } = require('../js/sim.js');
  for (const phys of [true, false]) {
    const sim = new Sim({ seed: 7, players: [{ fighter: 'striker' }, { fighter: 'wrestler' }], physics: phys });
    const S = sim.state, f = S.f;
    const dist = () => Math.hypot(f[1].x - f[0].x, f[1].z - f[0].z);
    let t = 0; const tick = (h0, p0, h1 = 0) => { sim.setInput(0, h0, p0); sim.setInput(1, h1, 0); sim.step(1/60); t++; };
    while (S.phase !== 'fight') tick(0, 0);
    // both walk in until they are jammed up
    for (let i = 0; i < 240 && dist() > 0.85; i++) tick(IN.FWD, 0, IN.FWD);
    const d0 = dist();
    // single tap: must NOT push
    tick(IN.BLOCK, IN.BLOCK); for (let i = 0; i < 30; i++) tick(0, 0);
    const evs1 = sim.drainEvents().filter(e => e.k === 'push');
    // double tap
    tick(IN.BLOCK, IN.BLOCK); for (let i = 0; i < 5; i++) tick(0, 0); tick(IN.BLOCK, IN.BLOCK);
    const act = f[0].act.type, oact = f[1].act.type;
    let dmax = dist();
    let ymin = 9; for (let i = 0; i < 45; i++) { tick(0, 0); dmax = Math.max(dmax, dist()); if (sim.phys) ymin = Math.min(ymin, sim.phys.fighters[1].bodies.pelvis.translation().y); } console.log('  opp pelvis min y', ymin.toFixed(2), 'down?', sim.phys ? sim.phys.fighters[1].isDown() : '-', 'act', f[1].act.type);
    const evs2 = sim.drainEvents().filter(e => e.k === 'push');
    console.log(`physics=${phys} start=${d0.toFixed(2)} singleTapPushes=${evs1.length} doubleTap: act=${act} opp=${oact} ev=${evs2.map(e => describe(e, S)).join('|')} maxDist=${dmax.toFixed(2)} stam=${f[0].stam.toFixed(1)}`);
    // too far: whiff
    for (let i = 0; i < 120; i++) tick(IN.BACK, 0);
    const dfar = dist();
    tick(IN.BLOCK, IN.BLOCK); for (let i = 0; i < 4; i++) tick(0, 0); tick(IN.BLOCK, IN.BLOCK);
    for (let i = 0; i < 30; i++) tick(0, 0);
    console.log(`  from ${dfar.toFixed(2)}m: ${sim.drainEvents().filter(e => e.k === 'push').map(e => describe(e, S) + ' ok=' + e.ok).join('|')}`);
    sim.destroy();
  }
})();
