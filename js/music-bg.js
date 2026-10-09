/* Music-reactive void behind the cage.
   At rest the field is a flat color. Once a track is playing, log-spaced bands
   drive a wash and particles (circuit on the menu, warp during a fight).
   Every accent is mixed from the base chosen in Options. */
(function (root) {
  'use strict';
  const TAU = Math.PI * 2;
  const STORAGE_KEY = 'cr_bg';
  const STORAGE_VER = 'cr_bg_ver';
  const MUSIC_KEY = 'cr_bg_fx';
  const IMPACT_KEY = 'cr_bg_hit';
  const DEFAULT_PRESET = 'legacy';
  const LEGACY_COLOR = '#07070a';

  const CIRCUIT = 'circuit';
  const WARP = 'warp';

  // Resting void colors. Accents (bass / mids / highs) are derived in paletteFrom.
  // 'legacy' (the default) hides the canvas and shows the flat LEGACY_COLOR.
  const PRESETS = [
    { id: 'legacy', name: 'Legacy', color: LEGACY_COLOR },
    { id: 'grey', name: 'Light grey', color: '#d0d0d4' },
    { id: 'offwhite', name: 'Off-white', color: '#e6e4df' },
    { id: 'bone', name: 'Bone', color: '#e6d7c3' },
    { id: 'peach', name: 'Peach', color: '#e8cbb0' },
    { id: 'blush', name: 'Blush', color: '#e4c8c8' },
    { id: 'lilac', name: 'Lilac', color: '#d4cce4' },
    { id: 'sky', name: 'Sky', color: '#b7c9de' },
    { id: 'mint', name: 'Mint', color: '#b7dcc8' },
    { id: 'green', name: 'Green', color: '#8ed56f' },
    { id: 'ink', name: 'Ink', color: '#07070a' },
    { id: 'slate', name: 'Slate', color: '#1a1e26' },
    { id: 'crimson', name: 'Crimson', color: '#2a0e14' },
    { id: 'scarlet', name: 'Scarlet', color: '#4a1420' },
    { id: 'wine', name: 'Wine', color: '#2c1224' },
    { id: 'cobalt', name: 'Cobalt', color: '#0e1a34' },
    { id: 'violet', name: 'Violet', color: '#1a1030' },
    { id: 'plum', name: 'Plum', color: '#2a1434' },
    { id: 'teal', name: 'Teal', color: '#0c2628' },
    { id: 'cyan', name: 'Cyan', color: '#0e2830' },
    { id: 'amber', name: 'Amber', color: '#2a1c0c' },
    { id: 'rust', name: 'Rust', color: '#3a160c' },
    { id: 'emerald', name: 'Emerald', color: '#102418' },
    { id: 'olive', name: 'Olive', color: '#1a220e' },
    { id: 'magenta', name: 'Magenta', color: '#2a1028' }
  ];

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const approach = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));
  function wrap(v, m) {
    if (!(m > 0)) return 0;
    return ((v % m) + m) % m;
  }
  function inside(x, y, w, h, pad) {
    return x >= -pad && y >= -pad && x <= w + pad && y <= h + pad;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }
  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 1); l = clamp(l, 0, 1);
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = l - c / 2;
    return { r: r + m, g: g + m, b: b + m };
  }
  function lerpInto(out, a, b, t) {
    t = clamp(t, 0, 1);
    out.r = a.r + (b.r - a.r) * t;
    out.g = a.g + (b.g - a.g) * t;
    out.b = a.b + (b.b - a.b) * t;
    return out;
  }
  function lightenInto(out, c, amount) {
    const t = clamp(amount, 0, 1);
    out.r = c.r + (1 - c.r) * t;
    out.g = c.g + (1 - c.g) * t;
    out.b = c.b + (1 - c.b) * t;
    return out;
  }
  function css(c, a) {
    const r = (clamp(c.r, 0, 1) * 255) | 0;
    const g = (clamp(c.g, 0, 1) * 255) | 0;
    const b = (clamp(c.b, 0, 1) * 255) | 0;
    if (a == null) return 'rgb(' + r + ',' + g + ',' + b + ')';
    return 'rgba(' + r + ',' + g + ',' + b + ',' + clamp(a, 0, 1) + ')';
  }

  // Dark bases get bright accents. Light bases get darker marks of the same hue
  // so particles stay readable; a near-neutral field (off-white) uses gray.
  function paletteFrom(hex) {
    const bg = hexToRgb(hex);
    const hsl = rgbToHsl(bg.r, bg.g, bg.b);
    const hue = hsl.h;
    const light = hsl.l > 0.55;
    if (light && hsl.s < 0.2) {
      return {
        bg, light: true, hex,
        neon: hslToRgb(0, 0, 0.32),
        gold: hslToRgb(0, 0, 0.42),
        silk: hslToRgb(0, 0, 0.55),
        copper: hslToRgb(0, 0, 0.18)
      };
    }
    if (light) {
      const sat = Math.max(hsl.s, 0.45);
      return {
        bg, light: true, hex,
        neon: hslToRgb(hue, sat, 0.28),
        gold: hslToRgb(hue + 28, Math.max(sat * 0.85, 0.4), 0.36),
        silk: hslToRgb(hue, Math.min(sat, 0.4), 0.46),
        copper: hslToRgb(hue - 12, Math.max(sat * 0.75, 0.4), 0.18)
      };
    }
    const sat = hsl.s < 0.08 ? 0.55 : hsl.s;
    return {
      bg, light: false, hex,
      neon: hslToRgb(hue, Math.max(sat, 0.75), 0.62),
      gold: hslToRgb(hue + 32, Math.max(sat * 0.92, 0.6), 0.56),
      silk: hslToRgb(hue, Math.min(sat * 0.22, 0.28), 0.78),
      copper: hslToRgb(hue - 16, Math.max(sat * 0.5, 0.3), 0.32)
    };
  }
  function loadPresetId() {
    try {
      let id = localStorage.getItem(STORAGE_KEY);
      // One-time migration keyed on STORAGE_VER: ids older builds auto-saved as
      // defaults (ink, offwhite, violet) reset to Legacy. Bump the version to reset again.
      if (localStorage.getItem(STORAGE_VER) !== '4') {
        localStorage.setItem(STORAGE_VER, '4');
        if (!id || id === 'ink' || id === 'offwhite' || id === 'violet') id = DEFAULT_PRESET;
        localStorage.setItem(STORAGE_KEY, id);
      }
      if (PRESETS.some(p => p.id === id)) return id;
    } catch (_) {}
    return DEFAULT_PRESET;
  }
  function loadFlag(key) {
    try { return localStorage.getItem(key) !== '0'; } catch (_) { return true; }
  }
  function saveFlag(key, on) {
    try { localStorage.setItem(key, on ? '1' : '0'); } catch (_) {}
  }
  function loadParticles() { return loadFlag(MUSIC_KEY); }
  function saveParticles(on) { saveFlag(MUSIC_KEY, on); }
  function loadImpact() { return loadFlag(IMPACT_KEY); }
  function saveImpact(on) { saveFlag(IMPACT_KEY, on); }
  function savePresetId(id) {
    try { localStorage.setItem(STORAGE_KEY, id); } catch (_) {}
  }
  function presetById(id) {
    return PRESETS.find(p => p.id === id) || PRESETS.find(p => p.id === DEFAULT_PRESET) || PRESETS[0];
  }

  function makeParticle() {
    return { x: 0, y: 0, vx: 0, vy: 0, life: 0, size: 2, band: 0 };
  }

  class MusicBackground {
    constructor(audio) {
      this.audio = audio || null;
      this.canvas = document.getElementById('musicbg');
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'musicbg';
        this.canvas.setAttribute('aria-hidden', 'true');
        document.body.insertBefore(this.canvas, document.body.firstChild);
      }
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.bandCount = 8;
      this.intensity = 1;
      this.attack = 10;
      this.release = 4;
      this.particleCount = 260;
      this.bands = new Float32Array(this.bandCount);
      this.particles = [];
      this.sparks = [];
      this.particlesOn = loadParticles();
      this.impactOn = loadImpact();
      this.legacy = true;
      this.active = CIRCUIT;
      this.bass = 0; this.low = 0; this.mid = 0; this.high = 0; this.flux = 0;
      this.time = 0;
      this.wash = { r: 0, g: 0, b: 0 };
      this._c0 = { r: 0, g: 0, b: 0 };
      this._c1 = { r: 0, g: 0, b: 0 };
      this._laidW = -1; this._laidH = -1;
      this._then = performance.now();
      this.w = 1; this.h = 1; this.dpr = 1;
      this._rebuildBands();
      this.setPreset(loadPresetId());
      this._resize();
      window.addEventListener('resize', () => this._resize());
    }

    setPreset(id) {
      const p = presetById(id);
      this.presetId = p.id;
      this.legacy = p.id === 'legacy';
      this.palette = paletteFrom(this.legacy ? LEGACY_COLOR : p.color);
      savePresetId(p.id);
      document.documentElement.style.setProperty('--bg', this.legacy ? LEGACY_COLOR : p.color);
      if (this.canvas) this.canvas.hidden = this.legacy;
      if (this.legacy) this.sparks.length = 0;
    }

    setMusicParticles(on) {
      this.particlesOn = !!on;
      saveParticles(this.particlesOn);
    }

    setImpactParticles(on) {
      this.impactOn = !!on;
      saveImpact(this.impactOn);
      if (!this.impactOn) this.sparks.length = 0;
    }

    // A hit shoves the void. Music specks recoil only while that layer is on.
    punch(x, y, power) {
      if (this.legacy || !this.impactOn) return;
      const pwr = clamp(power, 0, 1.2);
      const kick = 100 + pwr * 620;
      if (this.particlesOn) for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        let dx = p.x - x, dy = p.y - y;
        let dist = Math.hypot(dx, dy);
        if (!(dist > 1)) { dx = 1; dy = 0; dist = 1; }
        const falloff = Math.exp(-dist / (240 + pwr * 280));
        const s = kick * (0.22 + falloff) * (0.5 + Math.random() * 0.8);
        const shove = (10 + pwr * 42) * (0.25 + falloff);
        p.x += (dx / dist) * shove;
        p.y += (dy / dist) * shove;
        p.vx += (dx / dist) * s;
        p.vy += (dy / dist) * s;
        p.life = Math.max(p.life, 0.3 + pwr * 0.35);
      }
      const cx = this.w * 0.5, cy = this.h * 0.5;
      const far = Math.max(this.w, this.h) * 0.78;
      const born = (px, py, ang, sp) => {
        this.sparks.push({
          x: px, y: py,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          life: 0.42 + Math.random() * (0.28 + pwr * 0.4),
          size: 2.6 + pwr * 5.2 * Math.random()
        });
      };
      const fromHit = 8 + Math.round(pwr * 16);
      for (let i = 0; i < fromHit; i++) {
        const ang = Math.random() * TAU;
        born(x + Math.cos(ang) * rand(6, 36), y + Math.sin(ang) * rand(6, 36), ang, (220 + pwr * 860) * (0.45 + Math.random()));
      }
      const outer = 20 + Math.round(pwr * 42);
      for (let i = 0; i < outer; i++) {
        const ang = Math.random() * TAU;
        const rad = rand(far * 0.32, far * 0.96);
        const px = cx + Math.cos(ang) * rad;
        const py = cy + Math.sin(ang) * rad;
        let dx = px - x, dy = py - y;
        const dist = Math.hypot(dx, dy) || 1;
        const sp = (160 + pwr * 740) * (0.4 + Math.random() * 0.85);
        born(px, py, Math.atan2(dy, dx), sp);
      }
      if (this.sparks.length > 260) this.sparks.splice(0, this.sparks.length - 260);
    }

    step() {
      const now = performance.now();
      let dt = (now - this._then) / 1000;
      this._then = now;
      if (this.legacy) return;
      if (!(dt > 0)) dt = 0;
      else if (dt > 0.05) dt = 0.05;
      this._resize();
      if (this.w < 2 || this.h < 2) return;
      this.time += dt;
      this._sample(dt);
      this._resolveDirection();
      if (this.particlesOn) this._move(dt);
      this._stepImpacts(dt);
      this._draw();
    }

    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      const bw = Math.floor(w * dpr), bh = Math.floor(h * dpr);
      if (this.canvas.width !== bw || this.canvas.height !== bh) {
        this.canvas.width = bw;
        this.canvas.height = bh;
      }
      this.dpr = dpr;
      this.w = w;
      this.h = h;
      const n = Math.round(260 * Math.sqrt((w * h) / (1280 * 720)));
      const count = clamp(n, 180, 420);
      if (count !== this.particleCount || Math.abs(w - this._laidW) > 2 || Math.abs(h - this._laidH) > 2) {
        this.particleCount = count;
        this._laidW = w;
        this._laidH = h;
        if (w >= 2 && h >= 2) this._rebuild();
      }
    }

    _sample(dt) {
      if (this.bands.length !== this.bandCount) this._rebuildBands();
      const prevBass = this.bass;
      const raw = this.audio && this.audio.sampleBands ? this.audio.sampleBands() : null;
      if (!raw) {
        this._decay(dt);
      } else {
        const n = Math.min(this.bandCount, raw.length);
        for (let i = 0; i < n; i++) {
          const v = raw[i];
          const rate = v > this.bands[i] ? this.attack : this.release;
          this.bands[i] = approach(this.bands[i], v, rate, dt);
        }
        this.bass = this._slice(0, 0.22);
        this.low = this._slice(0.22, 0.42);
        this.mid = this._slice(0.42, 0.70);
        this.high = this._slice(0.70, 1);
        this.flux = Math.max(this.bass - prevBass, 0);
      }
      const pal = this.palette;
      if (pal.light) {
        lerpInto(this.wash, pal.bg, pal.copper, this.bass * 0.38 + this.flux * 0.22);
        lerpInto(this.wash, this.wash, pal.neon, this.mid * 0.22);
        lerpInto(this.wash, this.wash, pal.gold, this.high * 0.14);
      } else {
        lerpInto(this.wash, pal.bg, pal.neon, this.bass * 0.55 + this.flux * 0.35);
        lerpInto(this.wash, this.wash, pal.gold, this.mid * 0.40);
        lightenInto(this._c1, pal.silk, 0.35);
        lerpInto(this.wash, this.wash, this._c1, this.high * 0.35);
      }
    }

    _decay(dt) {
      const k = 1 - Math.exp(-this.release * dt);
      for (let i = 0; i < this.bands.length; i++) this.bands[i] = lerp(this.bands[i], 0, k);
      const s = 1 - Math.exp(-4 * dt);
      this.bass = lerp(this.bass, 0, s);
      this.low = lerp(this.low, 0, s);
      this.mid = lerp(this.mid, 0, s);
      this.high = lerp(this.high, 0, s);
      this.flux = 0;
    }

    _slice(fromT, toT) {
      const n = this.bandCount;
      if (!n) return 0;
      const start = clamp(Math.floor(fromT * n), 0, n - 1);
      const stop = clamp(Math.ceil(toT * n), start + 1, n);
      let acc = 0;
      for (let i = start; i < stop; i++) acc += this.bands[i];
      return acc / (stop - start);
    }

    _resolveDirection() {
      const track = this.audio ? (this.audio.wanted || this.audio.current || '') : '';
      const next = track === 'fight' ? WARP : CIRCUIT;
      if (next !== this.active) {
        this.active = next;
        this._rebuild();
      }
    }

    _move(dt) {
      if (this.particles.length !== this.particleCount) this._rebuild();
      if (this.active === CIRCUIT) this._stepCircuit(dt);
      else this._stepWarp(dt);
    }

    _stepCircuit(dt) {
      const surge = 40 + this.bass * 420 + this.flux * 700;
      const hop = this.high * 0.35;
      const w = this.w, h = this.h;
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        p.life -= dt;
        if (p.life <= 0 || !inside(p.x, p.y, w, h, 12)) { this._respawnCircuit(p); continue; }
        if (hop > 0.04 && Math.random() < hop * dt * 3) {
          const swap = p.vx;
          p.vx = -p.vy;
          p.vy = swap;
          p.size = Math.max(p.size, 2.4 + this.high * 2);
        }
        const axis = 1 + (this.bands[p.band] || 0) * 2.8;
        const s = surge * axis * dt;
        p.x = wrap(p.x + p.vx * s, w);
        p.y = wrap(p.y + p.vy * s, h);
      }
    }

    _stepWarp(dt) {
      const cx = this.w * 0.5, cy = this.h * 0.5;
      const out = 30 + this.bass * 520 + this.flux * 900;
      const swirl = (this.low * 1.6 - this.mid * 0.4) * 2.4;
      const kick = this.high * 180;
      const far = Math.max(this.w, this.h) * 0.72;
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        let dx = p.x - cx, dy = p.y - cy;
        let dist = Math.hypot(dx, dy);
        if (dist > far || p.life <= 0) {
          this._respawnWarp(p, cx, cy);
          dx = p.x - cx; dy = p.y - cy;
          dist = Math.hypot(dx, dy);
        }
        dist = Math.max(dist, 4);
        const inv = 1 / dist;
        const dirX = dx * inv, dirY = dy * inv;
        const band = this.bands[p.band] || 0;
        const radial = out * (0.35 + band);
        const tang = swirl * dist * 0.15;
        p.vx = dirX * radial + (-dirY) * tang;
        p.vy = dirY * radial + dirX * tang;
        p.vx += rand(-1, 1) * kick * dt;
        p.vy += rand(-1, 1) * kick * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt;
      }
    }

    _stepImpacts(dt) {
      for (let i = this.sparks.length - 1; i >= 0; i--) {
        const s = this.sparks[i];
        s.life -= dt;
        if (s.life <= 0) { this.sparks.splice(i, 1); continue; }
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vx *= 0.985;
        s.vy *= 0.985;
      }
    }

    _draw() {
      const ctx = this.ctx;
      const boost = document.querySelector('.screen:not(.hidden)') ? 1.35 : 1;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = css(this.palette.bg);
      ctx.fillRect(0, 0, this.w, this.h);
      const drive = Math.max(this.bass, this.mid, this.high, this.flux);
      if (this.particlesOn && drive > 0.02) {
        const washA = (this.bass * 0.42 + this.flux * 0.28 + this.mid * 0.16) * this.intensity * boost;
        ctx.fillStyle = css(this.wash, washA);
        ctx.fillRect(0, 0, this.w, this.h);
      }
      this._drawImpacts();
      if (!this.particlesOn || drive <= 0.08) return;
      ctx.lineCap = 'round';
      for (let i = 0; i < this.particles.length; i++) this._drawParticle(this.particles[i], boost);
    }

    _drawImpacts() {
      if (!this.impactOn || !this.sparks.length) return;
      const ctx = this.ctx;
      const pal = this.palette;
      ctx.lineCap = 'round';
      for (let i = 0; i < this.sparks.length; i++) {
        const s = this.sparks[i];
        const t = clamp(s.life / 0.4, 0, 1);
        lerpInto(this._c0, pal.copper, pal.neon, t);
        const sp = Math.hypot(s.vx, s.vy);
        ctx.fillStyle = css(this._c0, 0.35 + t * 0.55);
        if (sp > 8) {
          const len = Math.min(28, 6 + sp * 0.03);
          const inv = len / sp;
          ctx.strokeStyle = css(this._c0, t * 0.55);
          ctx.lineWidth = Math.max(s.size * 0.45, 1);
          ctx.beginPath();
          ctx.moveTo(s.x - s.vx * inv, s.y - s.vy * inv);
          ctx.lineTo(s.x, s.y);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(s.size * (0.4 + t), 0.6), 0, TAU);
        ctx.fill();
      }
    }

    _particleEnergy(p) {
      const own = this.bands[p.band] || 0;
      return Math.max(own, this.bass * 0.72, this.mid * 0.35);
    }

    _drawParticle(p, boost) {
      const energy = this._particleEnergy(p);
      if (energy < 0.08) return;
      this._colorInto(this._c0, p.band, energy);
      const alpha = clamp((energy * 0.85 + this.flux * 0.15) * this.intensity * boost, 0, 0.95);
      const radius = p.size * (1.05 + energy * 1.7) * this.intensity;
      const ctx = this.ctx;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0.01) {
        const len = 10 + energy * 34 + this.bass * 16;
        const inv = len / sp;
        ctx.strokeStyle = css(this._c0, alpha * 0.45);
        ctx.lineWidth = Math.max(radius * 0.7, 1);
        ctx.beginPath();
        ctx.moveTo(p.x - p.vx * inv, p.y - p.vy * inv);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.fillStyle = css(this._c0, alpha);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(radius, 0.4), 0, TAU);
      ctx.fill();
      if (energy > 0.55 || this.high > 0.4) {
        if (this.palette.light) lerpInto(this._c1, this._c0, this.palette.copper, 0.55);
        else lightenInto(this._c1, this.palette.neon, 0.72);
        ctx.fillStyle = css(this._c1, alpha * 0.65);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(radius * 0.38, 0.3), 0, TAU);
        ctx.fill();
      }
    }

    _colorInto(out, band, energy) {
      const t = band / Math.max(this.bandCount - 1, 1);
      const pal = this.palette;
      if (pal.light) {
        if (t < 0.3) lerpInto(out, pal.copper, pal.neon, 0.25 + this.bass * 0.5);
        else if (t > 0.75) lerpInto(out, pal.silk, pal.copper, 0.2 + this.high * 0.45);
        else lerpInto(out, pal.neon, pal.gold, t);
        lerpInto(out, out, pal.copper, energy * 0.35);
        return;
      }
      if (t < 0.3) lerpInto(out, pal.copper, pal.neon, 0.35 + this.bass * 0.65);
      else if (t > 0.75) lightenInto(out, pal.silk, 0.25 + this.high * 0.4);
      else lerpInto(out, pal.neon, pal.gold, t);
      lightenInto(this._c1, pal.neon, 0.75);
      lerpInto(out, out, this._c1, energy * 0.25);
    }

    _rebuildBands() {
      this.bandCount = Math.max(2, this.bandCount | 0);
      this.bands = new Float32Array(this.bandCount);
    }

    _rebuild() {
      const n = this.particleCount | 0;
      const list = this.particles;
      if (list.length > n) list.length = n;
      while (list.length < n) list.push(makeParticle());
      const centerX = this.w * 0.5, centerY = this.h * 0.5;
      for (let i = 0; i < n; i++) {
        const p = list[i];
        p.band = i % this.bandCount;
        if (this.active === CIRCUIT) this._respawnCircuit(p);
        else this._respawnWarp(p, centerX, centerY);
      }
    }

    _respawnCircuit(p) {
      p.x = Math.random() * this.w;
      p.y = Math.random() * this.h;
      if (Math.random() < 0.5) { p.vx = Math.random() < 0.5 ? 1 : -1; p.vy = 0; }
      else { p.vx = 0; p.vy = Math.random() < 0.5 ? 1 : -1; }
      p.life = rand(2, 6);
      p.size = rand(2.4, 4.6);
    }

    _respawnWarp(p, cx, cy) {
      const ang = Math.random() * TAU;
      // The cage covers the middle of the view, so most streaks are born
      // out in the void. A few still start at the center and fly out past the fence.
      const far = Math.max(this.w, this.h) * 0.72;
      const rad = Math.random() < 0.22 ? rand(6, 48) : rand(far * 0.28, far * 0.92);
      p.x = cx + Math.cos(ang) * rad;
      p.y = cy + Math.sin(ang) * rad;
      const sp = rand(30, 120);
      p.vx = Math.cos(ang) * sp;
      p.vy = Math.sin(ang) * sp;
      p.life = rand(2.6, 6.2);
      p.size = rand(2.6, 5.0);
    }
  }

  root.MMAMusicBg = { MusicBackground, PRESETS, paletteFrom, cssColor: css, loadPresetId, savePresetId, loadParticles, saveParticles, loadImpact, saveImpact, DEFAULT_PRESET, LEGACY_COLOR };
})(typeof window !== 'undefined' ? window : globalThis);
