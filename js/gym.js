/* ============================================================
   Cage Rules — the career gym as a walkable 3D room, rebuilt from the save.
   Stations: heavy bag (hit readout), computer (offers), whiteboard (training
   week), front desk (upgrades), wall of fame (history).
   Each facility level adds furniture; the total level sets the room tier
   (garage -> elite). Walking, striking and the bag run on the fight engine:
   a training Sim (js/sim.js) whose fighter 1 is a heavy bag hung in the
   physics World (js/physics.js), so the gym plays exactly like a fight.
   ============================================================ */
(function (root) {
  'use strict';
  const { STRIKES, IN, DEFAULT_MOVESET, KIND_LABEL, Sim } = root.MMASim;
  const { FighterModel } = root.MMARender;
  const Career = root.MMACareer;

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const expo = (dt, k) => 1 - Math.exp(-dt * k);
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  // ---------- layout (metres; the room is centred on the origin, the door is on the +z wall) ----------
  const ROOM = { hw: 7.5, hd: 5.5, h: 3.6 };          // half width (x), half depth (z), ceiling height
  const BAG = { x: 0.6, z: -0.6, r: 0.18, top: 1.95, bot: 0.72, pivot: 2.95 };
  const SPAWN = { x: 3.4, z: 1.7, yaw: Math.PI + 0.25 };     // facing -z, into the room
  const LOCK_RANGE = 3.2;                             // how close to the bag you can lock on
  const ROOM_FOV = 50, FIGHT_FOV = 42;                // camera lens walking the room / locked on (the fight camera's)
  const DIRS = IN.FWD | IN.BACK | IN.LEFT | IN.RIGHT;
  const SIM_BITS = 0x3fff;                            // input bits the sim reads (the gym's interact / lock bits sit above)

  // the interaction spots. `tab` is the hub panel the station opens; the bag has none (you just hit it).
  const STATIONS = [
    { id: 'computer', x: -5.6, z: -3.7, r: 1.35, tab: 'offers' },
    { id: 'board', x: -1.9, z: -4.5, r: 1.3, tab: 'camp' },
    { id: 'desk', x: 5.5, z: 3.5, r: 1.4, tab: 'gym' },
    { id: 'fame', x: 6.6, z: -1.2, r: 1.35, tab: 'history' },
    { id: 'bag', x: BAG.x, z: BAG.z, r: 1.7, tab: null }
  ];

  // ---------- canvas textures ----------
  function canvasTex(w, h, draw, repeat) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    return t;
  }
  function noise(g, w, h, n, a) { for (let i = 0; i < n; i++) { g.fillStyle = 'rgba(' + (Math.random() < 0.5 ? '255,255,255,' : '0,0,0,') + (Math.random() * a) + ')'; g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 4, 2 + Math.random() * 4); } }
  const FLOORS = {
    concrete: () => canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = '#6a6762'; g.fillRect(0, 0, w, h); noise(g, w, h, 5000, 0.12);
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
      g.fillStyle = 'rgba(20,15,10,0.22)'; g.beginPath(); g.ellipse(w * 0.3, h * 0.65, 70, 40, 0.5, 0, Math.PI * 2); g.fill();
    }, [3, 2]),
    rubber: () => canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = '#26262b'; g.fillRect(0, 0, w, h); noise(g, w, h, 9000, 0.08);
      g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 2;
      for (let i = 0; i <= 2; i++) { g.beginPath(); g.moveTo(0, i * h / 2); g.lineTo(w, i * h / 2); g.moveTo(i * w / 2, 0); g.lineTo(i * w / 2, h); g.stroke(); }
    }, [8, 6]),
    pro: () => canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = '#1c1c21'; g.fillRect(0, 0, w, h); noise(g, w, h, 6000, 0.06);
      g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1;
      for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(0, i * h / 4); g.lineTo(w, i * h / 4); g.moveTo(i * w / 4, 0); g.lineTo(i * w / 4, h); g.stroke(); }
    }, [8, 6]),
    mat: (color) => canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = color; g.fillRect(0, 0, w, h); noise(g, w, h, 1500, 0.08);
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 3; g.strokeRect(1, 1, w - 2, h - 2);
    }, [3, 3])
  };
  const WALLS = {
    block: () => canvasTex(512, 256, (g, w, h) => {
      g.fillStyle = '#8c8880'; g.fillRect(0, 0, w, h); noise(g, w, h, 3000, 0.1);
      g.strokeStyle = 'rgba(40,35,30,.6)'; g.lineWidth = 3;
      for (let r = 0; r < 4; r++) { const y = r * h / 4; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); const off = r % 2 ? w / 8 : 0; for (let c = 0; c < 4; c++) { g.beginPath(); g.moveTo(c * w / 4 + off, y); g.lineTo(c * w / 4 + off, y + h / 4); g.stroke(); } }
    }, [6, 3]),
    painted: (top, bottom) => canvasTex(256, 512, (g, w, h) => {
      g.fillStyle = top; g.fillRect(0, 0, w, h); g.fillStyle = bottom; g.fillRect(0, h * 0.62, w, h * 0.38);
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, h * 0.61, w, 6); noise(g, w, h, 1200, 0.05);
    }, [6, 1])
  };
  function textTex(w, h, bg, lines, opts) {
    opts = opts || {};
    return canvasTex(w, h, (g) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      if (opts.frame) { g.strokeStyle = opts.frame; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8); }
      let y = opts.top || 40;
      for (const L of lines) {
        g.fillStyle = L.color || '#eee'; g.font = (L.weight || 'bold') + ' ' + (L.size || 28) + 'px ' + (L.font || "'Barlow Condensed', Impact, sans-serif");
        g.textAlign = L.align || 'left'; g.textBaseline = 'top';
        const x = L.align === 'center' ? w / 2 : L.align === 'right' ? w - 24 : 24;
        g.fillText(L.text, x, y); y += (L.size || 28) * 1.3 + (L.gap || 0);
      }
    });
  }

  // ---------- small builders ----------
  const M = (color, o) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.8 }, o || {}));
  function box(g, w, h, d, mat, x, y, z, ry) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); if (ry) m.rotation.y = ry; m.castShadow = true; m.receiveShadow = true; g.add(m); return m; }
  function cyl(g, rt, rb, h, mat, x, y, z, seg) { const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 16), mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; }
  function sph(g, r, mat, x, y, z, s) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), mat); m.position.set(x, y, z); if (s) m.scale.set(...s); m.castShadow = true; g.add(m); return m; }
  function plane(g, w, h, mat, x, y, z, ry, rx) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(x, y, z); m.rotation.set(rx || 0, ry || 0, 0); m.receiveShadow = true; g.add(m); return m; }

  const MATS = {};
  function mats() {
    if (MATS.steel) return MATS;
    MATS.steel = M(0x9a9ea6, { roughness: 0.35, metalness: 0.8 });
    MATS.black = M(0x15151a, { roughness: 0.9 });
    MATS.dark = M(0x2a2a30, { roughness: 0.85 });
    MATS.leather = M(0x3a2418, { roughness: 0.7 });
    MATS.leatherRed = M(0x8a1c1c, { roughness: 0.6 });
    MATS.leatherBlack = M(0x1a1a1e, { roughness: 0.55 });
    MATS.wood = M(0x8b6a3e, { roughness: 0.75 });
    MATS.white = M(0xe8e8ec, { roughness: 0.6 });
    MATS.gold = M(0xc9a227, { roughness: 0.4, metalness: 0.5 });
    MATS.blue = M(0x2457b3, { roughness: 0.7 });
    MATS.red = M(0xb92f2f, { roughness: 0.7 });
    MATS.rubber = M(0x1e1e22, { roughness: 1 });
    MATS.canvas = M(0xd9d3c4, { roughness: 0.95 });
    MATS.chrome = M(0xd0d4da, { roughness: 0.2, metalness: 0.95 });
    MATS.glass = M(0x9ec5ff, { roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.35 });
    MATS.water = M(0x5aa8d8, { roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.8 });
    MATS.foam = M(0x3b3b42, { roughness: 0.95 });
    return MATS;
  }

  // ---------- the facilities, as furniture. level 0 = nothing (or the cheapest version) ----------
  // Each adds meshes to g and pushes collision circles {x,z,r} onto obs.
  function heavyBags(level, g, obs, tier) {
    const m = mats();
    // extra bags for the heavy bag room (the main bag is built separately, it is the one you hit)
    const n = level >= 4 ? 3 : level >= 2 ? 2 : level >= 1 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const x = 2.1 + i * 1.2, z = -0.6;
      cyl(g, 0.02, 0.02, 1.0, m.steel, x, 2.45, z, 8);
      const bag = cyl(g, 0.16, 0.17, 1.1, i === 1 ? m.leatherRed : m.leatherBlack, x, 1.4, z, 18);
      bag.rotation.z = (i % 2 ? 1 : -1) * 0.03;
      obs.push({ x, z, r: 0.3 });
    }
    // pads, Thai shields, a rack
    if (level >= 1) { box(g, 1.0, 0.06, 0.4, m.wood, 3.2, 0.9, -4.9); for (let i = 0; i < 3; i++) box(g, 0.26, 0.42, 0.08, i ? m.leatherRed : m.leatherBlack, 2.85 + i * 0.32, 1.14, -4.9); }
    if (level >= 3) { box(g, 1.0, 0.06, 0.4, m.wood, 3.2, 1.5, -4.9); for (let i = 0; i < 2; i++) box(g, 0.34, 0.22, 0.1, m.leatherBlack, 2.95 + i * 0.5, 1.66, -4.9); }
    if (level >= 5) { // a wall of gloves
      for (let i = 0; i < 6; i++) sph(g, 0.07, i % 2 ? m.red : m.blue, 4.2 + i * 0.22, 2.1 + (i % 2) * 0.25, -4.92, [1, 1, 0.7]);
    }
  }
  function cardio(level, g, obs) {
    const m = mats();
    const bike = (x, z) => {
      const b = new THREE.Group(); b.position.set(x, 0, z);
      cyl(b, 0.03, 0.03, 0.9, m.steel, 0, 0.45, 0, 8); cyl(b, 0.03, 0.03, 0.5, m.steel, 0.1, 0.25, 0.3, 8).rotation.x = 0.8;
      box(b, 0.6, 0.05, 0.3, m.black, 0, 0.03, 0.1); box(b, 0.26, 0.06, 0.16, m.leatherBlack, 0, 0.92, 0); box(b, 0.4, 0.04, 0.04, m.steel, 0.1, 0.95, 0.45);
      cyl(b, 0.22, 0.22, 0.08, m.dark, 0, 0.3, 0.42, 20).rotation.z = Math.PI / 2; cyl(b, 0.09, 0.09, 0.1, m.steel, 0.1, 0.4, 0.15, 12).rotation.z = Math.PI / 2;
      g.add(b); obs.push({ x, z, r: 0.42 });
    };
    const rope = (x, z) => { const r = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 6, 24), m.black); r.position.set(x, 0.04, z); r.rotation.x = Math.PI / 2; g.add(r); };
    if (level >= 1) { bike(-5.6, 1.6); rope(-4.4, 2.6); }
    if (level >= 2) bike(-5.6, 2.6);
    if (level >= 3) { // treadmill
      box(g, 0.8, 0.14, 1.8, m.black, -4.5, 0.07, 1.6); box(g, 0.6, 0.02, 1.5, m.rubber, -4.5, 0.15, 1.6); box(g, 0.06, 1.1, 0.06, m.steel, -4.78, 0.7, 0.8); box(g, 0.06, 1.1, 0.06, m.steel, -4.22, 0.7, 0.8); box(g, 0.7, 0.22, 0.08, m.dark, -4.5, 1.25, 0.8);
      obs.push({ x: -4.5, z: 1.6, r: 0.75 });
    }
    if (level >= 4) bike(-5.6, 3.6);
    if (level >= 5) { // rowing machine
      box(g, 0.3, 0.1, 2.0, m.steel, -3.5, 0.3, 2.9); cyl(g, 0.3, 0.3, 0.2, m.dark, -3.5, 0.45, 1.95, 20).rotation.z = Math.PI / 2; box(g, 0.3, 0.06, 0.3, m.leatherBlack, -3.5, 0.4, 3.3);
      obs.push({ x: -3.5, z: 2.7, r: 0.7 });
    }
  }
  function strength(level, g, obs) {
    const m = mats();
    const plate = (x, y, z, r, mat, rot) => { const p = cyl(g, r, r, 0.035, mat, x, y, z, 24); p.rotation.z = Math.PI / 2; if (rot) p.rotation.set(0, 0, 0); return p; };
    if (level >= 1) { // squat rack + barbell
      for (const dx of [-0.6, 0.6]) { box(g, 0.08, 2.0, 0.08, m.steel, -5.4 + dx, 1.0, -0.6); box(g, 0.08, 0.08, 0.9, m.steel, -5.4 + dx, 0.04, -0.6); }
      box(g, 1.3, 0.04, 0.04, m.steel, -5.4, 1.45, -0.6); box(g, 0.8, 0.5, 0.4, m.black, -5.4, 0.25, -0.6);
      const bar = cyl(g, 0.016, 0.016, 2.0, m.chrome, -5.4, 1.5, -0.6, 10); bar.rotation.z = Math.PI / 2;
      plate(-6.2, 1.5, -0.6, 0.22, m.black); plate(-4.6, 1.5, -0.6, 0.22, m.black);
      obs.push({ x: -5.4, z: -0.6, r: 0.9 });
    }
    if (level >= 2) { // plate tree
      cyl(g, 0.04, 0.04, 1.2, m.steel, -6.6, 0.6, -2.0, 8);
      for (let i = 0; i < 3; i++) { const p = cyl(g, 0.2 - i * 0.03, 0.2 - i * 0.03, 0.04, i ? m.black : m.red, -6.6, 0.45 + i * 0.3, -1.85 + i * 0.03, 24); p.rotation.x = Math.PI / 2; }
      obs.push({ x: -6.6, z: -2.0, r: 0.35 });
    }
    if (level >= 3) { // sled with plates
      box(g, 0.7, 0.08, 1.0, m.steel, -3.6, 0.06, -0.9); cyl(g, 0.03, 0.03, 0.9, m.steel, -3.6, 0.5, -0.9, 8); for (let i = 0; i < 2; i++) { const p = cyl(g, 0.2, 0.2, 0.04, m.black, -3.6, 0.12 + i * 0.045, -0.9, 24); }
      obs.push({ x: -3.6, z: -0.9, r: 0.6 });
    }
    if (level >= 4) { // bench press
      box(g, 0.3, 0.08, 1.2, m.leatherBlack, -3.6, 0.45, -2.6); box(g, 0.06, 0.4, 0.06, m.steel, -3.6, 0.2, -2.2); box(g, 0.06, 0.4, 0.06, m.steel, -3.6, 0.2, -3.0);
      for (const dx of [-0.5, 0.5]) box(g, 0.06, 1.1, 0.06, m.steel, -3.6 + dx, 0.55, -3.1);
      const bar = cyl(g, 0.016, 0.016, 1.8, m.chrome, -3.6, 1.1, -3.1, 10); bar.rotation.z = Math.PI / 2;
      obs.push({ x: -3.6, z: -2.6, r: 0.7 });
    }
    if (level >= 5) { // dumbbell rack
      box(g, 1.6, 0.05, 0.4, m.steel, -5.8, 0.4, -3.3); box(g, 1.6, 0.05, 0.4, m.steel, -5.8, 0.8, -3.3);
      for (let i = 0; i < 5; i++) for (const y of [0.47, 0.87]) { const d = cyl(g, 0.05 + i * 0.008, 0.05 + i * 0.008, 0.28, m.chrome, -6.4 + i * 0.3, y, -3.3, 10); d.rotation.z = Math.PI / 2; }
      obs.push({ x: -5.8, z: -3.3, r: 0.6 });
    }
  }
  function boxingRing(level, g, obs) {
    const m = mats();
    if (level >= 1) { // speed bag platform
      box(g, 0.9, 0.06, 0.9, m.wood, 4.6, 1.9, -4.5); cyl(g, 0.03, 0.03, 0.5, m.steel, 4.6, 2.2, -4.5, 8); box(g, 0.1, 0.8, 0.1, m.steel, 4.6, 2.05, -4.95);
      const sb = sph(g, 0.1, m.leatherRed, 4.6, 1.7, -4.5, [1, 1.35, 1]); cyl(g, 0.02, 0.02, 0.18, m.leatherRed, 4.6, 1.85, -4.5, 8);
      g.userData.speedBag = sb; obs.push({ x: 4.6, z: -4.5, r: 0.45 });
    }
    if (level >= 2) { // double-end bag
      sph(g, 0.09, m.leatherBlack, 5.8, 1.45, -3.9); cyl(g, 0.008, 0.008, 1.4, m.black, 5.8, 2.2, -3.9, 6); cyl(g, 0.008, 0.008, 1.3, m.black, 5.8, 0.72, -3.9, 6);
      obs.push({ x: 5.8, z: -3.9, r: 0.3 });
    }
    if (level >= 3) { // a real ring (raised platform, posts, ropes)
      const cx = 3.9, cz = -2.6, S = 1.55;
      box(g, S * 2 + 0.5, 0.35, S * 2 + 0.5, m.dark, cx, 0.175, cz);
      plane(g, S * 2 + 0.3, S * 2 + 0.3, m.canvas, cx, 0.36, cz, 0, -Math.PI / 2);
      const ropeMat = [m.red, m.white, m.blue];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { cyl(g, 0.05, 0.05, 1.5, m.steel, cx + sx * S, 1.05, cz + sz * S, 10); cyl(g, 0.09, 0.09, 0.9, sx * sz > 0 ? m.red : m.blue, cx + sx * S, 1.15, cz + sz * S, 10); }
      for (let r = 0; r < 3; r++) {
        const y = 0.75 + r * 0.32;
        box(g, S * 2, 0.03, 0.03, ropeMat[r], cx, y, cz - S); box(g, S * 2, 0.03, 0.03, ropeMat[r], cx, y, cz + S);
        box(g, 0.03, 0.03, S * 2, ropeMat[r], cx - S, y, cz); box(g, 0.03, 0.03, S * 2, ropeMat[r], cx + S, y, cz);
      }
      obs.push({ x: cx, z: cz, r: S + 0.35 });
    }
    if (level >= 4) { for (let i = 0; i < 2; i++) { box(g, 0.3, 0.3, 0.1, m.leatherRed, 6.6, 1.0 + i * 0.4, -3.2 + i * 0.5); } }
    if (level >= 5) { // bell on a post + a second speed bag
      box(g, 0.9, 0.06, 0.9, m.wood, 6.4, 1.9, -4.5); const sb = sph(g, 0.1, m.leatherBlack, 6.4, 1.7, -4.5, [1, 1.35, 1]); cyl(g, 0.02, 0.02, 0.18, m.leatherBlack, 6.4, 1.85, -4.5, 8);
      obs.push({ x: 6.4, z: -4.5, r: 0.45 });
    }
  }
  function matRoom(level, g, obs) {
    const m = mats();
    if (level < 1) return;
    const size = 2.4 + Math.min(level, 4) * 0.5;
    const matMat = M(0xffffff, { map: FLOORS.mat(level >= 3 ? '#2b4f9e' : '#355a9c'), roughness: 0.95 });
    const mt = plane(g, size, size * 0.85, matMat, -1.4, 0.015, 3.4, 0, -Math.PI / 2);
    if (level >= 2) { // grappling dummy slumped on the mat
      const d = new THREE.Group(); d.position.set(-2.4, 0, 2.8); d.rotation.y = 0.6;
      cyl(d, 0.14, 0.17, 0.6, m.leatherRed, 0, 0.32, 0, 14); sph(d, 0.12, m.leatherRed, 0, 0.72, 0.02); cyl(d, 0.06, 0.05, 0.5, m.leatherRed, -0.2, 0.45, 0.2, 10).rotation.z = 0.5; cyl(d, 0.06, 0.05, 0.5, m.leatherRed, 0.2, 0.45, 0.2, 10).rotation.z = -0.5;
      g.add(d); obs.push({ x: -2.4, z: 2.8, r: 0.38 });
    }
    if (level >= 3) { // wall pads along the front wall by the mats
      for (let i = 0; i < 4; i++) box(g, 0.95, 1.4, 0.08, i % 2 ? m.blue : m.foam, -3.0 + i * 1.0, 0.75, 5.44);
    }
    if (level >= 4) { for (let i = 0; i < 3; i++) box(g, 0.5, 0.06, 0.3, m.white, -3.4, 0.03 + i * 0.07, 4.9); }   // folded gi / towels
    if (level >= 5) { // three gold belts on the front wall
      for (let i = 0; i < 3; i++) box(g, 0.5, 0.14, 0.06, m.gold, -5.6 + i * 0.6, 1.9, 5.44);
    }
  }
  function wrestling(level, g, obs) {
    const m = mats();
    if (level < 1) return;
    // a cage wall section to drill against, by the front-right of the room
    const panelMat = M(0xcfd3da, { wireframe: true, roughness: 0.5, metalness: 0.6 });
    const n = Math.min(level, 3);
    for (let i = 0; i < n; i++) {
      const x = 1.0 + i * 1.3, z = 5.3;
      cyl(g, 0.05, 0.05, 1.9, m.black, x - 0.65, 0.95, z, 8); if (i === n - 1) cyl(g, 0.05, 0.05, 1.9, m.black, x + 0.65, 0.95, z, 8);
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.7, 8, 10), panelMat); p.position.set(x, 1.0, z); g.add(p);
      box(g, 1.3, 0.12, 0.1, m.foam, x, 1.9, z);
    }
    for (let i = 0; i < n; i++) obs.push({ x: 1.0 + i * 1.3, z: 5.3, r: 0.5 });
    if (level >= 2) { // standing dummy
      const d = new THREE.Group(); d.position.set(1.2, 0, 4.3);
      cyl(d, 0.3, 0.3, 0.08, m.black, 0, 0.04, 0, 16); cyl(d, 0.05, 0.05, 0.6, m.steel, 0, 0.35, 0, 8); cyl(d, 0.16, 0.19, 0.7, m.leatherBlack, 0, 1.0, 0, 14); sph(d, 0.12, m.leatherBlack, 0, 1.48, 0);
      g.add(d); obs.push({ x: 1.2, z: 4.3, r: 0.35 });
    }
    if (level >= 4) { const d = new THREE.Group(); d.position.set(2.4, 0, 4.3); cyl(d, 0.3, 0.3, 0.08, m.black, 0, 0.04, 0, 16); cyl(d, 0.05, 0.05, 0.6, m.steel, 0, 0.35, 0, 8); cyl(d, 0.16, 0.19, 0.7, m.leatherRed, 0, 1.0, 0, 14); sph(d, 0.12, m.leatherRed, 0, 1.48, 0); g.add(d); obs.push({ x: 2.4, z: 4.3, r: 0.35 }); }
    if (level >= 5) { box(g, 1.4, 0.5, 0.06, m.gold, 2.3, 2.7, 5.44); }
  }
  function recovery(level, g, obs) {
    const m = mats();
    if (level < 1) return;
    // ice bath
    box(g, 1.3, 0.7, 0.8, m.white, 5.6, 0.35, 0.9); plane(g, 1.1, 0.6, m.water, 5.6, 0.66, 0.9, 0, -Math.PI / 2);
    for (let i = 0; i < 5; i++) sph(g, 0.05 + Math.random() * 0.04, m.glass, 5.2 + Math.random() * 0.8, 0.68, 0.7 + Math.random() * 0.4);
    obs.push({ x: 5.6, z: 0.9, r: 0.85 });
    if (level >= 2) { box(g, 0.6, 0.7, 0.5, m.white, 6.9, 0.35, 0.4); box(g, 0.5, 0.05, 0.4, m.steel, 6.9, 0.72, 0.4); obs.push({ x: 6.9, z: 0.4, r: 0.45 }); } // fridge / towels
    if (level >= 3) { // massage table
      box(g, 0.7, 0.08, 1.9, m.leatherBlack, 5.8, 0.72, -0.4 - 0.1); for (const dz of [-0.8, 0.8]) for (const dx of [-0.25, 0.25]) box(g, 0.05, 0.7, 0.05, m.steel, 5.8 + dx, 0.35, -0.5 + dz);
      obs.push({ x: 5.8, z: -0.5, r: 0.95 });
    }
    if (level >= 4) { box(g, 0.9, 0.45, 0.4, m.dark, 6.9, 1.6, 0.4); box(g, 0.7, 0.25, 0.02, M(0x1fa3ff, { emissive: 0x1fa3ff, emissiveIntensity: 0.8 }), 6.9, 1.6, 0.61); } // light therapy panel
    if (level >= 5) { // sauna cabin in the corner
      box(g, 1.4, 2.2, 1.2, m.wood, 6.7, 1.1, 2.4); box(g, 0.5, 1.3, 0.04, m.glass, 6.0, 1.0, 2.4); obs.push({ x: 6.7, z: 2.4, r: 1.0 });
    }
  }

  // ---------- the gym ----------
  class Gym {
    constructor(renderer, audio) {
      this.R = renderer; this.scene = renderer.scene; this.audio = audio;
      this.active = false; this.paused = false;
      this.group = null; this.player = null; this.coach = null; this.obstacles = [];
      this.sig = null; this.C = null; this.controls = null;
      this.cam = { yaw: Math.PI, pos: new THREE.Vector3(), tgt: new THREE.Vector3(), side: new THREE.Vector3(0, 0, 1), fight: false, init: false };
      this.sim = null;      // the training Sim: you (fighter 0) and the heavy bag (fighter 1)
      this.bagSquash = 0;
      this.session = { hits: 0, combo: 0, bestCombo: 0, hardest: 0, last: '', lastT: -9, comboT: 0 };
      this.prompt = ''; this.station = null; this.fx = []; this.locked = false;
      this.time = 0;
      this.moveset = null;
      this._saved = null;
    }

    // ---- lifecycle ----
    enter(C, moveset) {
      this.C = C; this.moveset = moveset || DEFAULT_MOVESET;
      if (!this.active) {
        this.active = true;
        this._saved = { fog: this.scene.fog, bg: this.scene.background, fov: this.R.camera.fov };
        this.scene.fog = null; this.R.camera.fov = ROOM_FOV; this.R.camera.updateProjectionMatrix();
        if (this.R.setArenaVisible) this.R.setArenaVisible(false);
        // mirrors the sim's fighter 0 each frame (stations, lock-on and the camera read it)
        this.player = { x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw, act: { type: 'idle', t: 0 }, blocking: false, stam: 100 };
        this.model = new FighterModel(this.scene, C.color, C.skin, 0);
        this.cam.init = false; this.locked = false;
        this.session = { hits: 0, combo: 0, bestCombo: 0, hardest: 0, last: '', lastT: -9, comboT: 0 };
      }
      this.refresh(C);
      this.paused = false;
    }
    leave() {
      if (!this.active) return;
      this.active = false; this.paused = false;
      if (this.group) { this.scene.remove(this.group); this.group = null; }
      if (this.sim) { this.sim.destroy(); this.sim = null; }
      if (this.model) { this.model.dispose(); this.model = null; }
      if (this.coach) { this.coach.dispose(); this.coach = null; }
      for (const e of this.fx) this.scene.remove(e.m);
      this.fx = [];
      this.sig = null;
      if (this._saved) { this.scene.fog = this._saved.fog; this.scene.background = this._saved.bg; this.R.camera.fov = this._saved.fov; this.R.camera.updateProjectionMatrix(); }
      if (this.R.setArenaVisible) this.R.setArenaVisible(true);
    }
    // rebuild if the gym changed (an upgrade), always redraw the screens (offers, plan, record)
    refresh(C) {
      this.C = C;
      const sig = Career.FACILITIES.map(f => C.gym[f.id] || 0).join(',') + '|' + C.color;
      if (sig !== this.sig) { this.sig = sig; this.build(C); if (this.sim) this.sim.phys.setObstacles(this._physObstacles()); }
      if (this.sim) { // training changes your stats, the options panel your moveset
        const f = this.sim.state.f[0];
        for (const k in f.stats) if (typeof C.stats[k] === 'number') f.stats[k] = clamp(C.stats[k], 0, 1);
        f.moveset = root.MMASim.normalizeMoveset(this.moveset);
      }
      this.model.setColors(C.color, C.skin);
      this.redrawScreens(C);
    }

    totalLevel(C) { return Career.FACILITIES.reduce((a, f) => a + (C.gym[f.id] || 0), 0); }
    tierOf(C) { const t = this.totalLevel(C); return t <= 2 ? 0 : t <= 9 ? 1 : t <= 23 ? 2 : 3; }
    tierName(C) { return ['Garage', 'Neighbourhood gym', 'Fight gym', 'Elite facility'][this.tierOf(C)]; }

    // ---- build the room from the save ----
    build(C) {
      if (this.group) this.scene.remove(this.group);
      if (this.coach) { this.coach.dispose(); this.coach = null; }
      const m = mats();
      const g = new THREE.Group(); this.group = g; this.obstacles = [];
      const obs = this.obstacles;
      const tier = this.tierOf(C);
      const W = ROOM.hw, D = ROOM.hd, H = ROOM.h;

      // -- shell
      const floorMat = M(0xffffff, { map: tier === 0 ? FLOORS.concrete() : tier === 1 ? FLOORS.rubber() : FLOORS.pro(), roughness: tier >= 3 ? 0.5 : 0.95, metalness: tier >= 3 ? 0.1 : 0 });
      plane(g, W * 2, D * 2, floorMat, 0, 0, 0, 0, -Math.PI / 2);
      const wallMat = M(0xffffff, { map: tier === 0 ? WALLS.block() : tier === 1 ? WALLS.painted('#d9cfb8', '#7a2323') : tier === 2 ? WALLS.painted('#2a2a30', '#8f1f1f') : WALLS.painted('#17171c', '#1f1f26'), roughness: 0.9 });
      const wall = (w, x, z, ry) => { const p = plane(g, w, H, wallMat, x, H / 2, z, ry); p.receiveShadow = true; return p; };
      wall(W * 2, 0, -D, 0); wall(W * 2, 0, D, Math.PI); wall(D * 2, -W, 0, Math.PI / 2); wall(D * 2, W, 0, -Math.PI / 2);
      const ceil = plane(g, W * 2, D * 2, M(tier === 0 ? 0x3a3a3e : 0x26262c, { roughness: 1 }), 0, H, 0, 0, Math.PI / 2);
      // skirting
      for (const [w, x, z, ry] of [[W * 2, 0, -D + 0.03, 0], [W * 2, 0, D - 0.03, 0], [D * 2, -W + 0.03, 0, Math.PI / 2], [D * 2, W - 0.03, 0, Math.PI / 2]]) box(g, w, 0.12, 0.05, m.black, x, 0.06, z, ry);
      // the roll-up door on the front wall (garage) / a glass door later
      if (tier === 0) { plane(g, 2.6, 2.4, M(0x8d8d92, { roughness: 0.6, metalness: 0.4 }), 4.5, 1.2, D - 0.02, Math.PI); for (let i = 0; i < 8; i++) box(g, 2.6, 0.02, 0.02, m.black, 4.5, 0.3 * i + 0.15, D - 0.03); }
      else { plane(g, 1.2, 2.3, m.glass, 4.5, 1.15, D - 0.02, Math.PI); box(g, 0.05, 2.3, 0.08, m.black, 3.9, 1.15, D - 0.02); box(g, 0.05, 2.3, 0.08, m.black, 5.1, 1.15, D - 0.02); box(g, 1.3, 0.05, 0.08, m.black, 4.5, 2.3, D - 0.02); }
      // a window on the left wall
      plane(g, 1.6, 1.0, M(0x8fb6e6, { emissive: 0x6d8fbf, emissiveIntensity: tier === 0 ? 0.6 : 0.25, roughness: 0.2 }), -W + 0.02, 2.4, 2.5, Math.PI / 2);
      box(g, 0.06, 1.1, 1.7, m.black, -W + 0.03, 2.4, 2.5);

      // -- lighting (in the group so it goes away with the room)
      const hemi = new THREE.HemisphereLight(tier === 0 ? 0x6a6a70 : 0x9aa0b0, 0x2a2420, tier === 0 ? 0.55 : 0.8 + tier * 0.1); g.add(hemi);
      const sun = new THREE.DirectionalLight(tier === 0 ? 0xffd9a0 : 0xffffff, tier === 0 ? 0.55 : 0.75 + tier * 0.05);
      sun.position.set(3, 7, 2); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -9; sun.shadow.camera.right = 9; sun.shadow.camera.top = 7; sun.shadow.camera.bottom = -7; sun.shadow.camera.near = 1; sun.shadow.camera.far = 20; sun.shadow.bias = -0.0006;
      sun.target.position.set(0, 0, 0); g.add(sun); g.add(sun.target);
      if (tier === 0) { // one hanging bulb over the bag
        cyl(g, 0.01, 0.01, 0.8, m.black, BAG.x + 1.2, H - 0.4, BAG.z + 0.3, 6); const b = sph(g, 0.07, M(0xfff1c0, { emissive: 0xffd080, emissiveIntensity: 2 }), BAG.x + 1.2, H - 0.82, BAG.z + 0.3); b.castShadow = false;
        const pl = new THREE.PointLight(0xffd090, 0.9, 10, 2); pl.position.set(BAG.x + 1.2, H - 0.9, BAG.z + 0.3); g.add(pl);
      } else {
        // tube / LED fixtures in rows
        const rows = tier === 1 ? [[-3.5, -2.5], [-3.5, 2.5], [3.5, -2.5], [3.5, 2.5]] : [[-4.5, -3], [-4.5, 0], [-4.5, 3], [0, -3], [0, 0], [0, 3], [4.5, -3], [4.5, 0], [4.5, 3]];
        const lm = M(0xffffff, { emissive: tier === 1 ? 0xf0f4ff : 0xffffff, emissiveIntensity: 1.6 });
        for (const [x, z] of rows) { const f = box(g, tier === 1 ? 1.3 : 1.1, 0.06, tier === 1 ? 0.14 : 0.5, lm, x, H - 0.05, z); f.castShadow = false; }
        for (const [x, z] of [[-3.5, 0], [3.5, 0]]) { const pl = new THREE.PointLight(0xfff4e0, tier === 1 ? 0.45 : 0.6, 14, 2); pl.position.set(x, H - 0.4, z); g.add(pl); }
        if (tier >= 2) { const red = new THREE.PointLight(0xff3a2a, 0.35, 10, 2); red.position.set(-6, 2.6, -4.5); g.add(red); }
        if (tier >= 3) { const blue = new THREE.PointLight(0x2a7bff, 0.5, 12, 2); blue.position.set(6, 2.6, -4.5); g.add(blue); }
      }
      // -- banners / name on the back wall (tier 2+), a cheap poster earlier
      const name = (C.name || 'YOU').toUpperCase();
      if (tier >= 2) {
        const bannerTex = textTex(1024, 256, tier >= 3 ? '#0f0f14' : '#8f1f1f', [{ text: name + ' MMA', size: 150, align: 'center', color: tier >= 3 ? '#e0b23a' : '#fff' }], { top: 50, frame: tier >= 3 ? '#e0b23a' : null });
        const banner = plane(g, 5.0, 1.25, M(0xffffff, { map: bannerTex, roughness: 0.8, emissive: tier >= 3 ? 0x222222 : 0 }), 1.2, 2.9, -D + 0.03, 0);
        banner.receiveShadow = false;
      } else {
        const poster = textTex(256, 384, '#e9e2cf', [{ text: 'FIGHT', size: 64, align: 'center', color: '#8f1f1f' }, { text: 'NIGHT', size: 64, align: 'center', color: '#222' }, { text: 'LOCAL SHOW', size: 24, align: 'center', color: '#444', weight: 'normal' }], { top: 60 });
        plane(g, 0.6, 0.9, M(0xffffff, { map: poster, roughness: 0.95 }), 2.2, 2.1, -D + 0.02, 0);
      }
      if (tier >= 3) { // trophy case
        box(g, 1.6, 1.8, 0.4, m.black, -0.6, 0.9, D - 0.25); plane(g, 1.5, 1.6, m.glass, -0.6, 0.95, D - 0.44, Math.PI);
        for (let i = 0; i < 3; i++) { cyl(g, 0.06, 0.08, 0.3, m.gold, -1.1 + i * 0.5, 0.55, D - 0.25, 12); sph(g, 0.08, m.gold, -1.1 + i * 0.5, 0.78, D - 0.25); }
        for (let i = 0; i < 2; i++) box(g, 0.5, 0.14, 0.05, m.gold, -0.85 + i * 0.5, 1.4, D - 0.25);
        obs.push({ x: -0.6, z: D - 0.3, r: 0.9 });
      }

      // -- the main heavy bag (always there: a taped-up old bag in the garage, a proper one later)
      const bagGrp = new THREE.Group(); bagGrp.position.set(BAG.x, BAG.pivot, BAG.z); g.add(bagGrp);
      const beam = box(g, 2.4, 0.16, 0.16, m.steel, BAG.x, BAG.pivot + 0.15, BAG.z);
      const chainL = BAG.pivot - BAG.top;
      for (let i = 0; i < 2; i++) { const c = cyl(bagGrp, 0.012, 0.012, chainL, m.chrome, 0, -chainL / 2, 0, 6); c.position.x = i ? 0.06 : -0.06; }
      const bagLen = BAG.top - BAG.bot, bagMid = -(BAG.pivot - (BAG.top + BAG.bot) / 2);
      const pow = C.gym.pow || 0;
      const bagMat = pow >= 3 ? m.leatherRed : pow >= 1 ? m.leatherBlack : m.leather;
      const bag = cyl(bagGrp, BAG.r, BAG.r * 1.04, bagLen, bagMat, 0, bagMid, 0, 24);
      cyl(bagGrp, BAG.r * 1.02, BAG.r * 1.02, 0.06, m.black, 0, bagMid + bagLen / 2 - 0.05, 0, 24); cyl(bagGrp, BAG.r * 1.05, BAG.r * 1.05, 0.06, m.black, 0, bagMid - bagLen / 2 + 0.05, 0, 24);
      if (pow < 1) for (let i = 0; i < 3; i++) { const t = cyl(bagGrp, BAG.r * 1.03, BAG.r * 1.03, 0.07, M(0x9a9a9a, { roughness: 1 }), 0, bagMid - 0.35 + i * 0.3, 0, 24); } // duct tape
      sph(bagGrp, 0.05, m.chrome, 0, 0, 0); // swivel
      this.bagGroup = bagGrp; this.bagMesh = bag;
      obs.push({ x: BAG.x, z: BAG.z, r: BAG.r + 0.12, bag: true }); // the bag is its own physics body (see _ensureSim)
      this.bagSquash = 0;

      // -- stations
      // computer: desk, monitor, chair (a folding table + an old monitor in the garage; a proper office corner later)
      const cs = STATIONS[0];
      box(g, 1.5, 0.05, 0.7, tier === 0 ? m.wood : m.dark, cs.x, 0.74, cs.z - 0.6); for (const dx of [-0.65, 0.65]) box(g, 0.05, 0.72, 0.05, m.steel, cs.x + dx, 0.36, cs.z - 0.6);
      const scr = box(g, tier === 0 ? 0.42 : 0.6, tier === 0 ? 0.36 : 0.36, 0.03, m.black, cs.x, 1.0, cs.z - 0.75);
      if (tier === 0) { box(g, 0.4, 0.36, 0.34, M(0xd8d2c0, { roughness: 0.9 }), cs.x, 1.0, cs.z - 0.95); } else { box(g, 0.14, 0.14, 0.02, m.steel, cs.x, 0.84, cs.z - 0.78); }
      this.screenMat = M(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.4 });
      this.screen = plane(g, tier === 0 ? 0.38 : 0.56, 0.32, this.screenMat, cs.x, 1.0, cs.z - 0.73, 0);
      box(g, 0.3, 0.02, 0.12, m.dark, cs.x + 0.05, 0.77, cs.z - 0.45); // keyboard
      const chair = new THREE.Group(); chair.position.set(cs.x, 0, cs.z - 0.05); cyl(chair, 0.2, 0.2, 0.05, m.black, 0, 0.45, 0, 14); cyl(chair, 0.03, 0.03, 0.4, m.steel, 0, 0.25, 0, 8); box(chair, 0.4, 0.4, 0.05, m.black, 0, 0.7, 0.2); g.add(chair);
      const lamp = new THREE.PointLight(0x9fc4ff, 0.35, 4, 2); lamp.position.set(cs.x, 1.3, cs.z - 0.5); g.add(lamp);
      obs.push({ x: cs.x, z: cs.z - 0.6, r: 0.8 });
      // whiteboard on the back wall
      const bs = STATIONS[1];
      box(g, 1.9, 1.2, 0.05, m.white, bs.x, 1.75, -D + 0.05); box(g, 1.95, 1.25, 0.03, m.steel, bs.x, 1.75, -D + 0.03);
      this.boardMat = M(0xffffff, { roughness: 0.6 }); this.board = plane(g, 1.84, 1.14, this.boardMat, bs.x, 1.75, -D + 0.08, 0);
      box(g, 1.0, 0.04, 0.06, m.steel, bs.x, 1.12, -D + 0.08); for (let i = 0; i < 3; i++) cyl(g, 0.012, 0.012, 0.12, [m.red, m.blue, m.black][i], bs.x - 0.3 + i * 0.15, 1.16, -D + 0.09, 6).rotation.z = Math.PI / 2;
      // front desk: counter with a phone and a catalogue (upgrades)
      const ds = STATIONS[2];
      box(g, 1.6, 1.0, 0.6, tier >= 2 ? m.black : m.wood, ds.x, 0.5, ds.z + 0.75); box(g, 1.7, 0.05, 0.7, tier >= 2 ? m.gold : m.dark, ds.x, 1.02, ds.z + 0.75);
      box(g, 0.18, 0.05, 0.22, m.black, ds.x - 0.4, 1.07, ds.z + 0.7); cyl(g, 0.02, 0.02, 0.2, m.black, ds.x - 0.4, 1.12, ds.z + 0.7, 6).rotation.z = Math.PI / 2;
      box(g, 0.3, 0.03, 0.42, M(0xd7b55a, { roughness: 0.9 }), ds.x + 0.25, 1.06, ds.z + 0.75); // the catalogue
      const sign = textTex(512, 128, tier >= 2 ? '#0f0f14' : '#f1e9d2', [{ text: 'FRONT DESK', size: 72, align: 'center', color: tier >= 2 ? '#e0b23a' : '#333' }], { top: 24 });
      plane(g, 1.0, 0.25, M(0xffffff, { map: sign }), ds.x, 0.75, ds.z + 0.44, Math.PI);
      if (tier >= 1) { const cash = box(g, 0.3, 0.2, 0.3, m.dark, ds.x + 0.6, 1.14, ds.z + 0.75); }
      obs.push({ x: ds.x, z: ds.z + 0.75, r: 0.9 });
      // wall of fame on the right wall: frames (one per fight, up to 12) + a record board
      const fs = STATIONS[3];
      this.fameMat = M(0xffffff, { roughness: 0.6 }); this.fame = plane(g, 1.4, 0.9, this.fameMat, W - 0.06, 1.9, fs.z, -Math.PI / 2);
      box(g, 0.04, 0.96, 1.46, m.gold, W - 0.04, 1.9, fs.z);
      this.frames = [];
      for (let i = 0; i < 12; i++) {
        const row = Math.floor(i / 6), col = i % 6;
        const z = fs.z - 1.25 + col * 0.5, y = 1.05 + row * 0.42;
        const f = box(g, 0.03, 0.34, 0.42, m.black, W - 0.05, y, z); const inner = plane(g, 0.36, 0.28, M(0x444448, { roughness: 0.9 }), W - 0.065, y, z, -Math.PI / 2);
        f.visible = inner.visible = false; this.frames.push({ f, inner });
      }

      // -- facilities
      heavyBags(C.gym.pow || 0, g, obs, tier);
      cardio(C.gym.car || 0, g, obs);
      strength(C.gym.chin || 0, g, obs);
      boxingRing(C.gym.spd || 0, g, obs);
      matRoom(C.gym.bjj || 0, g, obs);
      wrestling(C.gym.wre || 0, g, obs);
      recovery(C.gym.recovery || 0, g, obs);
      // the head coach stands by the ring in the idle pose; dark kit from level 4
      if ((C.gym.coach || 0) >= 1) {
        this.coach = new FighterModel(this.scene, (C.gym.coach >= 4) ? 0x15151a : 0x2c3e50, 0x8d5a3b, 1);
        this.coachState = { x: 3.4, z: -0.9 + 0.0, act: { type: 'idle', t: 0 }, dmg: { head: 0, body: 0, legs: 0 }, rocked: 0, ground: null, blocking: false, stam: 100, idx: 1 };
        obs.push({ x: 3.4, z: -0.9, r: 0.4 });
      }
      this.scene.add(g);
      this.scene.background = new THREE.Color(tier === 0 ? 0x2a2a2e : 0x101014);
      this._shadowFix();
    }
    _shadowFix() { this.group.traverse(o => { if (o.isMesh && o.material && o.material.transparent) o.castShadow = false; }); }

    // the screens that show the save: monitor (offers / the booked fight), whiteboard (the camp), wall of fame (the record)
    redrawScreens(C) {
      const money = Career.fmtMoney;
      const lines = [];
      const B = C.booked;
      if (B) {
        lines.push({ text: 'BOOKED', size: 40, color: '#e0b23a' });
        lines.push({ text: 'vs ' + B.offer.opp.name, size: 62 });
        lines.push({ text: B.weeksLeft > 0 ? B.weeksLeft + ' week' + (B.weeksLeft === 1 ? '' : 's') + ' out' : 'FIGHT WEEK', size: 62, color: B.weeksLeft > 0 ? '#fff' : '#ff6b6b' });
        lines.push({ text: B.offer.orgName, size: 36, color: '#9a9aa8', weight: 'normal' });
      } else {
        lines.push({ text: 'INBOX', size: 40, color: '#e0b23a' });
        lines.push({ text: C.offers.length + ' fight offer' + (C.offers.length === 1 ? '' : 's'), size: 70 });
        for (const o of C.offers.slice(0, 2)) lines.push({ text: o.orgName + ' · ' + money(o.purse), size: 34, color: '#cfd3da', weight: 'normal' });
      }
      lines.push({ text: money(C.money) + ' in the bank', size: 34, color: '#52d273', weight: 'normal', gap: 6 });
      if (this.screenMat.map) this.screenMat.map.dispose();
      this.screenMat.map = textTex(512, 300, '#0d1b2a', lines, { top: 20 }); this.screenMat.needsUpdate = true;
      // whiteboard
      const wl = [{ text: Career.weekLabel(C.week).toUpperCase(), size: 60, color: '#1a3d8f' }];
      if (B) {
        wl.push({ text: 'CAMP: ' + B.offer.opp.name.toUpperCase(), size: 56, color: '#b3261e' });
        wl.push({ text: B.weeksLeft > 0 ? B.weeksLeft + ' WEEKS OUT' : 'FIGHT WEEK', size: 56, color: '#b3261e' });
        wl.push({ text: 'so far: ' + (B.plan.length ? B.plan.map(p => p === 'rest' ? 'rest' : Career.STAT_BY_KEY[p].short).join(' → ') : '—'), size: 40, color: '#222', weight: 'normal' });
      } else { wl.push({ text: 'NO FIGHT BOOKED', size: 56, color: '#b3261e' }); wl.push({ text: 'train, or take an offer', size: 40, color: '#222', weight: 'normal' }); }
      wl.push({ text: 'rating ' + Career.rating(C.stats), size: 40, color: '#222', weight: 'normal', gap: 4 });
      const inj = Career.injuryTotal(C);
      wl.push({ text: inj > 0 ? 'banged up: ' + Math.round(inj) : 'healthy', size: 40, color: inj > 30 ? '#b3261e' : '#2e7d32', weight: 'normal' });
      if (this.boardMat.map) this.boardMat.map.dispose();
      this.boardMat.map = textTex(768, 480, '#f4f4f2', wl, { top: 28 }); this.boardMat.needsUpdate = true;
      // wall of fame
      const r = C.record;
      const fl = [{ text: (C.name || 'YOU').toUpperCase() + (C.nick ? ' "' + C.nick.toUpperCase() + '"' : ''), size: 54, color: '#e0b23a', align: 'center' },
        { text: r.w + ' – ' + r.l + (r.d ? ' – ' + r.d : ''), size: 90, align: 'center' },
        { text: r.ko + ' (T)KO · ' + r.sub + ' SUB · ' + r.dec + ' DEC', size: 30, color: '#9a9aa8', align: 'center', weight: 'normal' },
        { text: (C.champion ? Career.TOP.name + ' CHAMPION' : Career.popLabel(C.pop).toUpperCase()) + ' · POP ' + Math.round(C.pop), size: 30, color: '#fff', align: 'center' }];
      if (this.fameMat.map) this.fameMat.map.dispose();
      this.fameMat.map = textTex(768, 480, '#141418', fl, { top: 40, frame: '#e0b23a' }); this.fameMat.needsUpdate = true;
      const n = Math.min(12, C.history.length);
      for (let i = 0; i < 12; i++) {
        const fr = this.frames[i]; fr.f.visible = fr.inner.visible = i < n;
        if (i < n) { const h = C.history[C.history.length - 1 - i]; fr.inner.material.color.setHex(h.draw ? 0x555560 : h.won ? 0x2e7d32 : 0x7a1f1f); fr.f.material = h.title ? mats().gold : mats().black; }
      }
    }

    // ---- per frame ----
    canLock() { const P = this.player; return !!P && Math.hypot(BAG.x - P.x, BAG.z - P.z) < LOCK_RANGE; }
    toggleLock() {
      if (this.locked) { this.locked = false; return; }
      if (this.canLock()) this.locked = true;
    }

    // the furniture as physics obstacles (the bag hangs in the world as its own body)
    _physObstacles() { return this.obstacles.filter(o => !o.bag); }
    // the training Sim, built once the physics engine has loaded (it streams in after the page)
    _ensureSim() {
      if (this.sim || !this.C || !root.MMAPhys || !root.MMAPhys.ready()) return this.sim;
      const C = this.C, P = this.player;
      this.sim = new Sim({
        training: true, grappling: false, seed: (Math.random() * 1e9) | 0, spawn: { x: P.x, z: P.z },
        players: [{ fighter: C.base, name: C.name, stats: C.stats, color: C.color, skin: C.skin, moveset: this.moveset }, { name: 'Heavy bag' }],
        world: { room: { hw: ROOM.hw, hd: ROOM.hd }, bag: { x: BAG.x, z: BAG.z, r: BAG.r, top: BAG.top, bot: BAG.bot, pivot: BAG.pivot }, obstacles: this._physObstacles() }
      });
      const rag = this.sim.phys.fighters[0];
      rag.teleport(P.x, P.z, P.yaw);
      rag.faceOpponent = this.locked; rag.faceYaw = P.yaw;
      return this.sim;
    }
    // put the fighter somewhere (dev tools / tests), standing still
    teleport(x, z, yaw) {
      const P = this.player; if (!P) return;
      P.x = x; P.z = z; if (yaw != null) P.yaw = yaw;
      if (this.sim) {
        const f = this.sim.state.f[0], rag = this.sim.phys.fighters[0];
        f.x = x; f.z = z; f.pose = null;
        rag.teleport(x, z, P.yaw); rag.faceYaw = P.yaw;
      }
    }

    update(dt, held, pressed, interactBit, lockBit) {
      if (!this.active) return;
      this.time += dt;
      const P = this.player, C = this.C, R = this.R;
      const live = !this.paused;
      const sim = this._ensureSim();
      // ----- lock-on: face the bag and move around it exactly as you would an opponent -----
      if (live && lockBit && (pressed & lockBit)) this.toggleLock();
      if (this.locked && (!live && this.station && this.station.tab || Math.hypot(BAG.x - P.x, BAG.z - P.z) > LOCK_RANGE + 1.2)) this.locked = false;
      const locked = this.locked;
      const lockYaw = Math.atan2(BAG.x - P.x, BAG.z - P.z);

      // ----- the fight engine: movement, strikes, guard, stamina, the bag -----
      if (sim) {
        const rag = sim.phys.fighters[0];
        let h = live ? held & SIM_BITS : 0;
        const p = live ? pressed & SIM_BITS : 0;
        rag.faceOpponent = locked;
        if (!locked && (h & DIRS)) {
          // free: W/A/S/D are screen directions (the camera does not swing round while you walk); he turns to the
          // way he is going and steps forward, at the fight's own footwork speed
          let mx = 0, mz = 0;
          if (h & IN.FWD) mz += 1; if (h & IN.BACK) mz -= 1; if (h & IN.LEFT) mx -= 1; if (h & IN.RIGHT) mx += 1;
          h &= ~DIRS;
          if (mx || mz) {
            const cy = this.cam.yaw; // forward = (sin cy, cos cy); screen right = forward x up = (-cos cy, sin cy)
            rag.faceYaw = Math.atan2(Math.sin(cy) * mz - Math.cos(cy) * mx, Math.cos(cy) * mz + Math.sin(cy) * mx);
            // turn first, then step: walking while still swinging round would curve the path
            let dy = rag.faceYaw - rag.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
            if (Math.abs(dy) < 1.0) h |= IN.FWD;
          }
        }
        sim.setInput(0, h, p); sim.setInput(1, 0, 0);
        sim.step(dt);
        for (const ev of sim.drainEvents()) this._onEvent(ev);
        const f = sim.state.f[0];
        P.x = f.x; P.z = f.z; P.yaw = rag.yaw; P.act = f.act; P.blocking = f.blocking; P.stam = f.stam;
        // the bag hangs from its pivot: the group turns with the physics body
        const q = sim.phys.fighters[1].rotation();
        this.bagGroup.quaternion.set(q.x, q.y, q.z, q.w);
      }
      if (this.session.combo && this.time - this.session.lastT > 1.4) this.session.combo = 0;
      this.bagSquash = Math.max(0, this.bagSquash - dt * 6);
      this.bagMesh.scale.set(1 + this.bagSquash * 0.12, 1 - this.bagSquash * 0.08, 1 + this.bagSquash * 0.12);
      // the speed bag idles with a little wobble
      const sb = this.group.userData.speedBag; if (sb) sb.position.x = 4.6 + Math.sin(this.time * 9) * 0.004;

      // ----- the fighter model: the ragdoll's pose, as in a fight -----
      this.model.inputHint = live ? held & SIM_BITS : 0;
      if (sim) this.model.update(sim.state.f[0], sim.state, sim.state.f[1], dt, this.time, R.groundAxis, 30);
      else { // physics still loading: stand at the spawn
        const f = { idx: 0, x: P.x, z: P.z, act: P.act, dmg: { head: 0, body: 0, legs: 0 }, rocked: 0, ground: null, blocking: false, stam: 100 };
        const opp = { x: P.x + Math.sin(P.yaw) * 3, z: P.z + Math.cos(P.yaw) * 3 };
        this.model.update(f, { phase: 'fight', ground: null, result: null, f: [f, opp] }, opp, dt, this.time, R.groundAxis, 30);
      }
      if (this.coach) {
        const cs = this.coachState; const co = { x: P.x, z: P.z }; // the coach watches you
        this.coach.inputHint = 0; this.coach.update(cs, { phase: 'fight', ground: null, result: null, f: [cs, co] }, co, dt, this.time, R.groundAxis, 18);
      }

      // ----- fx -----
      for (let i = this.fx.length - 1; i >= 0; i--) {
        const e = this.fx[i]; e.t += dt; const u = e.t / e.dur;
        if (u >= 1) { this.scene.remove(e.m); e.m.geometry.dispose(); e.m.material.dispose(); this.fx.splice(i, 1); continue; }
        e.m.scale.setScalar(1 + u * 2.5); e.m.material.opacity = 0.9 * (1 - u);
      }

      // ----- stations / prompt -----
      let near = null, nd = 1e9;
      for (const s of STATIONS) { const d = Math.hypot(s.x - P.x, s.z - P.z); if (d < s.r && d < nd) { near = s; nd = d; } }
      this.station = near;
      this.prompt = near ? this._promptFor(near, C) : '';
      if (live && near && near.tab && (pressed & interactBit) && this.onStation) this.onStation(near.tab, near.id);

      // ----- camera: third person, behind the fighter -----
      const cam = this.cam;
      if (!cam.init) { cam.yaw = P.yaw; cam.init = true; cam.pos.set(clamp(P.x - Math.sin(P.yaw) * 4.2, -ROOM.hw + 0.35, ROOM.hw - 0.35), 2.5, clamp(P.z - Math.cos(P.yaw) * 4.2, -ROOM.hd + 0.35, ROOM.hd - 0.35)); cam.tgt.set(P.x, 1.0, P.z); }
      // cam.yaw (the free-walk heading W/A/S/D read) follows the bag while locked, so unlocking leaves the camera behind you
      if (locked) { let d = lockYaw - cam.yaw; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; cam.yaw += d * expo(dt, 7); }
      if (locked) {
        // the fight camera (Renderer.update): side-on to you and the bag, centred between you, and it never swaps sides
        const dx = BAG.x - P.x, dz = BAG.z - P.z, dist = Math.hypot(dx, dz) || 0.001;
        const mx = (P.x + BAG.x) / 2, mz = (P.z + BAG.z) / 2;
        let sx = -dz / dist, sz = dx / dist; // the fight's opening side: you on the left, the bag on the right
        if (!cam.fight) {
          // a fight has a whole arena to stand back in; here take the other side if a wall is much closer on this one
          if (this._camReach(mx, mz, sx, sz) < 3.5 && this._camReach(mx, mz, -sx, -sz) > this._camReach(mx, mz, sx, sz) + 0.5) { sx = -sx; sz = -sz; }
          cam.side.set(sx, 0, sz); cam.fight = true;
        }
        if (sx * cam.side.x + sz * cam.side.z < 0) { sx = -sx; sz = -sz; }
        cam.side.x += (sx - cam.side.x) * expo(dt, 3); cam.side.z += (sz - cam.side.z) * expo(dt, 3); cam.side.normalize();
        const want = Math.min(clamp(4.4 + dist * 1.1, 4.8, 7.6), this._camReach(mx, mz, cam.side.x, cam.side.z));
        const height = 2.55 + dist * 0.15;
        const cx = mx + cam.side.x * want, cz = mz + cam.side.z * want;
        cam.pos.x += (cx - cam.pos.x) * expo(dt, 4); cam.pos.z += (cz - cam.pos.z) * expo(dt, 4); cam.pos.y += (height - cam.pos.y) * expo(dt, 4);
        cam.tgt.x += (mx - cam.tgt.x) * expo(dt, 5); cam.tgt.z += (mz - cam.tgt.z) * expo(dt, 5); cam.tgt.y += (0.95 - cam.tgt.y) * expo(dt, 4);
      } else {
        cam.fight = false;
        const back = 4.0, up = 2.2, side = 0.35; // over the right shoulder
        let cx = P.x - Math.sin(cam.yaw) * back + Math.cos(cam.yaw) * side, cz = P.z - Math.cos(cam.yaw) * back - Math.sin(cam.yaw) * side;
        cx = clamp(cx, -ROOM.hw + 0.35, ROOM.hw - 0.35); cz = clamp(cz, -ROOM.hd + 0.35, ROOM.hd - 0.35);
        cam.pos.x += (cx - cam.pos.x) * expo(dt, 8); cam.pos.z += (cz - cam.pos.z) * expo(dt, 8); cam.pos.y += (up - cam.pos.y) * expo(dt, 3);
        const tx = P.x + Math.cos(cam.yaw) * side * 0.5, tz = P.z - Math.sin(cam.yaw) * side * 0.5;
        cam.tgt.x += (tx - cam.tgt.x) * expo(dt, 8); cam.tgt.z += (tz - cam.tgt.z) * expo(dt, 8); cam.tgt.y += (1.0 - cam.tgt.y) * expo(dt, 4);
      }
      // the fight's lens while locked on, a wider one for walking the room
      const fov = locked ? FIGHT_FOV : ROOM_FOV;
      if (Math.abs(R.camera.fov - fov) > 0.01) { R.camera.fov += (fov - R.camera.fov) * expo(dt, 4); R.camera.updateProjectionMatrix(); }
      R.camera.position.copy(cam.pos);
      if (R.shake > 0) { R.camera.position.x += (Math.random() - 0.5) * 0.05 * R.shake; R.camera.position.y += (Math.random() - 0.5) * 0.05 * R.shake; R.shake = Math.max(0, R.shake - dt * 4); }
      R.camera.lookAt(cam.tgt);
      R.renderer.render(this.scene, R.camera);
    }

    // how far the camera can stand back from (x, z) along (dx, dz) before it meets a wall
    _camReach(x, z, dx, dz) {
      const lx = ROOM.hw - 0.35, lz = ROOM.hd - 0.35;
      const tx = dx > 1e-4 ? (lx - x) / dx : dx < -1e-4 ? (-lx - x) / dx : Infinity;
      const tz = dz > 1e-4 ? (lz - z) / dz : dz < -1e-4 ? (-lz - z) / dz : Infinity;
      return Math.max(0, Math.min(tx, tz));
    }

    _promptFor(s, C) {
      switch (s.id) {
        case 'computer': return C.booked ? (Career.fightReady(C) ? 'FIGHT NIGHT — step in' : 'Your booked fight (' + C.booked.weeksLeft + ' weeks out)') : 'Check fight offers' + (C.offers.length ? ' (' + C.offers.length + ' waiting)' : '');
        case 'board': return C.booked ? (Career.fightReady(C) ? 'Camp is over — it\'s fight week' : 'Plan this week\'s training') : 'Train this week (no fight booked)';
        case 'desk': return 'Gym upgrades · ' + Career.fmtMoney(C.money) + ' in the bank';
        case 'fame': return 'Fight history & news';
        case 'bag': return '';
      }
      return '';
    }

    // ---- the sim's events: sound, impact flash and the bag readout ----
    _onEvent(ev) {
      if (ev.i !== 0) return;
      const A = this.audio;
      switch (ev.k) {
        case 'miss': A.whiff(); return;
        case 'push': if (ev.ok) A.block(); else A.whiff(); return;
        case 'block': A.block(); return;
        case 'hit': break;
        default: return;
      }
      // a landed shot: dmg is the fight's damage number for it, vn the fist / shin speed into the bag (m/s)
      const st = STRIKES[ev.name] || null, dmg = ev.dmg || 0, big = !!ev.big;
      A.hit(big, 'body');
      this.bagSquash = Math.min(1, dmg / 6);
      const col = big ? 0xff5533 : dmg >= 2 ? 0xffb347 : 0xffe9b0;
      const geo = new THREE.SphereGeometry(big ? 0.2 : 0.12, 10, 8), mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9 });
      const m = new THREE.Mesh(geo, mat);
      if (ev.at) m.position.set(ev.at[0], ev.at[1], ev.at[2]); else m.position.set(BAG.x, 1.3, BAG.z);
      this.scene.add(m); this.fx.push({ m, t: 0, dur: big ? 0.32 : 0.2 });
      if (big) this.R.shake = Math.min(1, this.R.shake + 0.35);
      const S = this.session;
      S.hits++; S.combo = (this.time - S.lastT < 1.4) ? S.combo + 1 : 1; S.bestCombo = Math.max(S.bestCombo, S.combo); S.lastT = this.time;
      const speed = ev.vn || 0;
      S.hardest = Math.max(S.hardest, speed);
      const name = st ? (st.limb[0] === 'l' ? 'Left ' : 'Right ') + KIND_LABEL[st.kind].toLowerCase() : (ev.name || 'Strike');
      S.last = { name, speed, dmg, label: dmg >= 6 ? 'MONSTER' : big ? 'HEAVY' : dmg >= 2 ? 'SOLID' : 'LIGHT', big };
      S.lastStamp = this.time;
    }
  }

  root.MMAGym = { Gym, STATIONS, BAG, ROOM };
})(typeof window !== 'undefined' ? window : globalThis);
