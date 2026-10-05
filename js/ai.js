/* CPU opponent for practice mode. Produces {held, pressed} input masks from sim state. */
(function (root) {
  'use strict';
  const IN = root.MMASim.IN;

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
      const desired = st.wre > 0.75 ? 1.05 : st.bjj > 0.8 ? 1.15 : 1.3;
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
      if (dist > desired + 0.25) held |= IN.FWD;
      else if (dist < desired - 0.35 && !(st.wre > 0.75)) held |= IN.BACK;
      if (tired && dist < 1.6 && r() < 0.5) held |= IN.BACK;
      if (!(held & IN.BLOCK) || r() < 0.3) held |= this.lateral;

      // offence (discrete decisions)
      if (this.timer <= 0 && !(held & IN.BLOCK) && me.act.type !== 'strike') {
        this.timer = 0.12 + (1 - d) * 0.25 + r() * 0.2;
        const aggr = tired ? 0.15 : 0.45 + d * 0.4;
        if (dist <= 1.7 && r() < aggr) {
          // takedown?
          const tdWant = st.wre * 0.22 + (oppWinding ? 0.25 : 0) + (op.rocked > 0 ? 0.2 : 0) + (me.dmg.head > 55 ? 0.2 : 0);
          if (dist <= 1.5 && me.stam > 20 && r() < tdWant * (0.4 + d * 0.6)) {
            this.pressed |= IN.GRAPPLE;
          } else {
            this.pressed |= this._pickStrike(me, op, dist);
          }
        }
      }
      this.held = held;
      return { held, pressed: this.pressed };
    }

    _pickStrike(me, op, dist) {
      const r = this.rng, st = me.stats;
      const w = [];
      const push = (bit, wt) => { if (wt > 0) w.push([bit, wt]); };
      const rocked = op.rocked > 0;
      if (dist <= 1.35) push(IN.JAB, rocked ? 8 : 30);
      if (dist <= 1.4) push(IN.CROSS, 18 + st.pow * 15 + (rocked ? 25 : 0));
      if (dist <= 1.18) push(IN.HOOK, 10 + st.pow * 15 + (rocked ? 25 : 0));
      if (dist <= 1.5) push(IN.LKICK, 12 + (op.dmg.legs > 40 ? 10 : 0));
      if (dist <= 1.6) push(IN.BKICK, 9 + (op.stam < 40 ? 6 : 0));
      if (dist <= 1.7) push(IN.HKICK, 3 + st.pow * 6 + (rocked ? 12 : 0) + (op.stam < 30 ? 5 : 0));
      if (dist <= 1.1) push(IN.BKICK, 10); // knee
      if (!w.length) return 0;
      let tot = 0; for (const x of w) tot += x[1];
      let k = r() * tot;
      for (const x of w) { k -= x[1]; if (k <= 0) return x[0]; }
      return w[0][0];
    }

    _top(S, me, op, dt) {
      const r = this.rng, d = this.diff, G = S.ground;
      let held = 0;
      if (G.sub) { this.held = 0; return; }
      if (G.escape > 55 && r() < 0.6) held |= IN.BLOCK; // posture up, kill the escape
      if (this.timer <= 0 && me.act.type === 'idle') {
        this.timer = 0.25 + (1 - d) * 0.4 + r() * 0.3;
        const subWant = me.stats.bjj * 0.35 + (op.stam < 35 ? 0.2 : 0) + (op.rocked > 0 ? 0.3 : 0) - (me.stam < 30 ? 0.3 : 0);
        if ((me.stats.bjj > 0.45 || op.rocked > 0 || op.stam < 25) && r() < subWant * 0.45 && me.stam > 20) { this.pressed |= IN.GRAPPLE; held &= ~IN.BLOCK; }
        else if (r() < 0.75 && me.stam > 10) {
          held &= ~IN.BLOCK;
          const k = r();
          this.pressed |= k < 0.45 ? IN.JAB : k < 0.7 ? IN.CROSS : k < 0.85 ? IN.HOOK : IN.BKICK;
        }
      }
      this.held = held;
    }

    _bottom(S, me, op, dt) {
      const r = this.rng, d = this.diff, G = S.ground;
      let held = 0;
      const mashRate = (4 + d * 5) * dt; // presses per second
      if (G.sub) {
        if (r() < mashRate * 1.4) this.pressed |= (r() < 0.5 ? IN.BLOCK : IN.DODGE);
        if (r() < mashRate) this.pressed |= IN.LEFT;
        this.held = 0; return;
      }
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
