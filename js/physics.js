/* ============================================================
   CAGE RULES — MMAPhys: active-ragdoll physics for the standing game
   Ported from the MMAPhysics prototype (Rapier). No DOM, no Three.js,
   so the same file runs in the browser and in Node (tools/headless.js).

   Both fighters are active ragdolls: eleven rigid bodies joined by
   ball joints whose motors drive every limb toward a target pose
   (stance / guard / strike keyframes). Nothing is animated directly:
   a punch is a real rigid body thrown at the opponent, so a strike
   only scores when its fist or shin actually arrives with speed,
   square to the target. A guard works because the forearms are
   physically in the way.

   ---- TUNING (the knobs you will want first) ----
   DMG_SCALE   overall damage from a clean impact (fights should go rounds)
   VMIN        impact speed (m/s along the contact normal) below which a touch is just a touch
   PART_MULT   where a strike hurts (arms absorb; hits on a guarding
               opponent's arms are blocks)
   STRIKES     keyframes, damage windows, costs, speeds (see poses below)
   ============================================================ */
(function (root) {
  'use strict';

  let R = null; // RAPIER module, supplied by init()

  // ---------------------------------------------------------------- tuning
  const PHYS_DT = 1 / 240;
  const SUBSTEPS = 4;                 // physics substeps per 60 Hz sim tick
  const DMG_SCALE = 0.26;             // clean cross at ~7 m/s ≈ 3.5 head damage (100 = KO)
  const DMG_CAP = 11;                 // hardest single shot possible
  const VMIN = 2.2;                   // m/s along the contact normal
  const MIN_CLEAN = 0.35;             // vn / |v_rel| below this is a glancing blow
  const ZETA = 1.0;                   // damping ratio of every joint controller
  const HOVER_HEIGHT = 1.08; // hip height in stance (legs are human-proportioned: a head kick must be reachable)
  const HOVER_FRACTION = 0.7;
  const ROOT_INERTIA = 3.0;
  const MOVE_SPEED = 1.9;
  const CAGE_APOTHEM = 4.3;           // physics fence (visual posts sit at r = 4.75)
  const PART_MULT = { head: 1.6, chest: 1.0, pelvis: 0.8, upperArm: 0.35, forearm: 0.3, fist: 0.25, thigh: 0.55, shin: 0.3, foot: 0.2 };
  const KICK_PART_MULT = { thigh: 1.0, shin: 0.5, pelvis: 1.0 };
  const BLOCK_MULT = 0.15;            // hit on the arms while actively guarding
  const ARM_MULT = 0.45;              // hit on the arms while not guarding (shoulder roll, stray glove)
  const CHECK_MULT = 0.45;            // low kick into a raised / braced shin while guarding
  const REGION = { head: 'head', chest: 'body', pelvis: 'body', upperArm: 'arm', forearm: 'arm', fist: 'arm', thigh: 'legs', shin: 'legs', foot: 'legs' };

  // ---------------------------------------------------------------- math (no THREE)
  const DEG = Math.PI / 180;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const smooth = (s) => s * s * (3 - 2 * s);
  const Q = (x, y, z, w) => ({ x, y, z, w });
  const V = (x, y, z) => ({ x, y, z });
  function qMul(a, b) {
    return Q(a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
             a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
             a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
             a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z);
  }
  const qConj = (q) => Q(-q.x, -q.y, -q.z, q.w);
  function qNorm(q) { const l = Math.hypot(q.x, q.y, q.z, q.w) || 1; return Q(q.x / l, q.y / l, q.z / l, q.w / l); }
  function qYaw(yaw) { return Q(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)); }
  // THREE.Euler order 'XYZ', degrees
  function qEuler(e) {
    const x = e[0] * DEG / 2, y = e[1] * DEG / 2, z = e[2] * DEG / 2;
    const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
    return Q(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
  }
  function qRot(q, v) {
    const ix = q.w * v.x + q.y * v.z - q.z * v.y, iy = q.w * v.y + q.z * v.x - q.x * v.z, iz = q.w * v.z + q.x * v.y - q.y * v.x, iw = -q.x * v.x - q.y * v.y - q.z * v.z;
    return V(ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x);
  }
  function qSlerp(a, b, t) {
    let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (cos > 0.9995) return qNorm(Q(a.x + (bx - a.x) * t, a.y + (by - a.y) * t, a.z + (bz - a.z) * t, a.w + (bw - a.w) * t));
    const th = Math.acos(cos), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return Q(a.x * wa + bx * wb, a.y * wa + by * wb, a.z * wa + bz * wb, a.w * wa + bw * wb);
  }
  // quaternion -> rotation vector (axis * angle)
  function qToRotVec(q) {
    let { x, y, z, w } = q;
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    const half = Math.acos(clamp(w, -1, 1)), sh = Math.sin(half);
    const k = sh > 1e-6 ? (2 * half) / sh : 2;
    return [x * k, y * k, z * k];
  }
  // quaternion -> the per-axis "angles" Rapier's spherical joint motors actually measure, which
  // (found empirically, see tools/probe.js history) is 2*asin(q_i) per axis. Feeding the motors these
  // instead of a rotation vector makes them settle on the exact target rotation even for big
  // multi-axis swings (hooks, roundhouse kicks), where a rotation vector drifts by 30-40 degrees.
  function qToMotor(q) {
    let { x, y, z, w } = q;
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    return [2 * Math.asin(clamp(x, -1, 1)), 2 * Math.asin(clamp(y, -1, 1)), 2 * Math.asin(clamp(z, -1, 1))];
  }
  const vAdd = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
  const vSub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
  const vScale = (a, s) => V(a.x * s, a.y * s, a.z * s);
  const vDot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const vLen = (a) => Math.hypot(a.x, a.y, a.z);
  const vCross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

  // ---------------------------------------------------------------- rig
  // shape: ['capsule', halfHeight, radius] | ['ball', r] | ['cuboid', hx, hy, hz]
  // anchorParent / anchorSelf: joint anchor in the parent's / this segment's local frame.
  // w0: natural frequency (rad/s) of the joint motor driving this segment toward its target pose.
  const SEGS = {
    pelvis:    { parent: null,        shape: ['cuboid', 0.16, 0.09, 0.11], mass: 11, w0: 24, part: 'pelvis' },
    chest:     { parent: 'pelvis',    shape: ['cuboid', 0.19, 0.20, 0.12], mass: 20, w0: 48, part: 'chest',
                 anchorParent: [0, 0.12, 0], anchorSelf: [0, -0.22, 0] },
    head:      { parent: 'chest',     shape: ['ball', 0.12], mass: 5, w0: 44, part: 'head',
                 anchorParent: [0, 0.21, 0], anchorSelf: [0, -0.13, 0] },
    lUpperArm: { parent: 'chest',     shape: ['capsule', 0.12, 0.05], mass: 2.5, w0: 52, part: 'upperArm',
                 anchorParent: [-0.23, 0.17, 0], anchorSelf: [0, 0.14, 0] },
    lForearm:  { parent: 'lUpperArm', shape: ['capsule', 0.12, 0.045], mass: 2.0, w0: 60, part: 'forearm',
                 anchorParent: [0, -0.14, 0], anchorSelf: [0, 0.14, 0],
                 extra: { name: 'lFist', shape: ['ball', 0.062], pos: [0, -0.18, 0], mass: 0.5, part: 'fist' } },
    rUpperArm: { parent: 'chest',     shape: ['capsule', 0.12, 0.05], mass: 2.5, w0: 52, part: 'upperArm',
                 anchorParent: [0.23, 0.17, 0], anchorSelf: [0, 0.14, 0] },
    rForearm:  { parent: 'rUpperArm', shape: ['capsule', 0.12, 0.045], mass: 2.0, w0: 60, part: 'forearm',
                 anchorParent: [0, -0.14, 0], anchorSelf: [0, 0.14, 0],
                 extra: { name: 'rFist', shape: ['ball', 0.062], pos: [0, -0.18, 0], mass: 0.5, part: 'fist' } },
    lThigh:    { parent: 'pelvis',    shape: ['capsule', 0.21, 0.075], mass: 8, w0: 42, part: 'thigh',
                 anchorParent: [-0.10, -0.08, 0], anchorSelf: [0, 0.24, 0] },
    lShin:     { parent: 'lThigh',    shape: ['capsule', 0.21, 0.055], mass: 4, w0: 50, part: 'shin',
                 anchorParent: [0, -0.24, 0], anchorSelf: [0, 0.24, 0],
                 extra: { name: 'lFoot', shape: ['cuboid', 0.05, 0.035, 0.11], pos: [0, -0.25, 0.05], mass: 1, part: 'foot' } },
    rThigh:    { parent: 'pelvis',    shape: ['capsule', 0.21, 0.075], mass: 8, w0: 42, part: 'thigh',
                 anchorParent: [0.10, -0.08, 0], anchorSelf: [0, 0.24, 0] },
    rShin:     { parent: 'rThigh',    shape: ['capsule', 0.21, 0.055], mass: 4, w0: 50, part: 'shin',
                 anchorParent: [0, -0.24, 0], anchorSelf: [0, 0.24, 0],
                 extra: { name: 'rFoot', shape: ['cuboid', 0.05, 0.035, 0.11], pos: [0, -0.25, 0.05], mass: 1, part: 'foot' } }
  };
  const SEG_ORDER = ['pelvis', 'chest', 'head', 'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm', 'lThigh', 'lShin', 'rThigh', 'rShin'];
  const JOINTS = SEG_ORDER.slice(1);
  const MIRROR = { lUpperArm: 'rUpperArm', rUpperArm: 'lUpperArm', lForearm: 'rForearm', rForearm: 'lForearm', lThigh: 'rThigh', rThigh: 'lThigh', lShin: 'rShin', rShin: 'lShin', chest: 'chest', head: 'head' };

  // ---------------------------------------------------------------- poses
  // Fighter local frame: +Z = toward the opponent, +Y = up, +X = fighter's right. Every limb hangs
  // straight down at identity. Euler angles are degrees in the parent segment's frame, order XYZ:
  //   rotX negative -> limb swings forward (+Z);  rotZ positive -> toward +X;  rotY -> twist.
  // Torso rotY positive brings the LEFT shoulder forward (orthodox blading).
  const STANCE = { pelvisYaw: 14, chest: [4, 16, 0], head: [8, -14, 0], lUpperArm: [-32, -22, -10], lForearm: [-132, 0, 0], rUpperArm: [-8, -16, -30], rForearm: [-132, 0, -14], lThigh: [-22, 0, -4], lShin: [26, 0, 0], rThigh: [12, 0, 8], rShin: [6, 0, 0] };
  const GUARD  = { pelvisYaw: 16, chest: [12, 18, 0], head: [16, -16, 0], lUpperArm: [-61, -6, 60], lForearm: [-136, 0, 8], rUpperArm: [-87, -23, -19], rForearm: [-107, 0, -22], lThigh: [-20, 0, -4], lShin: [30, 0, 0], rThigh: [10, 0, 8], rShin: [10, 0, 0] };
  const LIMP   = { pelvisYaw: 0, chest: [0, 0, 0], head: [0, 0, 0], lUpperArm: [0, 0, 20], lForearm: [-20, 0, 0], rUpperArm: [0, 0, -20], rForearm: [-20, 0, 0], lThigh: [0, 0, 0], lShin: [10, 0, 0], rThigh: [0, 0, 0], rShin: [10, 0, 0] };
  // slip: head off the centre line (outside the lead shoulder), hands up
  const SLIP   = { pelvisYaw: 30, chest: [22, 30, -22], head: [10, -20, -10], lUpperArm: [-70, 10, 28], lForearm: [-125, 0, 14], rUpperArm: [-62, -14, -34], rForearm: [-135, 0, -14], lThigh: [-30, 0, -6], lShin: [40, 0, 0], rThigh: [8, 0, 10], rShin: [14, 0, 0] };
  // level change / shot: hips drop, chest pitches forward, arms reach for the legs
  const SHOOT  = { pelvisYaw: 0, chest: [55, 0, 0], head: [-30, 0, 0], lUpperArm: [-85, 0, 10], lForearm: [-20, 0, 0], rUpperArm: [-85, 0, -10], rForearm: [-20, 0, 0], lThigh: [-70, 0, -6], lShin: [70, 0, 0], rThigh: [-20, 0, 8], rShin: [60, 0, 0] };
  // sprawl: hips back, chest down on the shooter
  const SPRAWL = { pelvisYaw: 0, chest: [70, 0, 0], head: [-35, 0, 0], lUpperArm: [-110, 0, 20], lForearm: [-30, 0, 0], rUpperArm: [-110, 0, -20], rForearm: [-30, 0, 0], lThigh: [30, 0, -10], lShin: [20, 0, 0], rThigh: [30, 0, 10], rShin: [20, 0, 0] };
  // stumble: bent over, arms down, feet wide
  const STUMBLE = { pelvisYaw: 0, chest: [40, 0, 0], head: [10, 0, 0], lUpperArm: [-30, 0, 30], lForearm: [-40, 0, 0], rUpperArm: [-30, 0, -30], rForearm: [-40, 0, 0], lThigh: [-35, 0, -12], lShin: [40, 0, 0], rThigh: [20, 0, 12], rShin: [30, 0, 0] };
  // getting back up after a knockdown: crouched, hands coming off the mat
  const GETUP = { pelvisYaw: 0, chest: [45, 0, 0], head: [-25, 0, 0], lUpperArm: [-70, 0, 20], lForearm: [-40, 0, 0], rUpperArm: [-70, 0, -20], rForearm: [-40, 0, 0], lThigh: [-95, 0, -14], lShin: [110, 0, 0], rThigh: [-60, 0, 14], rShin: [100, 0, 0] };
  const CELEBRATE = { pelvisYaw: 0, chest: [-8, 0, 0], head: [-12, 0, 0], lUpperArm: [-170, 0, 30], lForearm: [-20, 0, 0], rUpperArm: [-170, 0, -30], rForearm: [-20, 0, 0], lThigh: [-5, 0, -8], lShin: [8, 0, 0], rThigh: [-5, 0, 8], rShin: [8, 0, 0] };
  // rocked: chin up, hands low, knees soft
  const WOBBLE = { pelvisYaw: 10, chest: [-6, 10, 0], head: [-10, -8, 0], lUpperArm: [-40, 8, 20], lForearm: [-70, 0, 8], rUpperArm: [-30, -10, -24], rForearm: [-80, 0, -6], lThigh: [-30, 0, -6], lShin: [38, 0, 0], rThigh: [4, 0, 10], rShin: [20, 0, 0] };
  const POSES = { STANCE, GUARD, LIMP, SLIP, SHOOT, SPRAWL, STUMBLE, CELEBRATE, WOBBLE, GETUP };

  // ---------------------------------------------------------------- strikes
  // keys: joints a strike animates. Every keyframe must give each of those joints (or 'stance').
  // weapon: collider that deals damage. active: [t0, t1] window in which it can score.
  // speed: multiplier on the joint controllers' natural frequency while the strike plays.
  // part: intended region (for the AI and commentary). cost: stamina.
  // Authored for the REAR (right) side where the game only has one version; lead versions are mirrored.
  const S = 'stance';
  const RAW = {
    // ---- straights
    lh_straight: { name: 'jab', part: 'head', keys: ['chest', 'head', 'lUpperArm', 'lForearm', 'pelvisYaw'], weapon: 'lFist', weaponMult: 1.0, active: [0.07, 0.23], cost: 3.5, speed: 1.5,
      frames: [
        { t: 0.00, pelvisYaw: S, chest: S, head: S, lUpperArm: S, lForearm: S },
        { t: 0.05, pelvisYaw: 18, chest: [6, 22, 0], head: [10, -20, 0], lUpperArm: [-36, -30, -35], lForearm: [-150, 0, -1] },
        { t: 0.12, pelvisYaw: 20, chest: [6, 25, 0], head: [10, -22, 0], lUpperArm: [-108, 6, -30], lForearm: [-2, 0, 1] },
        { t: 0.19, pelvisYaw: 20, chest: [6, 25, 0], head: [10, -22, 0], lUpperArm: [-108, 6, -30], lForearm: [-2, 0, 1] },
        { t: 0.34, pelvisYaw: S, chest: S, head: S, lUpperArm: S, lForearm: S }] },
    rh_straight: { name: 'cross', part: 'head', keys: ['chest', 'head', 'rUpperArm', 'rForearm', 'lUpperArm', 'pelvisYaw'], weapon: 'rFist', weaponMult: 1.25, active: [0.10, 0.28], cost: 5, speed: 1.3, lunge: 0.6,
      frames: [
        { t: 0.00, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S, lUpperArm: S },
        { t: 0.08, pelvisYaw: -12, chest: [8, -22, 0], head: [12, 6, 0], rUpperArm: [-34, 11, -10], rForearm: [-150, 0, 1], lUpperArm: [-72, 10, 30] },
        { t: 0.16, pelvisYaw: -18, chest: [8, -30, 0], head: [12, 10, 0], rUpperArm: [-107, -15, 37], rForearm: [0, 0, -5], lUpperArm: [-72, 10, 30] },
        { t: 0.23, pelvisYaw: -18, chest: [8, -30, 0], head: [12, 10, 0], rUpperArm: [-107, -15, 37], rForearm: [0, 0, -5], lUpperArm: [-72, 10, 30] },
        { t: 0.46, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S, lUpperArm: S }] },
    // ---- hooks: the torso rotates INTO the punch, elbow stays bent
    lh_hook: { name: 'lead hook', part: 'head', keys: ['chest', 'head', 'lUpperArm', 'lForearm', 'pelvisYaw'], weapon: 'lFist', weaponMult: 1.35, active: [0.12, 0.31], cost: 6, speed: 1.25,
      frames: [
        { t: 0.00, pelvisYaw: S, chest: S, head: S, lUpperArm: S, lForearm: S },
        { t: 0.09, pelvisYaw: 6, chest: [6, 8, 0], head: [10, -6, 0], lUpperArm: [-97, 10, -70], lForearm: [-30, 0, 50] },
        { t: 0.22, pelvisYaw: 34, chest: [6, 42, 0], head: [10, -34, 0], lUpperArm: [-122, -2, -78], lForearm: [-20, 0, 49] },
        { t: 0.29, pelvisYaw: 34, chest: [6, 42, 0], head: [10, -34, 0], lUpperArm: [-122, -2, -78], lForearm: [-20, 0, 49] },
        { t: 0.52, pelvisYaw: S, chest: S, head: S, lUpperArm: S, lForearm: S }] },
    rh_hook: { name: 'right hook', part: 'head', keys: ['chest', 'head', 'rUpperArm', 'rForearm', 'pelvisYaw'], weapon: 'rFist', weaponMult: 1.45, active: [0.13, 0.33], cost: 6.5, speed: 1.25,
      frames: [
        { t: 0.00, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S },
        { t: 0.10, pelvisYaw: 22, chest: [6, 30, 0], head: [10, -24, 0], rUpperArm: [-99, -30, -20], rForearm: [-40, 0, -1] },
        { t: 0.24, pelvisYaw: -30, chest: [6, -40, 0], head: [10, 16, 0], rUpperArm: [-114, 0, 68], rForearm: [-20, 0, -42] },
        { t: 0.31, pelvisYaw: -30, chest: [6, -40, 0], head: [10, 16, 0], rUpperArm: [-114, 0, 68], rForearm: [-20, 0, -42] },
        { t: 0.55, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S }] },
    // ---- uppercut: the hand drops below the chin, hips and legs drive it up through the centre line
    rh_uppercut: { name: 'rear uppercut', part: 'head', keys: ['chest', 'head', 'rUpperArm', 'rForearm', 'pelvisYaw'], weapon: 'rFist', weaponMult: 1.35, active: [0.13, 0.32], cost: 6, speed: 1.45, lunge: 0.9,
      frames: [
        { t: 0.00, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S },
        { t: 0.10, pelvisYaw: -4, chest: [18, -14, 6], head: [6, 6, 0], rUpperArm: [-1, 14, -16], rForearm: [-95, 0, -20] },
        { t: 0.24, pelvisYaw: -22, chest: [-8, -30, 0], head: [8, 10, 0], rUpperArm: [-87, 6, 34], rForearm: [-30, 0, -2] },
        { t: 0.30, pelvisYaw: -22, chest: [-8, -30, 0], head: [8, 10, 0], rUpperArm: [-87, 6, 34], rForearm: [-30, 0, -2] },
        { t: 0.54, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S }] },
    // ---- overhand: looping over the top of the guard, body falls into it
    rh_overhand: { name: 'overhand right', part: 'head', keys: ['chest', 'head', 'rUpperArm', 'rForearm', 'pelvisYaw'], weapon: 'rFist', weaponMult: 1.55, active: [0.16, 0.36], cost: 7.5, speed: 1.2, lunge: 1.2,
      frames: [
        { t: 0.00, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S },
        { t: 0.12, pelvisYaw: 8, chest: [-6, 10, 10], head: [4, -8, 0], rUpperArm: [-40, 0, -110], rForearm: [-70, 0, 0] },
        { t: 0.27, pelvisYaw: -26, chest: [26, -34, -14], head: [10, 14, 0], rUpperArm: [-136, -25, 22], rForearm: [-32, 0, 2] },
        { t: 0.34, pelvisYaw: -26, chest: [26, -34, -14], head: [10, 14, 0], rUpperArm: [-136, -25, 22], rForearm: [-32, 0, 2] },
        { t: 0.60, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S }] },
    // ---- lead-leg low kick: hips turn hard, the shin whips into the opponent's lead thigh
    ll_lkick: { name: 'lead low kick', part: 'legs', keys: ['chest', 'lThigh', 'lShin', 'rThigh', 'rShin', 'pelvisYaw', 'lUpperArm', 'rUpperArm'], weapon: 'lShin', weaponMult: 1.5, active: [0.15, 0.38], cost: 7, speed: 1.8, lunge: 0.5,
      frames: [
        { t: 0.00, pelvisYaw: S, chest: S, lThigh: S, lShin: S, rThigh: S, rShin: S, lUpperArm: S, rUpperArm: S },
        { t: 0.13, pelvisYaw: 40, chest: [-4, 20, 8], lThigh: [-45, 14, -58], lShin: [87, 0, 0], rThigh: [4, 0, 6], rShin: [10, 0, 0], lUpperArm: [-30, 0, 50], rUpperArm: [-70, -10, -20] },
        { t: 0.28, pelvisYaw: 70, chest: [-6, 22, 10], lThigh: [-74, 0, -50], lShin: [30, 0, 0], rThigh: [4, 0, 6], rShin: [10, 0, 0], lUpperArm: [-30, 0, 50], rUpperArm: [-70, -10, -20] },
        { t: 0.36, pelvisYaw: 70, chest: [-6, 22, 10], lThigh: [-74, 0, -50], lShin: [30, 0, 0], rThigh: [4, 0, 6], rShin: [10, 0, 0], lUpperArm: [-30, 0, 50], rUpperArm: [-70, -10, -20] },
        { t: 0.72, pelvisYaw: S, chest: S, lThigh: S, lShin: S, rThigh: S, rShin: S, lUpperArm: S, rUpperArm: S }] },
    // ---- rear-leg roundhouse to the head: chamber out to the right, hips turn through, knee snaps out
    rl_hkick: { name: 'head kick', part: 'head', keys: ['chest', 'head', 'rThigh', 'rShin', 'lThigh', 'lShin', 'pelvisYaw', 'pelvisTilt', 'lUpperArm', 'rUpperArm'], weapon: 'rShin', weaponMult: 1.8, active: [0.17, 0.42], cost: 10, speed: 2.0, lift: -0.04, lunge: 0.5,
      frames: [
        { t: 0.00, pelvisYaw: S, pelvisTilt: S, chest: S, head: S, rThigh: S, rShin: S, lThigh: S, lShin: S, lUpperArm: S, rUpperArm: S },
        { t: 0.14, pelvisYaw: -40, pelvisTilt: [-9, 0, 22], chest: [7, 3, -5], head: [10, 30, 10], rThigh: [57, -27, 107], rShin: [88, 0, 0], lThigh: [-4, 16, -14], lShin: [10, 0, 0], lUpperArm: [-80, 10, 20], rUpperArm: [-20, 0, -70] },
        { t: 0.30, pelvisYaw: -72, pelvisTilt: [-7, 0, 56], chest: [29, 15, -15], head: [10, 30, 10], rThigh: [35, -24, 99], rShin: [-1, 0, 0], lThigh: [-8, 21, -46], lShin: [8, 0, 0], lUpperArm: [-80, 10, 20], rUpperArm: [-20, 0, -70] },
        { t: 0.40, pelvisYaw: -72, pelvisTilt: [-7, 0, 56], chest: [29, 15, -15], head: [10, 30, 10], rThigh: [35, -24, 99], rShin: [-1, 0, 0], lThigh: [-8, 21, -46], lShin: [8, 0, 0], lUpperArm: [-80, 10, 20], rUpperArm: [-20, 0, -70] },
        { t: 0.84, pelvisYaw: S, pelvisTilt: S, chest: S, head: S, rThigh: S, rShin: S, lThigh: S, lShin: S, lUpperArm: S, rUpperArm: S }] },
    // ---- rear-leg roundhouse to the body: same turn, the knee stays at rib height
    rl_bkick: { name: 'body kick', part: 'body', keys: ['chest', 'head', 'rThigh', 'rShin', 'lThigh', 'lShin', 'pelvisYaw', 'lUpperArm', 'rUpperArm'], weapon: 'rShin', weaponMult: 1.5, active: [0.16, 0.40], cost: 8, speed: 1.7, lunge: 0.5,
      frames: [
        { t: 0.00, pelvisYaw: S, chest: S, head: S, rThigh: S, rShin: S, lThigh: S, lShin: S, lUpperArm: S, rUpperArm: S },
        { t: 0.13, pelvisYaw: -38, chest: [-6, -24, -10], head: [0, 24, 0], rThigh: [-38, -30, 87], rShin: [110, 0, 0], lThigh: [-4, 0, -6], lShin: [10, 0, 0], lUpperArm: [-80, 10, 20], rUpperArm: [-20, 0, -70] },
        { t: 0.28, pelvisYaw: -85, chest: [14, -26, -8], head: [0, 28, 0], rThigh: [28, 0, 118], rShin: [-10, 0, 0], lThigh: [-4, 0, -6], lShin: [10, 0, 0], lUpperArm: [-80, 10, 20], rUpperArm: [-20, 0, -70] },
        { t: 0.38, pelvisYaw: -85, chest: [14, -26, -8], head: [0, 28, 0], rThigh: [28, 0, 118], rShin: [-10, 0, 0], lThigh: [-4, 0, -6], lShin: [10, 0, 0], lUpperArm: [-80, 10, 20], rUpperArm: [-20, 0, -70] },
        { t: 0.80, pelvisYaw: S, chest: S, head: S, rThigh: S, rShin: S, lThigh: S, lShin: S, lUpperArm: S, rUpperArm: S }] },
    // ---- teep: knee comes up in front, the foot drives straight out and shoves
    rl_teep: { name: 'rear teep', part: 'body', push: true, keys: ['chest', 'rThigh', 'rShin', 'lThigh', 'lShin', 'pelvisYaw', 'lUpperArm', 'rUpperArm'], weapon: 'rFoot', weaponMult: 1.15, active: [0.15, 0.36], cost: 6, speed: 1.6, lunge: 0.8,
      frames: [
        { t: 0.00, pelvisYaw: S, chest: S, rThigh: S, rShin: S, lThigh: S, lShin: S, lUpperArm: S, rUpperArm: S },
        { t: 0.12, pelvisYaw: 4, chest: [10, 4, 0], rThigh: [-130, -2, -11], rShin: [126, 0, 0], lThigh: [-6, 0, -6], lShin: [12, 0, 0], lUpperArm: [-70, 8, 24], rUpperArm: [-55, -10, -30] },
        { t: 0.26, pelvisYaw: 0, chest: [-14, 0, 0], rThigh: [-98, -19, -2], rShin: [4, 0, 0], lThigh: [-6, 0, -6], lShin: [12, 0, 0], lUpperArm: [-70, 8, 24], rUpperArm: [-55, -10, -30] },
        { t: 0.34, pelvisYaw: 0, chest: [-14, 0, 0], rThigh: [-98, -19, -2], rShin: [4, 0, 0], lThigh: [-6, 0, -6], lShin: [12, 0, 0], lUpperArm: [-70, 8, 24], rUpperArm: [-55, -10, -30] },
        { t: 0.70, pelvisYaw: S, chest: S, rThigh: S, rShin: S, lThigh: S, lShin: S, lUpperArm: S, rUpperArm: S }] },
    // ---- knee: hips thrust in, the knee drives up into the body (the shin collider's top end is the weapon)
    rl_knee: { name: 'knee', part: 'body', keys: ['chest', 'head', 'rThigh', 'rShin', 'lThigh', 'lShin', 'pelvisYaw', 'lUpperArm', 'rUpperArm'], weapon: 'rShin', weaponMult: 1.35, active: [0.13, 0.32], cost: 6.5, speed: 1.6, lunge: 1.8,
      frames: [
        { t: 0.00, pelvisYaw: S, chest: S, head: S, rThigh: S, rShin: S, lThigh: S, lShin: S, lUpperArm: S, rUpperArm: S },
        { t: 0.10, pelvisYaw: -6, chest: [14, -6, 0], head: [10, 4, 0], rThigh: [26, -30, -2], rShin: [60, 0, 0], lThigh: [-14, 0, -6], lShin: [20, 0, 0], lUpperArm: [-95, 6, 10], rUpperArm: [-95, -6, -10] },
        { t: 0.24, pelvisYaw: -10, chest: [-16, -10, 0], head: [8, 6, 0], rThigh: [-124, -14, 2], rShin: [80, 0, 0], lThigh: [-8, 0, -6], lShin: [12, 0, 0], lUpperArm: [-95, 6, 10], rUpperArm: [-95, -6, -10] },
        { t: 0.30, pelvisYaw: -10, chest: [-16, -10, 0], head: [8, 6, 0], rThigh: [-124, -14, 2], rShin: [80, 0, 0], lThigh: [-8, 0, -6], lShin: [12, 0, 0], lUpperArm: [-95, 6, 10], rUpperArm: [-95, -6, -10] },
        { t: 0.62, pelvisYaw: S, chest: S, head: S, rThigh: S, rShin: S, lThigh: S, lShin: S, lUpperArm: S, rUpperArm: S }] }
  };
  // ground strikes are not physical; they keep the old timed model in sim.js

  function mirrorEuler(e) { return e === S ? S : [e[0], -e[1], -e[2]]; }
  function mirrorStrike(def, key, name, scaleT) {
    const out = { name, part: def.part, push: def.push, weaponMult: def.weaponMult * 0.92, cost: def.cost * 0.85, speed: def.speed * 1.05, lead: true,
      keys: def.keys.map(k => (k === 'pelvisYaw' || k === 'pelvisTilt') ? k : MIRROR[k]), lift: def.lift, lunge: def.lunge,
      weapon: def.weapon[0] === 'l' ? 'r' + def.weapon.slice(1) : 'l' + def.weapon.slice(1),
      active: [def.active[0] * scaleT, def.active[1] * scaleT],
      frames: def.frames.map(f => {
        const o = { t: f.t * scaleT };
        for (const k in f) {
          if (k === 't') continue;
          if (k === 'pelvisYaw') o.pelvisYaw = f[k] === S ? S : -f[k];
          else if (k === 'pelvisTilt') o.pelvisTilt = mirrorEuler(f[k]);
          else o[MIRROR[k]] = mirrorEuler(f[k]);
        }
        return o;
      }) };
    return out;
  }
  const STRIKES = Object.assign({}, RAW);
  STRIKES.lh_uppercut = mirrorStrike(RAW.rh_uppercut, 'lh_uppercut', 'lead uppercut', 0.92);
  STRIKES.lh_overhand = mirrorStrike(RAW.rh_overhand, 'lh_overhand', 'looping left', 0.92);
  STRIKES.rl_lkick = mirrorStrike(RAW.ll_lkick, 'rl_lkick', 'low kick', 1.05); STRIKES.rl_lkick.weaponMult = 1.6; STRIKES.rl_lkick.cost = 8; STRIKES.rl_lkick.lead = false;
  STRIKES.ll_hkick = mirrorStrike(RAW.rl_hkick, 'll_hkick', 'lead head kick', 0.92);
  STRIKES.ll_bkick = mirrorStrike(RAW.rl_bkick, 'll_bkick', 'lead body kick', 0.92);
  STRIKES.ll_teep = mirrorStrike(RAW.rl_teep, 'll_teep', 'teep', 0.9);
  STRIKES.ll_knee = mirrorStrike(RAW.rl_knee, 'll_knee', 'lead knee', 0.92);
  for (const k in STRIKES) {
    const d = STRIKES[k];
    d.key = k; d.limb = k.slice(0, 2); d.kind = k.slice(3);
    d.dur = d.frames[d.frames.length - 1].t;
    d.isKick = d.weapon.endsWith('Shin') || d.weapon.endsWith('Foot');
    // a roundhouse lands with the shin or the instep; a teep with the sole; a knee with the top of the shin
    d.weapons = d.weapon.endsWith('Shin') && d.kind !== 'knee' ? [d.weapon, d.weapon[0] + 'Foot'] : [d.weapon];
    // sim-side timing: windup / active / recovery
    d.w = d.active[0]; d.a = d.active[1] - d.active[0]; d.r = d.dur - d.active[1];
  }

  // ---------------------------------------------------------------- forward kinematics (authoring aid + AI ranges)
  // Returns world positions of every segment centre and the weapons for a pose, pelvis at the origin facing +Z.
  function fk(pose, yaw) {
    const q = {}, p = {};
    q.pelvis = qYaw((yaw || 0) + (pose.pelvisYaw || 0) * DEG);
    if (pose.pelvisTilt) q.pelvis = qMul(q.pelvis, qEuler(pose.pelvisTilt));
    p.pelvis = V(0, HOVER_HEIGHT + (pose.lift || 0), 0);
    for (const name of JOINTS) {
      const seg = SEGS[name];
      const e = pose[name] || [0, 0, 0];
      q[name] = qMul(q[seg.parent], qEuler(e));
      p[name] = vSub(vAdd(p[seg.parent], qRot(q[seg.parent], V(...seg.anchorParent))), qRot(q[name], V(...seg.anchorSelf)));
    }
    const w = {};
    for (const name of JOINTS) {
      const ex = SEGS[name].extra;
      if (ex) w[ex.name] = vAdd(p[name], qRot(q[name], V(...ex.pos)));
      w[name] = p[name];
    }
    // knee: top end of the shin
    w.lKnee = vAdd(p.lShin, qRot(q.lShin, V(0, 0.18, 0)));
    w.rKnee = vAdd(p.rShin, qRot(q.rShin, V(0, 0.18, 0)));
    return { p, q, w };
  }
  // resolve a keyframe's 'stance' refs against a base pose
  function resolveFrame(def, f, base) {
    const o = { pelvisYaw: base.pelvisYaw, pelvisTilt: base.pelvisTilt || [0, 0, 0], lift: 0 };
    for (const j of JOINTS) o[j] = base[j];
    for (const k of def.keys) o[k] = f[k] === S ? (base[k] || [0, 0, 0]) : f[k];
    if (def.lift && f.t >= def.active[0] - 1e-6 && f.t <= def.active[1] + 1e-6) o.lift = def.lift;
    return o;
  }
  // impact reach of each strike: furthest forward the weapon gets inside the active window, measured
  // from the impact keyframe. range = root-to-root distance at which a square-on opponent is hit.
  const TARGET_R = { head: 0.14, body: 0.2, legs: 0.17 };
  (function computeRanges() {
    for (const k in STRIKES) {
      const d = STRIKES[k];
      let best = -1, bestY = 0;
      for (const f of d.frames) {
        if (f.t < d.active[0] - 1e-6 || f.t > d.active[1] + 1e-6) continue;
        const pose = resolveFrame(d, f, STANCE);
        const r = fk(pose, 0);
        const wname = d.kind === 'knee' ? (d.weapon[0] + 'Knee') : d.weapon;
        const wp = r.w[wname];
        if (wp.z > best) { best = wp.z; bestY = wp.y; }
      }
      d.reach = best; d.reachY = bestY;
      const weaponR = d.weapon.endsWith('Fist') ? 0.062 : d.weapon.endsWith('Foot') ? 0.11 : 0.055;
      d.range = best + weaponR + TARGET_R[d.part] + 0.04;
    }
    // measured with tools/probe.js: the furthest root-to-root distance at which the strike still lands
    // on what it is aimed at. The AI picks strikes from these.
    const RANGE = { lh_straight: 1.0, rh_straight: 1.0, lh_hook: 1.0, rh_hook: 0.85, rh_uppercut: 0.75, lh_uppercut: 0.9, rh_overhand: 1.3, lh_overhand: 1.25,
      ll_lkick: 1.2, rl_lkick: 1.2, rl_hkick: 1.4, ll_hkick: 1.3, rl_bkick: 1.0, ll_bkick: 1.2, rl_teep: 1.25, ll_teep: 1.15, rl_knee: 0.8, ll_knee: 0.7 };
    for (const k in RANGE) if (STRIKES[k]) STRIKES[k].range = RANGE[k];
  })();

  // ---------------------------------------------------------------- Rapier helpers
  const GROUP_FIGHTER = [0b0001, 0b0010];
  const GROUP_WORLD = 0b0100;
  const groups = (membership, filter) => (membership << 16) | filter;

  // ---------------------------------------------------------------- Ragdoll
  class Ragdoll {
    constructor(world, index, x, z, yaw) {
      this.world = world;
      this.index = index;
      this.yaw = yaw;
      this.opponent = null;
      this.bodies = {}; this.joints = {}; this.colliders = {}; this.partColliders = []; this.inertia = {}; this.preVel = {};
      // control state (set by the sim every tick)
      this.move = [0, 0];       // local x (right), z (forward), -1..1
      this.moveSpeed = 1;       // multiplier on MOVE_SPEED
      this.guard = false;
      this.override = null;     // pose name: SLIP | SHOOT | SPRAWL | STUMBLE | CELEBRATE | WOBBLE
      this.ko = false;
      this.downT = 0; this.riseT = 0; this.riseTotal = 1; // knocked down: limp on the mat, then climbing back up
      this.gainTarget = 1;      // 1 normal, lower when staggered / stunned
      this.gainMult = 1;
      this.staggerT = 0;
      this.stunT = 0;
      this.wobble = 0;          // rocked wobble intensity
      this.strike = null;       // { def, t, tf, speedMult, hit, glanced }
      this.walkPhase = 0;
      this.faceOpponent = true;
      this.sleeping = false;
      this.#build(x, z, yaw);
    }

    #build(x, z, yaw) {
      const world = this.world;
      const member = GROUP_FIGHTER[this.index];
      const filter = GROUP_FIGHTER[1 - this.index] | GROUP_WORLD;
      const cg = groups(member, filter);
      const q = qYaw(yaw);
      const pos = { pelvis: V(x, HOVER_HEIGHT + 0.07, z) };
      this.totalMass = 0;
      for (const name of SEG_ORDER) {
        const seg = SEGS[name];
        if (seg.parent) pos[name] = vSub(vAdd(pos[seg.parent], qRot(q, V(...seg.anchorParent))), qRot(q, V(...seg.anchorSelf)));
        const p = pos[name];
        const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation(q).setLinearDamping(0.2).setAngularDamping(0.5).setCcdEnabled(true));
        this.bodies[name] = body;
        const mk = (shape, mass, offset, friction) => {
          let d;
          if (shape[0] === 'capsule') d = R.ColliderDesc.capsule(shape[1], shape[2]);
          else if (shape[0] === 'ball') d = R.ColliderDesc.ball(shape[1]);
          else d = R.ColliderDesc.cuboid(shape[1], shape[2], shape[3]);
          d.setMass(mass).setFriction(friction).setRestitution(0.05);
          if (offset) d.setTranslation(offset[0], offset[1], offset[2]);
          return d;
        };
        const col = world.createCollider(mk(seg.shape, seg.mass, null, seg.part === 'shin' ? 0.3 : 0.5), body);
        col.setCollisionGroups(cg);
        this.colliders[name] = { collider: col, part: seg.part, seg: name };
        this.partColliders.push(this.colliders[name]);
        this.totalMass += seg.mass;
        if (seg.extra) {
          const ex = seg.extra;
          const ecol = world.createCollider(mk(ex.shape, ex.mass, ex.pos, ex.part === 'foot' ? 0.15 : 0.5), body);
          ecol.setCollisionGroups(cg);
          this.colliders[ex.name] = { collider: ecol, part: ex.part, seg: name };
          this.partColliders.push(this.colliders[ex.name]);
          this.totalMass += ex.mass;
        }
        if (seg.parent) {
          const jd = R.JointData.spherical(V(...seg.anchorParent), V(...seg.anchorSelf));
          const joint = world.createImpulseJoint(jd, this.bodies[seg.parent], body, true);
          this.joints[name] = joint;
          for (const ax of [R.JointAxis.AngX, R.JointAxis.AngY, R.JointAxis.AngZ]) R.SphericalImpulseJoint.prototype.configureMotorModel.call(joint, ax, R.MotorModel.ForceBased);
        }
        const pi = body.principalInertia();
        this.inertia[name] = V(pi.x, pi.y, pi.z);
        this.preVel[name] = { lin: V(0, 0, 0), ang: V(0, 0, 0), pos: V(0, 0, 0) };
      }
      // subtree inertia about each joint (rest pose), so every joint behaves like the same "muscle"
      this.jointInertia = {};
      const descendants = (n) => SEG_ORDER.filter((c) => { let x = c; while (x) { if (x === n) return true; x = SEGS[x].parent; } return false; });
      for (const name of JOINTS) {
        const seg = SEGS[name];
        const jw = vAdd(pos[seg.parent], qRot(q, V(...seg.anchorParent)));
        let I = 0;
        for (const d of descendants(name)) {
          const sd = SEGS[d], m = sd.mass + (sd.extra ? sd.extra.mass : 0), own = this.inertia[d];
          const dd = vSub(pos[d], jw);
          I += m * vDot(dd, dd) + (own.x + own.y + own.z) / 3;
        }
        this.jointInertia[name] = I;
      }
    }

    // place the ragdoll upright in its stance at x,z facing yaw, at rest
    teleport(x, z, yaw) {
      this.yaw = yaw;
      const q = qYaw(yaw);
      const pos = { pelvis: V(x, HOVER_HEIGHT + 0.05, z) };
      for (const name of SEG_ORDER) {
        const seg = SEGS[name];
        if (seg.parent) pos[name] = vSub(vAdd(pos[seg.parent], qRot(q, V(...seg.anchorParent))), qRot(q, V(...seg.anchorSelf)));
        const b = this.bodies[name], p = pos[name];
        b.setTranslation(p, true); b.setRotation(q, true);
        b.setLinvel(V(0, 0, 0), true); b.setAngvel(V(0, 0, 0), true);
        b.resetForces(true); b.resetTorques(true);
      }
      this.strike = null; this.override = null; this.ko = false; this.downT = 0; this.riseT = 0; this.gainMult = 1; this.gainTarget = 1;
      this.staggerT = 0; this.stunT = 0; this.wobble = 0; this.move[0] = this.move[1] = 0; this.guard = false;
    }

    setSleeping(on) {
      if (this.sleeping === on) return;
      this.sleeping = on;
      for (const name of SEG_ORDER) {
        const b = this.bodies[name];
        b.setEnabled(!on);
      }
    }

    // ---- control API (called by the sim)
    startStrike(def, tf) {
      this.strike = { def, t: 0, tf: tf || 1, hit: false, glanced: false };
    }
    cancelStrike() { this.strike = null; }
    stagger(sec) { this.staggerT = Math.max(this.staggerT, sec); }
    stun(sec) { this.stunT = Math.max(this.stunT, sec); }

    position() { return this.bodies.pelvis.translation(); }
    velocity() { return this.bodies.pelvis.linvel(); }
    headPosition() { return this.bodies.head.translation(); }

    // ---- per-substep update (before world.step)
    update(dt, rand) {
      this.staggerT = Math.max(0, this.staggerT - dt);
      this.stunT = Math.max(0, this.stunT - dt);
      if (this.strike) {
        this.strike.t += dt;
        if (this.strike.t >= this.strike.def.dur * this.strike.tf) this.strike = null;
      }
      if (this.downT > 0) this.downT = Math.max(0, this.downT - dt);
      else if (this.riseT > 0) this.riseT = Math.max(0, this.riseT - dt);
      let gTarget = this.gainTarget;
      if (this.ko) gTarget = 0;
      else if (this.downT > 0) gTarget = 0.04;
      else if (this.riseT > 0) gTarget = Math.min(gTarget, 0.35 + 0.65 * this.riseProgress());
      else if (this.stunT > 0) gTarget = Math.min(gTarget, 0.45);
      else if (this.staggerT > 0) gTarget = Math.min(gTarget, 0.65);
      this.gainMult += (gTarget - this.gainMult) * Math.min(1, dt * (gTarget < this.gainMult ? 40 : 8));

      // facing
      if (this.opponent && !this.ko && this.downT <= 0 && this.faceOpponent) {
        const a = this.bodies.pelvis.translation(), b = this.opponent.bodies.pelvis.translation();
        const want = Math.atan2(b.x - a.x, b.z - a.z);
        let d = want - this.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const maxTurn = 7 * dt;
        this.yaw += clamp(d, -maxTurn, maxTurn);
      }
      const pose = this.#computePose(dt);
      this.#applyControl(pose, dt, rand);
    }

    #basePose() {
      if (this.ko || this.downT > 0) return LIMP;
      if (this.riseT > 0 && this.riseProgress() < 0.55) return GETUP;
      if (this.override && POSES[this.override]) return POSES[this.override];
      if (this.wobble > 0.3 && !this.strike) return WOBBLE;
      return this.guard && !this.strike ? GUARD : STANCE;
    }

    #computePose(dt) {
      const base = this.#basePose();
      const st = this.strike;
      const out = { pelvisYaw: base.pelvisYaw, pelvisTilt: base.pelvisTilt || null, lift: 0, q: {}, speed: {}, zeta: {} };
      const inStrike = st ? st.def.keys : [];
      // walk cycle
      const spd = Math.hypot(this.move[0], this.move[1]);
      const moving = !this.ko && spd > 0.05 && !this.override;
      if (moving) this.walkPhase += dt * (5 + 5 * Math.min(1, spd));
      const amp = moving ? Math.min(1, spd) * 26 : 0;
      const walk = amp ? {
        lThigh: [Math.sin(this.walkPhase) * amp, 0, 0], rThigh: [-Math.sin(this.walkPhase) * amp, 0, 0],
        lShin: [Math.max(0, Math.sin(this.walkPhase + 1.3)) * amp * 1.3, 0, 0], rShin: [Math.max(0, -Math.sin(this.walkPhase + 1.3)) * amp * 1.3, 0, 0]
      } : null;
      for (const j of JOINTS) {
        if (inStrike.indexOf(j) >= 0) continue;
        const e = base[j], w = walk && walk[j];
        out.q[j] = qEuler(w ? [e[0] + w[0], e[1] + w[1], e[2] + w[2]] : e);
        out.speed[j] = 1;
      }
      if (st) {
        const fr = st.def.frames, tt = st.t / st.tf;
        let i = 0;
        while (i < fr.length - 2 && tt >= fr[i + 1].t) i++;
        const f0 = fr[i], f1 = fr[i + 1];
        const s = smooth(clamp((tt - f0.t) / (f1.t - f0.t), 0, 1));
        const spdMul = st.def.speed / Math.sqrt(st.tf);
        if (st.def.lift && tt >= st.def.active[0] - 0.06 && tt <= st.def.active[1]) out.lift = st.def.lift;
        for (const j of st.def.keys) {
          const v0 = f0[j] === S ? base[j] : f0[j], v1 = f1[j] === S ? base[j] : f1[j];
          if (j === 'pelvisYaw') { out.pelvisYaw = v0 + (v1 - v0) * s; out.speed.pelvis = spdMul; }
          else if (j === 'pelvisTilt') { const a = v0 || [0, 0, 0], b = v1 || [0, 0, 0]; out.pelvisTilt = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]; }
          else {
            out.q[j] = qSlerp(qEuler(v0), qEuler(v1), s);
            out.speed[j] = spdMul;
            // under-damped while the blow is travelling so the limb whips through instead of easing in
            out.zeta[j] = tt < st.def.active[1] ? 0.5 : 1.0;
          }
        }
      }
      return out;
    }

    #applyControl(pose, dt, rand) {
      const yaw = this.yaw + pose.pelvisYaw * DEG;
      const qRoot = pose.pelvisTilt ? qMul(qYaw(yaw), qEuler(pose.pelvisTilt)) : qYaw(yaw);
      const g = this.gainMult;
      for (const name of SEG_ORDER) { const b = this.bodies[name]; b.resetForces(true); b.resetTorques(true); }

      // joint motors: every segment is driven toward its target rotation relative to its parent
      const axes = [R.JointAxis.AngX, R.JointAxis.AngY, R.JointAxis.AngZ];
      for (const name of JOINTS) {
        const seg = SEGS[name], joint = this.joints[name];
        const rv = qToMotor(pose.q[name]);
        const w0 = seg.w0 * (pose.speed[name] || 1);
        const I = this.jointInertia[name];
        const stiff = I * w0 * w0 * g;
        const damp = 2 * ZETA * (pose.zeta[name] || 1) * I * w0 * (0.25 + 0.75 * g);
        for (let i = 0; i < 3; i++) R.SphericalImpulseJoint.prototype.configureMotorPosition.call(joint, axes[i], rv[i], stiff, damp);
      }

      // root: explicit PD holds the pelvis to the facing yaw and upright
      if (g > 0.01) {
        const body = this.bodies.pelvis;
        const r = body.rotation();
        const qErr = qMul(qRoot, qConj(Q(r.x, r.y, r.z, r.w)));
        const ev = qToRotVec(qErr);
        const w = body.angvel();
        const w0 = SEGS.pelvis.w0 * (pose.speed.pelvis || 1);
        let tx = (ev[0] * w0 * w0 - w.x * 2 * ZETA * w0) * ROOT_INERTIA * g;
        let ty = (ev[1] * w0 * w0 - w.y * 2 * ZETA * w0) * ROOT_INERTIA * g;
        let tz = (ev[2] * w0 * w0 - w.z * 2 * ZETA * w0) * ROOT_INERTIA * g;
        const maxT = ROOT_INERTIA * w0 * w0 * 2.5, tl = Math.hypot(tx, ty, tz);
        if (tl > maxT) { tx *= maxT / tl; ty *= maxT / tl; tz *= maxT / tl; }
        body.addTorque(V(tx, ty, tz), true);
      }
      // rocked: the legs keep betraying him
      if (this.wobble > 0 && !this.ko && rand) {
        const k = this.wobble * 60;
        this.bodies.chest.addTorque(V((rand() - 0.5) * k, (rand() - 0.5) * k * 0.5, (rand() - 0.5) * k), true);
        this.bodies.pelvis.addForce(V((rand() - 0.5) * k * 4, 0, (rand() - 0.5) * k * 4), true);
      }

      // balance / locomotion (pelvis)
      if (!this.ko && this.downT <= 0) {
        const pelvis = this.bodies.pelvis, p = pelvis.translation(), v = pelvis.linvel(), M = this.totalMass;
        let hTarget = HOVER_HEIGHT + (pose.lift || 0) - (this.guard ? 0.03 : 0) - (this.stunT > 0 ? 0.12 : 0);
        if (this.riseT > 0) { const rp = this.riseProgress(); hTarget = 0.4 + (HOVER_HEIGHT - 0.4) * smooth(rp); }
        if (this.override === 'SHOOT') hTarget -= 0.3; else if (this.override === 'SPRAWL') hTarget -= 0.25; else if (this.override === 'STUMBLE') hTarget -= 0.15;
        const kH = 110, cH = 19;
        const above = p.y - hTarget;
        let fy;
        // the hover is a cushion, not a jetpack: once the hips are above where they should be it lets go
        // (and pulls down a little) so a fighter who gets bumped upward comes straight back to the mat
        if (above > 0.03) fy = M * (9.81 * 0.25 - 80 * (above - 0.03) - cH * Math.max(0, v.y)) * Math.max(0.35, g);
        else fy = M * (9.81 * HOVER_FRACTION + kH * (hTarget - p.y) - cH * v.y) * Math.max(0.35, g);
        fy = clamp(fy, -M * 20, M * 26);
        let vdx = 0, vdz = 0;
        if (this.strike && this.strike.def.lunge && this.staggerT <= 0) {
          const st = this.strike, tt = st.t / st.tf;
          if (tt < st.def.active[1]) { vdx += st.def.lunge * Math.sin(this.yaw); vdz += st.def.lunge * Math.cos(this.yaw); }
        }
        if (this.staggerT <= 0 && !this.override) {
          const ms = MOVE_SPEED * this.moveSpeed * (this.strike ? 0.6 : this.guard ? 0.75 : 1);
          let mx = this.move[0], mz = this.move[1];
          const ml = Math.hypot(mx, mz);
          if (ml > 1) { mx /= ml; mz /= ml; }
          const lx = mx * ms, lz = mz * ms * (mz < 0 ? 0.8 : 1);
          const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
          vdx += lx * c + lz * s; vdz += -lx * s + lz * c;
        } else if (this.override === 'SHOOT') {
          const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
          vdx = 2.2 * s; vdz = 2.2 * c;
        }
        const kv = 9 * Math.max(0.25, g);
        let fx = M * kv * (vdx - v.x), fz = M * kv * (vdz - v.z);
        const fh = Math.hypot(fx, fz), maxH = M * 22;
        if (fh > maxH) { fx *= maxH / fh; fz *= maxH / fh; }
        pelvis.addForce(V(fx, fy, fz), true);
        const cv = this.bodies.chest.linvel();
        this.bodies.chest.addForce(V(M * 1.5 * (vdx - cv.x), 0, M * 1.5 * (vdz - cv.z)), true);
      }
    }

    recordVelocities() {
      for (const name of SEG_ORDER) {
        const b = this.bodies[name], l = b.linvel(), a = b.angvel(), p = b.translation(), pv = this.preVel[name];
        pv.lin.x = l.x; pv.lin.y = l.y; pv.lin.z = l.z; pv.ang.x = a.x; pv.ang.y = a.y; pv.ang.z = a.z; pv.pos.x = p.x; pv.pos.y = p.y; pv.pos.z = p.z;
      }
    }
    #velAt(name, point) {
      const pv = this.preVel[name];
      return vAdd(pv.lin, vCross(pv.ang, vSub(point, pv.pos)));
    }

    // called after world.step(): did this fighter's live strike connect with anything?
    // Returns { partName, region, vn, speed, clean, point:[x,y,z], n:[x,y,z], glance } or null.
    checkHits() {
      const st = this.strike;
      if (!st || st.hit || !this.opponent) return null;
      const tt = st.t / st.tf;
      if (tt < st.def.active[0] || tt > st.def.active[1]) return null;
      const opp = this.opponent;
      let result = null;
      for (const wname of st.def.weapons) {
        const weapon = this.colliders[wname];
        for (const pc of opp.partColliders) {
          if (result) break;
          this.world.contactPair(weapon.collider, pc.collider, (manifold, flipped) => {
          if (result || manifold.numContacts() === 0) return;
          const n0 = manifold.normal();
          let n = V(n0.x, n0.y, n0.z);
          if (flipped) n = vScale(n, -1);
          const wp = weapon.collider.translation(), tp = pc.collider.translation();
          if (vDot(vSub(tp, wp), n) < 0) n = vScale(n, -1);
          let point;
          if (manifold.numSolverContacts() > 0) { const sp = manifold.solverContactPoint(0); point = V(sp.x, sp.y, sp.z); }
          else point = V(wp.x, wp.y, wp.z);
            const vRel = vSub(this.#velAt(weapon.seg, point), opp.#velAt(pc.seg, point));
            const vn = vDot(vRel, n), speed = vLen(vRel);
            if (vn < 1.0) return; // touching or pulling away, not a blow
            result = { partName: pc.part, region: REGION[pc.part], seg: pc.seg, n, point, vn, speed, clean: speed > 0.01 ? vn / speed : 0, weapon: wname };
          });
        }
        if (result) break;
      }
      if (!result) return null;
      // glove on glove is a touch, not a blow: the punch keeps travelling
      if (result.vn < VMIN || result.clean < MIN_CLEAN || result.partName === 'fist') {
        if (st.glanced) return null;
        st.glanced = true;
        result.glance = true;
        return result;
      }
      st.hit = true;
      return result;
    }

    // physical consequence of being hit: shove the part and the core. dmg is in sim units (100 = KO).
    takeHit(hit, dmg, blocked) {
      const { n, point, seg } = hit;
      const imp = (blocked ? 1.5 : 3) + dmg * 2.6;
      this.bodies[seg].applyImpulseAtPoint(V(n.x * imp, n.y * imp * 0.4, n.z * imp), point, true);
      const core = dmg * (blocked ? 1.6 : 3.6);
      this.bodies.pelvis.applyImpulse(V(n.x * core, 0, n.z * core), true);
      this.bodies.chest.applyImpulse(V(n.x * core * 0.6, 0, n.z * core * 0.6), true);
      if (!blocked) {
        this.staggerT = Math.max(this.staggerT, Math.min(0.75, 0.08 + dmg * 0.09));
        if (dmg > 2.2) this.strike = null;
        if (hit.region === 'head' && dmg >= 3.2) this.stunT = Math.max(this.stunT, 0.5 + dmg * 0.12);
      }
    }
    shove(dirX, dirZ, amount) {
      const M = this.totalMass;
      this.bodies.pelvis.applyImpulse(V(dirX * amount * M, 0, dirZ * amount * M), true);
      this.bodies.chest.applyImpulse(V(dirX * amount * M * 0.5, 0, dirZ * amount * M * 0.5), true);
    }
    knockOut() { this.ko = true; this.strike = null; }
    // drop like a sack for `down` seconds, then spend `rise` seconds climbing back to the stance
    knockDown(down, rise) { this.downT = down; this.riseT = rise; this.riseTotal = rise; this.strike = null; this.guard = false; }
    isDown() { return this.downT > 0; }
    riseProgress() { return this.downT > 0 ? 0 : this.riseT > 0 ? 1 - this.riseT / this.riseTotal : 1; }

    // compact pose for the renderer / network: 11 x [px,py,pz,qx,qy,qz,qw]
    snapshot(out) {
      out = out || new Array(SEG_ORDER.length * 7);
      let i = 0;
      for (const name of SEG_ORDER) {
        const b = this.bodies[name], p = b.translation(), r = b.rotation();
        out[i++] = Math.round(p.x * 1000) / 1000; out[i++] = Math.round(p.y * 1000) / 1000; out[i++] = Math.round(p.z * 1000) / 1000;
        out[i++] = Math.round(r.x * 10000) / 10000; out[i++] = Math.round(r.y * 10000) / 10000; out[i++] = Math.round(r.z * 10000) / 10000; out[i++] = Math.round(r.w * 10000) / 10000;
      }
      return out;
    }
  }

  // ---------------------------------------------------------------- World
  class World {
    constructor(opts) {
      if (!R) throw new Error('MMAPhys.init(RAPIER) has not been called');
      opts = opts || {};
      this.world = new R.World(V(0, -9.81, 0));
      this.world.timestep = PHYS_DT;
      try { this.world.integrationParameters.numSolverIterations = 8; } catch (e) { /* older API */ }
      this.rand = opts.rand || Math.random;
      // floor
      const ground = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
      const gc = this.world.createCollider(R.ColliderDesc.cuboid(CAGE_APOTHEM + 4, 0.5, CAGE_APOTHEM + 4).setFriction(0.35), ground);
      gc.setCollisionGroups(groups(GROUP_WORLD, GROUP_FIGHTER[0] | GROUP_FIGHTER[1]));
      // octagon fence
      const sides = 8, sideLen = 2 * CAGE_APOTHEM * Math.tan(Math.PI / sides);
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
        const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(Math.cos(a) * (CAGE_APOTHEM + 0.05), 1.0, Math.sin(a) * (CAGE_APOTHEM + 0.05)).setRotation(qYaw(-a + Math.PI / 2)));
        const col = this.world.createCollider(R.ColliderDesc.cuboid(sideLen / 2 + 0.1, 1.0, 0.05).setFriction(0.3).setRestitution(0.15), body);
        col.setCollisionGroups(groups(GROUP_WORLD, GROUP_FIGHTER[0] | GROUP_FIGHTER[1]));
      }
      const p = opts.positions || [[-1.3, 0], [1.3, 0]];
      this.fighters = [new Ragdoll(this.world, 0, p[0][0], p[0][1], Math.atan2(p[1][0] - p[0][0], p[1][1] - p[0][1])),
                       new Ragdoll(this.world, 1, p[1][0], p[1][1], Math.atan2(p[0][0] - p[1][0], p[0][1] - p[1][1]))];
      this.fighters[0].opponent = this.fighters[1];
      this.fighters[1].opponent = this.fighters[0];
      this.active = true;
      this.steps = 0;
    }

    // stand both fighters at their sim positions, facing each other
    place(f0, f1) {
      this.fighters[0].teleport(f0.x, f0.z, Math.atan2(f1.x - f0.x, f1.z - f0.z));
      this.fighters[1].teleport(f1.x, f1.z, Math.atan2(f0.x - f1.x, f0.z - f1.z));
    }
    setActive(on) {
      if (this.active === on) return;
      this.active = on;
      for (const f of this.fighters) f.setSleeping(!on);
    }

    // one 60 Hz sim tick = SUBSTEPS physics steps. Returns the first hit of each fighter's live strike (or null).
    step() {
      const hits = [null, null];
      for (let s = 0; s < SUBSTEPS; s++) {
        for (const f of this.fighters) f.update(PHYS_DT, this.rand);
        for (const f of this.fighters) f.recordVelocities();
        this.world.step();
        this.steps++;
        for (let i = 0; i < 2; i++) {
          if (hits[i] && !hits[i].glance) continue;
          const h = this.fighters[i].checkHits();
          if (h && (!hits[i] || !h.glance)) hits[i] = h;
        }
      }
      return hits;
    }

    free() { try { this.world.free(); } catch (e) { /* ignore */ } }
  }

  // ---------------------------------------------------------------- damage from an impact (sim units)
  // vn: closing speed along the contact normal; clean: how square (1 = dead on)
  function impactDamage(def, hit, striker, defenderGuarding) {
    const kick = def.isKick;
    let mult = PART_MULT[hit.partName];
    if (kick && KICK_PART_MULT[hit.partName]) mult = KICK_PART_MULT[hit.partName];
    let region = hit.region, blocked = false;
    if (region === 'arm') { blocked = true; region = 'body'; mult = defenderGuarding ? BLOCK_MULT : ARM_MULT; }
    else if (region === 'legs' && hit.partName !== 'thigh' && defenderGuarding && kick) { blocked = true; mult = CHECK_MULT; }
    else if (region === 'legs' && !kick) mult *= 0.6; // punching a leg
    const staminaMult = 0.6 + 0.4 * Math.min(1, striker.stam / 30);
    const dmg = DMG_SCALE * Math.pow(Math.max(0, hit.vn - VMIN), 1.3) * mult * def.weaponMult * (0.65 + 0.35 * hit.clean) * staminaMult;
    return { dmg: Math.min(dmg, DMG_CAP), region, blocked };
  }

  function init(RAPIER) { R = RAPIER; return R.init ? R.init() : Promise.resolve(); }

  root.MMAPhys = { init, ready: () => !!R, World, Ragdoll, STRIKES, POSES, SEGS, SEG_ORDER, fk, impactDamage, PHYS_DT, SUBSTEPS, HOVER_HEIGHT, VMIN, DMG_SCALE, TARGET_R, math: { qMul, qEuler, qRot, qYaw, qSlerp } };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MMAPhys;
})(typeof window !== 'undefined' ? window : globalThis);
