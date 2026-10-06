// Tiny procedural sound effects (no assets needed).
export class Sfx {
  constructor() { this.ctx = null; }
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.ctx = null; }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  hit(dmg, kind) {
    this.ensure();
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    const vol = Math.min(1, 0.25 + dmg / 40);
    // thud
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(kind === 'head' ? 150 : 95, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.18);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + 0.25);
    // slap (noise burst)
    const len = Math.floor(c.sampleRate * 0.08);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    const n = c.createBufferSource(); n.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = kind === 'block' ? 600 : 1800; f.Q.value = 0.7;
    const ng = c.createGain(); ng.gain.value = vol * (kind === 'block' ? 0.5 : 0.9);
    n.connect(f).connect(ng).connect(c.destination);
    n.start(t);
  }
  whoosh() {
    this.ensure();
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.16);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) { const e = Math.sin((i / len) * Math.PI); d[i] = (Math.random() * 2 - 1) * e * e; }
    const n = c.createBufferSource(); n.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 1.2;
    const g = c.createGain(); g.gain.value = 0.12;
    n.connect(f).connect(g).connect(c.destination);
    n.start(t);
  }
  bell() {
    this.ensure();
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    for (const [fr, v] of [[880, 0.3], [1760, 0.12], [2640, 0.05]]) {
      const o = c.createOscillator(); const g = c.createGain();
      o.frequency.value = fr; g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 1.7);
    }
  }
}
