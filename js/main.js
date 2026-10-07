/* ============================================================
   Cage Rules — app glue: menus, lobby, input, game loop, HUD, netcode
   ============================================================ */
(function () {
  'use strict';
  const { IN, Sim, ROSTER, describe, LIMBS, LIMB_NAME, MODS, HAND_KINDS, LEG_KINDS, KIND_LABEL, DEFAULT_MOVESET, normalizeMoveset, POS_NAME, MOVES, SUBS_BY, BOTTOM_CAN_STRIKE, KD } = window.MMASim;
  const { CpuBrain } = window.MMAAI;
  const NeuralBrain = window.MMABrain && window.MMABrain.NeuralBrain;
  const { Renderer } = window.MMARender;
  const { Net } = window.MMANet;
  const { Audio } = window.MMAAudio;

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
    { id: 'block', label: 'Block / sprawl / cover (hold) · push (tap twice)', bit: IN.BLOCK, def: ['KeyL', 'Semicolon'] },
    { id: 'grapple', label: 'Takedown / submission / sweep', bit: IN.GRAPPLE, def: ['Space', ''] },
    { id: 'dodge', label: 'Slip / stand up', bit: IN.DODGE, def: ['ShiftLeft', 'ShiftRight'] }
  ];
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
    lobby: { picks: ['striker', 'wrestler'], names: ['', ''], ready: [false, false], settings: { rounds: 3, len: 180, diff: 0.6 }, cpuPick: 'random', movesets: [null, null], brains: ['cpu', 'cpu'] },
    optionsOpen: false, paused: false,
    state: null, playing: false, lastSnap: 0, lastInputSend: 0, evQueue: [], rematch: [false, false],
    feedLines: [], hintsHidden: false
  };

  // practice (you vs a brain) and watch (brain vs brain) both run the sim locally with no network
  const isLocal = () => App.mode === 'practice' || App.mode === 'watch';

  // ============================================================
  //  Brains: the scripted CPU (js/ai.js) or an evolved neural brain (js/brain.js) from brains/index.json
  // ============================================================
  const Brains = { index: null, genomes: {}, loading: null };
  function loadBrainIndex() {
    if (Brains.loading) return Brains.loading;
    Brains.loading = fetch('brains/index.json', { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : { brains: [] }).catch(() => ({ brains: [] }))
      .then(ix => { Brains.index = (ix && ix.brains || []).slice().sort((a, b) => a.gen - b.gen); if (isLocal()) refreshLobby(); return Brains.index; });
    return Brains.loading;
  }
  const brainEntry = (id) => (Brains.index || []).find(b => b.file === id);
  function brainLabel(id) {
    if (id === 'cpu') return 'Scripted CPU';
    const e = brainEntry(id); return e ? e.name + ' \u00b7 ' + Math.round(e.winRate * 100) + '% vs CPU' : id;
  }
  function brainShort(id) { if (id === 'cpu') return 'CPU'; const e = brainEntry(id); return e ? e.name.toUpperCase() : 'AI'; }
  function ensureGenome(id) {
    if (id === 'cpu' || !NeuralBrain) return Promise.resolve(null);
    if (Brains.genomes[id]) return Promise.resolve(Brains.genomes[id]);
    return fetch('brains/' + id, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(g => (Brains.genomes[id] = g))
      .catch(e => { toast('Could not load ' + brainLabel(id) + ' — using the scripted CPU.', 5000); console.error(e); return null; });
  }
  function makeBrain(idx, id, diff) {
    if (id !== 'cpu' && NeuralBrain && Brains.genomes[id]) return new NeuralBrain(idx, Brains.genomes[id]);
    return new CpuBrain(idx, diff);
  }
  function brainSelect(id, sel) {
    const list = Brains.index || [];
    let h = '<select id="' + id + '"><option value="cpu"' + (sel === 'cpu' ? ' selected' : '') + '>Scripted CPU</option>';
    for (const b of list) h += '<option value="' + b.file + '"' + (sel === b.file ? ' selected' : '') + '>' + brainLabel(b.file) + '</option>';
    if (!list.length) h += '<option disabled>' + (Brains.index ? 'no evolved brains yet (run the training action)' : 'loading evolved brains\u2026') + '</option>';
    return h + '</select>';
  }
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
    for (const id of ['menu', 'lobby', 'end']) { const el = $('#' + id); if (id === name) show(el); else hide(el); }
    if (App.optionsOpen) closeOptions();
    if (name) hide($('#hud')); else show($('#hud'));
    App.audio.play(name === 'menu' || name === 'lobby' ? 'menu' : 'fight');
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
    else if (App.mode === 'watch') { st.textContent = 'Pick the red corner\'s fighter above, choose a brain for each corner, then hit READY to watch.' + rules; }
    else if (App.mode === 'host') {
      st.textContent = (App.net && App.net.connected ? (L.ready[opp] ? 'Opponent is READY.' : 'Opponent connected — picking a fighter...') : 'Share the room code. Waiting for an opponent to join...') + rules;
    } else {
      st.textContent = (L.ready[opp] ? 'Host is READY.' : 'Connected. Host is picking a fighter...') + rules;
    }
    const op = $('#oppPick');
    if (isLocal()) {
      const bp = (i) => { const el = $('#brainPick' + i); if (el) el.onchange = (e) => { L.brains[i] = e.target.value; ensureGenome(e.target.value); refreshLobby(); }; };
      if (App.mode === 'practice') {
        op.innerHTML = '<div class="pick-row">CPU opponent: ' + fighterSelect('cpuPick', L.cpuPick, true) + ' brain: ' + brainSelect('brainPick1', L.brains[1]) + '</div>' +
          '<div class="pick-note">' + (L.brains[1] === 'cpu' ? 'The scripted CPU plays at the CPU level set above.' : 'An evolved brain plays the way self-play taught it; the CPU level does not apply.') + '</div>';
      } else {
        op.innerHTML = '<div class="pick-row"><span class="corner red">RED</span> ' + ROSTER[L.picks[0]].name + ' brain: ' + brainSelect('brainPick0', L.brains[0]) + '</div>' +
          '<div class="pick-row"><span class="corner blue">BLUE</span> ' + fighterSelect('cpuPick', L.cpuPick, true) + ' brain: ' + brainSelect('brainPick1', L.brains[1]) + '</div>' +
          '<div class="pick-note">Scripted CPU plays at the CPU level above. Evolved brains are checkpoints from self-play training (win rate is against the scripted CPU).</div>';
        bp(0);
      }
      $('#cpuPick').onchange = (e) => { App.lobby.cpuPick = e.target.value; };
      bp(1);
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
    if (isLocal()) loadBrainIndex();
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
    const tag = (i) => ' (' + (L.brains[i] === 'cpu' ? 'CPU' : brainEntry(L.brains[i]) ? brainEntry(L.brains[i]).name : 'AI') + ')';
    const players = [
      { fighter: L.picks[0], name: App.mode === 'watch' ? ROSTER[L.picks[0]].name + tag(0) : (L.names[0] || myName() || ROSTER[L.picks[0]].name), moveset: App.mode === 'watch' ? DEFAULT_MOVESET : Controls.moveset },
      { fighter: p1, name: isLocal() ? ROSTER[p1].name + tag(1) : (L.names[1] || ROSTER[p1].name), moveset: isLocal() ? DEFAULT_MOVESET : (L.movesets[1] || DEFAULT_MOVESET) }
    ];
    // same archetype -> alternate shorts colour so they're distinguishable
    if (players[0].fighter === players[1].fighter) players[1].color = 0x8e44ad;
    const msg = { t: 'start', seed: (Math.random() * 1e9) | 0, players, settings: { rounds: L.settings.rounds, len: L.settings.len, grappling: L.settings.grappling !== false } };
    if (App.mode === 'host') App.net.send(msg);
    if (isLocal()) { Promise.all([ensureGenome(L.brains[0]), ensureGenome(L.brains[1])]).then(() => beginFight(msg)); return; }
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
    if (App.sim) App.sim.destroy();
    App.sim = null; App.state = null; App.evQueue = []; App.remote = { h: 0, p: 0 }; App.rematch = [false, false];
    App.lobby.ready = [false, false];
    if (isHost) {
      App.sim = new Sim({ seed: msg.seed, rounds: msg.settings.rounds, roundLen: msg.settings.len, players: msg.players, grappling: msg.settings.grappling !== false });
      App.state = App.sim.state;
      const diff = App.lobby.settings.diff;
      App.brain = isLocal() ? makeBrain(1, App.lobby.brains[1], diff) : null;
      // watch mode: a brain drives the red corner too. ?auto=1 : let the CPU drive your fighter in practice (handy for tuning)
      App.autoPilot = App.mode === 'watch' ? makeBrain(0, App.lobby.brains[0], diff)
        : App.mode === 'practice' && /[?&]auto=1/.test(location.search) ? new CpuBrain(0, diff) : null;
      if (!App.sim.phys) toast('Physics engine unavailable — running the classic striking model.', 5000);
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
    $('#fp0 .tag').textContent = App.mode === 'watch' ? brainShort(App.lobby.brains[0]) : App.myIdx === 0 ? 'YOU' : 'P1';
    $('#fp1 .tag').textContent = App.myIdx === 1 ? 'YOU' : (isLocal() ? brainShort(App.lobby.brains[1]) : 'P2');
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
    const t = S.f.map(f => { const o = Object.assign({}, f.ts); for (const k in f.rs) o[k] += f.rs[k]; return o; });
    // (if the fight ended by stoppage, the last round stats were folded into ts already; avoid double count)
    const ts = S.f.map(f => f.ts);
    const row = (lbl, fn) => '<tr><td>' + lbl + '</td><td>' + fn(ts[0]) + '</td><td>' + fn(ts[1]) + '</td></tr>';
    $('#totals').innerHTML = '<tr><th></th><th>' + S.f[0].name + '</th><th>' + S.f[1].name + '</th></tr>' +
      row('Strikes landed / thrown', s => s.landed + ' / ' + s.thrown) + row('Damage dealt', s => Math.round(s.sig)) +
      row('Takedowns', s => s.td + ' / ' + s.tdAtt) + row('Control time', s => Math.round(s.ctrl) + 's') + row('Submission attempts', s => s.subs) + row('Knockdowns', s => s.kd);
    $('#btnRematch').textContent = 'REMATCH'; $('#btnRematch').disabled = false;
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
        case 'block': A.block(); if (Math.random() < 0.35) feed(text); break;
        case 'push': if (ev.ok) { A.block(); feed(text); } else A.whiff(); break;
        case 'miss': A.whiff(); if (ev.slipped) feed(text); break;
        case 'kd': A.slam(); centerMsg('KNOCKDOWN!', 1400); feed(text, true); break;
        case 'follow': A.slam(); feed(text, true); break;
        case 'getup': feed(text); break;
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
          const res = ev.res;
          const w = res.winner == null ? 'DRAW' : S.f[res.winner].name.toUpperCase() + ' WINS';
          centerMsg(w + '<small>' + res.method + '</small>');
          if (res.method.indexOf('Decision') >= 0 || res.method.indexOf('Draw') >= 0) A.bell(3);
          setTimeout(() => { if (App.state && App.state.result) showEnd(App.state); }, 3800);
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
    $('#roundLbl').textContent = App.paused ? 'PAUSED' : S.phase === 'break' ? 'BREAK ' + Math.ceil(10 - S.phaseT) : 'ROUND ' + S.round + '/' + S.rounds;
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
      for (const a of ACTIONS) for (let i = 0; i < 2; i++) if (Controls.binds[a.id][i] === code) Controls.binds[a.id][i] = ''; // a key can only do one thing
      Controls.binds[act][slot] = code;
    }
    capture = null;
    saveControls(); buildOptions(); updateHint();
  }
  function openOptions() {
    App.optionsOpen = true; App.held = 0; App.pressed = 0;
    if (App.playing && isLocal()) App.paused = true;
    $('#btnOptQuit').style.display = $('#menu').classList.contains('hidden') ? '' : 'none'; // nothing to quit from on the main menu
    buildOptions(); show($('#options'));
  }
  function closeOptions() {
    cancelCapture();
    App.optionsOpen = false; App.paused = false;
    hide($('#options')); updateHint();
  }
  function resetControls() {
    Controls.binds = defaultBinds(); Controls.moveset = normalizeMoveset(DEFAULT_MOVESET);
    saveControls(); buildOptions(); updateHint(); toast('Controls reset to defaults', 1500);
  }
  function updateHint() {
    const B = id => '<b>' + keyName(Controls.binds[id][0]) + '</b>';
    const ms = Controls.moveset;
    const kind = k => KIND_LABEL[k].toLowerCase();
    const row = m => (m === 'none' ? 'no modifier' : 'hold ' + B(m)) + ': ' + LIMBS.map(l => kind(ms[m][l])).join(' / ');
    $('#controlsHint').innerHTML =
      '<div class="ctl-row">' + [B('fwd'), B('left'), B('back'), B('right')].join(' ') + ' move / circle (stepping into a shot adds power, backing off takes it away) · ' + B('lh') + ' left hand · ' + B('rh') + ' right hand · ' + B('ll') + ' left leg · ' + B('rl') + ' right leg</div>' +
      '<div class="ctl-row">' + MODS.map(row).join(' · ') + '</div>' +
      '<div class="ctl-row">' + B('block') + ' hold: block / sprawl (+ ' + B('mod3') + ' drops into a shell that covers the body), tap twice: push them off · ' + B('grapple') + ' takedown / dive on a downed opponent · ' + B('dodge') + ' slip · knocked down: a direction or ' + B('dodge') + ' gets up, or stay down to recover · ground: hands & legs strike, ' + B('grapple') + ' submission / sweep, ' + B('block') + ' posture / cover, ' + B('dodge') + ' let up · <b>ESC</b> options · <b>H</b> hide this · <b>M</b> mute</div>';
  }

  // ============================================================
  //  Input
  // ============================================================
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) { if (e.code === 'Escape') e.target.blur(); return; }
    if (capture) {
      e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'Escape') cancelCapture(); else captureKey(e.code);
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
    if (!App.playing || !App.state) { if (App.renderer && App.state) App.renderer.update(App.state, dt, null); return; }

    const isHost = App.mode !== 'guest';
    let inputs = [0, 0];
    if (App.paused && isLocal()) { App.pressed = 0; App.renderer.update(App.state, 0, inputs); updateHUD(App.state, inputs); return; }
    if (isHost) {
      const sim = App.sim;
      if (App.autoPilot) { const o = App.autoPilot.update(sim.state, dt); const watch = App.mode === 'watch'; sim.setInput(0, watch ? o.held : (o.held | App.held), watch ? o.pressed : (o.pressed | App.pressed)); App.pressed = 0; if (watch) inputs[0] = o.held; }
      else { sim.setInput(0, App.held, App.pressed); App.pressed = 0; }
      if (App.brain) { const o = App.brain.update(sim.state, dt); sim.setInput(1, o.held, o.pressed); inputs[1] = o.held; }
      else { sim.setInput(1, App.remote.h, App.remote.p); App.remote.p = 0; inputs[1] = App.remote.h; }
      if (App.mode !== 'watch') inputs[0] = App.held;
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
        App.net.send({ t: 'in', h: App.held, p: App.pressed }); App.pressed = 0;
      }
      inputs[1] = App.held;
      const S = App.state;
      if (S.phase === 'fight') {
        S.clock = Math.max(0, S.clock - dt);
        for (const f of S.f) if (f.act && f.act.type !== 'idle' && f.act.type !== 'move') f.act.t += dt;
      }
    }
    App.renderer.update(App.state, dt, inputs);
    updateHUD(App.state, inputs);
  }
  requestAnimationFrame(loop);

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
  updateHint();
  $('#btnBack').onclick = () => { if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('#codeLbl').textContent).then(() => toast('Room code copied', 1500)); };
  $('#btnReady').onclick = () => {
    App.lobby.ready[App.myIdx] = true; App.lobby.names[App.myIdx] = myName();
    readSettings(); refreshLobby(); sendPick(); maybeStart();
  };
  $('#nameInput').addEventListener('change', () => { App.lobby.names[App.myIdx] = myName(); sendPick(); refreshLobby(); });
  for (const id of ['selRounds', 'selLen', 'selGrapple']) $('#' + id).addEventListener('change', () => { readSettings(); sendPick(); refreshLobby(); });
  $('#btnMenu').onclick = () => { stopFight(); if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnOptQuit').onclick = () => { closeOptions(); stopFight(); if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnRematch').onclick = () => {
    if (App.mode === 'guest') { App.net.send({ t: 'rematch' }); $('#btnRematch').textContent = 'WAITING FOR HOST…'; $('#btnRematch').disabled = true; return; }
    App.rematch[0] = true;
    if (App.mode === 'host' && !App.rematch[1]) { $('#btnRematch').textContent = 'WAITING FOR OPPONENT…'; $('#btnRematch').disabled = true; }
    maybeRematch();
  };
  try { $('#nameInput').value = localStorage.getItem('cr_name') || ''; } catch (_) {}
  $('#nameInput').addEventListener('input', () => { try { localStorage.setItem('cr_name', $('#nameInput').value); } catch (_) {} });

  window.addEventListener('mmaphys', (e) => { if (!e.detail.ok) { App.physFailed = true; toast('Physics engine failed to load: ' + (e.detail.error && e.detail.error.message), 8000); } });

  window.CageRules = App; // dev hook: window.CageRules.sim / .state / .renderer
  // dev hook: advance a practice fight by n sim ticks regardless of frame rate (used by tools/browser-test.js)
  App.tick = (n) => {
    const sim = App.sim; if (!sim) return;
    for (let k = 0; k < n; k++) {
      if (App.autoPilot) { const o = App.autoPilot.update(sim.state, 1 / 60); sim.setInput(0, o.held, o.pressed); } else sim.setInput(0, App.held, App.pressed);
      if (App.brain) { const o = App.brain.update(sim.state, 1 / 60); sim.setInput(1, o.held, o.pressed); }
      sim.acc = 0; sim.step(1 / 60);
      const evs = sim.drainEvents(); if (evs.length) processEvents(evs, sim.state);
    }
  };

  // Build the arena right away so the menu has a live 3D background
  window.addEventListener('load', () => {
    try {
      const R = ensureRenderer();
      const demo = new Sim({ seed: 1, players: [{ fighter: 'striker' }, { fighter: 'wrestler' }], physics: false });
      App.state = demo.state; R.setFighters(demo.state);
    } catch (e) { console.error(e); toast('WebGL failed to start: ' + e.message, 8000); }
  });
  // Browsers block audio until a gesture, and a rejected play() must be retried on the next one.
  function unlockMusic() {
    const onMenu = !$('#menu').classList.contains('hidden') || !$('#lobby').classList.contains('hidden');
    App.audio.play(onMenu ? 'menu' : 'fight');
  }
  window.addEventListener('pointerdown', unlockMusic);
  window.addEventListener('keydown', unlockMusic);
})();
