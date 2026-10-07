/* CPU opponent for practice mode. Produces {held, pressed} input masks from sim state. */
(function (root) {
  'use strict';
  const { IN, STRIKES, MODS, LIMBS, LIMB_BIT, MOD_BIT, DEFAULT_MOVESET, recovering } = root.MMASim;

  class CpuBrain {
    constructor(idx, difficulty) {
      this.idx = idx;
      this.diff = difficulty == null ? 0.6 : difficulty; // 0..1
      this.timer = 0;
      this.held = 0;
      this.pressed = 0;
      this.lateral = 0;
      this.latT = 0;
      this.rng = Math.random;
      this.moveset = DEFAULT_MOVESET;
      this.modHeld = 0;      // modifier to keep held for the strike we just pressed
      this.modT = 0;
      this.rangeMode = 'kick'; // 'punch' = get in the pocket, 'kick' = fight at leg range
      this.rangeT = 0;
    }

    update(S, dt) {
      this.pressed = 0;
      const me = S.f[this.idx], op = S.f[1 - this.idx];
      if (S.phase !== 'fight') { this.held = 0; return { held: 0, pressed: 0 }; }
      this.timer -= dt;
      this.latT -= dt;
      const r = this.rng;
      const d = this.diff;

      if (S.ground) {
        this._ground(S, me, op, dt, me.ground === 'top' ? 'top' : 'bottom');
        if (this.modT > 0) { this.modT -= dt; this.held |= this.modHeld; }
        return { held: this.held, pressed: this.pressed };
      }

      const dist = Math.hypot(op.x - me.x, op.z - me.z);
      const st = me.stats;
      // alternate between kicking range and the pocket; wrestlers and grapplers like it close
      this.rangeT -= dt;
      if (this.rangeT <= 0) {
        const closeBias = st.wre > 0.75 ? 0.7 : st.bjj > 0.8 ? 0.6 : 0.45;
        this.rangeMode = r() < closeBias ? 'punch' : 'kick';
        this.rangeT = 1.2 + r() * 2.2;
      }
      const desired = this.rangeMode === 'punch' ? 0.92 + r() * 0.08 : 1.26 + r() * 0.08;
      let held = 0;

      // reactions (continuous)
      const oppWinding = op.act.type === 'strike' && !op.act.hit;
      const oppShooting = op.act.type === 'takedown' && !op.act.hit;
      const tired = me.stam < 22;

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
        this.held = held; return { held, pressed: 0 };
      }

      if (oppShooting && r() < 0.5 + d * 0.45) held |= IN.BLOCK; // sprawl
      else if (oppWinding && dist < 1.8) {
        const react = 0.25 + d * 0.6;
        if (r() < react) {
          if (r() < 0.25 + d * 0.2 && me.stam > 15) { this.pressed |= IN.DODGE; }
          else held |= IN.BLOCK;
        }
      }
      if (tired && r() < 0.7) held |= IN.BLOCK;

      // positioning
      if (this.latT <= 0) { this.lateral = r() < 0.4 ? 0 : (r() < 0.5 ? IN.LEFT : IN.RIGHT); this.latT = 0.6 + r() * 1.2; }
      if (dist > desired + 0.1) held |= IN.FWD;
      else if (dist < desired - 0.34 && !(st.wre > 0.75)) held |= IN.BACK;
      if (tired && dist < 1.6 && r() < 0.5) held |= IN.BACK;
      if (!(held & IN.BLOCK) || r() < 0.3) held |= this.lateral;

      // offence (discrete decisions)
      const free = me.act.type !== 'strike' || recovering(me);
      if (this.timer <= 0 && !(held & IN.BLOCK) && free) {
        // chain: right after a strike, a good fighter usually throws the next one straight away
        const chaining = me.act.type === 'strike' && me.combo < 3 && r() < 0.35 + d * 0.5;
        this.timer = chaining ? 0.02 : 0.12 + (1 - d) * 0.25 + r() * 0.2;
        const aggr = tired ? 0.15 : 0.45 + d * 0.4;
        if (dist <= 1.7 && r() < aggr) {
          // takedown?
          const tdWant = st.wre * 0.22 + (oppWinding ? 0.25 : 0) + (op.rocked > 0 ? 0.2 : 0) + (me.dmg.head > 55 ? 0.2 : 0);
          if (S.grappling !== false && dist <= 1.5 && me.stam > 20 && r() < tdWant * (0.4 + d * 0.6)) {
            this.pressed |= IN.GRAPPLE;
          } else {
            const pick = this._pickStrike(me, op, dist);
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

    // choose a strike by how well the opponent sits in its contact window, then find the
    // limb + modifier that throws it from this fighter's moveset
    _pickStrike(me, op, dist) {
      const r = this.rng, st = me.stats;
      if (me.stam < 3) return null; // swinging on empty only shrinks the tank
      const rocked = op.rocked > 0;
      const w = [];
      for (const mod of MODS) for (const limb of LIMBS) {
        const kind = this.moveset[mod][limb];
        const strike = STRIKES[limb + '_' + kind];
        if (!strike) continue;
        const sweet = strike.range - 0.12;           // contact distance for a full-extension hit
        const win = strike.part === 'head' && (kind === 'hook' || kind === 'uppercut') ? 0.2 : 0.32;
        const off = dist - sweet;
        if (off > -0.03 || off < -win) continue;     // out of reach (needs a little margin) or too close (it'd get smothered)
        const fit = 1 - Math.abs(off + 0.1) / win;
        let wt = 8 + fit * 24;
        const lead = limb === 'lh' || limb === 'll';
        if (lead) wt *= 1.25;                                  // quicker, safer
        if (strike.part === 'head') { wt += st.pow * 10 + (rocked ? 25 : 0); }
        if (kind === 'straight') wt += 10;
        if (kind === 'hkick') wt += (rocked ? 12 : 0) + (op.stam < 30 ? 5 : 0) - 6 + st.pow * 8;
        if (kind === 'lkick') wt += 6 + (op.dmg.legs > 40 ? 10 : 0);
        if (kind === 'bkick' || kind === 'teep') wt += (op.stam < 40 ? 6 : 0);
        if (kind === 'knee' || kind === 'uppercut') wt += 2;
        if (strike.stam > me.stam * 0.6) wt *= 0.3;
        w.push([{ limb: LIMB_BIT[limb], mod: MOD_BIT[mod] }, wt]);
      }
      if (!w.length) return null;
      let tot = 0; for (const x of w) tot += x[1];
      let k = r() * tot;
      for (const x of w) { k -= x[1]; if (k <= 0) return x[0]; }
      return w[0][0];
    }

    // ---------- ground ----------
    _ground(S, me, op, dt, role) {
      const r = this.rng, d = this.diff, G = S.ground;
      const { MOVES, SUBS_BY, BOTTOM_CAN_STRIKE } = root.MMASim;
      let held = 0;
      // --- submission in progress ---
      if (G.sub) {
        const sub = G.sub;
        if (sub.att === this.idx) {
          // squeeze while there's gas, let it breathe when running low (and bait the escape)
          const squeeze = me.stam > 18 && (sub.prog > 35 || r() < 0.85);
          if (squeeze) held |= IN.GRAPPLE;
        } else {
          // defend: hand-fight (block) most of the time, attempt an escape when the squeeze lets up or on a timer
          if (r() < 0.75 + d * 0.2) held |= IN.BLOCK;
          this.timer -= dt;
          if (this.timer <= 0 || (!sub.squeezing && r() < 0.3)) { this.pressed |= IN.GRAPPLE; this.timer = 1.6 + (1 - d) * 1.5 + r() * 1.0; }
        }
        this.held = held; return;
      }
      // --- someone is attempting a transition: deny it by basing / framing ---
      if (G.trans) {
        if (G.trans.by !== this.idx && me.stam > 20 && r() < 0.3 + d * 0.45) held |= IN.BLOCK;
        this.held = held; return;
      }
      const free = me.act.type === 'idle';
      if (!free) { this.held = held; return; }
      this.timer -= dt;
      if (this.timer > 0) { this.held = held; return; }
      this.timer = 0.3 + (1 - d) * 0.5 + r() * 0.4;
      const moves = MOVES[role][G.pos], subs = SUBS_BY[role][G.pos];
      const cdOk = G.cd[this.idx] <= 0;
      // candidate actions with weights
      const w = [];
      if (cdOk && me.stam > 20) {
        for (const dir in moves) {
          const mv = moves[dir];
          let wt = 0;
          if (role === 'top') wt = 1.2 + me.stats.wre * 1.5 + (G.pos === 'guard' ? 0.5 : 0);
          else {
            wt = 1.0 + me.stats.bjj * 1.2 + (G.pos === 'mount' || G.pos === 'back' ? 1.4 : 0) + (me.dmg.head > 50 ? 0.8 : 0);
            if (mv.stand) wt *= (me.stats.wre > 0.7 ? 1.3 : 0.7) * (op.stam < 40 ? 1.3 : 1);
            if (mv.flip) wt *= 0.8 + me.stats.bjj * 0.8;
          }
          if (op.act.type === 'strike') wt *= 1.6;     // they're swinging: go now
          if (op.posture || (this.inputsPostureHint)) wt *= 0.6;
          w.push([{ held: IN[dir], pressed: IN.GRAPPLE }, wt * (0.5 + d * 0.5)]);
        }
      }
      if (cdOk && subs.length && me.stam > 35) {
        // hunt for holds when they're worth it: strong BJJ, a dominant position, or an opponent who is exposed, rocked or gassed
        let wt = (me.stats.bjj - 0.35) * 3.0 + (op.stam < 30 ? 0.8 : 0) + (op.rocked > 0 ? 1.2 : 0) + (G.pos === 'back' || G.pos === 'mount' ? 1.2 : 0) + (op.act.type === 'hit' ? 1.5 : 0);
        if (wt > 0) w.push([{ held: 0, pressed: IN.GRAPPLE }, wt * (0.4 + d * 0.6)]);
      }
      if (me.stam > 10 && (role === 'top' || BOTTOM_CAN_STRIKE[G.pos])) {
        const base = role === 'top' ? 2.2 + (G.pos === 'mount' ? 1.5 : 0) + me.stats.pow : 0.7;
        const k = r();
        const strike = k < 0.5 ? { held: 0, pressed: r() < 0.5 ? IN.LHAND : IN.RHAND } : k < 0.7 ? { held: IN.MOD1, pressed: IN.RHAND } : k < 0.85 ? { held: IN.MOD2, pressed: r() < 0.5 ? IN.LHAND : IN.RHAND } : { held: 0, pressed: r() < 0.5 ? IN.LLEG : IN.RLEG };
        w.push([strike, base]);
      }
      // posture / rest
      w.push([{ held: IN.BLOCK, pressed: 0 }, (role === 'top' ? 0.8 : 1.2) + (me.stam < 30 ? 1.5 : 0) + (role === 'bottom' && op.act.type === 'strike' ? 2.5 : 0) + (role === 'bottom' && me.dmg.head > 60 ? 2 : 0)]);
      let tot = 0; for (const x of w) tot += x[1];
      let k = r() * tot, pick = w[w.length - 1][0];
      for (const x of w) { k -= x[1]; if (k <= 0) { pick = x[0]; break; } }
      held |= pick.held; this.pressed |= pick.pressed;
      this.modHeld = pick.held & (IN.MOD1 | IN.MOD2 | IN.MOD3); this.modT = 0.12;
      this.held = held;
    }
  }

  root.MMAAI = { CpuBrain };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MMAAI;
})(typeof window !== 'undefined' ? window : globalThis);
