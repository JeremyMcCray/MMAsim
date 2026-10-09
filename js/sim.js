/* ============================================================
   CAGE RULES — fight simulation
   Pure, deterministic (seeded), fixed-step. No DOM, no Three.js.
   Runs on the host (or locally in practice mode); clients only
   receive snapshots of `sim.state`.

   Striking: every strike is a limb (left/right hand or leg) + a
   kind chosen by the fighter's moveset and the modifier being held.
   The standing game requires js/physics.js (MMAPhys, Rapier) and
   runs on active ragdolls: strikes are keyframed poses the joint
   motors chase, and a strike scores only when its fist / shin /
   foot collider arrives on the opponent with speed, square to the
   target. Guarding puts the forearms physically in the way. The
   ground game (takedowns, positions, submissions) is abstract and
   runs with the ragdolls parked.
   ============================================================ */
(function (root) {
  'use strict';

  // ---------- Input bits ----------
  const IN = {
    FWD: 1, BACK: 2, LEFT: 4, RIGHT: 8,
    LHAND: 16, RHAND: 32, LLEG: 64, RLEG: 128,
    MOD1: 256, MOD2: 512, MOD3: 1024,
    BLOCK: 2048, GRAPPLE: 4096, DODGE: 8192,
    STANCE: 1 << 16, // switch orthodox / southpaw (bits 14 and 15 are the app's own)
    CHECK: 1 << 17   // lift the lead leg to check low kicks (hold)
  };
  const LIMB_BITS = IN.LHAND | IN.RHAND | IN.LLEG | IN.RLEG;
  const DIR_BITS = IN.FWD | IN.BACK | IN.LEFT | IN.RIGHT;
  const LIMBS = ['lh', 'rh', 'll', 'rl'];
  const LIMB_BIT = { lh: IN.LHAND, rh: IN.RHAND, ll: IN.LLEG, rl: IN.RLEG };
  const LIMB_NAME = { lh: 'Left hand', rh: 'Right hand', ll: 'Left leg', rl: 'Right leg' };
  const MODS = ['none', 'mod1', 'mod2', 'mod3'];
  const MOD_BIT = { none: 0, mod1: IN.MOD1, mod2: IN.MOD2, mod3: IN.MOD3 };
  const HAND_KINDS = ['straight', 'hook', 'uppercut', 'overhand'];
  const LEG_KINDS = ['teep', 'knee', 'bkick', 'hkick', 'lkick'];
  const KIND_LABEL = { straight: 'Straight', hook: 'Hook', uppercut: 'Uppercut', overhand: 'Overhand', teep: 'Teep', knee: 'Knee', bkick: 'Body kick', hkick: 'Head kick', lkick: 'Low kick' };

  // which strike each limb throws for each held modifier (orthodox stance: left side leads)
  const DEFAULT_MOVESET = {
    none: { lh: 'uppercut', rh: 'uppercut', ll: 'teep', rl: 'knee' },
    mod1: { lh: 'hook', rh: 'hook', ll: 'bkick', rl: 'bkick' },
    mod2: { lh: 'straight', rh: 'straight', ll: 'hkick', rl: 'hkick' },
    mod3: { lh: 'overhand', rh: 'overhand', ll: 'lkick', rl: 'lkick' }
  };
  function normalizeMoveset(ms) {
    const out = {};
    for (const m of MODS) {
      out[m] = {};
      for (const l of LIMBS) {
        const kinds = (l === 'lh' || l === 'rh') ? HAND_KINDS : LEG_KINDS;
        const v = ms && ms[m] && ms[m][l];
        out[m][l] = kinds.indexOf(v) >= 0 ? v : DEFAULT_MOVESET[m][l];
      }
    }
    return out;
  }
  // right foot forward? (a fighter with the lead prop or pocket item out stays orthodox: it lives in the left hand)
  function isSouthpaw(f) { return !!f.southpaw && !f.edge && !f.pocket; }
  const OTHER_SIDE = { lh: 'rh', rh: 'lh', ll: 'rl', rl: 'll' };
  function modOf(held) { return (held & IN.MOD3) ? 'mod3' : (held & IN.MOD2) ? 'mod2' : (held & IN.MOD1) ? 'mod1' : 'none'; }

  // ---------- Roster ----------
  // stats 0..1 : pow (power), spd (speed), chin, wre (wrestling), bjj (submissions / scrambles), car (cardio)
  const ROSTER = {
    striker: { key: 'striker', name: 'K. Varga', style: 'Striker', nick: 'The Hammer',
      stats: { pow: 0.9, spd: 0.8, chin: 0.7, wre: 0.45, bjj: 0.42, car: 0.62 },
      color: 0xd93b3b, skin: 0xe0b48c, desc: 'Devastating hands and head kicks. Weak off his back.' },
    wrestler: { key: 'wrestler', name: 'D. Okafor', style: 'Wrestler', nick: 'The Anchor',
      stats: { pow: 0.62, spd: 0.6, chin: 0.78, wre: 0.92, bjj: 0.55, car: 0.72 },
      color: 0x2f6fd9, skin: 0x6b4a2c, desc: 'Relentless takedowns, heavy top control and ground-and-pound.' },
    grappler: { key: 'grappler', name: 'R. Costa', style: 'Jiu-Jitsu', nick: 'Anaconda',
      stats: { pow: 0.48, spd: 0.66, chin: 0.56, wre: 0.6, bjj: 0.93, car: 0.66 },
      color: 0x2fb36b, skin: 0xc9956a, desc: 'Sweeps, scrambles and finishing submissions from anywhere.' },
    balanced: { key: 'balanced', name: 'J. Park', style: 'All-rounder', nick: 'Metronome',
      stats: { pow: 0.66, spd: 0.72, chin: 0.66, wre: 0.66, bjj: 0.64, car: 0.8 },
      color: 0xe8a62a, skin: 0xf0c9a0, desc: 'No holes in the game, elite cardio, wins late rounds.' }
  };

  // ---------- Strikes ----------
  // Tip paths are authored in the attacker's root frame as [t, fwd, side, height]:
  // fwd = metres towards the opponent, side = metres to the attacker's LEFT, height = metres above the mat.
  // t is seconds at time-factor 1; the whole path stretches with the strike's time factor (speed / fatigue).
  const HAND_GUARD = { lh: [0.34, 0.15, 1.27], rh: [0.22, -0.16, 1.24] };
  const FOOT_STANCE = { ll: [0.2, 0.16, 0], rl: [-0.24, -0.2, 0] };
  const TIP_R = { hand: 0.09, foot: 0.1, knee: 0.1 };
  const ARM_REACH = 0.71, LEG_REACH = 1.04, KNEE_REACH = 0.54;
  // rig proportions applied to the authored paths: forward-reach scale, and height offset (m) for hips / hands
  const REACH_SCALE = 1.06, Y_SHIFT = 0.06;

  // [windup, active, recover, damage, stamina] for lead (left) and rear (right) limbs
  const KIND_STATS = {
    straight: { lead: [0.12, 0.07, 0.16, 1.275, 2.5], rear: [0.20, 0.08, 0.24, 2.55, 4.5], part: 'head', names: ['jab', 'cross'] },
    hook:     { lead: [0.20, 0.08, 0.22, 2.465, 5.0], rear: [0.24, 0.08, 0.26, 2.975, 5.5], part: 'head', names: ['lead hook', 'right hook'] },
    uppercut: { lead: [0.18, 0.08, 0.22, 2.38, 5.0], rear: [0.23, 0.08, 0.26, 3.06, 5.5], part: 'head', names: ['lead uppercut', 'rear uppercut'] },
    overhand: { lead: [0.26, 0.09, 0.30, 2.72, 6.0], rear: [0.30, 0.09, 0.32, 3.57, 7.0], part: 'head', names: ['looping left', 'overhand right'] },
    hkick:    { lead: [0.28, 0.10, 0.34, 4.3, 9.0], rear: [0.34, 0.10, 0.38, 5.4, 10 ], part: 'head', names: ['lead head kick', 'head kick'] },
    bkick:    { lead: [0.24, 0.10, 0.30, 3.1, 7.0], rear: [0.28, 0.10, 0.34, 3.8, 8.0], part: 'body', names: ['lead body kick', 'body kick'] },
    lkick:    { lead: [0.18, 0.10, 0.24, 2.3, 5.0], rear: [0.22, 0.10, 0.28, 2.8, 6.0], part: 'legs', names: ['lead low kick', 'low kick'] },
    teep:     { lead: [0.16, 0.10, 0.24, 2.0, 5.0], rear: [0.22, 0.10, 0.28, 2.6, 6.0], part: 'body', names: ['teep', 'rear teep'], push: true },
    knee:     { lead: [0.16, 0.08, 0.24, 2.8, 6.0], rear: [0.18, 0.08, 0.26, 3.4, 6.5], part: 'body', names: ['lead knee', 'knee'] }
  };

  function handPath(limb, kind, w, a, r) {
    const s = limb === 'lh' ? 1 : -1, lead = limb === 'lh';
    const g = HAND_GUARD[limb], end = w + a + r;
    const G = [0, g[0], g[1], g[2]], E = [end, g[0], g[1], g[2]];
    switch (kind) {
      case 'straight': return [G, [w, g[0] - 0.08, s * 0.17, 1.3], [w + a * 0.75, lead ? 0.92 : 1.0, s * 0.02, 1.5], [w + a, lead ? 0.88 : 0.96, s * 0.02, 1.49], E];
      case 'hook':     return [G, [w, 0.28, s * 0.4, 1.4], [w + a * 0.35, 0.64, s * 0.3, 1.5], [w + a * 0.8, 0.86, -s * 0.06, 1.5], [w + a, 0.72, -s * 0.3, 1.48], E];
      case 'uppercut': return [G, [w, 0.2, s * 0.2, 1.0], [w + a * 0.7, 0.72, s * 0.05, 1.5], [w + a, 0.66, s * 0.04, 1.74], E];
      // overhand: out wide and up beside the head, over the top, then down AND across onto the jaw (a diagonal loop, not a chop)
      case 'overhand': return [G, [w * 0.5, 0.08, s * 0.34, 1.34], [w, 0.24, s * 0.44, 1.56], [w + a * 0.3, 0.58, s * 0.24, 1.6], [w + a * 0.8, 0.9, -s * 0.04, 1.42], [w + a, 0.84, -s * 0.18, 1.3], E];
    }
  }
  function legPath(limb, kind, w, a, r) {
    const s = limb === 'll' ? 1 : -1;
    const f = FOOT_STANCE[limb], end = w + a + r;
    const G = [0, f[0], f[1], f[2]], E = [end, f[0], f[1], f[2]];
    // Roundhouse kicks: the foot lifts out to the kicker's own side (the knee chambers high and
    // the hips turn over), then whips ACROSS the target in an arc and follows through past it.
    // s*0.6 is "out on the kicking side"; -s*0.45 is "past the centre line on the far side".
    const round = (chamberY, midY, hitY, hitF, followY) => [
      G,
      [w * 0.45, f[0] + 0.1, s * 0.42, chamberY * 0.45],
      [w, 0.3, s * 0.6, chamberY],
      [w + a * 0.35, hitF - 0.2, s * 0.4, midY],
      [w + a * 0.7, hitF, -s * 0.02, hitY],
      [w + a, hitF - 0.35, -s * 0.5, followY],
      [w + a + r * 0.45, 0.15, s * 0.3, chamberY * 0.5],
      E
    ];
    switch (kind) {
      case 'hkick': return round(0.75, 1.2, 1.48, 1.05, 1.3);
      case 'bkick': return round(0.55, 0.9, 1.08, 1.08, 0.95);
      case 'lkick': return round(0.32, 0.4, 0.42, 1.0, 0.45);
      // teep: knee comes up in front, then the foot drives straight out and back
      case 'teep':  return [G, [w * 0.6, 0.2, s * 0.12, 0.45], [w, 0.3, s * 0.1, 0.7], [w + a * 0.7, 1.12, s * 0.05, 1.02], [w + a, 1.05, s * 0.05, 1.0], [w + a + r * 0.5, 0.3, s * 0.12, 0.3], E];
      // knee: the path is the KNEE itself — it drives up and forward as the hips thrust in
      case 'knee':  return [G, [w, 0.12, s * 0.1, 0.5], [w + a * 0.7, 0.58, s * 0.06, 1.02], [w + a, 0.52, s * 0.06, 1.08], [w + a + r * 0.5, 0.15, s * 0.1, 0.45], E];
    }
  }

  // tip position [fwd, side, height] at time t (seconds since the strike started), path stretched by tf
  function strikeTip(st, t, tf, out) {
    const p = st.path, u = t / (tf || 1);
    out = out || [0, 0, 0];
    let k = p[p.length - 1];
    if (u <= p[0][0]) k = p[0];
    else {
      for (let i = 1; i < p.length; i++) {
        const k1 = p[i];
        if (u <= k1[0]) {
          const k0 = p[i - 1], s = (u - k0[0]) / Math.max(1e-6, k1[0] - k0[0]);
          out[0] = k0[1] + (k1[1] - k0[1]) * s; out[1] = k0[2] + (k1[2] - k0[2]) * s; out[2] = k0[3] + (k1[3] - k0[3]) * s;
          return out;
        }
      }
    }
    out[0] = k[1]; out[1] = k[2]; out[2] = k[3];
    return out;
  }

  const PART_R = { head: 0.15, body: 0.2, legs: 0.18 };
  const STRIKES = {};
  (function buildStrikes() {
    for (const limb of LIMBS) {
      const hand = limb === 'lh' || limb === 'rh';
      const lead = limb === 'lh' || limb === 'll';
      const s = lead ? 1 : -1;
      for (const kind of (hand ? HAND_KINDS : LEG_KINDS)) {
        const ks = KIND_STATS[kind], v = lead ? ks.lead : ks.rear;
        const st = {
          key: limb + '_' + kind, limb, kind, bit: LIMB_BIT[limb], name: ks.names[lead ? 0 : 1],
          w: v[0], a: v[1], r: v[2], dmg: v[3], stam: v[4], part: ks.part, push: !!ks.push,
          tip: hand ? 'hand' : kind === 'knee' ? 'knee' : 'foot',
          pivot: hand ? [0, s * 0.23, 1.36 + Y_SHIFT] : [0, s * 0.12, 0.86 + Y_SHIFT],
          reach: hand ? ARM_REACH : kind === 'knee' ? KNEE_REACH : LEG_REACH
        };
        st.path = hand ? handPath(limb, kind, st.w, st.a, st.r) : legPath(limb, kind, st.w, st.a, st.r);
        // scale the authored paths to the rig: forward reach, hands raised by Y_SHIFT, leg heights scaled by (1 + Y_SHIFT)
        for (const k of st.path) { if (k[1] > 0) k[1] *= REACH_SCALE; k[3] = hand ? k[3] + Y_SHIFT : k[3] * (1 + Y_SHIFT); }
        // impact keyframe: furthest-forward keyframe inside the active window
        let imp = null, best = -1e9, prev = null;
        for (let i = 0; i < st.path.length; i++) {
          const k = st.path[i];
          if (k[0] >= st.w - 1e-6 && k[0] <= st.w + st.a + 1e-6 && k[1] > best) { best = k[1]; imp = k; prev = st.path[i - 1]; }
        }
        st.impactT = imp[0];
        st.expExt = Math.hypot(imp[1] - st.pivot[0], imp[2] - st.pivot[1], imp[3] - st.pivot[2]);
        const segV = Math.hypot(imp[1] - prev[1], imp[2] - prev[2], imp[3] - prev[3]) / Math.max(1e-6, imp[0] - prev[0]);
        st.refSpeed = segV * 0.9;
        // root-to-root distance at which a clean impact lands on the intended region of a square-on opponent
        st.range = imp[1] + 0.06 + PART_R[st.part] + TIP_R[st.tip];
        STRIKES[st.key] = st;
      }
    }
    // ground strikes (top position): timed, always in range
    const G = {
      gpunch:  { w: 0.18, a: 0.05, r: 0.28, dmg: 1.36, stam: 3,   part: 'head', names: ['left hand', 'right hand'] },
      gelbow:  { w: 0.26, a: 0.05, r: 0.36, dmg: 2.7,  stam: 4.5, part: 'head', names: ['left elbow', 'right elbow'] },
      ghammer: { w: 0.24, a: 0.05, r: 0.34, dmg: 2.3,  stam: 4,   part: 'head', names: ['left hammer fist', 'right hammer fist'] },
      gbody:   { w: 0.20, a: 0.05, r: 0.30, dmg: 1.95, stam: 3,   part: 'body', names: ['left to the body', 'right to the body'] },
      gknee:   { w: 0.22, a: 0.05, r: 0.32, dmg: 2.2,  stam: 3.5, part: 'body', names: ['left knee to the body', 'right knee to the body'] }
    };
    for (const kind in G) {
      const g = G[kind];
      const limbs = kind === 'gknee' ? ['ll', 'rl'] : ['lh', 'rh'];
      limbs.forEach((limb, i) => {
        STRIKES[limb + '_' + kind] = { key: limb + '_' + kind, limb, kind, bit: LIMB_BIT[limb], name: g.names[i], w: g.w, a: g.a, r: g.r, dmg: g.dmg, stam: g.stam, part: g.part, ground: true, range: 9 };
      });
    }
  })();

  const SUBS = ['armbar', 'rear-naked choke', 'guillotine', 'kimura', 'triangle choke', 'americana', 'arm triangle'];

  // ---------- Ground positions ----------
  // Named from the top fighter's point of view. The bottom fighter 'has guard' in guard / half guard.
  const POS_NAME = { guard: 'closed guard', half: 'half guard', side: 'side control', mount: 'mount', back: 'back control' };
  // top strike damage multiplier by position, and whether the bottom can strike up
  const POS_STRIKE = { guard: 0.6, half: 0.7, side: 0.85, mount: 1.1, back: 0.8 };
  const BOTTOM_CAN_STRIKE = { guard: true, half: true, side: false, mount: false, back: false };
  // transition attempts: GRAPPLE pressed while holding a direction. Every attempt is timed and can be denied
  // by the other fighter holding BLOCK (basing / framing). to = new position, flip = reversal (attacker ends
  // on top in that position), stand = back to the feet, failTo = position the attacker gets punished into.
  const MOVES = {
    top: {
      guard: { FWD: { name: 'pass the guard', to: 'half', base: 0.42, dur: 0.9, stam: 6 } },
      half:  { FWD: { name: 'pass to side control', to: 'side', base: 0.42, dur: 0.8, stam: 6 } },
      side:  { FWD: { name: 'take mount', to: 'mount', base: 0.4, dur: 0.8, stam: 6 } },
      mount: {},
      back:  {}
    },
    bottom: {
      guard: { FWD: { name: 'stand up', stand: true, base: 0.52, dur: 1.0, stam: 7, failTo: 'half' },
               LEFT: { name: 'sweep', flip: 'half', base: 0.44, dur: 0.9, stam: 8 }, RIGHT: { name: 'sweep', flip: 'half', base: 0.44, dur: 0.9, stam: 8 } },
      half:  { BACK: { name: 'recover guard', to: 'guard', base: 0.62, dur: 0.7, stam: 4 },
               FWD: { name: 'stand up', stand: true, base: 0.44, dur: 1.0, stam: 8, failTo: 'side' },
               LEFT: { name: 'sweep', flip: 'half', base: 0.40, dur: 0.9, stam: 8 }, RIGHT: { name: 'sweep', flip: 'half', base: 0.40, dur: 0.9, stam: 8 } },
      side:  { BACK: { name: 'shrimp to half guard', to: 'half', base: 0.58, dur: 0.8, stam: 6 },
               FWD: { name: 'turn and stand', stand: true, base: 0.38, dur: 1.1, stam: 9, failTo: 'back' } },
      mount: { BACK: { name: 'elbow escape to half guard', to: 'half', base: 0.52, dur: 0.9, stam: 7 },
               LEFT: { name: 'bridge and roll', flip: 'guard', base: 0.40, dur: 0.9, stam: 9 }, RIGHT: { name: 'bridge and roll', flip: 'guard', base: 0.40, dur: 0.9, stam: 9 } },
      back:  { BACK: { name: 'turn in to half guard', to: 'half', base: 0.50, dur: 1.0, stam: 7 },
               FWD: { name: 'stand up', stand: true, base: 0.35, dur: 1.2, stam: 9 } }
    }
  };
  // submissions available by role and position (GRAPPLE with no direction)
  const SUBS_BY = {
    top:    { guard: ['guillotine'], half: ['kimura'], side: ['kimura', 'americana'], mount: ['armbar', 'arm triangle'], back: ['rear-naked choke'] },
    bottom: { guard: ['triangle choke', 'armbar', 'guillotine'], half: ['kimura'], side: [], mount: [], back: [] }
  };
  // where the defender ends up after escaping a submission
  function subEscapePos(attRole, pos) {
    if (attRole === 'bottom') return pos === 'guard' ? 'side' : 'side'; // scrambled out of the guard
    return { mount: 'half', side: 'half', half: 'guard', back: 'half', guard: 'guard' }[pos];
  }
  const DIR_KEYS = { FWD: IN.FWD, BACK: IN.BACK, LEFT: IN.LEFT, RIGHT: IN.RIGHT };
  // ground tuning
  const DENY_PENALTY = 0.08;    // odds lost when the other fighter is basing / framing during your attempt
  const PUNISH_CHANCE = 0.35;   // a denied failure gets pushed into mv.failTo this often
  const SUB_ATTEMPT_STAM = 5;   // stamina cost of a submission attempt
  const SUB_FAIL_CD = 2.0;      // attacker's cooldown (s) after a stuffed, lost or escaped submission
  const TD_FAIL_STUN = 0.25;     // multiplier on a failed takedown's stumble duration
  const TD_FAIL_CD = 3.0;       // seconds before the shooter may shoot again after a failed takedown
  const SUB_DECAY = 8;          // hold progress lost per second while not squeezing
  function dirOf(held) { for (const k in DIR_KEYS) if (held & DIR_KEYS[k]) return k; return null; }

  const CAGE_R = 3.9;      // max fighter radius from centre
  const MIN_DIST = 0.78;   // body collision distance
  const DT = 1 / 60;

  // ---------- Seeded RNG ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;

  // closest points between segments P0-P1 and Q0-Q1 (Ericson, Real-Time Collision Detection).
  // Returns [distance, s (param on P), t (param on Q)].
  function segSegClosest(p0x, p0y, p0z, p1x, p1y, p1z, q0x, q0y, q0z, q1x, q1y, q1z) {
    const d1x = p1x - p0x, d1y = p1y - p0y, d1z = p1z - p0z;
    const d2x = q1x - q0x, d2y = q1y - q0y, d2z = q1z - q0z;
    const rx = p0x - q0x, ry = p0y - q0y, rz = p0z - q0z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
    let s = 0, t = 0;
    if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
    else if (a <= 1e-9) { s = 0; t = clamp(f / e, 0, 1); }
    else {
      const c = d1x * rx + d1y * ry + d1z * rz;
      if (e <= 1e-9) { t = 0; s = clamp(-c / a, 0, 1); }
      else {
        const b = d1x * d2x + d1y * d2y + d1z * d2z, denom = a * e - b * b;
        s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
        else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
      }
    }
    const cx = p0x + d1x * s - (q0x + d2x * t), cy = p0y + d1y * s - (q0y + d2y * t), cz = p0z + d1z * s - (q0z + d2z * t);
    return [Math.sqrt(cx * cx + cy * cy + cz * cz), s, t];
  }

  function makeFighter(idx, key, name, color, moveset, extra) {
    const r = ROSTER[key] || ROSTER.balanced;
    extra = extra || {};
    const stats = Object.assign({}, r.stats);
    if (extra.stats) for (const k in stats) if (typeof extra.stats[k] === 'number') stats[k] = clamp(extra.stats[k], 0, 1);
    return {
      idx, key: r.key, name: name || r.name, style: extra.style || r.style,
      stats,
      color: color != null ? color : r.color, skin: extra.skin != null ? extra.skin : r.skin,
      moveset: normalizeMoveset(moveset),
      x: idx === 0 ? -1.3 : 1.3, z: 0,
      vx: 0, vz: 0,
      dmg: { head: clamp(extra.dmg && extra.dmg.head || 0, 0, 60), body: clamp(extra.dmg && extra.dmg.body || 0, 0, 60), legs: clamp(extra.dmg && extra.dmg.legs || 0, 0, 60) }, // starting damage carried in (career mode)
      stam: 100,
      stamMax: 100,       // ceiling stamina regens to; eroded by head/body damage and by swinging on empty
      act: { type: 'idle', name: '', t: 0, dur: 0, hit: false },
      buf: null,          // buffered strike {key, t}
      combo: 0, comboT: 0, // strikes chained without a pause
      lastStrike: '', repeatN: 0, // key of the last strike thrown and how many times in a row (see REPEAT_FREE)
      blocking: false,
      checking: false,    // lead leg lifted to check low kicks (CHECK held)
      southpaw: false,   // stance: right foot forward (see isSouthpaw)
      edge: false,        // lead prop out
      pocket: false,      // pocket item out; it replaces the lead prop
      ownEdge: false,
      ownPocket: false,
      blockTap: -9,       // sim time of the last BLOCK press (double tap = push)
      dirTap: -9, dirTapBit: 0, // sim time and key of the last direction press (the same key twice = lunge that way)
      lungeReady: -9,     // sim time the next lunge may start
      kickReady: -9,      // sim time the kicking foot is back on the mat: no kick can start before it
      restT: 0,           // seconds since he last blocked or threw: stamina regen ramps up the longer this runs
      rocked: 0,          // seconds remaining rocked
      rockLight: false,   // the current rock is a brief stun (slight wobble) rather than a heavy, leaning-back daze
      tdCd: 0,            // seconds until he may shoot again after a failed takedown
      wobble: 0,          // visual wobble intensity
      kdCount: 0,
      ground: null,       // null | 'top' | 'bottom'
      // round stats (reset per round)
      rs: { thrown: 0, landed: 0, sig: 0, td: 0, tdAtt: 0, ctrl: 0, subs: 0, kd: 0 },
      // total stats
      ts: { thrown: 0, landed: 0, sig: 0, td: 0, tdAtt: 0, ctrl: 0, subs: 0, kd: 0 },
      lastInput: 0
    };
  }
  const idleAct = () => ({ type: 'idle', name: '', t: 0, dur: 0, hit: false });
  // true while a kick's foot is off the mat: during the strike (including recovery) and until f.kickReady
  function kickInFlight(f, now) {
    if (now != null && now < f.kickReady) return true;
    if (f.act.type !== 'strike') return false;
    const st = STRIKES[f.act.name];
    return !!st && !st.ground && (st.limb === 'll' || st.limb === 'rl');
  }
  function isKickKey(key) { return key.startsWith('ll_') || key.startsWith('rl_'); }
  // A strike past its active window can be cancelled into the next action (combo flow),
  // except a slipped one: an over-committed whiff has to be ridden out.
  function recovering(f) {
    const a = f.act;
    if (a.type !== 'strike') return false;
    const st = STRIKES[a.name];
    const cancelAt = a.cancelAt != null ? a.cancelAt : (st.w + st.a) * a.tf;
    return !a.slipped && a.t >= cancelAt;
  }
  const PHYS_PUSH = 0.9; // teep shove (impulse per kg) in the physics model
  const BUFFER_T = 0.3; // seconds a buffered strike press stays valid
  const BODY_TOUGHNESS = 0.5; // body damage bar fills this much per point of damage (the stamina drain still uses the full hit)
  const LEG_TOUGHNESS = 1 / 1.3; // legs take 30% more punishment before the bar fills
  const PART_TOUGHNESS = { body: BODY_TOUGHNESS, legs: LEG_TOUGHNESS };
  // Sword in the lead (forward) hand. This direction is "forward and up" in the orthodox guard,
  // so the blade rests pointing at the other fighter. The swing carries that blade across him.
  const EDGE_DIR = [-0.091, -0.597, -0.797];
  const EDGE_HILT = [EDGE_DIR[0] * 0.08, -0.18 + EDGE_DIR[1] * 0.08, EDGE_DIR[2] * 0.08];
  const EDGE_TIP = [EDGE_DIR[0] * 0.86, -0.18 + EDGE_DIR[1] * 0.86, EDGE_DIR[2] * 0.86];
  const EDGE_PARRY = 0.18; // props closer than this (m) to each other lock
  const EDGE_HEAD_R = 0.20;
  const EDGE_HIT = 20;     // damage per clean cut (damage bars run 0..100)
  const POP_HIT = 50;       // damage per pocket-shot hit (0..100 bar)
  const EDGE_BODY_R = 0.30;
  // push: BLOCK tapped twice in quick succession stiff-arms the opponent off you
  const PUSH_TAP_T = 0.3;   // the second BLOCK tap has to come within this many seconds of the first
  const PUSH_DIST = 1.0;    // arm's length — any further and the push grabs air
  const PUSH_COST = 4;      // stamina
  const PUSH_SHOVE = 2.8;   // impulse per kg given to the opponent (cf. PHYS_PUSH for a teep)
  const PUSH_DUR = 0.38;    // seconds the pusher is committed
  const PUSH_STUN_DIST = PUSH_DIST * 0.5; // stumble / stagger applies only inside this range; beyond it the push just shoves
  // lunge: a direction key tapped twice quickly bursts that way to close / make distance or angle off
  const LUNGE_TAP_T = 0.28;  // the second tap has to come within this many seconds of the first
  const LUNGE_DUR = 0.32;    // seconds the burst lasts (it tapers off over the back half)
  const LUNGE_IN = 3.2;      // extra speed (m/s) on top of his step, lunging in
  const LUNGE_OUT = 2.7;     // ... and backing out
  const LUNGE_SIDE = 2.9;    // ... and angling off to either side
  const LUNGE_COST = 4;      // stamina
  const LUNGE_CD = 0.55;     // seconds from one lunge to the next
  // stamina economy
  const MISS_PENALTY = 0.30;   // a whiffed strike costs this much extra (fraction of its cost)
  const CLEAN_REFUND = 0.33;   // an unblocked landing gives this much of its cost back
  const BLOCK_REWARD = 0.08;   // a strike taken on a raised guard gives the BLOCKER this much of its cost
  const GROUND_BLOCK_REWARD = 0.4; // stamina for covering a ground strike
  const STAM_MAX_FLOOR = 30;   // lower bound for max-stamina erosion
  const EMPTY_SWING_COST = 1.5; // max stamina lost per strike press made with an empty tank
  const OVERDRAW_COST = 0.5;   // max stamina lost per point a strike overdraws the tank
  const ROUND_MAX_RECOVERY = 20; // max stamina regained in the corner
  const BREAK_T = 5;            // seconds between rounds
  // rest ramp: regen doubles every REST_DOUBLE_T seconds spent neither blocking nor striking, up to REST_MAX x.
  // Blocking or throwing anything resets it (f.restT).
  const REST_DOUBLE_T = 1.2;
  const REST_MAX = 4;
  const CHECK_DMG = 0.10;      // a checked low kick does this share of its damage to the defender's legs...
  const CHECK_SELF_DMG = 0.15; // ...and this share of it to the kicker's own legs
  const KICK_CANCEL_DMG = 2.8; // min damage of a clean hand strike that cancels the opponent's kick in flight
  const KICK_CANCEL_BONUS = 1.3; // damage multiplier for that kick-cancelling strike
  const KICK_CANCEL_STUN = 0.3; // extra seconds of hit-stun for being caught on one leg
  // spamming: the same strike thrown more than REPEAT_FREE times in a row loses half its power per extra throw
  // (3rd = x0.5, 4th = x0.25, ...); any different strike resets the count
  const REPEAT_FREE = 2;
  // hitstun halves the same way (3rd = x0.5, 4th = x0.25) and is gone from the throw after STUN_REPEAT_MAX on
  const STUN_REPEAT_MAX = 4;
  const KICK_PLANT_T = 0.2;     // seconds after a kick ends before the foot is planted enough to kick again
  const TEEP_PLANT_T = 0.2;     // same, after a teep
  // rocked / knockdown tuning
  const ROCK_TIME_MULT = 0.35;  // scales every rocked duration
  const ROCK_T0 = 1.3, ROCK_PER_DMG = 0.05; // seconds rocked = (ROCK_T0 + dmg * ROCK_PER_DMG) * ROCK_TIME_MULT
  const ROCK_HEAVY_P = 0.15;    // chance a rocking shot is a heavy daze (wobble pose, leans back); otherwise a brief stun
  const ROCK_LIGHT_T = 0.35;    // seconds rocked by a light (stun) rock
  const ROCK_LIGHT_WOBBLE = 0.15; // ragdoll wobble during a light rock: below the WOBBLE pose threshold, just small shoves
  const KD_THR_MIN = 3.4;       // weakest head shot that drops an already-rocked fighter
  const KD_THR_FRAC = 0.62;     // ...or this fraction of his rock threshold, whichever is higher
  const KD_FLASH_FRAC = 1.9;    // a shot this many times the rock threshold drops him outright
  const KD_FALL = 1.0;          // seconds a knocked-down fighter is falling / limp before he can do anything
  const KD_STAY = 4.0;          // longest he may stay down before the referee waves him up
  const KD_RISE = 1.0;          // seconds it takes him to climb back to his feet
  const KD_ROCKED = 3.2;        // rocked time set by a knockdown (before ROCK_TIME_MULT)
  const KD_DOWN_RECOVER = 2.5;  // rocked timer drains this many times faster while he stays down
  const KD_FOLLOW_DIST = 2.3;   // the attacker can dive on him from this far (takedown key)
  const KD_SHOVE = 0.5;         // impulse per kg the knockdown blow gives the falling body
  const KD_RISE_KEYS = DIR_BITS | IN.DODGE; // a direction or the stand-up key gets a downed fighter up

  class Sim {
    constructor(opts) {
      opts = opts || {};
      this.rand = mulberry32(opts.seed != null ? opts.seed : 1337);
      this.settings = { rounds: opts.rounds || 3, roundLen: opts.roundLen || 180, grappling: opts.grappling !== false };
      const p = opts.players || [{}, {}];
      this.state = {
        t: 0,                     // sim time
        phase: 'intro',           // intro | fight | break | over
        phaseT: 0,
        round: 1,
        clock: this.settings.roundLen,
        rounds: this.settings.rounds,
        roundLen: this.settings.roundLen,
        grappling: this.settings.grappling, // false = striking only: no takedowns, knockdowns are standing eight-counts
        f: [makeFighter(0, p[0].fighter || 'striker', p[0].name, p[0].color, p[0].moveset, p[0]),
            makeFighter(1, p[1].fighter || 'wrestler', p[1].name, p[1].color, p[1].moveset, p[1])],
        ground: null,             // { top, bottom, pos, trans, sub, ctrlT, idleT, cd:[..] }
        cards: [],                // per round [{p0, p1, j:[[10,9],[10,9],[10,9]]}]
        result: null,
        evSeq: 0
      };
      this.events = [];           // {seq, k, ...}
      this.roundScore = [{}, {}];
      this._resetRoundScore();
      this.inputs = [{ held: 0, pressed: 0 }, { held: 0, pressed: 0 }];
      this._bits = [];
      // physics (standing game). Off for guest placeholders / menu demos.
      const PH = root.MMAPhys;
      this.phys = null;
      // training (the career gym): fighter 1 is a heavy bag (opts.world.bag), the round never ends, nothing is stopped
      this.training = !!opts.training;
      if (this.training) {
        const F = this.state.f;
        if (opts.spawn) { F[0].x = opts.spawn.x; F[0].z = opts.spawn.z; }
        const bag = opts.world && opts.world.bag;
        if (bag) { F[1].x = bag.x; F[1].z = bag.z; }
        this.state.phase = 'fight';
        this.state.clock = this.state.roundLen = Infinity;
      }
      if (opts.physics !== false && PH && PH.ready()) {
        const F = this.state.f;
        this.phys = new PH.World(Object.assign({}, opts.world, { rand: this.rand, positions: [[F[0].x, F[0].z], [F[1].x, F[1].z]] }));
        this.state.phys = true;
        // the AI and the stamina economy read ranges / costs from STRIKES: use the physical ones
        if (!STRIKES._physTuned) {
          for (const k in PH.STRIKES) if (STRIKES[k]) { STRIKES[k].range = PH.STRIKES[k].range; STRIKES[k].stam = PH.STRIKES[k].cost; STRIKES[k].part = PH.STRIKES[k].part; STRIKES[k].name = PH.STRIKES[k].name; }
          Object.defineProperty(STRIKES, '_physTuned', { value: true, enumerable: false });
        }
      }
    }

    destroy() { if (this.phys) { this.phys.free(); this.phys = null; } }

    // -------- public --------
    setInput(i, held, pressed) {
      this.inputs[i].held = held | 0;
      this.inputs[i].pressed |= (pressed | 0);
    }

    step(dt) {
      // real-time accumulator: exactly 60 ticks per simulated second regardless of monitor refresh rate
      this.acc = (this.acc || 0) + Math.min(dt, 0.25);
      let n = 0;
      while (this.acc >= DT && n < 8) { this._tick(DT); this.acc -= DT; n++; }
      if (n > 0) { this.inputs[0].pressed = 0; this.inputs[1].pressed = 0; }
    }

    drainEvents() { const e = this.events; this.events = []; return e; }

    // -------- internals --------
    _emit(ev) { ev.seq = ++this.state.evSeq; ev.t = this.state.t; this.events.push(ev); return ev; }

    _resetRoundScore() {
      for (const f of this.state.f) f.rs = { thrown: 0, landed: 0, sig: 0, td: 0, tdAtt: 0, ctrl: 0, subs: 0, kd: 0 };
    }

    _tick(dt) {
      const S = this.state;
      S.t += dt; S.phaseT += dt;
      switch (S.phase) {
        case 'intro':
          if (this.phys) this._physTick(dt);
          if (S.phaseT >= 3.2) { S.phase = 'fight'; S.phaseT = 0; this._emit({ k: 'bell', round: S.round }); }
          break;
        case 'fight':
          this._fightTick(dt);
          break;
        case 'break':
          if (S.phaseT >= BREAK_T) this._startRound();
          break;
        case 'over':
          this._cooldown(dt);
          if (this.phys && !S.ground) this._physTick(dt);
          break;
      }
    }

    _startRound() {
      const S = this.state;
      S.round++;
      S.clock = this.settings.roundLen;
      S.phase = 'intro'; S.phaseT = 1.2;
      for (const f of S.f) {
        f.x = f.idx === 0 ? -1.3 : 1.3; f.z = 0; f.vx = 0; f.vz = 0;
        f.act = idleAct();
        f.rocked = 0; f.ground = null; f.blocking = false;
      }
      S.ground = null;
      this._resetRoundScore();
      if (this.phys) { this.phys.place(S.f[0], S.f[1]); this.phys.setActive(true); for (const f of S.f) f.pose = null; }
      this._emit({ k: 'round', round: S.round });
    }

    _endRound(finished) {
      const S = this.state;
      // score the round
      const sc = S.f.map(f => f.rs.sig * 1.0 + f.rs.landed * 0.35 + f.rs.td * 6 + f.rs.ctrl * 0.45 + f.rs.subs * 5 + f.rs.kd * 12);
      const judges = [];
      for (let j = 0; j < 3; j++) {
        const bias = j === 0 ? 0 : (this.rand() - 0.5) * 8; // judges see it a little differently
        const d = (sc[0] - sc[1]) + bias;
        let a = 10, b = 10;
        if (Math.abs(d) >= 2) {
          if (d > 0) { b = 9; if (d >= 48 || (S.f[0].rs.kd > 0 && d >= 30)) b = 8; }
          else { a = 9; if (-d >= 48 || (S.f[1].rs.kd > 0 && -d >= 30)) a = 8; }
        }
        judges.push([a, b]);
      }
      S.cards.push({ round: S.round, p0: Math.round(sc[0]), p1: Math.round(sc[1]), j: judges });
      for (const f of S.f) for (const k in f.rs) f.ts[k] += f.rs[k];
      if (finished) return;
      this._emit({ k: 'bell', end: true, round: S.round });
      if (S.round >= S.rounds) {
        this._decision();
      } else {
        S.phase = 'break'; S.phaseT = 0; S.ground = null;
        if (this.phys) { this.phys.setActive(false); for (const f of S.f) f.pose = null; }
        for (const f of S.f) {
          f.ground = null; f.act = idleAct();
          // corner recovery
          f.stamMax = Math.min(100, f.stamMax + ROUND_MAX_RECOVERY);
          f.stam = f.stamMax;
          f.dmg.head = Math.max(0, f.dmg.head - 10);
          f.dmg.body = Math.max(0, f.dmg.body - 8);
          f.dmg.legs = Math.max(0, f.dmg.legs - 5);
          f.rocked = 0;
        }
      }
    }

    _decision() {
      const S = this.state;
      const tot = [[0, 0], [0, 0], [0, 0]];
      for (const c of S.cards) for (let j = 0; j < 3; j++) { tot[j][0] += c.j[j][0]; tot[j][1] += c.j[j][1]; }
      let w0 = 0, w1 = 0;
      for (let j = 0; j < 3; j++) { if (tot[j][0] > tot[j][1]) w0++; else if (tot[j][1] > tot[j][0]) w1++; }
      let winner = null, type = 'Draw';
      if (w0 >= 2) { winner = 0; type = w0 === 3 ? 'Unanimous Decision' : 'Split Decision'; }
      else if (w1 >= 2) { winner = 1; type = w1 === 3 ? 'Unanimous Decision' : 'Split Decision'; }
      else type = 'Majority Draw';
      this._finish({ method: type, winner, round: S.round, time: 0, totals: tot });
    }

    _finish(res) {
      const S = this.state;
      S.result = res; S.phase = 'over'; S.phaseT = 0;
      for (const f of S.f) f.blocking = false;
      this._emit({ k: 'end', res });
    }

    _cooldown(dt) {
      for (const f of this.state.f) {
        if (f.act.type !== 'idle' && f.act.type !== 'down') {
          f.act.t += dt; if (f.act.t >= f.act.dur) f.act = idleAct();
        }
      }
    }

    // unit vectors of f's frame: fwd towards o, left = fwd rotated 90°
    _frame(f, o) {
      const dx = o.x - f.x, dz = o.z - f.z;
      const d = Math.hypot(dx, dz) || 0.001;
      const fx = dx / d, fz = dz / d;
      return { fx, fz, lx: -fz, lz: fx, d };
    }

    // ---------------------------------------------------------
    _fightTick(dt) {
      const S = this.state;
      S.clock -= dt;
      const F = S.f;
      const dx = F[1].x - F[0].x, dz = F[1].z - F[0].z;
      const dist = Math.hypot(dx, dz) || 0.001;
      const ux = dx / dist, uz = dz / dist;

      // stamina / timers
      for (const f of F) {
        if (f.tdCd > 0) f.tdCd = Math.max(0, f.tdCd - dt);
        if (f.rocked > 0) { f.rocked -= dt * (f.act.type === 'kd' && f.act.name === 'down' ? KD_DOWN_RECOVER : 1); if (f.rocked < 0) f.rocked = 0; }
        if (f.rocked <= 0) f.rockLight = false;
        f.wobble = Math.max(0, f.wobble - dt * 0.8);
        if (f.blocking) f.restT = 0; else f.restT += dt;
        let regen = 2.2 + f.stats.car * 4.5;
        regen *= Math.min(REST_MAX, Math.pow(2, f.restT / REST_DOUBLE_T));
        regen *= (1 - f.dmg.body / 160);
        if (f.blocking) regen *= 0.75;
        if (f.act.type === 'move') regen *= 0.85;
        if (f.ground === 'bottom') regen *= (S.ground && (S.ground.pos === 'mount' || S.ground.pos === 'back')) ? 0.45 : 0.7;
        if (S.ground && S.ground.sub) regen = 0;
        f.stam = clamp(f.stam + regen * dt, 0, f.stamMax);
      }

      if (S.ground) this._groundTick(dt);
      else this._standTick(dt, dist, ux, uz);

      // no ragdoll: the blade is tested before strikes resolve so a cut can mark the punch as spent
      if (!this.phys && !S.ground) this._edgeExchange();

      // actions progress
      for (const f of F) {
        const a = f.act;
        if (a.type === 'idle' || a.type === 'move' || a.type === 'down') continue;
        a.t += dt;
        if (a.type === 'strike') {
          const st = STRIKES[a.name];
          const tf = a.tf;
          if (st.ground) {
            if (!a.hit && a.t >= st.w * tf) { a.hit = true; this._resolveGroundStrike(f, st); }
          } else if (a.phys) {
            // physical strike: contacts are resolved in _physTick after the world steps
          } else if (!a.hit && !S.ground) {
            const t0 = st.w * tf * 0.45, t1 = (st.w + st.a) * tf;
            if (a.pop || a.edge) {
              // the lead prop, or the pocket hit, already resolved this; a lead hand that never arrived is just a miss
              if (a.pop && !a.popFired && a.t >= 0.08 * (a.tf || 1)) this._releaseShot(f);
              if (!a.hit && a.t >= t1) { a.hit = true; if (!a.popFired) this._whiff(f, st); }
            } else if (a.t >= t0) {
              this._traceStrike(f, st, dt);
              if (!a.hit && a.t >= t1) { a.hit = true; this._whiff(f, st); }
            }
          }
          if (a.t >= a.dur && f.act === a) f.act = idleAct();
        } else if (a.type === 'takedown') {
          if (!a.hit && a.t >= 0.32) { a.hit = true; this._resolveTakedown(f); }
          if (a.t >= a.dur && f.act === a) f.act = idleAct();
        } else if (a.t >= a.dur) {
          f.act = idleAct();
        }
      }

      // standing physics: ragdolls move, strike, collide; contacts become hits
      if (this.phys && !S.ground) this._physTick(dt);
      else if (S.phase === 'fight' && !S.ground) { this._releaseShots(); this._stepBullets(dt); }

      // round / finish checks
      if (S.phase === 'fight') {
        const stop = this._checkStoppage();
        if (!stop && S.clock <= 0) { S.clock = 0; this._endRound(false); }
      }
    }

    _checkStoppage() {
      const S = this.state;
      if (this.training) {
        // the bag soaks up everything and is fresh again for the next shot
        const b = S.f[1];
        b.dmg.head = b.dmg.body = b.dmg.legs = 0; b.rocked = 0; b.wobble = 0; b.stam = b.stamMax = 100;
        return false;
      }
      for (const f of S.f) {
        const o = S.f[1 - f.idx];
        let method = null;
        if (f.dmg.head >= 100) method = f._fatality ? 'FATALITY' : 'KO';
        else if (f.dmg.body >= 100) method = f._fatality ? 'FATALITY' : 'TKO (body)';
        else if (f.dmg.legs >= 100) method = 'TKO (leg kicks)';
        else if (f.ground && f.dmg.head >= 92 && f.act.type === 'hit') method = 'TKO (ground strikes)';
        if (method) {
          f.act = { type: 'down', name: '', t: 0, dur: 99, hit: false };
          o.act = { type: 'celebrate', name: '', t: 0, dur: 99, hit: false };
          const min = Math.floor((S.roundLen - S.clock) / 60), sec = Math.floor((S.roundLen - S.clock) % 60);
          this._endRound(true);
          this._emit({ k: 'ko', i: o.idx, j: f.idx, method });
          this._finish({ method, winner: o.idx, round: S.round, time: min + ':' + (sec < 10 ? '0' : '') + sec });
          return true;
        }
      }
      return false;
    }

    // ---------------------------------------------------------
    //  STANDING
    // ---------------------------------------------------------
    _standTick(dt, dist, ux, uz) {
      const S = this.state, F = S.f;
      for (let i = 0; i < 2; i++) {
        const f = F[i];
        const inp = this.inputs[i];
        const held = inp.held, pressed = inp.pressed;
        const striking = f.act.type === 'strike';
        const canCancel = recovering(f);
        const busy = f.act.type !== 'idle' && f.act.type !== 'move' && !canCancel;
        if (f.comboT > 0) { f.comboT -= dt; if (f.comboT <= 0) f.combo = 0; }
        // a limb pressed while a strike is still live is remembered and fired the moment it can be
        if (striking && !canCancel && (pressed & LIMB_BITS)) {
          const key = this._pickStrikeKey(f, pressed, held, false);
          if (key) f.buf = { key, t: S.t };
        }
        const sign = i === 0 ? 1 : -1; // direction towards opponent along (ux,uz)

        // facing vector towards opponent
        const fx = ux * sign, fz = uz * sign;
        // lateral (circle) vector = fighter's left
        const lx = -fz, lz = fx;

        f.blocking = !busy && !!(held & IN.BLOCK) && f.rocked <= 0.4;
        f.checking = !busy && !striking && !!(held & IN.CHECK) && f.rocked <= 0.4;
        // BLOCK tapped twice quickly = push (the taps are remembered even mid-strike, the push waits until he is free)
        let push = false;
        if (pressed & IN.BLOCK) { push = S.t - f.blockTap <= PUSH_TAP_T; f.blockTap = push ? -9 : S.t; }
        // a direction key tapped twice quickly = lunge that way (in / out / left / right)
        let lunge = 0;
        for (const bit of [IN.FWD, IN.BACK, IN.LEFT, IN.RIGHT]) {
          if (!(pressed & bit)) continue;
          if (f.dirTapBit === bit && S.t - f.dirTap <= LUNGE_TAP_T) { lunge = bit; f.dirTap = -9; f.dirTapBit = 0; }
          else { f.dirTap = S.t; f.dirTapBit = bit; }
        }
        const rag = this.phys.fighters[i];
        rag.move[0] = 0; rag.move[1] = 0;

        // knocked down: fall -> down (his choice: get up now, or stay down a while and recover) -> rise
        if (f.act.type === 'kd') { this._kdTick(f, i, held, pressed); continue; }

        // movement — allowed while striking at half speed, so you can step into (or away from) shots
        if (!busy || striking) {
          const slow = (1 - f.dmg.legs / 140) * (f.rocked > 0 ? 0.45 : 1) * (0.7 + f.stam / 330) * (f.blocking ? 0.8 : 1) * (f.checking ? 0.5 : 1);
          const spd = (1.9 + f.stats.spd * 1.0) * slow;
          // hand the ragdoll a local move vector (x = its right, z = toward the opponent)
          let rx = 0, rz = 0;
          if (held & IN.FWD) rz += 1;
          if (held & IN.BACK) rz -= 1;
          if (held & IN.LEFT) rx -= 1;
          if (held & IN.RIGHT) rx += 1;
          rag.move[0] = rx; rag.move[1] = rz; rag.moveSpeed = spd / 1.9;
          if (rx || rz) { if (!busy) f.act = { type: 'move', name: '', t: 0, dur: 0, hit: false }; }
          else if (f.act.type === 'move') f.act = idleAct();
          if (lunge && S.t >= f.lungeReady && f.stam > LUNGE_COST && f.rocked <= 0) {
            f.stam -= LUNGE_COST; f.restT = 0; f.lungeReady = S.t + LUNGE_CD;
            const legs = 1 - f.dmg.legs / 140;
            const k = (0.85 + f.stats.spd * 0.3) * legs;
            const fwd = lunge === IN.FWD ? LUNGE_IN : lunge === IN.BACK ? -LUNGE_OUT : 0;
            const side = lunge === IN.RIGHT ? LUNGE_SIDE : lunge === IN.LEFT ? -LUNGE_SIDE : 0;
            rag.dash(fwd * k, LUNGE_DUR, side * k);
          }
        }

        if (!busy && (pressed & IN.STANCE)) {
          f.southpaw = !f.southpaw;
          this._emit({ k: 'stance', i, southpaw: f.southpaw });
        }
        if (!busy) {
          // actions (press-triggered)
          if (push && f.stam > PUSH_COST && f.rocked <= 0) {
            this._push(f, F[1 - i], dist, fx, fz);
          } else if (pressed & IN.DODGE && f.stam > 6 && f.rocked <= 0) {
            f.stam -= 5;
            f.act = { type: 'dodge', name: '', t: 0, dur: 0.45, hit: false };
            f.blocking = false;
            const out = isSouthpaw(f) ? -0.4 : 0.4;
            rag.shove(lx * out - fx * 0.3, lz * out - fz * 0.3, 1.1); // slip outside the lead shoulder
          } else if (pressed & IN.GRAPPLE && S.grappling && this._canFollow(f, F[1 - i], dist)) {
            // dive on a knocked-down opponent: flat on his back he gives up side control, half guard if he was already rising
            const o = F[1 - i];
            this._emit({ k: 'follow', i, j: 1 - i });
            this._enterGround(f, o, 'kd', o.act.name === 'down' ? 'side' : 'half');
            return;
          } else if (pressed & IN.GRAPPLE && f.rocked <= 0 && S.grappling) {
            if (dist <= 1.7 && f.stam > 8 && !(f.tdCd > 0)) {
              f.stam -= 7; f.rs.tdAtt++;
              f.act = { type: 'takedown', name: '', t: 0, dur: 0.75, hit: false };
              f.blocking = false;
              this._emit({ k: 'shoot', i });
            }
          } else if (pressed & LIMB_BITS) {
            const key = this._pickStrikeKey(f, pressed, held, false);
            // no kicking with a leg already off the ground: a kick pressed mid-kick waits (buffered) for the foot to land
            if (key && isKickKey(key) && kickInFlight(f, S.t)) f.buf = { key, t: S.t };
            else if (key) this._startStrike(f, key, canCancel);
          } else if (f.buf && S.t - f.buf.t <= BUFFER_T && !(isKickKey(f.buf.key) && kickInFlight(f, S.t))) {
            this._startStrike(f, f.buf.key, canCancel);
          }
          if (f.buf && (f.act.type !== 'strike' || S.t - f.buf.t > BUFFER_T || f.act.t === 0)) f.buf = null;
        }
      }
    }

    // stiff-arm: lands inside PUSH_DIST, harder the closer he is, and interrupts his action (a strike in flight is
    // cancelled; its stamina stays spent). Has no effect on a knocked-down fighter.
    _push(f, o, dist, fx, fz) {
      const S = this.state;
      f.stam = Math.max(0, f.stam - PUSH_COST);
      f.act = { type: 'push', name: '', t: 0, dur: PUSH_DUR, hit: false };
      f.blocking = false; f.buf = null; f.restT = 0;
      const rag = this.phys.fighters[f.idx];
      const orag = this.phys.fighters[o.idx];
      const ok = dist <= PUSH_DIST && o.act.type !== 'kd' && o.act.type !== 'down';
      if (ok) {
        const w = 0.6 + 0.4 * clamp(1 - (dist - MIN_DIST) / (PUSH_DIST - MIN_DIST), 0, 1); // closer = more of the push lands
        const ot = o.act.type;
        const stuns = dist <= PUSH_STUN_DIST;
        if (stuns && (ot === 'idle' || ot === 'move' || ot === 'strike' || ot === 'dodge' || ot === 'sprawl')) {
          o.act = { type: 'stumble', name: 'push', t: 0, dur: (0.45 * w + 0.1) * 0.5, hit: false };
          o.blocking = false; o.buf = null;
        }
        orag.shove(fx, fz, PUSH_SHOVE * w); if (stuns) orag.stagger(0.15 * w);
        rag.shove(-fx, -fz, 0.2 * w); // equal and opposite: a little of it comes back through his arms
        f.act.hit = true;
      }
      this._emit({ k: 'push', i: f.idx, j: o.idx, ok, t: S.t });
    }

    // the attacker may dive on a knocked-down opponent while he is falling, lying there, or just starting to get up
    _canFollow(f, o, dist) {
      const a = o.act;
      if (a.type !== 'kd' || dist > KD_FOLLOW_DIST) return false;
      return a.name !== 'rise' || a.t < 0.3;
    }

    // knocked-down fighter: act.name is the phase. 'fall' (limp, KD_FALL s) -> 'down' (he can get up with a direction /
    // the stand-up key, or stay down and recover faster, up to KD_STAY s) -> 'rise' (KD_RISE s) -> idle, still rocked.
    _kdTick(f, i, held, pressed) {
      const a = f.act, rag = this.phys.fighters[i];
      f.blocking = false; f.buf = null;
      if (a.name === 'fall' && a.t >= KD_FALL) { a.name = 'down'; a.t = 0; }
      if (a.name === 'down') {
        // a press works at once; a key that was already held when he hit the mat has to be held a moment longer
        const wants = (pressed & KD_RISE_KEYS) || (a.t > 0.25 && (held & KD_RISE_KEYS));
        if (wants || a.t >= KD_STAY) {
          a.name = 'rise'; a.t = 0;
          rag.getUp(KD_RISE);
          this._emit({ k: 'getup', i, forced: !wants });
        }
      }
      if (a.name === 'rise' && a.t >= KD_RISE) f.act = idleAct();
    }

    // limb pressed + modifier held -> strike key, via the fighter's moveset
    _pickStrikeKey(f, pressed, held, ground) {
      let limb = null;
      for (const l of LIMBS) if (pressed & LIMB_BIT[l]) { limb = l; break; }
      if (!limb) return null;
      const mod = modOf(held);
      if (ground) {
        const hand = limb === 'lh' || limb === 'rh';
        const kind = !hand ? 'gknee' : mod === 'mod1' ? 'gelbow' : mod === 'mod2' ? 'ghammer' : mod === 'mod3' ? 'gbody' : 'gpunch';
        return limb + '_' + kind;
      }
      const kind = f.moveset[mod][limb];
      // strike keys are lead / rear (orthodox: left leads). Southpaw, the button's own hand or leg is the other
      // side's strike, which the mirrored ragdoll throws with that same hand or leg.
      const side = isSouthpaw(f) ? OTHER_SIDE[limb] : limb;
      const key = side + '_' + kind;
      return STRIKES[key] ? key : side + '_' + DEFAULT_MOVESET[mod][limb];
    }

    _startStrike(f, key, chained) {
      const st = STRIKES[key];
      if (f.stam < 3) { // swinging on empty wears the tank down
        f.stamMax = Math.max(STAM_MAX_FLOOR, f.stamMax - EMPTY_SWING_COST);
        f.stam = Math.min(f.stam, f.stamMax); f.buf = null;
        return;
      }
      let tf = (1.15 - f.stats.spd * 0.3) * (1 + (1 - f.stam / 100) * 0.4) * (f.rocked > 0 ? 1.3 : 1);
      f.combo = chained ? Math.min(3, f.combo + 1) : 0;
      f.comboT = 0.45;
      f.buf = null;
      const drawn = !!f.pocket;
      const baseKind = (f.moveset && f.moveset.none && f.moveset.none.lh) || 'uppercut';
      const popFire = !!(drawn && st.limb === 'lh' && st.kind === baseKind && !st.ground);
      const edgeSwing = !!(f.edge && !drawn && st.limb === 'lh' && !st.ground && !popFire);
      const edgeDef = edgeSwing && root.MMAPhys.EDGE_MOVES && root.MMAPhys.EDGE_MOVES[st.kind];
      const pdef = this.phys && !st.ground ? (edgeDef || root.MMAPhys.STRIKES[key]) : null;
      const baseCost = (!edgeSwing && pdef && pdef.cost) ? pdef.cost : st.stam;
      const cost = baseCost * (f.stam < 25 ? 0.6 : 1) * (chained ? 1.1 : 1);
      if (cost > f.stam) f.stamMax = Math.max(STAM_MAX_FLOOR, f.stamMax - (cost - f.stam) * OVERDRAW_COST); // overdrawing the tank erodes it
      f.stam = Math.max(0, Math.min(f.stam, f.stamMax) - cost);
      if (pdef) {
        const wind = pdef.active ? pdef.active[0] : pdef.w;
        const live = pdef.active ? pdef.active[1] - pdef.active[0] : pdef.a;
        f.act = { type: 'strike', name: key, t: 0, dur: pdef.dur * tf, tf, hit: false, slipped: false, chained: !!chained, cost, phys: true, cancelAt: (wind + live) * tf, pop: popFire, edge: edgeSwing };
        this.phys.fighters[f.idx].startStrike(pdef, tf);
      } else {
        f.act = { type: 'strike', name: key, t: 0, dur: (edgeSwing ? 0.66 : (st.w + st.a + st.r)) * tf, tf, hit: false, tip: null, tipT: null, slipped: false, chained: !!chained, cost, cancelAt: (edgeSwing ? 0.40 : (st.w + st.a)) * tf, pop: popFire, edge: edgeSwing };
      }
      f.repeatN = key === f.lastStrike ? f.repeatN + 1 : 1;
      f.lastStrike = key;
      f.act.powMul = Math.pow(0.5, Math.max(0, f.repeatN - REPEAT_FREE));
      f.act.stunMul = f.repeatN > STUN_REPEAT_MAX ? 0 : f.act.powMul;
      f.blocking = false; f.restT = 0;
      f.rs.thrown++;
      // the next kick waits until this one's foot has planted (see kickInFlight)
      if (!st.ground && (st.limb === 'll' || st.limb === 'rl')) f.kickReady = this.state.t + f.act.dur + (st.push ? TEEP_PLANT_T : KICK_PLANT_T);
    }

    _hitboxes(o, f) {
      const fr = this._frame(o, f); // o's frame, facing f
      const W = (p) => [o.x + fr.fx * p[0] + fr.lx * p[1], p[2], o.z + fr.fz * p[0] + fr.lz * p[1]];
      let head = [0.06, 0, 1.52 + Y_SHIFT], torsoA = [0.0, 0, 0.95 + Y_SHIFT], torsoB = [0.03, 0, 1.2 + Y_SHIFT];
      const a = o.act;
      if (a.type === 'dodge' && a.t < 0.32) { head = [-0.08, 0.34, 1.36 + Y_SHIFT]; torsoB = [-0.02, 0.12, 1.16 + Y_SHIFT]; }
      else if (a.type === 'hit') {
        if (a.name === 'head') head = [-0.14, 0, 1.5 + Y_SHIFT];
        else if (a.name === 'body') { head = [0.2, 0, 1.3 + Y_SHIFT]; torsoB = [0.15, 0, 1.12 + Y_SHIFT]; }
        else head = [0.06, 0.1, 1.42 + Y_SHIFT];
      } else if (a.type === 'stumble' || a.type === 'takedown') { head = [0.32, 0, 1.2 + Y_SHIFT]; torsoB = [0.25, 0, 1.1 + Y_SHIFT]; }
      else if (o.blocking) head = [0.0, 0, 1.46 + Y_SHIFT];
      if (o.rocked > 0 && a.type !== 'hit') head[2] -= 0.05;
      const hw = W(head);
      return [
        { part: 'head', a: hw, b: hw, r: PART_R.head },
        { part: 'body', a: W(torsoA), b: W(torsoB), r: PART_R.body },
        { part: 'legs', a: W([0, 0, 0.1]), b: W([0, 0, 0.82 + Y_SHIFT]), r: PART_R.legs }
      ];
    }

    // sweep the striking tip against the opponent this tick. The sweep is split at the path's
    // keyframes so the limb's peak extension is never skipped between two 60 Hz samples.
    _traceStrike(f, st, dt) {
      const S = this.state, o = S.f[1 - f.idx], a = f.act;
      const fr = this._frame(f, o);
      const world = (t, out) => {
        const tip = strikeTip(st, t, a.tf, out);
        const fwd = tip[0], side = tip[1];
        tip[0] = f.x + fr.fx * fwd + fr.lx * side; tip[1] = tip[2]; tip[2] = f.z + fr.fz * fwd + fr.lz * side;
        return tip;
      };
      const tNow = a.t, tPrev = a.tipT;
      a.tipT = tNow;
      if (tPrev == null) { a.tip = world(tNow); return; }
      if (o.act.type === 'dodge' && o.act.t < 0.32) a.slipped = true;
      if (o.act.type === 'down') return;
      // sample times: previous tick, any keyframe crossed since, this tick
      const times = [tPrev];
      for (const k of st.path) { const kt = k[0] * a.tf; if (kt > tPrev && kt < tNow) times.push(kt); }
      times.push(tNow);
      const hb = this._hitboxes(o, f);
      const tipR = TIP_R[st.tip];
      let prev = a.tip, cur = null, best = null, bestR = null, segDt = dt; // a.tip = last tick's world position, so the attacker's own motion counts
      for (let i = 1; i < times.length && !best; i++) {
        cur = world(times[i]);
        let bestD = 1e9;
        for (const h of hb) {
          const r = segSegClosest(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2], h.a[0], h.a[1], h.a[2], h.b[0], h.b[1], h.b[2]);
          if (r[0] > tipR + h.r) continue;
          const score = r[0] - (h.part === st.part ? 0.1 : 0); // prefer the region the strike is aimed at when boxes overlap
          if (score < bestD) { best = h; bestR = r; bestD = score; }
        }
        segDt = Math.max(1e-4, times[i] - times[i - 1]);
        if (!best) prev = cur;
      }
      if (!best) { a.tip = cur; return; }
      a.tip = world(tNow);
      a.hit = true;
      // entry point: back up from the closest approach along the sweep until the tip just touches the box
      const dx = cur[0] - prev[0], dy = cur[1] - prev[1], dz = cur[2] - prev[2];
      const len = Math.hypot(dx, dy, dz) || 1e-6, R = tipR + best.r;
      const back = Math.sqrt(Math.max(0, R * R - bestR[0] * bestR[0])) / len;
      const sE = clamp(bestR[1] - back, 0, 1);
      const wx = prev[0] + dx * sE, wy = prev[1] + dy * sE, wz = prev[2] + dz * sE;
      // closing speed between the tip and the target along the line of impact
      const vtx = dx / segDt, vty = dy / segDt, vtz = dz / segDt;
      const ax = best.b[0] - best.a[0], ay = best.b[1] - best.a[1], az = best.b[2] - best.a[2];
      const al = ax * ax + ay * ay + az * az;
      const tq = al > 1e-9 ? clamp(((wx - best.a[0]) * ax + (wy - best.a[1]) * ay + (wz - best.a[2]) * az) / al, 0, 1) : 0;
      let nx = best.a[0] + ax * tq - wx, ny = best.a[1] + ay * tq - wy, nz = best.a[2] + az * tq - wz;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const impact = (vtx - o.vx) * nx + vty * ny + (vtz - o.vz) * nz;
      const speedF = clamp(impact * a.tf / st.refSpeed, 0, 1.6); // ref is at tempo 1: a fighter's own speed is already in the stamina/speed factors
      // extension: how far the limb got from its pivot compared to a clean impact (jammed strikes land short)
      const pv = st.pivot;
      const px = f.x + fr.fx * pv[0] + fr.lx * pv[1], pz = f.z + fr.fz * pv[0] + fr.lz * pv[1];
      const ext = Math.hypot(wx - px, wy - pv[2], wz - pz) / st.expExt;
      const jamF = ext < 0.7 ? Math.pow(clamp(ext / 0.7, 0, 1), 2.5) : 1;
      this._landStrike(f, o, st, best.part, speedF, jamF, [wx, wy, wz], fr);
    }

    // a strike that finds nothing costs extra; one that lands clean gives some of its cost back
    _missCost(f, act) { f.stam = Math.max(0, f.stam - (act.cost || 0) * MISS_PENALTY); }
    _cleanRefund(f, act) { f.stam = Math.min(f.stamMax, f.stam + (act.cost || 0) * CLEAN_REFUND); }

    _whiff(f, st) {
      const o = this.state.f[1 - f.idx];
      this._missCost(f, f.act);
      if (f.act.slipped) {
        this._emit({ k: 'miss', i: f.idx, j: o.idx, name: st.name, slipped: true });
        f.act.dur *= 1.35; // over-committed
      } else this._emit({ k: 'miss', i: f.idx, name: st.name, whiff: true });
    }

    // ---------------------------------------------------------
    //  Lead props. A clean connection fills part of a bar. Crossed props lock.
    // ---------------------------------------------------------
    _qrot(q, v) {
      const x = q.x, y = q.y, z = q.z, w = q.w;
      const vx = v[0], vy = v[1], vz = v[2];
      const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
      return [
        vx + w * tx + (y * tz - z * ty),
        vy + w * ty + (z * tx - x * tz),
        vz + w * tz + (x * ty - y * tx)
      ];
    }
    _dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    _pointSeg(p, a, b) {
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      const ab2 = this._dot3(ab, ab) || 1e-8;
      const s = Math.max(0, Math.min(1, this._dot3(ap, ab) / ab2));
      const q = [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s];
      return { d: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), s, q };
    }
    _segDist(a, b, c, d) {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
      const w = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
      const uu = this._dot3(u, u) || 1e-8, uv = this._dot3(u, v), vv = this._dot3(v, v) || 1e-8;
      const uw = this._dot3(u, w), vw = this._dot3(v, w);
      const den = uu * vv - uv * uv;
      let s = 0, t = 0;
      if (den > 1e-8) { s = (uv * vw - vv * uw) / den; t = (uu * vw - uv * uw) / den; }
      // an interior solution is the crossing; only clamp when a closest point falls off an end
      if (s < 0 || s > 1 || t < 0 || t > 1) {
        s = Math.max(0, Math.min(1, s));
        t = Math.max(0, Math.min(1, (uv * s + vw) / vv));
        s = Math.max(0, Math.min(1, (uv * t - uw) / uu));
        t = Math.max(0, Math.min(1, (uv * s + vw) / vv));
      }
      const p = [a[0] + u[0] * s, a[1] + u[1] * s, a[2] + u[2] * s];
      const q = [c[0] + v[0] * t, c[1] + v[1] * t, c[2] + v[2] * t];
      return { d: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), p, s, t };
    }
    _bladeFromBody(body) {
      const p = body.translation(), r = body.rotation();
      const h = this._qrot(r, EDGE_HILT), t = this._qrot(r, EDGE_TIP);
      return { h: [p.x + h[0], p.y + h[1], p.z + h[2]], t: [p.x + t[0], p.y + t[1], p.z + t[2]] };
    }
    _bladeKinematic(f, o) {
      const fr = this._frame(f, o);
      const striking = !!(f.act && f.act.edge);
      const reach = striking ? 0.9 : 0.72;
      const hx = f.x + fr.lx * 0.28 + fr.fx * 0.36, hy = 1.45, hz = f.z + fr.lz * 0.28 + fr.fz * 0.36;
      const out = striking ? (f.act.t < 0.22 ? 0.4 : -0.5) : -0.12;
      return { h: [hx, hy, hz], t: [hx + fr.lx * out + fr.fx * reach, hy + 0.04, hz + fr.lz * out + fr.fz * reach] };
    }
    _edgeBlades() {
      const F = this.state.f;
      if (this.phys) return [0, 1].map(i => this._bladeFromBody(this.phys.fighters[i].bodies.lForearm));
      return [0, 1].map(i => this._bladeKinematic(F[i], F[1 - i]));
    }
    _vitals(i) {
      if (this.phys) {
        const rag = this.phys.fighters[i];
        const h = rag.bodies.head.translation(), c = rag.bodies.chest.translation();
        return { head: [h.x, h.y, h.z], chest: [c.x, c.y, c.z] };
      }
      const f = this.state.f[i];
      return { head: [f.x, 1.55, f.z], chest: [f.x, 1.18, f.z] };
    }
    _edgeSwing(f, blade) {
      const striking = !!(f.act && f.act.edge && !f.act.hit);
      const vit = this._vitals(1 - f.idx);
      const gap = this._pointSeg(vit.chest, blade.h, blade.t).d;
      const closing = f._edgeGap != null && (f._edgeGap - gap) > 0.015 && gap < EDGE_BODY_R + 0.04;
      f._edgeGap = gap;
      // a live lead swing that meets them, or someone walking onto the point
      return striking || closing;
    }
    _edgeCut(f, o, part, at) {
      const S = this.state;
      if (!o || (o.act && (o.act.type === 'down' || o.act.type === 'celebrate' || o.act.type === 'kd'))) return;
      if (f._edgeAt != null && S.t - f._edgeAt < 0.45) return;
      f._edgeAt = S.t;
      o.dmg[part] = clamp(o.dmg[part] + EDGE_HIT, 0, 100);
      const finish = o.dmg[part] >= 100;
      f.rs.landed++;
      f.rs.sig += EDGE_HIT;
      if (f.act && f.act.edge) f.act.hit = true;
      if (finish) o._fatality = true;
      if (this.phys && finish) {
        const rag = this.phys.fighters[o.idx];
        if (rag && !rag.ko) rag.knockOut();
      }
      o.act = { type: 'hit', name: part, t: 0, dur: 0.35, hit: false };
      o.blocking = false;
      const p = at || [o.x, part === 'head' ? 1.55 : 1.15, o.z];
      this._emit({ k: 'hit', i: f.idx, j: o.idx, name: 'cut', kind: 'cut', part, intended: part, dmg: EDGE_HIT, big: true, edge: true,
        at: [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 100) / 100] });
    }
    _edgeExchange() {
      const S = this.state, F = S.f;
      this._edgeLocked = false;
      if (S.phase !== 'fight' || S.ground || !F.some(f => f.edge)) return;
      const blades = this._edgeBlades();
      for (let i = 0; i < 2; i++) if (!F[i].edge || F[i].pocket) blades[i] = { h: [0, -20, 0], t: [0, -20, 0] };
      const swing = [0, 1].map(i => !!F[i].edge && !F[i].pocket && this._edgeSwing(F[i], blades[i]));
      const cross = this._segDist(blades[0].h, blades[0].t, blades[1].h, blades[1].t);
      if (cross.d < EDGE_PARRY) {
        this._edgeLocked = true;
        if (swing[0] || swing[1]) {
          for (let i = 0; i < 2; i++) {
            const a = F[i].act;
            if (a && a.edge) a.hit = true;
          }
          if (this._parryAt == null || S.t - this._parryAt >= 0.32) {
            this._parryAt = S.t;
            const p = cross.p;
            const attacker = swing[0] ? 0 : 1;
            this._emit({ k: 'block', i: attacker, j: 1 - attacker, name: 'cut', parry: true,
              at: [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 100) / 100] });
          }
        }
        return;
      }
      for (let i = 0; i < 2; i++) {
        if (!swing[i]) continue;
        const f = F[i], o = F[1 - i];
        const vit = this._vitals(o.idx);
        const head = this._pointSeg(vit.head, blades[i].h, blades[i].t);
        const chest = this._pointSeg(vit.chest, blades[i].h, blades[i].t);
        if (head.d < EDGE_HEAD_R && head.s > 0.08) this._edgeCut(f, o, 'head', head.q);
        else if (chest.d < EDGE_BODY_R && chest.s > 0.08) this._edgeCut(f, o, 'body', chest.q);
      }
    }

    // ---------------------------------------------------------
    //  PHYSICS (standing): drive the ragdolls from the fighters' state, step the world,
    //  turn contacts into hits, and publish bone poses for the renderer / network.
    // ---------------------------------------------------------
    _physTick(dt) {
      const S = this.state, F = S.f, W = this.phys;
      if (!W.active) W.setActive(true);
      for (let i = 0; i < 2; i++) {
        const f = F[i], rag = W.fighters[i], a = f.act;
        rag.southpaw = isSouthpaw(f);
        rag.guard = f.blocking && a.type !== 'strike';
        rag.guardLow = rag.guard && !!(this.inputs[i].held & IN.MOD3);
        rag.check = f.checking && a.type !== 'strike';
        // body language from the action
        let ov = null;
        if (a.type === 'dodge') ov = a.t < 0.32 ? 'SLIP' : null;
        else if (a.type === 'push') ov = a.t < 0.26 ? 'PUSH' : null;
        else if (a.type === 'takedown') ov = a.t < 0.32 ? 'SHOOT' : 'STUMBLE';
        else if (a.type === 'stumble') ov = 'STUMBLE';
        else if (a.type === 'sprawl') ov = 'SPRAWL';
        else if (a.type === 'celebrate' || (S.phase === 'over' && S.result && S.result.winner === i)) ov = 'CELEBRATE';
        if (!ov && f.edge && !f.pocket && f.blocking && a.type !== 'strike') ov = 'EDGE_GUARD';
        rag.override = ov;
        if (a.type === 'down' && !rag.ko) rag.knockOut();
        rag.wobble = f.rocked > 0 ? (f.rockLight ? ROCK_LIGHT_WOBBLE : Math.min(1, 0.4 + f.rocked * 0.25)) : 0;
        rag.gainTarget = f.rocked > 0 ? (f.rockLight ? 0.85 : 0.72) : (f.stam < 15 ? 0.85 : 1);
        if (S.phase !== 'fight' || a.type === 'hit' || a.type === 'down' || a.type === 'kd') { rag.move[0] = 0; rag.move[1] = 0; rag.guard = false; rag.check = false; }
        // the sim may have replaced a strike (hit reaction, takedown landed): keep the ragdoll honest
        if (a.type !== 'strike' && rag.strike) rag.cancelStrike();
      }
      const hits = W.step();
      for (let i = 0; i < 2; i++) {
        const f = F[i], rag = W.fighters[i];
        const p = rag.position(), v = rag.velocity();
        f.x = p.x; f.z = p.z; f.vx = v.x; f.vz = v.z;
      }
      this._edgeExchange();
      if (S.phase === 'fight') { this._releaseShots(); this._stepBullets(dt); }
      for (let i = 0; i < 2; i++) {
        const f = F[i], o = F[1 - i], a = f.act, h = hits[i];
        if (a.type !== 'strike' || !a.phys || a.hit) continue;
        const def = root.MMAPhys.STRIKES[a.name];
        const st = STRIKES[a.name];
        // a lead prop or a pocket hit replaces the glove on that hand
        if (a.pop || a.edge) {
          if (a.t >= a.cancelAt) { a.hit = true; if (!a.popFired) this._whiff(f, a.edge ? { name: 'cut' } : st); }
          continue;
        }
        if (h && !h.glance && S.phase === 'fight' && o.act.type !== 'kd') { a.hit = true; this._landPhys(f, o, def, h); }
        else if (a.t >= a.cancelAt) { a.hit = true; this._whiff(f, STRIKES[a.name] || def); }
      }
      if (S.ground || !W.active) return; // a knockdown / takedown landed during this tick: the ragdolls are parked
      for (let i = 0; i < 2; i++) F[i].pose = W.fighters[i].snapshot(F[i].pose);
    }

    // a physical contact becomes damage (sim units), stamina, events and a hit reaction
    _landPhys(f, o, def, h) {
      const PH = root.MMAPhys;
      const rag = this.phys.fighters[o.idx];
      // a low kick into a lifted lead leg is checked: the shin-on-shin hurts the kicker more than the defender
      const checked = o.checking && def.isKick && def.part === 'legs' && h.region === 'legs';
      // scored as the clean thigh shot it would have been; CHECK_DMG / CHECK_SELF_DMG then split it
      const res = PH.impactDamage(def, checked ? Object.assign({}, h, { partName: 'thigh' }) : h, f, o.blocking && !checked, o.blocking && !!(this.inputs[o.idx].held & IN.MOD3));
      if (checked) { res.blocked = true; res.region = 'legs'; }
      const part = res.region;
      const counter = o.act.type === 'strike' && !o.act.hit;
      let dmg = res.dmg * (0.7 + f.stats.pow * 0.6) * lerp(0.9, 1.1, this.rand());
      if (f.act.powMul != null) dmg *= f.act.powMul;
      if (counter) dmg *= 1.35;
      if (o.rocked > 0) dmg *= 1.25;
      if (f.rocked > 0) dmg *= 0.7;
      const oSt = o.act.type === 'strike' ? STRIKES[o.act.name] : null;
      const oKicking = !!oSt && !o.act.hit && !oSt.ground && (oSt.limb === 'll' || oSt.limb === 'rl');
      const kickCancel = oKicking && (def.limb === 'lh' || def.limb === 'rh') && !res.blocked && dmg >= KICK_CANCEL_DMG;
      if (kickCancel) dmg *= KICK_CANCEL_BONUS;
      const at = [Math.round(h.point.x * 100) / 100, Math.round(h.point.y * 100) / 100, Math.round(h.point.z * 100) / 100];
      const fwd = this._frame(f, o);
      if (checked) {
        f.dmg.legs = clamp(f.dmg.legs + dmg * CHECK_SELF_DMG * (PART_TOUGHNESS.legs || 1), 0, 100);
        dmg *= CHECK_DMG;
      }
      o.dmg[part] = clamp(o.dmg[part] + dmg * (PART_TOUGHNESS[part] || 1), 0, 100);
      f.rs.landed++;
      f.rs.sig += dmg;
      rag.takeHit(h, dmg, res.blocked);
      if (res.blocked) {
        if (o.blocking) o.stam = Math.min(o.stamMax, o.stam + def.cost * BLOCK_REWARD); // a stray arm in the way is free, a real block is rewarded
        this._emit({ k: 'block', i: f.idx, j: o.idx, name: def.name, part, at, passive: !o.blocking && !checked, checked, vn: Math.round(h.vn * 10) / 10 });
        if (def.push) rag.shove(fwd.fx, fwd.fz, PHYS_PUSH * 0.5);
        return;
      }
      this._cleanRefund(f, f.act);
      if (kickCancel) this._missCost(o, o.act);
      o.hitChain = (o.act.type === 'hit' && this.state.t - (o.lastHitT || -9) < 0.7) ? (o.hitChain || 0) + 1 : 0;
      o.lastHitT = this.state.t;
      // repeat penalty: stun is scaled by stunMul off the unpenalised damage, so the power cut doesn't count twice
      const pm = f.act.powMul || 1, sm = f.act.stunMul != null ? f.act.stunMul : 1;
      const stun = ((0.2 + dmg / pm * 0.025) * 0.6 * Math.pow(0.6, o.hitChain) + (kickCancel ? KICK_CANCEL_STUN : 0)) * sm;
      if (def.name !== 'jab' && sm > 0) { // the jab scores damage without hitstun
        o.act = { type: 'hit', name: part, t: 0, dur: stun, hit: false };
        o.blocking = false;
      }
      if (def.push) rag.shove(fwd.fx, fwd.fz, PHYS_PUSH);
      const ev = this._emit({ k: 'hit', i: f.idx, j: o.idx, name: def.name, kind: def.kind, part, intended: def.part, dmg: Math.round(dmg * 10) / 10, counter, big: dmg >= 3.6,
        vn: Math.round(h.vn * 10) / 10, clean: Math.round(h.clean * 100) / 100, momentum: h.vn >= 8, combo: f.combo, kickCancel, at, phys: true });
      this._afterHit(f, o, part, dmg, ev, false);
    }

    // Lead-hand pocket. The base lead punch sends one straight ahead.
    drawPocket(i) { const f = this.state.f[i]; if (f) { f.pocket = true; f.edge = false; f.heldPocket = true; } }
    popShot(i) { this.drawPocket(i); return this._releaseShot(this.state.f[i], true); }
    _muzzle(i) {
      if (this.phys) {
        const b = this.phys.fighters[i].bodies.lForearm;
        const p = b.translation(), r = b.rotation();
        const aim = this._qrot(r, [0, -1, 0]);
        const off = this._qrot(r, [0.04, -0.38, 0.02]);
        const len = Math.hypot(aim[0], aim[1], aim[2]) || 1;
        return { p: [p.x + off[0], p.y + off[1], p.z + off[2]], aim: [aim[0] / len, aim[1] / len, aim[2] / len] };
      }
      const f = this.state.f[i], o = this.state.f[1 - i];
      const fr = this._frame(f, o);
      return { p: [f.x + fr.lx * 0.28 + fr.fx * 0.5, 1.45, f.z + fr.lz * 0.28 + fr.fz * 0.5], aim: [fr.fx, 0.08, fr.fz] };
    }
    _headDir(i, from) {
      const vit = this._vitals(1 - i);
      const to = [vit.head[0] - from[0], vit.head[1] - from[1], vit.head[2] - from[2]];
      const l = Math.hypot(to[0], to[1], to[2]) || 1;
      return [to[0] / l, to[1] / l, to[2] / l];
    }
    // Pull the barrel toward a point, but only by a few degrees, so a jab that is already
    // pointed at them connects and a jab pointed away still misses.
    _steer(aim, want, maxDeg) {
      const dot = Math.max(-1, Math.min(1, aim[0] * want[0] + aim[1] * want[1] + aim[2] * want[2]));
      const ang = Math.acos(dot);
      const t = ang < 1e-4 ? 1 : Math.min(1, (maxDeg * Math.PI / 180) / ang);
      const x = aim[0] + (want[0] - aim[0]) * t, y = aim[1] + (want[1] - aim[1]) * t, z = aim[2] + (want[2] - aim[2]) * t;
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    }
    _facingAim(i, from) {
      let fx, fz;
      if (this.phys) {
        const yaw = this.phys.fighters[i].yaw;
        fx = Math.sin(yaw); fz = Math.cos(yaw);
      } else {
        const fr = this._frame(this.state.f[i], this.state.f[1 - i]);
        fx = fr.fx; fz = fr.fz;
      }
      const to = [fx * 2.4, 1.45 - from[1], fz * 2.4];
      const l = Math.hypot(to[0], to[1], to[2]) || 1;
      return [to[0] / l, to[1] / l, to[2] / l];
    }
    _releaseShots() {
      const F = this.state.f;
      for (let i = 0; i < 2; i++) {
        const a = F[i].act;
        if (!a || !a.pop || a.popFired) continue;
        if (a.t < 0.08 * (a.tf || 1)) continue;
        const m = this._muzzle(i);
        this._releaseShot(F[i], false, this._facingAim(i, m.p), m.p);
      }
    }
    _releaseShot(f, manual, aimOverride, fromOverride) {
      const S = this.state;
      if (!S || S.phase !== 'fight' || !f) return false;
      if (f.act && (f.act.type === 'down' || f.act.type === 'celebrate')) return false;
      if (f._popAt != null && S.t - f._popAt < 0.42) return false;
      f._popAt = S.t;
      if (f.act && f.act.pop) f.act.popFired = true;
      const m = this._muzzle(f.idx);
      const p = (fromOverride || m.p).slice();
      // A chosen aim is the punch's forward line. Otherwise nudge it toward them.
      const aim = aimOverride || this._steer(m.aim, this._headDir(f.idx, p), manual ? 12 : 20);
      const speed = 80;
      this._bits.push({ i: f.idx, p: p.slice(), v: [aim[0] * speed, aim[1] * speed, aim[2] * speed], life: 0.18 });
      const to = [p[0] + aim[0] * 6, p[1] + aim[1] * 6, p[2] + aim[2] * 6];
      this._emit({ k: 'line', i: f.idx, from: p.map(n => Math.round(n * 100) / 100), to: to.map(n => Math.round(n * 100) / 100), manual: !!manual });
      return true;
    }
    _stepBullets(dt) {
      if (!this._bits.length) return;
      const keep = [];
      for (let n = 0; n < this._bits.length; n++) {
        const b = this._bits[n];
        b.life -= dt;
        const nxt = [b.p[0] + b.v[0] * dt, b.p[1] + b.v[1] * dt, b.p[2] + b.v[2] * dt];
        const hit = this._bitTouch(b, nxt);
        if (hit) { this._bitHit(b.i, hit); continue; }
        b.p = nxt;
        if (b.life > 0 && nxt[1] > 0.05) keep.push(b);
      }
      this._bits = keep;
    }
    _bitTouch(b, nxt) {
      const o = this.state.f[1 - b.i];
      if (!o || (o.act && (o.act.type === 'down' || o.act.type === 'celebrate'))) return null;
      const vit = this._vitals(o.idx);
      let pelvis;
      if (this.phys) {
        const p = this.phys.fighters[o.idx].bodies.pelvis.translation();
        pelvis = [p.x, p.y, p.z];
      } else pelvis = [o.x, 0.95, o.z];
      const parts = [
        { part: 'head', p: vit.head, r: 0.22, pri: 2 },
        { part: 'body', p: vit.chest, r: 0.30, pri: 1 },
        { part: 'body', p: pelvis, r: 0.24, pri: 0 }
      ];
      let best = null;
      for (let k = 0; k < parts.length; k++) {
        const c = parts[k];
        const hit = this._pointSeg(c.p, b.p, nxt);
        if (hit.d > c.r) continue;
        if (!best || c.pri > best.pri || (c.pri === best.pri && hit.d < best.d)) best = { part: c.part, at: hit.q, d: hit.d, pri: c.pri };
      }
      return best;
    }
    _bitHit(i, hit) {
      const S = this.state, f = S.f[i], o = S.f[1 - i];
      if (!o) return;
      const part = hit.part;
      // The health bar is the head meter. This spends its damage there so a body hit still shows.
      o.dmg.head = clamp(o.dmg.head + POP_HIT, 0, 100);
      const finish = o.dmg.head >= 100;
      if (finish) o._fatality = true;
      f.rs.landed++;
      f.rs.sig += POP_HIT;
      if (this.phys && finish) {
        const rag = this.phys.fighters[o.idx];
        if (rag && !rag.ko) rag.knockOut();
      }
      const onGround = !!S.ground;
      if (!onGround && o.act && o.act.type !== 'down' && o.act.type !== 'celebrate') {
        o.act = { type: 'hit', name: part, t: 0, dur: 0.35, hit: false };
        o.blocking = false;
      }
      const at = hit.at || [o.x, part === 'head' ? 1.55 : 1.2, o.z];
      this._emit({ k: 'hit', i: f.idx, j: o.idx, name: 'pop', kind: 'pop', part, intended: part, dmg: POP_HIT, big: true, pop: true, fatal: finish, gore: true,
        at: [Math.round(at[0] * 100) / 100, Math.round(at[1] * 100) / 100, Math.round(at[2] * 100) / 100] });
    }

    _afterHit(f, o, part, dmg, ev, onGround) {
      // head and body damage shrink the tank
      if (part === 'head') o.stamMax = Math.max(STAM_MAX_FLOOR, o.stamMax - dmg * 0.35);
      else if (part === 'body') o.stamMax = Math.max(STAM_MAX_FLOOR, o.stamMax - dmg * 0.7);
      if (o.stam > o.stamMax) o.stam = o.stamMax;
      // rocked / knockdown
      if (part === 'head') {
        const thr = (4.6 + o.stats.chin * 4.6) * (1 - o.dmg.head / 170);
        // a rocked fighter goes down to a solid follow-up shot, not to a pawing jab; the bar drops as his head damage climbs
        const kdThr = Math.max(KD_THR_MIN, thr * KD_THR_FRAC);
        if (o.rocked > 0 && dmg >= kdThr && !onGround) {
          this._knockdown(f, o);
        } else if (dmg >= thr) {
          // most rocks are a short stun; now and then (or on a shot that nearly drops him) he's properly dazed
          if (this.rand() < ROCK_HEAVY_P || dmg >= thr * KD_FLASH_FRAC) {
            o.rocked = Math.max(o.rocked, (ROCK_T0 + dmg * ROCK_PER_DMG) * ROCK_TIME_MULT);
            o.rockLight = false;
            o.wobble = 1;
          } else {
            if (o.rocked <= 0) o.rockLight = true; // never downgrade a heavy daze still running
            o.rocked = Math.max(o.rocked, ROCK_LIGHT_T);
            o.wobble = Math.max(o.wobble, 0.3);
          }
          ev.rocked = true;
          this._emit({ k: 'rocked', i: f.idx, j: o.idx });
          if (!onGround && dmg >= thr * KD_FLASH_FRAC) this._knockdown(f, o);
        }
      } else if (part === 'body' && dmg >= 3.6 && this.rand() < 0.35) {
        o.stam = Math.max(0, o.stam - 12);
        ev.winded = true;
      } else if (part === 'legs' && o.dmg.legs > 65 && dmg >= 3 && this.rand() < 0.4 && !onGround) {
        o.act = { type: 'stumble', name: 'legs', t: 0, dur: 0.9, hit: false };
        ev.buckled = true;
      }
    }

    _resolveGroundStrike(f, st) {
      const S = this.state, o = S.f[1 - f.idx];
      if (!S.ground) return;
      const posMul = f.ground === 'top' ? POS_STRIKE[S.ground.pos] : 0.5;
      let dmg = st.dmg * posMul * (0.7 + f.stats.pow * 0.6) * (0.6 + 0.4 * f.stam / 100) * lerp(0.85, 1.15, this.rand());
      if (f.act.powMul != null) dmg *= f.act.powMul;
      if (o.rocked > 0) dmg *= 1.25;
      if (f.rocked > 0) dmg *= 0.7;
      let blocked = false;
      if (this.inputs[o.idx].held & IN.BLOCK) { blocked = true; dmg *= 0.3; o.stam = Math.min(o.stamMax, o.stam + GROUND_BLOCK_REWARD); }
      o.dmg[st.part] = clamp(o.dmg[st.part] + dmg * (PART_TOUGHNESS[st.part] || 1), 0, 100);
      f.rs.landed++; f.rs.sig += dmg;
      if (blocked) { this._emit({ k: 'block', i: f.idx, j: o.idx, name: st.name, part: st.part }); return; }
      this._cleanRefund(f, f.act);
      const pm = f.act.powMul || 1, sm = f.act.stunMul != null ? f.act.stunMul : 1;
      const stun = (0.2 + dmg / pm * 0.025) * 0.5 * sm;
      if (sm > 0) o.act = { type: 'hit', name: st.part, t: 0, dur: stun, hit: false };
      S.ground.idleT = 0;
      const ev = this._emit({ k: 'hit', i: f.idx, j: o.idx, name: st.name, kind: st.kind, part: st.part, intended: st.part, dmg: Math.round(dmg * 10) / 10, counter: false, big: dmg >= 3.6, ground: true });
      this._afterHit(f, o, st.part, dmg, ev, true);
    }

    _knockdown(att, vic) {
      const S = this.state;
      if (S.ground) return;
      vic.kdCount++; att.rs.kd++;
      vic.rocked = Math.max(vic.rocked, 3 * ROCK_TIME_MULT); vic.rockLight = false;
      if (vic.dmg.head >= 84) { this._emit({ k: 'kd', i: att.idx, j: vic.idx, standing: !S.grappling }); vic.dmg.head = 100; return; } // flash KO, caught by stoppage check
      this._emit({ k: 'kd', i: att.idx, j: vic.idx });
      if (this.phys) {
        // he drops where he stands; the fall / down / rise phases run in _kdTick
        vic.rocked = Math.max(vic.rocked, KD_ROCKED * ROCK_TIME_MULT);
        vic.act = { type: 'kd', name: 'fall', t: 0, dur: 99, hit: false };
        vic.blocking = false; vic.buf = null;
        vic.stamMax = Math.max(STAM_MAX_FLOOR, vic.stamMax - 6);
        const rag = this.phys.fighters[vic.idx], fr = this._frame(att, vic);
        // which way he goes: a shot that drives him back sits him down onto his back (he comes up in an open guard);
        // otherwise — or when the legs just give out — he crumples forward onto his hands and knees (turtle)
        const facing = Math.sin(rag.yaw) * fr.fx + Math.cos(rag.yaw) * fr.fz; // shove along his own facing (< 0: pushed backward)
        const dir = facing < -0.2 && this.rand() < 0.65 ? 'back' : 'fwd';
        rag.knockDown(KD_FALL, dir);
        rag.shove(fr.fx, fr.fz, dir === 'back' ? KD_SHOVE : KD_SHOVE * 0.35);
        return;
      }
      if (!S.grappling) { vic.rocked = Math.max(vic.rocked, 4 * ROCK_TIME_MULT); vic.act = { type: 'hit', name: 'head', t: 0, dur: 1.0, hit: false }; return; }
      this._enterGround(att, vic, 'kd', 'half');
    }

    _resolveTakedown(f) {
      const S = this.state, o = S.f[1 - f.idx];
      const dist = Math.hypot(o.x - f.x, o.z - f.z);
      if (dist > 1.85) {
        f.act = { type: 'stumble', name: 'td', t: 0, dur: 0.7 * TD_FAIL_STUN, hit: false };
        f.tdCd = TD_FAIL_CD;
        this._emit({ k: 'tdfail', i: f.idx, j: o.idx, air: true });
        return;
      }
      let p = 0.38 + (f.stats.wre - o.stats.wre) * 0.45;
      if (o.act.type === 'strike' && !o.act.hit) p += 0.22;      // caught mid-strike
      if (o.act.type === 'dodge') p -= 0.1;
      if (o.blocking) p -= 0.33;                                  // sprawl
      if (o.rocked > 0) p += 0.3;
      p += (100 - o.stam) / 400 - (100 - f.stam) / 300;
      p += (o.dmg.legs / 250);
      p = clamp(p, 0.08, 0.92);
      if (this.rand() < p) {
        f.rs.td++;
        o.stam = Math.max(0, o.stam - 6);
        this._emit({ k: 'td', i: f.idx, j: o.idx });
        this._enterGround(f, o, 'td', (o.act.type === 'strike' || o.rocked > 0) && f.stats.wre > 0.7 ? 'half' : 'guard');
      } else {
        f.act = { type: 'stumble', name: 'td', t: 0, dur: 0.95 * TD_FAIL_STUN, hit: false };
        f.tdCd = TD_FAIL_CD;
        f.stam = Math.max(0, f.stam - 6);
        if (o.blocking) o.act = { type: 'sprawl', name: '', t: 0, dur: 0.35, hit: false };
        this._emit({ k: 'tdfail', i: f.idx, j: o.idx, sprawl: o.blocking });
      }
    }

    _enterGround(top, bottom, how, pos) {
      const S = this.state;
      const mx = (top.x + bottom.x) / 2, mz = (top.z + bottom.z) / 2;
      // keep off the fence a bit
      const r = Math.hypot(mx, mz), lim = CAGE_R - 0.9;
      const cx = r > lim ? mx * lim / r : mx, cz = r > lim ? mz * lim / r : mz;
      top.x = cx; top.z = cz; bottom.x = cx; bottom.z = cz;
      top.vx = top.vz = bottom.vx = bottom.vz = 0;
      top.ground = 'top'; bottom.ground = 'bottom';
      top.blocking = false; bottom.blocking = false; top.buf = null; bottom.buf = null;
      top.act = idleAct();
      bottom.act = { type: 'hit', name: 'head', t: 0, dur: how === 'kd' ? 0.8 : 0.5, hit: false };
      S.ground = { top: top.idx, bottom: bottom.idx, pos: pos || 'guard', trans: null, sub: null, ctrlT: 0, idleT: 0, cd: [0, 0] };
      if (this.phys) { this.phys.setActive(false); top.pose = null; bottom.pose = null; }
    }

    _standUp(reason) {
      const S = this.state; if (!S.ground) return;
      const top = S.f[S.ground.top], bot = S.f[S.ground.bottom];
      top.ground = null; bot.ground = null;
      top.act = idleAct();
      bot.act = idleAct();
      top.posture = false;
      // separate
      const ang = this.rand() * Math.PI * 2;
      bot.x = clamp(bot.x + Math.cos(ang) * 0.9, -CAGE_R, CAGE_R); bot.z = clamp(bot.z + Math.sin(ang) * 0.9, -CAGE_R, CAGE_R);
      top.x = clamp(top.x - Math.cos(ang) * 0.6, -CAGE_R, CAGE_R); top.z = clamp(top.z - Math.sin(ang) * 0.6, -CAGE_R, CAGE_R);
      S.ground = null;
      if (this.phys) { this.phys.place(top, bot); this.phys.setActive(true); }
      this._emit({ k: 'standup', i: bot.idx, reason });
    }

    _setPos(pos) {
      const S = this.state, G = S.ground;
      G.pos = pos; G.idleT = 0;
    }
    // reversal: the bottom fighter becomes the top fighter
    _flip(pos) {
      const S = this.state, G = S.ground;
      const top = S.f[G.top], bot = S.f[G.bottom];
      top.ground = 'bottom'; bot.ground = 'top';
      G.top = bot.idx; G.bottom = top.idx;
      top.posture = false; bot.posture = false;
      this._setPos(pos);
    }

    // ---------------------------------------------------------
    //  GROUND
    //  - GRAPPLE + direction: a timed transition attempt (pass / escape / sweep / stand). The other fighter
    //    holds BLOCK to base and deny it. Attempts have a per-fighter cooldown (G.cd).
    //  - GRAPPLE alone: submission (if one is available from this position). Hold to squeeze.
    //  - Limb keys: strikes (power depends on position; bottom can only strike from guard / half guard).
    //  - BLOCK: top postures / bases, bottom covers and frames.
    // ---------------------------------------------------------
    _groundTick(dt) {
      const S = this.state, G = S.ground;
      const top = S.f[G.top], bot = S.f[G.bottom];
      const ti = this.inputs[top.idx], bi = this.inputs[bot.idx];
      top.rs.ctrl += dt; G.ctrlT += dt; G.idleT += dt;
      top.blocking = false; bot.blocking = false;
      G.cd[0] = Math.max(0, G.cd[0] - dt); G.cd[1] = Math.max(0, G.cd[1] - dt);

      if (G.sub) { this._subTick(dt); return; }
      if (G.trans) { this._transTick(dt); if (!S.ground || G.trans) return; }

      const roles = [[top, ti, 'top'], [bot, bi, 'bottom']];
      for (const [f, inp, role] of roles) {
        const o = role === 'top' ? bot : top;
        const busy = f.act.type !== 'idle'; // no recovery-cancels on the mat: ground strikes are deliberate
        f.posture = !!(inp.held & IN.BLOCK) && !busy;
        if (inp.held & IN.BLOCK) f.stam = Math.max(0, f.stam - dt * (role === 'top' ? 2.5 : 3.5)); // basing / framing is work
        if (busy) continue;
        if (role === 'top' && (inp.pressed & IN.DODGE)) { this._standUp('letup'); return; }
        if (inp.pressed & IN.GRAPPLE && f.rocked <= 0) {
          const dir = dirOf(inp.held);
          const mv = dir && MOVES[role][G.pos][dir];
          if (mv) { if (G.cd[f.idx] <= 0 && f.stam >= mv.stam) this._startTrans(f, o, role, mv); return; }
          const subs = SUBS_BY[role][G.pos];
          if (subs.length && f.stam > 15 && G.cd[f.idx] <= 0) { this._trySub(f, o, role, subs[Math.floor(this.rand() * subs.length)]); return; }
        } else if ((inp.pressed & LIMB_BITS) && !(inp.held & IN.BLOCK)) {
          if (role === 'top' || BOTTOM_CAN_STRIKE[G.pos]) {
            const key = this._pickStrikeKey(f, inp.pressed, inp.held, true);
            if (key) { this._startStrike(f, key, false); G.idleT = 0; }
          }
        }
      }
      if (G.idleT > 12) { this._standUp('ref'); return; }
    }

    _startTrans(f, o, role, mv) {
      const G = this.state.ground;
      f.stam = Math.max(0, f.stam - mv.stam);
      G.trans = { by: f.idx, role, name: mv.name, mv, t: 0, dur: mv.dur };
      G.idleT = 0;
      f.act = { type: 'trans', name: mv.name, t: 0, dur: mv.dur, hit: false };
      this._emit({ k: 'gattempt', i: f.idx, j: o.idx, name: mv.name });
    }

    _transTick(dt) {
      const S = this.state, G = S.ground, T = G.trans;
      const f = S.f[T.by], o = S.f[1 - T.by];
      T.t += dt;
      if (T.t < T.dur) return;
      // resolve
      const mv = T.mv, att = f.stats, def = o.stats;
      let p = mv.base;
      if (T.role === 'top') p += att.wre * 0.3 + att.bjj * 0.25 - def.bjj * 0.3 - def.wre * 0.15;
      else p += att.bjj * 0.3 + att.wre * 0.25 - def.wre * 0.18 - def.bjj * 0.10;
      p += (f.stam - o.stam) / 300;
      const denied = !!(this.inputs[o.idx].held & IN.BLOCK) && o.stam > 5;
      if (denied) p -= DENY_PENALTY;                                  // based / framed
      if (o.act.type === 'strike') p += 0.2;                            // caught swinging
      if (o.rocked > 0) p += 0.3;
      if (f.rocked > 0) p -= 0.3;
      if (T.role === 'bottom') p -= f.dmg.head / 400;
      p = clamp(p, 0.05, 0.95);
      G.trans = null; G.cd[f.idx] = 0.6; G.idleT = 0;
      f.act = idleAct();
      if (this.rand() < p) {
        if (mv.stand) { this._emit({ k: 'gresult', i: f.idx, j: o.idx, ok: true, name: mv.name, stand: true }); this._standUp('escape'); return; }
        if (mv.flip) { f.rs.td++; this._flip(mv.flip); this._emit({ k: 'gresult', i: f.idx, j: o.idx, ok: true, name: mv.name, flip: true, pos: mv.flip }); return; }
        this._setPos(mv.to);
        this._emit({ k: 'gresult', i: f.idx, j: o.idx, ok: true, name: mv.name, pos: mv.to });
      } else {
        f.stam = Math.max(0, f.stam - 4);
        f.act = { type: 'hit', name: 'body', t: 0, dur: 0.45, hit: false }; // exposed for a moment
        // a read attempt (denied while they were basing) can be punished with a worse position
        const punished = mv.failTo && denied && this.rand() < PUNISH_CHANCE;
        if (punished) this._setPos(mv.failTo);
        this._emit({ k: 'gresult', i: f.idx, j: o.idx, ok: false, name: mv.name, pos: punished ? mv.failTo : null, denied });
      }
    }

    // submission entry is a roll; odds favour attacking a fighter who is exposed, rocked or gassed
    _trySub(f, o, role, name) {
      const G = this.state.ground;
      f.stam = Math.max(0, f.stam - SUB_ATTEMPT_STAM);
      G.idleT = 0;
      let p = 0.45 + f.stats.bjj * 0.35 - o.stats.bjj * 0.25;
      if (o.act.type === 'hit' || o.act.type === 'stumble') p += 0.25;      // they just failed something / got hit: exposed
      if (o.act.type === 'strike') p += 0.15;                                // swinging: arm is out there
      if (o.rocked > 0) p += 0.25;
      if (o.stam < 25) p += 0.1;
      if (G.pos === 'mount' || G.pos === 'back') p += 0.15;
      if (f.stam < 25) p -= 0.1;
      p = clamp(p, 0.1, 0.95);
      if (this.rand() < p) { this._startSub(f, o, role, name); return; }
      G.cd[f.idx] = SUB_FAIL_CD;
      f.act = { type: 'hit', name: 'body', t: 0, dur: 0.5, hit: false }; // reached and got nothing
      this._emit({ k: 'subfail', i: f.idx, j: o.idx, name, stuffed: true });
    }

    _startSub(f, o, role, name) {
      const G = this.state.ground;
      G.sub = { name, att: f.idx, def: o.idx, role, prog: 12 + f.stats.bjj * 12, t: 0, squeezing: false, escCd: 0.4 };
      G.idleT = 0;
      f.act = { type: 'sub', name, t: 0, dur: 99, hit: false };
      o.act = { type: 'caught', name, t: 0, dur: 99, hit: false };
      f.rs.subs++;
      this._emit({ k: 'sub', i: f.idx, j: o.idx, name });
    }

    _subTick(dt) {
      const S = this.state, G = S.ground, sub = G.sub;
      const att = S.f[sub.att], def = S.f[sub.def];
      const ai = this.inputs[att.idx], di = this.inputs[def.idx];
      sub.t += dt;
      sub.escCd = Math.max(0, sub.escCd - dt);
      sub.squeezing = !!(ai.held & IN.GRAPPLE);
      sub.defending = !!(di.held & IN.BLOCK);
      if (sub.squeezing) {
        let rate = (5 + att.stats.bjj * 7) * (1 + (100 - def.stam) / 200) * (def.rocked > 0 ? 1.5 : 1);
        if (sub.defending) rate *= 0.4;
        sub.prog += rate * dt;
        att.stam = Math.max(0, att.stam - dt * 6);
      } else sub.prog -= SUB_DECAY * dt;
      if (sub.defending) def.stam = Math.max(0, def.stam - dt * 3);
      // escape attempt
      if ((di.pressed & IN.GRAPPLE) && sub.escCd <= 0) {
        sub.escCd = 1.2;
        let p = 0.2 + def.stats.bjj * 0.35 - att.stats.bjj * 0.2 + (1 - sub.prog / 100) * 0.25 + (sub.squeezing ? 0 : 0.3) + (att.stam < 30 ? 0.15 : 0) - (def.rocked > 0 ? 0.2 : 0);
        p = clamp(p, 0.05, 0.9);
        def.stam = Math.max(0, def.stam - 5);
        if (this.rand() < p) {
          const pos = subEscapePos(sub.role, G.pos);
          G.sub = null; att.act = { type: 'hit', name: 'body', t: 0, dur: 0.5, hit: false }; def.act = idleAct();
          G.cd[att.idx] = SUB_FAIL_CD;
          this._emit({ k: 'subescape', i: def.idx, j: att.idx, name: sub.name });
          if (sub.role === 'bottom') { /* the top scrambles out of the guard */ }
          this._setPos(pos);
          return;
        }
        sub.prog += 6;
        this._emit({ k: 'subhold', i: att.idx, j: def.idx, name: sub.name });
      }
      sub.prog = clamp(sub.prog, 0, 100);
      if (sub.prog >= 100) {
        this._endRound(true);
        this._emit({ k: 'tap', i: att.idx, j: def.idx, name: sub.name });
        def.act = { type: 'down', name: '', t: 0, dur: 99, hit: false };
        att.act = { type: 'celebrate', name: '', t: 0, dur: 99, hit: false };
        const min = Math.floor((S.roundLen - S.clock) / 60), sec = Math.floor((S.roundLen - S.clock) % 60);
        this._finish({ method: 'Submission (' + sub.name + ')', winner: att.idx, round: S.round, time: min + ':' + (sec < 10 ? '0' : '') + sec });
        return;
      }
      if (sub.prog <= 0 || att.stam <= 1) {
        G.sub = null; G.cd[att.idx] = SUB_FAIL_CD;
        att.stam = Math.max(0, att.stam - 6);
        att.act = { type: 'hit', name: 'body', t: 0, dur: 0.6, hit: false };
        def.act = idleAct();
        this._emit({ k: 'subfail', i: att.idx, j: def.idx, name: sub.name });
      }
    }

    _countBits(v) { let c = 0; while (v) { c += v & 1; v >>>= 1; } return c; }
  }

  // ---------- Commentary ----------
  function describe(ev, S) {
    const n = i => S.f[i].name;
    switch (ev.k) {
      case 'bell': return ev.end ? 'End of round ' + ev.round + '.' : 'Round ' + ev.round + ' — FIGHT!';
      case 'round': return 'Round ' + ev.round + ' coming up.';
      case 'stance': return n(ev.i) + ' switches to ' + (ev.southpaw ? 'southpaw' : 'orthodox') + '.';
      case 'hit': {
        if (ev.pop) return n(ev.i) + ' connects on ' + n(ev.j) + '!';
        if (ev.edge) return n(ev.i) + ' cuts ' + n(ev.j) + ' clean!';
        const where = ev.part && ev.intended && ev.part !== ev.intended ? ' to the ' + (ev.part === 'legs' ? 'leg' : ev.part) : '';
        if (ev.rocked) return n(ev.i) + ' ROCKS ' + n(ev.j) + ' with a ' + ev.name + where + '!';
        if (ev.kickCancel) return n(ev.i) + ' catches ' + n(ev.j) + ' on one leg with a ' + ev.name + where + '!';
        if (ev.counter) return 'Counter ' + ev.name + where + ' by ' + n(ev.i) + '!';
        if (ev.buckled) return n(ev.j) + "'s leg buckles from that " + ev.name + '!';
        if (ev.winded) return 'That ' + ev.name + ' takes the wind out of ' + n(ev.j) + '.';
        if (ev.momentum) return n(ev.j) + ' walks into a ' + ev.name + where + '!';
        if (ev.combo >= 2) return n(ev.i) + ' follows up with a ' + ev.name + where + (ev.combo >= 3 ? ' — beautiful combination!' : '.');
        if (ev.big) return n(ev.i) + ' lands a heavy ' + ev.name + where + '.';
        if (ev.jammed) return n(ev.i) + "'s " + ev.name + ' is smothered' + where + ' — no room on it.';
        return n(ev.i) + ' lands a ' + ev.name + where + '.';
      }
      case 'block': return ev.checked ? n(ev.j) + ' checks the ' + ev.name + '!' : ev.parry ?'They lock — neither one gets through.' : ev.passive ? n(ev.i) + "'s " + ev.name + ' is picked off by the arms.' : n(ev.j) + ' blocks the ' + ev.name + '.';
      case 'push': return ev.ok ? n(ev.i) + ' shoves ' + n(ev.j) + ' off.' : n(ev.i) + ' pushes at air.';
      case 'miss': return ev.slipped ? n(ev.j) + ' slips the ' + ev.name + '.' : n(ev.i) + ' misses with the ' + ev.name + '.';
      case 'rocked': return null;
      case 'kd': return n(ev.j) + ' GOES DOWN!';
      case 'follow': return n(ev.i) + ' dives on him!';
      case 'getup': return ev.forced ? 'The referee waves ' + n(ev.i) + ' back up.' : n(ev.i) + ' climbs back to his feet.';
      case 'shoot': return n(ev.i) + ' shoots for the takedown...';
      case 'td': return 'Takedown complete — ' + n(ev.i) + ' is on top.';
      case 'tdfail': return ev.sprawl ? n(ev.j) + ' sprawls and stuffs it!' : ev.air ? n(ev.i) + ' shoots at air.' : n(ev.j) + ' defends the takedown.';
      case 'gattempt': return n(ev.i) + (ev.name.indexOf('stand') >= 0 ? ' tries to ' : ' works to ') + ev.name + '...';
      case 'gresult': {
        if (ev.ok) {
          if (ev.stand) return n(ev.i) + ' gets back to his feet!';
          if (ev.flip) return 'REVERSAL! ' + n(ev.i) + ' sweeps into ' + POS_NAME[ev.pos] + '!';
          return n(ev.i) + ' ' + (ev.name.indexOf('pass') >= 0 ? 'passes to ' : ev.name.indexOf('mount') >= 0 ? 'takes the ' : 'gets to ') + POS_NAME[ev.pos] + '.';
        }
        if (ev.pos) return n(ev.j) + ' punishes the attempt — ' + POS_NAME[ev.pos] + '!';
        return ev.denied ? n(ev.j) + ' shuts down the ' + ev.name + '.' : n(ev.i) + ' can\'t ' + ev.name + '.';
      }
      case 'subescape': return n(ev.i) + ' slips out of the ' + ev.name + '!';
      case 'subhold': return n(ev.i) + ' keeps the ' + ev.name + ' locked in.';
      case 'standup': return ev.reason === 'ref' ? 'The referee stands them up.' : ev.reason === 'letup' ? n(ev.i) + ' is let back to his feet.' : n(ev.i) + ' scrambles back to his feet!';
      case 'sub': return n(ev.i) + ' is hunting for a ' + ev.name + '!';
      case 'subfail': return ev.stuffed ? n(ev.j) + ' sees the ' + ev.name + ' coming and shuts it down.' : n(ev.j) + ' works free of the ' + ev.name + '.';
      case 'tap': return "IT'S OVER! " + n(ev.j) + ' taps to the ' + ev.name + '!';
      case 'ko': return ev.method === 'FATALITY' ? 'FATALITY!' : "IT'S ALL OVER! " + n(ev.i) + ' wins by ' + ev.method + '!';
      case 'end': return null;
    }
    return null;
  }

  const API = { IN, STRIKES, ROSTER, SUBS, POS_NAME, MOVES, SUBS_BY, BOTTOM_CAN_STRIKE, Sim, describe, CAGE_R, DT, BREAK_T,
    KD: { FALL: KD_FALL, STAY: KD_STAY, RISE: KD_RISE, FOLLOW_DIST: KD_FOLLOW_DIST },
    LIMBS, LIMB_BIT, LIMB_NAME, MODS, MOD_BIT, HAND_KINDS, LEG_KINDS, KIND_LABEL, KIND_STATS, DEFAULT_MOVESET, normalizeMoveset, modOf, isSouthpaw, strikeTip, TIP_R, recovering };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.MMASim = API;
})(typeof window !== 'undefined' ? window : globalThis);
