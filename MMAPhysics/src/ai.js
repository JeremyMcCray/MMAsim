import * as THREE from 'three';
import { STRIKE_DURATION } from './poses.js';

// A simple reactive striker: manages range, circles, picks strikes by range, guards against
// incoming attacks (with human-ish reaction time) and backs off after eating a hit.
export class AI {
  constructor(fighter, opts = {}) {
    this.f = fighter;
    this.aggression = opts.aggression ?? 0.55;
    this.reaction = opts.reaction ?? 0.16;
    this.decisionT = 0;
    this.strafe = 0;
    this.strafeT = 0;
    this.guardUntil = 0;
    this.retreatUntil = 0;
    this.t = 0;
    this.wantRange = 1.0;
    this.plannedCombo = [];
    this.comboT = 0;
    this.lastOppStrike = null;
    this.oppStrikeSeenAt = -1;
    this.lastHealth = 100;
  }

  update(dt) {
    const f = this.f, o = f.opponent;
    this.t += dt;
    if (!o || f.state !== 'fight') { f.setMove(0, 0); f.setGuard(false); return; }

    const a = f.position(), b = o.position();
    const d = Math.hypot(b.x - a.x, b.z - a.z);

    // got hit -> short retreat
    if (f.health < this.lastHealth - 6) {
      this.retreatUntil = this.t + 0.5 + Math.random() * 0.5;
      this.plannedCombo.length = 0;
    }
    this.lastHealth = f.health;

    // react to opponent's strike start
    if (o.strike && o.strike !== this.lastOppStrike) {
      this.lastOppStrike = o.strike;
      this.oppStrikeSeenAt = this.t;
    }
    const oppAttacking = o.strike && o.strike.t < STRIKE_DURATION[o.strike.name] * 0.75;
    if (oppAttacking && this.t - this.oppStrikeSeenAt > this.reaction && d < 1.6) {
      const r = Math.random();
      if (r < 0.55) this.guardUntil = this.t + 0.35;
      else if (r < 0.7 && f.dashCd <= 0) f.dash(Math.random() < 0.5 ? -1 : 1, -0.4);
    }

    // decisions on a tick
    this.decisionT -= dt;
    if (this.decisionT <= 0) {
      this.decisionT = 0.18 + Math.random() * 0.3;
      this.wantRange = Math.random() < 0.65 ? 0.72 : 1.05;
      if (Math.random() < 0.3) this.strafe = Math.random() < 0.5 ? -1 : 1;
      else if (Math.random() < 0.3) this.strafe = 0;
      const inRange = d < this.wantRange + 0.25;
      const canAttack = this.t > this.retreatUntil && this.guardUntil < this.t && f.stamina > 18 && !f.strike;
      if (inRange && canAttack && Math.random() < this.aggression * (o.state !== 'fight' ? 1.6 : 1)) {
        this.plannedCombo = this.pickCombo(d);
        this.comboT = 0;
      }
    }

    // run combo
    if (this.plannedCombo.length) {
      this.comboT -= dt;
      if (this.comboT <= 0) {
        const name = this.plannedCombo.shift();
        if (f.startStrike(name)) this.comboT = STRIKE_DURATION[name] * 0.7;
        else this.plannedCombo.length = 0;
      }
    }

    // movement
    let mz = 0, mx = this.strafe * 0.7;
    const retreating = this.t < this.retreatUntil;
    if (retreating) { mz = -1; mx = this.strafe; }
    else if (d > this.wantRange + 0.15) mz = Math.min(1, (d - this.wantRange) * 2);
    else if (d < this.wantRange - 0.15) mz = -0.7;
    if (f.strike) mz = d > 0.7 ? 0.8 : 0; // step into the strike
    f.setMove(mx, mz);
    f.setGuard(this.guardUntil > this.t && !f.strike);
  }

  pickCombo(d) {
    const r = Math.random();
    if (d > 1.0) {
      if (r < 0.4) return ['rkick'];
      if (r < 0.7) return ['lkick'];
      return ['jab', 'cross'];
    }
    if (d < 0.62) {
      if (r < 0.35) return ['lhook'];
      if (r < 0.7) return ['rhook'];
      return ['lhook', 'rhook'];
    }
    if (r < 0.22) return ['jab'];
    if (r < 0.5) return ['jab', 'cross'];
    if (r < 0.62) return ['cross'];
    if (r < 0.74) return ['cross', 'lhook'];
    if (r < 0.86) return ['jab', 'cross', 'rhook'];
    return ['lkick'];
  }
}
