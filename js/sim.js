/* ============================================================
   CAGE RULES — fight simulation
   Pure, deterministic (seeded), fixed-step. No DOM, no Three.js.
   Runs on the host (or locally in practice mode); clients only
   receive snapshots of `sim.state`.

   Striking model (v2): every strike is a limb (left/right hand or
   leg) + a kind chosen by the fighter's moveset and the modifier
   being held. Each strike has an authored path for the striking
   tip (fist / foot / knee) in the attacker's frame. While the
   strike is live the sim sweeps that tip against the opponent's
   head / torso / legs hitboxes every tick. Damage scales with the
   closing speed between the tip and the target (moving into a
   strike hurts more, backing off hurts less) and drops sharply when
   the limb is jammed (contact before it extends).
   ============================================================ */
(function (root) {
  'use strict';

  // ---------- Input bits ----------
  const IN = {
    FWD: 1, BACK: 2, LEFT: 4, RIGHT: 8,
    LHAND: 16, RHAND: 32, LLEG: 64, RLEG: 128,
    MOD1: 256, MOD2: 512, MOD3: 1024,
    BLOCK: 2048, GRAPPLE: 4096, DODGE: 8192
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
  const ARM_REACH = 0.64, LEG_REACH = 0.96, KNEE_REACH = 0.5;

  // [windup, active, recover, damage, stamina] for lead (left) and rear (right) limbs
  const KIND_STATS = {
    straight: { lead: [0.12, 0.07, 0.16, 1.5, 2.5], rear: [0.20, 0.08, 0.24, 3.0, 4.5], part: 'head', names: ['jab', 'cross'] },
    hook:     { lead: [0.20, 0.08, 0.22, 2.9, 5.0], rear: [0.24, 0.08, 0.26, 3.5, 5.5], part: 'head', names: ['lead hook', 'right hook'] },
    uppercut: { lead: [0.18, 0.08, 0.22, 2.8, 5.0], rear: [0.23, 0.08, 0.26, 3.6, 5.5], part: 'head', names: ['lead uppercut', 'rear uppercut'] },
    overhand: { lead: [0.26, 0.09, 0.30, 3.2, 6.0], rear: [0.30, 0.09, 0.32, 4.2, 7.0], part: 'head', names: ['looping left', 'overhand right'] },
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
      case 'overhand': return [G, [w, -0.05, s * 0.3, 1.6], [w + a * 0.3, 0.45, s * 0.18, 1.82], [w + a * 0.8, 0.92, -s * 0.05, 1.5], [w + a, 0.84, -s * 0.1, 1.36], E];
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
          pivot: hand ? [0, s * 0.23, 1.36] : [0, s * 0.12, 0.86],
          reach: hand ? ARM_REACH : kind === 'knee' ? KNEE_REACH : LEG_REACH
        };
        st.path = hand ? handPath(limb, kind, st.w, st.a, st.r) : legPath(limb, kind, st.w, st.a, st.r);
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
      gpunch:  { w: 0.18, a: 0.05, r: 0.28, dmg: 1.6,  stam: 3,   part: 'head', names: ['left hand', 'right hand'] },
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

  const SUBS = ['armbar', 'rear-naked choke', 'guillotine', 'kimura', 'triangle choke'];

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

  function makeFighter(idx, key, name, color, moveset) {
    const r = ROSTER[key] || ROSTER.balanced;
    return {
      idx, key: r.key, name: name || r.name, style: r.style,
      stats: Object.assign({}, r.stats),
      color: color != null ? color : r.color, skin: r.skin,
      moveset: normalizeMoveset(moveset),
      x: idx === 0 ? -1.3 : 1.3, z: 0,
      vx: 0, vz: 0,
      dmg: { head: 0, body: 0, legs: 0 },
      stam: 100,
      act: { type: 'idle', name: '', t: 0, dur: 0, hit: false },
      buf: null,          // buffered strike {key, t}
      combo: 0, comboT: 0, // strikes chained without a pause
      blocking: false,
      rocked: 0,          // seconds remaining rocked
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
  // A strike whose active window has passed can be cancelled into the next action (combo flow),
  // unless it was slipped — an over-committed whiff has to be ridden out.
  function recovering(f) {
    const a = f.act;
    if (a.type !== 'strike') return false;
    const st = STRIKES[a.name];
    return !a.slipped && a.t >= (st.w + st.a) * a.tf;
  }
  const BUFFER_T = 0.3; // seconds a buffered strike press stays valid

  class Sim {
    constructor(opts) {
      opts = opts || {};
      this.rand = mulberry32(opts.seed != null ? opts.seed : 1337);
      this.settings = { rounds: opts.rounds || 3, roundLen: opts.roundLen || 180 };
      const p = opts.players || [{}, {}];
      this.state = {
        t: 0,                     // sim time
        phase: 'intro',           // intro | fight | break | over
        phaseT: 0,
        round: 1,
        clock: this.settings.roundLen,
        rounds: this.settings.rounds,
        roundLen: this.settings.roundLen,
        f: [makeFighter(0, p[0].fighter || 'striker', p[0].name, p[0].color, p[0].moveset),
            makeFighter(1, p[1].fighter || 'wrestler', p[1].name, p[1].color, p[1].moveset)],
        ground: null,             // { top, bottom, escape, sub, ctrlT, idleT }
        cards: [],                // per round [{p0, p1, j:[[10,9],[10,9],[10,9]]}]
        result: null,
        evSeq: 0
      };
      this.events = [];           // {seq, k, ...}
      this.roundScore = [{}, {}];
      this._resetRoundScore();
      this.inputs = [{ held: 0, pressed: 0 }, { held: 0, pressed: 0 }];
    }

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
          if (S.phaseT >= 3.2) { S.phase = 'fight'; S.phaseT = 0; this._emit({ k: 'bell', round: S.round }); }
          break;
        case 'fight':
          this._fightTick(dt);
          break;
        case 'break':
          if (S.phaseT >= 10) this._startRound();
          break;
        case 'over':
          this._cooldown(dt);
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
        for (const f of S.f) {
          f.ground = null; f.act = idleAct();
          // corner recovery
          f.stam = clamp(f.stam + 45, 0, 100);
          f.dmg.head = Math.max(0, f.dmg.head - 10);
          f.dmg.body = Math.max(0, f.dmg.body - 6);
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
        if (f.rocked > 0) { f.rocked -= dt; if (f.rocked < 0) f.rocked = 0; }
        f.wobble = Math.max(0, f.wobble - dt * 0.8);
        let regen = 2.2 + f.stats.car * 4.5;
        regen *= (1 - f.dmg.body / 160);
        if (f.blocking) regen *= 0.35;
        if (f.act.type === 'move') regen *= 0.55;
        if (f.ground === 'bottom') regen *= 0.7;
        if (S.ground && S.ground.sub) regen = 0;
        f.stam = clamp(f.stam + regen * dt, 0, 100);
      }

      if (S.ground) this._groundTick(dt);
      else this._standTick(dt, dist, ux, uz);

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
          } else if (!a.hit && !S.ground) {
            const t0 = st.w * tf * 0.45, t1 = (st.w + st.a) * tf;
            if (a.t >= t0) {
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

      // round / finish checks
      if (S.phase === 'fight') {
        const stop = this._checkStoppage();
        if (!stop && S.clock <= 0) { S.clock = 0; this._endRound(false); }
      }
    }

    _checkStoppage() {
      const S = this.state;
      for (const f of S.f) {
        const o = S.f[1 - f.idx];
        let method = null;
        if (f.dmg.head >= 100) method = 'KO';
        else if (f.dmg.body >= 100) method = 'TKO (body)';
        else if (f.dmg.legs >= 100) method = 'TKO (leg kicks)';
        else if (f.ground === 'bottom' && f.dmg.head >= 92 && f.act.type === 'hit') method = 'TKO (ground strikes)';
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
        f.vx = 0; f.vz = 0;

        // movement — allowed while striking at half speed, so you can step into (or away from) shots
        if (!busy || striking) {
          let mx = 0, mz = 0;
          const slow = (1 - f.dmg.legs / 140) * (f.rocked > 0 ? 0.45 : 1) * (0.7 + f.stam / 330) * (f.blocking ? 0.6 : 1) * (striking ? 0.5 : 1);
          const spd = (1.9 + f.stats.spd * 1.0) * slow;
          if (held & IN.FWD) { mx += fx; mz += fz; }
          if (held & IN.BACK) { mx -= fx * 0.8; mz -= fz * 0.8; }
          if (held & IN.LEFT) { mx += lx * 0.85; mz += lz * 0.85; }
          if (held & IN.RIGHT) { mx -= lx * 0.85; mz -= lz * 0.85; }
          if (mx || mz) {
            f.vx = mx * spd; f.vz = mz * spd;
            f.x += f.vx * dt; f.z += f.vz * dt;
            if (!busy) f.act = { type: 'move', name: '', t: 0, dur: 0, hit: false };
          } else if (f.act.type === 'move') f.act = idleAct();
        }

        if (!busy) {
          // actions (press-triggered)
          if (pressed & IN.DODGE && f.stam > 6 && f.rocked <= 0) {
            f.stam -= 5;
            f.act = { type: 'dodge', name: '', t: 0, dur: 0.45, hit: false };
            f.blocking = false;
          } else if (pressed & IN.GRAPPLE && f.rocked <= 0) {
            if (dist <= 1.7 && f.stam > 8) {
              f.stam -= 7; f.rs.tdAtt++;
              f.act = { type: 'takedown', name: '', t: 0, dur: 0.75, hit: false };
              f.blocking = false;
              this._emit({ k: 'shoot', i });
            }
          } else if (pressed & LIMB_BITS) {
            const key = this._pickStrikeKey(f, pressed, held, false);
            if (key) this._startStrike(f, key, canCancel);
          } else if (f.buf && S.t - f.buf.t <= BUFFER_T) {
            this._startStrike(f, f.buf.key, canCancel);
          }
          if (f.buf && (f.act.type !== 'strike' || S.t - f.buf.t > BUFFER_T || f.act.t === 0)) f.buf = null;
        }

        // keep inside cage
        const r = Math.hypot(f.x, f.z);
        if (r > CAGE_R) { f.x *= CAGE_R / r; f.z *= CAGE_R / r; }
      }
      // body collision
      const dx = F[1].x - F[0].x, dz = F[1].z - F[0].z;
      const d = Math.hypot(dx, dz) || 0.001;
      if (d < MIN_DIST) {
        const push = (MIN_DIST - d) / 2, nx = dx / d, nz = dz / d;
        F[0].x -= nx * push; F[0].z -= nz * push; F[1].x += nx * push; F[1].z += nz * push;
      }
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
      const key = limb + '_' + kind;
      return STRIKES[key] ? key : limb + '_' + DEFAULT_MOVESET[mod][limb];
    }

    _startStrike(f, key, chained) {
      const st = STRIKES[key];
      if (f.stam < 3) return;
      let tf = (1.15 - f.stats.spd * 0.3) * (1 + (1 - f.stam / 100) * 0.4) * (f.rocked > 0 ? 1.3 : 1);
      if (chained) {
        // flowing straight out of the last strike: quicker, up to a 3-strike rhythm; the same limb twice in a row is slower
        f.combo = Math.min(3, f.combo + 1);
        const same = f.act.type === 'strike' && STRIKES[f.act.name].limb === st.limb;
        tf *= same ? 1.0 : (1 - 0.06 * f.combo);
      } else f.combo = 0;
      f.comboT = 0.45;
      f.buf = null;
      f.stam = Math.max(0, f.stam - st.stam * (f.stam < 25 ? 0.6 : 1) * (chained ? 1.1 : 1));
      f.act = { type: 'strike', name: key, t: 0, dur: (st.w + st.a + st.r) * tf, tf, hit: false, tip: null, tipT: null, slipped: false, chained: !!chained };
      f.blocking = false;
      f.rs.thrown++;
    }

    // opponent hitboxes in world space, as capsules {part, a:[x,y,z], b:[x,y,z], r}
    _hitboxes(o, f) {
      const fr = this._frame(o, f); // o's frame, facing f
      const W = (p) => [o.x + fr.fx * p[0] + fr.lx * p[1], p[2], o.z + fr.fz * p[0] + fr.lz * p[1]];
      let head = [0.06, 0, 1.52], torsoA = [0.0, 0, 0.95], torsoB = [0.03, 0, 1.2];
      const a = o.act;
      if (a.type === 'dodge' && a.t < 0.32) { head = [-0.08, 0.34, 1.36]; torsoB = [-0.02, 0.12, 1.16]; }
      else if (a.type === 'hit') {
        if (a.name === 'head') head = [-0.14, 0, 1.5];
        else if (a.name === 'body') { head = [0.2, 0, 1.3]; torsoB = [0.15, 0, 1.12]; }
        else head = [0.06, 0.1, 1.42];
      } else if (a.type === 'stumble' || a.type === 'takedown') { head = [0.32, 0, 1.2]; torsoB = [0.25, 0, 1.1]; }
      else if (o.blocking) head = [0.0, 0, 1.46];
      if (o.rocked > 0 && a.type !== 'hit') head[2] -= 0.05;
      const hw = W(head);
      return [
        { part: 'head', a: hw, b: hw, r: PART_R.head },
        { part: 'body', a: W(torsoA), b: W(torsoB), r: PART_R.body },
        { part: 'legs', a: W([0, 0, 0.1]), b: W([0, 0, 0.82]), r: PART_R.legs }
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

    _whiff(f, st) {
      const o = this.state.f[1 - f.idx];
      if (f.act.slipped) {
        this._emit({ k: 'miss', i: f.idx, j: o.idx, name: st.name, slipped: true });
        f.act.dur *= 1.35; // over-committed
      } else this._emit({ k: 'miss', i: f.idx, name: st.name, whiff: true });
    }

    _landStrike(f, o, st, part, speedF, jamF, at, fr) {
      const counter = o.act.type === 'strike' && !o.act.hit;
      const phys = clamp(0.2 + 0.8 * speedF, 0.2, 1.45) * jamF;
      let dmg = st.dmg * (0.7 + f.stats.pow * 0.6) * (0.8 + 0.2 * f.stam / 100) * lerp(0.88, 1.12, this.rand()) * phys;
      if (counter) dmg *= 1.35;
      if (o.rocked > 0) dmg *= 1.25;
      if (f.rocked > 0) dmg *= 0.7;
      let blocked = false;
      if (o.blocking) {
        blocked = true;
        if (part === 'legs') dmg *= 0.45; else dmg *= 0.15;
        o.stam = Math.max(0, o.stam - st.dmg * 0.35);
      }
      o.dmg[part] = clamp(o.dmg[part] + dmg, 0, 100);
      f.rs.landed++;
      f.rs.sig += dmg;
      if (blocked) {
        this._emit({ k: 'block', i: f.idx, j: o.idx, name: st.name, part, at });
        if (st.push) { o.x += fr.fx * 0.2; o.z += fr.fz * 0.2; }
        return;
      }
      // hit reaction — each extra hit landed while still stunned stuns less, so a combo can't lock someone up forever
      o.hitChain = (o.act.type === 'hit' && this.state.t - (o.lastHitT || -9) < 0.7) ? (o.hitChain || 0) + 1 : 0;
      o.lastHitT = this.state.t;
      const stun = (0.2 + dmg * 0.025) * Math.pow(0.6, o.hitChain);
      o.act = { type: 'hit', name: part, t: 0, dur: stun, hit: false };
      o.blocking = false;
      // pushback (teeps shove hard)
      const pb = st.push ? Math.min(0.6, 0.25 + dmg * 0.05) : Math.min(0.35, dmg * 0.04);
      o.x += fr.fx * pb; o.z += fr.fz * pb;
      const ev = this._emit({ k: 'hit', i: f.idx, j: o.idx, name: st.name, kind: st.kind, part, intended: st.part, dmg: Math.round(dmg * 10) / 10, counter, big: dmg >= 3.6,
        phys: Math.round(phys * 100) / 100, jammed: jamF < 0.7, momentum: speedF > 1.15 && jamF >= 0.7, combo: f.combo, at });
      this._afterHit(f, o, part, dmg, ev, false);
    }

    _afterHit(f, o, part, dmg, ev, onGround) {
      // rocked / knockdown
      if (part === 'head') {
        const thr = (4.6 + o.stats.chin * 4.6) * (1 - o.dmg.head / 170);
        if (o.rocked > 0 && dmg >= 2.8 && !onGround) {
          this._knockdown(f, o);
        } else if (dmg >= thr) {
          o.rocked = Math.max(o.rocked, 2.2 + dmg * 0.06);
          o.wobble = 1;
          ev.rocked = true;
          this._emit({ k: 'rocked', i: f.idx, j: o.idx });
          if (!onGround && dmg >= thr * 1.6) this._knockdown(f, o);
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
      let dmg = st.dmg * (0.7 + f.stats.pow * 0.6) * (0.6 + 0.4 * f.stam / 100) * lerp(0.85, 1.15, this.rand());
      if (o.rocked > 0) dmg *= 1.25;
      if (f.rocked > 0) dmg *= 0.7;
      let blocked = false;
      if (this.inputs[o.idx].held & IN.BLOCK) { blocked = true; dmg *= 0.3; o.stam = Math.max(0, o.stam - 1.5); }
      o.dmg[st.part] = clamp(o.dmg[st.part] + dmg, 0, 100);
      f.rs.landed++; f.rs.sig += dmg;
      if (blocked) { this._emit({ k: 'block', i: f.idx, j: o.idx, name: st.name, part: st.part }); return; }
      const stun = 0.2 + dmg * 0.025;
      o.act = { type: 'hit', name: st.part, t: 0, dur: stun * 0.8, hit: false };
      S.ground.idleT = 0;
      S.ground.escape = clamp(S.ground.escape + 4, 0, 100);
      const ev = this._emit({ k: 'hit', i: f.idx, j: o.idx, name: st.name, kind: st.kind, part: st.part, intended: st.part, dmg: Math.round(dmg * 10) / 10, counter: false, big: dmg >= 3.6, ground: true });
      this._afterHit(f, o, st.part, dmg, ev, true);
    }

    _knockdown(att, vic) {
      const S = this.state;
      if (S.ground) return;
      vic.kdCount++; att.rs.kd++;
      this._emit({ k: 'kd', i: att.idx, j: vic.idx });
      vic.rocked = Math.max(vic.rocked, 3);
      if (vic.dmg.head >= 84) { vic.dmg.head = 100; return; } // flash KO, caught by stoppage check
      this._enterGround(att, vic, 'kd');
    }

    _resolveTakedown(f) {
      const S = this.state, o = S.f[1 - f.idx];
      const dist = Math.hypot(o.x - f.x, o.z - f.z);
      if (dist > 1.85) {
        f.act = { type: 'stumble', name: 'td', t: 0, dur: 0.7, hit: false };
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
        this._enterGround(f, o, 'td');
      } else {
        f.act = { type: 'stumble', name: 'td', t: 0, dur: 0.95, hit: false };
        f.stam = Math.max(0, f.stam - 6);
        if (o.blocking) o.act = { type: 'sprawl', name: '', t: 0, dur: 0.35, hit: false };
        this._emit({ k: 'tdfail', i: f.idx, j: o.idx, sprawl: o.blocking });
      }
    }

    _enterGround(top, bottom, how) {
      const S = this.state;
      const mx = (top.x + bottom.x) / 2, mz = (top.z + bottom.z) / 2;
      // keep off the fence a bit
      const r = Math.hypot(mx, mz), lim = CAGE_R - 0.9;
      const cx = r > lim ? mx * lim / r : mx, cz = r > lim ? mz * lim / r : mz;
      top.x = cx; top.z = cz; bottom.x = cx; bottom.z = cz;
      top.vx = top.vz = bottom.vx = bottom.vz = 0;
      top.ground = 'top'; bottom.ground = 'bottom';
      top.blocking = false; bottom.blocking = false;
      top.act = idleAct();
      bottom.act = { type: 'hit', name: 'head', t: 0, dur: how === 'kd' ? 0.8 : 0.5, hit: false };
      S.ground = { top: top.idx, bottom: bottom.idx, escape: how === 'kd' ? 10 : 0, sub: null, ctrlT: 0, idleT: 0 };
    }

    _standUp(reason) {
      const S = this.state; if (!S.ground) return;
      const top = S.f[S.ground.top], bot = S.f[S.ground.bottom];
      top.ground = null; bot.ground = null;
      top.act = idleAct();
      bot.act = idleAct();
      // separate
      const ang = this.rand() * Math.PI * 2;
      bot.x = clamp(bot.x + Math.cos(ang) * 0.9, -CAGE_R, CAGE_R); bot.z = clamp(bot.z + Math.sin(ang) * 0.9, -CAGE_R, CAGE_R);
      top.x = clamp(top.x - Math.cos(ang) * 0.6, -CAGE_R, CAGE_R); top.z = clamp(top.z - Math.sin(ang) * 0.6, -CAGE_R, CAGE_R);
      S.ground = null;
      this._emit({ k: 'standup', i: bot.idx, reason });
    }

    // ---------------------------------------------------------
    //  GROUND
    // ---------------------------------------------------------
    _groundTick(dt) {
      const S = this.state, G = S.ground;
      const top = S.f[G.top], bot = S.f[G.bottom];
      const ti = this.inputs[top.idx], bi = this.inputs[bot.idx];
      top.rs.ctrl += dt; G.ctrlT += dt; G.idleT += dt;
      top.blocking = false; bot.blocking = false;
      const topBusy = top.act.type !== 'idle' && !recovering(top);
      const botBusy = bot.act.type !== 'idle';

      // --- submission in progress: arrow-sequence duel ---
      if (G.sub) {
        const sub = G.sub; sub.t += dt;
        // slow passive squeeze so the defender can't just wait it out
        sub.prog += (0.5 + top.stats.bjj * 2) * (1 + (100 - bot.stam) / 150) * (bot.rocked > 0 ? 1.6 : 1) * dt;
        top.stam = Math.max(0, top.stam - dt * 3);
        const roles = [[sub.att, ti, top, true], [sub.def, bi, bot, false]];
        for (const [sq, inp, f, isAtt] of roles) {
          sq.timer -= dt;
          let presses = inp.pressed & DIR_BITS;
          let fail = false, done = false;
          while (presses) {
            const bit = presses & -presses; presses &= ~bit;
            if (bit === sq.keys[sq.idx]) { sq.idx++; if (sq.idx >= sq.keys.length) { done = true; break; } }
            else { fail = true; break; }
          }
          if (!fail && !done && sq.timer <= 0) fail = true;
          if (done) {
            sq.done++;
            if (isAtt) sub.prog += 15 + top.stats.bjj * 12;
            else sub.prog -= 16 + bot.stats.bjj * 8 + bot.stam / 16;
            this._newSeq(sq, f, isAtt, bot);
            this._emit({ k: 'seq', i: f.idx, ok: true });
          } else if (fail) {
            sq.fails++;
            f.stam = Math.max(0, f.stam - 3);
            this._newSeq(sq, f, isAtt, bot);
            this._emit({ k: 'seq', i: f.idx, ok: false, fails: sq.fails });
          }
        }
        sub.prog = clamp(sub.prog, 0, 100);
        const tapped = sub.prog >= 100 || sub.def.fails >= 3;
        const broken = !tapped && (sub.prog <= 0 || sub.att.fails >= 3 || top.stam <= 0);
        if (tapped) {
          this._endRound(true);
          this._emit({ k: 'tap', i: top.idx, j: bot.idx, name: sub.name });
          bot.act = { type: 'down', name: '', t: 0, dur: 99, hit: false };
          top.act = { type: 'celebrate', name: '', t: 0, dur: 99, hit: false };
          const min = Math.floor((S.roundLen - S.clock) / 60), sec = Math.floor((S.roundLen - S.clock) % 60);
          this._finish({ method: 'Submission (' + sub.name + ')', winner: top.idx, round: S.round, time: min + ':' + (sec < 10 ? '0' : '') + sec });
          return;
        }
        if (broken) {
          G.sub = null; G.escape = clamp(G.escape + 40, 0, 100);
          top.stam = Math.max(0, top.stam - 14);
          top.act = idleAct();
          this._emit({ k: 'subfail', i: top.idx, j: bot.idx, name: sub.name });
        }
        return;
      }

      // --- TOP player ---
      if (!topBusy) {
        if (ti.held & IN.BLOCK) {
          // posture / control: freeze escape, slowly drain bottom
          G.escape = Math.max(0, G.escape - dt * 6);
          top.posture = true;
        } else top.posture = false;
        if (ti.pressed & IN.DODGE) { this._standUp('letup'); return; }
        else if (ti.pressed & IN.GRAPPLE && top.stam > 12) {
          const name = SUBS[Math.floor(this.rand() * SUBS.length)];
          G.sub = { name, t: 0, prog: 40 + top.stats.bjj * 8, att: { keys: [], idx: 0, fails: 0, done: 0, timer: 0, limit: 0 }, def: { keys: [], idx: 0, fails: 0, done: 0, timer: 0, limit: 0 } };
          this._newSeq(G.sub.att, top, true, bot); this._newSeq(G.sub.def, bot, false, bot);
          top.rs.subs++; G.idleT = 0;
          top.act = { type: 'sub', name, t: 0, dur: 99, hit: false };
          this._emit({ k: 'sub', i: top.idx, j: bot.idx, name });
          return;
        } else if (ti.pressed & LIMB_BITS && !(ti.held & IN.BLOCK)) {
          const key = this._pickStrikeKey(top, ti.pressed, ti.held, true);
          if (key) { this._startStrike(top, key, recovering(top)); G.idleT = 0; }
        }
      }

      // --- BOTTOM player ---
      if (!botBusy) {
        const presses = this._countBits(bi.pressed & DIR_BITS);
        if (presses) {
          const gain = presses * 1.6 * (0.45 + (bot.stats.wre * 0.5 + bot.stats.bjj * 0.6)) * (0.5 + bot.stam / 200) * (bot.rocked > 0 ? 0.4 : 1) * (top.posture ? 0.35 : 1);
          G.escape = clamp(G.escape + gain, 0, 100);
          bot.stam = Math.max(0, bot.stam - presses * 0.25);
        }
        if (bi.pressed & IN.GRAPPLE && bot.stam > 8 && bot.rocked <= 0) {
          // sweep / reversal attempt
          let p = 0.05 + bot.stats.bjj * 0.22 - top.stats.wre * 0.22 + (top.act.type === 'strike' ? 0.2 : 0) + (100 - top.stam) / 350;
          p = clamp(p, 0.05, 0.85);
          bot.stam = Math.max(0, bot.stam - 10);
          G.idleT = 0;
          if (this.rand() < p) {
            top.ground = 'bottom'; bot.ground = 'top';
            G.top = bot.idx; G.bottom = top.idx; G.escape = 0;
            top.act = { type: 'hit', name: 'body', t: 0, dur: 0.6, hit: false };
            bot.act = idleAct();
            bot.rs.td++; // reversal counts like a takedown
            this._emit({ k: 'sweep', i: bot.idx, j: top.idx });
            return;
          } else {
            G.escape = Math.max(0, G.escape - 12);
            bot.act = { type: 'hit', name: 'body', t: 0, dur: 0.45, hit: false };
            this._emit({ k: 'sweepfail', i: bot.idx, j: top.idx });
          }
        }
      }

      if (G.escape >= 100) { this._standUp('escape'); return; }
      if (G.idleT > 9) { this._standUp('ref'); return; }
    }

    // generate a fresh arrow sequence for one side of the submission duel
    _newSeq(sq, f, isAtt, bot) {
      const DIRS = [IN.FWD, IN.LEFT, IN.BACK, IN.RIGHT];
      let len;
      if (isAtt) len = 7 - Math.round(f.stats.bjj * 2);                                  // 5..7, better BJJ = shorter
      else len = 4 + Math.round((1 - f.stats.bjj) * 1.5) + (f.stam < 40 ? 1 : 0) + (f.dmg.head > 50 ? 1 : 0); // 4..8
      len = clamp(len, 4, 8);
      sq.keys = [];
      for (let i = 0; i < len; i++) sq.keys.push(DIRS[Math.floor(this.rand() * 4)]);
      sq.idx = 0;
      sq.limit = isAtt ? 0.45 * len + 0.6 : (0.55 * len + 0.8) * (0.85 + f.stam / 650) * (f.rocked > 0 ? 0.85 : 1);
      sq.timer = sq.limit;
    }

    _countBits(v) { let c = 0; while (v) { c += v & 1; v >>>= 1; } return c; }
  }

  // ---------- Commentary ----------
  function describe(ev, S) {
    const n = i => S.f[i].name;
    switch (ev.k) {
      case 'bell': return ev.end ? 'End of round ' + ev.round + '.' : 'Round ' + ev.round + ' — FIGHT!';
      case 'round': return 'Round ' + ev.round + ' coming up.';
      case 'hit': {
        const where = ev.part && ev.intended && ev.part !== ev.intended ? ' to the ' + (ev.part === 'legs' ? 'leg' : ev.part) : '';
        if (ev.rocked) return n(ev.i) + ' ROCKS ' + n(ev.j) + ' with a ' + ev.name + where + '!';
        if (ev.counter) return 'Counter ' + ev.name + where + ' by ' + n(ev.i) + '!';
        if (ev.buckled) return n(ev.j) + "'s leg buckles from that " + ev.name + '!';
        if (ev.winded) return 'That ' + ev.name + ' takes the wind out of ' + n(ev.j) + '.';
        if (ev.momentum) return n(ev.j) + ' walks into a ' + ev.name + where + '!';
        if (ev.combo >= 2) return n(ev.i) + ' follows up with a ' + ev.name + where + (ev.combo >= 3 ? ' — beautiful combination!' : '.');
        if (ev.big) return n(ev.i) + ' lands a heavy ' + ev.name + where + '.';
        if (ev.jammed) return n(ev.i) + "'s " + ev.name + ' is smothered' + where + ' — no room on it.';
        return n(ev.i) + ' lands a ' + ev.name + where + '.';
      }
      case 'block': return n(ev.j) + ' blocks the ' + ev.name + '.';
      case 'miss': return ev.slipped ? n(ev.j) + ' slips the ' + ev.name + '.' : n(ev.i) + ' misses with the ' + ev.name + '.';
      case 'rocked': return null;
      case 'kd': return n(ev.j) + ' GOES DOWN! ' + n(ev.i) + ' follows him to the mat!';
      case 'shoot': return n(ev.i) + ' shoots for the takedown...';
      case 'td': return 'Takedown complete — ' + n(ev.i) + ' is on top.';
      case 'tdfail': return ev.sprawl ? n(ev.j) + ' sprawls and stuffs it!' : ev.air ? n(ev.i) + ' shoots at air.' : n(ev.j) + ' defends the takedown.';
      case 'sweep': return 'REVERSAL! ' + n(ev.i) + ' sweeps and takes top position!';
      case 'sweepfail': return n(ev.i) + ' tries to sweep but ' + n(ev.j) + ' keeps the position.';
      case 'standup': return ev.reason === 'ref' ? 'The referee stands them up.' : ev.reason === 'letup' ? n(ev.i) + ' is let back to his feet.' : n(ev.i) + ' scrambles back to his feet!';
      case 'sub': return n(ev.i) + ' is hunting for a ' + ev.name + '!';
      case 'seq': return null;
      case 'subfail': return n(ev.j) + ' works free of the ' + ev.name + '.';
      case 'tap': return "IT'S OVER! " + n(ev.j) + ' taps to the ' + ev.name + '!';
      case 'ko': return "IT'S ALL OVER! " + n(ev.i) + ' wins by ' + ev.method + '!';
      case 'end': return null;
    }
    return null;
  }

  const API = { IN, STRIKES, ROSTER, SUBS, Sim, describe, CAGE_R, DT,
    LIMBS, LIMB_BIT, LIMB_NAME, MODS, MOD_BIT, HAND_KINDS, LEG_KINDS, KIND_LABEL, KIND_STATS, DEFAULT_MOVESET, normalizeMoveset, modOf, strikeTip, TIP_R, recovering };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.MMASim = API;
})(typeof window !== 'undefined' ? window : globalThis);
