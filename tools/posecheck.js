// Pose sanity check: a fighter's own segments never collide with each other, so a stance / guard pose that
// folds an arm across the chest clips straight through it on screen. This prints, for every static pose,
// where each arm segment sits in the chest's frame and how far it is from the chest box (negative = inside).
//   node tools/posecheck.js            (all poses)
//   node tools/posecheck.js GUARD      (one pose)
const P = require('../js/physics.js');
const { fk, POSES, SEGS, math } = P;
const he = SEGS.chest.shape.slice(1);
const RAD = { upperArm: SEGS.lUpperArm.shape[2], forearm: SEGS.lForearm.shape[2], fist: SEGS.lForearm.extra.shape[1], head: SEGS.head.shape[1] };

function report(name) {
  const pose = POSES[name];
  const r = fk(pose, 0);
  const c = r.p.chest, q = r.q.chest, inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
  const loc = (v) => math.qRot(inv, { x: v.x - c.x, y: v.y - c.y, z: v.z - c.z });
  const gap = (v, rad) => { const l = loc(v); return Math.max(Math.abs(l.x) - he[0], Math.abs(l.y) - he[1], Math.abs(l.z) - he[2]) - rad; };
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const fmt = (v) => [v.x, v.y, v.z].map(x => (x >= 0 ? ' ' : '') + x.toFixed(2)).join(' ');
  console.log('== ' + name);
  let worst = 1;
  for (const s of ['l', 'r']) {
    const ua = r.p[s + 'UpperArm'], fa = r.p[s + 'Forearm'], qf = r.q[s + 'Forearm'];
    const elbow = add(fa, math.qRot(qf, { x: 0, y: 0.14, z: 0 }));
    const rows = [[s + ' upper arm', ua, RAD.upperArm], [s + ' elbow', elbow, RAD.forearm], [s + ' forearm', fa, RAD.forearm], [s + ' fist', r.w[s + 'Fist'], RAD.fist]];
    for (const [label, v, rad] of rows) {
      const g = gap(v, rad); worst = Math.min(worst, g);
      console.log('  ' + label.padEnd(12) + ' chest-local ' + fmt(loc(v)) + '   gap ' + (g >= 0 ? ' ' : '') + g.toFixed(3) + (g < -0.01 ? '   <-- inside the chest' : ''));
    }
  }
  console.log('  worst gap ' + worst.toFixed(3) + (worst < -0.01 ? '  (CLIPS)' : '  ok'));
}
const which = process.argv[2];
for (const n of (which ? [which] : Object.keys(POSES))) if (POSES[n]) report(n);
