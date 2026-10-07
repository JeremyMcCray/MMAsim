/* Fight SFX synth plus looping menu / fight music (MintoDog). */
(function (root) {
  'use strict';
  const MUSIC_DEFAULT = 0.2; // modest bed so the tracks sit under hits
  class Audio {
    constructor() {
      this.ctx = null; this.master = null; this.muted = false; this.crowdGain = null;
      this.musicVol = MUSIC_DEFAULT; this.musicMuted = false; this.tracks = null; this.current = null; this.wanted = null; this._musicWarned = false;
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
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }
    // Plain <audio> elements, not MediaElementSource. Routing file:// media
    // through Web Audio is silent in Chrome, and this game is often opened that way.
    _track(url) {
      const el = document.createElement('audio');
      el.src = url; el.loop = true; el.preload = 'auto'; el.setAttribute('playsinline', '');
      el.addEventListener('error', () => console.warn('Music failed to load', url, el.error && el.error.code));
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
      this.wanted = which;
      this._ensureTracks();
      this._startWanted();
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
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => {
          if (this.current === this.wanted) this.current = null;
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
