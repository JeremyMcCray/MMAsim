/* ============================================================
   CAGE RULES — fight simulation
   Pure, deterministic (seeded), fixed-step. No DOM, no Three.js.
   Runs on the host (or locally in practice mode); clients only
   receive snapshots of `sim.state`.
   ============================================================ */
(function (root) {
  'use strict';

  // ---------- Input bits ----------
  const IN = {
    FWD: 1, BACK: 2, LEFT: 4, RIGHT: 8,
    JAB: 16, CROSS: 32, HOOK: 64, HKICK: 128, BKICK: 256, LKICK: 512,
    BLOCK: 1024, GRAPPLE: 2048, DODGE: 4096
  };
  const STRIKE_BITS = IN.JAB | IN.CROSS | IN.HOOK | IN.HKICK | IN.BKICK | IN.LKICK;
  const DIR_BITS = IN.FWD | IN.BACK | IN.LEFT | IN.RIGHT;

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
  // windup / active / recover (seconds), range (m), base damage, target region, stamina cost
  const STRIKES = {
    jab:      { name: 'jab',        bit: IN.JAB,   w: 0.13, a: 0.07, r: 0.20, range: 1.30, dmg: 1.41,  part: 'head', stam: 2.5 },
    cross:    { name: 'cross',      bit: IN.CROSS, w: 0.22, a: 0.08, r: 0.32, range: 1.35, dmg: 2.94,  part: 'head', stam: 4.5 },
    hook:     { name: 'hook',       bit: IN.HOOK,  w: 0.26, a: 0.08, r: 1.15, range: 1.15, dmg: 3.43,   part: 'head', stam: 5.5 },
    hkick:    { name: 'head kick',  bit: IN.HKICK, w: 0.36, a: 0.10, r: 0.48, range: 1.65, dmg: 5.39,   part: 'head', stam: 10 },
    bkick:    { name: 'body kick',  bit: IN.BKICK, w: 0.30, a: 0.10, r: 0.42, range: 1.55, dmg: 3.79,   part: 'body', stam: 8 },
    knee:     { name: 'knee',       bit: IN.BKICK, w: 0.18, a: 0.08, r: 0.30, range: 1.05, dmg: 3.18,   part: 'body', stam: 6 },
    lkick:    { name: 'low kick',   bit: IN.LKICK, w: 0.24, a: 0.10, r: 0.34, range: 1.45, dmg: 2.81,    part: 'legs', stam: 6 },
    // ground strikes
    gnp1:     { name: 'ground punch', bit: IN.JAB,   w: 0.18, a: 0.05, r: 0.28, range: 9, dmg: 1.59, part: 'head', stam: 3, ground: true },
    gnp2:     { name: 'hammer fist',  bit: IN.CROSS, w: 0.24, a: 0.05, r: 0.34, range: 9, dmg: 2.33, part: 'head', stam: 4, ground: true },
    gnp3:     { name: 'elbow',        bit: IN.HOOK,  w: 0.26, a: 0.05, r: 0.36, range: 9, dmg: 2.69, part: 'head', stam: 4.5, ground: true },
    gbody:    { name: 'body shot',    bit: IN.BKICK, w: 0.2,  a: 0.05, r: 0.3,  range: 9, dmg: 1.95, part: 'body', stam: 3, ground: true }
  };
  // fix hook recover typo-proof
  STRIKES.hook.r = 0.34;

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

  function makeFighter(idx, key, name, color) {
    const r = ROSTER[key] || ROSTER.balanced;
    return {
      idx, key: r.key, name: name || r.name, style: r.style,
      stats: Object.assign({}, r.stats),
      color: color != null ? color : r.color, skin: r.skin,
      x: idx === 0 ? -1.3 : 1.3, z: 0,
      dmg: { head: 0, body: 0, legs: 0 },
      stam: 100,
      act: { type: 'idle', name: '', t: 0, dur: 0, hit: false },
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
        f: [makeFighter(0, p[0].fighter || 'striker', p[0].name, p[0].color),
            makeFighter(1, p[1].fighter || 'wrestler', p[1].name, p[1].color)],
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
      // fixed sub-steps
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
        f.x = f.idx === 0 ? -1.3 : 1.3; f.z = 0;
        f.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
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
          f.ground = null; f.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
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
          f.act.t += dt; if (f.act.t >= f.act.dur) f.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
        }
      }
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
          if (!a.hit && a.t >= st.w * tf) { a.hit = true; this._resolveStrike(f, st); }
          if (a.t >= a.dur) f.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
        } else if (a.type === 'takedown') {
          if (!a.hit && a.t >= 0.32) { a.hit = true; this._resolveTakedown(f); }
          if (a.t >= a.dur && f.act === a) f.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
        } else if (a.t >= a.dur) {
          f.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
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
        const f = F[i], o = F[1 - i];
        const inp = this.inputs[i];
        const held = inp.held, pressed = inp.pressed;
        const busy = f.act.type !== 'idle' && f.act.type !== 'move';
        const sign = i === 0 ? 1 : -1; // direction towards opponent along (ux,uz)

        // facing vector towards opponent
        const fx = ux * sign, fz = uz * sign;
        // lateral (circle) vector
        const lx = -fz, lz = fx;

        f.blocking = !busy && !!(held & IN.BLOCK) && f.rocked <= 0.4;

        if (!busy) {
          // movement
          let mx = 0, mz = 0;
          const slow = (1 - f.dmg.legs / 140) * (f.rocked > 0 ? 0.45 : 1) * (0.7 + f.stam / 330) * (f.blocking ? 0.6 : 1);
          const spd = (1.9 + f.stats.spd * 1.0) * slow;
          if (held & IN.FWD) { mx += fx; mz += fz; }
          if (held & IN.BACK) { mx -= fx * 0.8; mz -= fz * 0.8; }
          if (held & IN.LEFT) { mx += lx * 0.85; mz += lz * 0.85; }
          if (held & IN.RIGHT) { mx -= lx * 0.85; mz -= lz * 0.85; }
          if (mx || mz) {
            f.x += mx * spd * dt; f.z += mz * spd * dt;
            f.act = { type: 'move', name: '', t: 0, dur: 0, hit: false };
          } else if (f.act.type === 'move') f.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };

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
          } else if (pressed & STRIKE_BITS) {
            let key = null;
            if (pressed & IN.JAB) key = 'jab';
            else if (pressed & IN.CROSS) key = 'cross';
            else if (pressed & IN.HOOK) key = 'hook';
            else if (pressed & IN.HKICK) key = 'hkick';
            else if (pressed & IN.BKICK) key = dist < 1.1 ? 'knee' : 'bkick';
            else if (pressed & IN.LKICK) key = 'lkick';
            if (key) this._startStrike(f, key);
          }
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

    _startStrike(f, key) {
      const st = STRIKES[key];
      if (f.stam < 3) return;
      const tf = (1.15 - f.stats.spd * 0.3) * (1 + (1 - f.stam / 100) * 0.4) * (f.rocked > 0 ? 1.3 : 1);
      f.stam = Math.max(0, f.stam - st.stam * (f.stam < 25 ? 0.6 : 1));
      f.act = { type: 'strike', name: key, t: 0, dur: (st.w + st.a + st.r) * tf, tf, hit: false };
      f.blocking = false;
      f.rs.thrown++;
    }

    _resolveStrike(f, st) {
      const S = this.state, o = S.f[1 - f.idx];
      const dx = o.x - f.x, dz = o.z - f.z;
      const dist = Math.hypot(dx, dz);
      const onGround = !!st.ground;
      if (!onGround && dist > st.range + 0.08) { this._emit({ k: 'miss', i: f.idx, name: st.name, whiff: true }); return; }
      // dodge?
      if (o.act.type === 'dodge' && o.act.t < 0.32) {
        this._emit({ k: 'miss', i: f.idx, j: o.idx, name: st.name, slipped: true });
        f.act.dur *= 1.35; // over-committed
        return;
      }
      // counter?
      const counter = o.act.type === 'strike' && !o.act.hit;
      // damage
      let dmg = st.dmg * (0.7 + f.stats.pow * 0.6) * (0.6 + 0.4 * f.stam / 100) * lerp(0.85, 1.15, this.rand());
      if (counter) dmg *= 1.35;
      if (o.rocked > 0) dmg *= 1.25;
      if (f.rocked > 0) dmg *= 0.7;
      if (onGround && st.part === 'head' && f.dmg.head > 0) dmg *= 1; // placeholder parity
      let blocked = false;
      if (o.blocking) {
        blocked = true;
        if (st.part === 'legs') dmg *= 0.45; else dmg *= 0.15;
        o.stam = Math.max(0, o.stam - st.dmg * 0.35);
      } else if (onGround && (this.inputs[o.idx].held & IN.BLOCK)) {
        blocked = true; dmg *= 0.3; o.stam = Math.max(0, o.stam - 1.5);
      }
      o.dmg[st.part] = clamp(o.dmg[st.part] + dmg, 0, 100);
      f.rs.landed++;
      f.rs.sig += dmg;
      if (blocked) {
        this._emit({ k: 'block', i: f.idx, j: o.idx, name: st.name, part: st.part });
        return;
      }
      // hit reaction
      const stun = 0.2 + dmg * 0.025;
      if (!onGround) {
        o.act = { type: 'hit', name: st.part, t: 0, dur: stun, hit: false };
        o.blocking = false;
        // pushback
        const d = dist || 0.001;
        const pb = Math.min(0.35, dmg * 0.04);
        o.x += dx / d * pb; o.z += dz / d * pb;
      } else {
        o.act = { type: 'hit', name: st.part, t: 0, dur: stun * 0.8, hit: false };
        S.ground.idleT = 0;
        S.ground.escape = clamp(S.ground.escape + 4, 0, 100);
      }
      const ev = this._emit({ k: 'hit', i: f.idx, j: o.idx, name: st.name, part: st.part, dmg: Math.round(dmg * 10) / 10, counter, big: dmg >= 3.6 });
      // rocked / knockdown
      if (st.part === 'head') {
        const thr = (4.6 + o.stats.chin * 4.6) * (1 - o.dmg.head / 170);
        if (o.rocked > 0 && dmg >= 2.8 && !onGround) {
          this._knockdown(f, o);
        } else if (dmg >= thr) {
          if (o.rocked > 0 && onGround) { /* already down, keep rocked */ }
          o.rocked = Math.max(o.rocked, 2.2 + dmg * 0.06);
          o.wobble = 1;
          ev.rocked = true;
          this._emit({ k: 'rocked', i: f.idx, j: o.idx });
          if (!onGround && dmg >= thr * 1.6) this._knockdown(f, o);
        }
      } else if (st.part === 'body' && dmg >= 3.6 && this.rand() < 0.35) {
        o.stam = Math.max(0, o.stam - 12);
        ev.winded = true;
      } else if (st.part === 'legs' && o.dmg.legs > 65 && dmg >= 3 && this.rand() < 0.4 && !onGround) {
        o.act = { type: 'stumble', name: 'legs', t: 0, dur: 0.9, hit: false };
        ev.buckled = true;
      }
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
      top.ground = 'top'; bottom.ground = 'bottom';
      top.blocking = false; bottom.blocking = false;
      top.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
      bottom.act = { type: 'hit', name: 'head', t: 0, dur: how === 'kd' ? 0.8 : 0.5, hit: false };
      S.ground = { top: top.idx, bottom: bottom.idx, escape: how === 'kd' ? 10 : 0, sub: null, ctrlT: 0, idleT: 0 };
    }

    _standUp(reason) {
      const S = this.state; if (!S.ground) return;
      const top = S.f[S.ground.top], bot = S.f[S.ground.bottom];
      top.ground = null; bot.ground = null;
      top.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
      bot.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
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
      const topBusy = top.act.type !== 'idle';
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
          top.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
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
        } else if (ti.pressed & STRIKE_BITS && !(ti.held & IN.BLOCK)) {
          let key = null;
          if (ti.pressed & IN.JAB) key = 'gnp1';
          else if (ti.pressed & IN.CROSS) key = 'gnp2';
          else if (ti.pressed & IN.HOOK) key = 'gnp3';
          else if (ti.pressed & (IN.BKICK | IN.LKICK | IN.HKICK)) key = 'gbody';
          if (key) { this._startStrike(top, key); G.idleT = 0; }
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
            bot.act = { type: 'idle', name: '', t: 0, dur: 0, hit: false };
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
        if (ev.rocked) return n(ev.i) + ' ROCKS ' + n(ev.j) + ' with a ' + ev.name + '!';
        if (ev.counter) return 'Counter ' + ev.name + ' by ' + n(ev.i) + '!';
        if (ev.buckled) return n(ev.j) + "'s leg buckles from that " + ev.name + '!';
        if (ev.winded) return 'That ' + ev.name + ' takes the wind out of ' + n(ev.j) + '.';
        if (ev.big) return n(ev.i) + ' lands a heavy ' + ev.name + '.';
        return n(ev.i) + ' lands a ' + ev.name + '.';
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

  const API = { IN, STRIKES, ROSTER, SUBS, Sim, describe, CAGE_R, DT };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.MMASim = API;
})(typeof window !== 'undefined' ? window : globalThis);
