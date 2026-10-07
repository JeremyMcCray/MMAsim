/* ============================================================
   CAGE RULES — neural fighter brain
   A small multi-layer perceptron that reads the fight state and
   produces the same {held, pressed} input masks a keyboard (or the
   scripted CpuBrain in js/ai.js) would. Its weights are evolved by
   self-play in tools/train.js; checkpoints live in brains/*.json.
   Pure JS, no dependencies — runs in the browser and in Node.
   ============================================================ */
(function (root) {
  'use strict';
  const M = root.MMASim || (typeof require === 'function' ? require('./sim.js') : null);
  const { IN, MODS, LIMBS, LIMB_BIT, MOD_BIT, DEFAULT_MOVESET, recovering } = M;

  // ---------- observation ----------
  const POS = ['guard', 'half', 'side', 'mount', 'back'];
  const STRIKE_CHOICES = [null]; // index 0 = don't strike; then every limb x modifier combo
  for (const mod of MODS) for (const limb of LIMBS) STRIKE_CHOICES.push({ limb: LIMB_BIT[limb], mod: MOD_BIT[mod], key: limb + '_' + DEFAULT_MOVESET[mod][limb] });

  // ground actions: 0 rest, 1 block/base/cover, 2-5 transition (FWD/BACK/LEFT/RIGHT + grapple), 6 submission,
  // 7.. strikes: L/R punch, L/R elbow (mod1), L/R hammer fist (mod2), L/R body shot (mod3), L/R knee
  const GROUND_CHOICES = [
    { held: 0, pressed: 0 }, { held: IN.BLOCK, pressed: 0 },
    { held: IN.FWD, pressed: IN.GRAPPLE }, { held: IN.BACK, pressed: IN.GRAPPLE }, { held: IN.LEFT, pressed: IN.GRAPPLE }, { held: IN.RIGHT, pressed: IN.GRAPPLE },
    { held: 0, pressed: IN.GRAPPLE },
    { held: 0, pressed: IN.LHAND }, { held: 0, pressed: IN.RHAND },
    { held: IN.MOD1, pressed: IN.LHAND }, { held: IN.MOD1, pressed: IN.RHAND },
    { held: IN.MOD2, pressed: IN.LHAND }, { held: IN.MOD2, pressed: IN.RHAND },
    { held: IN.MOD3, pressed: IN.LHAND }, { held: IN.MOD3, pressed: IN.RHAND },
    { held: 0, pressed: IN.LLEG }, { held: 0, pressed: IN.RLEG }
  ];

  const N_IN = 61;
  // output layout
  const O = {};
  let o = 0;
  O.move = o; o += 3;        // back / hold / forward
  O.lat = o; o += 3;         // left / hold / right
  O.block = o++;             // > 0 hold block
  O.dodge = o++;             // > 0 press slip
  O.td = o++;                // > 0 press takedown
  O.strike = o; o += STRIKE_CHOICES.length; // argmax: which strike (0 = none)
  O.getup = o++;             // knocked down: > 0 get up now
  O.dive = o++;              // opponent down: > 0 dive on him
  O.ground = o; o += GROUND_CHOICES.length; // argmax ground action
  O.squeeze = o++;           // holding a sub: > 0 squeeze
  O.fight = o++;             // caught in a sub: > 0 hand-fight (block)
  O.escape = o++;            // caught in a sub: > 0 attempt escape
  const N_OUT = o;
  const ARCH = [N_IN, 48, 32, N_OUT];

  function paramCount(arch) { let n = 0; for (let i = 1; i < arch.length; i++) n += arch[i - 1] * arch[i] + arch[i]; return n; }

  function observe(S, idx, x) {
    const me = S.f[idx], op = S.f[1 - idx];
    x.fill(0);
    let k = 0;
    const dist = Math.hypot(op.x - me.x, op.z - me.z);
    x[k++] = Math.min(dist, 3) / 3;
    x[k++] = Math.max(-1, Math.min(1, dist - 1.1));
    x[k++] = me.stam / 100; x[k++] = me.stamMax / 100; x[k++] = op.stam / 100; x[k++] = op.stamMax / 100;
    x[k++] = me.dmg.head / 100; x[k++] = me.dmg.body / 100; x[k++] = me.dmg.legs / 100;
    x[k++] = op.dmg.head / 100; x[k++] = op.dmg.body / 100; x[k++] = op.dmg.legs / 100;
    x[k++] = me.rocked > 0 ? 1 : 0; x[k++] = op.rocked > 0 ? 1 : 0;
    x[k++] = op.blocking ? 1 : 0;
    const oa = op.act, ma = me.act;
    const oStrike = oa.type === 'strike';
    const oWind = oStrike && !oa.hit && !recovering(op);
    x[k++] = oWind ? 1 : 0;
    x[k++] = oStrike && recovering(op) ? 1 : 0;
    x[k++] = oa.type === 'takedown' ? 1 : 0;
    x[k++] = (oa.type === 'hit' || oa.type === 'stumble') ? 1 : 0;
    x[k++] = oa.type === 'dodge' ? 1 : 0;
    x[k++] = oa.type === 'kd' ? 1 : 0;
    x[k++] = oStrike && (oa.name[0] === 'l' && oa.name[1] === 'l' || oa.name[0] === 'r' && oa.name[1] === 'l') ? 1 : 0; // a kick is coming
    x[k++] = (ma.type === 'idle' || ma.type === 'move') ? 1 : 0;
    x[k++] = ma.type === 'strike' && recovering(me) ? 1 : 0;
    x[k++] = ma.type === 'strike' && !recovering(me) ? 1 : 0;
    x[k++] = (ma.type === 'hit' || ma.type === 'stumble') ? 1 : 0;
    x[k++] = ma.type === 'kd' ? 1 : 0;
    x[k++] = ma.type === 'kd' ? Math.min(1, ma.t / 4) : 0;
    x[k++] = me.combo / 3;
    const ms = me.stats, os = op.stats;
    x[k++] = ms.pow; x[k++] = ms.spd; x[k++] = ms.chin; x[k++] = ms.wre; x[k++] = ms.bjj; x[k++] = ms.car;
    x[k++] = os.pow; x[k++] = os.spd; x[k++] = os.chin; x[k++] = os.wre; x[k++] = os.bjj; x[k++] = os.car;
    x[k++] = S.round / S.rounds; x[k++] = S.clock / S.roundLen;
    x[k++] = S.grappling === false ? 0 : 1;
    const G = S.ground;
    x[k++] = G ? 1 : 0;
    if (G) {
      const top = G.top === idx;
      x[k++] = top ? 1 : -1;
      for (const p of POS) x[k++] = G.pos === p ? 1 : 0;
      x[k++] = G.trans && G.trans.by === idx ? 1 : 0;
      x[k++] = G.trans && G.trans.by !== idx ? 1 : 0;
      x[k++] = G.sub && G.sub.att === idx ? 1 : 0;
      x[k++] = G.sub && G.sub.def === idx ? 1 : 0;
      x[k++] = G.sub ? G.sub.prog / 100 : 0;
      x[k++] = G.sub && G.sub.squeezing ? 1 : 0;
      x[k++] = G.cd[idx] > 0 ? 1 : 0;
      x[k++] = op.posture ? 1 : 0;
      x[k++] = Math.min(1, G.ctrlT / 20);
    } else k += 15;
    x[k++] = 1; // bias
    if (k !== N_IN) throw new Error('observation size mismatch: ' + k + ' vs ' + N_IN);
  }

  // ---------- network ----------
  class NeuralBrain {
    // genome: { arch, w: number[] }  (arch optional)
    constructor(idx, genome) {
      this.idx = idx;
      this.arch = (genome && genome.arch) || ARCH;
      this.w = genome && genome.w ? Float32Array.from(genome.w) : NeuralBrain.randomWeights(this.arch, Math.random);
      this.x = new Float32Array(this.arch[0]);
      this.h = this.arch.map(n => new Float32Array(n));
      this.held = 0; this.pressed = 0;
      this.evalT = 0; this.strikeT = 0; this.modHeld = 0; this.modT = 0; this.tdT = 0; this.escT = 0; this.gT = 0;
      this.kdDecided = false; this.diveDecided = false;
      this.name = (genome && genome.name) || 'neural';
    }

    static randomWeights(arch, rng) {
      const w = new Float32Array(paramCount(arch));
      let p = 0;
      for (let l = 1; l < arch.length; l++) {
        const s = Math.sqrt(2 / arch[l - 1]);
        for (let i = 0; i < arch[l - 1] * arch[l]; i++) w[p++] = (rng() * 2 - 1) * s;
        for (let i = 0; i < arch[l]; i++) w[p++] = 0;
      }
      return w;
    }

    forward() {
      const a = this.arch, w = this.w, h = this.h;
      h[0].set(this.x);
      let p = 0;
      for (let l = 1; l < a.length; l++) {
        const inp = h[l - 1], out = h[l], nIn = a[l - 1], nOut = a[l];
        const last = l === a.length - 1;
        for (let j = 0; j < nOut; j++) {
          let s = 0;
          const base = p + j * nIn;
          for (let i = 0; i < nIn; i++) s += w[base + i] * inp[i];
          s += w[p + nIn * nOut + j];
          out[j] = last ? s : (s > 0 ? s : 0.1 * s); // leaky relu
        }
        p += nIn * nOut + nOut;
      }
      return h[a.length - 1];
    }

    update(S, dt) {
      this.pressed = 0;
      const me = S.f[this.idx], op = S.f[1 - this.idx];
      if (S.phase !== 'fight') { this.held = 0; return { held: 0, pressed: 0 }; }
      this.strikeT -= dt; this.modT -= dt; this.tdT -= dt; this.escT -= dt; this.gT -= dt;
      // think every 3 ticks; keep the held mask in between (cheap enough to do every tick, but a human doesn't retarget at 60 Hz)
      this.evalT -= dt;
      if (this.evalT > 0) {
        let held = this.held & ~(IN.LHAND | IN.RHAND | IN.LLEG | IN.RLEG | IN.GRAPPLE | IN.DODGE);
        if (this.modT <= 0) held &= ~(IN.MOD1 | IN.MOD2 | IN.MOD3);
        this.held = held;
        return { held, pressed: 0 };
      }
      this.evalT = 3 / 60;
      observe(S, this.idx, this.x);
      const y = this.forward();
      let held = 0, pressed = 0;
      const argmax = (off, n) => { let b = 0, bv = y[off]; for (let i = 1; i < n; i++) if (y[off + i] > bv) { bv = y[off + i]; b = i; } return b; };

      if (S.ground) {
        const G = S.ground;
        if (G.sub) {
          if (G.sub.att === this.idx) { if (y[O.squeeze] > 0) held |= IN.GRAPPLE; }
          else {
            if (y[O.fight] > 0) held |= IN.BLOCK;
            if (y[O.escape] > 0 && this.escT <= 0) { pressed |= IN.GRAPPLE; this.escT = 0.5; }
          }
        } else if (G.trans) {
          if (G.trans.by !== this.idx && y[O.block] > 0) held |= IN.BLOCK;
        } else {
          const c = GROUND_CHOICES[argmax(O.ground, GROUND_CHOICES.length)];
          if (c.pressed) {
            if (me.act.type === 'idle' && this.gT <= 0) { pressed |= c.pressed; held |= c.held; this.gT = 0.15; this.modHeld = c.held & (IN.MOD1 | IN.MOD2 | IN.MOD3); this.modT = 0.12; }
          } else held |= c.held;
        }
        if (this.modT > 0) held |= this.modHeld;
        this.held = held; this.pressed = pressed;
        return { held, pressed };
      }

      // --- standing ---
      if (me.act.type === 'kd') {
        if (me.act.name === 'down' && y[O.getup] > 0) pressed |= IN.FWD;
        this.held = 0; this.pressed = pressed; return { held: 0, pressed };
      }
      const mv = argmax(O.move, 3);
      if (mv === 0) held |= IN.BACK; else if (mv === 2) held |= IN.FWD;
      const lat = argmax(O.lat, 3);
      if (lat === 0) held |= IN.LEFT; else if (lat === 2) held |= IN.RIGHT;
      if (op.act.type === 'kd') {
        if (y[O.dive] > 0 && this.tdT <= 0) { pressed |= IN.GRAPPLE; this.tdT = 0.3; }
        this.held = held; this.pressed = pressed; return { held, pressed };
      }
      if (y[O.block] > 0) held |= IN.BLOCK;
      if (y[O.dodge] > 0 && me.act.type !== 'dodge') pressed |= IN.DODGE;
      const free = me.act.type !== 'strike' || recovering(me);
      if (!(held & IN.BLOCK) && free) {
        if (y[O.td] > 0 && S.grappling !== false && this.tdT <= 0) { pressed |= IN.GRAPPLE; this.tdT = 0.4; }
        else if (this.strikeT <= 0 && me.stam >= 3) { // (a press on an empty tank only erodes max stamina: never worth it)
          const c = STRIKE_CHOICES[argmax(O.strike, STRIKE_CHOICES.length)];
          if (c) { pressed |= c.limb; this.modHeld = c.mod; this.modT = 0.12; this.strikeT = 0.1; }
        }
      }
      if (this.modT > 0) held |= this.modHeld;
      this.held = held; this.pressed = pressed;
      return { held, pressed };
    }

    toJSON() { return { arch: this.arch, w: Array.from(this.w, v => Math.round(v * 1e4) / 1e4), name: this.name }; }
  }

  root.MMABrain = { NeuralBrain, ARCH, N_IN, N_OUT, paramCount, observe, STRIKE_CHOICES, GROUND_CHOICES, OUT: O };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MMABrain;
})(typeof window !== 'undefined' ? window : globalThis);
