/* ============================================================
   3D renderer — Three.js (global THREE, r128)
   Builds the arena + two procedurally animated fighters driven
   by sim state snapshots. Uses analytic two-bone IK for limbs.
   ============================================================ */
(function (root) {
  'use strict';
  const { STRIKES, strikeTip, IN } = root.MMASim;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const smooth = t => t * t * (3 - 2 * t);
  const expo = (dt, k) => 1 - Math.exp(-dt * k);

  // ---------- dimensions ----------
  const HIP_H = 0.92; // hip height the ground / fallback poses are authored against

  // ---------- poses (torso-space hand targets, body-space foot targets) ----------
  // h: hip height, lean: torso pitch (rad, + forward), yaw: torso twist, roll,
  // lh/rh: left/right hand targets (torso frame), lf/rf: foot targets XZ (root frame), fy: foot lift (world)
  // hp: head pitch, hy: head yaw, lie: body pitch (0 standing, -PI/2 on back)
  function P(o) {
    return Object.assign({
      h: HIP_H, lean: 0.08, yaw: 0.25, roll: 0,
      lh: [-0.14, 0.42, 0.34], rh: [0.16, 0.38, 0.22],
      lf: [-0.16, 0.2], rf: [0.2, -0.24], lfy: 0, rfy: 0, lfz: null, rfz: null,
      hp: 0.05, hy: -0.15, lie: 0, ox: 0, oz: 0, elbowOut: 0.5, elbowUp: 0, hipYaw: 0, lPole: [0, 0, 1], rPole: [0, 0, 1]
    }, o);
  }
  const POSES = {
    idle: P({}),
    block: P({ lh: [-0.09, 0.68, 0.22], rh: [0.09, 0.66, 0.2], h: HIP_H - 0.05, lean: 0.18, hp: 0.25, elbowOut: 0.25 }),
    blockLow: P({ yaw: 0.6, lean: 0.12, h: HIP_H - 0.04, lh: [0.08, 0.1, 0.3], rh: [0.14, 0.5, 0.2], hp: 0.2, hy: -0.35, elbowOut: 0.2 }),
    dodge: P({ lean: -0.42, h: HIP_H - 0.08, oz: -0.18, lh: [-0.14, 0.5, 0.3], rh: [0.16, 0.48, 0.22], hp: -0.2 }),
    hitHead: P({ lean: -0.3, hp: -0.55, hy: 0.4, lh: [-0.2, 0.3, 0.25], rh: [0.22, 0.25, 0.1], h: HIP_H - 0.03 }),
    hitBody: P({ lean: 0.5, h: HIP_H - 0.14, hp: 0.4, lh: [-0.1, 0.1, 0.3], rh: [0.15, 0.05, 0.25] }),
    hitLegs: P({ lean: 0.25, h: HIP_H - 0.2, roll: 0.25, lh: [-0.14, 0.3, 0.3], rh: [0.3, 0.2, 0.1] }),
    push: P({ lean: 0.3, h: HIP_H - 0.06, oz: 0.08, lh: [-0.17, 0.46, 0.66], rh: [0.17, 0.46, 0.66], hp: 0.05, elbowOut: 0.2 }),
    stumble: P({ lean: 0.55, h: HIP_H - 0.25, lh: [-0.3, -0.1, 0.4], rh: [0.3, -0.05, 0.35], hp: 0.3 }),
    sprawl: P({ lean: 1.05, h: HIP_H - 0.32, lh: [-0.26, -0.3, 0.5], rh: [0.26, -0.3, 0.5], lf: [-0.2, -0.25], rf: [0.22, -0.3], hp: -0.3 }),
    tdWind: P({ lean: 0.75, h: HIP_H - 0.3, lh: [-0.2, 0.0, 0.5], rh: [0.2, 0.0, 0.45], lf: [-0.16, 0.3], rf: [0.2, -0.3], hp: -0.3 }),
    tdShoot: P({ lean: 1.0, h: HIP_H - 0.36, lh: [-0.22, -0.15, 0.75], rh: [0.22, -0.15, 0.7], lf: [-0.16, 0.55], rf: [0.2, -0.1], oz: 0.25, hp: -0.5 }),
    celebrate: P({ lean: -0.15, lh: [-0.3, 1.0, 0.1], rh: [0.3, 1.0, 0.1], hp: -0.3, hy: 0, yaw: 0 }),
    // ground
    bottom: P({ lie: -Math.PI / 2, h: 0.2, lean: 0.25, yaw: 0, lh: [-0.16, 0.5, 0.32], rh: [0.16, 0.48, 0.3], lf: [-0.2, -0.14], rf: [0.2, -0.14], lfy: -0.48, rfy: -0.5, hp: 0.35, hy: 0 }),
    bottomBlock: P({ lie: -Math.PI / 2, h: 0.2, lean: 0.25, yaw: 0, lh: [-0.1, 0.62, 0.42], rh: [0.1, 0.6, 0.42], lf: [-0.2, -0.14], rf: [0.2, -0.14], lfy: -0.48, rfy: -0.5, hp: 0.5, hy: 0 }),
    bottomHit: P({ lie: -Math.PI / 2, h: 0.2, lean: 0.05, yaw: 0.2, lh: [-0.3, 0.3, 0.2], rh: [0.3, 0.3, 0.15], lf: [-0.24, -0.14], rf: [0.16, -0.14], lfy: -0.52, rfy: -0.46, hp: -0.2, hy: 0.5 }),
    down: P({ lie: -Math.PI / 2, h: 0.17, lean: 0, yaw: 0, lh: [-0.5, 0.75, 0.05], rh: [0.5, 0.7, 0.05], lf: [-0.24, -0.1], rf: [0.2, -0.1], lfy: -0.9, rfy: -0.88, hp: 0.2, hy: 0.4 }),
    top: P({ h: 0.5, lean: 0.55, yaw: 0, lh: [-0.2, -0.05, 0.4], rh: [0.2, -0.05, 0.4], lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: 0.3, hy: 0 }),
    topPosture: P({ h: 0.55, lean: 0.25, yaw: 0, lh: [-0.2, 0.1, 0.45], rh: [0.2, 0.1, 0.45], lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: 0.35, hy: 0 }),
    topSub: P({ h: 0.38, lean: 1.15, yaw: 0.3, lh: [-0.1, -0.2, 0.55], rh: [0.2, -0.15, 0.5], lf: [-0.3, -0.5], rf: [0.3, -0.45], hp: 0.1, hy: 0.3 }),
    topHit: P({ h: 0.5, lean: -0.1, yaw: 0.2, lh: [-0.3, 0.3, 0.3], rh: [0.3, 0.3, 0.3], lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: -0.3 }),
    // --- positional ground poses ---
    // Lying poses: lf/rf = [across, height above the hips], lfy/rfy = -(distance towards the feet end); the knee
    // poles are [across, towards the head, up]. The top fighter kneels GROUND_OFF.guard (0.32 m) towards the feet end
    // with his hips 0.5 m up, so the guard's ankles cross behind his back: 0.55 m down the axis, 0.62 m off the mat.
    // bottom in closed guard: hips lifted onto the top's thighs, knees out wide around his waist, ankles crossed behind him
    bottomGuard: P({ lie: -Math.PI / 2, h: 0.3, lean: 0.3, yaw: 0, lh: [-0.18, 0.45, 0.35], rh: [0.18, 0.42, 0.33], lf: [0.1, 0.32], rf: [-0.1, 0.3], lfy: -0.55, rfy: -0.55, lPole: [-1, 0, 0.5], rPole: [1, 0, 0.5], hp: 0.4, hy: 0 }),
    // half guard: one leg hooked around the top's thigh (knee out, foot behind his knee), the other flat
    bottomHalf: P({ lie: -Math.PI / 2, h: 0.2, lean: 0.25, yaw: 0.15, lh: [-0.18, 0.45, 0.35], rh: [0.18, 0.42, 0.33], lf: [0.0, 0.2], rf: [0.22, -0.2], lfy: -0.55, rfy: -0.5, lPole: [-1, 0, 0.6], hp: 0.4, hy: 0 }),
    // flat on the back (side control / mount): framing with the arms, legs flat
    bottomFlat: P({ lie: -Math.PI / 2, h: 0.18, lean: 0.1, yaw: 0, lh: [-0.2, 0.55, 0.3], rh: [0.2, 0.52, 0.3], lf: [-0.22, -0.2], rf: [0.22, -0.2], lfy: -0.5, rfy: -0.5, hp: 0.3, hy: 0 }),
    // turtled (back control): on hands and knees
    turtle: P({ lie: 0, h: 0.48, lean: 1.35, yaw: 0, lh: [-0.22, -0.25, 0.42], rh: [0.22, -0.25, 0.42], lf: [-0.22, -0.4], rf: [0.22, -0.4], lfy: 0, rfy: 0, hp: 0.2, hy: 0 }),
    // bottom attacking a submission from the guard: legs high, pulling the top down
    bottomSub: P({ lie: -Math.PI / 2, h: 0.24, lean: 0.5, yaw: 0, lh: [-0.14, 0.15, 0.6], rh: [0.14, 0.15, 0.6], lf: [-0.2, 0.55], rf: [0.2, 0.55], lfy: 0.2, rfy: 0.25, hp: 0.5, hy: 0 }),
    // top inside the guard: kneeling, posture mid
    topGuard: P({ h: 0.5, lean: 0.5, yaw: 0, lh: [-0.2, -0.1, 0.42], rh: [0.2, -0.1, 0.42], lf: [-0.28, -0.5], rf: [0.28, -0.5], hp: 0.3, hy: 0 }),
    // side control: chest down across them, hips low
    topSide: P({ h: 0.42, lean: 1.0, yaw: 0.2, lh: [-0.25, -0.2, 0.5], rh: [0.25, -0.25, 0.45], lf: [-0.3, -0.5], rf: [0.3, -0.35], hp: 0.2, hy: 0.2 }),
    // mount: sat upright on the hips, knees wide
    topMount: P({ h: 0.56, lean: 0.25, yaw: 0, lh: [-0.2, 0.25, 0.4], rh: [0.2, 0.25, 0.4], lf: [-0.4, -0.2], rf: [0.4, -0.2], hp: 0.35, hy: 0 }),
    // back control: chest on their back, hooks in, arms around the neck
    topBack: P({ h: 0.62, lean: 1.1, yaw: 0, lh: [-0.15, -0.3, 0.5], rh: [0.15, -0.25, 0.55], lf: [-0.3, -0.4], rf: [0.3, -0.4], hp: 0.2, hy: 0 }),
    // caught in a submission from the bottom: bent down, head pulled in
    topCaught: P({ h: 0.4, lean: 1.25, yaw: 0.2, lh: [-0.2, -0.3, 0.55], rh: [0.3, -0.1, 0.4], lf: [-0.3, -0.5], rf: [0.3, -0.45], hp: 0.3, hy: 0.3 })
  };
  // strike keyframes per strike kind: [windup, hit], authored for the RIGHT limb (rear side, orthodox).
  // Left-limb strikes use mirrored copies (upper body only for punches, so the stance stays orthodox).
  // The striking limb's own target is overridden every frame by the simulation's tip path (see update()).
  const STRIKE_POSES = {
    straight: [P({ yaw: 0.5, lean: 0.05, lh: [-0.14, 0.44, 0.3], rh: [0.26, 0.36, 0.0] }),
               P({ yaw: -0.55, lean: 0.25, lh: [-0.22, 0.45, 0.25], rh: [-0.05, 0.48, 0.92], oz: 0.12, hp: 0.1 })],
    hook: [P({ yaw: 0.55, lean: 0.1, lh: [-0.14, 0.44, 0.3], rh: [0.36, 0.42, 0.15], elbowOut: 1.0, elbowUp: 0.9 }),
           P({ yaw: -0.8, lean: 0.12, roll: -0.12, lh: [-0.22, 0.45, 0.25], rh: [-0.25, 0.5, 0.55], elbowOut: 1.2, elbowUp: 1.3, oz: 0.08 })],
    uppercut: [P({ yaw: 0.45, lean: 0.22, h: HIP_H - 0.06, lh: [-0.14, 0.44, 0.3], rh: [0.3, 0.12, 0.12], hp: 0.15 }),
               P({ yaw: -0.4, lean: -0.1, h: HIP_H + 0.01, lh: [-0.2, 0.45, 0.28], rh: [0.0, 0.62, 0.5], oz: 0.08, hp: -0.1 })],
    overhand: [P({ yaw: 0.4, lean: 0.05, lh: [-0.14, 0.44, 0.3], rh: [0.46, 0.6, 0.15], elbowOut: 1.3, elbowUp: 1.1 }),
               P({ yaw: -0.6, lean: 0.3, roll: -0.15, lh: [-0.24, 0.4, 0.25], rh: [-0.1, 0.45, 0.8], oz: 0.14, hp: 0.25, elbowOut: 1.1, elbowUp: 1.1 })],
    hkick: [P({ yaw: -0.1, lean: 0.0, roll: 0.15, h: HIP_H - 0.05, hipYaw: -0.5, lh: [-0.18, 0.5, 0.3], rh: [0.34, 0.3, -0.05], rf: [0.42, 0.25], rfy: 0.72, rPole: [1, 0.3, 0.1], lf: [-0.1, 0.02], lPole: [0.4, 0, 1] }),
            P({ yaw: -0.9, lean: -0.5, roll: 0.5, h: HIP_H + 0.02, hipYaw: -1.4, lh: [0.05, 0.42, 0.28], rh: [0.3, -0.15, -0.3], rf: [-0.5, 0.55], rfy: 1.4, rPole: [0.9, 0.6, 0.0], lf: [-0.1, 0.02], lPole: [0.9, 0, 0.4], oz: 0.1, hp: 0.1, hy: 0.7 })],
    bkick: [P({ yaw: -0.1, lean: 0.0, roll: 0.12, h: HIP_H - 0.05, hipYaw: -0.45, lh: [-0.18, 0.5, 0.3], rh: [0.34, 0.3, -0.05], rf: [0.4, 0.25], rfy: 0.6, rPole: [1, 0.2, 0.1], lf: [-0.1, 0.02], lPole: [0.4, 0, 1] }),
            P({ yaw: -0.8, lean: -0.35, roll: 0.4, h: HIP_H - 0.02, hipYaw: -1.25, lh: [0.05, 0.42, 0.28], rh: [0.3, -0.12, -0.3], rf: [-0.45, 0.65], rfy: 1.0, rPole: [0.9, 0.4, 0.1], lf: [-0.1, 0.02], lPole: [0.9, 0, 0.4], oz: 0.1, hp: 0.1, hy: 0.6 })],
    lkick: [P({ yaw: -0.1, lean: 0.08, roll: 0.1, h: HIP_H - 0.07, hipYaw: -0.4, lh: [-0.18, 0.5, 0.3], rh: [0.34, 0.3, -0.05], rf: [0.38, 0.2], rfy: 0.45, rPole: [1, 0.1, 0.2], lf: [-0.1, 0.02], lPole: [0.4, 0, 1] }),
            P({ yaw: -0.75, lean: -0.1, roll: 0.3, h: HIP_H - 0.1, hipYaw: -1.2, lh: [0.05, 0.42, 0.28], rh: [0.3, -0.1, -0.3], rf: [-0.4, 0.75], rfy: 0.4, rPole: [0.9, 0.2, 0.2], lf: [-0.1, 0.02], lPole: [0.9, 0, 0.4], oz: 0.12, hp: 0.15, hy: 0.55 })],
    knee: [P({ yaw: 0.25, lean: 0.15, h: HIP_H - 0.04, lh: [-0.14, 0.5, 0.3], rh: [0.2, 0.5, 0.25], rf: [0.2, -0.3], rfy: 0.1, lf: [-0.14, 0.1] }),
           P({ yaw: -0.15, lean: -0.35, h: HIP_H - 0.02, lh: [-0.12, 0.35, 0.45], rh: [0.14, 0.35, 0.45], rf: [0.1, 0.4], rfy: 0.8, rPole: [0.2, 0.3, 1], lf: [-0.14, 0.1], oz: 0.16, hp: 0.1 })],
    teep: [P({ yaw: 0.2, lean: 0.12, h: HIP_H - 0.04, lh: [-0.14, 0.48, 0.3], rh: [0.18, 0.46, 0.22], rf: [0.2, 0.0], rfy: 0.5, rPole: [0.2, 0.2, 1], lf: [-0.12, 0.02] }),
           P({ yaw: 0.1, lean: -0.3, h: HIP_H - 0.03, lh: [-0.16, 0.5, 0.26], rh: [0.2, 0.46, 0.18], rf: [0.1, 0.95], rfy: 1.0, rPole: [0.2, 0.4, 1], lf: [-0.12, 0.02], oz: 0.1, hp: -0.1 })],
    // ground strikes (top position)
    gpunch: [P({ h: 0.52, lean: 0.35, yaw: -0.3, lh: [-0.2, -0.05, 0.4], rh: [0.25, 0.2, 0.25], lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: 0.3 }),
             P({ h: 0.48, lean: 0.75, yaw: 0.0, lh: [-0.2, -0.05, 0.4], rh: [0.05, -0.3, 0.55], lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: 0.3 })],
    ghammer: [P({ h: 0.55, lean: 0.1, yaw: -0.3, lh: [-0.2, -0.05, 0.4], rh: [0.35, 0.55, 0.1], lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: 0.3 }),
              P({ h: 0.46, lean: 0.85, yaw: 0.0, lh: [-0.2, -0.05, 0.4], rh: [0.05, -0.35, 0.55], lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: 0.3 })],
    gelbow: [P({ h: 0.55, lean: 0.2, yaw: -0.5, lh: [-0.2, -0.05, 0.4], rh: [0.45, 0.4, 0.2], elbowOut: 1.3, lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: 0.3 }),
             P({ h: 0.46, lean: 0.8, yaw: 0.3, lh: [-0.2, -0.05, 0.4], rh: [-0.15, -0.3, 0.5], elbowOut: 1.3, lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: 0.3 })],
    gbody: [P({ h: 0.52, lean: 0.3, yaw: -0.3, lh: [-0.2, -0.05, 0.4], rh: [0.3, 0.1, 0.3], lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: 0.3 }),
            P({ h: 0.5, lean: 0.6, yaw: 0.1, lh: [-0.2, -0.05, 0.4], rh: [0.05, -0.3, 0.3], lf: [-0.26, -0.55], rf: [0.26, -0.55], hp: 0.3 })],
    gknee: [P({ h: 0.55, lean: 0.4, yaw: 0, lh: [-0.2, -0.05, 0.4], rh: [0.2, -0.05, 0.4], lf: [-0.26, -0.55], rf: [0.3, -0.45], rfy: 0.25, hp: 0.3 }),
            P({ h: 0.5, lean: 0.7, yaw: 0, lh: [-0.2, -0.05, 0.4], rh: [0.2, -0.05, 0.4], lf: [-0.26, -0.55], rf: [0.15, 0.15], rfy: 0.3, hp: 0.3 })]
  };
  const HAND_KINDS = { straight: 1, hook: 1, uppercut: 1, overhand: 1, gpunch: 1, ghammer: 1, gelbow: 1, gbody: 1 };
  function mirrorPose(p, upperOnly) {
    const m = {};
    for (const k in p) m[k] = Array.isArray(p[k]) ? p[k].slice() : p[k];
    m.lh = [-p.rh[0], p.rh[1], p.rh[2]]; m.rh = [-p.lh[0], p.lh[1], p.lh[2]];
    m.yaw = -p.yaw; m.roll = -p.roll; m.hy = -p.hy; m.ox = -p.ox;
    if (!upperOnly) {
      m.lf = [-p.rf[0], p.rf[1]]; m.rf = [-p.lf[0], p.lf[1]];
      m.lfy = p.rfy; m.rfy = p.lfy;
      m.lPole = [-p.rPole[0], p.rPole[1], p.rPole[2]]; m.rPole = [-p.lPole[0], p.lPole[1], p.lPole[2]];
      m.hipYaw = -p.hipYaw;
    }
    return m;
  }
  const STRIKE_POSES_L = {};
  for (const k in STRIKE_POSES) STRIKE_POSES_L[k] = STRIKE_POSES[k].map(p => mirrorPose(p, !!HAND_KINDS[k]));

  // top fighter placement relative to the bottom fighter's hips: [along the ground axis (+ = towards their head), across]
  const GROUND_OFF = { guard: [-0.32, 0], half: [-0.26, 0.08], side: [0.12, 0.42], mount: [-0.02, 0], back: [-0.48, 0] };

  function lerpPose(a, b, t, out) {
    out = out || {};
    for (const k in a) {
      const va = a[k], vb = b[k];
      if (Array.isArray(va)) { out[k] = out[k] || []; for (let i = 0; i < va.length; i++) out[k][i] = va[i] + (vb[i] - va[i]) * t; }
      else if (typeof va === 'number') out[k] = va + ((vb == null ? va : vb) - va) * t;
      else out[k] = va;
    }
    return out;
  }
  function copyPose(a, out) { return lerpPose(a, a, 0, out); }
  // take the hips and legs of `legs` (a lying position pose) into `pose`, keeping its upper body
  function legsFrom(pose, legs) {
    pose.h = legs.h; pose.lfy = legs.lfy; pose.rfy = legs.rfy;
    for (const k of ['lf', 'rf', 'lPole', 'rPole']) { pose[k] = pose[k] || []; for (let i = 0; i < legs[k].length; i++) pose[k][i] = legs[k][i]; }
    return pose;
  }

  // ---------- two-bone IK ----------
  const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _u = new THREE.Vector3(), _e = new THREE.Vector3(), _l = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const _qU = new THREE.Quaternion(), _qL = new THREE.Quaternion(), _qInv = new THREE.Quaternion();
  function solveIK(rootPos, target, L1, L2, pole, upperGroup, lowerGroup) {
    _d.copy(target).sub(rootPos);
    let dist = _d.length();
    const maxR = L1 + L2 - 0.005, minR = Math.abs(L1 - L2) + 0.02;
    if (dist < 1e-4) { _d.set(0, -1, 0); dist = 1e-4; }
    const dn = _d.multiplyScalar(1 / dist);
    dist = clamp(dist, minR, maxR);
    const cosA = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
    const a = Math.acos(cosA);
    _p.copy(pole).addScaledVector(dn, -pole.dot(dn));
    if (_p.lengthSq() < 1e-6) _p.set(0, 0, 1).addScaledVector(dn, -dn.z);
    _p.normalize();
    _u.copy(dn).multiplyScalar(Math.cos(a)).addScaledVector(_p, Math.sin(a));
    _e.copy(rootPos).addScaledVector(_u, L1);
    _l.copy(rootPos).addScaledVector(dn, dist).sub(_e).normalize();
    _qU.setFromUnitVectors(DOWN, _u);
    _qL.setFromUnitVectors(DOWN, _l);
    upperGroup.quaternion.copy(_qU);
    _qInv.copy(_qU).invert();
    lowerGroup.quaternion.copy(_qInv.multiply(_qL));
  }

  // ---------- fighter model ----------
  // The visible fighter is eleven rigid segments (the same rig the physics uses: box pelvis and
  // chest, ball head, capsule limbs, ball gloves, box feet). While the ragdoll is live the segments
  // copy its bodies one-to-one from the pose snapshot in the sim state. On the ground (and in the
  // menu / without physics) a hidden two-bone IK skeleton is posed from POSES and the segments are
  // snapped onto its bones, so the look never changes.
  const SEGS = (root.MMAPhys && root.MMAPhys.SEGS) || null;
  const SEG_ORDER = ['pelvis', 'chest', 'head', 'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm', 'lThigh', 'lShin', 'rThigh', 'rShin'];
  const ANKLE_PIVOT = [0, -0.215, -0.02]; // where the foot hinges on the shin — mirrors js/physics.js
  const RIG = { // segment dims (metres) — mirrors js/physics.js SEGS
    pelvis: [0.16, 0.09, 0.11], chest: [0.19, 0.20, 0.12], headR: 0.12,
    upperArm: [0.12, 0.05], forearm: [0.12, 0.045], fistR: 0.062, fistY: -0.18,
    thigh: [0.18, 0.075], shin: [0.18, 0.055], foot: [0.05, 0.035, 0.11], footPos: [0, -0.22, 0.05],
    chestUp: 0.34, headUp: 0.34, shoulder: [0.23, 0.17], hip: [0.10, -0.08]
  };
  if (SEGS) {
    const s = SEGS;
    RIG.pelvis = s.pelvis.shape.slice(1); RIG.chest = s.chest.shape.slice(1); RIG.headR = s.head.shape[1];
    RIG.upperArm = s.lUpperArm.shape.slice(1); RIG.forearm = s.lForearm.shape.slice(1); RIG.fistR = s.lForearm.extra.shape[1]; RIG.fistY = s.lForearm.extra.pos[1];
    RIG.thigh = s.lThigh.shape.slice(1); RIG.shin = s.lShin.shape.slice(1); RIG.foot = s.lShin.extra.shape.slice(1); RIG.footPos = s.lShin.extra.pos.slice();
    RIG.chestUp = s.chest.anchorParent[1] - s.chest.anchorSelf[1];
    RIG.headUp = s.head.anchorParent[1] - s.head.anchorSelf[1];
    RIG.shoulder = [-s.lUpperArm.anchorParent[0], s.lUpperArm.anchorParent[1]];
    RIG.hip = [-s.lThigh.anchorParent[0], s.lThigh.anchorParent[1]];
  }
  // IK bone lengths derived from the rig: joint-to-joint for the upper bones, joint-to-weapon for the lower
  const UPPER_L = RIG.upperArm[0] * 2 + 0.04, FORE_L = RIG.forearm[0] + 0.02 - RIG.fistY;   // elbow -> glove centre
  const THIGH_L = RIG.thigh[0] * 2 + 0.06, SHIN_L = RIG.shin[0] + 0.03 - RIG.footPos[1];     // knee -> foot centre
  const SH_X = RIG.shoulder[0], SH_Y = RIG.chestUp + RIG.shoulder[1], HIP_XX = RIG.hip[0], HIP_Y = RIG.hip[1];
  const _q = new THREE.Quaternion(), _pw = new THREE.Vector3(), _off = new THREE.Vector3();

  function makeProp() {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0xe7edf4, metalness: 0.72, roughness: 0.2 });
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.6, roughness: 0.32 });
    const gripMat = new THREE.MeshStandardMaterial({ color: 0x4a2c18, roughness: 0.72 });
    // Built along local -Y. The lead forearm aims that axis forward in the guard.
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.78, 0.014), steel);
    bar.position.y = -0.52;
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.78, 0.05), steel);
    edge.position.y = -0.52;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.045), goldMat);
    guard.position.y = -0.12;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.13, 8), gripMat);
    grip.position.y = -0.04;
    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), goldMat);
    pommel.position.y = 0.04;
    g.add(bar, edge, guard, grip, pommel);
    g.visible = false;
    return g;
  }
  function makePop() {
    const g = new THREE.Group();
    // Long axis along local -Z, which is the direction Object3D.lookAt aims.
    const metal = new THREE.MeshStandardMaterial({ color: 0x4a4a52, metalness: 0.72, roughness: 0.28 });
    const gripMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.8 });
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.075, 0.26), metal);
    slide.position.z = -0.05;
    const tube = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.026, 0.12), metal);
    tube.position.z = -0.22;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.12, 0.055), gripMat);
    grip.position.set(0, -0.09, 0.03);
    grip.rotation.x = -0.22;
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.02, 0.02), new THREE.MeshBasicMaterial({ color: 0xffb24a }));
    sight.position.set(0, 0.05, -0.26);
    g.add(slide, tube, grip, sight);
    g.scale.setScalar(1.28);
    g.visible = false;
    return g;
  }
  function BloodField(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 512;
    this.g = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.mesh = new THREE.Mesh(
      new THREE.CircleGeometry(4.55, 40),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    );
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.045;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    const geo = new THREE.SphereGeometry(0.04, 6, 5);
    const mat = new THREE.MeshBasicMaterial({ color: 0x8a1014 });
    this.drops = [];
    for (let i = 0; i < 140; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.castShadow = false;
      scene.add(m);
      this.drops.push({ m, v: new THREE.Vector3(), life: 0 });
    }
    this.on = false;
  }
  BloodField.prototype.stamp = function (x, z, size) {
    const u = (x / 9.1 + 0.5) * 512;
    const v = (z / 9.1 + 0.5) * 512;
    const rad = 8 + size * 16;
    const g = this.g;
    const grd = g.createRadialGradient(u, v, 0, u, v, rad);
    grd.addColorStop(0, 'rgba(110, 6, 10, 0.9)');
    grd.addColorStop(0.55, 'rgba(80, 4, 8, 0.5)');
    grd.addColorStop(1, 'rgba(80, 4, 8, 0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(u, v, rad, 0, Math.PI * 2);
    g.fill();
    this.tex.needsUpdate = true;
    this.mesh.visible = true;
  };
  BloodField.prototype.explode = function (origin) {
    if (!origin) return;
    this.mesh.visible = true;
    this.stamp(origin.x, origin.z, 6);
    for (let i = 0; i < 28; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 0.15 + Math.random() * 1.8;
      this.stamp(origin.x + Math.cos(ang) * rad, origin.z + Math.sin(ang) * rad, 1.4 + Math.random() * 2.2);
    }
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      d.life = 0.7 + Math.random() * 0.8;
      d.m.visible = true;
      d.m.position.copy(origin);
      const sc = 1.6 + Math.random() * 3.4;
      d.m.scale.setScalar(sc);
      const ang = Math.random() * Math.PI * 2;
      const sp = 2.4 + Math.random() * 7;
      d.v.set(Math.cos(ang) * sp, 2.2 + Math.random() * 6.5, Math.sin(ang) * sp);
    }
  };
  BloodField.prototype.burst = function (origin, power) {
    if (!this.on || !origin) return;
    const pwr = power < 0.3 ? 0.3 : power > 1.4 ? 1.4 : power;
    const n = 12 + Math.round(pwr * 20);
    let spawned = 0;
    for (let i = 0; i < this.drops.length && spawned < n; i++) {
      const d = this.drops[i];
      if (d.life > 0) continue;
      d.life = 0.55 + Math.random() * 0.55;
      d.m.visible = true;
      d.m.scale.setScalar(1);
      d.m.position.copy(origin);
      const ang = Math.random() * Math.PI * 2;
      const sp = 1.1 + pwr * 3.2 * Math.random();
      d.v.set(Math.cos(ang) * sp, 1.5 + Math.random() * 2.6 * pwr, Math.sin(ang) * sp);
      spawned++;
    }
    const stains = 5 + Math.round(pwr * 8);
    for (let i = 0; i < stains; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * (0.45 + pwr);
      this.stamp(origin.x + Math.cos(ang) * rad, origin.z + Math.sin(ang) * rad, 0.45 + Math.random() * pwr);
    }
  };
  BloodField.prototype.step = function (dt) {
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      if (d.life <= 0) continue;
      d.life -= dt;
      d.v.y -= 10 * dt;
      d.m.position.x += d.v.x * dt;
      d.m.position.y += d.v.y * dt;
      d.m.position.z += d.v.z * dt;
      if (d.m.position.y <= 0.05 || d.life <= 0) {
        if (d.m.position.y <= 0.35) this.stamp(d.m.position.x, d.m.position.z, 0.55 + Math.random() * 0.7);
        d.life = 0;
        d.m.visible = false;
      }
    }
  };
  BloodField.prototype.clear = function () {
    this.g.clearRect(0, 0, 512, 512);
    this.tex.needsUpdate = true;
    this.mesh.visible = false;
    for (let i = 0; i < this.drops.length; i++) { this.drops[i].life = 0; this.drops[i].m.visible = false; }
  };

  class FighterModel {
    constructor(scene, color, skin, idx) {
      this.idx = idx;
      const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.75, metalness: 0.0 });
      const shortsMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
      const gloveMat = new THREE.MeshStandardMaterial({ color: idx === 0 ? 0xc62828 : 0x1e5bd6, roughness: 0.4, metalness: 0.05 });
      const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.9 });
      const headMat = skinMat.clone(), bodyMat = skinMat.clone(), legMat = skinMat.clone();
      this.mats = { skinMat, shortsMat, gloveMat, headMat, bodyMat, legMat };
      this.skinBase = new THREE.Color(skin);

      // ---- visible segments (world-space groups)
      // Each physics segment is a group holding an anatomical-ish body part built from lathes (smooth, tapered
      // muscle shapes) plus a few spheres and boxes for landmarks. Everything stays inside / close to the physics
      // collider of that segment so what you see is what gets hit.
      this.segs = {}; this.feet = {};
      const seg = (name) => { const g = new THREE.Group(); scene.add(g); this.segs[name] = g; return g; };
      const addMesh = (g, geo, mat, offset, scale) => {
        const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true;
        if (offset) m.position.set(...offset); if (scale) m.scale.set(...scale); g.add(m); return m;
      };
      // lathe around Y from a profile of [y, radius] pairs (top to bottom); zScale squashes it into an ellipse
      const lathe = (g, profile, mat, zScale, offset) => {
        // LatheGeometry winds its faces outward for points ordered bottom-to-top; profiles here are written top-down
        const ordered = profile[0][0] > profile[profile.length - 1][0] ? profile.slice().reverse() : profile;
        const pts = ordered.map(([y, r]) => new THREE.Vector2(Math.max(r, 0.001), y));
        const m = addMesh(g, new THREE.LatheGeometry(pts, 24), mat, offset, zScale ? [1, 1, zScale] : null);
        return m;
      };
      // smooth limb: capped lathe with rounded ends, radius given at the top, the belly (fraction f down) and the bottom
      const limb = (g, half, rTop, rBelly, rBot, f, mat, ySkew) => {
        const prof = [];
        const N = 14;
        for (let i = 0; i <= N; i++) {
          const t = i / N, y = half - t * half * 2;
          // blend top -> belly -> bottom with smooth cosine shoulders
          let r;
          if (t < f) { const u = t / f; r = rTop + (rBelly - rTop) * (0.5 - 0.5 * Math.cos(u * Math.PI)); }
          else { const u = (t - f) / (1 - f); r = rBelly + (rBot - rBelly) * (0.5 - 0.5 * Math.cos(u * Math.PI)); }
          prof.push([y, r]);
        }
        // rounded ends
        prof.unshift([half + rTop * 0.6, rTop * 0.75], [half + rTop * 0.9, rTop * 0.35], [half + rTop, 0]);
        prof.push([-half - rBot * 0.6, rBot * 0.75], [-half - rBot * 0.9, rBot * 0.35], [-half - rBot, 0]);
        return lathe(g, prof, mat, null, ySkew ? [0, ySkew, 0] : null);
      };
      const R = RIG;
      const trimMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 });
      const bandMat = new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.85 });
      const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xf4f0ea, roughness: 0.4 });
      const mouthMat = new THREE.MeshStandardMaterial({ color: 0x5a2a2a, roughness: 0.8 });

      // -- pelvis: fight shorts. Waistband at the top, hips flare, hem just above the thigh tops, a seam stripe.
      const pelvis = seg('pelvis');
      const PW = R.pelvis[0], PH = R.pelvis[1], PD = R.pelvis[2];
      lathe(pelvis, [[PH + 0.015, PW * 0.86], [PH, PW * 0.98], [PH * 0.4, PW * 1.06], [-PH * 0.3, PW * 1.1], [-PH - 0.02, PW * 1.06], [-PH - 0.05, PW * 0.98], [-PH - 0.06, 0.6 * PW]], shortsMat, PD / PW * 1.05);
      lathe(pelvis, [[PH + 0.03, PW * 0.9], [PH + 0.03, PW * 0.84], [PH - 0.015, PW * 0.84], [PH - 0.015, PW * 1.0], [PH + 0.03, PW * 1.0]], bandMat, PD / PW * 1.05); // waistband
      addMesh(pelvis, new THREE.BoxGeometry(0.02, PH * 1.6, 0.012), trimMat, [PW * 1.07, -0.01, 0]);   // side stripes
      addMesh(pelvis, new THREE.BoxGeometry(0.02, PH * 1.6, 0.012), trimMat, [-PW * 1.07, -0.01, 0]);

      // -- chest: a torso lathe (wide shoulders, narrow waist) squashed front-to-back, with traps, pecs and abs
      const chest = seg('chest');
      const CW = R.chest[0], CH = R.chest[1], CD = R.chest[2];
      lathe(chest, [[CH + 0.045, CW * 0.36], [CH + 0.02, CW * 0.8], [CH - 0.01, CW * 1.04], [CH - 0.08, CW * 1.03], [0, CW * 0.95], [-CH * 0.55, CW * 0.86], [-CH, CW * 0.84], [-CH - 0.03, CW * 0.8]], bodyMat, CD / CW * 1.1);
      // trapezius wedges running from the neck to the shoulders
      addMesh(chest, new THREE.SphereGeometry(0.07, 14, 10), bodyMat, [0.1, CH - 0.01, -0.01], [1.5, 0.6, 0.75]);
      addMesh(chest, new THREE.SphereGeometry(0.07, 14, 10), bodyMat, [-0.1, CH - 0.01, -0.01], [1.5, 0.6, 0.75]);
      // pecs
      addMesh(chest, new THREE.SphereGeometry(0.085, 16, 12), bodyMat, [0.085, CH * 0.3, CD * 0.62], [1.05, 0.68, 0.38]);
      addMesh(chest, new THREE.SphereGeometry(0.085, 16, 12), bodyMat, [-0.085, CH * 0.3, CD * 0.62], [1.05, 0.68, 0.38]);
      // abs: three rows of paired blocks down the front
      for (let i = 0; i < 3; i++) for (const sx of [-1, 1]) addMesh(chest, new THREE.SphereGeometry(0.04, 10, 8), bodyMat, [sx * 0.04, -0.03 - i * 0.06, CD * 1.0], [0.95, 0.68, 0.2]);
      // shoulder blades hint at the back
      addMesh(chest, new THREE.SphereGeometry(0.09, 14, 10), bodyMat, [0.085, CH * 0.35, -CD * 0.62], [1.0, 1.0, 0.35]);
      addMesh(chest, new THREE.SphereGeometry(0.09, 14, 10), bodyMat, [-0.085, CH * 0.35, -CD * 0.62], [1.0, 1.0, 0.35]);
      // neck column rises from the chest (the head carries its own short neck so there is never a gap)
      addMesh(chest, new THREE.CylinderGeometry(0.052, 0.062, 0.1, 16), bodyMat, [0, CH + 0.04, -0.005]);

      // -- head: slightly egg-shaped skull, jaw, ears, brow, nose, eyes, mouth and a short crop of hair
      const head = seg('head');
      const HR = R.headR;
      this.head = addMesh(head, new THREE.SphereGeometry(HR, 28, 22), headMat, [0, 0.01, -0.005], [0.93, 1.05, 1.0]);
      addMesh(head, new THREE.SphereGeometry(HR * 0.78, 20, 16), headMat, [0, -HR * 0.52, HR * 0.18], [0.86, 0.72, 0.9]);     // jaw
      addMesh(head, new THREE.CylinderGeometry(0.05, 0.056, 0.1, 16), headMat, [0, -HR - 0.02, -0.01]);                       // neck
      addMesh(head, new THREE.SphereGeometry(0.028, 10, 8), headMat, [HR * 0.93, -0.005, -0.01], [0.55, 1.0, 0.8]);          // ears
      addMesh(head, new THREE.SphereGeometry(0.028, 10, 8), headMat, [-HR * 0.93, -0.005, -0.01], [0.55, 1.0, 0.8]);
      addMesh(head, new THREE.SphereGeometry(0.03, 12, 10), headMat, [0, 0.052, HR * 0.68], [2.2, 0.4, 0.7]);                 // brow ridge
      addMesh(head, new THREE.SphereGeometry(0.02, 10, 8), headMat, [0, -0.02, HR * 0.94], [0.7, 1.25, 0.9]);               // nose
      for (const sx of [-1, 1]) {
        addMesh(head, new THREE.SphereGeometry(0.02, 10, 8), eyeWhite, [sx * 0.045, 0.02, HR * 0.82], [1.1, 0.7, 0.6]);
        addMesh(head, new THREE.SphereGeometry(0.011, 8, 8), darkMat, [sx * 0.045, 0.02, HR * 0.82 + 0.014]);
        addMesh(head, new THREE.SphereGeometry(0.05, 12, 10), headMat, [sx * 0.06, -0.03, HR * 0.5], [0.8, 0.75, 0.75]);     // cheekbones
      }
      addMesh(head, new THREE.BoxGeometry(0.05, 0.008, 0.01), mouthMat, [0, -0.065, HR * 0.86]);                              // mouth
      addMesh(head, new THREE.SphereGeometry(HR * 1.01, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.44), darkMat, [0, 0.012, -0.015], [0.94, 1.05, 1.0]); // hair cap

      for (const side of ['l', 'r']) {
        const sx = side === 'l' ? -1 : 1;
        // -- upper arm: deltoid cap at the shoulder, bicep belly, narrowing to the elbow
        const ua = seg(side + 'UpperArm');
        const UH = R.upperArm[0], UR = R.upperArm[1];
        limb(ua, UH, UR * 1.15, UR * 1.3, UR * 0.95, 0.45, skinMat);
        addMesh(ua, new THREE.SphereGeometry(UR * 1.55, 16, 12), skinMat, [0, UH + 0.01, 0], [1.0, 0.9, 1.0]);           // deltoid
        // -- forearm + glove
        const fa = seg(side + 'Forearm');
        const FH = R.forearm[0], FR = R.forearm[1];
        limb(fa, FH, FR * 1.1, FR * 1.25, FR * 0.82, 0.3, skinMat);
        addMesh(fa, new THREE.SphereGeometry(FR * 1.1, 12, 10), skinMat, [0, FH + 0.005, 0]);                              // elbow
        // MMA glove: padded knuckle block over the fist, open palm side, thumb, wrist strap
        const GY = R.fistY, GR = R.fistR;
        addMesh(fa, new THREE.SphereGeometry(GR, 18, 14), gloveMat, [0, GY, 0.005], [1.0, 1.0, 0.85]);                      // fist
        addMesh(fa, new THREE.SphereGeometry(GR * 0.95, 16, 12), gloveMat, [0, GY - 0.01, 0.025], [1.05, 0.8, 0.8]);         // knuckle pad
        addMesh(fa, new THREE.SphereGeometry(GR * 0.45, 10, 8), gloveMat, [sx * -GR * 0.75, GY + 0.015, 0.03], [0.8, 1.2, 0.8]); // thumb
        for (let i = 0; i < 4; i++) addMesh(fa, new THREE.SphereGeometry(0.012, 8, 6), skinMat, [(-0.03 + i * 0.02) * -sx, GY - GR * 0.95, 0.01]); // fingertips
        addMesh(fa, new THREE.CylinderGeometry(FR * 1.1, FR * 1.2, 0.06, 16), gloveMat, [0, GY + GR + 0.01, 0]);         // wrist strap
        addMesh(fa, new THREE.CylinderGeometry(FR * 1.14, FR * 1.14, 0.014, 16), bandMat, [0, GY + GR + 0.02, 0]);     // strap seam
        // -- thigh: shorts leg over the top half, quad belly, knee cap
        const th = seg(side + 'Thigh');
        const TH = R.thigh[0], TR = R.thigh[1];
        limb(th, TH, TR * 1.12, TR * 1.26, TR * 0.86, 0.4, legMat);
        lathe(th, [[TH + 0.03, TR * 1.15], [TH, TR * 1.32], [TH * 0.5, TR * 1.36], [0.02, TR * 1.33], [-0.01, TR * 1.28], [-0.015, TR * 0.9]], shortsMat, 1);
        addMesh(th, new THREE.CylinderGeometry(TR * 1.32, TR * 1.32, 0.012, 20), trimMat, [0, -0.005, 0]);           // hem trim
        addMesh(th, new THREE.SphereGeometry(TR * 0.72, 14, 10), legMat, [0, -TH - 0.01, 0.015], [1.0, 1.0, 0.9]);   // knee
        // -- shin: calf belly high at the back, thin ankle, bare foot
        const sh = seg(side + 'Shin');
        const SH = R.shin[0], SR = R.shin[1];
        limb(sh, SH, SR * 1.12, SR * 1.28, SR * 0.82, 0.3, legMat);
        addMesh(sh, new THREE.SphereGeometry(SR * 1.15, 14, 10), legMat, [0, SH * 0.45, -SR * 0.5], [0.95, 1.5, 0.95]);  // calf
        const fp = R.footPos, FW = R.foot[0], FHh = R.foot[1], FL = R.foot[2];
        addMesh(sh, new THREE.SphereGeometry(SR * 0.9, 12, 10), legMat, [0, fp[1] + FHh + 0.02, -0.005], [1.0, 0.8, 1.0]); // ankle
        // the foot hangs off an ankle group so it can point (plantar-flex) with the physics foot during kicks
        const AP = ANKLE_PIVOT, foot = new THREE.Group(); foot.position.set(AP[0], AP[1], AP[2]); sh.add(foot); this.feet[side] = foot;
        const fo = (x, y, z) => [x - AP[0], y - AP[1], z - AP[2]];
        addMesh(foot, new THREE.BoxGeometry(FW * 2, FHh * 2, FL * 1.6), legMat, fo(fp[0], fp[1], fp[2] - FL * 0.2));          // foot body
        addMesh(foot, new THREE.SphereGeometry(FW, 14, 10), legMat, fo(fp[0], fp[1] - FHh * 0.1, fp[2] + FL * 0.6), [1.0, 0.75, 1.0]); // toes
        addMesh(foot, new THREE.SphereGeometry(FW * 0.9, 12, 10), legMat, fo(fp[0], fp[1], fp[2] - FL * 0.95), [1.0, 0.8, 0.7]);     // heel
        addMesh(foot, new THREE.BoxGeometry(FW * 2.05, 0.008, FL * 2.05), bandMat, fo(fp[0], fp[1] - FHh, fp[2] - FL * 0.02));      // sole
      }
      // a cut over the eye, a marked nose and mouth, and a smear on the chest (shown as damage climbs)
      const bloodMat = new THREE.MeshStandardMaterial({ color: 0x8a0f12, roughness: 0.35, transparent: true, opacity: 0 });
      this.bloodMat = bloodMat;
      const cut = addMesh(head, new THREE.BoxGeometry(0.05, 0.016, 0.02), bloodMat, [0.05, 0.062, R.headR * 0.78]); cut.rotation.z = 0.3; cut.castShadow = false;
      const nose = addMesh(head, new THREE.BoxGeometry(0.03, 0.06, 0.02), bloodMat, [0, -0.05, R.headR * 0.88]); nose.castShadow = false;
      const cheek = addMesh(head, new THREE.SphereGeometry(0.03, 8, 6), bloodMat, [-0.075, -0.02, R.headR * 0.7]); cheek.scale.set(1, 1.3, 0.5); cheek.castShadow = false;
      const smear = addMesh(chest, new THREE.BoxGeometry(0.14, 0.22, 0.01), bloodMat, [0.02, 0.0, R.chest[2] * 1.1 + 0.01]); smear.castShadow = false;
      this.blood = { cut, nose, cheek, smear };

      // ---- hidden IK skeleton (drives the segments when the ragdoll is parked)
      this.root = new THREE.Group();
      this.body = new THREE.Group(); this.root.add(this.body);           // hips; y = hip height
      this.torso = new THREE.Group(); this.body.add(this.torso);         // pitch / yaw
      this.neck = new THREE.Group(); this.neck.position.y = RIG.chestUp + RIG.headUp; this.torso.add(this.neck);
      this.lSh = new THREE.Group(); this.lSh.position.set(-SH_X, SH_Y, 0); this.torso.add(this.lSh);
      this.rSh = new THREE.Group(); this.rSh.position.set(SH_X, SH_Y, 0); this.torso.add(this.rSh);
      this.lEl = new THREE.Group(); this.lEl.position.y = -UPPER_L; this.lSh.add(this.lEl);
      this.rEl = new THREE.Group(); this.rEl.position.y = -UPPER_L; this.rSh.add(this.rEl);
      this.lHip = new THREE.Group(); this.lHip.position.set(-HIP_XX, HIP_Y, 0); this.body.add(this.lHip);
      this.rHip = new THREE.Group(); this.rHip.position.set(HIP_XX, HIP_Y, 0); this.body.add(this.rHip);
      this.lKn = new THREE.Group(); this.lKn.position.y = -THIGH_L; this.lHip.add(this.lKn);
      this.rKn = new THREE.Group(); this.rKn.position.y = -THIGH_L; this.rHip.add(this.rKn);
      scene.add(this.root);

      // shadow blob
      const blob = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.012; scene.add(blob);
      this.blob = blob;

      this.scene = scene;
      this.pose = copyPose(POSES.idle);
      this.px = 0; this.pz = 0; this.yaw = 0; this.initialized = false; this.physMode = false;
      this.flash = 0; this.stepPhase = 0;
      this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      this._pole = new THREE.Vector3();
      this._tipV = new THREE.Vector3();
      this._dmgC = new THREE.Color(); this._red = new THREE.Color(0.75, 0.25, 0.22); this._bruise = new THREE.Color(0.38, 0.22, 0.42);
      this._eul = new THREE.Euler(); this._qHip = new THREE.Quaternion(); this._yAxis = new THREE.Vector3(0, 1, 0);
      this._tipArr = [0, 0, 0];
      this.prop = makeProp();
      // Lead hand. The long axis is the one that points forward in the orthodox guard.
      this.prop.position.set(0, RIG.fistY, 0);
      this.prop.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(-0.091, -0.597, -0.797).normalize());
      this.segs.lForearm.add(this.prop);
      this.pop = makePop();
      // It runs out past the fist (forearm -Y), so a lead punch points it forward.
      this.pop.position.set(0.045, RIG.fistY - 0.02, 0.02);
      this.pop.rotation.x = -Math.PI / 2;
      this.segs.lForearm.add(this.pop);
      this.pocket = false;
    }

    carry(f) {
      const pocket = !!(f && f.pocket);
      const edge = !!(f && f.edge) && !pocket;
      if (this.pop) this.pop.visible = pocket;
      if (this.prop) this.prop.visible = edge;
    }

    dispose() {
      if (this.pop && this.pop.parent) this.pop.parent.remove(this.pop);
      for (const n in this.segs) this.scene.remove(this.segs[n]);
      this.scene.remove(this.root); this.scene.remove(this.blob);
    }

    setColors(color, skin) { this.mats.shortsMat.color.setHex(color); this.skinBase.setHex(skin); for (const k of ['skinMat', 'headMat', 'bodyMat', 'legMat']) this.mats[k].color.setHex(skin); }

    // bruising + blood per damage region
    updateDamage(f) {
      const B = this.skinBase, fl = Math.max(0, this.flash);
      const tint = (mat, d) => {
        // reddens first (0-45), then darkens towards purple-blue bruising (45-100)
        const c = this._dmgC.copy(B);
        const red = Math.min(1, d / 45), br = Math.max(0, (d - 40) / 60);
        c.lerp(this._red, red * 0.35); c.lerp(this._bruise, br * 0.55);
        mat.color.copy(c);
        mat.emissive.setRGB(fl * 0.6, fl * 0.1, fl * 0.1);
      };
      tint(this.mats.headMat, f.dmg.head); tint(this.mats.bodyMat, f.dmg.body); tint(this.mats.legMat, f.dmg.legs);
      this.mats.skinMat.emissive.setRGB(fl * 0.6, fl * 0.1, fl * 0.1);
      const h = f.dmg.head;
      this.bloodMat.opacity = h > 25 ? Math.min(1, (h - 25) / 30) : 0;
      this.blood.cut.visible = h > 25; this.blood.nose.visible = h > 40; this.blood.cheek.visible = h > 55; this.blood.smear.visible = h > 60;
      this.blood.smear.scale.y = 0.4 + Math.min(1, (h - 60) / 40) * 0.8;
    }

    // compute target pose from sim state
    targetPose(f, S, out) {
      const a = f.act;
      let pose;
      if (S.phase === 'over' && S.result && S.result.winner === f.idx) pose = POSES.celebrate;
      else if (a.type === 'down') pose = POSES.down;
      else if (f.ground === 'bottom') {
        const pos = S.ground ? S.ground.pos : 'guard';
        const base = pos === 'guard' ? POSES.bottomGuard : pos === 'half' ? POSES.bottomHalf : pos === 'back' ? POSES.turtle : POSES.bottomFlat;
        if (a.type === 'strike') return this._strikePose(f, out, base);
        // in guard / half guard the legs stay wrapped around the top fighter whatever the upper body is doing
        const wrap = pos === 'guard' || pos === 'half';
        if (a.type === 'sub') pose = POSES.bottomSub;
        else if (a.type === 'hit') pose = pos === 'back' ? POSES.turtle : POSES.bottomHit;
        else if (a.type === 'caught') pose = POSES.bottomHit;
        else if (a.type === 'trans') return lerpPose(base, pos === 'back' ? POSES.bottomHalf : POSES.bottomHit, 0.35 + 0.25 * Math.sin(a.t * 14), out);
        else if ((this.inputHint & IN.BLOCK) && pos !== 'back') return legsFrom(lerpPose(base, POSES.bottomBlock, 0.6, out), base);
        else pose = base;
        if (wrap && pose !== base && pose !== POSES.bottomSub) return legsFrom(copyPose(pose, out), base);
      } else if (f.ground === 'top') {
        const pos = S.ground ? S.ground.pos : 'guard';
        const base = pos === 'guard' ? POSES.topGuard : pos === 'half' ? POSES.top : pos === 'side' ? POSES.topSide : pos === 'mount' ? POSES.topMount : POSES.topBack;
        if (a.type === 'strike') return this._strikePose(f, out, base);
        if (a.type === 'sub') pose = pos === 'back' ? POSES.topBack : POSES.topSub;
        else if (a.type === 'caught') pose = POSES.topCaught;
        else if (a.type === 'hit') pose = POSES.topHit;
        else if (a.type === 'trans') return lerpPose(base, POSES.topPosture, 0.35 + 0.25 * Math.sin(a.t * 14), out);
        else pose = f.posture ? POSES.topPosture : base;
      } else {
        switch (a.type) {
          case 'strike': return this._strikePose(f, out);
          case 'hit': pose = a.name === 'body' ? POSES.hitBody : a.name === 'legs' ? POSES.hitLegs : POSES.hitHead; break;
          case 'dodge': pose = POSES.dodge; break;
          case 'push': pose = a.t < 0.26 ? POSES.push : POSES.idle; break;
          case 'stumble': pose = POSES.stumble; break;
          case 'sprawl': pose = POSES.sprawl; break;
          case 'takedown': {
            const u = clamp(a.t / 0.32, 0, 1);
            if (!a.hit) return lerpPose(POSES.tdWind, POSES.tdShoot, smooth(u), out);
            return lerpPose(POSES.tdShoot, POSES.stumble, smooth(clamp((a.t - 0.32) / 0.4, 0, 1)), out);
          }
          case 'celebrate': pose = POSES.celebrate; break;
          default: pose = f.blocking ? ((this.inputHint & IN.MOD3) ? POSES.blockLow : POSES.block) : POSES.idle;
        }
      }
      return copyPose(pose, out);
    }

    _strikePose(f, out, groundBase) {
      const a = f.act, st = STRIKES[a.name];
      const left = st.limb === 'lh' || st.limb === 'll';
      let kf = (left ? STRIKE_POSES_L : STRIKE_POSES)[st.kind] || STRIKE_POSES.straight;
      const tf = a.tf || 1;
      const w = st.w * tf, ac = st.a * tf, r = st.r * tf;
      const base = groundBase || (f.ground ? POSES.top : POSES.idle);
      if (f.ground === 'bottom' && st.ground) {
        // striking up from the back: blend the ground punch keyframes onto the lying pose
        const kfB = kf.map(k => Object.assign(copyPose(base), { lh: k.lh.map((v, i) => i === 1 ? v + 0.45 : v), rh: k.rh.map((v, i) => i === 1 ? v + 0.45 : v) }));
        kf = kfB;
      }
      if (a.t < w) return lerpPose(base, kf[0], smooth(clamp(a.t / w, 0, 1)), out);
      if (a.t < w + ac) return lerpPose(kf[0], kf[1], smooth(clamp((a.t - w) / (ac * 0.6), 0, 1)), out);
      return lerpPose(kf[1], base, smooth(clamp((a.t - w - ac) / r, 0, 1)), out);
    }

    // While a standing strike is live, drive the striking limb from the simulation's tip path so the
    // hand / foot on screen is exactly where the hit detection says it is. Returns the root-local tip.
    _limbOverride(f, p) {
      const a = f.act;
      if (a.type !== 'strike' || f.ground) return null;
      const st = STRIKES[a.name];
      if (!st || st.ground || !st.path) return null;
      const tip = strikeTip(st, a.t, a.tf || 1, this._tipArr);
      // sim frame [fwd, side(left), height] -> root-local (x = -side, y = height, z = fwd)
      const lx = -tip[1], ly = tip[2], lz = tip[0];
      const hand = st.tip === 'hand';
      if (hand) {
        // lunge: if the fist is beyond the arm's reach, carry the body forward with it
        const sx = (st.limb === 'lh' ? -SH_X : SH_X) + p.ox, sy = p.h + SH_Y, sz = p.oz + 0.05;
        const over = Math.hypot(lx - sx, ly - sy, lz - sz) - (UPPER_L + FORE_L + 0.07);
        if (over > 0) { p.oz += Math.min(0.32, over); p.lean += Math.min(0.25, over * 0.6); }
      } else {
        const hx0 = st.limb === 'll' ? -HIP_XX : HIP_XX;
        const hx = hx0 * Math.cos(p.hipYaw) + p.ox, hy = p.h + HIP_Y, hz = -hx0 * Math.sin(p.hipYaw) + p.oz;
        const reach = st.tip === 'knee' ? THIGH_L : THIGH_L + SHIN_L;
        const over = Math.hypot(lx - hx, ly - hy, lz - hz) - (reach + 0.02);
        if (over > 0) { p.oz += Math.min(0.28, over * 0.9); if (st.tip !== 'knee') p.h -= Math.min(0.06, over * 0.2); }
      }
      return { st, lx, ly, lz, hand };
    }

    // ---- segments <- physics snapshot (11 x [px,py,pz,qx,qy,qz,qw])
    _applySnapshot(pose, dt, k) {
      const a = 1 - Math.exp(-dt * k);
      for (let i = 0; i < SEG_ORDER.length; i++) {
        const g = this.segs[SEG_ORDER[i]], o = i * 7;
        _pw.set(pose[o], pose[o + 1], pose[o + 2]);
        _q.set(pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]);
        if (this.physMode) { g.position.lerp(_pw, a); g.quaternion.slerp(_q, a); }
        else { g.position.copy(_pw); g.quaternion.copy(_q); }
      }
      // ankles (plantar-flexion, rad) ride along after the eleven segments
      const n = SEG_ORDER.length * 7;
      const al = pose.length > n + 1 ? pose[n] : 0, ar = pose.length > n + 1 ? pose[n + 1] : 0;
      if (this.physMode) { this.feet.l.rotation.x += (al - this.feet.l.rotation.x) * a; this.feet.r.rotation.x += (ar - this.feet.r.rotation.x) * a; }
      else { this.feet.l.rotation.x = al; this.feet.r.rotation.x = ar; }
    }
    // ---- segments <- hidden IK skeleton
    _segFromBone(name, bone, offY, offZ) {
      const g = this.segs[name];
      bone.getWorldQuaternion(g.quaternion);
      bone.getWorldPosition(g.position);
      if (offY || offZ) { _off.set(0, offY || 0, offZ || 0).applyQuaternion(g.quaternion); g.position.add(_off); }
    }
    _applySkeleton() {
      this.root.updateMatrixWorld(true);
      this._segFromBone('pelvis', this.body);
      this._segFromBone('chest', this.torso, RIG.chestUp);
      this._segFromBone('head', this.neck);
      this._segFromBone('lUpperArm', this.lSh, -RIG.upperArm[0] - 0.02); this._segFromBone('rUpperArm', this.rSh, -RIG.upperArm[0] - 0.02);
      this._segFromBone('lForearm', this.lEl, -RIG.forearm[0] - 0.02); this._segFromBone('rForearm', this.rEl, -RIG.forearm[0] - 0.02);
      this._segFromBone('lThigh', this.lHip, -RIG.thigh[0] - 0.03); this._segFromBone('rThigh', this.rHip, -RIG.thigh[0] - 0.03);
      this._segFromBone('lShin', this.lKn, -RIG.shin[0] - 0.03); this._segFromBone('rShin', this.rKn, -RIG.shin[0] - 0.03);
      this.feet.l.rotation.x = 0; this.feet.r.rotation.x = 0;
    }

    update(f, S, opp, dt, time, groundAxis, posLerp) {
      // ---- live ragdoll: the sim publishes every bone, nothing to pose
      if (f.pose && f.pose.length >= SEG_ORDER.length * 7 && !f.ground) {
        this._applySnapshot(f.pose, dt, posLerp && posLerp < 15 ? 14 : 40); // guests smooth between snapshots
        const pv = this.segs.pelvis.position;
        this.px = pv.x; this.pz = pv.z;
        _off.set(0, 0, 1).applyQuaternion(this.segs.pelvis.quaternion);
        this.yaw = Math.atan2(_off.x, _off.z);
        this.initialized = true;
        this.physMode = true;
        this.blob.position.set(this.px, 0.012, this.pz);
        this.blob.material.opacity = 0.35;
        if (this.flash > 0) this.flash -= dt * 4;
        this.updateDamage(f);
        return;
      }
      const wasPhys = this.physMode;
      this.physMode = false;

      // ---- position & facing ----
      let tx = f.x, tz = f.z, tyaw;
      if (S.ground && f.ground) {
        const ax = groundAxis.x, az = groundAxis.z;
        // top keeps facing +axis; bottom lies with head towards +axis (local -Z after lying back)
        const pos = S.ground.pos || 'guard';
        if (f.ground === 'bottom') {
          tyaw = pos === 'back' ? Math.atan2(ax, az) : Math.atan2(-ax, -az);  // turtled: faces +axis
          tx = f.x; tz = f.z;
        } else {
          const off = GROUND_OFF[pos] || GROUND_OFF.guard;   // [along axis, across axis]
          const px = -az, pz = ax;                            // perpendicular
          tx = f.x + ax * off[0] + px * off[1]; tz = f.z + az * off[0] + pz * off[1];
          tyaw = pos === 'side' ? Math.atan2(-px, -pz) : Math.atan2(ax, az);
        }
      } else if (f.act.type === 'down') {
        tyaw = this.yaw;
      } else if (S.phase === 'break') {
        tx = f.idx === 0 ? -3.1 : 3.1; tz = 0; tyaw = Math.atan2(-tx, 0.001);
      } else {
        tyaw = Math.atan2(opp.x - f.x, opp.z - f.z);
      }
      if (!this.initialized) { this.px = tx; this.pz = tz; this.yaw = tyaw; this.initialized = true; }
      const k = posLerp || 18;
      this.px += (tx - this.px) * expo(dt, k); this.pz += (tz - this.pz) * expo(dt, k);
      let dy = tyaw - this.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * expo(dt, 10);
      const moving = f.act.type === 'move' && !f.ground;

      // ---- pose ----
      const target = this.targetPose(f, S, this._tp);
      this._tp = target;
      const speed = (f.act.type === 'strike' || f.act.type === 'hit' || f.act.type === 'dodge' || f.act.type === 'push') ? 26 : 12;
      if (wasPhys) copyPose(target, this.pose); // coming off the ragdoll: start from the new pose, not a stale one
      else lerpPose(this.pose, target, expo(dt, speed), this.pose);
      // overrides (striking limb, lunge) are applied to a per-frame copy so they never feed back into the smoothing
      const p = copyPose(this.pose, this._rp); this._rp = p;

      // procedural: breathing bob, rocked wobble, footwork
      const bob = Math.sin(time * 2.1 + f.idx) * 0.012;
      let wob = 0;
      if (f.rocked > 0 && !f.ground && f.act.type !== 'down') wob = Math.sin(time * 7) * 0.12 * Math.min(1, f.rocked) + Math.sin(time * 3.3) * 0.08;

      const ov = this._limbOverride(f, p);
      this.root.position.set(this.px, 0, this.pz);
      this.root.rotation.set(0, this.yaw, 0);
      this.body.position.set(p.ox, p.h + bob, p.oz);
      this.body.rotation.set(p.lie, p.hipYaw, 0);
      // torso angles are authored in the root frame so a turned-over hip (kicks) doesn't change what lean/roll mean
      this._eul.set(p.lean + wob * 0.5, p.yaw, p.roll + wob);
      this.torso.quaternion.setFromEuler(this._eul);
      if (p.hipYaw) { this._qHip.setFromAxisAngle(this._yAxis, -p.hipYaw); this.torso.quaternion.premultiply(this._qHip); }
      this.neck.rotation.set(p.hp, p.hy, 0);

      if (ov) {
        if (ov.hand) {
          // root-local -> torso-local for the arm IK
          this.root.updateMatrixWorld(true);
          const t = this._tipV.set(ov.lx, ov.ly, ov.lz);
          this.root.localToWorld(t); this.torso.worldToLocal(t);
          const tgt = ov.st.limb === 'lh' ? p.lh : p.rh;
          tgt[0] = t.x; tgt[1] = t.y; tgt[2] = t.z;
          const keep = ov.st.limb === 'lh' ? this.pose.lh : this.pose.rh; // so the limb eases back from where it really was
          keep[0] = t.x; keep[1] = t.y; keep[2] = t.z;
        } else {
          // feet are already in the root frame; a knee strike carries the foot tucked under the knee
          const left = ov.st.limb === 'll';
          const fxz = left ? p.lf : p.rf;
          if (ov.st.tip === 'knee') { fxz[0] = ov.lx; fxz[1] = ov.lz - 0.22; if (left) p.lfy = ov.ly - SHIN_L * 0.85; else p.rfy = ov.ly - SHIN_L * 0.85; }
          else { fxz[0] = ov.lx; fxz[1] = ov.lz; if (left) p.lfy = ov.ly; else p.rfy = ov.ly; }
          const kxz = left ? this.pose.lf : this.pose.rf; kxz[0] = fxz[0]; kxz[1] = fxz[1];
          if (left) this.pose.lfy = p.lfy; else this.pose.rfy = p.rfy;
        }
      }

      // ---- IK arms (torso frame) ----
      const v = this._v;
      v[0].set(-SH_X, SH_Y, 0); v[1].fromArray(p.lh);
      this._pole.set(-1, -0.4 - p.elbowOut * 0.3 + p.elbowUp, -0.6); // elbows down/out/back (raised for hooks)
      solveIK(v[0], v[1], UPPER_L, FORE_L, this._pole, this.lSh, this.lEl);
      v[0].set(SH_X, SH_Y, 0); v[1].fromArray(p.rh);
      this._pole.set(1, -0.4 - p.elbowOut * 0.3 + p.elbowUp, -0.6);
      solveIK(v[0], v[1], UPPER_L, FORE_L, this._pole, this.rSh, this.rEl);

      // ---- IK legs (body frame) ----
      if (p.lie > -0.5) {
        // standing: feet on ground in root frame -> body frame (body has only translation + small lie)
        let lfx = p.lf[0], lfz = p.lf[1], rfx = p.rf[0], rfz = p.rf[1];
        let lfy = p.lfy, rfy = p.rfy;
        if (moving) {
          this.stepPhase += dt * 9;
          const s = Math.sin(this.stepPhase), c = Math.cos(this.stepPhase);
          lfz += s * 0.12; rfz -= s * 0.12;
          lfy += Math.max(0, c) * 0.08; rfy += Math.max(0, -c) * 0.08;
        }
        const ch = Math.cos(p.hipYaw), sh = Math.sin(p.hipYaw);
        const toBody = (x, z, out) => { out.x = x * ch - z * sh; out.z = x * sh + z * ch; return out; };
        toBody(lfx - p.ox, lfz - p.oz, v[1]); v[1].y = lfy - (p.h + bob) + 0.05;
        v[0].set(-HIP_XX, HIP_Y, 0); this._pole.fromArray(p.lPole); solveIK(v[0], v[1], THIGH_L, SHIN_L, this._pole, this.lHip, this.lKn);
        toBody(rfx - p.ox, rfz - p.oz, v[1]); v[1].y = rfy - (p.h + bob) + 0.05;
        v[0].set(HIP_XX, HIP_Y, 0); this._pole.fromArray(p.rPole); solveIK(v[0], v[1], THIGH_L, SHIN_L, this._pole, this.rHip, this.rKn);
      } else {
        // lying on back: body frame rotated; targets given directly in body frame. The pose's knee poles are
        // [across, towards the head, up] (default: knees up and a little towards the head)
        v[0].set(-HIP_XX, HIP_Y, 0); v[1].set(p.lf[0], p.lfy, p.lf[1]);
        this._pole.set(p.lPole[0], p.lPole[1] + 0.3, p.lPole[2]); solveIK(v[0], v[1], THIGH_L, SHIN_L, this._pole, this.lHip, this.lKn);
        v[0].set(HIP_XX, HIP_Y, 0); v[1].set(p.rf[0], p.rfy, p.rf[1]);
        this._pole.set(p.rPole[0], p.rPole[1] + 0.3, p.rPole[2]); solveIK(v[0], v[1], THIGH_L, SHIN_L, this._pole, this.rHip, this.rKn);
      }
      this._applySkeleton();
      this.blob.position.set(this.px, 0.012, this.pz);
      this.blob.material.opacity = p.lie < -0.5 ? 0.15 : 0.35;

      // hit flash + accumulated damage on the skin
      if (this.flash > 0) { this.flash -= dt * 4; }
      this.updateDamage(f);
    }

    headWorld(out) { return out.copy(this.segs.head.position); }
    torsoWorld(out) { return out.copy(this.segs.chest.position); }
  }

  // ---------- arena ----------
  function chainLinkTexture() {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(200,205,215,0.95)'; g.lineWidth = 2.2;
    const s = 32;
    g.beginPath();
    for (let i = -4; i < 8; i++) {
      g.moveTo(i * s, 0); g.lineTo(i * s + 128, 128);
      g.moveTo(i * s + 128, 0); g.lineTo(i * s, 128);
    }
    g.stroke();
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(5, 2.4); t.anisotropy = 4;
    return t;
  }
  function matTexture() {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = '#2b2b30'; g.fillRect(0, 0, 1024, 1024);
    // subtle noise
    for (let i = 0; i < 4000; i++) { g.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.03) + ')'; g.fillRect(Math.random() * 1024, Math.random() * 1024, 3, 3); }
    g.strokeStyle = '#d8d8dc'; g.lineWidth = 10;
    g.beginPath(); g.arc(512, 512, 430, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(512, 512, 150, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(220,220,225,0.9)'; g.font = 'bold 110px Impact, Arial Black, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('CAGE', 512, 460); g.fillText('RULES', 512, 570);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 8;
    return t;
  }

  function buildArena(scene) {
    const R = 4.75, N = 8, H = 1.85;
    const g = new THREE.Group();
    // platform
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.5, R + 0.9, 0.7, N), new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.9 }));
    plat.position.y = -0.37; plat.receiveShadow = true; plat.rotation.y = Math.PI / N; g.add(plat); // top face at -0.02: just under the mat so the two never share a plane
    // mat
    const mat = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.06, N), new THREE.MeshStandardMaterial({ map: matTexture(), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    mat.position.y = -0.03; mat.receiveShadow = true; mat.rotation.y = Math.PI / N; g.add(mat);
    // fence + posts
    const fenceMat = new THREE.MeshStandardMaterial({ map: chainLinkTexture(), transparent: true, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5, alphaTest: 0.2, depthWrite: false });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x111115, roughness: 0.6, metalness: 0.4 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0x1b1b22, roughness: 0.8 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.5, metalness: 0.3, emissive: 0x3a2a05 });
    const segments = [];
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2 + Math.PI / N, a1 = ((i + 1) / N) * Math.PI * 2 + Math.PI / N;
      const x0 = Math.cos(a0) * R, z0 = Math.sin(a0) * R, x1 = Math.cos(a1) * R, z1 = Math.sin(a1) * R;
      // per-segment material clones so the fence nearest the camera can fade out
      const fM = fenceMat.clone(), pM = postMat.clone(), dM = padMat.clone(), aM = accent.clone();
      for (const m of [pM, dM, aM]) m.transparent = true;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, H, 10), pM);
      post.position.set(x0, H / 2, z0); post.castShadow = true; g.add(post);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, H - 0.3, 10), dM);
      pad.position.set(x0, H / 2 + 0.05, z0); g.add(pad);
      // panel
      const len = Math.hypot(x1 - x0, z1 - z0);
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(len, H - 0.25), fM);
      panel.position.set((x0 + x1) / 2, (H - 0.25) / 2 + 0.05, (z0 + z1) / 2);
      panel.lookAt(0, (H - 0.25) / 2 + 0.05, 0);
      g.add(panel);
      // top rail padding + bottom rail
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.14, 0.14), dM);
      rail.position.set((x0 + x1) / 2, H - 0.02, (z0 + z1) / 2); rail.lookAt(0, H - 0.02, 0); g.add(rail);
      const rail2 = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.08), aM);
      rail2.position.set((x0 + x1) / 2, H + 0.07, (z0 + z1) / 2); rail2.lookAt(0, H + 0.07, 0); g.add(rail2);
      const base = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.1), padMat);
      base.position.set((x0 + x1) / 2, 0.06, (z0 + z1) / 2); base.lookAt(0, 0.06, 0); g.add(base);
      const am = (a0 + a1) / 2;
      segments.push({ dir: [Math.cos(am), Math.sin(am)], postDir: [Math.cos(a0), Math.sin(a0)], mats: [fM, dM, aM], postMats: [pM, dM], meshes: [post, pad, panel, rail, rail2] });
    }
    g.userData.segments = segments;
    const legacy = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshStandardMaterial({ color: 0x08080b, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.7; floor.receiveShadow = true; legacy.add(floor);
    const crowdGeo = new THREE.BoxGeometry(0.5, 1.0, 0.5);
    const crowdMat = new THREE.MeshStandardMaterial({ color: 0x3a3a48, roughness: 1 });
    const count = 900;
    const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, count);
    const m = new THREE.Matrix4(), col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const ring = Math.floor(i / 150), ang = (i % 150) / 150 * Math.PI * 2 + ring * 0.02;
      const rad = 8.5 + ring * 1.6 + Math.random() * 0.5;
      const y = -0.7 + ring * 0.55 + 0.5 + Math.random() * 0.1;
      m.makeRotationY(-ang + Math.PI / 2); m.setPosition(Math.cos(ang) * rad, y, Math.sin(ang) * rad);
      crowd.setMatrixAt(i, m);
      col.setHSL(Math.random(), 0.35, 0.18 + Math.random() * 0.15); crowd.setColorAt(i, col);
    }
    crowd.instanceMatrix.needsUpdate = true;
    legacy.add(crowd);
    for (let r = 0; r < 6; r++) {
      const tier = new THREE.Mesh(new THREE.CylinderGeometry(8 + r * 1.6 + 1.2, 8 + r * 1.6 + 1.2, 0.55, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x101016, roughness: 1, side: THREE.DoubleSide }));
      tier.position.y = -0.7 + r * 0.55 + 0.27; legacy.add(tier);
    }
    g.add(legacy);
    g.userData.legacy = legacy;
    scene.add(g);
    return g;
  }

  // ---------- renderer ----------
  class Renderer {
    constructor(canvas, audio) {
      this.canvas = canvas;
      // Alpha stays on so a color void can show through the fence. Legacy paints an opaque arena instead.
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.scene = new THREE.Scene();
      this.blood = new BloodField(this.scene);
      this.stain = false;
      this.tracer = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 1), new THREE.MeshBasicMaterial({ color: 0xffe28a }));
      this.tracer.visible = false;
      this.tracer.frustumCulled = false;
      this.scene.add(this.tracer);
      this.spark = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff1c4 }));
      this.spark.visible = false;
      this.scene.add(this.spark);
      this._line = null;
      this.legacy = true;
      this._legacyColor = new THREE.Color(0x07070a);
      this._legacyFog = new THREE.Fog(0x07070a, 18, 42);
      this.musicBg = root.MMAMusicBg ? new root.MMAMusicBg.MusicBackground(audio) : null;
      this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 100);
      this.camera.position.set(0, 2.2, 7.5);
      this.camTarget = new THREE.Vector3(0, 1, 0);
      this.camPos = new THREE.Vector3(0, 2.2, 7.5);
      this.camSide = new THREE.Vector3(0, 0, 1);
      this.shake = 0;

      // lights
      const hemi = new THREE.HemisphereLight(0x8899bb, 0x201a14, 0.55); this.scene.add(hemi);
      const key = new THREE.SpotLight(0xfff2dd, 1.6, 40, 0.55, 0.5, 1.2);
      key.position.set(4, 9, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0005; key.shadow.radius = 3;
      key.target.position.set(0, 0, 0); this.scene.add(key); this.scene.add(key.target);
      const fill = new THREE.SpotLight(0xa9c4ff, 0.8, 40, 0.6, 0.5, 1.2);
      fill.position.set(-6, 8, -3); fill.castShadow = true; fill.shadow.mapSize.set(1024, 1024); fill.shadow.bias = -0.0005;
      this.scene.add(fill); this.scene.add(fill.target);
      const rim = new THREE.PointLight(0xff8844, 0.6, 25); rim.position.set(0, 4, -8); this.scene.add(rim);
      const rim2 = new THREE.PointLight(0x4488ff, 0.5, 25); rim2.position.set(0, 4, 8); this.scene.add(rim2);
      // overhead rig glow
      const rig = new THREE.Mesh(new THREE.TorusGeometry(5.2, 0.12, 8, 48), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xfff0d0, emissiveIntensity: 0.9 }));
      rig.rotation.x = Math.PI / 2; rig.position.y = 7.5; this.scene.add(rig);
      this.arenaLights = [hemi, key, fill, rim, rim2, rig];

      this.arena = buildArena(this.scene);
      this.models = [];
      this.groundAxis = new THREE.Vector3(1, 0, 0);
      this.lastGround = false;
      this.fx = [];
      this.time = 0;
      this._tmp = new THREE.Vector3();
      this.setBackdrop(this.musicBg ? this.musicBg.presetId : 'legacy');
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }

    setBackdrop(id) {
      const legacy = !id || id === 'legacy';
      this.legacy = legacy;
      if (this.arena && this.arena.userData.legacy) this.arena.userData.legacy.visible = legacy;
      this.scene.background = legacy ? this._legacyColor : null;
      this.scene.fog = legacy ? this._legacyFog : null;
      this.renderer.setClearColor(legacy ? 0x07070a : 0x000000, legacy ? 1 : 0);
      if (this.musicBg) this.musicBg.setPreset(legacy ? 'legacy' : id);
    }

    resize() {
      const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.renderer.setClearColor(this.legacy ? 0x07070a : 0x000000, this.legacy ? 1 : 0);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }

    // the career gym (js/gym.js) borrows the scene: hide the cage, crowd and arena lighting while it is up
    setArenaVisible(v) {
      this.arena.visible = v;
      for (const l of this.arenaLights) l.visible = v;
    }

    setFighters(S) {
      for (const m of this.models) m.dispose();
      this.models = S.f.map((f, i) => new FighterModel(this.scene, f.color, f.skin, i));
      this.lastGround = false;
      if (this.blood) this.blood.clear();
    }

    setMarks(on) {
      this.stain = !!on;
      if (this.blood) {
        this.blood.on = this.stain;
        if (!this.stain) this.blood.clear();
      }
    }

    showPop(i, from, to) {
      const m = this.models[i];
      if (!m || !m.pop) return;
      if (m.prop) m.prop.visible = false;
      if (m.pop) m.pop.visible = true;
      if (!from || !to) return;
      m.segs.lForearm.updateMatrixWorld(true);
      const origin = from ? new THREE.Vector3(from[0], from[1], from[2]) : m.pop.localToWorld(new THREE.Vector3(0, 0.02, -0.42));
      const end = to ? new THREE.Vector3(to[0], to[1], to[2]) : origin.clone().add(new THREE.Vector3(0, 0, 1));
      this._line = { from: origin, to: end, t: 0, dur: 0.18 };
      this.spark.position.copy(origin);
      this.spark.visible = true;
    }

    impact(pos, big, color) {
      const geo = new THREE.SphereGeometry(big ? 0.22 : 0.13, 10, 8);
      const mat = new THREE.MeshBasicMaterial({ color: color || 0xffe9b0, transparent: true, opacity: 0.9 });
      const m = new THREE.Mesh(geo, mat); m.position.copy(pos); this.scene.add(m);
      this.fx.push({ m, t: 0, dur: big ? 0.35 : 0.22 });
      if (big) this.shake = Math.min(1, this.shake + 0.6);
    }

    // Project a contact into the void and let the background particles take the hit.
    _voidImpact(pos, power) {
      if (!this.musicBg || this.legacy || !this.musicBg.impactOn || !pos) return;
      const proj = pos.clone().project(this.camera);
      if (proj.z > 1) return;
      this.musicBg.punch((proj.x * 0.5 + 0.5) * this.musicBg.w, (-proj.y * 0.5 + 0.5) * this.musicBg.h, power);
    }

    handleEvent(ev) {
      if (!this.models.length) return;
      if (ev.k === 'hit') {
        const victim = this.models[ev.j];
        const p = ev.at ? new THREE.Vector3(ev.at[0], ev.at[1], ev.at[2])
          : ev.part === 'head' ? victim.headWorld(this._tmp.clone()) : ev.part === 'legs' ? new THREE.Vector3(victim.px, 0.5, victim.pz) : victim.torsoWorld(this._tmp.clone());
        this.impact(p, ev.big || ev.rocked, ev.edge ? 0xf4f7ff : ev.rocked ? 0xff5533 : ev.jammed ? 0xaaaaaa : ev.momentum ? 0xffb347 : 0xffe9b0);
        victim.flash = ev.rocked ? 1 : 0.5;
        if (ev.pop && this.blood) this.blood.explode(p);
        else if (this.stain && this.blood && (ev.big || ev.rocked)) {
          const power = Math.max(0.45, Math.min(1.35, (ev.dmg || 4) / 7));
          this.blood.burst(p, power);
        }
        let power = clamp((ev.dmg || (ev.big ? 4 : 1.6)) / 7.5, 0.28, 1);
        if (ev.rocked) power = Math.max(power, 0.92);
        else if (ev.big) power = Math.max(power, 0.62);
        if (ev.jammed) power *= 0.4;
        this._voidImpact(p, power);
      } else if (ev.k === 'line') {
        this.showPop(ev.i, ev.from, ev.to);
      } else if (ev.k === 'block') {
        const victim = this.models[ev.j];
        const p = ev.at ? new THREE.Vector3(ev.at[0], ev.at[1], ev.at[2]) : victim.headWorld(this._tmp.clone()).add(new THREE.Vector3(0, -0.1, 0));
        this.impact(p, !!ev.parry, ev.parry ? 0xf0d060 : 0x88aaff);
        this._voidImpact(p, 0.22);
      } else if (ev.k === 'kd' || ev.k === 'td' || ev.k === 'sweep') {
        this.shake = 1;
        const victim = this.models[ev.j != null ? ev.j : 0];
        if (victim) this._voidImpact(new THREE.Vector3(victim.px, 0.8, victim.pz), 1);
      } else if (ev.k === 'ko' || ev.k === 'tap') {
        this.shake = 1.2;
        const who = ev.j != null ? ev.j : ev.i;
        const victim = this.models[who != null ? who : 0];
        if (victim) this._voidImpact(new THREE.Vector3(victim.px, 1.1, victim.pz), 1);
      }
    }

    update(S, dt, inputs) {
      if (this.musicBg) this.musicBg.step();
      this.time += dt;
      if (this.blood) this.blood.step(dt);
      if (this._line) {
        this._line.t += dt;
        const u = this._line.t / this._line.dur;
        if (u >= 1) { this.tracer.visible = false; this.spark.visible = false; this._line = null; }
        else {
          const a = this._line.from, b = this._line.to;
          this.tracer.visible = true;
          this.tracer.position.copy(a).lerp(b, 0.5);
          this.tracer.lookAt(b);
          this.tracer.scale.set(1, 1, Math.max(0.2, a.distanceTo(b)));
          this.spark.visible = u < 0.4;
        }
      }
      if (!this.models.length) return;
      const F = S.f;
      // ground axis: freeze the facing when ground fight starts
      if (S.ground && !this.lastGround) {
        const top = F[S.ground.top], bot = F[S.ground.bottom];
        const mt = this.models[top.idx];
        // axis = direction from the top's side towards the bottom's feet (i.e. top keeps facing)
        this.groundAxis.set(Math.sin(mt.yaw), 0, Math.cos(mt.yaw)).normalize();
      }
      this.lastGround = !!S.ground;
      for (let i = 0; i < 2; i++) {
        this.models[i].inputHint = inputs ? inputs[i] : 0;
        this.models[i].update(F[i], S, F[1 - i], dt, this.time, this.groundAxis, this.posLerp);
        this.models[i].carry(F[i]);
      }

      // fx
      for (let i = this.fx.length - 1; i >= 0; i--) {
        const e = this.fx[i]; e.t += dt;
        const u = e.t / e.dur;
        if (u >= 1) { this.scene.remove(e.m); e.m.geometry.dispose(); e.m.material.dispose(); this.fx.splice(i, 1); continue; }
        e.m.scale.setScalar(1 + u * 2.5); e.m.material.opacity = 0.9 * (1 - u);
      }

      // camera
      const m0 = this.models[0], m1 = this.models[1];
      const mx = (m0.px + m1.px) / 2, mz = (m0.pz + m1.pz) / 2;
      const dx = m1.px - m0.px, dz = m1.pz - m0.pz;
      const dist = Math.hypot(dx, dz);
      let sx, sz;
      if (dist > 0.3 && !S.ground) { sx = -dz / dist; sz = dx / dist; } else { sx = this.camSide.x; sz = this.camSide.z; }
      // keep camera on the same side (avoid flipping)
      if (sx * this.camSide.x + sz * this.camSide.z < 0) { sx = -sx; sz = -sz; }
      this.camSide.x += (sx - this.camSide.x) * expo(dt, 3); this.camSide.z += (sz - this.camSide.z) * expo(dt, 3); this.camSide.normalize();
      const ground = !!S.ground;
      const want = ground ? 4.8 : clamp(4.4 + dist * 1.1, 4.8, 7.6);
      const height = ground ? 3.1 : 2.55 + dist * 0.15;
      const tx = mx + this.camSide.x * want, tz = mz + this.camSide.z * want;
      this.camPos.x += (tx - this.camPos.x) * expo(dt, 4); this.camPos.z += (tz - this.camPos.z) * expo(dt, 4); this.camPos.y += (height - this.camPos.y) * expo(dt, 4);
      this.camTarget.x += (mx - this.camTarget.x) * expo(dt, 5); this.camTarget.z += (mz - this.camTarget.z) * expo(dt, 5);
      this.camTarget.y += ((ground ? 0.45 : 0.95) - this.camTarget.y) * expo(dt, 4);
      // fade the cage segments that sit between the camera and the action
      const cl = Math.hypot(this.camPos.x, this.camPos.z) || 1, cx = this.camPos.x / cl, cz = this.camPos.z / cl;
      const outside = cl > 3.6;
      for (const seg of this.arena.userData.segments) {
        const d = seg.dir[0] * cx + seg.dir[1] * cz;
        const near = outside || cl > 2.2;
        const o = near ? (d > 0.92 ? 0.08 : d > 0.55 ? 0.08 + (0.92 - d) / 0.37 * 0.92 : 1) : 1;
        for (const m of seg.mats) { m.opacity += (o - m.opacity) * expo(dt, 8); }
        const dp = seg.postDir[0] * cx + seg.postDir[1] * cz;
        const op = (near && dp > 0.6) ? 0.1 : 1;
        for (const m of seg.postMats) { if (m !== seg.mats[1]) m.opacity += (op - m.opacity) * expo(dt, 8); }
        for (const mesh of seg.meshes) mesh.castShadow = mesh.material.opacity > 0.5;
      }
      this.camera.position.copy(this.camPos);
      if (this.shake > 0) {
        this.camera.position.x += (Math.random() - 0.5) * 0.08 * this.shake;
        this.camera.position.y += (Math.random() - 0.5) * 0.08 * this.shake;
        this.shake = Math.max(0, this.shake - dt * 3);
      }
      this.camera.lookAt(this.camTarget);
      this.renderer.render(this.scene, this.camera);
    }
  }

  root.MMARender = { Renderer, FighterModel, POSES };
})(typeof window !== 'undefined' ? window : globalThis);
