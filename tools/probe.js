// Authoring aid for js/physics.js strikes. Throws every strike at a standing opponent over a
// sweep of distances and prints what it connects with, so poses and AI ranges can be tuned.
//   node tools/probe.js            (opponent in stance)
//   node tools/probe.js guard      (opponent holding block)
const RAPIER = require('./rapier.js');
const P = require('../js/physics.js');
const GUARD = process.argv[2] === 'guard';

(async () => {
  await P.init(RAPIER);
  {
    const w = new P.World({ rand: () => 0.5 });
    for (let i = 0; i < 60 * 3; i++) w.step();
    const p0 = w.fighters[0].position(), h0 = w.fighters[0].headPosition();
    console.log('idle 3s: pelvis y', p0.y.toFixed(3), 'head y', h0.y.toFixed(3), 'drift', (p0.x + 1.3).toFixed(3), p0.z.toFixed(3));
    w.free();
  }
  const dists = []; for (let d = 0.5; d <= 1.35; d += 0.1) dists.push(+d.toFixed(2));
  console.log('\ndistance:        ' + dists.map(d => String(Math.round(d * 100)).padStart(4)).join(''));
  const code = { head: 'H', chest: 'B', pelvis: 'P', thigh: 'L', shin: 'S', foot: 'f', upperArm: 'U', forearm: 'A', fist: 'g' };
  const summary = {};
  for (const k in P.STRIKES) {
    const d = P.STRIKES[k];
    let line = '', last = null, lastGood = null, vmax = 0;
    for (const dist of dists) {
      const w = new P.World({ rand: () => 0.5, positions: [[0, 0], [0, dist]] });
      const a = w.fighters[0], b = w.fighters[1];
      b.guard = GUARD;
      for (let i = 0; i < 45; i++) w.step();
      a.startStrike(d, 1);
      let res = null, glance = false;
      for (let i = 0; i < 80 && a.strike; i++) {
        const hits = w.step();
        if (hits[0]) { if (hits[0].glance) glance = true; else { res = hits[0]; break; } }
      }
      let c = res ? code[res.partName] : glance ? '.' : ' ';
      if (res && res.vn < 4) c = c.toLowerCase();
      line += '   ' + c;
      if (res) { last = dist; vmax = Math.max(vmax, res.vn); if (res.region === d.part || (d.part === 'body' && res.region === 'legs')) lastGood = dist; }
      w.free();
    }
    summary[k] = { last, lastGood, vmax };
    console.log(k.padEnd(16), line, '  max', last, 'intended', lastGood, 'vn', vmax.toFixed(1), 'fk-range', d.range.toFixed(2));
  }
  console.log('\nH head, B chest, P pelvis, L thigh, S shin, f foot, U upper arm, A forearm; lower-case = soft (<4 m/s), . = glancing only');
})();
