/* CPU opponent for practice / career mode. Produces {held, pressed} input masks from sim state.
   difficulty 0..1 picks a profile (profileFor): how much he sees, how fast he answers, how well he manages his gas
   tank, how precisely he judges range, how he reads the mat, and which bad habits he keeps. */
(function (root) {
  'use strict';
  const { IN, STRIKES, MODS, LIMBS, LIMB_BIT, MOD_BIT, DEFAULT_MOVESET, recovering, isSouthpaw } = root.MMASim;
  const OTHER_SIDE = { lh: 'rh', rh: 'lh', ll: 'rl', rl: 'll' };
  const isKick = st => !!st && (st.limb === 'll' || st.limb === 'rl');
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  // named levels for the lobby; career opponents sit anywhere on the band
  const LEVELS = [
    { key: 'novice', name: 'Novice', diff: 0.12 },
    { key: 'rookie', name: 'Rookie', diff: 0.3 },
    { key: 'contender', name: 'Contender', diff: 0.55 },
    { key: 'champion', name: 'Champion', diff: 0.8 },
    { key: 'legend', name: 'Legend', diff: 1.0 }
  ];

  // Everything difficulty touches, in one place. u = how much of a novice he is.
  function profileFor(d) {
    d = clamp(d == null ? 0.6 : d, 0, 1);
    const u = 1 - d;
    return {
      see: 0.22 + d * 0.7,          // chance of seeing a strike coming at all (slow strikes are easier, see _react)
      delay: 0.03 + u * 0.24,       // reaction time (s) before the answer goes up
      slip: 0.08 + d * 0.5,         // of the hand strikes he sees, the share he slips rather than blocks
      check: 0.05 + d * 0.8,        // chance of checking a low kick he sees
      evade: d * 0.45,              // chance of dashing out of a big kick he sees
      shell: 0.1 + d * 0.5,         // chance of keeping the guard up through the opponent's recovery (combos)
      sprawl: 0.4 + d * 0.55,       // chance of sprawling on a shot he sees
      restLow: 14 + d * 26,         // % of his current max stamina under which he stops working and lets the rest ramp run...
      restHigh: 38 + d * 32,        // ...until it is back up over this % (both scale with stamMax, which damage erodes)
      reserve: 2 + d * 16,          // a strike that would leave him under this is off the table (unless he has him hurt)
      rangeErr: 0.02 + u * 0.15,    // how far off his read of the distance drifts (m)
      spam: 0.08 + u * 0.6,         // willingness to throw into the repeat penalty (3rd of the same strike in a row)
      counter: 0.15 + d * 0.8,      // chance to punish a whiff / stun / slip the moment it shows
      decide: 0.08 + u * 0.3,       // seconds between offensive decisions
      chain: 0.2 + d * 0.65,        // chance to follow a strike with the next one
      aggr: 0.4 + d * 0.45,         // base chance of attacking when a decision comes up in range
      dash: d < 0.25 ? 0 : 0.1 + d * 0.5, // dash use: closing on a punch range, getting out to rest
      swarm: 0.3 + d * 0.65,        // pressure on a hurt opponent
      tdSense: 0.2 + d * 0.75,      // picks the moment for a takedown; doesn't shoot into a set sprawl
      guardHold: u * 0.55,          // bad habit: parking the guard up when nothing is coming (kills the rest ramp)
      tiredBlock: u * 0.7,          // bad habit: covering up when gassed instead of resting
      mat: 0.22 + d * 0.42          // ground: base chance of reading a move's direction
    };
  }

  class CpuBrain {
    constructor(idx, difficulty, rng) {
      this.idx = idx;
      this.diff = clamp(difficulty == null ? 0.6 : difficulty, 0, 1); // 0..1
      this.P = profileFor(this.diff);
      this.timer = 0;
      this.held = 0;
      this.pressed = 0;
      this.lateral = 0;
      this.latT = 0;
      this.rng = rng || Math.random; // pass a seeded rng (MMASim.mulberry32) for reproducible runs
      this.moveset = DEFAULT_MOVESET;
      this.modHeld = 0;      // modifier to keep held for the strike we just pressed
      this.modT = 0;
      this.rangeMode = 'kick'; // 'punch' = get in the pocket, 'kick' = fight at leg range
      this.rangeT = 0;
      this.pushT = 0;          // > 0: second BLOCK tap of a push is pending
      this.lastTap = -9;       // sim time of our last BLOCK press (two inside 0.3 s = push; a slip must not become one)
      this.err = 0; this.errT = 0;   // current misjudgement of the range
      this.resting = false;    // off the gas: stay out of reach, no guard, no strikes, let the rest ramp build
      this.restBlock = false;  // the bad version of resting: covering up (rookies)
      this.seen = null; this.plan = null; this.planT = 0; this.planAt = 0; this.planDone = false; // the incoming strike being answered
      this.shellT = 0;         // keep the guard up this much longer after a strike has passed
      this.openSeen = null;    // the opening (stun / whiff) already reacted to
      this.shotSeen = null; this.shotPlan = false; this.shotT = 0;
      this.habitT = 0; this.habitHold = 0;
      this.rockDash = false;
      this.readKey = null; this.readDir = null; this.readT = 0; this.readAt = 0; // the ground read being answered (see _ground)
      this.holdPlan = 0;       // ground: input to keep holding between decisions (cover, or a pre-read)
    }

    update(S, dt) {
      this.pressed = 0;
      const me = S.f[this.idx], op = S.f[1 - this.idx];
      if (S.phase !== 'fight') { this.held = 0; this.resting = false; return { held: 0, pressed: 0 }; }
      this.timer -= dt;
      this.latT -= dt;
      const r = this.rng;
      const d = this.diff, P = this.P;

      // gas tank: under restLow he stops working until the rest ramp has taken him back over restHigh
      // (a hurt opponent is worth burning the last of it on)
      const hurtOpp = op.rocked > 0 || op.act.type === 'kd';
      const tank = (me.stamMax || 100) / 100;
      const restLow = P.restLow * tank, restHigh = P.restHigh * tank;
      this.restLow = restLow; this.restHigh = restHigh;
      if (!this.resting && me.stam < restLow && !hurtOpp) { this.resting = true; this.restBlock = r() < P.tiredBlock; }
      else if (this.resting && (me.stam >= restHigh || (hurtOpp && me.stam > 15))) this.resting = false;

      if (S.ground) {
        this._ground(S, me, op, dt, me.ground === 'top' ? 'top' : 'bottom');
        if (this.modT > 0) { this.modT -= dt; this.held |= this.modHeld; }
        return { held: this.held, pressed: this.pressed };
      }

      const dist = Math.hypot(op.x - me.x, op.z - me.z);
      const st = me.stats;
      // perceived range: a misjudgement that drifts every second or so
      this.errT -= dt;
      if (this.errT <= 0) { this.err = (r() * 2 - 1) * P.rangeErr; this.errT = 0.8 + r() * 1.5; }
      const pd = dist + this.err;
      // alternate between kicking range and the pocket; wrestlers and grapplers like it close
      this.rangeT -= dt;
      if (this.rangeT <= 0) {
        const closeBias = st.wre > 0.75 ? 0.7 : st.bjj > 0.8 ? 0.6 : 0.45;
        this.rangeMode = r() < closeBias ? 'punch' : 'kick';
        this.rangeT = 1.2 + r() * 2.2;
      }
      const restDist = 1.85 + r() * 0.1; // out of everyone's reach
      const desired = this.resting ? restDist : this.rangeMode === 'punch' ? 0.92 + r() * 0.08 : 1.26 + r() * 0.08;
      let held = 0;

      const oppShooting = op.act.type === 'takedown' && !op.act.hit;
      const tired = this.resting || me.stam < restLow;

      // knocked down myself: stay down a moment to clear the head (longer the worse it is), then get up
      if (me.act.type === 'kd') {
        if (me.act.name === 'fall') {
          const hurt = Math.min(1, me.dmg.head / 80);
          this.kdRest = 0.3 + r() * 0.8 + hurt * 1.6 + (st.chin < 0.6 ? 0.4 : 0);
          // a wrestler closing in is a reason to get up at once
          if (S.grappling !== false && op.stats.wre > 0.75 && r() < 0.5 + d * 0.3) this.kdRest = Math.min(this.kdRest, 0.3);
        } else if (me.act.name === 'down' && me.act.t >= (this.kdRest || 0)) this.pressed |= IN.FWD;
        this.held = 0; return { held: 0, pressed: this.pressed };
      }
      // opponent knocked down: decide once whether to dive on him (wrestlers and grapplers do, strikers let him up)
      if (op.act.type === 'kd') {
        if (!this.kdPlan) {
          const dive = S.grappling !== false && r() < (0.15 + st.wre * 0.5 + st.bjj * 0.3) * (0.4 + d * 0.6);
          this.kdPlan = { dive, t: 0 };
        }
        this.kdPlan.t += dt;
        if (this.kdPlan.dive) {
          if (dist <= 2.0) { if (this.kdPlan.t > 0.35 && r() < 0.5) this.pressed |= IN.GRAPPLE; }
          else held |= IN.FWD;
        } else if (dist < 1.6) held |= IN.BACK;
        this.held = held; return { held, pressed: this.pressed };
      }
      this.kdPlan = null;
      if (me.rocked > 0) {
        held |= IN.BLOCK; if (r() < 0.6) held |= IN.BACK;
        if (r() < 0.02) held |= (r() < 0.5 ? IN.LEFT : IN.RIGHT);
        // a good fighter gets out of there at once
        if (P.dash > 0 && !this.rockDash && S.t >= me.lungeReady && me.stam > 6 && r() < P.dash) { this.pressed |= IN.DODGE; held |= IN.BACK; }
        this.rockDash = true;
        this.held = held; return { held, pressed: this.pressed };
      }
      this.rockDash = false;

      // ---- defence: one decision per incoming strike / shot, answered after a reaction delay ----
      held |= this._react(S, me, op, dist, dt);
      if (oppShooting) {
        if (this.shotSeen !== op.act) { this.shotSeen = op.act; this.shotPlan = r() < P.sprawl; this.shotT = 0; }
        this.shotT += dt;
        if (this.shotPlan && this.shotT >= P.delay * 0.7) held |= IN.BLOCK; // sprawl
      }
      // bad habits: parking the guard, or covering up when gassed (both stall the rest ramp)
      this.habitT -= dt;
      if (this.habitT <= 0) { this.habitHold = r() < P.guardHold ? 0.4 + r() * 1.2 : 0; this.habitT = 1.2 + r() * 2.5; }
      if (this.habitHold > 0) { this.habitHold -= dt; if (!this.resting) held |= IN.BLOCK; }
      if (this.resting && this.restBlock && dist < 1.8) held |= IN.BLOCK;
      // which guard: drop it (BLOCK + MOD3) when a body shot is coming or the body is what's being broken down
      if (held & IN.BLOCK) {
        const oppSt = op.act.type === 'strike' && !op.act.hit ? STRIKES[op.act.name] : null;
        const bodyShot = !!oppSt && oppSt.part === 'body';
        const bodyHurt = me.dmg.body > me.dmg.head + 15 && me.dmg.body > 30;
        if ((bodyShot && r() < 0.35 + d * 0.5) || (bodyHurt && !oppSt && r() < 0.5)) { this.modHeld = IN.MOD3; this.modT = 0.2; }
      }

      // ---- positioning ----
      if (this.latT <= 0) { this.lateral = r() < (this.resting ? 0.7 : 0.4) ? 0 : (r() < 0.5 ? IN.LEFT : IN.RIGHT); this.latT = 0.6 + r() * 1.2; }
      const incoming = this.seen != null;
      if (this.resting) {
        // out of reach and still: moving costs a little regen, so only step when he is getting close
        if (pd < desired - 0.1) held |= IN.BACK;
        if (pd < 1.35 && P.dash > 0 && S.t >= me.lungeReady && me.stam > 8 && !incoming && r() < P.dash * 2.5 * dt) { this.pressed |= IN.DODGE; held |= IN.BACK; }
      } else {
        if (pd > desired + 0.1) held |= IN.FWD;
        else if (pd < desired - 0.34 && !(st.wre > 0.75)) held |= IN.BACK;
        // dash in: close a punch range in one burst, or get on a hurt man before he recovers
        const wantIn = (this.rangeMode === 'punch' && pd > desired + 0.55) || (op.rocked > 0 && pd > 1.5);
        if (wantIn && P.dash > 0 && !incoming && S.t >= me.lungeReady && me.stam > P.reserve + 10 && r() < P.dash * (op.rocked > 0 ? 4 : 1.5) * dt) { this.pressed |= IN.DODGE; held |= IN.FWD; }
      }
      // smothered: shove him off (double tap BLOCK) — strikers do it to make room, anyone does it when tired
      if (this.pushT > 0) { this.pushT -= dt; if (this.pushT <= 0) { this.pressed |= IN.BLOCK; this.lastTap = S.t; } }
      else if (dist < 0.98 && me.act.type !== 'strike' && me.act.type !== 'push' && !oppShooting && me.stam > 12 && !incoming) {
        const want = (st.wre > 0.75 ? 0.15 : 0.5) + (tired ? 0.6 : 0) + (this.rangeMode === 'kick' ? 0.4 : 0);
        if (r() < want * (0.4 + d * 0.6) * dt) { this.pressed |= IN.BLOCK; this.lastTap = S.t; this.pushT = 0.08; }
      }
      if (!(held & IN.BLOCK) || r() < 0.3) held |= this.lateral;

      // ---- offence (discrete decisions) ----
      // an opening: he is stunned, stumbling, over-committed on a slipped strike, or has just whiffed
      const opening = op.act.type === 'hit' || op.act.type === 'stumble' || (op.act.type === 'strike' && (op.act.slipped || (op.act.hit && recovering(op))));
      if (opening) { if (this.openSeen !== op.act) { this.openSeen = op.act; if (r() < P.counter) this.timer = Math.min(this.timer, P.delay * 0.6); } }
      else this.openSeen = null;
      const free = me.act.type === 'idle' || me.act.type === 'move' || recovering(me);
      if (this.timer <= 0 && !(held & IN.BLOCK) && free && !this.resting) {
        // chain: right after a strike, a good fighter usually throws the next one straight away (if the tank allows)
        const chaining = me.act.type === 'strike' && me.combo < 3 && me.stam > restLow + 12 && r() < P.chain;
        this.timer = chaining ? 0.02 : P.decide * (0.6 + r() * 0.8);
        let aggr = P.aggr;
        if (opening) aggr = Math.max(aggr, P.counter);
        if (op.rocked > 0) aggr = Math.max(aggr, P.swarm);
        if (me.stam < restLow + 10 && !hurtOpp) aggr *= 0.5;
        if (pd <= 1.7 && r() < aggr) {
          // takedown? best when he is mid-strike, hurt or gassed; never into a set sprawl if we can see it
          const opStriking = op.act.type === 'strike' && !op.act.hit;
          let tdWant = st.wre * 0.25 + (opStriking ? 0.25 : 0) + (op.rocked > 0 ? 0.2 : 0) + (op.stam < 35 ? 0.15 : 0) + (me.dmg.head > 55 ? 0.2 : 0);
          if (op.blocking && r() < P.tdSense) tdWant = 0;
          if (S.grappling !== false && pd <= 1.5 && me.stam > 14 + P.reserve * 0.5 && !(me.tdCd > 0) && r() < tdWant * (0.35 + d * 0.65)) {
            this.pressed |= IN.GRAPPLE;
          } else {
            const pick = this._pickStrike(S, me, op, pd);
            if (pick) { this.pressed |= pick.limb; this.modHeld = pick.mod; this.modT = 0.12; }
          }
        }
      }
      // keep the chosen modifier held for a few frames so the sim reads limb + modifier together
      this.modT -= dt;
      if (this.modT > 0) held |= this.modHeld;
      this.held = held;
      return { held, pressed: this.pressed };
    }

    // The answer to an incoming strike, decided once when it starts: check a low kick, dash out of a big kick, slip a
    // hand strike, block, or miss it altogether. Applied after a reaction delay; the guard comes back down as soon as
    // the strike has passed (unless he shells up through the recovery), so the rest ramp isn't stalled for nothing.
    _react(S, me, op, dist, dt) {
      const r = this.rng, P = this.P, d = this.diff;
      let held = 0;
      const a = op.act;
      const live = a.type === 'strike' && !a.hit && !a.slipped && a.t < (a.cancelAt != null ? a.cancelAt : a.dur);
      if (live && dist < 2.2) {
        if (this.seen !== a) {
          this.seen = a;
          const oSt = STRIKES[a.name];
          const kick = isKick(oSt);
          const slow = kick || (oSt && (oSt.kind === 'overhand' || oSt.kind === 'hook')) ? 0.12 : 0;
          let plan = null;
          if (r() < P.see + slow) {
            if (kick && oSt.part === 'legs' && r() < P.check) plan = 'check';
            else if (kick && oSt.part !== 'legs' && r() < P.evade && me.stam > 10 && S.t >= me.lungeReady) plan = 'evade';
            else if (!kick && r() < P.slip && me.stam > 12 + P.reserve * 0.5 && S.t - this.lastTap > 0.35 && (me.act.type !== 'strike' || recovering(me))) plan = 'slip';
            else plan = 'block';
          }
          this.plan = plan; this.planAt = P.delay * (0.6 + r() * 0.8); this.planT = 0; this.planDone = false;
          this.shellT = plan === 'block' && r() < P.shell ? 0.2 + d * 0.15 : 0;
        }
        this.planT += dt;
        if (this.plan && this.planT >= this.planAt) {
          if (this.plan === 'check') held |= IN.CHECK;
          else if (this.plan === 'evade') { if (!this.planDone) { this.pressed |= IN.DODGE; this.planDone = true; } held |= IN.BACK; }
          else if (this.plan === 'slip') { if (!this.planDone) { this.pressed |= IN.BLOCK; this.lastTap = S.t; this.planDone = true; } held |= IN.BLOCK; }
          else held |= IN.BLOCK;
        }
        return held;
      }
      // the strike has passed: shell up through his recovery if that was the plan, else drop the hands
      if (this.seen) {
        if (this.shellT > 0 && op.act.type === 'strike') { this.shellT -= dt; held |= IN.BLOCK; return held; }
        this.seen = null; this.plan = null; this.shellT = 0;
      }
      return held;
    }

    // choose a strike by how well the opponent sits in its contact window and what it costs, then find the
    // limb + modifier that throws it from this fighter's moveset
    _pickStrike(S, me, op, dist) {
      const r = this.rng, st = me.stats, P = this.P, d = this.diff;
      if (me.stam < 3) return null; // swinging on empty only shrinks the tank
      const rocked = op.rocked > 0;
      const hurt = rocked || op.act.type === 'hit' || op.act.type === 'stumble';
      const chained = recovering(me);
      const lowMul = me.stam < 25 ? 0.6 : 1;      // the sim discounts strikes thrown on a low tank
      const kickOk = !(me.kickReady > S.t) && !(me.act.type === 'strike' && isKick(STRIKES[me.act.name]));
      const last = me.lastStrike ? me.lastStrike.split('_') : null; // [side, kind] as the sim stores it
      const opKicking = op.act.type === 'strike' && !op.act.hit && isKick(STRIKES[op.act.name]);
      const sp = isSouthpaw(me);
      const w = [];
      for (const mod of MODS) for (const limb of LIMBS) {
        const kind = this.moveset[mod][limb];
        const side = sp ? OTHER_SIDE[limb] : limb;
        const strike = STRIKES[side + '_' + kind] || STRIKES[side + '_' + DEFAULT_MOVESET[mod][limb]];
        if (!strike) continue;
        if (isKick(strike) && !kickOk) continue;        // the foot isn't back on the mat yet
        const cost = strike.stam * lowMul * (chained ? 1.1 : 1);
        if (cost > me.stam) continue;                   // overdrawing the tank erodes it
        if (me.stam - cost < P.reserve && !hurt) continue;
        const sweet = strike.range - 0.12;           // contact distance for a full-extension hit
        const win = strike.part === 'head' && (kind === 'hook' || kind === 'uppercut') ? 0.2 : 0.32;
        const off = dist - sweet;
        if (off > -0.03 || off < -win) continue;     // out of reach (needs a little margin) or too close (it'd get smothered)
        const fit = 1 - Math.abs(off + 0.1) / win;
        let wt = 8 + fit * 24;
        const lead = limb === 'lh' || limb === 'll';
        if (lead) wt *= 1.25;                                  // quicker, safer
        if (strike.part === 'head') { wt += st.pow * 10 + (rocked ? 25 : 0) + (hurt ? 10 : 0); }
        if (kind === 'straight') wt += 10;
        if (kind === 'hkick') wt += (rocked ? 12 : 0) + (op.stam < 30 ? 5 : 0) - 6 + st.pow * 8;
        if (kind === 'lkick') wt += 6 + (op.dmg.legs > 40 ? 10 : 0) - (op.checking ? 12 : 0);
        if (kind === 'bkick' || kind === 'teep') wt += (op.stam < 40 ? 6 : 0);
        if (kind === 'knee' || kind === 'uppercut') wt += 2;
        if (opKicking && !isKick(strike) && kind !== 'uppercut') wt += 6 + d * 14; // a hand on a man on one leg cancels his kick
        // the tank: cheaper strikes as it drains
        wt *= clamp(1.2 - cost / Math.max(8, me.stam * 0.5), 0.15, 1);
        // the repeat penalty: a 3rd throw of the same strike in a row lands at half power, the 4th at a quarter
        if (last && last[0] === side && last[1] === kind) {
          if (me.repeatN >= 2) wt *= P.spam * (me.repeatN >= 3 ? 0.4 : 1);
          else if (!hurt) wt *= 0.8;
        }
        w.push([{ limb: LIMB_BIT[limb], mod: MOD_BIT[mod] }, wt]);
      }
      if (!w.length) return this._wildSwing(me, dist, lowMul);
      let tot = 0; for (const x of w) tot += x[1];
      let k = r() * tot;
      for (const x of w) { k -= x[1]; if (k <= 0) return x[0]; }
      return w[0][0];
    }

    // nothing fits the range: a novice throws anyway now and then, a hand strike that comes up short (the whiff
    // costs him extra); a seasoned fighter waits for the distance
    _wildSwing(me, dist, lowMul) {
      const r = this.rng, P = this.P;
      if (r() > (1 - this.diff) * 0.5 || dist > 1.75) return null;
      const limb = r() < 0.6 ? 'lh' : 'rh';
      const kind = this.moveset.none[limb];
      const strike = STRIKES[(isSouthpaw(me) ? OTHER_SIDE[limb] : limb) + '_' + kind];
      if (!strike || strike.stam * lowMul > me.stam - P.reserve) return null;
      return { limb: LIMB_BIT[limb], mod: 0 };
    }

    // ---------- ground ----------
    // Everything on the mat is a read: the opponent's move (or crank) shows its direction for a short window and
    // we answer with GRAPPLE + that direction. The brain decides once per read (right / wrong / freeze, by difficulty
    // and grappling stats) and answers after a human-ish reaction delay.
    _ground(S, me, op, dt, role) {
      const r = this.rng, d = this.diff, G = S.ground, P = this.P;
      const { MOVES, SUBS_BY, BOTTOM_CAN_STRIKE } = root.MMASim;
      const DIRS = ['FWD', 'BACK', 'LEFT', 'RIGHT'];
      let held = 0;
      const skill = role === 'top' ? me.stats.wre * 0.6 + me.stats.bjj * 0.4 : me.stats.bjj * 0.6 + me.stats.wre * 0.4;

      // --- a read is up: the opponent's move, or a crank on the hold I'm caught in ---
      const read = G.sub ? (G.sub.crank && G.sub.att !== this.idx ? G.sub.crank : null) : (G.trans && G.trans.by !== this.idx ? G.trans : null);
      if (read) {
        const key = (G.sub ? 'c' : 't') + read.id;
        if (this.readKey !== key) {
          this.readKey = key;
          const big = read.mv && read.mv.winMul > 1 ? 0.12 : 0;                  // big moves are easier to see coming
          const pRead = P.mat + skill * 0.2 + big + (G.sub ? 0.08 : 0);
          const k = r();
          this.readDir = k < pRead ? read.dir : k < pRead + 0.25 ? DIRS[Math.floor(r() * 4)] : null; // right / wrong guess / freeze
          this.readAt = 0.07 + (1 - d) * 0.18 + r() * 0.1;
          this.readT = 0;
        }
        this.readT += dt;
        if (this.readDir && this.readT >= this.readAt && me.stam > 4) held |= IN.GRAPPLE | IN[this.readDir];
        else if (G.sub ? r() < 0.8 : r() < 0.5 && !this.resting) held |= IN.BLOCK; // meanwhile: hand-fight / cover (it costs gas)
        this.held = held; return;
      }

      // --- submission in progress ---
      if (G.sub) {
        const sub = G.sub;
        if (sub.att === this.idx) {
          // squeeze while there's gas; crank now and then (more often when they are hurt or gassed)
          if (me.stam > 12 && (sub.prog > 30 || r() < 0.85)) held |= IN.GRAPPLE;
          this.timer -= dt;
          if (this.timer <= 0) {
            this.timer = 0.35 + (1 - d) * 0.7 + r() * 0.6;
            const want = 0.35 + d * 0.4 + (op.rocked > 0 ? 0.3 : 0) + (op.stam < 30 ? 0.2 : 0);
            if (sub.crankCd <= 0 && me.stam > 10 && r() < want) this.pressed |= IN[DIRS[Math.floor(r() * 4)]];
          }
        } else if (r() < 0.75 + d * 0.2) held |= IN.BLOCK;                        // fight the hands
        this.held = held; return;
      }
      // my own move is playing out
      if (G.trans) { this.held = held; return; }
      if (me.act.type !== 'idle') { this.held = held; return; }
      this.timer -= dt;
      if (this.timer > 0) { this.held = this.holdPlan || held; return; }
      this.timer = 0.3 + (1 - d) * 0.5 + r() * 0.45;
      this.holdPlan = 0;
      const moves = MOVES[role][G.pos], subs = SUBS_BY[role][G.pos];
      const cdOk = G.cd[this.idx] <= 0;
      const opExposed = op.act.type === 'hit' || op.act.type === 'strike';      // caught: a move now can't be denied
      // candidate actions with weights
      const w = [];
      const pinned = role === 'bottom' && (G.pos === 'mount' || G.pos === 'back' || op.act.type === 'strike'); // no resting under fire
      if (cdOk && me.stam > 12 + P.reserve * 0.6 && (!this.resting || pinned)) {
        for (const dir in moves) {
          const mv = moves[dir];
          let wt = 0;
          if (role === 'top') wt = 1.1 + me.stats.wre * 1.4 + (G.pos === 'guard' ? 0.4 : 0);
          else {
            wt = 1.0 + me.stats.bjj * 1.2 + (G.pos === 'mount' || G.pos === 'back' ? 1.4 : 0) + (me.dmg.head > 50 ? 0.8 : 0);
            if (mv.stand) wt *= (me.stats.wre > 0.7 ? 1.3 : 0.7) * (op.stam < 40 ? 1.3 : 1);
            if (mv.flip) wt *= 0.5 + me.stats.bjj * 0.7;
          }
          if (mv.read) wt *= opExposed || G.mom[this.idx] > 0 ? 1.2 : 0.55;   // risky moves: when they can't answer
          if (opExposed) wt *= 1.8;
          if (op.cover) wt *= 1.2;                                            // covering up: not reading
          w.push([{ held: IN[dir], pressed: IN.GRAPPLE }, wt * 0.7 * (0.5 + d * 0.5)]);
        }
      }
      if (cdOk && subs.length && me.stam > 22 + P.reserve && !this.resting) {
        // hunt for holds when they're worth it: strong BJJ, a dominant position, or an opponent who is exposed, rocked or gassed
        let wt = (me.stats.bjj - 0.35) * 3.0 + (op.stam < 30 ? 0.8 : 0) + (op.rocked > 0 ? 1.2 : 0) + (G.pos === 'back' || G.pos === 'mount' ? 1.2 : 0) + (opExposed ? 1.5 : 0);
        if (wt > 0) w.push([{ held: 0, pressed: IN.GRAPPLE }, wt * (0.4 + d * 0.6)]);
      }
      if (me.stam > 8 + P.reserve * 0.5 && !this.resting && (role === 'top' || BOTTOM_CAN_STRIKE[G.pos])) {
        const base = role === 'top' ? 2.8 + (G.pos === 'mount' ? 1.8 : 0) + me.stats.pow * 1.5 + (op.cover ? -0.8 : 0) : 0.7;
        const k = r();
        const strike = k < 0.5 ? { held: 0, pressed: r() < 0.5 ? IN.LHAND : IN.RHAND } : k < 0.7 ? { held: IN.MOD1, pressed: IN.RHAND } : k < 0.85 ? { held: IN.MOD2, pressed: r() < 0.5 ? IN.LHAND : IN.RHAND } : { held: 0, pressed: r() < 0.5 ? IN.LLEG : IN.RLEG };
        w.push([strike, Math.max(0.2, base)]);
      }
      // cover / posture: BLOCK on the mat is basing and framing, and it costs gas; a rookie covers up when tired
      w.push([{ held: IN.BLOCK, pressed: 0, plan: true }, (role === 'top' ? 0.6 : 1.0) + (me.stam < 30 ? 1.5 * P.tiredBlock : 0) + (role === 'bottom' && op.act.type === 'strike' ? 2.5 : 0) + (role === 'bottom' && me.dmg.head > 60 ? 2 : 0)]);
      // rest: do nothing and let the ramp run (the only way to get it back down here)
      w.push([{ held: 0, pressed: 0, plan: true }, (this.resting ? 4 : me.stam < this.restHigh ? 0.9 : 0.25) * (role === 'top' ? 1 : pinned ? 0.25 : 0.7)]);
      let tot = 0; for (const x of w) tot += x[1];
      let k = r() * tot, pick = w[w.length - 1][0];
      for (const x of w) { k -= x[1]; if (k <= 0) { pick = x[0]; break; } }
      held |= pick.held; this.pressed |= pick.pressed;
      if (pick.plan) this.holdPlan = pick.held;                                // keep holding it until the next decision
      this.modHeld = pick.held & (IN.MOD1 | IN.MOD2 | IN.MOD3); this.modT = 0.12;
      this.held = held;
    }
  }

  root.MMAAI = { CpuBrain, LEVELS, profileFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MMAAI;
})(typeof window !== 'undefined' ? window : globalThis);
