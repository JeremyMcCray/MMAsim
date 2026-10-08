/* Fight SFX synth plus looping menu / fight music (MintoDog). */
(function (root) {
  'use strict';
  const MUSIC_DEFAULT = 0.2; // modest bed so the tracks sit under hits
  class Audio {
    constructor() {
      this.ctx = null; this.master = null; this.muted = false; this.crowdGain = null;
      this.musicVol = MUSIC_DEFAULT; this.musicMuted = false; this.tracks = null; this.current = null; this.wanted = null; this._musicWarned = false;
      this.analyser = null; this._specSrc = null; this._specEl = null; this._freq = null; this._specListen = null;
      try {
        const v = parseFloat(localStorage.getItem('cr_music'));
        if (Number.isFinite(v)) this.musicVol = Math.min(1, Math.max(0, v));
        this.musicMuted = localStorage.getItem('cr_music_mute') === '1';
      } catch (_) {}
    }
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.8; this.master.connect(this.ctx.destination);
      // 2 s of white noise, shared by the crowd bed and the SFX bursts
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
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }
    // Plain <audio> elements, not MediaElementSource. Routing file:// media
    // through Web Audio is silent in Chrome, and this game is often opened that way.
    _track(url) {
      const el = document.createElement('audio');
      el.src = url; el.loop = true; el.preload = 'auto'; el.setAttribute('playsinline', '');
      el.style.display = 'none';
      el.addEventListener('error', () => console.warn('Music failed to load', url, el.error && el.error.code));
      if (document.body) document.body.appendChild(el);
      return el;
    }
    _ensureTracks() {
      if (this.tracks) return;
      this.tracks = {
        menu: this._track('audio/menu-music.mp3'),
        fight: this._track('audio/fight-music.mp3')
      };
    }
    _applyMusicVolume() {
      if (!this.tracks) return;
      const v = (this.muted || this.musicMuted) ? 0 : this.musicVol;
      this.tracks.menu.volume = v;
      this.tracks.fight.volume = v;
    }
    setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.value = m ? 0 : 0.8;
      this._applyMusicVolume();
    }
    setMusicMuted(m) {
      this.musicMuted = !!m;
      this._applyMusicVolume();
      try { localStorage.setItem('cr_music_mute', this.musicMuted ? '1' : '0'); } catch (_) {}
    }
    setMusicVolume(v) {
      this.musicVol = Math.min(1, Math.max(0, v));
      this._applyMusicVolume();
      try { localStorage.setItem('cr_music', String(this.musicVol)); } catch (_) {}
    }
    play(which) {
      if (!which || which === 'menu') { this.stop(); return; }
      this.wanted = which;
      this.init();
      this._ensureTracks();
      this._startWanted();
    }
    stop() {
      this.wanted = null;
      if (!this.tracks) return;
      for (const name in this.tracks) {
        const el = this.tracks[name];
        if (!el) continue;
        el.pause();
        try { el.currentTime = 0; } catch (_) {}
      }
      this.current = null;
    }
    _audible() {
      const tracks = this.tracks;
      if (!tracks) return null;
      const current = this.current && tracks[this.current];
      if (current && !current.paused) return { name: this.current, el: current };
      for (const name of ['fight', 'menu']) {
        const el = tracks[name];
        if (el && !el.paused) return { name, el };
      }
      return null;
    }
    // Band levels in 0..1 for the playing track. Prefers the precomputed envelope
    // in music-env.js (indexed by currentTime, works from file://); live FFT is
    // the fallback when a track has no envelope.
    sampleBands() {
      const playing = this._audible();
      if (!playing) return null;
      const env = root.MMAMusicEnv;
      const data = env && env.tracks ? env.tracks[playing.name] : null;
      if (data && data.length) return this._envBands(playing.el, env, data);
      return this._liveBands();
    }
    _envBands(el, env, data) {
      const bands = env.bands || 8;
      const frames = (data.length / bands) | 0;
      if (frames < 1) return null;
      const f = Math.max(0, el.currentTime) * (env.hz || 30);
      const i0 = Math.min(frames - 1, f | 0);
      const i1 = Math.min(frames - 1, i0 + 1);
      const u = i0 === i1 ? 0 : f - i0;
      const out = this._bandOut && this._bandOut.length === bands ? this._bandOut : (this._bandOut = new Float32Array(bands));
      const a0 = i0 * bands, a1 = i1 * bands;
      for (let b = 0; b < bands; b++) {
        const lo = data[a0 + b] / 255;
        out[b] = lo + (data[a1 + b] / 255 - lo) * u;
      }
      return out;
    }
    _liveBands() {
      const spec = this.sampleSpectrum();
      if (!spec) return null;
      const bands = 8, minHz = 40, maxHz = 14000;
      const out = this._bandOut && this._bandOut.length === bands ? this._bandOut : (this._bandOut = new Float32Array(bands));
      const minDb = -36, maxDb = -8;
      for (let b = 0; b < bands; b++) {
        const lo = minHz * Math.pow(maxHz / minHz, b / bands);
        const hi = minHz * Math.pow(maxHz / minHz, (b + 1) / bands);
        let i0 = Math.floor(lo / spec.binHz);
        let i1 = Math.ceil(hi / spec.binHz);
        if (i0 < 1) i0 = 1;
        if (i1 >= spec.db.length) i1 = spec.db.length - 1;
        let max = -Infinity;
        for (let i = i0; i <= i1; i++) if (spec.db[i] > max) max = spec.db[i];
        out[b] = max === -Infinity ? 0 : Math.max(0, Math.min(1, (max - minDb) / (maxDb - minDb)));
      }
      return out;
    }
    // Live FFT of the playing track via captureStream, which keeps the <audio>
    // element audible (see _track for why MediaElementSource is avoided).
    sampleSpectrum() {
      if (!this.ctx) return null;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._ensureSpectrum();
      if (!this.analyser || !this._freq) return null;
      this.analyser.getFloatFrequencyData(this._freq);
      return { db: this._freq, binHz: this.ctx.sampleRate / this.analyser.fftSize };
    }
    _ensureSpectrum() {
      const el = this.tracks && this.current ? this.tracks[this.current] : null;
      if (!el) return;
      if (this.analyser && this._specEl === el) return;
      if (this._specEl && this._specEl !== el) {
        if (this._specSrc) { try { this._specSrc.disconnect(); } catch (_) {} this._specSrc = null; }
        this.analyser = null;
        this._specEl = null;
      }
      if (!this._specListen) this._specListen = new WeakSet();
      if (!this._specListen.has(el)) {
        this._specListen.add(el);
        el.addEventListener('playing', () => { if (this.tracks && this.tracks[this.current] === el) this._hookSpectrum(el, true); });
      }
      if (!el.paused) this._hookSpectrum(el, false);
    }
    _hookSpectrum(el, force) {
      if (!this.ctx || (this.analyser && this._specEl === el) || this._specFailed === el) return;
      if (!force) {
        this._specTick = (this._specTick | 0) + 1;
        if (this._specTick % 10 !== 1) return;
      }
      const cap = el.captureStream || el.mozCaptureStream;
      if (typeof cap !== 'function') { this._specFailed = el; return; }
      let stream;
      try { stream = cap.call(el); }
      catch (err) {
        this._specFailed = el;
        if (!this._musicWarned) console.warn('Music spectrum tap failed', err);
        return;
      }
      if (!stream.getAudioTracks().length) return;
      try {
        if (this._specSrc) { try { this._specSrc.disconnect(); } catch (_) {} }
        const src = this.ctx.createMediaStreamSource(stream);
        const an = this.ctx.createAnalyser();
        an.fftSize = 2048;
        an.smoothingTimeConstant = 0;
        an.minDecibels = -100;
        an.maxDecibels = -8;
        src.connect(an);
        this._specSrc = src;
        this.analyser = an;
        this._specEl = el;
        this._freq = new Float32Array(an.frequencyBinCount);
      } catch (err) {
        this._specFailed = el;
        console.warn('Music spectrum tap failed', err);
      }
    }
    _startWanted() {
      if (!this.tracks || !this.wanted) return;
      if (this.current && this.current !== this.wanted) {
        const prev = this.tracks[this.current];
        prev.pause();
        try { prev.currentTime = 0; } catch (_) {}
      }
      const el = this.tracks[this.wanted];
      this.current = this.wanted;
      this._applyMusicVolume();
      if (!el.paused && el.currentTime > 0) return;
      const pending = el.play();
      const started = this.wanted;
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => {
          // Switching tracks aborts the previous play() after the new one has started.
          if (!err || err.name === 'AbortError') return;
          if (this.wanted === started && this.current === started) this.current = null;
          if (!this._musicWarned) {
            this._musicWarned = true;
            console.warn('Music could not start', err);
          }
        });
      }
    }
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
