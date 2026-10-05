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
  const THIGH = 0.47, SHIN = 0.45, UPPER = 0.3, FORE = 0.28;
  const HIP_H = 0.86, SHOULDER_Y = 0.5, SHOULDER_X = 0.23, HIP_X = 0.12;

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
    block: P({ lh: [-0.1, 0.62, 0.26], rh: [0.1, 0.6, 0.24], h: HIP_H - 0.05, lean: 0.18, hp: 0.25 }),
    dodge: P({ lean: -0.42, h: HIP_H - 0.08, oz: -0.18, lh: [-0.14, 0.5, 0.3], rh: [0.16, 0.48, 0.22], hp: -0.2 }),
    hitHead: P({ lean: -0.3, hp: -0.55, hy: 0.4, lh: [-0.2, 0.3, 0.25], rh: [0.22, 0.25, 0.1], h: HIP_H - 0.03 }),
    hitBody: P({ lean: 0.5, h: HIP_H - 0.14, hp: 0.4, lh: [-0.1, 0.1, 0.3], rh: [0.15, 0.05, 0.25] }),
    hitLegs: P({ lean: 0.25, h: HIP_H - 0.2, roll: 0.25, lh: [-0.14, 0.3, 0.3], rh: [0.3, 0.2, 0.1] }),
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
    // bottom in closed guard: on the back, legs wrapped high around the top's waist
    bottomGuard: P({ lie: -Math.PI / 2, h: 0.22, lean: 0.3, yaw: 0, lh: [-0.18, 0.45, 0.35], rh: [0.18, 0.42, 0.33], lf: [-0.3, 0.42], rf: [0.3, 0.42], lfy: -0.05, rfy: -0.05, hp: 0.4, hy: 0 }),
    // half guard: one leg hooked, the other flat
    bottomHalf: P({ lie: -Math.PI / 2, h: 0.2, lean: 0.25, yaw: 0.15, lh: [-0.18, 0.45, 0.35], rh: [0.18, 0.42, 0.33], lf: [-0.28, 0.3], rf: [0.22, -0.2], lfy: -0.15, rfy: -0.5, hp: 0.4, hy: 0 }),
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
    overhand: [P({ yaw: 0.55, lean: -0.05, lh: [-0.14, 0.44, 0.3], rh: [0.38, 0.62, -0.12], elbowOut: 1.0, elbowUp: 1.0 }),
               P({ yaw: -0.6, lean: 0.42, roll: -0.25, lh: [-0.24, 0.4, 0.25], rh: [-0.1, 0.45, 0.8], oz: 0.14, hp: 0.25, elbowOut: 0.8, elbowUp: 0.5 })],
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
  function limb(len, r, mat, r2) {
    const g = new THREE.Group();
    const geo = new THREE.CylinderGeometry(r2 || r * 0.8, r, len, 10, 1);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = -len / 2; m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat); cap.castShadow = true; g.add(cap);
    return g;
  }

  class FighterModel {
    constructor(scene, color, skin, idx) {
      this.idx = idx;
      const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.75, metalness: 0.0 });
      const shortsMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
      const gloveMat = new THREE.MeshStandardMaterial({ color: idx === 0 ? 0xc62828 : 0x1e5bd6, roughness: 0.5 });
      const hairMat = new THREE.MeshStandardMaterial({ color: 0x1a120c, roughness: 0.9 });
      // separate skin materials per damage region so bruising can be shown where the damage is
      const headMat = skinMat.clone(), bodyMat = skinMat.clone(), legMat = skinMat.clone();
      this.mats = { skinMat, shortsMat, gloveMat, headMat, bodyMat, legMat };
      this.skinBase = new THREE.Color(skin);

      this.root = new THREE.Group();
      this.body = new THREE.Group(); this.root.add(this.body);           // hips; y = hip height
      this.torso = new THREE.Group(); this.body.add(this.torso);         // pitch / yaw
      // pelvis + shorts
      const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.26, 0.24), shortsMat); pelvis.position.y = 0.0; pelvis.castShadow = true; this.torso.add(pelvis);
      const abs = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.22, 12), bodyMat); abs.position.y = 0.22; abs.castShadow = true; this.torso.add(abs);
      const chest = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.3, 0.27), bodyMat); chest.position.y = 0.42; chest.castShadow = true; this.torso.add(chest);
      const trap = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.22, 0.1, 10), skinMat); trap.position.y = 0.6; this.torso.add(trap);
      // head
      this.neck = new THREE.Group(); this.neck.position.y = 0.62; this.torso.add(this.neck);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 16, 14), headMat); head.position.y = 0.13; head.castShadow = true; this.neck.add(head);
      // blood: a cut over the eye, a bloody nose/mouth, and a smear on the chest (shown as damage climbs)
      const bloodMat = new THREE.MeshStandardMaterial({ color: 0x8a0f12, roughness: 0.35, transparent: true, opacity: 0 });
      this.bloodMat = bloodMat;
      const cut = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.018, 0.02), bloodMat); cut.position.set(0.05, 0.18, 0.105); cut.rotation.z = 0.3; this.neck.add(cut);
      const nose = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.06, 0.02), bloodMat); nose.position.set(0, 0.09, 0.118); this.neck.add(nose);
      const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), bloodMat); cheek.position.set(-0.07, 0.12, 0.085); cheek.scale.set(1, 1.3, 0.5); this.neck.add(cheek);
      const smear = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.22, 0.01), bloodMat); smear.position.set(0.02, 0.4, 0.14); this.torso.add(smear);
      this.blood = { cut, nose, cheek, smear };
      const hair = new THREE.Mesh(new THREE.SphereGeometry(0.128, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), hairMat); hair.position.y = 0.15; hair.scale.set(1, 0.8, 1); this.neck.add(hair);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.04), hairMat); brow.position.set(0, 0.17, 0.115); this.neck.add(brow);
      this.head = head;
      // arms
      const shoulderPad = (sx) => { const s = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), skinMat); s.position.set(sx, SHOULDER_Y, 0); s.castShadow = true; this.torso.add(s); };
      shoulderPad(-SHOULDER_X); shoulderPad(SHOULDER_X);
      this.lSh = new THREE.Group(); this.lSh.position.set(-SHOULDER_X, SHOULDER_Y, 0); this.torso.add(this.lSh);
      this.rSh = new THREE.Group(); this.rSh.position.set(SHOULDER_X, SHOULDER_Y, 0); this.torso.add(this.rSh);
      const lUp = limb(UPPER, 0.062, skinMat, 0.055); this.lSh.add(lUp);
      const rUp = limb(UPPER, 0.062, skinMat, 0.055); this.rSh.add(rUp);
      this.lEl = new THREE.Group(); this.lEl.position.y = -UPPER; lUp.add(this.lEl);
      this.rEl = new THREE.Group(); this.rEl.position.y = -UPPER; rUp.add(this.rEl);
      const lFo = limb(FORE, 0.052, skinMat, 0.048); this.lEl.add(lFo);
      const rFo = limb(FORE, 0.052, skinMat, 0.048); this.rEl.add(rFo);
      const glove = () => { const g = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), gloveMat); g.position.y = -FORE - 0.02; g.scale.set(1, 0.9, 1.15); g.castShadow = true; return g; };
      this.lGlove = glove(); lFo.add(this.lGlove); this.rGlove = glove(); rFo.add(this.rGlove);
      // legs
      this.lHip = new THREE.Group(); this.lHip.position.set(-HIP_X, -0.08, 0); this.body.add(this.lHip);
      this.rHip = new THREE.Group(); this.rHip.position.set(HIP_X, -0.08, 0); this.body.add(this.rHip);
      const lTh = limb(THIGH, 0.095, shortsMat, 0.075); this.lHip.add(lTh);
      const rTh = limb(THIGH, 0.095, shortsMat, 0.075); this.rHip.add(rTh);
      // skin lower thigh
      const lThSkin = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.078, THIGH * 0.45, 10), legMat); lThSkin.position.y = -THIGH * 0.75; lTh.add(lThSkin);
      const rThSkin = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.078, THIGH * 0.45, 10), legMat); rThSkin.position.y = -THIGH * 0.75; rTh.add(rThSkin);
      this.lKn = new THREE.Group(); this.lKn.position.y = -THIGH; lTh.add(this.lKn);
      this.rKn = new THREE.Group(); this.rKn.position.y = -THIGH; rTh.add(this.rKn);
      const lSh = limb(SHIN, 0.065, legMat, 0.05); this.lKn.add(lSh);
      const rSh = limb(SHIN, 0.065, legMat, 0.05); this.rKn.add(rSh);
      const foot = () => { const f = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.24), skinMat); f.position.set(0, -SHIN - 0.02, 0.06); f.castShadow = true; return f; };
      lSh.add(foot()); rSh.add(foot());

      // shadow blob
      const blob = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.012; this.root.add(blob);
      this.blob = blob;

      scene.add(this.root);
      this.pose = copyPose(POSES.idle);
      this.px = 0; this.pz = 0; this.yaw = 0; this.initialized = false;
      this.flash = 0; this.stepPhase = 0;
      this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      this._pole = new THREE.Vector3();
      this._tipV = new THREE.Vector3();
      this._dmgC = new THREE.Color(); this._red = new THREE.Color(0.75, 0.25, 0.22); this._bruise = new THREE.Color(0.38, 0.22, 0.42);
      this._eul = new THREE.Euler(); this._qHip = new THREE.Quaternion(); this._yAxis = new THREE.Vector3(0, 1, 0);
      this._tipArr = [0, 0, 0];
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
        if (a.type === 'sub') pose = POSES.bottomSub;
        else if (a.type === 'hit') pose = pos === 'back' ? POSES.turtle : POSES.bottomHit;
        else if (a.type === 'caught') pose = POSES.bottomHit;
        else if (a.type === 'trans') return lerpPose(base, pos === 'back' ? POSES.bottomHalf : POSES.bottomHit, 0.35 + 0.25 * Math.sin(a.t * 14), out);
        else if ((this.inputHint & IN.BLOCK) && pos !== 'back') return lerpPose(base, POSES.bottomBlock, 0.6, out);
        else pose = base;
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
          case 'stumble': pose = POSES.stumble; break;
          case 'sprawl': pose = POSES.sprawl; break;
          case 'takedown': {
            const u = clamp(a.t / 0.32, 0, 1);
            if (!a.hit) return lerpPose(POSES.tdWind, POSES.tdShoot, smooth(u), out);
            return lerpPose(POSES.tdShoot, POSES.stumble, smooth(clamp((a.t - 0.32) / 0.4, 0, 1)), out);
          }
          case 'celebrate': pose = POSES.celebrate; break;
          default: pose = f.blocking ? POSES.block : POSES.idle;
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
        const sx = (st.limb === 'lh' ? -SHOULDER_X : SHOULDER_X) + p.ox, sy = p.h + SHOULDER_Y, sz = p.oz + 0.05;
        const over = Math.hypot(lx - sx, ly - sy, lz - sz) - (UPPER + FORE + 0.07);
        if (over > 0) { p.oz += Math.min(0.32, over); p.lean += Math.min(0.25, over * 0.6); }
      } else {
        const hx0 = st.limb === 'll' ? -HIP_X : HIP_X;
        const hx = hx0 * Math.cos(p.hipYaw) + p.ox, hy = p.h - 0.08, hz = -hx0 * Math.sin(p.hipYaw) + p.oz;
        const reach = st.tip === 'knee' ? THIGH : THIGH + SHIN;
        const over = Math.hypot(lx - hx, ly - hy, lz - hz) - (reach + 0.02);
        if (over > 0) { p.oz += Math.min(0.28, over * 0.9); if (st.tip !== 'knee') p.h -= Math.min(0.06, over * 0.2); }
      }
      return { st, lx, ly, lz, hand };
    }

    update(f, S, opp, dt, time, groundAxis, posLerp) {
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
      const vx = (tx - this.px), vz = (tz - this.pz);
      const moving = f.act.type === 'move' && !f.ground;

      // ---- pose ----
      const target = this.targetPose(f, S, this._tp);
      this._tp = target;
      const speed = (f.act.type === 'strike' || f.act.type === 'hit' || f.act.type === 'dodge') ? 26 : 12;
      lerpPose(this.pose, target, expo(dt, speed), this.pose);
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
          if (ov.st.tip === 'knee') { fxz[0] = ov.lx; fxz[1] = ov.lz - 0.22; if (left) p.lfy = ov.ly - SHIN * 0.85; else p.rfy = ov.ly - SHIN * 0.85; }
          else { fxz[0] = ov.lx; fxz[1] = ov.lz; if (left) p.lfy = ov.ly; else p.rfy = ov.ly; }
          const kxz = left ? this.pose.lf : this.pose.rf; kxz[0] = fxz[0]; kxz[1] = fxz[1];
          if (left) this.pose.lfy = p.lfy; else this.pose.rfy = p.rfy;
        }
      }

      // ---- IK arms (torso frame) ----
      const v = this._v;
      v[0].set(-SHOULDER_X, SHOULDER_Y, 0); v[1].fromArray(p.lh);
      this._pole.set(-1, -0.4 - p.elbowOut * 0.3 + p.elbowUp, -0.6); // elbows down/out/back (raised for hooks)
      solveIK(v[0], v[1], UPPER, FORE, this._pole, this.lSh, this.lEl);
      v[0].set(SHOULDER_X, SHOULDER_Y, 0); v[1].fromArray(p.rh);
      this._pole.set(1, -0.4 - p.elbowOut * 0.3 + p.elbowUp, -0.6);
      solveIK(v[0], v[1], UPPER, FORE, this._pole, this.rSh, this.rEl);

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
        v[0].set(-HIP_X, -0.08, 0); this._pole.fromArray(p.lPole); solveIK(v[0], v[1], THIGH, SHIN, this._pole, this.lHip, this.lKn);
        toBody(rfx - p.ox, rfz - p.oz, v[1]); v[1].y = rfy - (p.h + bob) + 0.05;
        v[0].set(HIP_X, -0.08, 0); this._pole.fromArray(p.rPole); solveIK(v[0], v[1], THIGH, SHIN, this._pole, this.rHip, this.rKn);
      } else {
        // lying on back: body frame rotated; targets given directly in body frame
        v[0].set(-HIP_X, -0.08, 0); v[1].set(p.lf[0], p.lfy, p.lf[1]);
        this._pole.set(0, 0.3, 1); solveIK(v[0], v[1], THIGH, SHIN, this._pole, this.lHip, this.lKn);
        v[0].set(HIP_X, -0.08, 0); v[1].set(p.rf[0], p.rfy, p.rf[1]);
        this._pole.set(0, 0.3, 1); solveIK(v[0], v[1], THIGH, SHIN, this._pole, this.rHip, this.rKn);
      }
      this.blob.material.opacity = p.lie < -0.5 ? 0.15 : 0.35;

      // hit flash + accumulated damage on the skin
      if (this.flash > 0) { this.flash -= dt * 4; }
      this.updateDamage(f);
    }

    headWorld(out) { return this.head.getWorldPosition(out); }
    torsoWorld(out) { return this.torso.getWorldPosition(out).add(new THREE.Vector3(0, 0.35, 0)); }
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
    // arena floor + crowd
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshStandardMaterial({ color: 0x08080b, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.7; floor.receiveShadow = true; g.add(floor);
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
    g.add(crowd);
    // seating tiers
    for (let r = 0; r < 6; r++) {
      const tier = new THREE.Mesh(new THREE.CylinderGeometry(8 + r * 1.6 + 1.2, 8 + r * 1.6 + 1.2, 0.55, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x101016, roughness: 1, side: THREE.DoubleSide }));
      tier.position.y = -0.7 + r * 0.55 + 0.27; g.add(tier);
    }
    scene.add(g);
    return g;
  }

  // ---------- renderer ----------
  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x07070a);
      this.scene.fog = new THREE.Fog(0x07070a, 18, 42);
      this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 100);
      this.camera.position.set(0, 2.2, 7.5);
      this.camTarget = new THREE.Vector3(0, 1, 0);
      this.camPos = new THREE.Vector3(0, 2.2, 7.5);
      this.camSide = new THREE.Vector3(0, 0, 1);
      this.shake = 0;

      // lights
      this.scene.add(new THREE.HemisphereLight(0x8899bb, 0x201a14, 0.55));
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

      this.arena = buildArena(this.scene);
      this.models = [];
      this.groundAxis = new THREE.Vector3(1, 0, 0);
      this.lastGround = false;
      this.fx = [];
      this.time = 0;
      this._tmp = new THREE.Vector3();
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }

    resize() {
      const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }

    setFighters(S) {
      for (const m of this.models) this.scene.remove(m.root);
      this.models = S.f.map((f, i) => new FighterModel(this.scene, f.color, f.skin, i));
      this.lastGround = false;
    }

    // visual effect: impact burst
    impact(pos, big, color) {
      const geo = new THREE.SphereGeometry(big ? 0.22 : 0.13, 10, 8);
      const mat = new THREE.MeshBasicMaterial({ color: color || 0xffe9b0, transparent: true, opacity: 0.9 });
      const m = new THREE.Mesh(geo, mat); m.position.copy(pos); this.scene.add(m);
      this.fx.push({ m, t: 0, dur: big ? 0.35 : 0.22 });
      if (big) this.shake = Math.min(1, this.shake + 0.6);
    }

    handleEvent(ev, S) {
      if (!this.models.length) return;
      if (ev.k === 'hit') {
        const victim = this.models[ev.j];
        const p = ev.at ? new THREE.Vector3(ev.at[0], ev.at[1], ev.at[2])
          : ev.part === 'head' ? victim.headWorld(this._tmp.clone()) : ev.part === 'legs' ? new THREE.Vector3(victim.px, 0.5, victim.pz) : victim.torsoWorld(this._tmp.clone());
        this.impact(p, ev.big || ev.rocked, ev.rocked ? 0xff5533 : ev.jammed ? 0xaaaaaa : ev.momentum ? 0xffb347 : 0xffe9b0);
        victim.flash = ev.rocked ? 1 : 0.5;
      } else if (ev.k === 'block') {
        const victim = this.models[ev.j];
        this.impact(ev.at ? new THREE.Vector3(ev.at[0], ev.at[1], ev.at[2]) : victim.headWorld(this._tmp.clone()).add(new THREE.Vector3(0, -0.1, 0)), false, 0x88aaff);
      } else if (ev.k === 'kd' || ev.k === 'td' || ev.k === 'sweep') this.shake = 1;
      else if (ev.k === 'ko' || ev.k === 'tap') this.shake = 1.2;
    }

    update(S, dt, inputs) {
      this.time += dt;
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
      for (let i = 0; i < 2; i++) { this.models[i].inputHint = inputs ? inputs[i] : 0; this.models[i].update(F[i], S, F[1 - i], dt, this.time, this.groundAxis, this.posLerp); }

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
      // don't let camera go through the far crowd: clamp radius
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
