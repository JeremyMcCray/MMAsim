/* Strike Lab: the options-panel editor for player-made strikes (see MMASim.CustomStrikes for the record format).
   Left: a 3D preview of the fighter in the pose being edited, scrubbed or played back along the keyframes, or run as
   a real ragdoll against a dummy with PHYSICS TEST. Right: the strike's properties, its keyframes and the pose
   editor for the selected frame (per-joint Euler angles in the rig's own terms). Every change re-registers the strike
   with the physics engine and the sim and is saved by the host app through the bridge passed to mount(). */
(function (root) {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (t) => t * t * (3 - 2 * t);
  const DEG = Math.PI / 180;

  const JOINT_LABEL = { pelvisYaw: 'Hips turn', pelvisTilt: 'Hips tilt', chest: 'Chest', head: 'Head', lUpperArm: 'L shoulder', lForearm: 'L elbow', rUpperArm: 'R shoulder', rForearm: 'R elbow',
    lThigh: 'L hip', lShin: 'L knee', rThigh: 'R hip', rShin: 'R knee', lift: 'Hop (height)', lAnkle: 'L ankle', rAnkle: 'R ankle' };
  const JOINT_ORDER = ['pelvisYaw', 'pelvisTilt', 'chest', 'head', 'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm', 'lThigh', 'lShin', 'rThigh', 'rShin', 'lift', 'lAnkle', 'rAnkle'];
  const AXIS_HELP = { 0: 'X · forward / back (negative swings the limb forward)', 1: 'Y · twist', 2: 'Z · sideways (positive toward the fighter\'s left)' };
  const WEAPON_LABEL = { fist: 'Fist', shin: 'Shin', foot: 'Foot (sole)', knee: 'Knee' };
  const PART_LABEL = { head: 'Head', body: 'Body', legs: 'Legs' };
  const MOD_LABEL = { none: 'no modifier', mod1: 'Modifier 1', mod2: 'Modifier 2', mod3: 'Modifier 3' };

  const Lab = {
    on: false, bridge: null, rec: null, frame: 1, joint: 'rUpperArm', t: 0, playing: false, test: null, yaw: 0.6, dist: 0, drag: null,
    mount(bridge) { this.bridge = bridge; },
    // ---------- state ----------
    get list() { return this.bridge.list(); },
    get CS() { return root.MMASim.CustomStrikes; },
    get PH() { return root.MMAPhys; },
    limb() { return this.CS.limbOf(this.rec); },
    def() { return this.rec ? this.PH.STRIKES[this.limb() + '_' + this.rec.id] : null; },
    pick(id) {
      this.rec = this.list.find(c => c.id === id) || this.list[0] || null;
      this.frame = this.rec ? Math.min(1, this.rec.frames.length - 1) : 0;
      this.t = this.rec ? this.rec.active[0] : 0;
      this.stopTest(); this.playing = false; this.scrubbed = false;
      const pb = $('#labPlay'); if (pb) pb.textContent = 'PLAY';
      if (this.rec) { this.joint = this.rec.weapon === 'fist' ? this.rec.side + 'UpperArm' : this.rec.side + 'Thigh'; this.dist = 0; }
      this.build(); this.pose();
    },
    // re-register and save; keepT: keep the scrub time where it is
    commit(structural) {
      if (!this.rec) return;
      const i = this.list.indexOf(this.rec);
      const clean = this.CS.register(this.rec);
      if (clean) { if (i >= 0) this.list[i] = clean; this.rec = clean; }
      this.frame = clamp(this.frame, 0, this.rec.frames.length - 1);
      this.bridge.save();
      if (structural) this.build(); else this.refreshLabels();
      this.pose();
    },
    create(fromKey) {
      const c = this.CS.fromBuiltin(fromKey || 'rh_straight', null);
      if (!c) return;
      c.name = ('My ' + c.name).slice(0, 24); c.id = this.CS.newId();
      const clean = this.CS.register(c); if (!clean) return;
      this.list.push(clean); this.bridge.save();
      this.pick(clean.id);
    },
    duplicate() {
      if (!this.rec) return;
      const c = this.CS.sanitize(JSON.parse(JSON.stringify(this.rec))); c.id = this.CS.newId(); c.name = (this.rec.name + ' 2').slice(0, 24);
      const clean = this.CS.register(c); if (!clean) return;
      this.list.push(clean); this.bridge.save(); this.pick(clean.id);
    },
    remove() {
      if (!this.rec) return;
      const id = this.rec.id, i = this.list.indexOf(this.rec);
      if (i >= 0) this.list.splice(i, 1);
      this.CS.unregister(id);
      this.bridge.save(); // the app drops it from the moveset as well
      this.pick(this.list[Math.min(i, this.list.length - 1)] ? this.list[Math.min(i, this.list.length - 1)].id : null);
    },

    // ---------- pose maths: the keyframes interpolated the way the ragdoll's controller does (js/physics.js #computePose) ----------
    poseAt(tt) {
      const d = this.def(), PH = this.PH; if (!d) return null;
      const S = 'stance', base = PH.STANCE, fr = d.frames;
      let i = 0; while (i < fr.length - 2 && tt >= fr[i + 1].t) i++;
      const f0 = fr[i], f1 = fr[i + 1], u = clamp((tt - f0.t) / Math.max(1e-6, f1.t - f0.t), 0, 1);
      const act = d.active;
      const phase = f1.t <= act[0] + 1e-6 ? 'windup' : f0.t < act[0] ? 'delivery' : f0.t < act[1] - 1e-6 ? 'follow' : 'recovery';
      const s = phase === 'windup' ? smooth(u) : phase === 'delivery' ? Math.pow(u, 1.8) : phase === 'follow' ? u : 1 - Math.pow(1 - u, 1.6);
      const pose = { pelvisYaw: base.pelvisYaw, pelvisTilt: [0, 0, 0], lift: 0, lAnkle: 0, rAnkle: 0 };
      for (const j of PH.JOINTS) pose[j] = base[j];
      const lerp3 = (a, b) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
      for (const k of d.keys) {
        if (PH.SCALAR_KEYS[k]) { const a = f0[k] || 0, b = f1[k] || 0; pose[k] = a + (b - a) * s; continue; }
        const v0 = f0[k] === S ? (k === 'pelvisTilt' ? [0, 0, 0] : base[k]) : f0[k], v1 = f1[k] === S ? (k === 'pelvisTilt' ? [0, 0, 0] : base[k]) : f1[k];
        if (k === 'pelvisYaw') pose.pelvisYaw = v0 + (v1 - v0) * s;
        else pose[k] = lerp3(v0, v1);
      }
      return pose;
    },
    // the selected frame exactly as authored (no interpolation), for editing
    framePose(idx) {
      const d = this.def(), PH = this.PH; if (!d) return null;
      return PH.resolveFrameExport(d, d.frames[idx], PH.STANCE);
    },
    snapshotOf(pose, x, z, yaw) {
      const PH = this.PH, r = PH.fk(pose, yaw || 0), out = [];
      for (const n of PH.SEG_ORDER) { const p = r.p[n], q = r.q[n]; out.push(p.x + x, p.y, p.z + z, q.x, q.y, q.z, q.w); }
      out.push((pose.lAnkle || 0) * DEG, (pose.rAnkle || 0) * DEG);
      return out;
    },
    applyTo(model, snap) {
      model.physMode = false; model._applySnapshot(snap, 0, 0);
      model.blob.position.set(snap[0], 0.012, snap[2]); model.blob.material.opacity = 0.35;
    },
    // show the current time (scrubbing / playing) or the selected keyframe when idle
    pose() {
      if (!this.model) return;
      if (this.dummy) this.dummy.setVisible(!!this.rec);
      if (!this.rec) { this.applyTo(this.model, this.snapshotOf(this.PH.STANCE, 0, 0, 0)); return; }
      const d = this.def(); if (!d) return;
      const scrub = this.playing || this.scrubbed;
      const p = scrub ? this.poseAt(this.t) : this.framePose(this.frame);
      if (!p) return;
      this.applyTo(this.model, this.snapshotOf(p, 0, 0, 0));
      if (this.dummy) this.applyTo(this.dummy, this.snapshotOf(this.PH.STANCE, 0, this.distance(), Math.PI));
      const sc = $('#labScrub'); if (sc && scrub) sc.value = Math.round(this.t / d.dur * 1000);
      const tl = $('#labT'); if (tl) tl.textContent = (scrub ? this.t : d.frames[this.frame].t).toFixed(2) + ' s';
    },
    distance() { const d = this.def(); return this.dist || (d ? Math.round((d.range - 0.05) * 100) / 100 : 1); },

    // ---------- the 3D preview ----------
    initScene() {
      if (this.R) return true;
      const canvas = $('#labCanvas'); if (!canvas || !root.THREE) return false;
      const THREE = root.THREE;
      try { this.R = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch (_) { return false; }
      this.R.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2)); this.R.setClearColor(0x000000, 0);
      this.R.outputEncoding = THREE.sRGBEncoding; this.R.toneMapping = THREE.ACESFilmicToneMapping; this.R.toneMappingExposure = 0.85;
      this.scene = new THREE.Scene();
      this.scene.add(new THREE.HemisphereLight(0x8899bb, 0x201a14, 0.4));
      const key = new THREE.DirectionalLight(0xfff2dd, 0.7); key.position.set(2.5, 4, 3); this.scene.add(key);
      const fill = new THREE.DirectionalLight(0xa9c4ff, 0.25); fill.position.set(-3, 2, -2); this.scene.add(fill);
      const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.95 });
      const floor = new THREE.Mesh(new THREE.CircleGeometry(2.4, 48), mat); floor.rotation.x = -Math.PI / 2; floor.position.y = 0.002; this.scene.add(floor);
      const grid = new THREE.GridHelper(4, 16, 0x555566, 0x3a3a46); grid.position.y = 0.004; this.scene.add(grid);
      this.cam = new THREE.PerspectiveCamera(32, 4 / 3, 0.1, 30);
      canvas.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, h: this.camH }; canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', (e) => { if (this.drag) { this.yaw = this.drag.yaw + (e.clientX - this.drag.x) * 0.012; this.camH = clamp(this.drag.h + (e.clientY - this.drag.y) * 0.006, 0.4, 2.6); } });
      canvas.addEventListener('pointerup', () => { this.drag = null; }); canvas.addEventListener('pointercancel', () => { this.drag = null; });
      canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.camD = clamp(this.camD + e.deltaY * 0.002, 1.8, 6); }, { passive: false });
      this.camH = 1.3; this.camD = 3.6;
      return true;
    },
    open() {
      if (!this.initScene()) return;
      this.on = true;
      if (!this.model) {
        const F = root.MMARender.FighterModel;
        this.model = new F(this.scene, 0xc62828, 0xc8956c, 0, {});
        this.dummy = new F(this.scene, 0x1e5bd6, 0x8d5a3b, 1, {});
      }
      this.pick(this.rec ? this.rec.id : (this.list[0] && this.list[0].id));
      if (!this._raf) this._raf = requestAnimationFrame((t) => this.frameLoop(t));
    },
    close() {
      this.on = false; this.playing = false; this.stopTest();
      if (this.model) { this.model.dispose(); this.model = null; }
      if (this.dummy) { this.dummy.dispose(); this.dummy = null; }
    },
    frameLoop(t) {
      this._raf = 0;
      if (!this.on) return;
      this._raf = requestAnimationFrame((t2) => this.frameLoop(t2));
      const canvas = $('#labCanvas'), w = canvas.clientWidth | 0, h = canvas.clientHeight | 0;
      if (!w || !h || !this.model) return;
      if (canvas.width !== Math.round(w * this.R.getPixelRatio()) || canvas.height !== Math.round(h * this.R.getPixelRatio())) { this.R.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }
      const dt = this._t ? Math.min(0.05, (t - this._t) / 1000) : 0; this._t = t;
      const d = this.def();
      if (this.test) this.stepTest(dt);
      else if (this.playing && d) {
        this.t += dt * (this.slow ? 0.25 : 1);
        if (this.t >= d.dur) { this.t = 0; }
        this.pose();
      }
      const cz = this.distance() / 2;
      this.cam.position.set(Math.sin(this.yaw) * this.camD, this.camH, cz + Math.cos(this.yaw) * this.camD);
      this.cam.lookAt(0, 1.0, cz);
      this.R.render(this.scene, this.cam);
    },

    // ---------- physics test: the real ragdoll throws it at a dummy ----------
    startTest() {
      const PH = this.PH, d = this.def();
      if (!d || !PH.ready()) { this.readout(PH.ready() ? 'No strike selected.' : 'Physics is still loading.'); return; }
      this.stopTest(); this.playing = false;
      const dist = this.distance();
      const world = new PH.World({ positions: [[0, 0], [0, dist]], rand: root.MMASim.mulberry32(7) });
      // let both settle into the stance, then throw
      for (let i = 0; i < 40; i++) world.step();
      world.fighters[1].guard = false;
      world.fighters[0].startStrike(d, 1);
      this.test = { world, t: 0, hit: null, glance: null, done: false, hold: 0 };
      this.readout('Throwing…');
    },
    stepTest(dt) {
      const T = this.test, f = T.world.fighters[0];
      let acc = (T.acc || 0) + dt;
      while (acc >= 1 / 60) {
        acc -= 1 / 60;
        const hits = T.world.step(); T.t += 1 / 60;
        const h = hits[0];
        if (h) { if (h.glance) { if (!T.hit) T.glance = h; } else T.hit = h; }
        if (!f.strike && !T.done) { T.done = true; }
        if (T.done) { T.hold += 1 / 60; if (T.hold > 0.6) { this.stopTest(true); return; } }
      }
      T.acc = acc;
      this.applyTo(this.model, T.world.fighters[0].snapshot());
      this.applyTo(this.dummy, T.world.fighters[1].snapshot());
      const sc = $('#labScrub'), d = this.def(); if (sc && d) sc.value = Math.round(clamp(T.t / d.dur, 0, 1) * 1000);
      const tl = $('#labT'); if (tl) tl.textContent = T.t.toFixed(2) + ' s';
    },
    stopTest(report) {
      const T = this.test; if (!T) return;
      this.test = null;
      if (report) {
        const h = T.hit, g = T.glance;
        if (h) this.readout('LANDED on the ' + (h.region === 'legs' ? 'leg' : h.region) + ' (' + h.partName + ') at ' + h.vn.toFixed(1) + ' m/s' + (h.vn < 3 ? ' · light: speed it up or aim for a firmer line' : h.vn > 6 ? ' · heavy' : ''), 'ok');
        else if (g) this.readout('Glanced off the ' + g.partName + ' at ' + g.vn.toFixed(1) + ' m/s · brushing contact, no damage. Bring the weapon in faster or more squarely.', 'warn');
        else this.readout('MISSED · nothing was in the way during the impact window. Check reach (dummy distance), height and the window timing.', 'bad');
      }
      T.world.free();
      this.pose();
      const b = $('#labTest'); if (b) b.textContent = 'PHYSICS TEST';
    },
    readout(msg, cls) { const r = $('#labReadout'); if (r) { r.textContent = msg; r.className = 'lab-readout' + (cls ? ' ' + cls : ''); } },

    // ---------- the panel ----------
    build() {
      const host = $('#labPanel'); if (!host) return;
      const B = this.bridge, rec = this.rec, CS = this.CS, PH = this.PH;
      const builtins = PH.BUILTIN_KEYS.map(k => '<option value="' + k + '">' + esc(PH.STRIKES[k].name) + '</option>').join('');
      let h = '<div class="lab-sec"><h3>YOUR STRIKES</h3><div class="lab-row">' +
        '<select id="labPick" aria-label="Your strikes">' + (this.list.length ? this.list.map(c => '<option value="' + c.id + '"' + (rec && c.id === rec.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') : '<option value="">(none yet)</option>') + '</select>' +
        '<select id="labTemplate" aria-label="Start from"><option value="">New from…</option>' + builtins + '</select>' +
        '<button type="button" class="ghost small" id="labDup"' + (rec ? '' : ' disabled') + '>DUPLICATE</button><button type="button" class="ghost small danger" id="labDel"' + (rec ? '' : ' disabled') + '>DELETE</button></div>' +
        '<p class="opt-help">Pick a built-in strike under <b>New from…</b> to start from its motion, then reshape it frame by frame. Everything saves as you go. Up to ' + CS.LIMITS.frames + ' keyframes.</p></div>';
      if (!rec) { host.innerHTML = h; this.wirePanel(); return; }
      const seg = (id, opts, cur) => '<span class="seg" data-seg="' + id + '">' + opts.map(([v, l]) => '<button type="button" data-v="' + v + '" class="' + (v === cur ? 'on' : '') + '">' + l + '</button>').join('') + '</span>';
      const slider = (id, label, v, lo, hi, step, fmt) => '<div class="lab-row"><label>' + label + '</label><input type="range" data-prop="' + id + '" min="' + lo + '" max="' + hi + '" step="' + step + '" value="' + v + '"><span class="lab-val" data-val="' + id + '">' + (fmt ? fmt(v) : v) + '</span></div>';
      h += '<div class="lab-sec"><h3>STRIKE</h3>' +
        '<div class="lab-row"><label>Name</label><input id="labName" maxlength="24" value="' + esc(rec.name) + '"></div>' +
        '<div class="lab-row"><label>Side</label>' + seg('side', [['l', 'LEFT'], ['r', 'RIGHT']], rec.side) + '<label class="in">Weapon</label>' + seg('weapon', Object.keys(WEAPON_LABEL).map(k => [k, WEAPON_LABEL[k].toUpperCase()]), rec.weapon) + '</div>' +
        '<div class="lab-row"><label>Target</label>' + seg('part', Object.keys(PART_LABEL).map(k => [k, PART_LABEL[k].toUpperCase()]), rec.part) + '<label class="mute-music in"><input type="checkbox" id="labPush"' + (rec.push ? ' checked' : '') + '> Shoves (like a teep)</label></div>' +
        slider('power', 'Power', rec.power, CS.LIMITS.power[0], CS.LIMITS.power[1], 0.05, v => (+v).toFixed(2) + '×') +
        slider('cost', 'Stamina', rec.cost, CS.LIMITS.cost[0], CS.LIMITS.cost[1], 0.5) +
        slider('speed', 'Snap', rec.speed, CS.LIMITS.speed[0], CS.LIMITS.speed[1], 0.05, v => (+v).toFixed(2) + '×') +
        slider('lunge', 'Step in', rec.lunge, CS.LIMITS.lunge[0], CS.LIMITS.lunge[1], 0.1, v => (+v).toFixed(1) + ' m/s') +
        '<p class="opt-help">Power scales the damage of a clean landing; Snap is how hard the joints chase each frame (fast strikes snap, slow ones push). Step in drives the body forward until the impact window closes.</p></div>';
      // throw it with
      const limb = CS.limbOf(rec), ms = B.getMoveset(), mods = root.MMASim.MODS;
      const held = mods.filter(m => ms[m][limb] === rec.id);
      h += '<div class="lab-sec"><h3>THROW IT WITH</h3><div class="lab-row"><label>' + esc(root.MMASim.LIMB_NAME[limb]) + ' key <b>' + esc(B.keyName(B.binds()[limb][0])) + '</b></label>' +
        '<select id="labMod"><option value=""' + (held.length ? '' : ' selected') + '>not assigned</option>' + mods.map(m => '<option value="' + m + '"' + (held[0] === m ? ' selected' : '') + '>' + (m === 'none' ? 'no modifier' : 'hold ' + esc(B.keyName(B.binds()[m][0])) + ' (' + MOD_LABEL[m] + ')') + '</option>').join('') + '</select>' +
        (held.length > 1 ? '<span class="lab-val">also on ' + held.slice(1).map(m => MOD_LABEL[m]).join(', ') + '</span>' : '') + '</div>' +
        '<p class="opt-help">The other hand or leg throws the mirror image of it. The full map is on the STRIKES tab.</p></div>';
      // keyframes
      const d = this.def(), dur = d.dur;
      h += '<div class="lab-sec"><h3>KEYFRAMES <small>' + rec.frames.length + ' / ' + CS.LIMITS.frames + ' · ' + dur.toFixed(2) + ' s</small></h3>' +
        '<div class="lab-tl"><div class="lab-tl-act" style="left:' + (rec.active[0] / dur * 100) + '%;width:' + ((rec.active[1] - rec.active[0]) / dur * 100) + '%"></div>' +
        rec.frames.map((f, i) => '<button type="button" class="lab-kf' + (i === this.frame ? ' on' : '') + (i === 0 || i === rec.frames.length - 1 ? ' end' : '') + '" data-kf="' + i + '" style="left:' + (f.t / dur * 100) + '%" title="' + f.t.toFixed(2) + ' s">' + (i + 1) + '</button>').join('') + '</div>' +
        '<div class="lab-row"><label>Frame ' + (this.frame + 1) + ' at</label><input type="number" id="labKfT" step="0.01" min="0.01" max="' + CS.LIMITS.maxT + '" value="' + rec.frames[this.frame].t + '"' + (this.frame === 0 ? ' disabled' : '') + '> s' +
        '<button type="button" class="ghost small" id="labKfAdd"' + (rec.frames.length >= CS.LIMITS.frames || this.frame === rec.frames.length - 1 ? ' disabled' : '') + '>ADD AFTER</button>' +
        '<button type="button" class="ghost small" id="labKfCopy"' + (this.frame <= 1 || this.frame === rec.frames.length - 1 ? ' disabled' : '') + '>COPY PREVIOUS</button>' +
        '<button type="button" class="ghost small danger" id="labKfDel"' + (this.frame === 0 || this.frame === rec.frames.length - 1 || rec.frames.length <= 2 ? ' disabled' : '') + '>REMOVE</button></div>' +
        slider('active0', 'Impact from', rec.active[0], 0.02, dur, 0.01, v => (+v).toFixed(2) + ' s') +
        slider('active1', 'Impact to', rec.active[1], 0.04, dur, 0.01, v => (+v).toFixed(2) + ' s') +
        '<p class="opt-help">The gold band is the impact window: the weapon only scores inside it. The first and last frames are the stance; move the last one to set the length.</p></div>';
      // pose editor
      const f = rec.frames[this.frame], endFrame = this.frame === 0 || this.frame === rec.frames.length - 1;
      h += '<div class="lab-sec"><h3>POSE <small>frame ' + (this.frame + 1) + (endFrame ? ' · stance' : '') + '</small></h3>';
      if (endFrame) h += '<p class="opt-help">The fighter starts and ends every strike in the stance. Pick a middle frame to shape it.</p>';
      else {
        h += '<div class="lab-joints">' + JOINT_ORDER.map(j => '<button type="button" data-joint="' + j + '" class="' + (j === this.joint ? 'on' : '') + (f[j] != null ? ' set' : '') + '">' + JOINT_LABEL[j] + '</button>').join('') + '</div>';
        const j = this.joint, v = f[j];
        const isScalar = j === 'pelvisYaw' || j === 'lift' || j === 'lAnkle' || j === 'rAnkle';
        h += '<div class="lab-row"><label class="mute-music"><input type="checkbox" id="labStance"' + (v == null ? ' checked' : '') + '> ' + JOINT_LABEL[j] + ' stays in the stance</label></div>';
        if (v != null) {
          if (isScalar) {
            const lo = j === 'lift' ? -0.3 : j === 'pelvisYaw' ? -180 : -90, hi = -lo, st = j === 'lift' ? 0.005 : 1;
            h += slider('j0', j === 'lift' ? 'Height' : j === 'pelvisYaw' ? 'Turn (deg)' : 'Point toes (deg)', v, lo, hi, st, x => j === 'lift' ? (+x).toFixed(3) + ' m' : Math.round(x) + '°');
          } else for (let a = 0; a < 3; a++) h += slider('j' + a, ['X', 'Y', 'Z'][a], v[a], -180, 180, 1, x => Math.round(x) + '°');
          h += '<p class="opt-help">' + (isScalar ? (j === 'pelvisYaw' ? 'Positive turns the hips to the left (brings the right side forward).' : j === 'lift' ? 'Raises or sinks the hips: hop into a knee, dip under a hook.' : 'Positive points the toes down, in line with the shin.') : AXIS_HELP[0] + ' · ' + AXIS_HELP[1] + ' · ' + AXIS_HELP[2] + '. Angles are relative to the parent segment.') + '</p>';
        }
      }
      h += '</div>';
      host.innerHTML = h;
      this.wirePanel();
      const sc = $('#labScrub'); if (sc) sc.value = Math.round(this.t / dur * 1000);
      const ds = $('#labDist'); if (ds) { ds.value = this.distance(); $('#labDistLbl').textContent = this.distance().toFixed(2) + ' m'; }
    },
    refreshLabels() {
      const rec = this.rec; if (!rec) return;
      const host = $('#labPanel');
      const d = this.def();
      host.querySelectorAll('.lab-tl-act').forEach(el => { el.style.left = (rec.active[0] / d.dur * 100) + '%'; el.style.width = ((rec.active[1] - rec.active[0]) / d.dur * 100) + '%'; });
      host.querySelectorAll('[data-joint]').forEach(b => b.classList.toggle('set', rec.frames[this.frame][b.dataset.joint] != null));
    },
    wirePanel() {
      const host = $('#labPanel'), rec = this.rec, CS = this.CS;
      $('#labPick').onchange = (e) => { if (e.target.value) this.pick(e.target.value); };
      $('#labTemplate').onchange = (e) => { if (e.target.value) { this.create(e.target.value); } };
      $('#labDup').onclick = () => this.duplicate();
      $('#labDel').onclick = () => { if (!this.rec) return; if (this.confirmDel === this.rec.id) { this.confirmDel = null; this.remove(); } else { this.confirmDel = this.rec.id; $('#labDel').textContent = 'SURE?'; setTimeout(() => { if (this.confirmDel) { this.confirmDel = null; const b = $('#labDel'); if (b) b.textContent = 'DELETE'; } }, 2500); } };
      if (!rec) return;
      $('#labName').oninput = (e) => { rec.name = e.target.value; };
      $('#labName').onchange = () => { this.commit(true); this.bridge.onChange(); };
      host.querySelectorAll('[data-seg] button').forEach(b => b.onclick = () => {
        const k = b.parentElement.dataset.seg, v = b.dataset.v;
        if (k === 'side' && v !== rec.side) { this.mirrorRecord(); }
        else if (k === 'weapon') { const wasHand = rec.weapon === 'fist', nowHand = v === 'fist'; rec.weapon = v; if (wasHand !== nowHand) this.bridge.unassign(rec.id); }
        else rec[k] = v;
        this.commit(true); this.bridge.onChange();
      });
      $('#labPush').onchange = (e) => { rec.push = e.target.checked; this.commit(); };
      $('#labMod').onchange = (e) => { this.bridge.assign(rec.id, CS.limbOf(rec), e.target.value || null); this.build(); };
      host.querySelectorAll('input[type=range][data-prop]').forEach(sl => {
        const id = sl.dataset.prop, lbl = host.querySelector('[data-val="' + id + '"]');
        sl.oninput = () => {
          const v = +sl.value;
          if (id === 'active0') { rec.active[0] = v; if (rec.active[1] < v + 0.02) { rec.active[1] = v + 0.02; const o = host.querySelector('[data-prop=active1]'); if (o) { o.value = rec.active[1]; host.querySelector('[data-val=active1]').textContent = rec.active[1].toFixed(2) + ' s'; } } this.t = v; this.scrubbed = true; }
          else if (id === 'active1') { rec.active[1] = v; if (rec.active[0] > v - 0.02) { rec.active[0] = Math.max(0.02, v - 0.02); const o = host.querySelector('[data-prop=active0]'); if (o) { o.value = rec.active[0]; host.querySelector('[data-val=active0]').textContent = rec.active[0].toFixed(2) + ' s'; } } this.t = v; this.scrubbed = true; }
          else if (id[0] === 'j' && id.length === 2) { const f = rec.frames[this.frame], j = this.joint; if (Array.isArray(f[j])) f[j][+id[1]] = v; else f[j] = v; this.scrubbed = false; }
          else rec[id] = v;
          if (lbl) lbl.textContent = id === 'power' || id === 'speed' ? v.toFixed(2) + '×' : id === 'lunge' ? v.toFixed(1) + ' m/s' : id === 'cost' ? String(v) : id.startsWith('active') ? v.toFixed(2) + ' s' : this.joint === 'lift' && id[0] === 'j' ? v.toFixed(3) + ' m' : Math.round(v) + '°';
          this.commit();
        };
        sl.onchange = () => { this.scrubbed = false; this.pose(); };
      });
      host.querySelectorAll('.lab-kf').forEach(b => b.onclick = () => { this.frame = +b.dataset.kf; this.scrubbed = false; this.playing = false; this.build(); this.pose(); });
      const kt = $('#labKfT'); if (kt) kt.onchange = () => { const f = rec.frames[this.frame]; f.t = +kt.value; const t = f.t; this.commit(true); this.frame = Math.max(0, rec.frames.findIndex(x => Math.abs(x.t - t) < 1e-6)); this.build(); this.pose(); };
      $('#labKfAdd').onclick = () => {
        const i = this.frame, a = rec.frames[i], b = rec.frames[i + 1];
        const nf = JSON.parse(JSON.stringify(a)); nf.t = Math.round((a.t + b.t) / 2 * 1000) / 1000;
        if (i === 0) for (const k in nf) if (k !== 't') delete nf[k];
        rec.frames.splice(i + 1, 0, nf); this.frame = i + 1; this.commit(true);
      };
      $('#labKfCopy').onclick = () => { const src = rec.frames[this.frame - 1], t = rec.frames[this.frame].t; rec.frames[this.frame] = Object.assign(JSON.parse(JSON.stringify(src)), { t }); this.commit(true); };
      $('#labKfDel').onclick = () => { rec.frames.splice(this.frame, 1); this.frame = Math.max(1, this.frame - 1); this.commit(true); };
      host.querySelectorAll('[data-joint]').forEach(b => b.onclick = () => { this.joint = b.dataset.joint; this.build(); });
      const st = $('#labStance'); if (st) st.onchange = () => {
        const f = rec.frames[this.frame], j = this.joint;
        if (st.checked) delete f[j];
        else {
          // start from where the joint is right now (the stance, or the previous frame's value when it has one)
          const prev = rec.frames[this.frame - 1] && rec.frames[this.frame - 1][j];
          const base = this.PH.STANCE;
          f[j] = prev != null ? JSON.parse(JSON.stringify(prev)) : j === 'pelvisYaw' ? base.pelvisYaw : j === 'pelvisTilt' ? [0, 0, 0] : (j === 'lift' || j === 'lAnkle' || j === 'rAnkle') ? 0 : base[j].slice();
        }
        this.commit(true);
      };
    },
    // the whole record flipped left <-> right (a left-side version of a right-side strike)
    mirrorRecord() {
      const rec = this.rec, M = this.PH.MIRROR;
      rec.side = rec.side === 'l' ? 'r' : 'l';
      const flip = (e) => [e[0], -e[1], -e[2]];
      rec.frames = rec.frames.map(f => {
        const o = { t: f.t };
        for (const k in f) {
          if (k === 't') continue;
          if (k === 'pelvisYaw') o.pelvisYaw = -f[k];
          else if (k === 'pelvisTilt') o.pelvisTilt = flip(f[k]);
          else if (k === 'lift') o.lift = f[k];
          else if (k === 'lAnkle' || k === 'rAnkle') o[M[k]] = f[k];
          else if (M[k]) o[M[k]] = flip(f[k]);
          else o[k] = f[k];
        }
        return o;
      });
      if (M[this.joint]) this.joint = M[this.joint];
      this.bridge.unassign(rec.id); // the other hand / leg throws it now
    },
    // transport controls (static part of the page)
    wireStatic() {
      const play = $('#labPlay'), sc = $('#labScrub'), test = $('#labTest'), slow = $('#labSlow'), ds = $('#labDist');
      if (!play || play._wired) return; play._wired = true;
      play.onclick = () => { this.stopTest(); this.playing = !this.playing; this.scrubbed = this.playing; play.textContent = this.playing ? 'STOP' : 'PLAY'; if (!this.playing) this.pose(); };
      sc.oninput = () => { const d = this.def(); if (!d) return; this.stopTest(); this.playing = false; play.textContent = 'PLAY'; this.scrubbed = true; this.t = sc.value / 1000 * d.dur; this.pose(); };
      slow.onchange = () => { this.slow = slow.checked; };
      test.onclick = () => { if (this.test) { this.stopTest(); return; } this.playing = false; play.textContent = 'PLAY'; this.startTest(); if (this.test) test.textContent = 'STOP TEST'; };
      ds.oninput = () => { this.dist = +ds.value; $('#labDistLbl').textContent = this.dist.toFixed(2) + ' m'; this.pose(); };
    }
  };
  const open = Lab.open.bind(Lab);
  Lab.open = function () { this.wireStatic(); open(); };

  root.MMAStrikeLab = Lab;
})(typeof window !== 'undefined' ? window : globalThis);
