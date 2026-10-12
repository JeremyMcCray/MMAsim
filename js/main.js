/* ============================================================
   Cage Rules — app glue: menus, lobby, input, game loop, HUD, netcode
   ============================================================ */
(function () {
  'use strict';
  const { IN, Sim, ROSTER, describe, LIMBS, LIMB_NAME, LIMB_BIT, MODS, MOD_BIT, HAND_KINDS, LEG_KINDS, KIND_LABEL, DEFAULT_MOVESET, normalizeMoveset, POS_NAME, MOVES, SUBS_BY, BOTTOM_CAN_STRIKE, KD, BREAK_T } = window.MMASim;
  const { CpuBrain } = window.MMAAI;
  const { Renderer } = window.MMARender;
  const { Net } = window.MMANet;
  const { Audio } = window.MMAAudio;
  const Career = window.MMACareer;
  // playtest analytics (js/analytics.js, PostHog); every call is a no-op without a project key
  const Analytics = window.MMAAnalytics || { enabled: false, track() {}, register() {}, person() {}, identify() {}, fightStarted() {}, replayUrl() { return ''; } };

  const $ = (s) => document.querySelector(s);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  // ---------- controls (rebindable, saved in localStorage) ----------
  const ACTIONS = [
    { id: 'fwd', label: 'Move in', bit: IN.FWD, def: ['KeyW', 'ArrowUp'] },
    { id: 'back', label: 'Back off', bit: IN.BACK, def: ['KeyS', 'ArrowDown'] },
    { id: 'left', label: 'Circle left', bit: IN.LEFT, def: ['KeyA', 'ArrowLeft'] },
    { id: 'right', label: 'Circle right', bit: IN.RIGHT, def: ['KeyD', 'ArrowRight'] },
    { id: 'lh', label: 'Left hand', bit: IN.LHAND, def: ['KeyU', ''] },
    { id: 'rh', label: 'Right hand', bit: IN.RHAND, def: ['KeyI', ''] },
    { id: 'll', label: 'Left leg', bit: IN.LLEG, def: ['KeyJ', ''] },
    { id: 'rl', label: 'Right leg', bit: IN.RLEG, def: ['KeyK', ''] },
    { id: 'mod1', label: 'Modifier 1 (hold)', bit: IN.MOD1, def: ['KeyQ', ''] },
    { id: 'mod2', label: 'Modifier 2 (hold)', bit: IN.MOD2, def: ['KeyE', ''] },
    { id: 'mod3', label: 'Modifier 3 (hold)', bit: IN.MOD3, def: ['KeyR', ''] },
    { id: 'block', label: 'Block / sprawl / cover (hold) · slip (press as a strike comes) · push (tap twice)', bit: IN.BLOCK, def: ['KeyL', 'Semicolon'] },
    { id: 'grapple', label: 'Takedown / submission / sweep', bit: IN.GRAPPLE, def: ['Space', ''] },
    { id: 'dodge', label: 'Dash (the way you are stepping) / stand up', bit: IN.DODGE, def: ['ShiftLeft', 'ShiftRight'] },
    { id: 'stance', label: 'Switch stance (orthodox / southpaw)', bit: IN.STANCE, def: ['KeyX', ''] },
    { id: 'check', label: 'Check low kicks: lift the lead leg (hold)', bit: IN.CHECK, def: ['KeyO', ''] },
    { id: 'interact', label: 'Use (gym: computer, whiteboard, desk)', bit: 1 << 14, def: ['Enter', 'KeyF'] },
    { id: 'lock', label: 'Lock on to the heavy bag (gym)', bit: 1 << 15, def: ['KeyT', ''] }
  ];
  const IN_INTERACT = 1 << 14, IN_LOCK = 1 << 15, SIM_MASK = 0x3fff | IN.STANCE | IN.CHECK; // interact/lock are app-only bits; mask with SIM_MASK before input reaches the sim
  const Controls = { binds: {}, moveset: null, keyMap: {}, pad: {} };
  // ---------- gamepad (standard layout: Xbox / PlayStation / Steam Input) ----------
  // pad codes: 'B<n>' = button n, 'A<axis><+|->' = a stick axis pushed past the deadzone
  const PAD_DEFAULT = { fwd: 'A1-', back: 'A1+', left: 'A0-', right: 'A0+', lh: 'B2', rh: 'B3', ll: 'B0', rl: 'B1', mod1: 'B4', mod2: 'B5', mod3: 'B6', block: 'B7', grapple: 'B10', dodge: 'B11', stance: 'B14', check: 'B13', interact: 'B12', lock: 'B15' };
  const PAD_NAMES = { B0: 'A', B1: 'B', B2: 'X', B3: 'Y', B4: 'LB', B5: 'RB', B6: 'LT', B7: 'RT', B8: 'BACK', B9: 'START', B10: 'LS', B11: 'RS', B12: 'D-UP', B13: 'D-DOWN', B14: 'D-LEFT', B15: 'D-RIGHT', B16: 'GUIDE', 'A0-': 'LS\u2190', 'A0+': 'LS\u2192', 'A1-': 'LS\u2191', 'A1+': 'LS\u2193', 'A2-': 'RS\u2190', 'A2+': 'RS\u2192', 'A3-': 'RS\u2191', 'A3+': 'RS\u2193' };
  const PAD_DEAD = 0.35;   // stick deflection that counts as a press
  const PAD_LOOK = 12;     // gym camera: right-stick deflection (squared) -> mouse pixels per frame
  const PAD_START = 9, PAD_B = 1, PAD_A = 0;
  const Pad = { held: 0, prev: null, index: -1, active: false, nav: 0, edit: null }; // active = the pad was used more recently than the keyboard (hints show pad names); nav = frames a menu direction has been held
  function padName(code) { return code ? (PAD_NAMES[code] || code) : '\u2014'; }
  const KEY_NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'SPACE', ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT', ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL', AltLeft: 'L-ALT', AltRight: 'R-ALT', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Enter: 'ENTER', Tab: 'TAB', Backspace: 'BKSP', CapsLock: 'CAPS', Backquote: '`', NumpadEnter: 'NUM ENTER', NumpadAdd: 'NUM +', NumpadSubtract: 'NUM -', NumpadMultiply: 'NUM *', NumpadDivide: 'NUM /', NumpadDecimal: 'NUM .' };
  function keyName(code) {
    if (!code) return '—';
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
    return code.toUpperCase();
  }
  function defaultBinds() { const b = {}; for (const a of ACTIONS) b[a.id] = a.def.slice(); return b; }
  function defaultPad() { const b = {}; for (const a of ACTIONS) b[a.id] = PAD_DEFAULT[a.id] || ''; return b; }
  function loadControls() {
    Controls.binds = defaultBinds(); Controls.pad = defaultPad();
    Controls.moveset = normalizeMoveset(DEFAULT_MOVESET);
    try {
      const b = JSON.parse(localStorage.getItem('cr_binds') || 'null');
      if (b) for (const a of ACTIONS) if (Array.isArray(b[a.id])) Controls.binds[a.id] = [String(b[a.id][0] || ''), String(b[a.id][1] || '')];
      const g = JSON.parse(localStorage.getItem('cr_pad') || 'null');
      if (g) for (const a of ACTIONS) if (typeof g[a.id] === 'string') Controls.pad[a.id] = g[a.id];
      const m = JSON.parse(localStorage.getItem('cr_moveset') || 'null');
      if (m) Controls.moveset = normalizeMoveset(m);
    } catch (_) {}
    rebuildKeyMap();
  }
  function syncGymMoveset() { if (App.gym && App.gym.active) App.gym.setMoveset(Controls.moveset); }
  function saveControls() {
    try { localStorage.setItem('cr_binds', JSON.stringify(Controls.binds)); localStorage.setItem('cr_pad', JSON.stringify(Controls.pad)); localStorage.setItem('cr_moveset', JSON.stringify(Controls.moveset)); } catch (_) {}
    rebuildKeyMap(); syncGymMoveset();
  }
  function rebuildKeyMap() {
    Controls.keyMap = {};
    for (const a of ACTIONS) for (const c of Controls.binds[a.id]) if (c) Controls.keyMap[c] = (Controls.keyMap[c] | 0) | a.bit;
  }
  loadControls();

  const App = {
    mode: null, net: null, sim: null, renderer: null, audio: new Audio(), brain: null,
    myIdx: 0, held: 0, pressed: 0, remote: { h: 0, p: 0 },
    lobby: { picks: ['striker', 'wrestler'], names: ['', ''], ready: [false, false], settings: { rounds: 3, len: 180, diff: 0.55, grappling: false }, cpuPick: 'random', movesets: [null, null], looks: [null, null] },
    optionsOpen: false, paused: false,
    state: null, playing: false, lastSnap: 0, lastInputSend: 0, evQueue: [], rematch: [false, false],
    feedLines: [], hintsHidden: true, gFlash: null
  };

  // ---------- playtest feedback: where SEND FEEDBACK goes ----------
  // endpoint: the Google Apps Script web app in tools/feedback-sheet.gs; every report lands as a row in the dev's sheet.
  // Apps Script only takes cross-origin POSTs as text/plain (no preflight); it parses the JSON body on its side.
  const FEEDBACK = { endpoint: 'https://script.google.com/macros/s/AKfycbw9oMRVcbESqB-gtSHNlm1gg12Y10b9X3mToQ3Mc5Sjo29jzf3qqdo_Dc7LgPxw2ep1pA/exec', subject: 'Cage Rules feedback' };
  const Diag = { errors: [], started: Date.now() }; // the last few script errors ride along with every report
  function logErr(m) { Diag.errors.push(new Date().toISOString().slice(11, 19) + ' ' + String(m).slice(0, 200)); if (Diag.errors.length > 8) Diag.errors.shift(); Analytics.track('client_error', { message: String(m).slice(0, 200), where: whereAmI() }); }
  window.addEventListener('error', (e) => logErr((e.message || 'error') + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : '')));
  window.addEventListener('unhandledrejection', (e) => logErr('promise: ' + (e.reason && (e.reason.message || e.reason))));

  // practice (you vs CPU), watch (CPU vs CPU), career and the striking tutorial run the sim locally with no network
  const isLocal = () => App.mode === 'practice' || App.mode === 'watch' || App.mode === 'career' || App.mode === 'tutorial';
  // a roster key that arrived over the network (an own key: '__proto__' or 'toString' must not pass)
  const isFighter = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(ROSTER, k);

  // ---------- your fighter: the look (hair / beard / build / colours, skin, trunks) used in practice and online fights ----------
  // Career fighters carry their own look on the save; this one lives beside it and is optional (none = a random body).
  const PROFILE_KEY = 'cr_fighter';
  const Profile = {
    cache: undefined,
    get() {
      if (this.cache !== undefined) return this.cache;
      try { this.cache = this.clean(JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null')); } catch (_) { this.cache = null; }
      return this.cache;
    },
    set(p) { this.cache = this.clean(p); try { if (this.cache) localStorage.setItem(PROFILE_KEY, JSON.stringify(this.cache)); else localStorage.removeItem(PROFILE_KEY); } catch (_) {} return this.cache; },
    // a complete profile from anything (a save, the other player's machine), or null
    clean(p) {
      if (!p || typeof p !== 'object') return null;
      return { look: Career.normalizeLook(p.look), skin: typeof p.skin === 'number' ? p.skin : Career.SKINS[0], color: typeof p.color === 'number' ? p.color : Career.COLORS[0] };
    },
    // what a fighter with no profile gets: a fresh random body every fight
    random() { return { look: Career.randomLook(), skin: Career.SKINS[(Math.random() * Career.SKINS.length) | 0], color: undefined }; }
  };
  function applyProfile(p, prof) { prof = prof || Profile.random(); p.look = prof.look; p.skin = prof.skin; if (prof.color != null) p.color = prof.color; }

  function fighterSelect(id, sel, random) {
    return '<select id="' + id + '">' + (random ? '<option value="random"' + (sel === 'random' ? ' selected' : '') + '>Random</option>' : '') +
      Object.keys(ROSTER).map(k => '<option value="' + k + '"' + (sel === k ? ' selected' : '') + '>' + ROSTER[k].name + ' (' + ROSTER[k].style + ')</option>').join('') + '</select>';
  }

  // ============================================================
  //  UI helpers
  // ============================================================
  let toastT = null;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; show(t);
    clearTimeout(toastT); toastT = setTimeout(() => hide(t), ms || 3500);
  }
  function screen(name) {
    Analytics.track('screen_view', { screen: name || 'fight', mode: App.mode });
    // leaving the walkable gym for anything but one of its own station panels tears the room down
    if (App.gym && App.gym.active && name !== 'career') exitGym(name === null); // screen(null) = a fight is taking the scene
    hide($('#gymHud'));
    for (const id of ['menu', 'lobby', 'end', 'career', 'careerNew', 'more']) { const el = $('#' + id); if (el && id === name) show(el); else if (el) hide(el); }
    if (App.optionsOpen) closeOptions();
    if (name) hide($('#hud')); else show($('#hud'));
    syncHint();
    if (name === 'menu') refreshMenuCareer();
    if (!name || name === 'end') App.audio.play('fight');
    else App.audio.stop();
  }
  function centerMsg(html, ms) {
    const el = $('#centerMsg'); el.innerHTML = html; el.classList.add('show');
    clearTimeout(centerMsg._t);
    if (ms) centerMsg._t = setTimeout(() => el.classList.remove('show'), ms);
  }
  function hideCenter() { $('#centerMsg').classList.remove('show'); }

  function statBar(label, v) { return '<div class="stat"><span>' + label + '</span><div class="sb"><i style="width:' + Math.round(v * 100) + '%"></i></div></div>'; }
  function buildRoster() {
    const el = $('#roster'); el.innerHTML = '';
    for (const key in ROSTER) {
      const r = ROSTER[key];
      const c = document.createElement('div'); c.className = 'card'; c.dataset.key = key; c.tabIndex = 0; // focusable so a controller can pick it
      c.innerHTML = '<div class="swatch" style="background:#' + r.color.toString(16).padStart(6, '0') + '"></div>' +
        '<div class="cname">' + r.name + '</div><div class="cstyle">' + r.style + ' · "' + r.nick + '"</div><div class="cdesc">' + r.desc + '</div>' +
        statBar('POW', r.stats.pow) + statBar('SPD', r.stats.spd) + statBar('CHIN', r.stats.chin) + statBar('WRE', r.stats.wre) + statBar('BJJ', r.stats.bjj) + statBar('CAR', r.stats.car);
      c.onclick = () => { if (App.lobby.ready[App.myIdx]) return; App.lobby.picks[App.myIdx] = key; refreshLobby(); sendPick(); };
      el.appendChild(c);
    }
  }
  function refreshLobby() {
    const L = App.lobby, me = App.myIdx, opp = 1 - me;
    document.querySelectorAll('.card').forEach(c => {
      c.classList.toggle('sel', c.dataset.key === L.picks[me]);
      c.classList.toggle('opp', !isLocal() && c.dataset.key === L.picks[opp]);
    });
    const isHost = App.mode !== 'guest';
    $('#settingsBox').style.display = isHost ? '' : 'none';
    $('#diffWrap').style.display = isLocal() ? '' : 'none';
    $('#nameInput').parentElement.style.display = App.mode === 'watch' ? 'none' : '';
    $('#codeBox').classList.toggle('hidden', App.mode !== 'host');
    const st = $('#lobbyStatus');
    const rules = L.settings.grappling === false ? ' · STRIKING ONLY' : '';
    if (App.mode === 'practice') { st.textContent = 'Pick your fighter, then hit READY.' + rules; }
    else if (App.mode === 'watch') { st.textContent = 'Pick the red corner\'s fighter above and the blue corner\'s below, then hit READY to watch.' + rules; }
    else if (App.mode === 'host') {
      st.textContent = (App.net && App.net.connected ? (L.ready[opp] ? 'Opponent is READY.' : 'Opponent connected — picking a fighter...') : 'Share the room code. Waiting for an opponent to join...') + rules;
    } else {
      st.textContent = (L.ready[opp] ? 'Host is READY.' : 'Connected. Host is picking a fighter...') + rules;
    }
    const op = $('#oppPick');
    if (isLocal()) {
      if (App.mode === 'practice') {
        op.innerHTML = '<div class="pick-row">CPU opponent: ' + fighterSelect('cpuPick', L.cpuPick, true) + '</div>' +
          '<div class="pick-note">The CPU plays at the CPU level set above.</div>';
      } else {
        op.innerHTML = '<div class="pick-row"><span class="corner red">RED</span> ' + ROSTER[L.picks[0]].name + '</div>' +
          '<div class="pick-row"><span class="corner blue">BLUE</span> ' + fighterSelect('cpuPick', L.cpuPick, true) + '</div>' +
          '<div class="pick-note">Both corners are the CPU, playing at the CPU level above.</div>';
      }
      $('#cpuPick').onchange = (e) => { App.lobby.cpuPick = e.target.value; };
    } else {
      const on = L.names[opp] || (opp === 0 ? 'Host' : 'Guest');
      op.textContent = App.net && App.net.connected ? on + ' picked ' + ROSTER[L.picks[opp]].name + (L.ready[opp] ? ' ✓' : '') : '';
    }
    $('#lookLine').classList.toggle('hidden', App.mode === 'watch');
    $('#lookLineTxt').textContent = Profile.get() ? 'Your fighter: custom look' : 'Your fighter: random look each fight';
    $('#btnLobbyLook').disabled = !!L.ready[me];
    const rb = $('#btnReady');
    rb.textContent = L.ready[me] ? 'WAITING...' : 'READY';
    rb.disabled = L.ready[me] || (!isLocal() && !(App.net && App.net.connected));
    $('#lobbyTitle').textContent = App.mode === 'practice' ? 'PRACTICE' : App.mode === 'watch' ? 'AI vs AI' : App.mode === 'host' ? 'HOST — FIGHTER SELECT' : 'GUEST — FIGHTER SELECT';
  }

  // ============================================================
  //  Lobby / netcode
  // ============================================================
  function readSettings() {
    App.lobby.settings.rounds = parseInt($('#selRounds').value, 10);
    App.lobby.settings.len = parseInt($('#selLen').value, 10);
    App.lobby.settings.diff = parseFloat($('#selDiff').value);
    App.lobby.settings.grappling = $('#selGrapple').value !== '0';
  }
  function myName() { return ($('#nameInput').value || '').trim().slice(0, 14); }

  function sendPick() {
    if (App.mode === 'host') App.net.send({ t: 'lobby', picks: App.lobby.picks, names: App.lobby.names, ready: App.lobby.ready, settings: App.lobby.settings });
    else if (App.mode === 'guest') App.net.send({ t: 'pick', fighter: App.lobby.picks[1], name: myName(), ready: App.lobby.ready[1], moveset: Controls.moveset, profile: Profile.get() });
  }

  function enterLobby(mode) {
    Analytics.track('lobby_enter', { mode });
    App.mode = mode; App.myIdx = mode === 'guest' ? 1 : 0;
    App.lobby.ready = [false, false]; App.rematch = [false, false];
    buildRoster(); screen('lobby'); refreshLobby();
  }

  function startHost() {
    if (App.net) App.net.destroy(); // a join still connecting must not keep running behind the new room
    App.net = new Net({
      onReady: (code) => { $('#codeLbl').textContent = code; refreshLobby(); },
      onConnect: () => { toast('Opponent connected!'); Analytics.track('online_connected', { role: 'host' }); App.lobby.names[0] = myName(); sendPick(); refreshLobby(); },
      onData: onHostData,
      onClose: () => { onOpponentLeft(); },
      onError: (m) => { toast(m, 6000); Analytics.track('online_error', { role: 'host', message: String(m).slice(0, 200) }); }
    });
    Analytics.track('online_host');
    App.net.host();
    enterLobby('host');
    $('#codeLbl').textContent = '…';
  }
  function startJoin(code) {
    if (App.net) App.net.destroy();
    const net = App.net = new Net({
      onConnect: () => { toast('Connected to room ' + net.code); Analytics.track('online_connected', { role: 'guest' }); enterLobby('guest'); App.lobby.names[1] = myName(); sendPick(); },
      onData: onGuestData,
      onClose: () => { onOpponentLeft(); },
      // a failed join drops its own Net — never a newer one that took App.net since
      onError: (m) => { toast(m, 6000); Analytics.track('online_error', { role: 'guest', message: String(m).slice(0, 200) }); if (App.net === net && !net.connected) { net.destroy(); App.net = null; } }
    });
    Analytics.track('online_join');
    net.join(code);
    toast('Connecting to ' + code + '…', 8000);
  }
  function onOpponentLeft() {
    toast('Opponent disconnected.', 5000);
    Analytics.track('online_opponent_left', { mode: App.mode, in_fight: App.playing && !(App.state && App.state.result) });
    stopFight(); if (App.net) { App.net.destroy(); App.net = null; }
    App.mode = null; screen('menu');
  }

  // Everything below arrives from the other player's machine, which may not be running this code: fields are
  // type-checked and rebuilt before use, and whatever reaches innerHTML later is escaped there.
  function onHostData(d) {
    switch (d.t) {
      case 'pick':
        App.lobby.picks[1] = isFighter(d.fighter) ? d.fighter : 'balanced';
        App.lobby.names[1] = String(d.name || '').slice(0, 14);
        App.lobby.ready[1] = !!d.ready;
        App.lobby.movesets[1] = normalizeMoveset(d.moveset);
        App.lobby.looks[1] = Profile.clean(d.profile);
        refreshLobby(); sendPick(); maybeStart(); break;
      case 'in':
        App.remote.h = (d.h | 0) & SIM_MASK; App.remote.p |= (d.p | 0) & SIM_MASK; break;
      case 'say': {
        // the cleaned line is what gets echoed back; a flood is dropped here, on the machine running the fight
        const m = cleanLine(d.m), now = performance.now();
        if (!m || now - guestSayT < SAY_GAP_MS) break;
        guestSayT = now;
        showLine(1, m);
        if (App.net) App.net.send({ t: 'say', i: 1, m });
        break;
      }
      case 'rematch':
        App.rematch[1] = true; toast('Opponent wants a rematch!'); maybeRematch(); break;
    }
  }
  function onGuestData(d) {
    switch (d.t) {
      case 'lobby': {
        const s = d.settings;
        if (!Array.isArray(d.picks) || !Array.isArray(d.names) || !Array.isArray(d.ready) || !s || typeof s !== 'object') break;
        App.lobby.picks[0] = isFighter(d.picks[0]) ? d.picks[0] : 'balanced';
        App.lobby.names[0] = String(d.names[0] || '').slice(0, 14);
        App.lobby.ready[0] = !!d.ready[0];
        App.lobby.settings = { rounds: s.rounds | 0, len: s.len | 0, grappling: s.grappling !== false, diff: App.lobby.settings.diff };
        $('#selRounds').value = App.lobby.settings.rounds; $('#selLen').value = App.lobby.settings.len; $('#selGrapple').value = App.lobby.settings.grappling ? '1' : '0';
        refreshLobby(); break;
      }
      case 'start': {
        const msg = cleanStart(d);
        if (msg) beginFight(msg);
        break;
      }
      case 's': {
        const S = d.s;
        if (!S || !Array.isArray(S.f) || S.f.length !== 2 || !S.f.every(f => f && typeof f === 'object')) break;
        for (const f of S.f) f.name = String(f.name == null ? '' : f.name).slice(0, 24);
        App.state = S; App.lastSnap = performance.now();
        if (Array.isArray(d.ev) && d.ev.length) processEvents(d.ev, App.state);
        break;
      }
      case 'say':
        showLine(d.i === 1 ? 1 : 0, d.m);
        break;
    }
  }
  // the host's 'start', rebuilt from checked fields: two known fighters, short string names, settings in range
  function cleanStart(d) {
    const s = d.settings;
    if (!Array.isArray(d.players) || d.players.length !== 2 || !s || typeof s !== 'object') return null;
    const players = d.players.map((p) => {
      p = p && typeof p === 'object' ? p : {};
      return { fighter: isFighter(p.fighter) ? p.fighter : 'balanced', name: String(p.name || '').slice(0, 24), color: typeof p.color === 'number' ? p.color : undefined, moveset: p.moveset, skin: typeof p.skin === 'number' ? p.skin : undefined, look: p.look && typeof p.look === 'object' ? Career.normalizeLook(p.look) : undefined };
    });
    return { t: 'start', seed: d.seed | 0, players, settings: { rounds: Math.min(5, Math.max(1, s.rounds | 0)), len: Math.min(300, Math.max(60, s.len | 0)), grappling: s.grappling !== false } };
  }

  function maybeStart() {
    if (isLocal()) { if (App.lobby.ready[0]) launchHostFight(); return; }
    if (App.mode === 'host' && App.lobby.ready[0] && App.lobby.ready[1]) launchHostFight();
  }
  function maybeRematch() {
    if (isLocal() && App.rematch[0]) launchHostFight();
    if (App.mode === 'host' && App.rematch[0] && App.rematch[1]) launchHostFight();
  }

  function launchHostFight() {
    readSettings();
    const L = App.lobby;
    let p1 = L.picks[1];
    if (isLocal()) { p1 = L.cpuPick === 'random' ? Object.keys(ROSTER)[Math.floor(Math.random() * 4)] : L.cpuPick; }
    const players = [
      { fighter: L.picks[0], name: App.mode === 'watch' ? ROSTER[L.picks[0]].name + ' (CPU)' : (L.names[0] || myName() || ROSTER[L.picks[0]].name), moveset: App.mode === 'watch' ? DEFAULT_MOVESET : Controls.moveset },
      { fighter: p1, name: isLocal() ? ROSTER[p1].name + ' (CPU)' : (L.names[1] || ROSTER[p1].name), moveset: isLocal() ? DEFAULT_MOVESET : (L.movesets[1] || DEFAULT_MOVESET) }
    ];
    // looks: a human wears their own fighter (none saved = random); the CPU gets a fresh random body every fight
    applyProfile(players[0], App.mode === 'watch' ? null : Profile.get());
    applyProfile(players[1], App.mode === 'host' ? L.looks[1] : null);
    // same trunks -> alternate the blue corner's colour so they're distinguishable
    const trunks = (p) => p.color != null ? p.color : ROSTER[p.fighter].color;
    if (trunks(players[0]) === trunks(players[1])) players[1].color = trunks(players[0]) === 0x8e44ad ? 0x1e88e5 : 0x8e44ad;
    const msg = { t: 'start', seed: (Math.random() * 1e9) | 0, players, settings: { rounds: L.settings.rounds, len: L.settings.len, grappling: L.settings.grappling !== false } };
    if (App.mode === 'host') App.net.send(msg);
    beginFight(msg);
  }

  // ============================================================
  //  Fight lifecycle
  // ============================================================
  function ensureRenderer() {
    if (!App.renderer) App.renderer = new Renderer($('#gl'));
    return App.renderer;
  }

  function beginFight(msg) {
    App.audio.init();
    const isHost = App.mode !== 'guest';
    // the physics engine (lib/rapier3d-compat.js, ~4 MB) loads in the background; the host needs it
    if (isHost && window.MMAPhys && !MMAPhys.ready() && !App.physFailed) {
      toast('Loading physics…', 4000);
      window.addEventListener('mmaphys', () => beginFight(msg), { once: true });
      return;
    }
    if (isHost && App.physFailed) return; // the host needs physics to run a fight; the failure toast was already shown
    if (App.sim) App.sim.destroy();
    if (App.mode !== 'tutorial') tutorStop();
    clearTimeout(App.endT); App.endT = 0;
    App.sim = null; App.state = null; App.evQueue = []; App.remote = { h: 0, p: 0 }; App.rematch = [false, false]; App.endTracked = false;
    App.lobby.ready = [false, false];
    if (isHost) {
      App.sim = new Sim({ seed: msg.seed, rounds: msg.settings.rounds, roundLen: msg.settings.len, players: msg.players, grappling: msg.settings.grappling !== false });
      App.state = App.sim.state;
      const diff = App.lobby.settings.diff;
      App.brain = App.mode === 'tutorial' ? Tutor.brain : isLocal() ? new CpuBrain(1, diff) : null;
      // watch mode: the CPU drives the red corner too. ?auto=1 in practice: the CPU also drives your fighter (testing aid)
      App.autoPilot = App.mode === 'watch' ? new CpuBrain(0, diff)
        : App.mode === 'practice' && /[?&]auto=1/.test(location.search) ? new CpuBrain(0, diff) : null;
    } else {
      // placeholder state until the first snapshot arrives
      const tmp = new Sim({ seed: msg.seed, rounds: msg.settings.rounds, roundLen: msg.settings.len, players: msg.players, physics: false, grappling: msg.settings.grappling !== false });
      App.state = tmp.state;
    }
    const R = ensureRenderer();
    R.setFighters(App.state);
    R.posLerp = isHost ? 18 : 10;
    App.feedLines = []; $('#feed').innerHTML = '';
    $('#fp0 .nm').textContent = App.state.f[0].name; $('#fp1 .nm').textContent = App.state.f[1].name;
    $('#fp0 .tag').textContent = App.mode === 'watch' ? 'CPU' : App.myIdx === 0 ? 'YOU' : 'P1';
    $('#fp1 .tag').textContent = App.myIdx === 1 ? 'YOU' : App.mode === 'career' ? 'OPP' : (isLocal() ? 'CPU' : 'P2');
    screen(null);
    App.playing = true;
    App.fightT0 = Date.now();
    Analytics.fightStarted();
    Analytics.track('fight_start', Object.assign(fightProps(), {
      p1: msg.players[0].fighter, p2: msg.players[1].fighter, p1_name: App.state.f[0].name, p2_name: App.state.f[1].name,
      rounds: msg.settings.rounds, round_len: msg.settings.len, grappling: msg.settings.grappling !== false,
      difficulty: isLocal() ? App.lobby.settings.diff : null, input: Pad.active ? 'gamepad' : 'keyboard'
    }));
    syncHint();
    App.audio.setCrowd(0.06);
    centerMsg('ROUND 1<small>' + esc(App.state.f[0].name) + ' vs ' + esc(App.state.f[1].name) + (App.state.grappling === false ? ' · striking only' : '') + '</small>', 2600);
  }

  // what every fight event carries: the mode, who the player is, and how far in the fight is
  function fightProps() {
    const S = App.state;
    return { mode: App.mode, my_idx: App.myIdx, round: S ? S.round : null, clock: S ? Math.round(S.clock) : null, fight_sec: App.fightT0 ? Math.round((Date.now() - App.fightT0) / 1000) : null };
  }
  const statProps = (prefix, s) => { const o = {}; for (const k of ['thrown', 'landed', 'blocked', 'sig', 'td', 'tdAtt', 'ctrl', 'subs', 'kd']) o[prefix + '_' + k] = Math.round(s[k] || 0); return o; };
  function stopFight() { if (App.playing && !(App.state && App.state.result)) Analytics.track('fight_quit', fightProps()); clearTimeout(App.endT); App.endT = 0; App.playing = false; App.paused = false; if (App.sim) App.sim.destroy(); App.sim = null; App.audio.setCrowd(0); hideCenter(); $('#grapple').classList.remove('show'); tutorStop(); }

  function showEnd(S) {
    const R = S.result; if (!R) return;
    if (!App.endTracked) {
      App.endTracked = true;
      const mine = App.mode === 'watch' ? null : R.winner == null ? 'draw' : R.winner === App.myIdx ? 'win' : 'loss';
      Analytics.track('fight_end', Object.assign(fightProps(), { method: R.method, winner: R.winner, result: mine, end_round: R.round, end_time: R.time, p1_name: S.f[0].name, p2_name: S.f[1].name }, statProps('p1', S.f[0].ts), statProps('p2', S.f[1].ts)));
      if (mine) Analytics.person({ ['last_' + mine]: new Date().toISOString() });
    }
    const w = R.winner == null ? null : S.f[R.winner];
    $('#endMethod').textContent = R.method.toUpperCase() + (!/Decision|Draw/.test(R.method) ? ' · ROUND ' + R.round + ' · ' + R.time : '');
    $('#endWinner').textContent = w ? w.name + ' WINS' : 'DRAW';
    $('#endWinner').style.color = w ? (App.mode === 'watch' ? '#fff' : R.winner === App.myIdx ? '#52d273' : '#e23b3b') : '#fff';
    $('#endDetail').textContent = w ? (App.mode === 'watch' ? '' : R.winner === App.myIdx ? 'Victory.' : 'Defeat.') : 'The judges could not separate them.';
    // scorecards (online, S is the host's snapshot: counts are forced to numbers and names escaped for innerHTML)
    let h = '<tr><th>Judges</th>' + S.cards.map(c => '<th>R' + (c.round | 0) + '</th>').join('') + '<th>Total</th></tr>';
    for (let j = 0; j < 3; j++) {
      let a = 0, b = 0;
      h += '<tr><td>Judge ' + (j + 1) + '</td>' + S.cards.map(c => { const x = c.j[j][0] | 0, y = c.j[j][1] | 0; a += x; b += y; return '<td>' + x + '–' + y + '</td>'; }).join('') + '<td><b>' + a + '–' + b + '</b></td></tr>';
    }
    $('#cards').innerHTML = h;
    // totals use ts alone: after a stoppage the last round's rs is already folded into ts, so adding rs double-counts
    const ts = S.f.map(f => f.ts);
    const row = (lbl, fn) => '<tr><td>' + lbl + '</td><td>' + fn(ts[0]) + '</td><td>' + fn(ts[1]) + '</td></tr>';
    $('#totals').innerHTML = '<tr><th></th><th>' + esc(S.f[0].name) + '</th><th>' + esc(S.f[1].name) + '</th></tr>' +
      row('Strikes landed / blocked / thrown', s => (s.landed | 0) + ' / ' + (s.blocked | 0) + ' / ' + (s.thrown | 0)) + row('Damage dealt', s => Math.round(s.sig)) +
      row('Takedowns', s => (s.td | 0) + ' / ' + (s.tdAtt | 0)) + row('Control time', s => Math.round(s.ctrl) + 's') + row('Submission attempts', s => s.subs | 0) + row('Knockdowns', s => s.kd | 0);
    $('#btnRematch').textContent = 'REMATCH'; $('#btnRematch').disabled = false;
    if (App.mode === 'tutorial') {
      $('#endDetail').textContent = 'Tutorial complete. ' + (w ? (R.winner === 0 ? 'You finished the sparring round on top.' : 'The sparring partner got the better of you this time.') : 'Nothing between you and the sparring partner.') + ' Practice vs CPU is the next step.';
      $('#btnRematch').textContent = 'RUN IT AGAIN';
    }
    if (App.mode === 'career') {
      settleCareerFight();
      const lf = CareerUI.C && CareerUI.C.lastFight;
      if (lf) $('#endDetail').textContent = (w ? (R.winner === 0 ? 'Victory. ' : 'Defeat. ') : '') + 'Paid ' + Career.fmtMoney(lf.pay) + ' · popularity ' + (lf.dPop >= 0 ? '+' : '') + lf.dPop + (lf.titleNote ? ' · ' + lf.titleNote : '');
      $('#btnRematch').textContent = 'BACK TO THE GYM';
    }
    screen('end');
  }

  // ============================================================
  //  Events -> feed / audio / fx
  // ============================================================
  function feed(text, big) {
    if (!text) return;
    const el = $('#feed'); const d = document.createElement('div'); d.textContent = text; if (big) d.className = 'big';
    el.insertBefore(d, el.firstChild);
    while (el.children.length > 5) el.removeChild(el.lastChild);
  }
  function processEvents(evs, S) {
    const R = App.renderer, A = App.audio;
    for (const ev of evs) {
      R && R.handleEvent(ev, S);
      if (Tutor.active) tutorEvent(ev);
      const text = describe(ev, S);
      switch (ev.k) {
        case 'hit': A.hit(ev.big || ev.rocked, ev.part); feed(text, ev.big || ev.rocked || ev.counter); break;
        case 'block': A.block(); if (ev.checked || Math.random() < 0.35) feed(text); break;
        case 'push': if (ev.ok) { A.block(); feed(text); } else A.whiff(); break;
        case 'miss': A.whiff(); if (ev.slipped) feed(text); break;
        case 'slip': feed(text); break;
        case 'kd': A.slam(); centerMsg('KNOCKDOWN!', 1400); feed(text, true); break;
        case 'follow': A.slam(); feed(text, true); break;
        case 'getup': case 'stance': feed(text); break;
        case 'td': A.slam(); feed(text, true); break;
        case 'sweep': A.slam(); feed(text, true); break;
        case 'tdfail': case 'shoot': case 'standup': case 'subfail': feed(text); break;
        case 'sub': A.roar(0.2); feed(text, true); break;
        case 'gattempt': feed(text); break;
        case 'gread': {
          // the read window closed: a flash on the ground panel for whoever had to read it (ev.i = the reader)
          const mineRead = ev.i === App.myIdx, txt = ev.res === 'denied' ? (mineRead ? 'READ IT!' : 'THEY READ IT') : ev.res === 'wrong' ? (mineRead ? 'WRONG WAY' : 'THEY GUESSED WRONG') : (mineRead ? 'TOO LATE' : 'IT LANDS');
          App.gFlash = { at: performance.now(), txt };
          if (ev.res === 'denied') A.block();
          break;
        }
        case 'gresult': if (ev.ok) { A.slam(); feed(text, !!(ev.flip || ev.stand)); } else { if (ev.flip) A.slam(); else A.block(); feed(text, !!ev.flip); } break;
        case 'subcrank': if (ev.ok) { A.hit(false, 'body'); feed(text); } else { A.block(); feed(text); } break;
        case 'refwarn': feed(text); break;
        case 'subescape': A.whistle(); feed(text, true); break;
        case 'tap': A.tap(); feed(text, true); break;
        case 'ko': A.horn(); feed(text, true); break;
        case 'bell':
          if (ev.end) { A.bell(2); centerMsg('END OF ROUND ' + (ev.round | 0), 2500); if (App.state) Analytics.track('round_end', Object.assign(fightProps(), { round: ev.round | 0 }, statProps('p1', App.state.f[0].rs), statProps('p2', App.state.f[1].rs))); }
          else { A.bell(1); centerMsg('FIGHT!', 900); }
          feed(text); break;
        case 'round': centerMsg('ROUND ' + (ev.round | 0), 2200); break;
        case 'end': {
          // no centre-screen result here: the ref announces the winner in the hand-raise, and the end screen follows
          const res = ev.res;
          if (res.method.indexOf('Decision') >= 0 || res.method.indexOf('Draw') >= 0) A.bell(3);
          // after the referee has raised the winner's hand
          clearTimeout(App.endT);
          App.endT = setTimeout(() => { App.endT = 0; if (App.state && App.state.result) showEnd(App.state); }, window.MMARender.ceremonyEnd(res) * 1000);
          break;
        }
      }
    }
  }

  // ============================================================
  //  HUD
  // ============================================================
  function pct(v) { return Math.max(0, Math.min(100, v)) + '%'; }
  const bindName = id => Pad.active && Controls.pad[id] ? padName(Controls.pad[id]) : keyName(Controls.binds[id][0]); // hints name whichever device was used last
  const kn = bindName;
  function dmgColor(d) { const h = 120 - d * 1.2; return 'hsla(' + h + ',70%,' + (25 + d * 0.3) + '%,' + (0.35 + d / 150) + ')'; }
  function updateHUD(S, inputs) {
    inputs = inputs || [0, 0];
    for (let i = 0; i < 2; i++) {
      const f = S.f[i], p = $('#fp' + i);
      const hp = 100 - f.dmg.head;
      const fill = p.querySelector('.hp .fill'); fill.style.width = pct(hp); fill.className = 'fill' + (hp < 25 ? ' crit' : hp < 50 ? ' low' : '');
      p.querySelector('.hp .ghost').style.width = pct(hp);
      p.querySelector('.st .fill').style.width = pct(f.stam);
      p.querySelector('.st .max').style.width = pct(f.stamMax != null ? f.stamMax : 100);
      const dm = p.querySelectorAll('.d');
      for (const el of dm) { const k = el.classList.contains('head') ? 'head' : el.classList.contains('body') ? 'body' : 'legs'; el.style.background = dmgColor(f.dmg[k]); el.style.color = f.dmg[k] > 40 ? '#fff' : ''; }
      const st = p.querySelector('.status');
      let txt = '', cls = 'status';
      if (f.act.type === 'down') txt = 'OUT';
      else if (f.act.type === 'kd') { txt = f.act.name === 'rise' ? 'GETTING UP' : 'DOWN'; cls += ' rocked'; }
      else if (f.rocked > 0) { txt = 'ROCKED'; cls += ' rocked'; }
      else if (f.ground === 'top') txt = 'TOP';
      else if (f.ground === 'bottom') txt = 'BOTTOM';
      else if (f.blocking) txt = (inputs[f.idx] & IN.MOD3) ? 'BODY BLOCK' : 'BLOCK';
      else if (f.act.type === 'push') txt = 'PUSH';
      else if (f.stam < 22) txt = 'GASSED';
      st.textContent = txt; st.className = cls;
    }
    $('#roundLbl').textContent = App.paused ? 'PAUSED' : S.phase === 'break' ? 'BREAK ' + Math.ceil(BREAK_T - S.phaseT) : 'ROUND ' + S.round + '/' + S.rounds;
    const c = Math.max(0, S.clock); $('#clock').textContent = Math.floor(c / 60) + ':' + String(Math.floor(c % 60)).padStart(2, '0');
    $('#pingLbl').textContent = App.net && App.net.connected ? App.net.ping + ' ms' : App.mode === 'practice' ? 'CPU' : App.mode === 'watch' ? 'AI vs AI' : App.mode === 'tutorial' ? 'TUTORIAL' : '';
    // knockdown prompt: the downed fighter chooses when to get up; the other may dive on him
    const kh = $('#kdHint');
    const me = S.f[App.myIdx], op = S.f[1 - App.myIdx];
    let kdTxt = '';
    if (S.phase === 'fight' && !S.ground && App.mode !== 'watch') {
      if (me.act.type === 'kd') {
        if (me.act.name === 'down') {
          const left = Math.max(0, KD.STAY - me.act.t);
          kdTxt = '<span class="t">YOU ARE DOWN</span><b>' + kn('fwd') + '</b> / any direction / <b>' + kn('dodge') + '</b> get up now (you come up rocked) · stay down to clear your head — ref waves you up in ' + left.toFixed(1) + 's';
        } else if (me.act.name === 'rise') kdTxt = '<span class="t">GETTING UP</span>Still rocked — cover up.';
      } else if (op.act.type === 'kd' && op.act.name !== 'rise' && S.grappling) {
        const dist = Math.hypot(op.x - me.x, op.z - me.z);
        kdTxt = '<span class="t">' + esc(String(op.name).toUpperCase()) + ' IS DOWN</span><b>' + kn('grapple') + '</b> dive on him' + (dist > KD.FOLLOW_DIST ? ' (get closer)' : '') + ' · back off to keep it standing — he comes up rocked';
      }
    }
    if (kdTxt) { kh.innerHTML = kdTxt; kh.classList.add('show'); } else kh.classList.remove('show');
    // ground panel: a compass of my moves (one per direction, submission in the middle). The opponent's move
    // lights up the cell in its direction while it can still be denied (GRAPPLE + that direction), with a shrinking
    // bar for the window; my own move fills its cell as it plays out. Cranks on a hold use the same compass.
    const g = $('#grapple');
    if (S.ground && S.phase === 'fight') {
      const G = S.ground, T = G.trans, sub = G.sub;
      const my = App.myIdx, op = 1 - my, meTop = G.top === my, role = meTop ? 'top' : 'bottom';
      const watch = App.mode === 'watch';
      g.classList.add('show'); g.classList.toggle('subbing', !!sub);
      g.classList.toggle('mom-me', G.mom[my] > 0); g.classList.toggle('mom-op', G.mom[op] > 0);
      const momTxt = G.mom[my] > 0 ? (watch ? ' · ' + S.f[my].name + ' has momentum' : ' · momentum') : G.mom[op] > 0 ? (watch ? ' · ' + S.f[op].name + ' has momentum' : ' · their momentum') : '';
      $('#gTitle').textContent = (POS_NAME[G.pos] + ' · ' + S.f[G.top].name + ' on top' + momTxt).toUpperCase();
      $('#gAdvMe').style.width = pct(G.adv[my]); $('#gAdvOp').style.width = pct(G.adv[op]);
      const incoming = sub ? (sub.crank && sub.att !== my ? sub.crank : null) : (T && T.by !== my ? T : null);
      const mine = sub ? null : (T && T.by === my ? T : null);
      const DK = { FWD: 'fwd', BACK: 'back', LEFT: 'left', RIGHT: 'right' };
      for (const cell of $('#gCompass').querySelectorAll('.g-cell')) {
        const dir = cell.dataset.dir;
        let key = '', name = '', cls = 'g-cell c-' + dir.toLowerCase();
        if (sub) {
          if (dir !== 'SUB') { if (sub.att === my) { key = kn(DK[dir]); name = 'crank'; cls += ' mine'; } else { key = kn(DK[dir]) + '+' + kn('grapple'); name = 'read a crank'; } }
        } else if (dir === 'SUB') {
          const subs = SUBS_BY[role][G.pos];
          if (subs.length) { key = kn('grapple'); name = subs.length > 1 ? 'submission' : subs[0]; cls += ' mine'; }
        } else {
          const mv = MOVES[role][G.pos][dir];
          if (mv) { key = kn(DK[dir]) + '+' + kn('grapple'); name = mv.name; cls += ' mine'; }
        }
        if (incoming && dir === incoming.dir && (incoming.res == null || sub)) {
          cls += ' in'; key = kn(DK[dir]) + '+' + kn('grapple');
          name = sub ? 'READ THE CRANK' : 'DENY ' + incoming.name.toUpperCase();
        }
        if (incoming && incoming.guess === dir) cls += incoming.guess === incoming.dir ? ' right' : ' guessed';
        if (mine && (mine.sub ? dir === 'SUB' : dir === mine.dir)) { cls += ' going'; }
        if (cell.className !== cls) cell.className = cls;
        const html = key ? '<b>' + esc(key) + '</b><span>' + esc(name) + '</span>' : '';
        if (cell.innerHTML !== html) cell.innerHTML = html;
      }
      // the read bar: their window shrinking (red), or my move playing out (gold)
      const rd = $('#gRead');
      if (incoming) {
        const open = incoming.t < incoming.win;
        rd.className = 'g-read show in';
        $('#gReadLbl').textContent = open ? (sub ? 'READ IT' : 'READ IT: ' + kn(DK[incoming.dir]) + ' + ' + kn('grapple')) : (incoming.res === 'denied' ? 'DENIED!' : incoming.res === 'wrong' ? 'WRONG WAY' : sub ? '' : 'TOO LATE');
        rd.querySelector('.fill').style.width = pct(open ? (1 - incoming.t / incoming.win) * 100 : 0);
      } else if (mine) {
        rd.className = 'g-read show mine';
        $('#gReadLbl').textContent = mine.res === 'denied' ? 'READ!' : mine.res ? (mine.sub ? 'LOCKING' : 'LANDS') : mine.name.toUpperCase();
        rd.querySelector('.fill').style.width = pct(mine.t / mine.dur * 100);
      } else rd.className = 'g-read';
      if (sub) {
        const mineAtt = sub.att === my;
        g.querySelector('.sub .fill').style.width = pct(sub.prog); $('#subName').textContent = sub.name.toUpperCase();
        $('#gState').textContent = (sub.squeezing ? 'SQUEEZING' : 'LOOSE') + (sub.defending ? ' · HAND FIGHTING' : '');
        $('#gHint').textContent = watch ? '' : mineAtt
          ? 'Hold ' + kn('grapple') + ' to squeeze (burns stamina) · tap a direction to crank: unread it tightens, read it loosens'
          : 'Hold ' + kn('block') + ' to fight the hands (slows it) · when a crank lights up, that direction + ' + kn('grapple') + ' loosens it · at 0 you are out';
      } else {
        const fl = App.gFlash;
        $('#gState').textContent = fl && performance.now() - fl.at < 900 ? fl.txt : '';
        const parts = [];
        if (role === 'top' || BOTTOM_CAN_STRIKE[G.pos]) parts.push(kn('lh') + '/' + kn('rh') + '/' + kn('ll') + '/' + kn('rl') + ' strike (builds advantage)');
        parts.push('hold ' + kn('block') + (role === 'top' ? ' posture' : ' cover') + ' · their move lights a direction: that direction + ' + kn('grapple') + ' denies it');
        if (role === 'top') parts.push(kn('dodge') + ' let them up');
        $('#gHint').textContent = watch ? '' : parts.join(' · ');
      }
    } else g.classList.remove('show');
  }

  // ============================================================
  //  Options panel (key bindings + strike mapping)
  // ============================================================
  let capture = null; // { act, slot, btn } while waiting for a key
  function buildOptions() {
    const kt = $('#keyTable');
    let h = '<tr><th>Action</th><th>Key</th><th>Alt</th><th>Pad</th></tr>';
    for (const a of ACTIONS) h += '<tr><td>' + a.label + '</td>' + [0, 1].map(i => '<td><button class="keybtn" data-act="' + a.id + '" data-slot="' + i + '">' + keyName(Controls.binds[a.id][i]) + '</button></td>').join('') + '<td><button class="keybtn pad" data-act="' + a.id + '" data-slot="2">' + padName(Controls.pad[a.id]) + '</button></td></tr>';
    kt.innerHTML = h;
    kt.querySelectorAll('.keybtn').forEach(b => b.onclick = () => startCapture(b.dataset.act, +b.dataset.slot, b));
    $('#padStatus').textContent = Pad.index >= 0 ? 'Controller connected. Click a Pad cell, then press a button or push a stick to rebind it. START opens this panel, A picks (and opens a dropdown or slider: d-pad changes it, A closes it), B backs out.' : 'No controller detected. Press any button on it to wake it up; Xbox, PlayStation and Steam Input pads all use the same layout.';
    const mt = $('#moveTable');
    h = '<tr><th>Hold</th>' + LIMBS.map(l => '<th>' + LIMB_NAME[l] + '<small>' + keyName(Controls.binds[l][0]) + '</small></th>').join('') + '</tr>';
    for (const m of MODS) {
      h += '<tr><td>' + (m === 'none' ? '<span class="muted">nothing</span>' : '<b>' + keyName(Controls.binds[m][0]) + '</b>') + '</td>';
      for (const l of LIMBS) {
        const kinds = (l === 'lh' || l === 'rh') ? HAND_KINDS : LEG_KINDS;
        h += '<td><select data-mod="' + m + '" data-limb="' + l + '">' + kinds.map(k => '<option value="' + k + '"' + (Controls.moveset[m][l] === k ? ' selected' : '') + '>' + KIND_LABEL[k] + '</option>').join('') + '</select></td>';
      }
      h += '</tr>';
    }
    mt.innerHTML = h;
    mt.querySelectorAll('select').forEach(sel => sel.onchange = () => { Controls.moveset[sel.dataset.mod][sel.dataset.limb] = sel.value; saveControls(); updateHint(); });
    document.querySelectorAll('#options b[data-mod]').forEach(b => { b.textContent = keyName(Controls.binds[b.dataset.mod][0]); });
    $('#optStatus').textContent = App.playing ? (isLocal() ? 'Fight paused. Changes apply instantly.' : 'Online: the fight keeps running while this is open. Strike changes apply next fight.') : 'Changes are saved automatically.';
    buildKeyboard();
  }

  // ---------- keyboard diagram (options panel), drawn from the live binds ----------
  const KB_CAT = { fwd: 'move', back: 'move', left: 'move', right: 'move', lh: 'strike', rh: 'strike', ll: 'strike', rl: 'strike', mod1: 'mod', mod2: 'mod', mod3: 'mod', block: 'def', dodge: 'def', check: 'def', grapple: 'grap', stance: 'misc', interact: 'misc', lock: 'misc' };
  const KB_SHORT = { fwd: 'In', back: 'Out', left: 'Left', right: 'Right', lh: 'L hand', rh: 'R hand', ll: 'L leg', rl: 'R leg', mod1: 'Mod 1', mod2: 'Mod 2', mod3: 'Mod 3', block: 'Block', dodge: 'Dash', check: 'Check', grapple: 'Takedown', stance: 'Stance', interact: 'Use', lock: 'Lock' };
  const KB_KIND = { straight: 'Straight', hook: 'Hook', uppercut: 'Upper', overhand: 'Overhd', teep: 'Teep', knee: 'Knee', bkick: 'Body kk', hkick: 'Head kk', lkick: 'Low kk' }; // fits a 1u cap
  const KB_LEGEND = [['move', 'Move'], ['strike', 'Strike'], ['mod', 'Modifier'], ['def', 'Defense'], ['grap', 'Grapple'], ['misc', 'Other'], ['sys', 'System']];
  const KB_CAP = { Escape: 'ESC', MetaLeft: 'WIN', MetaRight: 'WIN', ContextMenu: 'MENU', Backspace: '⌫' };
  const kbKeys = (pre, s) => s.split('').map(c => [pre + c, 1]);
  const KB_MAIN = [
    [['Escape', 1], [null, 14]],
    [['Backquote', 1], ...kbKeys('Digit', '1234567890'), ['Minus', 1], ['Equal', 1], ['Backspace', 2]],
    [['Tab', 1.5], ...kbKeys('Key', 'QWERTYUIOP'), ['BracketLeft', 1], ['BracketRight', 1], ['Backslash', 1.5]],
    [['CapsLock', 1.75], ...kbKeys('Key', 'ASDFGHJKL'), ['Semicolon', 1], ['Quote', 1], ['Enter', 2.25]],
    [['ShiftLeft', 2.25], ...kbKeys('Key', 'ZXCVBNM'), ['Comma', 1], ['Period', 1], ['Slash', 1], ['ShiftRight', 2.75]],
    [['ControlLeft', 1.5], ['MetaLeft', 1.25], ['AltLeft', 1.25], ['Space', 7], ['AltRight', 1.25], ['ContextMenu', 1.25], ['ControlRight', 1.5]]
  ];
  const KB_ARROWS = [[[null, 3]], [[null, 3]], [[null, 3]], [[null, 3]], [[null, 1], ['ArrowUp', 1], [null, 1]], [['ArrowLeft', 1], ['ArrowDown', 1], ['ArrowRight', 1]]];
  // keys main.js handles itself; H and M only when nothing is bound to them
  function kbFixed(code) {
    if (code === 'Escape') return ['Menu', 'Open / close options (pauses practice)'];
    if (code === 'Enter') return ['Chat', 'Open chat during a fight'];
    if (code === 'KeyH' && !Controls.keyMap.KeyH) return ['Hints', 'Show / hide the on-screen control hints'];
    if (code === 'KeyM' && !Controls.keyMap.KeyM) return ['Mute', 'Mute / unmute sound'];
    return null;
  }
  function buildKeyboard() {
    const host = $('#kbMap'); if (!host) return;
    const byCode = {};
    for (const a of ACTIONS) for (const c of Controls.binds[a.id]) if (c && !byCode[c]) byCode[c] = a;
    const placed = new Set();
    const cap = ([code, w]) => {
      if (!code) return '<div class="kk gap" style="flex:' + w + '"></div>';
      placed.add(code);
      const a = byCode[code], fx = kbFixed(code);
      const cat = a ? KB_CAT[a.id] : fx ? 'sys' : '';
      const label = a ? KB_SHORT[a.id] : fx ? fx[0] : '';
      const strike = a && KB_CAT[a.id] === 'strike' ? '<span class="ks" data-limb="' + a.id + '"></span>' : '';
      return '<div class="kk' + (cat ? ' c-' + cat : ' off') + '" style="flex:' + w + '" data-code="' + code + '"' + (a ? ' data-act="' + a.id + '"' : '') + '>' +
        '<span class="kc">' + esc(KB_CAP[code] || keyName(code)) + '</span>' + (label ? '<span class="kl">' + label + '</span>' : '') + strike + '</div>';
    };
    const block = (rows, cls) => '<div class="kb-block ' + cls + '">' + rows.map(r => '<div class="kb-row">' + r.map(cap).join('') + '</div>').join('') + '</div>';
    host.innerHTML = block(KB_MAIN, 'main') + block(KB_ARROWS, 'arrows');
    // binds on keys the diagram has no cap for (numpad, F-keys, ...)
    const extra = Object.keys(byCode).filter(c => !placed.has(c));
    const info = $('#kbInfo');
    const idle = extra.length ? 'Also bound: ' + extra.map(c => '<b>' + esc(keyName(c)) + '</b> ' + KB_SHORT[byCode[c].id]).join(' · ') : '<span class="muted">Hover a key.</span>';
    info.innerHTML = idle;
    $('#kbLegend').innerHTML = KB_LEGEND.map(([c, n]) => '<span class="c-' + c + '"><i></i>' + n + '</span>').join('');
    const ms = Controls.moveset;
    const showMod = (m) => {
      host.querySelectorAll('.ks').forEach(s => { s.textContent = KB_KIND[ms[m][s.dataset.limb]] || KIND_LABEL[ms[m][s.dataset.limb]]; });
      host.querySelectorAll('.kk[data-act^="mod"]').forEach(k => k.classList.toggle('hot', k.dataset.act === m));
    };
    showMod('none');
    const modKey = m => m === 'none' ? 'no modifier' : 'hold <b>' + esc(keyName(Controls.binds[m][0])) + '</b>';
    host.querySelectorAll('.kk[data-code]').forEach(k => k.onmouseenter = () => {
      const a = byCode[k.dataset.code], fx = kbFixed(k.dataset.code);
      if (a && KB_CAT[a.id] === 'mod') showMod(a.id);
      let h = '<b>' + esc(keyName(k.dataset.code)) + '</b> ';
      if (a && KB_CAT[a.id] === 'mod') h += a.label + ': ' + LIMBS.map(l => LIMB_NAME[l].toLowerCase() + ' ' + KIND_LABEL[ms[a.id][l]].toLowerCase()).join(' · ');
      else if (a && KB_CAT[a.id] === 'strike') h += a.label + ': ' + MODS.map(m => modKey(m) + ' ' + KIND_LABEL[ms[m][a.id]].toLowerCase()).join(' · ');
      else if (a) h += a.label;
      if (fx) h += (a ? ' · ' : '') + fx[1];
      if (!a && !fx) h += '<span class="muted">unbound</span>';
      info.innerHTML = h;
    });
    host.onmouseleave = () => { showMod('none'); info.innerHTML = idle; };
  }
  function startCapture(act, slot, btn) {
    cancelCapture();
    capture = { act, slot, btn };
    btn.textContent = slot === 2 ? 'PRESS A BUTTON' : 'PRESS A KEY'; btn.classList.add('cap');
  }
  function cancelCapture() {
    if (!capture) return;
    capture.btn.textContent = capture.slot === 2 ? padName(Controls.pad[capture.act]) : keyName(Controls.binds[capture.act][capture.slot]); capture.btn.classList.remove('cap');
    capture = null;
  }
  function capturePad(code) {
    const { act } = capture;
    for (const a of ACTIONS) if (Controls.pad[a.id] === code) Controls.pad[a.id] = ''; // one action per button
    Controls.pad[act] = code;
    capture = null;
    saveControls(); buildOptions(); updateHint();
  }
  function captureKey(code) {
    const { act, slot } = capture;
    if (slot === 2) { if (code === 'Backspace' || code === 'Delete') { Controls.pad[act] = ''; capture = null; saveControls(); buildOptions(); updateHint(); } return; } // a pad cell only takes pad input; Backspace clears it
    if (code === 'Backspace' || code === 'Delete') { Controls.binds[act][slot] = ''; }
    else {
      for (const a of ACTIONS) for (let i = 0; i < 2; i++) if (Controls.binds[a.id][i] === code) Controls.binds[a.id][i] = ''; // one action per key: unbind it everywhere else first
      Controls.binds[act][slot] = code;
    }
    capture = null;
    saveControls(); buildOptions(); updateHint();
  }
  function openOptions() {
    Analytics.track('options_open', { where: whereAmI() });
    App.optionsOpen = true; App.held = 0; App.pressed = 0; releasePointer();
    if (App.playing && isLocal()) App.paused = true;
    $('#btnOptQuit').style.display = ($('#menu').classList.contains('hidden') && $('#career').classList.contains('hidden') && $('#careerNew').classList.contains('hidden')) || (App.gym && App.gym.active) ? '' : 'none'; // QUIT shows only in a fight/lobby or the gym, hidden on the menus
    buildOptions(); show($('#options'));
  }
  function closeOptions() {
    cancelCapture();
    App.optionsOpen = false; App.paused = false;
    hide($('#options')); updateHint();
  }
  // ============================================================
  //  Feedback (playtest notes to the dev)
  // ============================================================
  const FB = { kind: 'bug' };
  function whereAmI() {
    if (App.playing || App.sim) return 'fight (' + (App.mode || '?') + (App.paused ? ', paused' : '') + ')';
    if (App.gym && App.gym.active) return 'career gym';
    for (const id of ['end', 'career', 'careerNew', 'lobby', 'more', 'menu']) if (!$('#' + id).classList.contains('hidden')) return id + (id === 'lobby' && App.mode ? ' (' + App.mode + ')' : '');
    return 'unknown';
  }
  function fbReport() {
    let gpu = '';
    try { const gl = App.renderer && App.renderer.getContext(); const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info'); if (dbg) gpu = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL); } catch (_) {}
    const S = App.state, C = CareerUI.C;
    return {
      kind: FB.kind,
      version: window.desktop && window.desktop.version ? 'desktop v' + window.desktop.version : 'web',
      page: location.href.split('?')[0],
      where: whereAmI(),
      time: new Date().toISOString(),
      sessionMin: Math.round((Date.now() - Diag.started) / 60000),
      browser: navigator.userAgent,
      lang: navigator.language,
      screen: innerWidth + 'x' + innerHeight + ' @' + (devicePixelRatio || 1) + 'x' + (document.fullscreenElement ? ' fullscreen' : ''),
      gpu,
      input: Pad.active ? 'gamepad' : 'keyboard',
      rules: App.lobby.settings,
      picks: App.lobby.picks,
      fight: S ? { round: S.round, clock: Math.round(S.clock), phase: S.phase, ground: !!S.ground } : null,
      career: C ? { name: C.name, record: C.record } : null,
      errors: Diag.errors,
      replay: Analytics.replayUrl() // the PostHog session replay for this tester, so a bug report can be watched back
    };
  }
  function fbText(r, msg, contact) {
    const lines = ['[' + r.kind.toUpperCase() + '] ' + FEEDBACK.subject, '', msg || '(no message)', ''];
    if (contact) lines.push('Reply to: ' + contact);
    lines.push('--- attached ---');
    for (const k of Object.keys(r)) if (k !== 'kind') lines.push(k + ': ' + (r[k] !== null && typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k]));
    return lines.join('\n');
  }
  function openFeedback() {
    if (App.feedbackOpen) return;
    Analytics.track('feedback_open', { where: whereAmI() });
    App.feedbackOpen = true; App.held = 0; App.pressed = 0; releasePointer();
    if (App.playing && isLocal()) App.paused = true;
    $('#fbReport').textContent = fbText(fbReport(), '', '').split('--- attached ---')[1].trim();
    hide($('#fbTab')); show($('#feedback'));
    $('#fbText').focus();
  }
  function closeFeedback() {
    App.feedbackOpen = false; if (!App.optionsOpen) App.paused = false;
    hide($('#feedback')); show($('#fbTab'));
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (_) {}
    try { const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (_) { return false; }
  }
  async function sendFeedback() {
    const msg = $('#fbText').value.trim(), contact = $('#fbContact').value.trim();
    if (msg.length < 3) { toast('Write a line first.'); $('#fbText').focus(); return; }
    try { localStorage.setItem('cr_fb_contact', contact); } catch (_) {}
    const r = fbReport(), text = fbText(r, msg, contact);
    const btn = $('#btnFbSend'); btn.disabled = true; btn.textContent = 'SENDING\u2026';
    let sent = false;
    try {
      const res = await fetch(FEEDBACK.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ message: msg, contact }, r)) });
      sent = res.ok && (await res.json()).ok === true;
    } catch (_) {}
    btn.disabled = false; btn.textContent = 'SEND';
    Analytics.track('feedback_sent', { kind: r.kind, delivered: sent, where: r.where, has_contact: !!contact, length: msg.length });
    if (contact) Analytics.identify(contact, { contact });
    if (sent) { toast('Sent. Thank you!', 2500); $('#fbText').value = ''; closeFeedback(); return; }
    // the inbox is unreachable: keep the report on their clipboard so it can still be pasted to the dev
    const copied = await copyText(text);
    toast(copied ? 'Could not reach the inbox. The report is copied to your clipboard, paste it to the dev instead.' : 'Could not reach the inbox. Use COPY and paste the report to the dev.', 6000);
  }
  function resetControls() {
    Controls.binds = defaultBinds(); Controls.pad = defaultPad(); Controls.moveset = normalizeMoveset(DEFAULT_MOVESET);
    saveControls();
    buildOptions(); updateHint(); toast('Options reset to defaults', 1500);
  }
  function menuHint() {
    const h = $('#menuHint'); if (!h) return;
    h.innerHTML = Pad.active
      ? '<span><b>D-PAD</b>select</span><span><b>A</b>confirm</span><span><b>START</b>options</span>'
      : '<span><b>\u2191\u2193</b>select</span><span><b>ENTER</b>confirm</span><span><b>ESC</b>options</span>' + (window.desktop ? '<span><b>F11</b>fullscreen</span>' : '');
  }
  function updateHint() {
    menuHint();
    Tutor.dirty = true; Tutor.shown = -1; // the step card names keys for whichever device is in use
    const B = id => '<b>' + bindName(id) + '</b>';
    const ms = Controls.moveset;
    const kind = k => KIND_LABEL[k].toLowerCase();
    const row = m => (m === 'none' ? 'no modifier' : 'hold ' + B(m)) + ': ' + LIMBS.map(l => kind(ms[m][l])).join(' / ');
    $('#controlsHint').innerHTML =
      '<div class="ctl-row">' + [B('fwd'), B('left'), B('back'), B('right')].join(' ') + ' move / circle (stepping into a shot adds power, backing off takes it away) · ' + B('dodge') + ' dash the way you are stepping (straight back if standing still) · ' + B('lh') + ' left hand · ' + B('rh') + ' right hand · ' + B('ll') + ' left leg · ' + B('rl') + ' right leg</div>' +
      '<div class="ctl-row">' + MODS.map(row).join(' · ') + '</div>' +
      '<div class="ctl-row">' + B('block') + ' hold: block / sprawl (+ ' + B('mod3') + ' drops into a shell that covers the body), press as a strike comes in: block and slip it, tap twice: push them off · ' + B('grapple') + ' takedown / dive on a downed opponent · ' + B('stance') + ' switch stance · knocked down: a direction or ' + B('dodge') + ' gets up, or stay down to recover · ground: hands & legs strike, direction + ' + B('grapple') + ' move (see the compass), ' + B('grapple') + ' alone submission, their direction + ' + B('grapple') + ' denies, ' + B('block') + ' covers, ' + B('dodge') + ' let up · <b>Enter</b> chat · <b>ESC</b>' + (Pad.active ? ' / <b>START</b>' : '') + ' options · <b>H</b> hide this · <b>M</b> mute</div>';
    syncHint();
  }
  // the hint panel is closed by default; the CONTROLS tab (or H) opens it, and the corner tabs move up so they never sit on top of it
  function syncHint() {
    const hud = $('#hud'), hint = $('#controlsHint'), tab = $('#ctlTab'), corner = $('#corner');
    if (!hud || !hint || !tab || !corner) return;
    const inFight = App.playing && !hud.classList.contains('hidden') && App.mode !== 'watch';
    const open = inFight && !App.hintsHidden;
    hint.style.display = open ? '' : 'none';
    tab.classList.toggle('hidden', !inFight);
    tab.textContent = (open ? 'HIDE CONTROLS' : 'CONTROLS') + ' [H]';
    const h = open ? hint.offsetHeight : 0;
    corner.style.bottom = h > 0 ? (h + 22) + 'px' : '';
  }
  function toggleHint() { App.hintsHidden = !App.hintsHidden; syncHint(); }

  // ============================================================
  //  Input
  // ============================================================
  window.addEventListener('keydown', (e) => {
    if (App.feedbackOpen) { if (e.code === 'Escape' && !e.repeat) { e.preventDefault(); closeFeedback(); } return; } // ESC closes it even from inside the text box
    if (tutorPromptOpen()) { // the first-run prompt: ESC is NOT NOW, arrows move between its buttons, Enter / Space press the focused one
      if (e.code === 'Escape') { e.preventDefault(); if (!e.repeat) closeTutorPrompt(); }
      else if (/^Arrow(Up|Down|Left|Right)$/.test(e.code)) { e.preventDefault(); padFocusMove(e.code.slice(5).toLowerCase()); }
      return;
    }
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) { if (e.code === 'Escape') e.target.blur(); return; }
    if (e.code === 'Enter' && !e.repeat) {
      const el = document.activeElement;
      const tag = el && el.tagName;
      const box = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const shown = box && box.width > 0 && box.height > 0;
      if (shown && (tag === 'BUTTON' || tag === 'A')) return;
      const moreOpen = $('#more') && !$('#more').classList.contains('hidden');
      // Enter opens chat in a fight. In the career gym it is the "use" key, so it has to reach the bind.
      const inGym = App.gym && App.gym.active;
      if (!inGym && !App.optionsOpen && !capture && !moreOpen && App.talk) { e.preventDefault(); App.talk.open(); }
      if (!inGym) return;
    }
    if (capture) {
      e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'Escape') cancelCapture(); else captureKey(e.code);
      return;
    }
    if (!$('#more').classList.contains('hidden')) {
      if (e.code === 'Escape' && !e.repeat) { e.preventDefault(); pressEscape(); }
      return;
    }
    if (e.code === 'Escape') { e.preventDefault(); if (!e.repeat) pressEscape(); return; }
    if (/^Arrow(Up|Down|Left|Right)$/.test(e.code) && !(App.gym && App.gym.active)) {
      const onScreen = App.optionsOpen || ['menu', 'lobby', 'end', 'career', 'careerNew', 'more'].some(id => !$('#' + id).classList.contains('hidden'));
      if (onScreen) { e.preventDefault(); padFocusMove(e.code.slice(5).toLowerCase()); return; }
    }
    if (App.optionsOpen) return;
    if (e.code === 'KeyH' && !Controls.keyMap.KeyH) { if (!e.repeat) toggleHint(); return; }
    if (e.code === 'KeyM' && !Controls.keyMap.KeyM) { if (!e.repeat) { App.audio.setMuted(!App.audio.muted); toast(App.audio.muted ? 'Muted' : 'Sound on', 1200); } return; }
    const b = Controls.keyMap[e.code]; if (!b) return;
    e.preventDefault();
    if (Pad.active) { Pad.active = false; updateHint(); }
    if (!e.repeat) { App.pressed |= b; }
    App.held |= b;
  });
  window.addEventListener('keyup', (e) => { const b = Controls.keyMap[e.code]; if (b) { App.held &= ~b; e.preventDefault(); } });
  window.addEventListener('blur', () => { App.held = 0; Pad.held = 0; });
  // what ESC (or the pad's START button) does, from the most specific context outward
  function pressEscape() {
    if (capture) { cancelCapture(); return; }
    if (App.feedbackOpen) { closeFeedback(); return; }
    if (tutorPromptOpen()) { closeTutorPrompt(); return; }
    if (!$('#more').classList.contains('hidden')) { screen('menu'); return; }
    // in the gym, ESC backs out of an open station screen before it reaches the options menu
    if (!App.optionsOpen && App.gym && App.gym.active && CareerUI.station && !$('#career').classList.contains('hidden')) { closeStation(); return; }
    if (App.optionsOpen) closeOptions(); else openOptions();
  }

  // ---------- gamepad: polled once per frame and merged into the same held / pressed bits as the keyboard ----------
  window.addEventListener('gamepadconnected', (e) => { Pad.index = e.gamepad.index; toast('Controller connected: ' + String(e.gamepad.id || '').replace(/\s*\(.*$/, '').slice(0, 40), 2000); if (App.optionsOpen) buildOptions(); });
  window.addEventListener('gamepaddisconnected', (e) => { if (e.gamepad.index === Pad.index) { Pad.index = -1; Pad.prev = null; App.held &= ~Pad.held; Pad.held = 0; if (App.optionsOpen) buildOptions(); } });
  function getPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (Pad.index >= 0 && pads[Pad.index] && pads[Pad.index].connected) return pads[Pad.index];
    for (const p of pads) if (p && p.connected) { Pad.index = p.index; return p; }
    return null;
  }
  const padDown = (gp, code) => { // is this pad code pressed right now?
    if (code[0] === 'B') { const b = gp.buttons[+code.slice(1)]; return !!b && (b.pressed || b.value > 0.5); }
    const v = gp.axes[+code.slice(1, -1)] || 0; return code.endsWith('+') ? v > PAD_DEAD : v < -PAD_DEAD;
  };
  function padCodes(gp) { // every code pressed right now (rebinding and menu navigation)
    const out = [];
    for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i].pressed || gp.buttons[i].value > 0.5) out.push('B' + i);
    for (let i = 0; i < Math.min(4, gp.axes.length); i++) { const v = gp.axes[i]; if (v > PAD_DEAD) out.push('A' + i + '+'); else if (v < -PAD_DEAD) out.push('A' + i + '-'); }
    return out;
  }
  function dropPadHeld() { if (Pad.held) { App.held &= ~Pad.held; Pad.held = 0; } }
  function pollPad() {
    const gp = getPad();
    if (!gp) { dropPadHeld(); return; }
    const now = padCodes(gp), prev = Pad.prev || [];
    const fresh = now.filter(c => !prev.includes(c)); // rising edges this frame
    Pad.prev = now;
    if (fresh.length && !Pad.active) { Pad.active = true; updateHint(); }
    if (capture && capture.slot === 2) { if (fresh.length) capturePad(fresh[0]); return; } // rebinding a pad cell: the first new press is the bind
    if (capture) return;
    if (fresh.includes('B' + PAD_START)) { pressEscape(); return; }
    const gymLive = App.gym && App.gym.active && !App.gym.paused;
    const stationUp = App.gym && App.gym.active && CareerUI.station && !$('#career').classList.contains('hidden');
    const inPlay = gymLive || (App.playing && $('#hud') && !$('#hud').classList.contains('hidden'));
    if (App.optionsOpen || !inPlay || stationUp) { dropPadHeld(); padMenu(gp, now, fresh); return; }
    if (gymLive) { const rx = gp.axes[2] || 0; if (Math.abs(rx) > PAD_DEAD) App.gym.look(rx * Math.abs(rx) * PAD_LOOK); } // the gym camera turns with the right stick
    let held = 0;
    for (const a of ACTIONS) { const c = Controls.pad[a.id]; if (c && padDown(gp, c)) held |= a.bit; }
    App.pressed |= held & ~Pad.held;
    App.held = (App.held & ~Pad.held) | held;
    Pad.held = held;
  }
  // menus: d-pad / left stick moves focus between the visible controls, A activates, B backs out
  const padDir = (codes) => codes.includes('B12') || codes.includes('A1-') ? 'up' : codes.includes('B13') || codes.includes('A1+') ? 'down' : codes.includes('B14') || codes.includes('A0-') ? 'left' : codes.includes('B15') || codes.includes('A0+') ? 'right' : null;
  // a dropdown or slider is "opened" with A (like clicking it), then the d-pad changes its value and A or B closes it; otherwise focus passes straight over it
  function padEditStop() { if (Pad.edit) { Pad.edit.classList.remove('pad-edit'); Pad.edit = null; } }
  function padMenu(gp, now, fresh) {
    const dir = padDir(fresh), holdDir = padDir(now);
    Pad.nav = holdDir ? Pad.nav + 1 : 0;
    const step = dir || (holdDir && Pad.nav > 24 && Pad.nav % 8 === 0 ? holdDir : null); // a held direction repeats after a short delay
    const el = document.activeElement;
    const a = fresh.includes('B' + PAD_A), b = fresh.includes('B' + PAD_B);
    if (Pad.edit && (Pad.edit !== el || !Pad.edit.closest('body') || Pad.edit.closest('.hidden'))) padEditStop(); // focus moved on or the panel closed
    if (Pad.edit) {
      if (a || b) { padEditStop(); return; }
      if (step && el.tagName === 'INPUT') { el.value = +el.value + ((step === 'right' || step === 'up') ? 1 : -1) * (+el.step || 1); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      else if (step && el.tagName === 'SELECT') { const i = el.selectedIndex + ((step === 'down' || step === 'right') ? 1 : -1); if (i >= 0 && i < el.options.length) { el.selectedIndex = i; el.dispatchEvent(new Event('change', { bubbles: true })); } }
      return;
    }
    if (step) padFocusMove(step);
    if (a && el && el.getBoundingClientRect().width > 0) {
      if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.classList.contains('card') || (el.tagName === 'INPUT' && el.type === 'checkbox')) el.click();
      else if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'range')) { Pad.edit = el; el.classList.add('pad-edit'); }
    }
    if (b) {
      if (App.optionsOpen) closeOptions();
      else { const back = ['#btnTutNo', '#btnCareerNewBack', '#btnMoreClose', '#btnBack', '#btnMenu'].map(s => $(s)).find(b => b && !b.closest('.hidden') && b.getBoundingClientRect().width > 0); if (back) back.click(); }
    }
  }
  const PAD_FOCUSABLE = 'button, a[href], input[type=range], input[type=checkbox], select, .card';
  function padFocusMove(dir) {
    const modal = ['#tutorPrompt', '#feedback'].map(s => $(s)).find(m => m && !m.classList.contains('hidden')); // a dialog over the screen keeps the focus to itself
    const els = Array.from((modal || document).querySelectorAll(PAD_FOCUSABLE)).filter(e => { if (e.disabled || e.closest('.hidden') || e.classList.contains('letter')) return false; /* the title's G is an easter egg, not a menu item */ const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (!els.length) return;
    const cur = document.activeElement, from = cur && els.includes(cur) ? cur.getBoundingClientRect() : null;
    if (!from) { els[0].focus(); return; }
    const vertical = dir === 'up' || dir === 'down';
    let best = null, bestD = Infinity;
    for (const e of els) {
      if (e === cur) continue;
      const r = e.getBoundingClientRect();
      // distance from this control's edge to the next one's facing edge, along the direction of travel
      const along = dir === 'up' ? from.top - r.bottom : dir === 'down' ? r.top - from.bottom : dir === 'left' ? from.left - r.right : r.left - from.right;
      if (along < -Math.min(vertical ? from.height : from.width, vertical ? r.height : r.width) * 0.5) continue; // behind us or beside us
      // overlap on the other axis: a control in the same column (or row) wins over one that is off to the side
      const lap = vertical ? Math.min(from.right, r.right) - Math.max(from.left, r.left) : Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top);
      const across = lap > 0 ? 0 : -lap;
      const d = Math.max(0, along) + (lap > 0 ? 0 : 1000 + across * 2);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) { best.focus(); if (best.scrollIntoView) best.scrollIntoView({ block: 'nearest' }); }
  }
  // the gym's free-walk camera turns with the mouse: click the view to capture the pointer (ESC lets it go)
  const gymLive = () => App.gym && App.gym.active && !App.gym.paused && !App.optionsOpen;
  $('#gl').addEventListener('mousedown', () => { if (gymLive() && !document.pointerLockElement) { const p = $('#gl').requestPointerLock(); if (p && p.catch) p.catch(() => {}); } });
  window.addEventListener('mousemove', (e) => { if (document.pointerLockElement === $('#gl') && gymLive()) App.gym.look(e.movementX || 0); });
  function releasePointer() { if (document.pointerLockElement) document.exitPointerLock(); }

  // ============================================================
  //  Main loop
  // ============================================================
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.1) dt = 0.1;
    pollPad();
    if (App.gym && App.gym.active) {
      // the career gym: walk, hit the bag, use the stations. Input is zeroed while the options panel is open.
      const live = !App.optionsOpen;
      App.gym.update(dt, live ? App.held : 0, live ? App.pressed : 0, IN_INTERACT, IN_LOCK); App.pressed = 0;
      updateGymHUD();
      return;
    }
    if (!App.playing || !App.state) { if (App.renderer && App.state) App.renderer.update(App.state, dt, null); tickTalk(dt); return; }

    const isHost = App.mode !== 'guest';
    let inputs = [0, 0];
    if (App.paused && isLocal()) { App.pressed = 0; App.renderer.update(App.state, 0, inputs); updateHUD(App.state, inputs); tickTalk(dt); return; }
    if (isHost) {
      const sim = App.sim;
      if (App.autoPilot) { const o = App.autoPilot.update(sim.state, dt); const watch = App.mode === 'watch'; sim.setInput(0, watch ? o.held : (o.held | (App.held & SIM_MASK)), watch ? o.pressed : (o.pressed | (App.pressed & SIM_MASK))); App.pressed = 0; if (watch) inputs[0] = o.held; }
      else { sim.setInput(0, App.held & SIM_MASK, App.pressed & SIM_MASK); App.pressed = 0; }
      if (App.brain) { const o = App.brain.update(sim.state, dt); sim.setInput(1, o.held, o.pressed); inputs[1] = o.held; }
      else { sim.setInput(1, App.remote.h, App.remote.p); App.remote.p = 0; inputs[1] = App.remote.h; }
      if (App.mode !== 'watch') inputs[0] = App.held & SIM_MASK;
      sim.step(dt);
      const evs = sim.drainEvents();
      if (evs.length) processEvents(evs, sim.state);
      if (Tutor.active) tutorTick(sim.state, dt);
      if (App.mode === 'host' && App.net) {
        App.evQueue.push(...evs);
        if (now - App.lastSnap >= 50) {
          App.lastSnap = now;
          App.net.send({ t: 's', s: sim.state, ev: App.evQueue });
          App.evQueue = [];
        }
      }
    } else {
      // guest: send inputs, extrapolate a little between snapshots
      if (App.net && now - App.lastInputSend >= 33) {
        App.lastInputSend = now;
        App.net.send({ t: 'in', h: App.held & SIM_MASK, p: App.pressed & SIM_MASK }); App.pressed = 0;
      }
      inputs[1] = App.held & SIM_MASK;
      const S = App.state;
      if (S.phase === 'fight') {
        S.clock = Math.max(0, S.clock - dt);
        for (const f of S.f) if (f.act && f.act.type !== 'idle' && f.act.type !== 'move') f.act.t += dt;
      }
    }
    App.renderer.update(App.state, dt, inputs);
    updateHUD(App.state, inputs);
    tickTalk(dt);
  }
  requestAnimationFrame(loop);

  // ============================================================
  //  Career mode (single player campaign) — model in js/career.js
  // ============================================================
  const CareerUI = { C: null, tab: 'camp', pick: { base: 'striker', color: null, skin: null, look: null }, pickMode: 'career', backTo: 'menu', justFought: false, lastTrain: null, confirmDel: 0 };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');
  const pct100 = (v) => Math.round(v * 100);
  function careerSave() { if (CareerUI.C) Career.save(CareerUI.C); }
  function careerLoad() { if (!CareerUI.C) CareerUI.C = Career.load(); return CareerUI.C; }
  function refreshMenuCareer() {
    const has = !!careerLoad();
    const b = $('#btnCareer'); if (b) b.textContent = has ? 'CONTINUE CAREER' : 'START A CAREER';
    const n = $('#btnCareerNew'); if (n) { n.classList.toggle('hidden', !has); n.textContent = 'NEW CAREER'; CareerUI.confirmNew = 0; }
  }

  // ---- new fighter ----
  function swatches(el, list, sel, onPick) {
    el.innerHTML = list.map((c, i) => '<i data-i="' + i + '" style="background:' + hex(c) + '" class="' + (c === sel ? 'sel' : '') + '"></i>').join('');
    el.querySelectorAll('i').forEach(i => i.onclick = () => onPick(list[+i.dataset.i]));
  }
  // a row of named choices (build, hair style, facial hair)
  function segPicker(el, list, sel, onPick) {
    el.innerHTML = list.map(o => '<button type="button" data-id="' + o.id + '" class="' + (o.id === sel ? 'on' : '') + '">' + esc(o.name) + '</button>').join('');
    el.querySelectorAll('button').forEach(b => b.onclick = () => onPick(b.dataset.id));
  }
  function openCareerNew() {
    const P = CareerUI.pick;
    if (P.color == null) P.color = Career.COLORS[0];
    if (P.skin == null) P.skin = Career.SKINS[0];
    if (!P.look) P.look = Career.normalizeLook(null);
    const el = $('#careerBases'); el.innerHTML = '';
    for (const key in ROSTER) {
      const r = ROSTER[key], st = Career.startingStats(key);
      const c = document.createElement('div'); c.className = 'card' + (P.base === key ? ' sel' : ''); c.dataset.key = key;
      c.innerHTML = '<div class="swatch" style="background:' + hex(r.color) + '"></div><div class="cname">' + esc(r.style) + '</div><div class="cstyle">starting shape · rating ' + Career.rating(st) + '</div><div class="cdesc">' + esc(r.desc) + '</div>' +
        Career.STATS.map(s => statBar(s.short, st[s.key])).join('');
      c.onclick = () => { P.base = key; el.querySelectorAll('.card').forEach(x => x.classList.toggle('sel', x.dataset.key === key)); };
      el.appendChild(c);
    }
    renderLookPicks();
    try { if (!$('#careerName').value) $('#careerName').value = localStorage.getItem('cr_name') || ''; } catch (_) {}
    setPickMode('career');
    screen('careerNew');
    LookPreview.start();
  }
  // the same screen edits your fighter for practice / online: no base style or name, SAVE instead of START
  function setPickMode(mode) {
    CareerUI.pickMode = mode;
    const prof = mode === 'profile';
    $('#careerBases').classList.toggle('hidden', prof);
    $('#careerNames').classList.toggle('hidden', prof);
    $('#careerNewTitle').textContent = prof ? 'YOUR FIGHTER' : 'NEW CAREER';
    $('#careerNewStatus').textContent = prof ? 'This is you in practice and online fights. The CPU always shows up as somebody new.' : 'From the regional circuit to the big league. Pick a base style \u2014 it only shapes where you start; training decides what you become.';
    $('#btnCareerStart').textContent = prof ? 'SAVE' : 'START CAREER';
    $('#btnLookClear').classList.toggle('hidden', !prof || !Profile.get());
  }
  // backTo: the screen to return to (the lobby keeps its room open while the look is edited)
  function openProfile(backTo) {
    const saved = Profile.get() || Profile.random();
    CareerUI.pick = { base: 'striker', color: saved.color != null ? saved.color : Career.COLORS[0], skin: saved.skin, look: Career.normalizeLook(saved.look) };
    CareerUI.backTo = backTo || 'menu';
    renderLookPicks();
    setPickMode('profile');
    screen('careerNew');
    LookPreview.start();
  }
  function closeProfile() {
    LookPreview.stop();
    screen(CareerUI.backTo);
    if (CareerUI.backTo === 'lobby') { refreshLobby(); sendPick(); } // the host / guest hears about the new look
  }
  function saveProfile() {
    const P = CareerUI.pick;
    Profile.set({ look: P.look, skin: P.skin, color: P.color });
    Analytics.track('look_saved');
    toast('Fighter saved.', 2000);
    closeProfile();
  }
  // the pickers for everything the renderer can vary; every change rebuilds the preview model
  function renderLookPicks() {
    const P = CareerUI.pick, L = P.look, LK = Career.LOOK;
    const set = (fn) => { fn(); renderLookPicks(); LookPreview.rebuild(); };
    swatches($('#careerColors'), Career.COLORS, P.color, (c) => set(() => { P.color = c; }));
    swatches($('#careerSkins'), Career.SKINS, P.skin, (c) => set(() => { P.skin = c; }));
    swatches($('#lkHairColor'), LK.hairColors, L.hairColor, (c) => set(() => { L.hairColor = c; }));
    swatches($('#lkTrim'), LK.trims, L.trim, (c) => set(() => { L.trim = c; }));
    swatches($('#lkGloves'), LK.gloves, L.gloves, (c) => set(() => { L.gloves = c; }));
    segPicker($('#lkBuild'), LK.build, L.build, (id) => set(() => { L.build = id; }));
    segPicker($('#lkHair'), LK.hair, L.hair, (id) => set(() => { L.hair = id; }));
    segPicker($('#lkBeard'), LK.beard, L.beard, (id) => set(() => { L.beard = id; }));
    $('#btnLookRandom').onclick = () => set(() => { P.look = Career.randomLook(); P.color = Career.COLORS[(Math.random() * Career.COLORS.length) | 0]; P.skin = Career.SKINS[(Math.random() * Career.SKINS.length) | 0]; });
  }
  // the fighter in the new-career panel: its own small scene, the model standing in its bind pose, turned by dragging
  const LookPreview = {
    on: false, yaw: 0.35, drag: null, spin: true,
    init() {
      if (this.R) return true;
      const canvas = $('#careerPreview'); if (!canvas || !window.THREE) return false;
      try { this.R = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch (_) { return false; }
      this.R.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); this.R.setClearColor(0x000000, 0);
      this.R.outputEncoding = THREE.sRGBEncoding; this.R.toneMapping = THREE.ACESFilmicToneMapping; this.R.toneMappingExposure = 0.85;
      this.scene = new THREE.Scene();
      this.scene.add(new THREE.HemisphereLight(0x8899bb, 0x201a14, 0.35));
      const key = new THREE.DirectionalLight(0xfff2dd, 0.6); key.position.set(2.5, 4, 3); this.scene.add(key);
      const fill = new THREE.DirectionalLight(0xa9c4ff, 0.25); fill.position.set(-3, 2, -2); this.scene.add(fill);
      this.cam = new THREE.PerspectiveCamera(30, 3 / 4, 0.1, 20);
      this.pivot = new THREE.Vector3(0, 0.98, 0);
      canvas.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, yaw: this.yaw }; this.spin = false; canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', (e) => { if (this.drag) this.yaw = this.drag.yaw + (e.clientX - this.drag.x) * 0.012; });
      canvas.addEventListener('pointerup', () => { this.drag = null; }); canvas.addEventListener('pointercancel', () => { this.drag = null; });
      return true;
    },
    start() { if (!this.init()) return; this.on = true; this.rebuild(); if (!this._raf) this._raf = requestAnimationFrame((t) => this.frame(t)); },
    stop() { this.on = false; if (this.model) { this.model.dispose(); this.model = null; } },
    rebuild() {
      if (!this.R || !this.on) return;
      const P = CareerUI.pick;
      if (this.model) this.model.dispose();
      this.model = new window.MMARender.FighterModel(this.scene, P.color, P.skin, 0, { look: P.look });
    },
    frame(t) {
      this._raf = 0;
      if (!this.on) return;
      this._raf = requestAnimationFrame((t2) => this.frame(t2));
      const canvas = $('#careerPreview'), w = canvas.clientWidth | 0, h = canvas.clientHeight | 0;
      if (!w || !h || !this.model) return;
      if (canvas.width !== Math.round(w * this.R.getPixelRatio()) || canvas.height !== Math.round(h * this.R.getPixelRatio())) { this.R.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }
      const dt = this._t ? Math.min(0.1, (t - this._t) / 1000) : 0; this._t = t;
      if (this.spin && !this.drag) this.yaw += dt * 0.35;
      const d = 3.4;
      this.cam.position.set(Math.sin(this.yaw) * d, 1.35, Math.cos(this.yaw) * d); this.cam.lookAt(this.pivot);
      this.R.render(this.scene, this.cam);
    }
  };
  function startCareer() {
    if (CareerUI.pickMode === 'profile') { saveProfile(); return; }
    const name = ($('#careerName').value || '').trim();
    if (!name) { toast('Give your fighter a name.'); $('#careerName').focus(); return; }
    const P = CareerUI.pick;
    CareerUI.C = Career.newCareer({ name, nick: $('#careerNick').value, base: P.base, color: P.color, skin: P.skin, look: P.look });
    Analytics.track('career_start', { base: P.base, name }); Analytics.person({ career_name: name, career_base: P.base });
    careerSave(); CareerUI.justFought = false; CareerUI.lastTrain = null;
    LookPreview.stop();
    openCareer();
  }

  // ---- hub: the gym is a room you walk around (js/gym.js); the stations in it open the panels below ----
  const STATION_TITLE = { computer: 'THE COMPUTER · FIGHT OFFERS', computerBooked: 'THE COMPUTER · YOUR NEXT FIGHT', board: 'THE WHITEBOARD · THIS WEEK', desk: 'FRONT DESK · UPGRADES', fame: 'WALL OF FAME · HISTORY' };
  function openCareer(tab) {
    const C = careerLoad(); if (!C) { openCareerNew(); return; }
    CareerUI.confirmDel = 0; $('#btnCareerDelete').textContent = 'RETIRE (DELETE SAVE)';
    enterGym();
    if (tab) openStation(tab, { offers: 'computer', camp: 'board', gym: 'desk', history: 'fame' }[tab]);
  }
  function enterGym() {
    const C = CareerUI.C; if (!C) return;
    if (App.optionsOpen) closeOptions();
    App.mode = 'gym'; App.held = 0; App.pressed = 0;
    for (const id of ['menu', 'lobby', 'end', 'career', 'careerNew']) hide($('#' + id));
    hide($('#hud'));
    const R = ensureRenderer();
    if (!App.gym) { App.gym = new window.MMAGym.Gym(R, App.audio); App.gym.onStation = (tab, id) => openStation(tab, id); }
    const first = !App.gym.active;
    if (first) R.setFighters({ f: [] }); // the menu's demo fighters leave the scene
    App.gym.enter(C, Controls.moveset);
    App.audio.play('menu'); App.audio.setCrowd(0);
    refreshGymHUD(); show($('#gymHud'));
    if (first && !C.history.length && !C._gymHint) { C._gymHint = true; toast('Walk with ' + keyName(Controls.binds.fwd[0]) + keyName(Controls.binds.left[0]) + keyName(Controls.binds.back[0]) + keyName(Controls.binds.right[0]) + '. Hit the bag with your strike keys. The computer has your fight offers.', 7000); }
  }
  // keepScene: a fight is about to take the scene over; otherwise put the menu's demo arena back
  function exitGym(keepScene) {
    if (!App.gym || !App.gym.active) return;
    App.gym.leave(); hide($('#gymHud')); releasePointer();
    if (App.mode === 'gym') App.mode = null;
    if (!keepScene) menuScene();
  }
  function openStation(tab, id) {
    const C = CareerUI.C; if (!C || !App.gym || !App.gym.active) return;
    // once a fight is booked the computer shows the fight card (and the FIGHT button on fight week)
    if (id === 'computer' && C.booked) { tab = 'camp'; id = 'computerBooked'; }
    CareerUI.tab = tab; CareerUI.station = id || tab;
    App.gym.paused = true; App.held = 0; App.pressed = 0; releasePointer();
    hide($('#gymHud'));
    renderCareer(); show($('#career'));
    $('#career .panel').scrollTop = 0;
  }
  function closeStation() {
    hide($('#career')); CareerUI.station = false;
    if (!App.gym || !App.gym.active) return;
    const C = CareerUI.C, before = App.gym.sig;
    App.gym.refresh(C);
    if (App.gym.sig !== before) toast('The gym got an upgrade — take a look around.', 3000);
    App.gym.paused = false; App.held = 0; App.pressed = 0;
    refreshGymHUD(); show($('#gymHud'));
  }
  // the gym's overlay: name / record / bank / week / popularity, the station prompt, the bag readout
  const GymHUD = { prompt: '', bag: '', help: '' };
  function refreshGymHUD() {
    const C = CareerUI.C, G = App.gym; if (!C || !G) return;
    $('#gName').innerHTML = esc(C.name) + (C.nick ? ' <span>"' + esc(C.nick) + '"</span>' : '') + (C.champion ? '<span class="belt">' + esc(Career.TOP.name) + ' CHAMPION</span>' : '');
    $('#gSub').textContent = G.tierName(C) + ' · ' + G.totalLevel(C) + ' / ' + (Career.FACILITIES.length * Career.FACILITY_MAX) + ' upgrades · ' + Career.TIER_NAME[Career.tierFor(C.pop)] + ' level';
    const r = C.record;
    $('#gKpis').innerHTML = '<div class="kpi"><span>RECORD</span><b>' + r.w + '-' + r.l + (r.d ? '-' + r.d : '') + '</b></div><div class="kpi"><span>BANK</span><b>' + Career.fmtMoney(C.money) + '</b></div><div class="kpi"><span>DATE</span><b>' + Career.weekLabel(C.week) + '</b></div><div class="kpi"><span>POPULARITY</span><b>' + Math.round(C.pop) + '</b><small>' + Career.popLabel(C.pop) + '</small></div>' +
      (C.booked ? '<div class="kpi fight"><span>' + (Career.fightReady(C) ? 'FIGHT WEEK' : 'NEXT FIGHT') + '</span><b>' + esc(C.booked.offer.opp.name) + '</b><small>' + (Career.fightReady(C) ? 'go to the computer' : C.booked.weeksLeft + ' weeks · ' + esc(C.booked.offer.orgName)) + '</small></div>' : '<div class="kpi"><span>OFFERS</span><b>' + C.offers.length + '</b><small>on the computer</small></div>');
    const rb = $('#gResult');
    if (CareerUI.justFought && C.lastFight) {
      const h = C.lastFight;
      rb.classList.remove('hidden'); rb.classList.toggle('lost', !h.won && !h.draw);
      rb.innerHTML = '<div class="rh">' + resultWord(h) + '<small>' + esc(h.method) + (/KO|Sub/i.test(h.method) ? ' · R' + h.round + ' ' + esc(h.time) : '') + '</small></div>' +
        '<div class="rl">vs <b>' + esc(h.opp) + '</b> at <b>' + esc(h.org) + '</b>' + (h.titleNote ? ' · <b style="color:var(--gold)">' + esc(h.titleNote) + '</b>' : '') + '<br>Paid <b>' + Career.fmtMoney(h.pay) + '</b> · popularity <b>' + (h.dPop >= 0 ? '+' : '') + h.dPop + '</b> → ' + Math.round(h.pop) + ' · took <b>' + (h.inj.head + h.inj.body + h.inj.legs) + '</b> damage into camp</div>' +
        '<button class="ghost" id="btnGymResultOk">OK</button>';
      $('#btnGymResultOk').onclick = () => { CareerUI.justFought = false; rb.classList.add('hidden'); };
    } else rb.classList.add('hidden');
    const B = id => '<b>' + keyName(Controls.binds[id][0]) + '</b>';
    const help = B('fwd') + B('left') + B('back') + B('right') + ' walk · ' + B('lh') + ' ' + B('rh') + ' hands · ' + B('ll') + ' ' + B('rl') + ' legs (hold ' + B('mod1') + ' / ' + B('mod2') + ' / ' + B('mod3') + ' for the other strikes) · ' + B('block') + ' guard · ' + B('interact') + ' use · ' + B('lock') + ' lock on bag · <b>ESC</b> options';
    if (help !== GymHUD.help) { GymHUD.help = help; $('#gHelp').innerHTML = help; }
  }
  function updateGymHUD() {
    const G = App.gym; if (!G || G.paused) return;
    const st = G.station;
    let prompt = '';
    if (st && st.tab) prompt = '<b>' + keyName(Controls.binds.interact[0]) + '</b> ' + esc(G.prompt);
    else if (st && st.id === 'bag') prompt = '<span class="muted">HEAVY BAG</span> throw strikes · hold ' + keyName(Controls.binds.block[0]) + ' to guard · <b>' + keyName(Controls.binds.lock[0]) + '</b> ' + (G.locked ? 'unlock' : 'lock on');
    const lockBtn = $('#btnGymLock'), canLock = !!(G.locked || G.canLock());
    if (lockBtn) { lockBtn.classList.toggle('hidden', !canLock); lockBtn.classList.toggle('on', !!G.locked); lockBtn.textContent = (G.locked ? 'UNLOCK BAG' : 'LOCK ON BAG') + ' [' + keyName(Controls.binds.lock[0]) + ']'; }
    if (prompt !== GymHUD.prompt) { GymHUD.prompt = prompt; const el = $('#gPrompt'); el.innerHTML = prompt; el.classList.toggle('show', !!prompt); }
    const S = G.session;
    let bag = '';
    if (S.hits && (st && st.id === 'bag' || G.time - (S.lastStamp || -9) < 4)) {
      const L = S.last;
      bag = (L ? '<div class="last' + (L.big ? ' big' : '') + '">' + esc(L.name) + ' <b>' + L.speed.toFixed(1) + ' m/s</b> <i>' + L.label + '</i></div>' : '') +
        '<div class="tot">' + S.hits + ' hit' + (S.hits === 1 ? '' : 's') + (S.combo > 1 ? ' · <b>' + S.combo + ' combo</b>' : '') + ' · best combo ' + S.bestCombo + ' · hardest ' + S.hardest.toFixed(1) + ' m/s</div>';
    }
    if (bag !== GymHUD.bag) { GymHUD.bag = bag; const el = $('#gBag'); el.innerHTML = bag; el.classList.toggle('show', !!bag); }
  }
  function menuScene() {
    try {
      const R = ensureRenderer();
      const demo = new Sim({ seed: 1, players: [{ fighter: 'striker' }, { fighter: 'wrestler' }], physics: false });
      App.state = demo.state; R.setFighters(demo.state);
    } catch (e) { console.error(e); }
  }
  const dangerTag = (d) => d <= -8 ? '<span class="dang easy">FAVOURED</span>' : d <= 6 ? '<span class="dang even">EVEN</span>' : d <= 16 ? '<span class="dang hard">UNDERDOG</span>' : '<span class="dang brutal">LONG SHOT</span>';
  const resultWord = (h) => h.draw ? 'DRAW' : h.won ? 'WIN' : 'LOSS';
  function renderCareer() {
    const C = CareerUI.C; if (!C) return;
    const money = Career.fmtMoney;
    // header
    $('#cName').innerHTML = esc(C.name) + (C.nick ? ' <span style="color:var(--gold);font-size:22px">"' + esc(C.nick) + '"</span>' : '') + (C.champion ? '<span class="belt">' + esc(Career.TOP.name) + ' CHAMPION</span>' : '');
    const tier = Career.tierFor(C.pop);
    $('#cSub').textContent = ROSTER[C.base].style + ' base · ' + Career.TIER_NAME[tier] + ' level · ' + (C.streak > 1 ? C.streak + ' in a row' : C.streak < -1 ? (-C.streak) + ' straight losses' : 'rating ' + Career.rating(C.stats));
    const r = C.record;
    $('#cRecord').textContent = r.w + '-' + r.l + (r.d ? '-' + r.d : '');
    $('#cRecord').title = r.ko + ' (T)KO · ' + r.sub + ' SUB · ' + r.dec + ' DEC';
    $('#cMoney').textContent = money(C.money);
    $('#cWeek').textContent = Career.weekLabel(C.week);
    $('#cPop').textContent = Math.round(C.pop);
    $('#cPopBar').style.width = Math.max(0, Math.min(100, C.pop)) + '%';
    $('#cPopMarks').innerHTML = [24, 50, 74, Career.TITLE_POP].map(p => '<b style="left:' + p + '%" title="' + p + '"></b>').join('');
    $('#cPopLbl').textContent = Career.popLabel(C.pop);
    // last fight banner
    const rb = $('#cResult');
    if (CareerUI.justFought && C.lastFight) {
      const h = C.lastFight;
      rb.classList.remove('hidden'); rb.classList.toggle('lost', !h.won && !h.draw);
      rb.innerHTML = '<div class="rh">' + resultWord(h) + '<small style="display:block;font-size:13px;color:var(--muted);letter-spacing:.15em">' + esc(h.method) + (/KO|Sub/i.test(h.method) ? ' · R' + h.round + ' ' + esc(h.time) : '') + '</small></div>' +
        '<div class="rl">vs <b>' + esc(h.opp) + '</b> at <b>' + esc(h.org) + '</b>' + (h.titleNote ? ' · <b style="color:var(--gold)">' + esc(h.titleNote) + '</b>' : '') + '</div>' +
        '<div class="rl">Paid <b>' + money(h.pay) + '</b> · popularity <b>' + (h.dPop >= 0 ? '+' : '') + h.dPop + '</b> → ' + Math.round(h.pop) +
        ' · took <b>' + (h.inj.head + h.inj.body + h.inj.legs) + '</b> damage into camp · strikes landed ' + h.stats.me.landed + ' / ' + h.stats.opp.landed + '</div>';
    } else rb.classList.add('hidden');
    // side: stats
    const lt = CareerUI.lastTrain;
    $('#cStats').innerHTML = Career.STATS.map(s => {
      const up = lt && lt.focus === s.key;
      return '<div class="cstat' + (up ? ' up' : '') + '" title="' + esc(s.desc) + '"><span>' + s.label + '</span><div class="sb"><i style="width:' + pct100(C.stats[s.key]) + '%"></i></div><b>' + pct100(C.stats[s.key]) + (up ? '<small style="font-size:10px"> +' + (lt.gain * 100).toFixed(1) + '</small>' : '') + '</b></div>';
    }).join('');
    $('#cRating').textContent = 'overall ' + Career.rating(C.stats);
    const injT = Career.injuryTotal(C);
    const injCell = (k, lbl) => { const v = Math.round(C.injury[k]); return '<span style="color:' + (v > 40 ? '#ff6b6b' : v > 10 ? 'var(--gold)' : '') + '">' + lbl + '<small>' + (v <= 0 ? 'healthy' : v > 40 ? 'injured ' + v : 'sore ' + v) + '</small></span>'; };
    $('#cInjury').innerHTML = '<div class="inj">' + injCell('head', 'HEAD') + injCell('body', 'BODY') + injCell('legs', 'LEGS') + '</div>' +
      '<div class="inj-note">' + (injT <= 0 ? 'Fully healthy.' : 'Damage heals ' + (10 + (C.gym.recovery || 0) * 4) + ' a week (×2.5 resting). Training hurt is ' + Math.round((1 - Math.max(0.35, 1 - injT / 260)) * 100) + '% less effective, and you start a fight carrying half of it.') + '</div>';
    $('#cGymSummary').innerHTML = Career.FACILITIES.map(f => '<b>' + (f.id === 'coach' ? 'Coach' : f.id === 'recovery' ? 'Recovery' : Career.STAT_BY_KEY[f.stat].label) + '</b> L' + (C.gym[f.id] || 0)).join(' · ');
    // tabs
    const nOffers = C.booked ? 0 : C.offers.length;
    document.querySelectorAll('#cTabs .tab').forEach(b => {
      b.classList.toggle('on', b.dataset.tab === CareerUI.tab);
      if (b.dataset.tab === 'offers') b.innerHTML = 'OFFERS' + (nOffers ? '<span class="badge">' + nOffers + '</span>' : '');
      if (b.dataset.tab === 'camp') b.innerHTML = C.booked ? (Career.fightReady(C) ? 'FIGHT WEEK<span class="badge">!</span>' : 'CAMP') : 'TRAINING';
    });
    for (const t of ['camp', 'offers', 'gym', 'history']) $('#tab' + t[0].toUpperCase() + t.slice(1)).classList.toggle('hidden', CareerUI.tab !== t);
    const station = !!CareerUI.station;
    $('#cTabs').classList.toggle('hidden', station);
    $('#cStation').classList.toggle('hidden', !station); $('#cStation').textContent = STATION_TITLE[CareerUI.station] || '';
    $('#btnCareerGym').classList.toggle('hidden', !station);
    renderCamp(C); renderOffers(C); renderGym(C); renderHistory(C);
  }
  function trainGrid(C) {
    const hurt = Career.injuryTotal(C) > 0;
    let h = '<div class="train-grid">' + Career.STATS.map(s => '<button class="train" data-focus="' + s.key + '"><span class="tn">' + s.label + '</span><span class="tg">+' + (Career.trainGain(C, s.key) * 100).toFixed(1) + '</span><div class="td">' + esc(s.desc) + ' Gym: ' + (Career.FACILITY_BY_ID[s.key].name) + ' L' + (C.gym[s.key] || 0) + '.</div></button>').join('') +
      '<button class="train rest" data-focus="rest"><span class="tn">Rest &amp; recover</span><span class="tg">heal ×2.5</span><div class="td">No stat gains this week; injuries heal two and a half times as fast.' + (hurt ? '' : ' You are healthy — probably train instead.') + '</div></button></div>';
    return h;
  }
  function bindTrain(root) {
    root.querySelectorAll('.train').forEach(b => b.onclick = () => {
      const C = CareerUI.C; if (!C) return;
      const out = Career.trainWeek(C, b.dataset.focus); if (!out) return;
      Analytics.track('career_train', { focus: b.dataset.focus, week: C.week });
      CareerUI.lastTrain = out; CareerUI.justFought = false; careerSave();
      if (Career.fightReady(C)) { CareerUI.tab = 'camp'; toast('Fight week. Step in when you are ready.', 2500); }
      renderCareer();
    });
  }
  function fighterSide(name, nick, style, rec, rating, from, right) {
    return '<div class="side' + (right ? ' r' : '') + '"><div class="fn">' + esc(name) + '</div><div class="fs">' + (nick ? '"' + esc(nick) + '" · ' : '') + esc(style) + '</div><div class="fr">' + rec + ' · rating ' + rating + (from ? ' · ' + esc(from) : '') + '</div></div>';
  }
  function renderCamp(C) {
    const el = $('#tabCamp');
    if (!C.booked) {
      el.innerHTML = '<h3>NO FIGHT BOOKED</h3><div class="offer-none">Take an offer from the OFFERS tab, or spend a week in the gym while you wait — new offers come in every week, but a week off the cards costs a little popularity.</div>' + trainGrid(C);
      bindTrain(el); return;
    }
    const B = C.booked, o = B.offer, opp = o.opp, d = Career.offerDanger(C, o);
    const r = C.record;
    let h = '<div class="fight-card">' + fighterSide(C.name, C.nick, ROSTER[C.base].style, r.w + '-' + r.l + (r.d ? '-' + r.d : ''), Career.rating(C.stats), null, false) +
      '<div class="vs">VS</div>' + fighterSide(opp.name, opp.nick, opp.style, opp.record.w + '-' + opp.record.l, opp.rating + ' ' + dangerTag(d), opp.from, true) + '</div>' +
      '<div class="fight-meta"><span><b>' + esc(o.orgName) + '</b> · ' + Career.TIER_NAME[o.tier] + '</span>' + (o.title ? '<span class="title-tag">' + (C.champion ? 'TITLE DEFENCE' : 'TITLE FIGHT') + '</span>' : '') +
      '<span>purse <b>' + Career.fmtMoney(o.purse) + '</b> + <b>' + Career.fmtMoney(o.bonus) + '</b> win bonus</span><span><b>' + o.rounds + '</b> × ' + (o.len / 60) + ' min rounds</span>' +
      '<span>' + (B.weeksLeft > 0 ? '<b>' + B.weeksLeft + '</b> week' + (B.weeksLeft === 1 ? '' : 's') + ' to go' : '<b>FIGHT WEEK</b>') + '</span></div>';
    h += '<div class="cmp">' + Career.STATS.map(s => { const a = C.stats[s.key], b = opp.stats[s.key]; return '<div class="row"><b style="color:' + (a >= b ? '#52d273' : '#ff8a8a') + '">' + pct100(a) + '</b><div class="bar2 me"><i style="width:' + pct100(a) + '%"></i></div><span class="lbl">' + s.short + '</span><div class="bar2 op"><i style="width:' + pct100(b) + '%"></i></div><b>' + pct100(b) + '</b></div>'; }).join('') + '</div>';
    if (B.weeksLeft > 0) {
      h += '<h3>WEEK ' + (o.weeks - B.weeksLeft + 1) + ' OF ' + o.weeks + ' — WHAT ARE YOU TRAINING?</h3>' + trainGrid(C);
    } else {
      const inj = Career.injuryTotal(C);
      h += '<div class="fight-now"><div><div class="t">IT\'S FIGHT NIGHT</div><small>' + (inj > 30 ? 'You are going in hurt (' + Math.round(inj) + ' damage carried).' : inj > 0 ? 'A little banged up (' + Math.round(inj) + '), nothing serious.' : 'Healthy and ready.') + '</small></div><button class="big" id="btnCareerFight">FIGHT</button></div>';
    }
    if (B.plan.length) h += '<div class="camp-plan">Camp so far: ' + B.plan.map(p => '<b>' + (p === 'rest' ? 'Rest' : Career.STAT_BY_KEY[p].label) + '</b>').join(' → ') + '</div>';
    el.innerHTML = h; bindTrain(el);
    const fb = $('#btnCareerFight'); if (fb) fb.onclick = () => launchCareerFight();
  }
  function renderOffers(C) {
    const el = $('#tabOffers');
    let h = '';
    if (C.booked) h += '<div class="offer-none">You are booked against <b>' + esc(C.booked.offer.opp.name) + '</b>. New offers come in after the fight.</div>';
    else if (!C.offers.length) h += '<div class="offer-none">Nobody is calling this week.</div>';
    else {
      h += C.offers.map(o => {
        const d = Career.offerDanger(C, o);
        return '<div class="offer t' + o.tier + (o.title ? ' title' : '') + '"><div><div class="org">' + esc(o.orgName) + '<small>' + Career.TIER_NAME[o.tier].toUpperCase() + '</small>' + (o.title ? '<span class="title-tag">' + (C.champion ? 'TITLE DEFENCE' : 'TITLE FIGHT') + '</span>' : '') + '</div>' +
          '<div class="who">vs <b>' + esc(o.opp.name) + '</b>' + (o.opp.nick ? ' "' + esc(o.opp.nick) + '"' : '') + ' · ' + esc(o.opp.style) + ' · ' + o.opp.record.w + '-' + o.opp.record.l + ' · rating ' + o.opp.rating + dangerTag(d) + '</div>' +
          '<div class="terms">in <b>' + o.weeks + ' weeks</b> · purse <b>' + Career.fmtMoney(o.purse) + '</b> + <b>' + Career.fmtMoney(o.bonus) + '</b> to win · ' + o.rounds + ' rounds</div>' + (o.note ? '<div class="note">' + esc(o.note) + '</div>' : '') + '</div>' +
          '<button data-offer="' + o.id + '">ACCEPT</button></div>';
      }).join('');
    }
    // what it takes to get the next org on the phone
    const next = Career.ORGS.filter(x => x.pop > C.pop).sort((a, b) => a.pop - b.pop)[0];
    h += '<div class="next-org">' + (C.champion ? 'You are the champion. Keep defending.' : C.pop >= Career.TITLE_POP ? 'The champion has agreed to fight you.' :
      next ? 'Next up: <b>' + esc(next.name) + '</b> starts calling at popularity <b>' + next.pop + '</b> (you are at ' + Math.round(C.pop) + '). ' : 'A title shot comes at popularity <b>' + Career.TITLE_POP + '</b>. ') +
      'Wins at bigger shows are worth more; fast finishes are worth a lot more; losses cost you. Each level of the sport can only make you so famous (' + Career.TIER_POP_CAP.slice(0, 3).join(' / ') + ') — move up to keep climbing.</div>';
    el.innerHTML = h;
    el.querySelectorAll('button[data-offer]').forEach(b => b.onclick = () => {
      if (Career.accept(C, +b.dataset.offer)) { Analytics.track('career_offer_accepted', { opponent: C.booked && C.booked.offer.opp.name, org: C.booked && C.booked.offer.orgName, week: C.week }); CareerUI.justFought = false; careerSave(); CareerUI.tab = 'camp'; renderCareer(); }
    });
  }
  function renderGym(C) {
    const el = $('#tabGym');
    let h = '<div class="offer-none">Winnings go here. Each facility level makes a week of that training worth 30% more; the recovery suite heals 4 more damage a week per level; the head coach adds 12% to everything per level.</div>';
    h += Career.FACILITIES.map(f => {
      const lvl = C.gym[f.id] || 0, cost = Career.upgradeCost(f.id, lvl);
      return '<div class="fac"><div><div class="fn">' + esc(f.name) + '</div><div class="fd">' + esc(f.desc) + '</div></div><div class="lvl" title="level ' + lvl + '">' + [1, 2, 3, 4, 5].map(i => '<i class="' + (i <= lvl ? 'on' : '') + '"></i>').join('') + '</div>' +
        (cost == null ? '<button class="ghost" disabled>MAXED</button>' : '<button data-up="' + f.id + '"' + (C.money < cost ? ' class="ghost" disabled' : '') + '>UPGRADE · ' + Career.fmtMoney(cost) + '</button>') + '</div>';
    }).join('');
    el.innerHTML = h;
    el.querySelectorAll('button[data-up]').forEach(b => b.onclick = () => { if (Career.buyUpgrade(C, b.dataset.up)) { Analytics.track('career_upgrade', { facility: b.dataset.up, level: C.gym[b.dataset.up] || 0 }); careerSave(); renderCareer(); } });
  }
  function renderHistory(C) {
    const el = $('#tabHistory');
    let h = '';
    if (!C.history.length) h += '<div class="offer-none">No fights yet.</div>';
    else h += '<table class="hist"><tr><th>#</th><th>Date</th><th>Org</th><th>Opponent</th><th>Result</th><th>Method</th><th>Paid</th><th>Pop</th></tr>' +
      C.history.slice().reverse().map((f, i) => '<tr><td>' + (C.history.length - i) + '</td><td>' + Career.weekLabel(f.week) + '</td><td>' + esc(f.org) + (f.title ? ' <span style="color:var(--gold)">TITLE</span>' : '') + '</td><td>' + esc(f.opp) + ' <span style="color:var(--muted)">(' + f.oppRating + ')</span></td><td class="' + (f.draw ? 'd' : f.won ? 'w' : 'l') + '">' + resultWord(f) + '</td><td>' + esc(f.method) + (/KO|Sub/i.test(f.method) ? ' R' + f.round : '') + '</td><td>' + Career.fmtMoney(f.pay) + '</td><td>' + (f.dPop >= 0 ? '+' : '') + f.dPop + '</td></tr>').join('') + '</table>';
    h += '<div class="news">' + C.log.slice().reverse().map(l => '<div><b>' + Career.weekLabel(l.week).replace('Year ', 'Y').replace(' · Week ', ' W') + '</b>' + esc(l.text) + '</div>').join('') + '</div>';
    el.innerHTML = h;
  }

  // ---- the fight ----
  function launchCareerFight() {
    const C = CareerUI.C; if (!C || !Career.fightReady(C)) return;
    App.audio.init();
    const setup = Career.fightSetup(C);
    App.mode = 'career'; App.myIdx = 0;
    App.lobby.settings.diff = setup.diff; App.lobby.ready = [false, false];
    setup.players[0].moveset = Controls.moveset; setup.players[1].moveset = DEFAULT_MOVESET;
    App.careerApplied = false;
    beginFight({ t: 'start', seed: setup.seed, players: setup.players, settings: setup.settings });
  }
  // the fight is over (or abandoned): book the result once, then back to the hub
  function settleCareerFight() {
    const C = CareerUI.C; if (!C || App.mode !== 'career') return;
    if (App.careerApplied) return;
    App.careerApplied = true;
    const S = App.state;
    const booked = C.booked ? { opponent: C.booked.offer.opp.name, org: C.booked.offer.orgName } : {};
    if (S && S.result && C.booked) Career.applyResult(C, S);
    else if (C.booked) { Career.withdraw(C); toast('You pulled out of the fight. No purse, popularity -4.', 4000); }
    const lf = C.lastFight;
    Analytics.track('career_fight_settled', Object.assign(booked, { withdrew: !(S && S.result), won: lf ? !!lf.won : null, method: lf ? lf.method : null, pay: lf ? lf.pay : null, pop: Math.round(C.pop), record: C.record.w + '-' + C.record.l + '-' + (C.record.d || 0), week: C.week, money: Math.round(C.money) }));
    CareerUI.justFought = true; CareerUI.lastTrain = null; careerSave();
  }
  function leaveCareerFight() { settleCareerFight(); stopFight(); openCareer(); }
  $('#btnCareer').onclick = () => { App.audio.init(); if (careerLoad()) openCareer(); else openCareerNew(); };
  $('#btnCareerNewBack').onclick = () => { if (CareerUI.pickMode === 'profile') closeProfile(); else { LookPreview.stop(); screen('menu'); } };
  $('#btnFighter').onclick = () => { App.audio.init(); openProfile('menu'); };
  $('#btnLobbyLook').onclick = () => openProfile('lobby');
  $('#btnLookClear').onclick = () => { Profile.set(null); toast('Look cleared \u2014 you get a random fighter each fight.', 2500); closeProfile(); };
  // NEW CAREER on the main menu: shown only when a save exists. Click twice to confirm; the old save is
  // kept until the new fighter is actually started, so backing out of the creation screen loses nothing.
  $('#btnCareerNew').onclick = () => {
    const b = $('#btnCareerNew');
    if ((CareerUI.confirmNew = (CareerUI.confirmNew || 0) + 1) < 2) { b.textContent = 'CLICK AGAIN · REPLACES CURRENT SAVE'; setTimeout(() => { CareerUI.confirmNew = 0; b.textContent = 'NEW CAREER'; }, 4000); return; }
    CareerUI.confirmNew = 0; b.textContent = 'NEW CAREER';
    App.audio.init(); CareerUI.pick = { base: 'striker', color: null, skin: null, look: null }; openCareerNew();
  };
  $('#btnCareerStart').onclick = () => startCareer();
  $('#careerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') startCareer(); });
  $('#btnCareerMenu').onclick = () => { careerSave(); screen('menu'); };
  $('#btnCareerGym').onclick = () => { careerSave(); closeStation(); };
  $('#btnGymMenu').onclick = () => { careerSave(); screen('menu'); };
  $('#btnGymOptions').onclick = () => openOptions();
  $('#btnGymLock').onclick = (e) => { e.currentTarget.blur(); if (App.gym && App.gym.active) App.gym.toggleLock(); };
  $('#btnCareerOptions').onclick = () => openOptions();
  $('#btnCareerDelete').onclick = () => {
    if (CareerUI.confirmDel++ < 1) { $('#btnCareerDelete').textContent = 'CLICK AGAIN TO DELETE'; setTimeout(() => { CareerUI.confirmDel = 0; $('#btnCareerDelete').textContent = 'RETIRE (DELETE SAVE)'; }, 4000); return; }
    Analytics.track('career_delete', CareerUI.C ? { record: CareerUI.C.record.w + '-' + CareerUI.C.record.l, week: CareerUI.C.week } : {});
    Career.erase(); CareerUI.C = null; CareerUI.confirmDel = 0; $('#btnCareerDelete').textContent = 'RETIRE (DELETE SAVE)';
    toast('Career deleted.', 2000); screen('menu');
  };
  document.querySelectorAll('#cTabs .tab').forEach(b => b.onclick = () => { CareerUI.tab = b.dataset.tab; renderCareer(); });

  // ============================================================
  //  Striking tutorial: a guided session against a sparring partner (markup: #tutor, #tutorPrompt)
  //  Steps are drills checked against sim events and state; the partner's behaviour follows the step.
  // ============================================================
  const TUT_KEYS = { shown: 'cr_tut_shown', off: 'cr_tut_off', done: 'cr_tut_done' };
  const TUT_PROMPT_TIMES = 3; // opens of the game that offer the tutorial before it stops asking
  const TUT_SPAR_LEN = 90;    // seconds on the clock for the final round
  // The sparring partner. 'idle': stands in his guard and lets you work. 'jab' / 'lowkick': throws that strike every
  // couple of seconds so you can practise the answer. 'spar': the rookie CPU, fighting for real.
  class TutorBrain {
    constructor() { this.mode = 'idle'; this.t = 1.2; this.modHeld = 0; this.modT = 0; this.cpu = null; }
    set(mode) { this.mode = mode; this.t = 1.0; if (mode === 'spar' && !this.cpu) this.cpu = new CpuBrain(1, 0.3); }
    update(S, dt) {
      if (this.mode === 'spar') return this.cpu.update(S, dt);
      if (S.phase !== 'fight') return { held: 0, pressed: 0 };
      const me = S.f[1], op = S.f[0];
      let held = 0, pressed = 0;
      if (me.act.type === 'kd') { if (me.act.name === 'down' && me.act.t > 0.6) pressed |= IN.FWD; return { held: 0, pressed }; }
      const dist = Math.hypot(op.x - me.x, op.z - me.z);
      // he keeps the range the drill needs: steps back out of the clinch (nothing lands from there), and when he is
      // throwing he walks after you so the strikes you have to answer actually come
      if (dist < 0.72) held |= IN.BACK;
      else if (this.mode !== 'idle' && dist > 1.45) held |= IN.FWD;
      if (this.mode === 'jab' || this.mode === 'lowkick') {
        this.t -= dt;
        if (this.t <= 0 && dist < 1.55 && me.act.type !== 'strike' && me.act.type !== 'hit' && me.rocked <= 0) {
          const kind = this.mode === 'jab' ? 'straight' : 'lkick';
          const limb = (this.mode === 'jab' ? ['lh', 'rh'] : ['ll', 'rl'])[Math.random() < 0.5 ? 0 : 1];
          const mod = MODS.find(m => DEFAULT_MOVESET[m][limb] === kind) || 'none';
          this.modHeld = MOD_BIT[mod]; this.modT = 0.35;
          pressed |= LIMB_BIT[limb];
          this.t = (this.mode === 'jab' ? 1.3 : 1.9) + Math.random() * 0.8;
        }
      }
      if (this.modT > 0) { this.modT -= dt; held |= this.modHeld; }
      return { held, pressed };
    }
  }
  const K = (id) => '<b>' + esc(bindName(id)) + '</b>';
  // how the player throws this strike with their own mapping: 'hold Q + U / I', or every way if it is mapped twice
  function strikeHow(kind) {
    const ms = Controls.moveset, ways = [];
    for (const m of MODS) { const limbs = LIMBS.filter(l => ms[m][l] === kind); if (limbs.length) ways.push((m === 'none' ? 'no modifier, ' : 'hold ' + K(m) + ' + ') + limbs.map(K).join(' / ')); }
    return ways.length ? ways.join(', or ') : '<i>not in your strike mapping: see OPTIONS, STRIKES</i>';
  }
  // goal: how many times the check must pass. hit(ev): a strike of yours that reached him (landed or into the guard).
  // block(ev): a strike of his that you blocked. push: a push of yours that reached him. tick(): checked every frame, returns the progress to add.
  // mode: what the partner does. Every step but the last keeps both fighters fresh and the clock still.
  const TUT_STEPS = [
    { id: 'close', title: 'CLOSE THE DISTANCE', goal: 1, mode: 'idle',
      text: () => 'Movement is relative to your opponent: ' + K('fwd') + ' always walks toward him. Hold ' + K('fwd') + ' until you are in punching range.',
      tick: (S, me, op, dist) => dist < 1.12 ? 1 : 0 },
    { id: 'circle', title: 'CIRCLE', goal: 3, mode: 'idle', float: true,
      text: () => 'Hold ' + K('left') + ' or ' + K('right') + ' to circle him. Three seconds of footwork.',
      tick: (S, me, op, dist, dt) => (App.held & (IN.LEFT | IN.RIGHT)) && dist < 2.6 ? dt : 0 }, // circling drifts outward; only footwork far off him is not circling
    { id: 'out', title: 'GET OUT OF RANGE', goal: 1, mode: 'idle',
      text: () => 'Hold ' + K('back') + ' to step out, or tap ' + K('dodge') + ' to dash the way you are stepping (straight back when you stand still). Get out past kicking range.',
      tick: (S, me, op, dist) => dist > Math.max(1.75, Tutor.d0 + 0.5) ? 1 : 0 }, // measured from where the step began, so it never completes on its own
    { id: 'straight', title: 'STRAIGHT PUNCHES', goal: 3, mode: 'idle',
      text: () => 'Your hands are ' + K('lh') + ' and ' + K('rh') + '; the modifier you hold decides the punch. Straights: ' + strikeHow('straight') + '. Step back in and hit him with three.',
      hit: (ev) => ev.kind === 'straight' },
    { id: 'hook', title: 'HOOKS', goal: 3, mode: 'idle',
      text: () => 'Hooks come around the guard: ' + strikeHow('hook') + '. Land three.',
      hit: (ev) => ev.kind === 'hook' },
    { id: 'uppercut', title: 'UPPERCUTS', goal: 2, mode: 'idle',
      text: () => 'Uppercuts come up the middle and are at their best in close: ' + strikeHow('uppercut') + '. Land two.',
      hit: (ev) => ev.kind === 'uppercut' },
    { id: 'overhand', title: 'OVERHANDS', goal: 2, mode: 'idle',
      text: () => 'The overhand loops over the top: ' + strikeHow('overhand') + '. Land two.',
      hit: (ev) => ev.kind === 'overhand' },
    { id: 'lowkick', title: 'LOW KICKS', goal: 2, mode: 'idle',
      text: () => 'Your legs are ' + K('ll') + ' and ' + K('rl') + '. Low kicks: ' + strikeHow('lkick') + '. Leg damage slows him down and takes the power out of his own kicks. Land two.',
      hit: (ev) => ev.kind === 'lkick' },
    { id: 'bkick', title: 'BODY KICKS', goal: 2, mode: 'idle',
      text: () => 'Body kicks: ' + strikeHow('bkick') + '. Body damage shrinks his stamina tank for the rest of the fight. Land two.',
      hit: (ev) => ev.kind === 'bkick' },
    { id: 'hkick', title: 'HEAD KICKS', goal: 1, mode: 'idle',
      text: () => 'Head kicks: ' + strikeHow('hkick') + '. Land one.',
      hit: (ev) => ev.kind === 'hkick' },
    { id: 'teep', title: 'TEEP AND KNEE', goal: 2, mode: 'idle',
      text: () => 'Teep: ' + strikeHow('teep') + '. Knee: ' + strikeHow('knee') + '. The teep is a push kick that keeps him off you; the knee wants him close. Land two of either.',
      hit: (ev) => ev.kind === 'teep' || ev.kind === 'knee' },
    { id: 'power', title: 'PUT YOUR WEIGHT INTO IT', goal: 1, mode: 'idle',
      text: () => 'Stepping in (' + K('fwd') + ') as you throw adds power; backing off takes it away. Land one heavy shot off a step in. Watch the feed: it tells you when a shot lands big.',
      hit: (ev) => !!(ev.big || ev.momentum), landed: true },
    { id: 'block', title: 'BLOCK', goal: 3, mode: 'jab',
      text: () => 'He is going to jab. Hold ' + K('block') + ' to put your guard up and block three. Holding ' + K('mod3') + ' with it drops you into a shell that covers the body too.',
      block: (ev) => !ev.passive && !ev.checked },
    { id: 'push', title: 'PUSH', goal: 2, mode: 'idle',
      text: () => 'Tap ' + K('block') + ' twice quickly to stiff-arm him off you. It only works at arm\'s length, and the closer he is the harder he stumbles. Push him off twice.',
      push: true },
    { id: 'check', title: 'CHECK THE LOW KICK', goal: 2, mode: 'lowkick',
      text: () => 'Now he is kicking your lead leg. Hold ' + K('check') + ' to lift it and check the kick: his shin hits your knee and it hurts him instead of you. Check two.',
      block: (ev) => !!ev.checked },
    { id: 'stance', title: 'SWITCH STANCE', goal: 1, mode: 'idle',
      text: () => 'Tap ' + K('stance') + ' to switch to southpaw (right foot forward). Your lead and rear limbs swap, so the same keys now throw mirrored strikes.',
      stance: true },
    { id: 'spar', title: 'SPAR', goal: 0, mode: 'spar',
      text: () => 'That is the striking game. Now he fights back: one round of ' + TUT_SPAR_LEN + ' seconds, real damage both ways. Finish him or hear the bell. <b>ESC</b> pauses and opens the options; QUIT TUTORIAL leaves any time.' }
  ];
  const Tutor = { active: false, brain: null, i: 0, n: 0, dirty: true, shown: -1, d0: 2.6 }; // d0: the distance between the fighters when the step began
  function tutorPromptOpen() { return !$('#tutorPrompt').classList.contains('hidden'); }
  function startTutorial() {
    App.audio.init();
    hide($('#tutorPrompt'));
    if (App.net) { App.net.destroy(); App.net = null; }
    App.mode = 'tutorial'; App.myIdx = 0; App.lobby.ready = [false, false]; App.lobby.settings.diff = 0.3;
    const players = [
      { fighter: 'striker', name: myName() || 'You', moveset: Controls.moveset },
      { fighter: 'balanced', name: 'Sparring Partner', moveset: DEFAULT_MOVESET }
    ];
    applyProfile(players[0], Profile.get()); applyProfile(players[1], null);
    Tutor.brain = new TutorBrain(); Tutor.active = true;
    Analytics.track('tutorial_start');
    tutorEnter(0);
    beginFight({ t: 'start', seed: (Math.random() * 1e9) | 0, players, settings: { rounds: 1, len: 180, grappling: false } });
  }
  function tutorStop() {
    if (!Tutor.active && !Tutor.brain) return;
    Tutor.active = false; Tutor.brain = null; Tutor.shown = -1;
    hide($('#tutor'));
  }
  function tutorEnter(i) {
    Tutor.i = i; Tutor.n = 0; Tutor.dirty = true;
    Analytics.track('tutorial_step', { step: i + 1, step_id: TUT_STEPS[i].id, of: TUT_STEPS.length });
    const S = App.sim && App.state; Tutor.d0 = S ? Math.hypot(S.f[1].x - S.f[0].x, S.f[1].z - S.f[0].z) : 2.6;
    const st = TUT_STEPS[i];
    if (Tutor.brain) Tutor.brain.set(st.mode);
    if (st.id === 'spar') {
      try { localStorage.setItem(TUT_KEYS.done, '1'); } catch (_) {} // every drill seen: the prompt stops asking
      if (App.state) App.state.clock = TUT_SPAR_LEN;
      centerMsg('SPAR<small>' + TUT_SPAR_LEN + ' seconds, for real</small>', 2200);
    }
  }
  function tutorProgress(add) {
    const st = TUT_STEPS[Tutor.i];
    if (!st.goal) return;
    Tutor.n = Math.min(st.goal, Tutor.n + add); Tutor.dirty = true;
    if (Tutor.n >= st.goal - 1e-6) tutorAdvance();
  }
  function tutorAdvance() {
    if (Tutor.i + 1 >= TUT_STEPS.length) return;
    App.audio.roar(0.12);
    const el = $('#tutor'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    tutorEnter(Tutor.i + 1);
  }
  function tutorEvent(ev) {
    if (!App.sim) return;
    const st = TUT_STEPS[Tutor.i];
    if (ev.k === 'end') { Tutor.active = false; hide($('#tutor')); return; } // the spar round is over: the end screen takes it from here
    if (st.hit && ev.i === 0 && (ev.k === 'hit' || (ev.k === 'block' && !st.landed)) && st.hit(ev)) tutorProgress(1);
    else if (st.block && ev.k === 'block' && ev.j === 0 && st.block(ev)) tutorProgress(1);
    else if (st.push && ev.k === 'push' && ev.i === 0 && ev.ok) tutorProgress(1);
    else if (st.stance && ev.k === 'stance' && ev.i === 0) tutorProgress(1);
  }
  function tutorFresh(f) { f.dmg.head = 0; f.dmg.body = 0; f.dmg.legs = 0; f.stamMax = 100; f.stam = 100; if (f.rocked > 0) f.rocked = 0; }
  function tutorTick(S, dt) {
    if (!App.sim) return;
    const st = TUT_STEPS[Tutor.i], me = S.f[0], op = S.f[1];
    if (st.id !== 'spar') {
      S.clock = S.roundLen;      // the clock waits until the spar
      tutorFresh(me); tutorFresh(op); // nobody gets hurt or tired during the drills
      if (S.phase === 'fight' && st.tick) {
        const add = st.tick(S, me, op, Math.hypot(op.x - me.x, op.z - me.z), dt);
        if (add) tutorProgress(add);
      }
    }
    if (Tutor.dirty) tutorRender();
  }
  function tutorRender() {
    Tutor.dirty = false;
    const el = $('#tutor'); if (!el || !Tutor.active) return;
    show(el);
    const st = TUT_STEPS[Tutor.i];
    if (Tutor.shown !== Tutor.i) { // the words change with the step (and with the device the keys are named for)
      Tutor.shown = Tutor.i;
      $('#tutStep').textContent = 'STRIKING TUTORIAL · STEP ' + (Tutor.i + 1) + ' OF ' + TUT_STEPS.length;
      $('#tutTitle').textContent = st.title;
      $('#tutText').innerHTML = st.text();
      $('#tutProg').classList.toggle('hidden', !st.goal);
      $('#btnTutSkip').classList.toggle('hidden', st.id === 'spar');
    }
    if (st.goal) {
      $('#tutCount').textContent = Math.min(st.goal, Math.floor(Tutor.n + 1e-6)) + ' / ' + st.goal;
      $('#tutProg .fill').style.width = pct(Tutor.n / st.goal * 100);
    }
  }
  // the first few times the game opens, offer the tutorial; the checkbox or finishing it stops the asking
  function maybeTutorPrompt() {
    let shown = 0, off = false, done = false;
    try { shown = parseInt(localStorage.getItem(TUT_KEYS.shown) || '0', 10) || 0; off = localStorage.getItem(TUT_KEYS.off) === '1'; done = localStorage.getItem(TUT_KEYS.done) === '1'; } catch (_) {}
    if (off || done || shown >= TUT_PROMPT_TIMES) return;
    try { localStorage.setItem(TUT_KEYS.shown, String(shown + 1)); } catch (_) {}
    $('#tutPromptNote').textContent = shown + 1 >= TUT_PROMPT_TIMES ? 'This is the last time we ask. The tutorial stays on the main menu.' : 'The tutorial is always on the main menu, under PRACTICE.';
    $('#tutNever').checked = false;
    show($('#tutorPrompt'));
    $('#btnTutYes').focus();
  }
  function closeTutorPrompt() {
    if ($('#tutNever').checked) { try { localStorage.setItem(TUT_KEYS.off, '1'); } catch (_) {} }
    hide($('#tutorPrompt'));
  }
  $('#btnTutNo').onclick = () => { Analytics.track('tutorial_prompt', { accepted: false, never: $('#tutNever').checked }); closeTutorPrompt(); };
  $('#btnTutYes').onclick = () => { Analytics.track('tutorial_prompt', { accepted: true }); closeTutorPrompt(); startTutorial(); };
  $('#btnTutorial').onclick = () => startTutorial();
  $('#btnTutSkip').onclick = (e) => { e.currentTarget.blur(); if (Tutor.active) { Analytics.track('tutorial_skip', { step: Tutor.i + 1, step_id: TUT_STEPS[Tutor.i].id }); tutorAdvance(); } };
  $('#btnTutQuit').onclick = (e) => { e.currentTarget.blur(); Analytics.track('tutorial_quit', { step: Tutor.i + 1, step_id: TUT_STEPS[Tutor.i] && TUT_STEPS[Tutor.i].id }); stopFight(); App.mode = null; screen('menu'); };

  // ============================================================
  //  Wire up buttons
  // ============================================================
  $('#btnHost').onclick = () => { App.audio.init(); startHost(); };
  $('#btnJoin').onclick = () => { App.audio.init(); const open = !$('#joinRow').classList.toggle('hidden'); $('#btnJoin').setAttribute('aria-expanded', open ? 'true' : 'false'); if (open) $('#joinCode').focus(); };
  $('#btnJoinGo').onclick = () => { const c = $('#joinCode').value.trim(); if (c.length < 4) { toast('Enter the 5-letter room code.'); return; } startJoin(c); };
  $('#joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoinGo').click(); });
  $('#btnPractice').onclick = () => { App.audio.init(); enterLobby('practice'); };
  $('#btnWatch').onclick = () => { App.audio.init(); enterLobby('watch'); };
  $('#btnOptions').onclick = () => openOptions();
  $('#btnFeedback').onclick = () => openFeedback();
  $('#fbTab').onclick = () => openFeedback();
  $('#btnFbClose').onclick = () => closeFeedback();
  $('#btnFbSend').onclick = () => sendFeedback();
  $('#btnFbCopy').onclick = async () => { const ok = await copyText(fbText(fbReport(), $('#fbText').value.trim(), $('#fbContact').value.trim())); toast(ok ? 'Copied. Paste it anywhere.' : 'Copy failed. Select the text and copy it by hand.', 2500); };
  document.querySelectorAll('#fbKind button').forEach(b => b.onclick = () => { FB.kind = b.dataset.kind; document.querySelectorAll('#fbKind button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b ? 'true' : 'false'); }); });
  try { $('#fbContact').value = localStorage.getItem('cr_fb_contact') || ''; } catch (_) {}
  $('#ctlTab').onclick = () => toggleHint();
  window.addEventListener('resize', syncHint);
  if (window.desktop) { // Electron build (desktop/preload.js)
    $('#btnQuit').classList.remove('hidden');
    $('#btnQuit').onclick = () => { Analytics.track('quit_to_desktop'); setTimeout(() => window.desktop.quit(), 150); };
    if (window.desktop.version) $('#menuVersion').textContent = 'v' + window.desktop.version;
  }
  $('#btnLobbyOptions').onclick = () => openOptions();
  $('#btnOptClose').onclick = () => closeOptions();
  // options pages: the chosen tab sticks for the session
  function showOptTab(name) {
    cancelCapture(); App.optTab = name;
    document.querySelectorAll('#optTabs .opt-tab').forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    document.querySelectorAll('#options .opt-page').forEach(p => p.classList.toggle('hidden', p.dataset.page !== name));
  }
  document.querySelectorAll('#optTabs .opt-tab').forEach(b => b.onclick = () => showOptTab(b.dataset.tab));
  $('#btnOptReset').onclick = () => resetControls();
  (function bindMusicVolume() {
    const sl = $('#musicVol'), lbl = $('#musicVolLbl');
    const boxes = [$('#muteMusic'), $('#muteMusicOpt')];
    const showVol = (p) => { sl.value = String(p); lbl.textContent = String(p); };
    showVol(Math.round(App.audio.musicVol * 100));
    sl.addEventListener('input', () => {
      const p = Math.max(0, Math.min(100, parseInt(sl.value, 10) || 0));
      App.audio.setMusicVolume(p / 100);
      lbl.textContent = String(p);
    });
    const syncMute = () => { for (const box of boxes) box.checked = App.audio.musicMuted; };
    syncMute();
    for (const box of boxes) box.addEventListener('change', () => { App.audio.setMusicMuted(box.checked); syncMute(); });
  })();
  updateHint();
  $('#btnBack').onclick = () => { if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('#codeLbl').textContent).then(() => toast('Room code copied', 1500)); };
  $('#btnReady').onclick = () => {
    Analytics.track('lobby_ready', { mode: App.mode, pick: App.lobby.picks[App.myIdx], cpu_pick: App.lobby.cpuPick });
    App.lobby.ready[App.myIdx] = true; App.lobby.names[App.myIdx] = myName();
    readSettings(); refreshLobby(); sendPick(); maybeStart();
  };
  $('#nameInput').addEventListener('change', () => { App.lobby.names[App.myIdx] = myName(); sendPick(); refreshLobby(); });
  for (const id of ['selRounds', 'selLen', 'selGrapple']) $('#' + id).addEventListener('change', () => { readSettings(); sendPick(); refreshLobby(); });
  $('#btnMenu').onclick = () => { if (App.mode === 'career') settleCareerFight(); stopFight(); if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnOptQuit').onclick = () => { closeOptions(); if (App.mode === 'career') { leaveCareerFight(); return; } if (App.mode === 'gym') { careerSave(); screen('menu'); return; } stopFight(); if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnRematch').onclick = () => {
    Analytics.track('rematch', { mode: App.mode });
    if (App.mode === 'career') { leaveCareerFight(); return; }
    if (App.mode === 'tutorial') { startTutorial(); return; }
    if (App.mode === 'guest') { App.net.send({ t: 'rematch' }); $('#btnRematch').textContent = 'WAITING FOR HOST…'; $('#btnRematch').disabled = true; return; }
    App.rematch[0] = true;
    if (App.mode === 'host' && !App.rematch[1]) { $('#btnRematch').textContent = 'WAITING FOR OPPONENT…'; $('#btnRematch').disabled = true; }
    maybeRematch();
  };
  refreshMenuCareer();
  try { $('#nameInput').value = localStorage.getItem('cr_name') || ''; } catch (_) {}
  $('#nameInput').addEventListener('input', () => { try { localStorage.setItem('cr_name', $('#nameInput').value); } catch (_) {} });

  window.addEventListener('mmaphys', (e) => { if (!e.detail.ok) { App.physFailed = true; toast('Physics engine failed to load: ' + (e.detail.error && e.detail.error.message), 8000); } });

  // Hidden extras: clicking the title's G (#titleG) opens the 'more' screen.
  const Extras = { mark: false, ref: true, sphere: true };
  function loadExtras() {
    try {
      Extras.mark = localStorage.getItem('cr_fx_1') === '1';
      Extras.ref = localStorage.getItem('cr_ref') !== '0';
      Extras.sphere = localStorage.getItem('cr_sphere') !== '0';
    } catch (_) {}
  }
  function saveExtras() {
    try {
      localStorage.setItem('cr_fx_1', Extras.mark ? '1' : '0');
      localStorage.setItem('cr_ref', Extras.ref ? '1' : '0');
      localStorage.setItem('cr_sphere', Extras.sphere ? '1' : '0');
    } catch (_) {}
  }
  function syncExtras() {
    const mark = $('#optMark');
    if (mark) mark.checked = Extras.mark;
    const ref = $('#optRef');
    if (ref) ref.checked = Extras.ref;
    const sphere = $('#optSphere');
    if (sphere) sphere.checked = Extras.sphere;
    if (App.renderer) { App.renderer.setMarks(Extras.mark); App.renderer.setRefVisible(Extras.ref); App.renderer.setImpactSphere(Extras.sphere); }
    updateHint();
  }
  function lineName(i) {
    const f = App.state && App.state.f && App.state.f[i];
    if (f && f.name) return f.name;
    if (i === App.myIdx) return myName() || 'You';
    return 'Opponent';
  }
  const cleanLine = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const SAY_GAP_MS = 300; // the host takes at most one chat line per this from the guest (see onHostData)
  let guestSayT = -1e9;
  function showLine(i, text) {
    text = cleanLine(text);
    if (!text || !App.talk) return;
    const slot = App.state && App.state.f && App.state.f[i] ? i : null;
    App.talk.add(lineName(i), text, slot);
  }
  function postLine(text) {
    text = cleanLine(text);
    if (!text) return;
    if (App.mode === 'guest') { if (App.net) App.net.send({ t: 'say', m: text }); return; }
    showLine(App.myIdx, text);
    if (App.mode === 'host' && App.net) App.net.send({ t: 'say', i: App.myIdx, m: text });
  }
  function tickTalk(dt) {
    if (!App.talk || !App.renderer || !App.renderer.camera) return;
    const cam = App.renderer.camera;
    const w = window.innerWidth, h = window.innerHeight;
    if (!App.talk._v && typeof THREE !== 'undefined') App.talk._v = new THREE.Vector3();
    App.talk.tick(dt, (slot) => {
      const m = App.renderer.models[slot];
      if (!m || !m.headWorld || !App.talk._v) return null;
      const v = m.headWorld(App.talk._v);
      v.y += 0.45;
      v.project(cam);
      if (v.z > 1) return null;
      return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
    });
  }
  App.extras = Extras;
  loadExtras();
  $('#titleG').onclick = () => { if ($('#menu').classList.contains('hidden')) return; screen('more'); syncExtras(); };
  $('#btnMoreClose').onclick = () => screen('menu');
  $('#optMark').addEventListener('change', () => { Extras.mark = $('#optMark').checked; saveExtras(); syncExtras(); });
  $('#optRef').addEventListener('change', () => { Extras.ref = $('#optRef').checked; saveExtras(); syncExtras(); });
  $('#optSphere').addEventListener('change', () => { Extras.sphere = $('#optSphere').checked; saveExtras(); syncExtras(); });
  syncExtras();
  menuHint();
  App.talk = new CageTalk.Talk();
  App.talk.mount();
  App.talk.onLine = postLine;
  maybeTutorPrompt();

  window.CageRules = App; // dev hook: window.CageRules.sim / .state / .renderer
  App.tutor = Tutor; App.startTutorial = startTutorial; // dev hook: the striking tutorial's step state (tools / scratch tests)
  // dev hook: advance the career gym by n 60 Hz frames with these inputs (tools/gym-test.js)
  App.gymTick = (n, held, pressed) => { if (!App.gym || !App.gym.active) return; for (let k = 0; k < n; k++) { App.gym.update(1 / 60, held | 0, k === 0 ? (pressed | 0) : 0, IN_INTERACT, IN_LOCK); } };
  // dev hook: advance a practice fight by n sim ticks regardless of frame rate (used by tools/browser-test.js)
  App.tick = (n) => {
    const sim = App.sim; if (!sim) return;
    for (let k = 0; k < n; k++) {
      if (App.autoPilot) { const o = App.autoPilot.update(sim.state, 1 / 60); sim.setInput(0, o.held, o.pressed); } else sim.setInput(0, App.held & SIM_MASK, App.pressed & SIM_MASK);
      if (App.brain) { const o = App.brain.update(sim.state, 1 / 60); sim.setInput(1, o.held, o.pressed); }
      sim.acc = 0; sim.step(1 / 60);
      const evs = sim.drainEvents(); if (evs.length) processEvents(evs, sim.state);
    }
  };

  // Build the arena right away so the menu has a live 3D background
  Analytics.register({ build: window.desktop && window.desktop.version ? 'desktop v' + window.desktop.version : 'web', has_career: !!careerLoad(), has_look: !!Profile.get() });
  Analytics.track('app_open', { screen_px: innerWidth + 'x' + innerHeight, dpr: devicePixelRatio || 1, lang: navigator.language });
  window.addEventListener('load', () => {
    try { menuScene(); syncExtras(); } catch (e) { console.error(e); toast('WebGL failed to start: ' + e.message, 8000); }
  });
  // Browsers block audio until a gesture, and a rejected play() must be retried on the next one.
  function unlockMusic() {
    if (App.playing || !$('#end').classList.contains('hidden')) App.audio.play('fight');
    else if (App.gym && App.gym.active) App.audio.play('menu');
  }
  window.addEventListener('pointerdown', unlockMusic);
  window.addEventListener('keydown', unlockMusic);
})();
