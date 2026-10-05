/* ============================================================
   Cage Rules — app glue: menus, lobby, input, game loop, HUD, netcode
   ============================================================ */
(function () {
  'use strict';
  const { IN, Sim, ROSTER, describe } = window.MMASim;
  const { CpuBrain } = window.MMAAI;
  const { Renderer } = window.MMARender;
  const { Net } = window.MMANet;
  const { Audio } = window.MMAAudio;

  const $ = (s) => document.querySelector(s);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  // ---------- key map ----------
  const KEYS = {
    KeyW: IN.FWD, ArrowUp: IN.FWD, KeyS: IN.BACK, ArrowDown: IN.BACK, KeyA: IN.LEFT, ArrowLeft: IN.LEFT, KeyD: IN.RIGHT, ArrowRight: IN.RIGHT,
    KeyJ: IN.JAB, KeyK: IN.CROSS, KeyU: IN.HOOK, KeyI: IN.HKICK, KeyO: IN.BKICK, KeyP: IN.LKICK,
    KeyL: IN.BLOCK, Semicolon: IN.BLOCK, Space: IN.GRAPPLE, ShiftLeft: IN.DODGE, ShiftRight: IN.DODGE
  };

  const App = {
    mode: null, net: null, sim: null, renderer: null, audio: new Audio(), brain: null,
    myIdx: 0, held: 0, pressed: 0, remote: { h: 0, p: 0 },
    lobby: { picks: ['striker', 'wrestler'], names: ['', ''], ready: [false, false], settings: { rounds: 3, len: 180, diff: 0.6 }, cpuPick: 'random' },
    state: null, playing: false, lastSnap: 0, lastInputSend: 0, evQueue: [], rematch: [false, false],
    feedLines: [], hintsHidden: false
  };

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
    if (name) hide($('#hud')); else show($('#hud'));
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
      c.classList.toggle('opp', App.mode !== 'practice' && c.dataset.key === L.picks[opp]);
    });
    const isHost = App.mode !== 'guest';
    $('#settingsBox').style.display = isHost ? '' : 'none';
    $('#diffWrap').style.display = App.mode === 'practice' ? '' : 'none';
    $('#codeBox').classList.toggle('hidden', App.mode !== 'host');
    const st = $('#lobbyStatus');
    if (App.mode === 'practice') { st.textContent = 'Pick your fighter, then hit READY.'; }
    else if (App.mode === 'host') {
      st.textContent = App.net && App.net.connected ? (L.ready[opp] ? 'Opponent is READY.' : 'Opponent connected — picking a fighter...') : 'Share the room code. Waiting for an opponent to join...';
    } else {
      st.textContent = L.ready[opp] ? 'Host is READY.' : 'Connected. Host is picking a fighter...';
    }
    const op = $('#oppPick');
    if (App.mode === 'practice') {
      if (!op.querySelector('select')) {
        op.innerHTML = 'CPU opponent: <select id="cpuPick"><option value="random">Random</option>' + Object.keys(ROSTER).map(k => '<option value="' + k + '">' + ROSTER[k].name + ' (' + ROSTER[k].style + ')</option>').join('') + '</select>';
        $('#cpuPick').onchange = (e) => { App.lobby.cpuPick = e.target.value; };
      }
    } else {
      const on = L.names[opp] || (opp === 0 ? 'Host' : 'Guest');
      op.textContent = App.net && App.net.connected ? on + ' picked ' + ROSTER[L.picks[opp]].name + (L.ready[opp] ? ' ✓' : '') : '';
    }
    const rb = $('#btnReady');
    rb.textContent = L.ready[me] ? 'WAITING...' : 'READY';
    rb.disabled = L.ready[me] || (App.mode !== 'practice' && !(App.net && App.net.connected));
    $('#lobbyTitle').textContent = App.mode === 'practice' ? 'PRACTICE' : App.mode === 'host' ? 'HOST — FIGHTER SELECT' : 'GUEST — FIGHTER SELECT';
  }

  // ============================================================
  //  Lobby / netcode
  // ============================================================
  function readSettings() {
    App.lobby.settings.rounds = parseInt($('#selRounds').value, 10);
    App.lobby.settings.len = parseInt($('#selLen').value, 10);
    App.lobby.settings.diff = parseFloat($('#selDiff').value);
  }
  function myName() { return ($('#nameInput').value || '').trim().slice(0, 14); }

  function sendPick() {
    if (App.mode === 'host') App.net.send({ t: 'lobby', picks: App.lobby.picks, names: App.lobby.names, ready: App.lobby.ready, settings: App.lobby.settings });
    else if (App.mode === 'guest') App.net.send({ t: 'pick', fighter: App.lobby.picks[1], name: myName(), ready: App.lobby.ready[1] });
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
        App.lobby.settings = d.settings; refreshLobby(); break;
      case 'start':
        beginFight(d); break;
      case 's':
        App.state = d.s; App.lastSnap = performance.now();
        if (d.ev && d.ev.length) processEvents(d.ev, App.state);
        break;
    }
  }

  function maybeStart() {
    if (App.mode === 'practice') { if (App.lobby.ready[0]) launchHostFight(); return; }
    if (App.mode === 'host' && App.lobby.ready[0] && App.lobby.ready[1]) launchHostFight();
  }
  function maybeRematch() {
    if (App.mode === 'practice' && App.rematch[0]) launchHostFight();
    if (App.mode === 'host' && App.rematch[0] && App.rematch[1]) launchHostFight();
  }

  function launchHostFight() {
    readSettings();
    const L = App.lobby;
    let p1 = L.picks[1];
    if (App.mode === 'practice') { p1 = L.cpuPick === 'random' ? Object.keys(ROSTER)[Math.floor(Math.random() * 4)] : L.cpuPick; }
    const players = [
      { fighter: L.picks[0], name: L.names[0] || myName() || ROSTER[L.picks[0]].name },
      { fighter: p1, name: App.mode === 'practice' ? ROSTER[p1].name + ' (CPU)' : (L.names[1] || ROSTER[p1].name) }
    ];
    // same archetype -> alternate shorts colour so they're distinguishable
    if (players[0].fighter === players[1].fighter) players[1].color = 0x8e44ad;
    const msg = { t: 'start', seed: (Math.random() * 1e9) | 0, players, settings: { rounds: L.settings.rounds, len: L.settings.len } };
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
    App.sim = null; App.state = null; App.evQueue = []; App.remote = { h: 0, p: 0 }; App.rematch = [false, false];
    App.lobby.ready = [false, false];
    if (isHost) {
      App.sim = new Sim({ seed: msg.seed, rounds: msg.settings.rounds, roundLen: msg.settings.len, players: msg.players });
      App.state = App.sim.state;
      App.brain = App.mode === 'practice' ? new CpuBrain(1, App.lobby.settings.diff) : null;
    } else {
      // placeholder state until the first snapshot arrives
      const tmp = new Sim({ seed: msg.seed, rounds: msg.settings.rounds, roundLen: msg.settings.len, players: msg.players });
      App.state = tmp.state;
    }
    const R = ensureRenderer();
    R.setFighters(App.state);
    R.posLerp = isHost ? 18 : 10;
    App.feedLines = []; $('#feed').innerHTML = '';
    $('#fp0 .nm').textContent = App.state.f[0].name; $('#fp1 .nm').textContent = App.state.f[1].name;
    $('#fp0 .tag').textContent = App.myIdx === 0 ? 'YOU' : (App.mode === 'practice' ? 'P1' : 'P1');
    $('#fp1 .tag').textContent = App.myIdx === 1 ? 'YOU' : (App.mode === 'practice' ? 'CPU' : 'P2');
    screen(null);
    App.playing = true;
    App.audio.setCrowd(0.06);
    centerMsg('ROUND 1<small>' + App.state.f[0].name + ' vs ' + App.state.f[1].name + '</small>', 2600);
  }

  function stopFight() { App.playing = false; App.sim = null; hideCenter(); $('#grapple').classList.remove('show'); }

  function showEnd(S) {
    const R = S.result; if (!R) return;
    const w = R.winner == null ? null : S.f[R.winner];
    $('#endMethod').textContent = R.method.toUpperCase() + (R.method.indexOf('Decision') < 0 && R.method !== 'Majority Draw' ? ' · ROUND ' + R.round + ' · ' + R.time : '');
    $('#endWinner').textContent = w ? w.name + ' WINS' : 'DRAW';
    $('#endWinner').style.color = w ? (R.winner === App.myIdx ? '#52d273' : '#e23b3b') : '#fff';
    $('#endDetail').textContent = w ? (R.winner === App.myIdx ? 'Victory.' : 'Defeat.') : 'The judges could not separate them.';
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
        case 'miss': A.whiff(); if (ev.slipped) feed(text); break;
        case 'kd': A.slam(); centerMsg('KNOCKDOWN!', 1400); feed(text, true); break;
        case 'td': A.slam(); feed(text, true); break;
        case 'sweep': A.slam(); feed(text, true); break;
        case 'tdfail': case 'sweepfail': case 'shoot': case 'standup': case 'subfail': feed(text); break;
        case 'sub': A.roar(0.2); feed(text, true); break;
        case 'seq': {
          const mine = ev.i === App.myIdx;
          const row = $(mine ? '#seqMe' : '#seqThem');
          row.classList.remove('flash-ok', 'flash-bad'); void row.offsetWidth; row.classList.add(ev.ok ? 'flash-ok' : 'flash-bad');
          if (mine) { if (ev.ok) A.block(); else A.whistle(); }
          break;
        }
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
  function dmgColor(d) { const h = 120 - d * 1.2; return 'hsla(' + h + ',70%,' + (25 + d * 0.3) + '%,' + (0.35 + d / 150) + ')'; }
  function updateHUD(S) {
    for (let i = 0; i < 2; i++) {
      const f = S.f[i], p = $('#fp' + i);
      const hp = 100 - f.dmg.head;
      const fill = p.querySelector('.hp .fill'); fill.style.width = pct(hp); fill.className = 'fill' + (hp < 25 ? ' crit' : hp < 50 ? ' low' : '');
      p.querySelector('.hp .ghost').style.width = pct(hp);
      p.querySelector('.st .fill').style.width = pct(f.stam);
      const dm = p.querySelectorAll('.d');
      for (const el of dm) { const k = el.classList.contains('head') ? 'head' : el.classList.contains('body') ? 'body' : 'legs'; el.style.background = dmgColor(f.dmg[k]); el.style.color = f.dmg[k] > 40 ? '#fff' : ''; }
      const st = p.querySelector('.status');
      let txt = '', cls = 'status';
      if (f.act.type === 'down') txt = 'OUT';
      else if (f.rocked > 0) { txt = 'ROCKED'; cls += ' rocked'; }
      else if (f.ground === 'top') txt = 'TOP';
      else if (f.ground === 'bottom') txt = 'BOTTOM';
      else if (f.blocking) txt = 'BLOCK';
      else if (f.stam < 22) txt = 'GASSED';
      st.textContent = txt; st.className = cls;
    }
    $('#roundLbl').textContent = S.phase === 'break' ? 'BREAK ' + Math.ceil(10 - S.phaseT) : 'ROUND ' + S.round + '/' + S.rounds;
    const c = Math.max(0, S.clock); $('#clock').textContent = Math.floor(c / 60) + ':' + String(Math.floor(c % 60)).padStart(2, '0');
    $('#pingLbl').textContent = App.net && App.net.connected ? App.net.ping + ' ms' : (App.mode === 'practice' ? 'CPU' : '');
    // grapple panel
    const g = $('#grapple');
    if (S.ground && S.phase === 'fight') {
      g.classList.add('show'); g.classList.toggle('subbing', !!S.ground.sub);
      g.querySelector('.esc .fill').style.width = pct(S.ground.escape);
      const meTop = S.ground.top === App.myIdx;
      if (S.ground.sub) {
        const sub = S.ground.sub;
        g.querySelector('.sub .fill').style.width = pct(sub.prog); $('#subName').textContent = sub.name.toUpperCase();
        renderSeq($('#seqMe'), meTop ? sub.att : sub.def);
        renderSeq($('#seqThem'), meTop ? sub.def : sub.att);
      }
      $('#gTitle').textContent = (S.f[S.ground.top].name + ' ON TOP').toUpperCase();
      $('#gHint').textContent = S.ground.sub ? (meTop ? 'Enter the W/A/S/D sequence to tighten the hold — 3 misses and you lose it.' : 'Enter the W/A/S/D sequence to escape — 3 misses and you tap!')
        : meTop ? 'J/K/U strike · O body · SPACE submission · hold L to posture · SHIFT stand up' : 'MASH W/A/S/D to escape · hold L to cover · SPACE to sweep when they swing';
    } else g.classList.remove('show');
  }

  const ARROWS = { 1: '▲', 4: '◀', 2: '▼', 8: '▶' };
  function renderSeq(row, sq) {
    const keysEl = row.querySelector('.seq-keys');
    const sig = sq.keys.join(',') + '|' + sq.idx + '|' + sq.fails;
    if (row.dataset.sig !== sig) {
      row.dataset.sig = sig;
      keysEl.innerHTML = sq.keys.map((k, i) => '<span class="' + (i < sq.idx ? 'done' : i === sq.idx ? 'cur' : '') + '">' + ARROWS[k] + '</span>').join('');
      row.querySelector('.seq-fails').innerHTML = [0, 1, 2].map(i => '<i class="' + (i < sq.fails ? 'x' : '') + '">✕</i>').join('');
    }
    row.querySelector('.seq-timer i').style.width = pct(sq.limit ? sq.timer / sq.limit * 100 : 0);
  }

  // ============================================================
  //  Input
  // ============================================================
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.code === 'KeyH') { if (!e.repeat) { App.hintsHidden = !App.hintsHidden; $('#controlsHint').style.display = App.hintsHidden ? 'none' : ''; } return; }
    if (e.code === 'KeyM') { if (!e.repeat) { App.audio.setMuted(!App.audio.muted); toast(App.audio.muted ? 'Muted' : 'Sound on', 1200); } return; }
    const b = KEYS[e.code]; if (!b) return;
    e.preventDefault();
    if (!e.repeat) { App.pressed |= b; }
    App.held |= b;
  });
  window.addEventListener('keyup', (e) => { const b = KEYS[e.code]; if (b) { App.held &= ~b; e.preventDefault(); } });
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
    if (isHost) {
      const sim = App.sim;
      sim.setInput(0, App.held, App.pressed); App.pressed = 0;
      if (App.brain) { const o = App.brain.update(sim.state, dt); sim.setInput(1, o.held, o.pressed); inputs[1] = o.held; }
      else { sim.setInput(1, App.remote.h, App.remote.p); App.remote.p = 0; inputs[1] = App.remote.h; }
      inputs[0] = App.held;
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
    updateHUD(App.state);
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
  $('#btnBack').onclick = () => { if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('#codeLbl').textContent).then(() => toast('Room code copied', 1500)); };
  $('#btnReady').onclick = () => {
    App.lobby.ready[App.myIdx] = true; App.lobby.names[App.myIdx] = myName();
    readSettings(); refreshLobby(); sendPick(); maybeStart();
  };
  $('#nameInput').addEventListener('change', () => { App.lobby.names[App.myIdx] = myName(); sendPick(); refreshLobby(); });
  for (const id of ['selRounds', 'selLen']) $('#' + id).addEventListener('change', () => { readSettings(); sendPick(); });
  $('#btnMenu').onclick = () => { stopFight(); if (App.net) { App.net.destroy(); App.net = null; } App.mode = null; screen('menu'); };
  $('#btnRematch').onclick = () => {
    if (App.mode === 'guest') { App.net.send({ t: 'rematch' }); $('#btnRematch').textContent = 'WAITING FOR HOST…'; $('#btnRematch').disabled = true; return; }
    App.rematch[0] = true;
    if (App.mode === 'host' && !App.rematch[1]) { $('#btnRematch').textContent = 'WAITING FOR OPPONENT…'; $('#btnRematch').disabled = true; }
    maybeRematch();
  };
  try { $('#nameInput').value = localStorage.getItem('cr_name') || ''; } catch (_) {}
  $('#nameInput').addEventListener('input', () => { try { localStorage.setItem('cr_name', $('#nameInput').value); } catch (_) {} });

  // Build the arena right away so the menu has a live 3D background
  window.addEventListener('load', () => {
    try {
      const R = ensureRenderer();
      const demo = new Sim({ seed: 1, players: [{ fighter: 'striker' }, { fighter: 'wrestler' }] });
      App.state = demo.state; R.setFighters(demo.state);
    } catch (e) { console.error(e); toast('WebGL failed to start: ' + e.message, 8000); }
  });
})();
