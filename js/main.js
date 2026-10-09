/* ============================================================
   Cage Rules — app glue: menus, lobby, input, game loop, HUD, netcode
   ============================================================ */
(function () {
  'use strict';
  const { IN, Sim, ROSTER, describe, LIMBS, LIMB_NAME, MODS, HAND_KINDS, LEG_KINDS, KIND_LABEL, DEFAULT_MOVESET, normalizeMoveset, POS_NAME, MOVES, SUBS_BY, BOTTOM_CAN_STRIKE, KD, BREAK_T } = window.MMASim;
  const { CpuBrain } = window.MMAAI;
  const { Renderer } = window.MMARender;
  const { Net } = window.MMANet;
  const { Audio } = window.MMAAudio;
  const Career = window.MMACareer;

  const $ = (s) => document.querySelector(s);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  // ---------- controls (rebindable, saved in localStorage) ----------
  const ACTIONS = [
    { id: 'fwd', label: 'Move in · lunge in (tap twice)', bit: IN.FWD, def: ['KeyW', 'ArrowUp'] },
    { id: 'back', label: 'Back off · lunge out (tap twice)', bit: IN.BACK, def: ['KeyS', 'ArrowDown'] },
    { id: 'left', label: 'Circle left · lunge left (tap twice)', bit: IN.LEFT, def: ['KeyA', 'ArrowLeft'] },
    { id: 'right', label: 'Circle right · lunge right (tap twice)', bit: IN.RIGHT, def: ['KeyD', 'ArrowRight'] },
    { id: 'lh', label: 'Left hand', bit: IN.LHAND, def: ['KeyU', ''] },
    { id: 'rh', label: 'Right hand', bit: IN.RHAND, def: ['KeyI', ''] },
    { id: 'll', label: 'Left leg', bit: IN.LLEG, def: ['KeyJ', ''] },
    { id: 'rl', label: 'Right leg', bit: IN.RLEG, def: ['KeyK', ''] },
    { id: 'mod1', label: 'Modifier 1 (hold)', bit: IN.MOD1, def: ['KeyQ', ''] },
    { id: 'mod2', label: 'Modifier 2 (hold)', bit: IN.MOD2, def: ['KeyE', ''] },
    { id: 'mod3', label: 'Modifier 3 (hold)', bit: IN.MOD3, def: ['KeyR', ''] },
    { id: 'block', label: 'Block / sprawl / cover (hold) · push (tap twice)', bit: IN.BLOCK, def: ['KeyL', 'Semicolon'] },
    { id: 'grapple', label: 'Takedown / submission / sweep', bit: IN.GRAPPLE, def: ['Space', ''] },
    { id: 'dodge', label: 'Slip / stand up', bit: IN.DODGE, def: ['ShiftLeft', 'ShiftRight'] },
    { id: 'stance', label: 'Switch stance (orthodox / southpaw)', bit: IN.STANCE, def: ['KeyX', ''] },
    { id: 'check', label: 'Check low kicks: lift the lead leg (hold)', bit: IN.CHECK, def: ['KeyO', ''] },
    { id: 'interact', label: 'Use (gym: computer, whiteboard, desk)', bit: 1 << 14, def: ['Enter', 'KeyF'] },
    { id: 'lock', label: 'Lock on to the heavy bag (gym)', bit: 1 << 15, def: ['KeyT', ''] }
  ];
  const IN_INTERACT = 1 << 14, IN_LOCK = 1 << 15, SIM_MASK = 0x3fff | IN.STANCE | IN.CHECK; // interact/lock are app-only bits; mask with SIM_MASK before input reaches the sim
  const Controls = { binds: {}, moveset: null, keyMap: {} };
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
  function loadControls() {
    Controls.binds = defaultBinds();
    Controls.moveset = normalizeMoveset(DEFAULT_MOVESET);
    try {
      const b = JSON.parse(localStorage.getItem('cr_binds') || 'null');
      if (b) for (const a of ACTIONS) if (Array.isArray(b[a.id])) Controls.binds[a.id] = [String(b[a.id][0] || ''), String(b[a.id][1] || '')];
      const m = JSON.parse(localStorage.getItem('cr_moveset') || 'null');
      if (m) Controls.moveset = normalizeMoveset(m);
    } catch (_) {}
    rebuildKeyMap();
  }
  function saveControls() {
    try { localStorage.setItem('cr_binds', JSON.stringify(Controls.binds)); localStorage.setItem('cr_moveset', JSON.stringify(Controls.moveset)); } catch (_) {}
    rebuildKeyMap();
  }
  function rebuildKeyMap() {
    Controls.keyMap = {};
    for (const a of ACTIONS) for (const c of Controls.binds[a.id]) if (c) Controls.keyMap[c] = (Controls.keyMap[c] | 0) | a.bit;
  }
  loadControls();

  const App = {
    mode: null, net: null, sim: null, renderer: null, audio: new Audio(), brain: null,
    myIdx: 0, held: 0, pressed: 0, remote: { h: 0, p: 0 },
    lobby: { picks: ['striker', 'wrestler'], names: ['', ''], ready: [false, false], settings: { rounds: 3, len: 180, diff: 0.6 }, cpuPick: 'random', movesets: [null, null] },
    optionsOpen: false, paused: false,
    state: null, playing: false, lastSnap: 0, lastInputSend: 0, evQueue: [], rematch: [false, false],
    feedLines: [], hintsHidden: false
  };

  // practice (you vs CPU), watch (CPU vs CPU) and career run the sim locally with no network
  const isLocal = () => App.mode === 'practice' || App.mode === 'watch' || App.mode === 'career';

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
    // leaving the walkable gym for anything but one of its own station panels tears the room down
    if (App.gym && App.gym.active && name !== 'career') exitGym(name === null); // screen(null) = a fight is taking the scene
    hide($('#gymHud'));
    for (const id of ['menu', 'lobby', 'end', 'career', 'careerNew', 'more']) { const el = $('#' + id); if (el && id === name) show(el); else if (el) hide(el); }
    if (App.optionsOpen) closeOptions();
    if (name) hide($('#hud')); else show($('#hud'));
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
      const c = document.createElement('div'); c.className = 'card'; c.dataset.key = key;
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
    else if (App.mode === 'guest') App.net.send({ t: 'pick', fighter: App.lobby.picks[1], name: myName(), ready: App.lobby.ready[1], moveset: Controls.moveset });
  }

  function enterLobby(mode) {
    App.mode = mode; App.myIdx = mode === 'guest' ? 1 : 0;
    App.lobby.ready = [false, false]; App.rematch = [false, false];
    buildRoster(); screen('lobby'); refreshLobby();
  }

  function startHost() {
    App.net = new Net({
      onReady: (code) => { $('#codeLbl').textContent = code; refreshLobby(); },
      onConnect: () => { toast('Opponent connected!'); App.lobby.names[0] = myName(); sendPick(); refreshLobby(); },
      onData: onHostData,
      onClose: () => { onOpponentLeft(); },
      onError: (m) => toast(m, 6000)
    });
    App.net.host();
    enterLobby('host');
    $('#codeLbl').textContent = '…';
  }
  function startJoin(code) {
    App.net = new Net({
      onConnect: () => { toast('Connected to room ' + App.net.code); enterLobby('guest'); App.lobby.names[1] = myName(); sendPick(); },
      onData: onGuestData,
      onClose: () => { onOpponentLeft(); },
      onError: (m) => { toast(m, 6000); if (!App.net.connected) { App.net.destroy(); App.net = null; } }
    });
    App.net.join(code);
    toast('Connecting to ' + code + '…', 8000);
  }
  function onOpponentLeft() {
    toast('Opponent disconnected.', 5000);
    stopFight(); if (App.net) { App.net.destroy(); App.net = null; }
    App.mode = null; screen('menu');
  }

  function onHostData(d) {
    switch (d.t) {
      case 'pick':
        App.lobby.picks[1] = ROSTER[d.fighter] ? d.fighter : 'balanced';
        App.lobby.names[1] = (d.name || '').slice(0, 14);
        App.lobby.ready[1] = !!d.ready;
        App.lobby.movesets[1] = normalizeMoveset(d.moveset);
        refreshLobby(); sendPick(); maybeStart(); break;
      case 'in':
        App.remote.h = d.h | 0; App.remote.p |= (d.p | 0); break;
      case 'say': {
        showLine(1, d.m);
        if (App.net) App.net.send({ t: 'say', i: 1, m: d.m });
        break;
      }
      case 'rematch':
        App.rematch[1] = true; toast('Opponent wants a rematch!'); maybeRematch(); break;
    }
  }
  function onGuestData(d) {
    switch (d.t) {
      case 'lobby':
        App.lobby.picks[0] = d.picks[0]; App.lobby.names[0] = d.names[0]; App.lobby.ready[0] = d.ready[0];
        App.lobby.settings = d.settings;
        if (d.settings) { $('#selRounds').value = d.settings.rounds; $('#selLen').value = d.settings.len; $('#selGrapple').value = d.settings.grappling === false ? '0' : '1'; }
        refreshLobby(); break;
      case 'start':
        beginFight(d); break;
      case 's':
        App.state = d.s; App.lastSnap = performance.now();
        if (d.ev && d.ev.length) processEvents(d.ev, App.state);
        break;
      case 'say':
        if (d && d.m) showLine(d.i, d.m);
        break;
    }
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
    // same archetype -> alternate shorts colour so they're distinguishable
    if (players[0].fighter === players[1].fighter) players[1].color = 0x8e44ad;
    const msg = { t: 'start', seed: (Math.random() * 1e9) | 0, players, settings: { rounds: L.settings.rounds, len: L.settings.len, grappling: L.settings.grappling !== false } };
    if (App.mode === 'host') App.net.send(msg);
    beginFight(msg);
  }

  // ============================================================
  //  Fight lifecycle
  // ============================================================
  function ensureRenderer() {
    if (!App.renderer) App.renderer = new Renderer($('#gl'), App.audio);
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
    App.sim = null; App.state = null; App.evQueue = []; App.remote = { h: 0, p: 0 }; App.rematch = [false, false];
    App.lobby.ready = [false, false];
    if (isHost) {
      App.sim = new Sim({ seed: msg.seed, rounds: msg.settings.rounds, roundLen: msg.settings.len, players: msg.players, grappling: msg.settings.grappling !== false });
      App.state = App.sim.state;
      const diff = App.lobby.settings.diff;
      App.brain = isLocal() ? new CpuBrain(1, diff) : null;
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
    $('#controlsHint').style.display = App.mode === 'watch' || App.hintsHidden ? 'none' : '';
    App.playing = true;
    App.audio.setCrowd(0.06);
    centerMsg('ROUND 1<small>' + App.state.f[0].name + ' vs ' + App.state.f[1].name + (App.state.grappling === false ? ' · striking only' : '') + '</small>', 2600);
  }

  function stopFight() { App.playing = false; App.paused = false; if (App.sim) App.sim.destroy(); App.sim = null; hideCenter(); $('#grapple').classList.remove('show'); }

  function showEnd(S) {
    const R = S.result; if (!R) return;
    const w = R.winner == null ? null : S.f[R.winner];
    $('#endMethod').textContent = R.method.toUpperCase() + (R.method.indexOf('Decision') < 0 && R.method !== 'Majority Draw' ? ' · ROUND ' + R.round + ' · ' + R.time : '');
    $('#endWinner').textContent = w ? w.name + ' WINS' : 'DRAW';
    $('#endWinner').style.color = w ? (App.mode === 'watch' ? '#fff' : R.winner === App.myIdx ? '#52d273' : '#e23b3b') : '#fff';
    $('#endDetail').textContent = w ? (App.mode === 'watch' ? '' : R.winner === App.myIdx ? 'Victory.' : 'Defeat.') : 'The judges could not separate them.';
    // scorecards
    let h = '<tr><th>Judges</th>' + S.cards.map(c => '<th>R' + c.round + '</th>').join('') + '<th>Total</th></tr>';
    for (let j = 0; j < 3; j++) {
      let a = 0, b = 0;
      h += '<tr><td>Judge ' + (j + 1) + '</td>' + S.cards.map(c => { a += c.j[j][0]; b += c.j[j][1]; return '<td>' + c.j[j][0] + '–' + c.j[j][1] + '</td>'; }).join('') + '<td><b>' + a + '–' + b + '</b></td></tr>';
    }
    $('#cards').innerHTML = h;
    // totals use ts alone: after a stoppage the last round's rs is already folded into ts, so adding rs double-counts
    const ts = S.f.map(f => f.ts);
    const row = (lbl, fn) => '<tr><td>' + lbl + '</td><td>' + fn(ts[0]) + '</td><td>' + fn(ts[1]) + '</td></tr>';
    $('#totals').innerHTML = '<tr><th></th><th>' + S.f[0].name + '</th><th>' + S.f[1].name + '</th></tr>' +
      row('Strikes landed / thrown', s => s.landed + ' / ' + s.thrown) + row('Damage dealt', s => Math.round(s.sig)) +
      row('Takedowns', s => s.td + ' / ' + s.tdAtt) + row('Control time', s => Math.round(s.ctrl) + 's') + row('Submission attempts', s => s.subs) + row('Knockdowns', s => s.kd);
    $('#btnRematch').textContent = 'REMATCH'; $('#btnRematch').disabled = false;
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
      const text = describe(ev, S);
      switch (ev.k) {
        case 'hit': A.hit(ev.big || ev.rocked, ev.part); feed(text, ev.big || ev.rocked || ev.counter); break;
        case 'block': A.block(); if (ev.checked || Math.random() < 0.35) feed(text); break;
        case 'push': if (ev.ok) { A.block(); feed(text); } else A.whiff(); break;
        case 'miss': A.whiff(); if (ev.slipped) feed(text); break;
        case 'kd': A.slam(); centerMsg('KNOCKDOWN!', 1400); feed(text, true); break;
        case 'follow': A.slam(); feed(text, true); break;
        case 'getup': case 'stance': feed(text); break;
        case 'td': A.slam(); feed(text, true); break;
        case 'sweep': A.slam(); feed(text, true); break;
        case 'tdfail': case 'shoot': case 'standup': case 'subfail': feed(text); break;
        case 'sub': A.roar(0.2); feed(text, true); break;
        case 'gattempt': feed(text); break;
        case 'gresult': if (ev.ok) { A.slam(); feed(text, !!(ev.flip || ev.stand)); } else { A.block(); feed(text); } break;
        case 'subescape': A.whistle(); feed(text, true); break;
        case 'subhold': A.block(); feed(text); break;
        case 'tap': A.tap(); feed(text, true); break;
        case 'ko': A.horn(); feed(text, true); break;
        case 'bell':
          if (ev.end) { A.bell(2); centerMsg('END OF ROUND ' + ev.round, 2500); }
          else { A.bell(1); centerMsg('FIGHT!', 900); }
          feed(text); break;
        case 'round': centerMsg('ROUND ' + ev.round, 2200); break;
        case 'end': {
          // no centre-screen result here: the ref announces the winner in the hand-raise, and the end screen follows
          const res = ev.res;
          if (res.method.indexOf('Decision') >= 0 || res.method.indexOf('Draw') >= 0) A.bell(3);
          // after the referee has raised the winner's hand
          setTimeout(() => { if (App.state && App.state.result) showEnd(App.state); }, window.MMARender.ceremonyEnd(res) * 1000);
          break;
        }
      }
    }
  }

  // ============================================================
  //  HUD
  // ============================================================
  function pct(v) { return Math.max(0, Math.min(100, v)) + '%'; }
  const kn = id => keyName(Controls.binds[id][0]);
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
    $('#pingLbl').textContent = App.net && App.net.connected ? App.net.ping + ' ms' : App.mode === 'practice' ? 'CPU' : App.mode === 'watch' ? 'AI vs AI' : '';
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
        kdTxt = '<span class="t">' + op.name.toUpperCase() + ' IS DOWN</span><b>' + kn('grapple') + '</b> dive on him' + (dist > KD.FOLLOW_DIST ? ' (get closer)' : '') + ' · back off to keep it standing — he comes up rocked';
      }
    }
    if (kdTxt) { kh.innerHTML = kdTxt; kh.classList.add('show'); } else kh.classList.remove('show');
    // ground panel
    const g = $('#grapple');
    if (S.ground && S.phase === 'fight') {
      const G = S.ground;
      g.classList.add('show'); g.classList.toggle('subbing', !!G.sub);
      const meTop = G.top === App.myIdx, role = meTop ? 'top' : 'bottom';
      $('#gTitle').textContent = (POS_NAME[G.pos] + ' · ' + S.f[G.top].name + ' on top').toUpperCase();
      // transition attempt
      const ar = $('#attRow');
      if (G.trans) {
        ar.classList.add('show');
        $('#attName').textContent = (G.trans.by === App.myIdx && App.mode !== 'watch' ? 'YOU: ' : S.f[G.trans.by].name.toUpperCase() + ': ') + G.trans.name.toUpperCase();
        ar.querySelector('.fill').style.width = pct(G.trans.t / G.trans.dur * 100);
        ar.classList.toggle('mine', G.trans.by === App.myIdx);
      } else ar.classList.remove('show');
      if (G.sub) {
        const sub = G.sub, mineAtt = sub.att === App.myIdx;
        g.querySelector('.sub .fill').style.width = pct(sub.prog); $('#subName').textContent = sub.name.toUpperCase();
        $('#subState').textContent = (sub.squeezing ? 'SQUEEZING' : 'LOOSE') + (sub.defending ? ' · DEFENDING' : '');
        $('#gHint').textContent = App.mode === 'watch' ? '' : mineAtt
          ? 'Hold ' + kn('grapple') + ' to squeeze (burns stamina) — let go to breathe, but they can slip out when it\'s loose.'
          : 'Hold ' + kn('block') + ' to fight the hold (slows it). Tap ' + kn('grapple') + ' to attempt an escape — best when the squeeze is loose.';
      } else {
        const moves = MOVES[role][G.pos], subs = SUBS_BY[role][G.pos];
        const parts = [];
        for (const dir in moves) parts.push(kn(dir.toLowerCase() === 'fwd' ? 'fwd' : dir.toLowerCase()) + '+' + kn('grapple') + ' ' + moves[dir].name);
        if (subs.length) parts.push(kn('grapple') + ' ' + (subs.length > 1 ? 'submission' : subs[0]));
        if (role === 'top' || BOTTOM_CAN_STRIKE[G.pos]) parts.push(kn('lh') + '/' + kn('rh') + '/' + kn('ll') + '/' + kn('rl') + ' strike');
        parts.push('hold ' + kn('block') + (role === 'top' ? ' base (deny escapes)' : ' frame (deny passes, cover up)'));
        if (role === 'top') parts.push(kn('dodge') + ' let them up');
        const cd = G.cd[App.myIdx] > 0 ? ' · recovering ' + G.cd[App.myIdx].toFixed(1) + 's' : '';
        $('#gHint').textContent = App.mode === 'watch' ? '' : parts.join(' · ') + cd;
      }
    } else g.classList.remove('show');
  }

  // ============================================================
  //  Options panel (key bindings + strike mapping)
  // ============================================================
  let capture = null; // { act, slot, btn } while waiting for a key
  function buildOptions() {
    const kt = $('#keyTable');
    let h = '<tr><th>Action</th><th>Key</th><th>Alt</th></tr>';
    for (const a of ACTIONS) h += '<tr><td>' + a.label + '</td>' + [0, 1].map(i => '<td><button class="keybtn" data-act="' + a.id + '" data-slot="' + i + '">' + keyName(Controls.binds[a.id][i]) + '</button></td>').join('') + '</tr>';
    kt.innerHTML = h;
    kt.querySelectorAll('.keybtn').forEach(b => b.onclick = () => startCapture(b.dataset.act, +b.dataset.slot, b));
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
  }
  function startCapture(act, slot, btn) {
    cancelCapture();
    capture = { act, slot, btn };
    btn.textContent = 'PRESS A KEY'; btn.classList.add('cap');
  }
  function cancelCapture() {
    if (!capture) return;
    capture.btn.textContent = keyName(Controls.binds[capture.act][capture.slot]); capture.btn.classList.remove('cap');
    capture = null;
  }
  function captureKey(code) {
    const { act, slot } = capture;
    if (code === 'Backspace' || code === 'Delete') { Controls.binds[act][slot] = ''; }
    else {
      for (const a of ACTIONS) for (let i = 0; i < 2; i++) if (Controls.binds[a.id][i] === code) Controls.binds[a.id][i] = ''; // one action per key: unbind it everywhere else first
      Controls.binds[act][slot] = code;
    }
    capture = null;
    saveControls(); buildOptions(); updateHint();
  }
  function openOptions() {
    App.optionsOpen = true; App.held = 0; App.pressed = 0;
    if (App.playing && isLocal()) App.paused = true;
    $('#btnOptQuit').style.display = ($('#menu').classList.contains('hidden') && $('#career').classList.contains('hidden') && $('#careerNew').classList.contains('hidden')) || (App.gym && App.gym.active) ? '' : 'none'; // QUIT shows only in a fight/lobby or the gym, hidden on the menus
    buildOptions(); show($('#options'));
  }
  function closeOptions() {
    cancelCapture();
    App.optionsOpen = false; App.paused = false;
    hide($('#options')); updateHint();
  }
  function resetControls() {
    Controls.binds = defaultBinds(); Controls.moveset = normalizeMoveset(DEFAULT_MOVESET);
    saveControls();
    if (App.setMusicParticles) App.setMusicParticles(true);
    if (App.setImpactParticles) App.setImpactParticles(true);
    if (App.setBackground) App.setBackground('legacy');
    buildOptions(); updateHint(); toast('Options reset to defaults', 1500);
  }
  function updateHint() {
    const B = id => '<b>' + keyName(Controls.binds[id][0]) + '</b>';
    const ms = Controls.moveset;
    const kind = k => KIND_LABEL[k].toLowerCase();
    const row = m => (m === 'none' ? 'no modifier' : 'hold ' + B(m)) + ': ' + LIMBS.map(l => kind(ms[m][l])).join(' / ');
    $('#controlsHint').innerHTML =
      '<div class="ctl-row">' + [B('fwd'), B('left'), B('back'), B('right')].join(' ') + ' move / circle (stepping into a shot adds power, backing off takes it away), tap any direction twice to lunge that way · ' + B('lh') + ' left hand · ' + B('rh') + ' right hand · ' + B('ll') + ' left leg · ' + B('rl') + ' right leg</div>' +
      '<div class="ctl-row">' + MODS.map(row).join(' · ') + '</div>' +
      '<div class="ctl-row">' + B('block') + ' hold: block / sprawl (+ ' + B('mod3') + ' drops into a shell that covers the body), tap twice: push them off · ' + B('grapple') + ' takedown / dive on a downed opponent · ' + B('dodge') + ' slip · ' + B('stance') + ' switch stance · knocked down: a direction or ' + B('dodge') + ' gets up, or stay down to recover · ground: hands & legs strike, ' + B('grapple') + ' submission / sweep, ' + B('block') + ' posture / cover, ' + B('dodge') + ' let up · <b>Enter</b> chat · <b>ESC</b> options · <b>H</b> hide this · <b>M</b> mute</div>';
  }

  // ============================================================
  //  Input
  // ============================================================
  window.addEventListener('keydown', (e) => {
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
      if (e.code === 'Escape' && !e.repeat) { e.preventDefault(); screen('menu'); }
      return;
    }
    if (e.code === 'Escape') { e.preventDefault(); if (!e.repeat) { if (App.optionsOpen) closeOptions(); else openOptions(); } return; }
    if (App.optionsOpen) return;
    if (e.code === 'KeyH' && !Controls.keyMap.KeyH) { if (!e.repeat) { App.hintsHidden = !App.hintsHidden; $('#controlsHint').style.display = App.hintsHidden ? 'none' : ''; } return; }
    if (e.code === 'KeyM' && !Controls.keyMap.KeyM) { if (!e.repeat) { App.audio.setMuted(!App.audio.muted); toast(App.audio.muted ? 'Muted' : 'Sound on', 1200); } return; }
    const b = Controls.keyMap[e.code]; if (!b) return;
    e.preventDefault();
    if (!e.repeat) { App.pressed |= b; }
    App.held |= b;
  });
  window.addEventListener('keyup', (e) => { const b = Controls.keyMap[e.code]; if (b) { App.held &= ~b; e.preventDefault(); } });
  window.addEventListener('blur', () => { App.held = 0; });

  // ============================================================
  //  Main loop
  // ============================================================
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.1) dt = 0.1;
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
  const CareerUI = { C: null, tab: 'camp', pick: { base: 'striker', color: null, skin: null }, justFought: false, lastTrain: null, confirmDel: 0 };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');
  const pct100 = (v) => Math.round(v * 100);
  function careerSave() { if (CareerUI.C) Career.save(CareerUI.C); }
  function careerLoad() { if (!CareerUI.C) CareerUI.C = Career.load(); return CareerUI.C; }
  function refreshMenuCareer() { const b = $('#btnCareer'); if (b) b.textContent = careerLoad() ? 'CONTINUE CAREER' : 'START A CAREER'; }

  // ---- new fighter ----
  function swatches(el, list, sel, onPick) {
    el.innerHTML = list.map((c, i) => '<i data-i="' + i + '" style="background:' + hex(c) + '" class="' + (c === sel ? 'sel' : '') + '"></i>').join('');
    el.querySelectorAll('i').forEach(i => i.onclick = () => onPick(list[+i.dataset.i]));
  }
  function openCareerNew() {
    const P = CareerUI.pick;
    if (P.color == null) P.color = Career.COLORS[0];
    if (P.skin == null) P.skin = Career.SKINS[0];
    const el = $('#careerBases'); el.innerHTML = '';
    for (const key in ROSTER) {
      const r = ROSTER[key], st = Career.startingStats(key);
      const c = document.createElement('div'); c.className = 'card' + (P.base === key ? ' sel' : ''); c.dataset.key = key;
      c.innerHTML = '<div class="swatch" style="background:' + hex(r.color) + '"></div><div class="cname">' + esc(r.style) + '</div><div class="cstyle">starting shape · rating ' + Career.rating(st) + '</div><div class="cdesc">' + esc(r.desc) + '</div>' +
        Career.STATS.map(s => statBar(s.short, st[s.key])).join('');
      c.onclick = () => { P.base = key; el.querySelectorAll('.card').forEach(x => x.classList.toggle('sel', x.dataset.key === key)); };
      el.appendChild(c);
    }
    swatches($('#careerColors'), Career.COLORS, P.color, (c) => { P.color = c; openCareerNew(); });
    swatches($('#careerSkins'), Career.SKINS, P.skin, (c) => { P.skin = c; openCareerNew(); });
    try { if (!$('#careerName').value) $('#careerName').value = localStorage.getItem('cr_name') || ''; } catch (_) {}
    screen('careerNew');
  }
  function startCareer() {
    const name = ($('#careerName').value || '').trim();
    if (!name) { toast('Give your fighter a name.'); $('#careerName').focus(); return; }
    const P = CareerUI.pick;
    CareerUI.C = Career.newCareer({ name, nick: $('#careerNick').value, base: P.base, color: P.color, skin: P.skin });
    careerSave(); CareerUI.justFought = false; CareerUI.lastTrain = null;
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
    App.gym.leave(); hide($('#gymHud'));
    if (App.mode === 'gym') App.mode = null;
    if (!keepScene) menuScene();
  }
  function openStation(tab, id) {
    const C = CareerUI.C; if (!C || !App.gym || !App.gym.active) return;
    // once a fight is booked the computer shows the fight card (and the FIGHT button on fight week)
    if (id === 'computer' && C.booked) { tab = 'camp'; id = 'computerBooked'; }
    CareerUI.tab = tab; CareerUI.station = id || tab;
    App.gym.paused = true; App.held = 0; App.pressed = 0;
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
      h += '<div class="fight-now"><div><div class="t">IT\'S FIGHT NIGHT</div><small>' + (inj > 30 ? 'You are going in hurt (' + Math.round(inj) + ' damage carried) — it shows up on your damage meters from the first bell.' : inj > 0 ? 'A little banged up (' + Math.round(inj) + '), nothing serious.' : 'Healthy and ready.') + ' Quitting mid-fight counts as pulling out: no purse, and the promoter remembers.</small></div><button class="big" id="btnCareerFight">FIGHT</button></div>';
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
      if (Career.accept(C, +b.dataset.offer)) { CareerUI.justFought = false; careerSave(); CareerUI.tab = 'camp'; renderCareer(); }
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
    el.querySelectorAll('button[data-up]').forEach(b => b.onclick = () => { if (Career.buyUpgrade(C, b.dataset.up)) { careerSave(); renderCareer(); } });
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
    if (S && S.result && C.booked) Career.applyResult(C, S);
    else if (C.booked) { Career.withdraw(C); toast('You pulled out of the fight. No purse, popularity -4.', 4000); }
    CareerUI.justFought = true; CareerUI.lastTrain = null; careerSave();
  }
  function leaveCareerFight() { settleCareerFight(); stopFight(); openCareer(); }
  $('#btnCareer').onclick = () => { App.audio.init(); if (careerLoad()) openCareer(); else openCareerNew(); };
  $('#btnCareerNewBack').onclick = () => screen('menu');
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
    Career.erase(); CareerUI.C = null; CareerUI.confirmDel = 0; $('#btnCareerDelete').textContent = 'RETIRE (DELETE SAVE)';
    toast('Career deleted.', 2000); screen('menu');
  };
  document.querySelectorAll('#cTabs .tab').forEach(b => b.onclick = () => { CareerUI.tab = b.dataset.tab; renderCareer(); });

  // ============================================================
  //  Wire up buttons
  // ============================================================
  $('#btnHost').onclick = () => { App.audio.init(); startHost(); };
  $('#btnJoin').onclick = () => { App.audio.init(); $('#joinRow').classList.toggle('hidden'); $('#joinCode').focus(); };
  $('#btnJoinGo').onclick = () => { const c = $('#joinCode').value.trim(); if (c.length < 4) { toast('Enter the 5-letter room code.'); return; } startJoin(c); };
  $('#joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoinGo').click(); });
  $('#btnPractice').onclick = () => { App.audio.init(); enterLobby('practice'); };
  $('#btnWatch').onclick = () => { App.audio.init(); enterLobby('watch'); };
  $('#btnOptions').onclick = () => openOptions();
  if (window.desktop) { // Electron build (desktop/preload.js)
    $('#btnQuit').classList.remove('hidden');
    $('#btnQuit').onclick = () => window.desktop.quit();
  }
  $('#btnLobbyOptions').onclick = () => openOptions();
  $('#btnOptClose').onclick = () => closeOptions();
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
  (function bindBackground() {
    const bg = window.MMAMusicBg;
    const box = $('#bgSwatches');
    const preview = $('#bgPreview');
    const menuBtn = $('#bgColorBtn');
    const menuSub = $('#bgColorSub');
    const menuName = $('#bgColorName');
    const musicBox = $('#bgMusicFx');
    const impactBox = $('#bgImpactFx');
    if (!bg || !box) return;
    box.innerHTML = bg.PRESETS.map(p =>
      '<button type="button" class="bg-swatch" role="radio" data-id="' + p.id + '" style="--swatch:' + p.color + '" aria-checked="false"><i></i>' + p.name + '</button>'
    ).join('');
    const chip = (color, label) => '<span><i style="background:' + bg.cssColor(color) + '"></i>' + label + '</span>';
    let currentId = bg.DEFAULT_PRESET;
    function syncParticleControls() {
      const legacy = currentId === 'legacy';
      if (musicBox) {
        musicBox.disabled = legacy;
        musicBox.checked = legacy ? false : bg.loadParticles();
      }
      if (impactBox) {
        impactBox.disabled = legacy;
        impactBox.checked = legacy ? false : bg.loadImpact();
      }
    }
    function applyBackground(id) {
      const p = bg.PRESETS.find(x => x.id === id) || bg.PRESETS.find(x => x.id === bg.DEFAULT_PRESET) || bg.PRESETS[0];
      currentId = p.id;
      if (App.renderer) App.renderer.setBackdrop(p.id);
      else {
        bg.savePresetId(p.id);
        document.documentElement.style.setProperty('--bg', p.id === 'legacy' ? bg.LEGACY_COLOR : p.color);
      }
      if (preview) {
        if (p.id === 'legacy') preview.innerHTML = '<span>Original arena</span>';
        else {
          const pal = bg.paletteFrom(p.color);
          preview.innerHTML = chip(pal.bg, 'Base') + chip(pal.neon, 'Bass') + chip(pal.gold, 'Mids') + chip(pal.silk, 'Highs');
        }
      }
      if (menuName) menuName.textContent = p.name;
      box.querySelectorAll('.bg-swatch').forEach(btn => {
        const on = btn.dataset.id === p.id;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      syncParticleControls();
    }
    box.querySelectorAll('.bg-swatch').forEach(btn => { btn.onclick = () => applyBackground(btn.dataset.id); });
    if (menuBtn && menuSub) {
      menuBtn.onclick = () => {
        const open = !menuSub.classList.toggle('hidden');
        menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
    }
    function applyMusicParticles(on) {
      if (App.renderer && App.renderer.musicBg) App.renderer.musicBg.setMusicParticles(on);
      else bg.saveParticles(on);
      syncParticleControls();
    }
    function applyImpactParticles(on) {
      if (App.renderer && App.renderer.musicBg) App.renderer.musicBg.setImpactParticles(on);
      else bg.saveImpact(on);
      syncParticleControls();
    }
    if (musicBox) musicBox.addEventListener('change', () => { if (!musicBox.disabled) applyMusicParticles(musicBox.checked); });
    if (impactBox) impactBox.addEventListener('change', () => { if (!impactBox.disabled) applyImpactParticles(impactBox.checked); });
    App.setBackground = applyBackground;
    App.setMusicParticles = applyMusicParticles;
    App.setImpactParticles = applyImpactParticles;
    applyBackground(bg.loadPresetId());
  })();
  updateHint();
  $('#btnBack').onclick = () => { if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('#codeLbl').textContent).then(() => toast('Room code copied', 1500)); };
  $('#btnReady').onclick = () => {
    App.lobby.ready[App.myIdx] = true; App.lobby.names[App.myIdx] = myName();
    readSettings(); refreshLobby(); sendPick(); maybeStart();
  };
  $('#nameInput').addEventListener('change', () => { App.lobby.names[App.myIdx] = myName(); sendPick(); refreshLobby(); });
  for (const id of ['selRounds', 'selLen', 'selGrapple']) $('#' + id).addEventListener('change', () => { readSettings(); sendPick(); refreshLobby(); });
  $('#btnMenu').onclick = () => { if (App.mode === 'career') settleCareerFight(); stopFight(); if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnOptQuit').onclick = () => { closeOptions(); if (App.mode === 'career') { leaveCareerFight(); return; } if (App.mode === 'gym') { careerSave(); screen('menu'); return; } stopFight(); if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnRematch').onclick = () => {
    if (App.mode === 'career') { leaveCareerFight(); return; }
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
  const Extras = { mark: false };
  function loadExtras() {
    try {
      Extras.mark = localStorage.getItem('cr_fx_1') === '1';
    } catch (_) {}
  }
  function saveExtras() {
    try {
      localStorage.setItem('cr_fx_1', Extras.mark ? '1' : '0');
    } catch (_) {}
  }
  function syncExtras() {
    const mark = $('#optMark');
    if (mark) mark.checked = Extras.mark;
    if (App.renderer) App.renderer.setMarks(Extras.mark);
    updateHint();
  }
  function lineName(i) {
    const f = App.state && App.state.f && App.state.f[i];
    if (f && f.name) return f.name;
    if (i === App.myIdx) return myName() || 'You';
    return 'Opponent';
  }
  function showLine(i, text) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text || !App.talk) return;
    const slot = App.state && App.state.f && App.state.f[i] ? i : null;
    App.talk.add(lineName(i), text, slot);
  }
  function postLine(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
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
  syncExtras();
  App.talk = new CageTalk.Talk();
  App.talk.mount();
  App.talk.onLine = postLine;

  window.CageRules = App; // dev hook: window.CageRules.sim / .state / .renderer
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
