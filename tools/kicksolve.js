// Authoring aid for the roundhouse kicks in js/physics.js. Each keyframe is written as WHERE the knee and the
// foot of each leg should be (fighter frame: origin at the hips, +Z toward the opponent, +X the fighter's left,
// +Y up, metres) plus a heading for a planted foot, and this solves the thigh / shin Euler angles that put them
// there under that frame's torso pose. Prints the frames in the RAW strike format.
//   node tools/kicksolve.js            prints all the kicks
//   node tools/kicksolve.js rl_knee    prints just the named ones (comma separated)
const P = require('../js/physics.js');
const m = P.math;
const H = P.HOVER_HEIGHT;
const S = 'stance';
const vs = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

function legEval(pose, side) {
  const r = P.fk(pose, 0);
  const sh = r.p[side + 'Shin'], q = r.q[side + 'Shin'];
  const knee = m.vAdd(sh, m.qRot(q, { x: 0, y: 0.24, z: 0 }));
  const foot = r.w[side + 'Foot'];
  const dir = m.qRot(q, { x: 0, y: 0, z: 1 });
  const a = (pose[side + 'Ankle'] || 0) * Math.PI / 180, toes = m.qRot(q, { x: 0, y: -Math.sin(a), z: Math.cos(a) });
  return { knee: [knee.x, knee.y - H, knee.z], foot: [foot.x, foot.y - H, foot.z], heading: Math.atan2(dir.x, dir.z) * 180 / Math.PI,
    face: [dir.x, dir.y, dir.z], toes: [toes.x, toes.y, toes.z] };
}
// target: { knee:[x,y,z], foot:[x,y,z], heading?: deg (foot +Z direction, 0 = at the opponent), face?: [x,y,z] direction the
//           kneecap points (shin +Z; sets the thigh twist, which the two positions leave free on a nearly straight leg), ref?: [thigh..., shin] }
function solveLeg(torso, side, target) {
  const base = Object.assign({}, P.POSES.STANCE, torso);
  const sgn = side === 'l' ? 1 : -1;
  const LIM = target.lim || { u: [[-175, 60], [-90, 90], sgn > 0 ? [-30, 135] : [-135, 30]], l: [2, 150] };
  const pen = (x, lim) => x < lim[0] ? (lim[0] - x) : x > lim[1] ? (x - lim[1]) : 0;
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const cost = (v) => {
    const pose = Object.assign({}, base); pose[side + 'Thigh'] = [v[0], v[1], v[2]]; pose[side + 'Shin'] = [v[3], 0, 0];
    const e = legEval(pose, side);
    let c = d2(e.foot, target.foot) + d2(e.knee, target.knee);
    if (target.heading != null) { let dh = ((e.heading - target.heading + 540) % 360) - 180; c += 4e-5 * dh * dh; }
    if (target.face) { const f = target.face, L = Math.hypot(f[0], f[1], f[2]); c += 0.1 * d2(e.face, [f[0] / L, f[1] / L, f[2] / L]); }
    c += 1e-3 * (pen(v[0], LIM.u[0]) + pen(v[1], LIM.u[1]) + pen(v[2], LIM.u[2]) + pen(v[3], LIM.l)) ** 2;
    if (target.ref) c += 1e-7 * ((v[0] - target.ref[0]) ** 2 + (v[1] - target.ref[1]) ** 2 + (v[2] - target.ref[2]) ** 2);
    return c;
  };
  let best = null, bestC = 1e9;
  for (let s = 0; s < 40; s++) {
    let v = s === 0 && target.ref ? target.ref.slice() : [LIM.u[0][0] + Math.random() * (LIM.u[0][1] - LIM.u[0][0]), LIM.u[1][0] + Math.random() * (LIM.u[1][1] - LIM.u[1][0]), LIM.u[2][0] + Math.random() * (LIM.u[2][1] - LIM.u[2][0]), LIM.l[0] + Math.random() * (LIM.l[1] - LIM.l[0])];
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
  const pose = Object.assign({}, base); pose[side + 'Thigh'] = best.slice(0, 3); pose[side + 'Shin'] = [best[3], 0, 0];
  const got = legEval(pose, side);
  const R = (x) => Math.round(x);
  return { thigh: [R(best[0]), R(best[1]), R(best[2])], shin: [R(best[3]), 0, 0], err: Math.sqrt(d2(got.foot, target.foot)), errK: Math.sqrt(d2(got.knee, target.knee)), heading: got.heading, got };
}
// arm: where the fist should be (same frame) under this torso pose; solves upper arm Euler + elbow bend.
// target: { fist:[x,y,z], ref?: [ua..., fa] }
function solveArm(torso, side, target) {
  const base = Object.assign({}, P.POSES.STANCE, torso);
  const sgn = side === 'l' ? 1 : -1;
  const LIM = { u: [[-175, 60], [-90, 90], sgn > 0 ? [-160, 40] : [-40, 160]], l: [-150, 0] };
  const pen = (x, lim) => x < lim[0] ? (lim[0] - x) : x > lim[1] ? (x - lim[1]) : 0;
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const fist = (v) => { const pose = Object.assign({}, base); pose[side + 'UpperArm'] = [v[0], v[1], v[2]]; pose[side + 'Forearm'] = [v[3], 0, 0]; const w = P.fk(pose, 0).w[side + 'Fist']; return [w.x, w.y - H, w.z]; };
  const cost = (v) => {
    let c = d2(fist(v), target.fist);
    c += 1e-3 * (pen(v[0], LIM.u[0]) + pen(v[1], LIM.u[1]) + pen(v[2], LIM.u[2]) + pen(v[3], LIM.l)) ** 2;
    if (target.ref) c += 1e-7 * ((v[0] - target.ref[0]) ** 2 + (v[1] - target.ref[1]) ** 2 + (v[2] - target.ref[2]) ** 2 + (v[3] - target.ref[3]) ** 2);
    return c;
  };
  let best = null, bestC = 1e9;
  for (let s = 0; s < 40; s++) {
    let v = s === 0 && target.ref ? target.ref.slice() : [LIM.u[0][0] + Math.random() * (LIM.u[0][1] - LIM.u[0][0]), LIM.u[1][0] + Math.random() * (LIM.u[1][1] - LIM.u[1][0]), LIM.u[2][0] + Math.random() * (LIM.u[2][1] - LIM.u[2][0]), LIM.l[0] + Math.random() * (LIM.l[1] - LIM.l[0])];
    let c = cost(v), step = 30;
    while (step > 0.05) {
      let improved = false;
      for (let i = 0; i < 4; i++) for (const dir of [1, -1]) { const t = v.slice(); t[i] += dir * step; const tc = cost(t); if (tc < c) { v = t; c = tc; improved = true; } }
      if (!improved) step *= 0.5;
    }
    if (c < bestC) { bestC = c; best = v; }
  }
  const R = (x) => Math.round(x);
  return { ua: [R(best[0]), R(best[1]), R(best[2])], fa: [R(best[3]), 0, 0], err: Math.sqrt(d2(fist(best), target.fist)) };
}

// ------------------------------------------------------------------ the kicks
// Every roundhouse is the same story told at a different height:
//   load      weight onto the support leg, kicking knee starts up and forward, shin folded, foot pointing
//   chamber   knee high and across, pointed at the target; shin still folded ~110 deg, foot trailing behind
//   impact    hips fully over, thigh at target height, shin snapped out (slight bend); the SHIN moved, not the thigh
//   through   the leg carries past the target, still long
//   refold    knee folds again as the thigh comes back down in front
//   land      the foot comes down in front / beside, hips square up
//   stance
const KICKS = {
  // rear-leg Muay Thai head kick, swing-through style:
  //   step    the lead foot steps out 45 deg off the line (support foot moves, heading opens), weight onto it
  //   chamber knee driven high and ACROSS the centre line (over the shoulder), shin folded, kicking-side arm
  //           already swinging down and back, lead hand up by the face
  //   impact  hips all the way over, hard lean away, support heel pointing at the opponent, shin snaps through the head
  //   through the leg keeps travelling past the head, the body keeps turning with it
  //   land    the kicking foot comes down forward and across (momentarily squared / southpaw), then back to stance
  rl_hkick: { side: 'r', dur: 0.90, active: [0.21, 0.43],
    // kicking-side (right) arm: authored by fist position (rFist) and solved with solveArm. It swings like a
    // pendulum against the leg: up and forward on the step, straight out at shoulder height as the knee comes
    // up, then down past the hip and behind as the shin snaps through (the counterweight that lets the hips roll
    // all the way over), and only comes back up with the leg. The lead hand stays up at the face.
    // face: where the kneecap points. The hips roll so far over at impact that the knee points almost at the
    // mat, and with the ankle pointed the toes end up aimed past the target at the back of the head.
    frames: [
      { t: 0.00, S: true },
      { t: 0.09, yaw: 6, tilt: [0, 0, -4], chest: [4, 0, 4], head: [8, -8, -2], lUA: [-62, 0, -12], ankle: 10, rFist: [-0.30, 0.80, 0.42],
        kick: { knee: [-0.16, -0.50, -0.06], foot: [-0.22, -0.98, -0.16] }, sup: { knee: [0.26, -0.56, 0.26], foot: [0.30, -1.03, 0.32], heading: 35 } },
      { t: 0.19, yaw: 52, tilt: [-6, 0, -42], chest: [16, -8, 8], head: [10, -28, -8], lUA: [-86, -12, -26], ankle: 45, rFist: [-0.22, 0.42, 0.40],
        kick: { knee: [0.04, 0.40, 0.40], foot: [-0.40, 0.14, 0.20] }, sup: { knee: [0.22, -0.54, 0.06], foot: [0.26, -1.02, 0.00], heading: 85 } },
      // mid-swing: the knee leads and points where the shin is going (across, to the kicker's left), the shin is half
      // way out, the foot still trailing to the right at head height; the arm is on its way down past the ribs
      { t: 0.235, yaw: 67, tilt: [-7, 0, -52], chest: [20, -11, 8], head: [10, -30, -10], lUA: [-86, -12, -26], ankle: 48, lift: 0.08, rFist: [-0.22, 0.15, 0.15],
        kick: { knee: [-0.02, 0.40, 0.45], foot: [-0.36, 0.46, 0.68] }, sup: { knee: [0.22, -0.52, 0.02], foot: [0.26, -1.00, -0.04], heading: 108 } },
      // impact: the shin comes through level at head height (the opponent's head sits ~0.65 m above the kicker's hips),
      // the kneecap turned down at the mat, the toes aimed past the target
      { t: 0.28, yaw: 82, tilt: [-8, 0, -62], chest: [24, -14, 8], head: [10, -32, -12], lUA: [-86, -12, -26], ankle: 45, lift: 0.08, rFist: [-0.02, -0.02, -0.22],
        kick: { knee: [0.00, 0.40, 0.45], foot: [0.05, 0.62, 0.88], face: [0.5, -0.75, 0.33] }, sup: { knee: [0.22, -0.50, -0.02], foot: [0.26, -0.98, -0.08], heading: 130 } },
      { t: 0.38, yaw: 108, tilt: [-8, 0, -58], chest: [26, -16, 8], head: [10, -32, -12], lUA: [-84, -8, -22], ankle: 45, lift: 0.08, rFist: [-0.12, 0.03, -0.42],
        kick: { knee: [0.33, 0.28, 0.41], foot: [0.67, 0.50, 0.67], face: [0.2, -0.85, 0.4] }, sup: { knee: [0.22, -0.50, -0.02], foot: [0.26, -0.98, -0.08], heading: 145 } },
      { t: 0.50, yaw: 96, tilt: [-4, 0, -30], chest: [18, -10, 4], head: [8, -20, -6], lUA: [-70, 0, -10], ankle: 25, rFist: [-0.15, 0.30, 0.15],
        kick: { knee: [0.22, 0.04, 0.30], foot: [0.30, -0.40, 0.22] }, sup: { knee: [0.20, -0.54, 0.02], foot: [0.24, -1.02, -0.04], heading: 120 } },
      { t: 0.62, yaw: 48, tilt: [0, 0, -8], chest: [8, -4, 2], head: [8, -6, 0], lUA: [-44, 14, 0], rUA: [-32, 12, 4], rFA: [-138, 0, 22], ankle: 5,
        kick: { knee: [0.14, -0.42, 0.32], foot: [0.18, -0.96, 0.26] }, sup: { knee: [0.16, -0.54, 0.08], foot: [0.18, -1.03, 0.02], heading: 60 } },
      { t: 0.90, S: true }] },
  // rear-leg roundhouse to the body: the head kick's path (knee up and across, hips over, late shin snap) brought
  // down to rib height — the thigh stops level, the lean-away is smaller, the shin comes through nearly horizontal.
  // The leg must TURN OVER: from the mid-swing on, the kneecap faces across (the way the shin travels) and down, the
  // shin swings in a near-level plane and the pointed foot's instep leads it across the ribs. Without the face
  // targets the solver keeps the kneecap up and the shin flicks forward and up like a teep.
  rl_bkick: { side: 'r', dur: 0.80, active: [0.21, 0.42],
    frames: [
      { t: 0.00, S: true },
      { t: 0.10, yaw: 14, tilt: [0, 0, -6], chest: [4, 4, 4], head: [6, -14, -2], lUA: [-60, 0, -10], rUA: [-26, 6, 30], ankle: 20,
        kick: { knee: [-0.20, -0.12, 0.30], foot: [-0.26, -0.56, 0.02] }, sup: { knee: [0.12, -0.56, 0.16], foot: [0.13, -1.04, 0.16], heading: 20 } },
      // chamber: knee up in front at belt height, shin folded and trailing out to the right, foot already pointed
      { t: 0.20, yaw: 48, tilt: [-4, 0, -28], chest: [8, -4, 8], head: [6, -28, -4], lUA: [-80, -10, -20], rUA: [-20, 0, 70], ankle: 50,
        kick: { knee: [-0.08, 0.16, 0.46], foot: [-0.48, 0.02, 0.26] }, sup: { knee: [0.18, -0.54, 0.04], foot: [0.20, -1.02, -0.02], heading: 75 } },
      // mid-swing: the hips roll over and the knee leads across the centre line, kneecap turning to face across and
      // down; the shin opens out level behind it, the foot still out to the right at rib height
      { t: 0.245, yaw: 64, tilt: [-5, 0, -38], chest: [14, -7, 11], head: [6, -30, -5], lUA: [-80, -10, -20], rUA: [-20, 0, 70], ankle: 55, lift: 0.02,
        kick: { knee: [-0.07, 0.10, 0.59], foot: [-0.52, 0.26, 0.70], face: [0.28, 0.12, 0.95] }, sup: { knee: [0.20, -0.53, 0.02], foot: [0.22, -1.01, -0.03], heading: 100 } },
      // impact: hips over, shin snapped out level across the ribs (slight bend left in it), kneecap across and down,
      // instep in line with the shin and pointed past the target
      { t: 0.29, yaw: 78, tilt: [-6, 0, -46], chest: [20, -10, 14], head: [6, -30, -6], lUA: [-80, -10, -20], rUA: [-20, 0, 70], ankle: 55, lift: 0.04,
        kick: { knee: [0.10, 0.06, 0.58], foot: [0.15, 0.17, 1.05], face: [0.70, -0.71, 0.09] }, sup: { knee: [0.22, -0.52, 0.00], foot: [0.24, -1.00, -0.04], heading: 120 } },
      // through: the leg carries on across, still long and level, kneecap rolled down at the mat
      { t: 0.38, yaw: 88, tilt: [-6, 0, -46], chest: [22, -14, 14], head: [6, -30, -6], lUA: [-80, -10, -20], rUA: [-20, 0, 70], ankle: 55, lift: 0.04,
        kick: { knee: [0.25, 0.06, 0.53], foot: [0.50, 0.16, 0.94], face: [0.40, -0.92, -0.01] }, sup: { knee: [0.22, -0.52, 0.00], foot: [0.24, -1.00, -0.04], heading: 130 } },
      { t: 0.50, yaw: 46, tilt: [-4, 0, -22], chest: [10, -6, 8], head: [6, -14, -2], lUA: [-64, 6, -4], rUA: [-36, 8, 30], ankle: 25,
        kick: { knee: [-0.09, 0.01, 0.55], foot: [-0.24, -0.34, 0.20] }, sup: { knee: [0.18, -0.54, 0.04], foot: [0.20, -1.02, -0.02], heading: 80 } },
      { t: 0.64, yaw: 8, tilt: [0, 0, -4], chest: [4, -2, 2], head: [6, 0, 0], lUA: [-40, 16, 4], rUA: [-32, 12, 0], ankle: 5,
        kick: { knee: [-0.18, -0.40, 0.10], foot: [-0.22, -0.95, -0.06] }, sup: { knee: [0.12, -0.54, 0.16], foot: [0.12, -1.03, 0.18], heading: 20 } },
      { t: 0.80, S: true }] },
  // rear-leg Thai low kick into the outside of the opponent's lead thigh (the lead version is this one mirrored):
  //   step    small step out with the lead foot, toes turning out, weight onto it; the rear heel comes up
  //   swing   NO high chamber: the hips open and the leg comes round from the kicker's right side, long, the knee
  //           only slightly bent, the foot trailing out wide at knee height; the rear arm starts to swing down
  //   impact  hips turned over (support heel at the opponent), the near-straight leg angles down and the shin
  //           chops ACROSS the target from the outside, kneecap facing the way it travels; rear arm swung down and
  //           back past the hip as the counterweight, lead glove covering the jaw, a slight lean away
  //   through the shin carries on across the thigh line (on the mirrored lead kick this is the inside of the thigh)
  //   return  the knee folds and the leg comes back the way it went, landing back in stance
  rl_lkick: { side: 'r', dur: 0.70, active: [0.18, 0.34],
    frames: [
      { t: 0.00, S: true },
      { t: 0.08, yaw: 14, tilt: [0, 0, -4], chest: [6, -2, 2], head: [8, -10, 0], lUA: [-76, -3, -12], ankle: 15, rUA: [-24, 10, -14], rFA: [-128, 0, 14],
        kick: { knee: [-0.20, -0.50, 0.02], foot: [-0.28, -0.95, -0.16] }, sup: { knee: [0.22, -0.56, 0.24], foot: [0.26, -1.03, 0.24], heading: 30 } },
      { t: 0.16, yaw: 50, tilt: [-2, 0, -12], chest: [6, -8, 6], head: [8, -26, -4], lUA: [-80, -10, -18], ankle: 35, rUA: [-2, 0, -22], rFA: [-80, 0, 0],
        kick: { knee: [-0.32, -0.32, 0.30], foot: [-0.66, -0.50, 0.24] }, sup: { knee: [0.22, -0.54, 0.12], foot: [0.26, -1.02, 0.10], heading: 70 } },
      { t: 0.25, yaw: 80, tilt: [-4, 0, -20], chest: [6, -12, 10], head: [8, -32, -8], lUA: [-82, -12, -22], ankle: 40, rUA: [34, 0, -16], rFA: [-24, 0, 0],
        kick: { knee: [-0.10, -0.20, 0.52], foot: [-0.36, -0.40, 0.92], face: [0.85, -0.25, 0.35] }, sup: { knee: [0.22, -0.52, 0.04], foot: [0.26, -1.00, 0.00], heading: 105 } },
      { t: 0.32, yaw: 90, tilt: [-4, 0, -20], chest: [6, -14, 10], head: [8, -32, -8], lUA: [-82, -12, -22], ankle: 40, rUA: [40, 0, -14], rFA: [-20, 0, 0],
        kick: { knee: [0.04, -0.24, 0.52], foot: [0.10, -0.48, 0.96], face: [0.8, -0.4, 0.3] }, sup: { knee: [0.22, -0.52, 0.02], foot: [0.26, -1.00, -0.02], heading: 112 } },
      { t: 0.43, yaw: 52, tilt: [-2, 0, -10], chest: [6, -8, 6], head: [8, -22, -4], lUA: [-80, -10, -18], ankle: 25, rUA: [-6, 4, -18], rFA: [-90, 0, 0],
        kick: { knee: [-0.22, -0.34, 0.34], foot: [-0.38, -0.74, 0.12] }, sup: { knee: [0.22, -0.54, 0.12], foot: [0.26, -1.02, 0.10], heading: 70 } },
      { t: 0.55, yaw: 16, tilt: [0, 0, -4], chest: [6, -4, 2], head: [8, -6, 0], lUA: [-76, -3, -12], ankle: 8, rUA: [-28, 14, -8], rFA: [-134, 0, 20],
        kick: { knee: [-0.18, -0.50, 0.02], foot: [-0.24, -0.98, -0.16] }, sup: { knee: [0.20, -0.55, 0.20], foot: [0.24, -1.03, 0.20], heading: 30 } },
      { t: 0.70, S: true }] },
  // rear-leg Muay Thai straight knee (khao trong):
  //   load    weight onto the lead foot, rear heel up, the rear knee starts forward; the lead glove reaches out
  //           to frame the opponent's head and the rear arm starts to drop
  //   drive   the knee rises up the centre line with the shin folded tight under it and the toes pointed down
  //   impact  knee above the belt, driven up and forward into the solar plexus; hips thrust through and the
  //           torso leans back behind them, up on the ball of the straight support leg, rear arm swung down
  //           and back past the hip as the counterweight, lead arm out at head height
  //   return  the knee drops straight back down and the foot returns to stance
  rl_knee: { side: 'r', dur: 0.62, active: [0.12, 0.32],
    frames: [
      { t: 0.00, S: true },
      { t: 0.08, yaw: -2, tilt: [-4, 0, -2], chest: [6, -10, 0], head: [12, 4, 0], ankle: 25, lFist: [0.14, 0.58, 0.44], rUA: [-52, 6, 4], rFA: [-130, 0, 16],
        kick: { knee: [-0.13, -0.52, 0.14], foot: [-0.18, -0.92, -0.22] }, sup: { knee: [0.10, -0.53, 0.18], foot: [0.11, -1.02, 0.18], heading: -8 } },
      { t: 0.15, yaw: 22, tilt: [-14, 0, -4], chest: [-6, -22, 0], head: [22, 4, 0], ankle: 50, lFist: [0.12, 0.52, 0.42], rUA: [-18, 4, -4], rFA: [-132, 0, 12], lift: 0.03,
        kick: { knee: [-0.04, -0.04, 0.47], foot: [-0.06, -0.48, 0.23] }, sup: { knee: [0.10, -0.53, 0.10], foot: [0.11, -1.00, 0.08], heading: -4 } },
      { t: 0.22, yaw: 36, tilt: [-22, 0, -6], chest: [-14, -30, 0], head: [34, 6, 0], ankle: 60, lFist: [0.08, 0.46, 0.34], rUA: [14, 0, -10], rFA: [-134, 0, 10], lift: 0.05,
        kick: { knee: [0.00, 0.20, 0.47], foot: [-0.02, -0.24, 0.27] }, sup: { knee: [0.10, -0.52, 0.02], foot: [0.11, -0.99, -0.02], heading: 0 } },
      { t: 0.30, yaw: 38, tilt: [-24, 0, -6], chest: [-14, -30, 0], head: [36, 6, 0], ankle: 60, lFist: [0.08, 0.45, 0.34], rUA: [18, 0, -10], rFA: [-134, 0, 10], lift: 0.05,
        kick: { knee: [0.00, 0.23, 0.48], foot: [-0.02, -0.21, 0.27] }, sup: { knee: [0.10, -0.52, 0.00], foot: [0.11, -0.99, -0.04], heading: 0 } },
      { t: 0.40, yaw: 12, tilt: [-8, 0, -3], chest: [0, -18, 0], head: [16, 6, 0], ankle: 35, lFist: [0.14, 0.56, 0.42], rUA: [-24, 6, -4], rFA: [-132, 0, 14], lift: 0.02,
        kick: { knee: [-0.07, -0.32, 0.40], foot: [-0.11, -0.76, 0.12] }, sup: { knee: [0.10, -0.53, 0.10], foot: [0.11, -1.01, 0.08], heading: -6 } },
      { t: 0.50, yaw: -8, tilt: [-2, 0, -1], chest: [4, -14, 0], head: [10, 10, 0], ankle: 10, lFist: [0.16, 0.56, 0.40], rUA: [-30, 14, -6], rFA: [-136, 0, 20],
        kick: { knee: [-0.13, -0.50, -0.04], foot: [-0.17, -0.99, -0.20] }, sup: { knee: [0.09, -0.52, 0.18], foot: [0.11, -1.02, 0.20], heading: -10 } },
      { t: 0.62, S: true }] }
};

if (require.main === module) {
  const only = process.argv[2] ? process.argv[2].split(',') : null;
  for (const key in KICKS) {
    if (only && !only.includes(key)) continue;
    const K = KICKS[key], side = K.side, osd = side === 'r' ? 'l' : 'r';
    const armKeyed = K.frames.some(f => f.rFist || f.rFA); // this kick animates the kicking-side forearm too
    const leadKeyed = K.frames.some(f => f.lFist); // ...and the lead forearm
    const lines = []; let refK = null, refS = null, refA = null, refL = [-76, -3, -12, -128]; // lead arm seeded from the guard so the elbow stays down in front
    console.log(`// ${key}  active ${JSON.stringify(K.active)}`);
    for (const f of K.frames) {
      if (f.S) { lines.push(`        { t: ${f.t.toFixed(2)}, pelvisYaw: S, pelvisTilt: S, chest: S, head: S, ${side}Thigh: S, ${side}Shin: S, ${osd}Thigh: S, ${osd}Shin: S, lUpperArm: S, rUpperArm: S, ${armKeyed ? 'rForearm: S, ' : ''}${leadKeyed ? 'lForearm: S, ' : ''}lift: 0, ${side}Ankle: 0 }`); continue; }
      const torso = { pelvisYaw: f.yaw, pelvisTilt: f.tilt, chest: f.chest, head: f.head, lUpperArm: f.lUA, rUpperArm: f.rUA }; torso[side + 'Ankle'] = f.ankle;
      let rUA = f.rUA, rFA = f.rFA, armNote = '';
      if (f.rFist) { const a = solveArm(torso, 'r', { fist: f.rFist, ref: refA }); rUA = a.ua; rFA = a.fa; refA = a.ua.concat(a.fa[0]); armNote = ` | fist err ${(a.err * 100).toFixed(1)}cm`; }
      let lUA = f.lUA, lFA = null;
      if (f.lFist) { const a = solveArm(torso, 'l', { fist: f.lFist, ref: refL }); lUA = a.ua; lFA = a.fa; refL = a.ua.concat(a.fa[0]); armNote += ` | lead fist err ${(a.err * 100).toFixed(1)}cm`; }
      torso.lUpperArm = lUA; if (lFA) torso.lForearm = lFA;
      torso.rUpperArm = rUA; if (rFA) torso.rForearm = rFA;
      const k = solveLeg(torso, side, Object.assign({ ref: refK }, f.kick));
      const s = solveLeg(torso, osd, Object.assign({ ref: refS }, f.sup));
      refK = k.thigh.concat(k.shin[0]); refS = s.thigh.concat(s.shin[0]);
      const D = (v) => '(' + v.map(x => x.toFixed(2)).join(',') + ')';
      console.error(`  t=${f.t.toFixed(2)} kick foot err ${(k.err * 100).toFixed(1)}cm knee err ${(k.errK * 100).toFixed(1)}cm knee bend ${k.shin[0]} face ${D(k.got.face)} toes ${D(k.got.toes)} | support foot err ${(s.err * 100).toFixed(1)}cm heading ${s.heading.toFixed(0)} (want ${f.sup.heading})${armNote}`);
      const E = (v) => `[${v.join(', ')}]`;
      lines.push(`        { t: ${+f.t.toFixed(3)}, pelvisYaw: ${f.yaw}, pelvisTilt: ${E(f.tilt)}, chest: ${E(f.chest)}, head: ${E(f.head)}, ${side}Thigh: ${E(k.thigh)}, ${side}Shin: ${E(k.shin)}, ${osd}Thigh: ${E(s.thigh)}, ${osd}Shin: ${E(s.shin)}, lUpperArm: ${E(lUA)}, rUpperArm: ${E(rUA)}, ${armKeyed ? `rForearm: ${E(rFA)}, ` : ''}${leadKeyed ? `lForearm: ${E(lFA)}, ` : ''}lift: ${f.lift || 0}, ${side}Ankle: ${f.ankle} }`);
    }
    console.log(lines.join(',\n') + ']');
  }
}
module.exports = { solveLeg, solveArm, legEval, KICKS };
