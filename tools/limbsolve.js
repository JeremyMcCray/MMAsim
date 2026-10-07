// Keyframe authoring aid: given where the elbow and fist (or knee and foot) should be in the PELVIS frame
// (origin at the hips, +Z towards the opponent, +X the fighter's right, +Y up; stance hips sit at y=0),
// find the upper/lower segment Euler angles (deg, THREE 'XYZ') that put them there under the given torso pose.
// Usage from node: const { solveArm, solveLeg } = require('./tools/limbsolve.js');
const P = require('../js/physics.js');
const m = P.math;
const H = P.HOVER_HEIGHT;
function evalPose(pose, upper, lower, side, kind) {
  const r = P.fk(pose, 0);
  const lo = r.p[lower], ql = r.q[lower];
  const jointOff = kind === 'arm' ? 0.14 : 0.24;               // lower segment's top end = elbow / knee
  const mid = m.vAdd(lo, m.qRot(ql, { x: 0, y: jointOff, z: 0 }));
  const tip = r.w[kind === 'arm' ? side + 'Fist' : side + 'Foot'];
  return { mid: [mid.x, mid.y - H, mid.z], tip: [tip.x, tip.y - H, tip.z] };
}
function solve(kind, side, torso, midT, tipT, opts) {
  opts = opts || {};
  const upper = kind === 'arm' ? side + 'UpperArm' : side + 'Thigh', lower = kind === 'arm' ? side + 'Forearm' : side + 'Shin';
  const base = Object.assign({}, P.POSES.STANCE, torso);
  const wMid = opts.midWeight == null ? 1 : opts.midWeight;
  // joint limits (deg): the elbow / knee is a hinge (lower z fixed at 0, the upper segment's twist orients it)
  const sgn = side === 'r' ? 1 : -1;
  const LIM = kind === 'arm'
    ? { u: [[-185, 50], [-125, 125], sgn > 0 ? [-40, 150] : [-150, 40]], l: [-150, -3] }
    : { u: [[-170, 60], [-70, 70], sgn > 0 ? [-25, 130] : [-130, 25]], l: [3, 150] };
  const pen = (x, lim) => x < lim[0] ? (lim[0] - x) : x > lim[1] ? (x - lim[1]) : 0;
  const ref = opts.ref || null; // stay near this (previous frame) when several solutions fit
  const cost = (v) => {
    const pose = Object.assign({}, base); pose[upper] = [v[0], v[1], v[2]]; pose[lower] = [v[3], 0, 0];
    const e = evalPose(pose, upper, lower, side, kind);
    const d = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    let c = d(e.tip, tipT) + wMid * d(e.mid, midT);
    c += 1e-3 * (pen(v[0], LIM.u[0]) + pen(v[1], LIM.u[1]) + pen(v[2], LIM.u[2]) + pen(v[3], LIM.l)) ** 2;
    if (ref) c += 2e-7 * ((v[0] - ref[0]) ** 2 + (v[1] - ref[1]) ** 2 + (v[2] - ref[2]) ** 2);
    return c;
  };
  let best = null, bestC = 1e9;
  const starts = opts.starts || 24;
  for (let s = 0; s < starts; s++) {
    let v = s === 0 && opts.init ? opts.init.slice() : [LIM.u[0][0] + Math.random() * (LIM.u[0][1] - LIM.u[0][0]), LIM.u[1][0] + Math.random() * (LIM.u[1][1] - LIM.u[1][0]), LIM.u[2][0] + Math.random() * (LIM.u[2][1] - LIM.u[2][0]), LIM.l[0] + Math.random() * (LIM.l[1] - LIM.l[0]), 0];
    if (s === 1 && ref) v = ref.slice().concat([0]).slice(0, 5);
    let c = cost(v), step = 30;
    while (step > 0.05) {
      let improved = false;
      for (let i = 0; i < 4; i++) for (const dir of [1, -1]) {
        const t = v.slice(); t[i] += dir * step; const tc = cost(t);
        if (tc < c) { v = t; c = tc; improved = true; }
      }
      if (!improved) step *= 0.5;
    }
    if (c < bestC) { bestC = c; best = v; }
  }
  const pose = Object.assign({}, base); pose[upper] = [best[0], best[1], best[2]]; pose[lower] = [best[3], 0, 0];
  const got = evalPose(pose, upper, lower, side, kind);
  const r = (x) => Math.round(x);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return { upper: [r(best[0]), r(best[1]), r(best[2])], lower: [r(best[3]), 0, 0], err: d(got.tip, tipT), errMid: d(got.mid, midT), got };
}
const solveArm = (side, torso, elbow, fist, opts) => solve('arm', side, torso, elbow, fist, opts);
const solveLeg = (side, torso, knee, foot, opts) => solve('leg', side, torso, knee, foot, opts);
module.exports = { solveArm, solveLeg, evalPose };
if (require.main === module) {
  // demo: where the stance puts things
  const r = P.fk(P.POSES.STANCE, 0);
  const f = (v) => [v.x, v.y - H, v.z].map(x => x.toFixed(2)).join(' ');
  console.log('stance rFist', f(r.w.rFist), 'lFist', f(r.w.lFist), 'head', f(r.p.head));
}
