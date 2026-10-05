/* Tiny WebAudio synth for fight sounds (no external files). */
(function (root) {
  'use strict';
  class Audio {
    constructor() { this.ctx = null; this.master = null; this.muted = false; this.crowdGain = null; }
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.8; this.master.connect(this.ctx.destination);
      // noise buffer
      const len = this.ctx.sampleRate * 2; const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
      // crowd bed: looping filtered noise
      const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
      const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 350; bp.Q.value = 0.6;
      this.crowdGain = this.ctx.createGain(); this.crowdGain.gain.value = 0.0;
      src.connect(lp); lp.connect(bp); bp.connect(this.crowdGain); this.crowdGain.connect(this.master); src.start();
      this.crowdLevel = 0.05;
    }
    setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.8; }
    setCrowd(level) { if (!this.crowdGain) return; const t = this.ctx.currentTime; this.crowdGain.gain.cancelScheduledValues(t); this.crowdGain.gain.setTargetAtTime(level, t, 0.4); }
    roar(amount) { if (!this.crowdGain) return; const t = this.ctx.currentTime; this.crowdGain.gain.cancelScheduledValues(t); this.crowdGain.gain.setTargetAtTime(Math.min(0.5, 0.08 + amount), t, 0.08); this.crowdGain.gain.setTargetAtTime(0.06, t + 1.2, 1.2); }

    _noise(dur, freq, q, gain, type) {
      const c = this.ctx, t = c.currentTime;
      const s = c.createBufferSource(); s.buffer = this.noise;
      const f = c.createBiquadFilter(); f.type = type || 'lowpass'; f.frequency.value = freq; f.Q.value = q || 1;
      const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.master); s.start(t); s.stop(t + dur + 0.05);
    }
    _tone(freq, dur, gain, type, slide) {
      const c = this.ctx, t = c.currentTime;
      const o = c.createOscillator(); o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
    }

    hit(big, part) {
      if (!this.ctx) return;
      this._noise(big ? 0.22 : 0.12, part === 'body' ? 300 : 900, 1, big ? 0.9 : 0.5);
      this._tone(part === 'body' ? 90 : 140, big ? 0.25 : 0.12, big ? 0.7 : 0.35, 'sine', 40);
      if (big) this.roar(0.18);
    }
    block() { if (!this.ctx) return; this._noise(0.08, 2500, 2, 0.3, 'bandpass'); this._tone(220, 0.06, 0.15, 'triangle'); }
    whiff() { if (!this.ctx) return; this._noise(0.16, 1800, 0.7, 0.14, 'bandpass'); }
    slam() { if (!this.ctx) return; this._noise(0.35, 250, 1, 1.0); this._tone(60, 0.4, 0.8, 'sine', 30); this.roar(0.25); }
    bell(n) {
      if (!this.ctx) return;
      const ring = (dl) => { setTimeout(() => { this._tone(1760, 1.4, 0.35, 'triangle'); this._tone(2640, 0.9, 0.15, 'sine'); this._tone(880, 1.6, 0.25, 'sine'); }, dl); };
      for (let i = 0; i < (n || 1); i++) ring(i * 350);
      this.roar(0.15);
    }
    horn() { if (!this.ctx) return; this._tone(196, 1.6, 0.5, 'sawtooth'); this._tone(147, 1.6, 0.4, 'sawtooth'); this.roar(0.45); }
    tap() { if (!this.ctx) return; this._noise(0.1, 1200, 1, 0.5); setTimeout(() => this._noise(0.1, 1200, 1, 0.5), 120); setTimeout(() => this._noise(0.1, 1200, 1, 0.5), 240); this.roar(0.45); }
    whistle() { if (!this.ctx) return; this._tone(2800, 0.5, 0.25, 'square', 2600); }
  }
  root.MMAAudio = { Audio };
})(typeof window !== 'undefined' ? window : globalThis);
