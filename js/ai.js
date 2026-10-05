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
        if (me.ground === 'top') this._top(S, me, op, dt);
        else this._bottom(S, me, op, dt);
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
          if (dist <= 1.5 && me.stam > 20 && r() < tdWant * (0.4 + d * 0.6)) {
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

    _top(S, me, op, dt) {
      const r = this.rng, d = this.diff, G = S.ground;
      let held = 0;
      if (G.sub) { this.held = 0; this._playSeq(G.sub.att, dt); return; }
      if (G.escape > 55 && r() < 0.6) held |= IN.BLOCK; // posture up, kill the escape
      if (this.timer <= 0 && (me.act.type === 'idle' || recovering(me))) {
        this.timer = 0.25 + (1 - d) * 0.4 + r() * 0.3;
        const subWant = me.stats.bjj * 0.35 + (op.stam < 35 ? 0.2 : 0) + (op.rocked > 0 ? 0.3 : 0) - (me.stam < 30 ? 0.3 : 0);
        if ((me.stats.bjj > 0.45 || op.rocked > 0 || op.stam < 25) && r() < subWant * 0.18 && me.stam > 35) { this.pressed |= IN.GRAPPLE; held &= ~IN.BLOCK; }
        else if (r() < 0.75 && me.stam > 10) {
          held &= ~IN.BLOCK;
          const k = r();
          if (k < 0.5) this.pressed |= (r() < 0.5 ? IN.LHAND : IN.RHAND);                       // punches
          else if (k < 0.7) { this.pressed |= IN.RHAND; held |= IN.MOD1; }                        // elbow
          else if (k < 0.85) { this.pressed |= (r() < 0.5 ? IN.LHAND : IN.RHAND); held |= IN.MOD2; } // hammer fist
          else this.pressed |= (r() < 0.5 ? IN.LLEG : IN.RLEG);                                   // knee to the body
        }
      }
      this.held = held;
    }

    // play the arrow-sequence duel: press rate and accuracy scale with difficulty
    _playSeq(sq, dt) {
      const r = this.rng, d = this.diff;
      const rate = (2.2 + d * 3.3) * dt;
      if (r() < rate) {
        const acc = 0.95 + d * 0.045;
        const want = sq.keys[sq.idx];
        if (r() < acc) this.pressed |= want;
        else { const DIRS = [IN.FWD, IN.LEFT, IN.BACK, IN.RIGHT].filter(k => k !== want); this.pressed |= DIRS[Math.floor(r() * 3)]; }
      }
    }

    _bottom(S, me, op, dt) {
      const r = this.rng, d = this.diff, G = S.ground;
      let held = 0;
      const mashRate = (4 + d * 5) * dt; // presses per second
      if (G.sub) { this.held = 0; this._playSeq(G.sub.def, dt); return; }
      const topStriking = op.act.type === 'strike' && !op.act.hit;
      if (topStriking && r() < 0.4 + d * 0.5) held |= IN.BLOCK;
      if (r() < mashRate && me.stam > 5) this.pressed |= [IN.FWD, IN.BACK, IN.LEFT, IN.RIGHT][Math.floor(r() * 4)];
      if (this.timer <= 0 && me.act.type === 'idle') {
        this.timer = 0.3 + r() * 0.5;
        const sweepWant = me.stats.bjj * 0.15 + (topStriking ? 0.25 : 0.02);
        if (r() < sweepWant * (0.4 + d * 0.6) && me.stam > 12) this.pressed |= IN.GRAPPLE;
      }
      this.held = held;
    }
  }

  root.MMAAI = { CpuBrain };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MMAAI;
})(typeof window !== 'undefined' ? window : globalThis);
