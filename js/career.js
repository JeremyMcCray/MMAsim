/* ============================================================
   Cage Rules — single-player career (campaign)
   Pure model, no DOM: fighter creation, fight offers from local orgs up to the
   big league, weekly fight camps, an upgradeable gym, popularity, purses,
   injuries and the save file. js/main.js draws the screens.
   ============================================================ */
(function (root) {
  'use strict';
  const SimAPI = root.MMASim || (typeof require !== 'undefined' ? require('./sim.js') : null);
  const ROSTER = SimAPI.ROSTER;

  const SAVE_KEY = 'cr_career';
  const SAVE_VERSION = 1;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- the six trainable stats ----------
  // key = the sim's stat key; label / short / desc are player-facing
  const STATS = [
    { key: 'car', label: 'Stamina', short: 'STAM', desc: 'Cardio: stamina regen and how big the tank stays late in a fight.' },
    { key: 'chin', label: 'Health', short: 'HLTH', desc: 'Durability: how much a clean head shot rocks you and how hard you are to knock down.' },
    { key: 'spd', label: 'Strike speed', short: 'SPD', desc: 'How fast strikes come out and how quickly you move.' },
    { key: 'pow', label: 'Strike power', short: 'POW', desc: 'Damage behind every punch, kick, knee and elbow.' },
    { key: 'bjj', label: 'BJJ', short: 'BJJ', desc: 'Submissions, submission defence, sweeps and escapes.' },
    { key: 'wre', label: 'Wrestling', short: 'WRE', desc: 'Takedowns, takedown defence, passing and top control.' }
  ];
  const STAT_BY_KEY = {}; for (const s of STATS) STAT_BY_KEY[s.key] = s;

  // ---------- the gym ----------
  // one facility per stat (each level makes a week of that training worth more), a recovery suite and a head coach
  const FACILITIES = [
    { id: 'car', name: 'Cardio room', stat: 'car', desc: 'Bikes, ropes and a hill out back. Stamina training.' },
    { id: 'chin', name: 'Strength & conditioning', stat: 'chin', desc: 'Neck harness, sled, barbells. Health training.' },
    { id: 'spd', name: 'Boxing ring', stat: 'spd', desc: 'Speed bags, mitts, sparring rounds. Strike speed training.' },
    { id: 'pow', name: 'Heavy bag room', stat: 'pow', desc: 'Bags, pads and Thai shields. Strike power training.' },
    { id: 'bjj', name: 'Mat room', stat: 'bjj', desc: 'Competition mats and a rolling room. BJJ training.' },
    { id: 'wre', name: 'Wrestling room', stat: 'wre', desc: 'Dummies, a cage wall and drilling partners. Wrestling training.' },
    { id: 'recovery', name: 'Recovery suite', stat: null, desc: 'Ice baths, physio, sleep. Injuries heal faster every week.' },
    { id: 'coach', name: 'Head coach', stat: null, desc: 'A better coach makes every training week count for more.' }
  ];
  const FACILITY_MAX = 5;
  const FACILITY_COST = [1500, 4000, 10000, 25000, 60000];            // indexed by current level: [0] buys 0->1 ... [4] buys 4->5
  const COACH_COST = [6000, 25000, 90000, 250000, 600000];
  const FACILITY_BY_ID = {}; for (const f of FACILITIES) FACILITY_BY_ID[f.id] = f;
  function upgradeCost(id, level) { return (id === 'coach' ? COACH_COST : FACILITY_COST)[level] || null; }

  // ---------- organisations ----------
  // tier 0 = regional shows, 3 = the big league. pop is the popularity (0..100) they start making offers at.
  const ORGS = [
    { id: 'tsc', name: 'Tri-State Cage Wars', tier: 0, pop: 0, purse: [500, 1100], diff: [0.25, 0.4] },
    { id: 'bayou', name: 'Bayou Brawl', tier: 0, pop: 0, purse: [400, 900], diff: [0.2, 0.38] },
    { id: 'rust', name: 'Rust Belt Fighting Series', tier: 0, pop: 6, purse: [700, 1600], diff: [0.3, 0.45] },
    { id: 'iron', name: 'Iron Circuit', tier: 1, pop: 24, purse: [3000, 7000], diff: [0.42, 0.58] },
    { id: 'pfl', name: 'Pacific Fight League', tier: 1, pop: 28, purse: [3500, 8500], diff: [0.45, 0.6] },
    { id: 'cn', name: 'Cage Nation', tier: 1, pop: 34, purse: [5000, 12000], diff: [0.5, 0.65] },
    { id: 'apex', name: 'Apex Fighting', tier: 2, pop: 50, purse: [15000, 40000], diff: [0.58, 0.74] },
    { id: 'valor', name: 'Valor FC', tier: 2, pop: 56, purse: [20000, 55000], diff: [0.62, 0.78] },
    { id: 'ufc', name: 'UFC', tier: 3, pop: 74, purse: [60000, 220000], diff: [0.72, 0.92] }
  ];
  const TIER_NAME = ['Regional', 'National', 'Major', 'The big league'];
  const TIER_POP_CAP = [42, 66, 88, 100]; // wins at this level can only make you so famous: move up to keep climbing
  const TITLE_POP = 92;            // popularity at which the champion agrees to fight you
  const TOP = ORGS[ORGS.length - 1];

  // ---------- names ----------
  const FIRST = ['Marcus', 'Diego', 'Tyrone', 'Jarrod', 'Ivan', 'Rafael', 'Kenji', 'Cody', 'Anton', 'Mateo', 'Darnell', 'Luka', 'Tomas', 'Elijah', 'Ruslan', 'Kofi', 'Brennan', 'Yusuf', 'Dmitri', 'Caleb', 'Joaquin', 'Teo', 'Malik', 'Vitor', 'Soren', 'Andre', 'Hugo', 'Ezra', 'Nikolai', 'Tavian', 'Reece', 'Alejandro', 'Kwame', 'Lorenzo', 'Jonah', 'Emeka', 'Ravi', 'Dante', 'Felix', 'Omar'];
  const LAST = ['Vance', 'Ferreira', 'Dawson', 'Kowalski', 'Blake', 'Petrov', 'Salgado', 'Tanaka', 'Garrity', 'Okonkwo', 'Harlan', 'Moreau', 'Reyes', 'Brandt', 'Castellano', 'Mbeki', 'Whitlock', 'Demir', 'Volkov', 'Ashby', 'Quintero', 'Lindqvist', 'Haddad', 'Oyelaran', 'Beaumont', 'Stroud', 'Navarro', 'Kirchner', 'Delgado', 'Fenwick', 'Abara', 'Santoro', 'Mahlangu', 'Ivashko', 'Carvalho', 'Rourke', 'Nakamura', 'Sosa', 'Thorne', 'Achebe'];
  const NICKS = ['The Reaper', 'Iron', 'Sugar', 'Showtime', 'The Eagle', 'Blessed', 'Poatan', 'The Diamond', 'The Nightmare', 'Bones', 'Rocky', 'Durinho', 'Platinum', 'The Machine', 'Stylebender', 'Bam Bam', 'Trouble', 'Hands of Stone', 'Chaos', 'The Problem', 'Rukus', 'Tarzan', 'El Matador', 'The Butcher', 'Hurricane', 'Thunder', 'Venom', 'Diesel', 'Mayhem', 'Bad Boy'];
  const CITIES = ['Newark', 'Baton Rouge', 'Youngstown', 'Fresno', 'Tulsa', 'Dayton', 'Reno', 'Spokane', 'Albuquerque', 'Toledo', 'Las Vegas', 'Anaheim', 'Denver', 'Houston', 'Miami', 'Phoenix', 'Atlanta', 'Chicago', 'Boston', 'Sao Paulo', 'Manchester', 'Dagestan', 'Auckland', 'Mexico City'];
  const SKINS = [0xe0b48c, 0x6b4a2c, 0xc9956a, 0xf0c9a0, 0x8d5a3b, 0xd9a77c, 0x4a2f1c, 0xb98a64];
  const COLORS = [0xd93b3b, 0x2f6fd9, 0x2fb36b, 0xe8a62a, 0x8e44ad, 0x16a085, 0xd35400, 0x2c3e50, 0xf1c40f, 0x7f8c8d];

  // ---------- RNG (seeded so a save reloads the same offers) ----------
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

  // ---------- fighter creation ----------
  // the archetype only shapes the starting spread; everything starts well below the roster fighters
  function startingStats(base) {
    const r = ROSTER[base] || ROSTER.balanced, out = {};
    for (const s of STATS) out[s.key] = Math.round((0.16 + r.stats[s.key] * 0.36) * 100) / 100; // ~0.33 .. 0.49
    return out;
  }
  const avg = (stats) => STATS.reduce((a, s) => a + stats[s.key], 0) / STATS.length;
  // overall rating shown to the player (0..100)
  const rating = (stats) => Math.round(avg(stats) * 100);

  function newCareer(opts) {
    opts = opts || {};
    const base = ROSTER[opts.base] ? opts.base : 'balanced';
    const r0 = rng((Date.now() ^ 0x9e3779b9) >>> 0);
    const C = {
      v: SAVE_VERSION,
      seed: (r0() * 1e9) | 0,
      name: (opts.name || '').trim().slice(0, 14) || 'You',
      nick: (opts.nick || '').trim().slice(0, 16),
      base, color: opts.color != null ? opts.color : ROSTER[base].color, skin: opts.skin != null ? opts.skin : ROSTER[base].skin,
      stats: startingStats(base),
      week: 1,
      money: 2000,
      pop: 2,
      record: { w: 0, l: 0, d: 0, ko: 0, sub: 0, dec: 0 },
      streak: 0,
      gym: { car: 0, chin: 0, spd: 0, pow: 0, bjj: 0, wre: 0, recovery: 0, coach: 0 },
      injury: { head: 0, body: 0, legs: 0 },
      booked: null,        // the camp in progress: { offer, weeksLeft, plan: [] }
      offers: [],
      history: [],         // fights, newest last
      log: [],             // short news lines, newest last
      champion: false,
      titleDefenses: 0,
      lastFight: null
    };
    C.offers = makeOffers(C);
    say(C, 'Career started out of a ' + pick(rng(C.seed), CITIES) + ' garage gym. Regional promoters are calling.');
    return C;
  }

  function say(C, text) { C.log.push({ week: C.week, text }); while (C.log.length > 60) C.log.shift(); }

  // ---------- popularity / tiers ----------
  function tierFor(pop) { let t = 0; for (const o of ORGS) if (pop >= o.pop) t = Math.max(t, o.tier); return t; }
  function orgsOpenTo(pop) { return ORGS.filter(o => pop >= o.pop); }
  function popLabel(pop) {
    return pop >= TITLE_POP ? 'Superstar' : pop >= 74 ? 'Household name' : pop >= 50 ? 'Rising contender' : pop >= 24 ? 'Regional champion material' : pop >= 8 ? 'Local draw' : 'Unknown';
  }

  // ---------- opponents ----------
  function makeOpponent(r, org, C, title) {
    const base = pick(r, Object.keys(ROSTER));
    const arch = ROSTER[base].stats;
    // the org's difficulty band sets the opponent's level; the archetype shapes it; title holders are a class above
    const lvl = title ? 0.9 + r() * 0.06 : lerp(org.diff[0], org.diff[1], r());
    const stats = {};
    for (const s of STATS) stats[s.key] = Math.round(clamp(lvl + (arch[s.key] - 0.66) * 0.55 + (r() - 0.5) * 0.08, 0.15, 0.99) * 100) / 100;
    const fights = Math.round(2 + lvl * 24 + r() * 6), wins = Math.round(fights * clamp(0.45 + lvl * 0.45 + (r() - 0.5) * 0.2, 0.3, 0.95));
    return {
      name: pick(r, FIRST) + ' ' + pick(r, LAST), nick: r() < 0.7 ? pick(r, NICKS) : '',
      base, style: ROSTER[base].style, stats, rating: rating(stats), level: lvl,
      record: { w: wins, l: fights - wins }, from: pick(r, CITIES),
      color: pick(r, COLORS), skin: pick(r, SKINS),
      diff: clamp(lvl, 0.2, 0.97)   // CPU difficulty for the brain that drives him
    };
  }

  // ---------- offers ----------
  function makeOffers(C) {
    const r = rng((C.seed + C.week * 7919) >>> 0);
    const open = orgsOpenTo(C.pop);
    if (C.champion && open.indexOf(TOP) < 0) open.push(TOP); // the champion always has the big league on the phone
    const top = open.reduce((m, o) => Math.max(m, o.tier), 0);
    // only your top tier and the one below it make offers; offer 0 always comes from the top tier
    const pool = open.filter(o => o.tier >= top - 1);
    const n = 2 + (r() < 0.6 ? 1 : 0);
    const offers = [];
    const titleShot = C.pop >= TITLE_POP && !C.champion;
    for (let i = 0; i < n; i++) {
      let org;
      const used = offers.map(x => x.org);
      if (i === 0) { const tops = pool.filter(o => o.tier === top); org = pick(r, tops); }
      else {
        // weight toward the higher tiers as popularity grows past their threshold; spread the offers over different promoters
        const w = pool.map(o => (1 + (o.tier === top ? 1.5 : 0) + Math.max(0, (C.pop - o.pop) / 40)) * (used.indexOf(o.id) >= 0 ? 0.15 : 1));
        let t = r() * w.reduce((a, b) => a + b, 0); org = pool[0];
        for (let k = 0; k < pool.length; k++) { t -= w[k]; if (t <= 0) { org = pool[k]; break; } }
      }
      const title = titleShot && org.tier === 3 && i === 0 || (C.champion && org.tier === 3 && i === 0);
      const opp = makeOpponent(r, org, C, title);
      const weeks = title ? 10 : 4 + Math.floor(r() * 7); // 4..10
      // purse: org band, scaled by popularity inside the band, plus a win bonus. Short-notice fights pay a little more.
      const popIn = clamp((C.pop - org.pop) / 30, 0, 1);
      let purse = lerp(org.purse[0], org.purse[1], popIn * 0.7 + r() * 0.3) * (1 + (10 - weeks) * 0.03);
      if (title) purse *= 2.5;
      purse = Math.round(purse / 50) * 50;
      const bonus = Math.round(purse * (org.tier === 3 ? 1 : 0.6) / 50) * 50;
      offers.push({
        id: (r() * 1e9) | 0, org: org.id, orgName: org.name, tier: org.tier, title: !!title,
        opp, weeks, purse, bonus, rounds: title ? 5 : 3, len: 180,
        note: title ? (C.champion ? 'Title defence. Lose and the belt goes with it.' : 'Title fight. Five rounds for the belt.') :
          org.tier === 3 ? 'Main card. The whole world is watching.' :
          weeks <= 5 ? 'Short notice — less time to prepare, a little more money.' : weeks >= 9 ? 'A long camp: plenty of weeks to train.' : ''
      });
    }
    return offers;
  }

  function offerDanger(C, offer) {
    // how the opponent compares to you (what the matchmaker shows): < -8 easy, > 8 tough
    return offer.opp.rating - rating(C.stats);
  }

  // ---------- booking / weeks ----------
  function accept(C, offerId) {
    const o = C.offers.find(x => x.id === offerId); if (!o || C.booked) return false;
    C.booked = { offer: o, weeksLeft: o.weeks, plan: [] };
    C.offers = [];
    say(C, 'Signed to fight ' + o.opp.name + ' for ' + o.orgName + ' in ' + o.weeks + ' weeks.');
    return true;
  }

  // training gain for one week on a stat
  function trainGain(C, key) {
    const s = C.stats[key];
    const lvl = C.gym[key] || 0, coach = C.gym.coach || 0;
    const base = 0.026;
    const facility = 1 + lvl * 0.3;              // level 5 room: +150 %
    const coachMul = 1 + coach * 0.12;           // level 5 coach: +60 %
    const dimin = Math.pow(1 - s, 1.2) + 0.1;    // easy gains early, grinding past 0.85
    const hurt = 1 - injuryTotal(C) / 260;       // injuries cut gains (floored at x0.35 below)
    return base * facility * coachMul * dimin * Math.max(0.35, hurt);
  }
  function injuryTotal(C) { return C.injury.head + C.injury.body + C.injury.legs; }
  function healWeek(C, rest) {
    const h = (10 + (C.gym.recovery || 0) * 4) * (rest ? 2.5 : 1);
    for (const k in C.injury) C.injury[k] = Math.max(0, C.injury[k] - h);
  }

  // spend one week: focus = a stat key or 'rest'. Returns what happened.
  function trainWeek(C, focus) {
    const out = { week: C.week, focus, gain: 0, before: null, after: null };
    if (focus === 'rest') { healWeek(C, true); }
    else {
      if (!STAT_BY_KEY[focus]) return null;
      out.before = C.stats[focus];
      const g = trainGain(C, focus);
      C.stats[focus] = Math.round(clamp(C.stats[focus] + g, 0, 0.99) * 10000) / 10000;
      out.after = C.stats[focus]; out.gain = out.after - out.before;
      healWeek(C, false);
    }
    C.week++;
    if (C.booked) { C.booked.plan.push(focus); C.booked.weeksLeft--; }
    else {
      // no fight booked: a quiet week costs a sliver of popularity and brings new offers
      C.pop = Math.max(0, Math.round((C.pop - 0.6) * 10) / 10);
      C.offers = makeOffers(C);
    }
    return out;
  }
  const fightReady = (C) => !!(C.booked && C.booked.weeksLeft <= 0);

  // ---------- gym ----------
  function buyUpgrade(C, id) {
    const lvl = C.gym[id] || 0; const cost = upgradeCost(id, lvl);
    if (cost == null || lvl >= FACILITY_MAX || C.money < cost) return false;
    C.money -= cost; C.gym[id] = lvl + 1;
    say(C, FACILITY_BY_ID[id].name + ' upgraded to level ' + (lvl + 1) + '.');
    return true;
  }

  // ---------- the fight itself ----------
  // players array for new Sim(...) / beginFight; the player is always the red corner
  function fightSetup(C) {
    const o = C.booked.offer, opp = o.opp;
    return {
      seed: (Math.random() * 1e9) | 0,
      players: [
        { fighter: C.base, name: C.name, stats: C.stats, color: C.color, skin: C.skin, dmg: { head: C.injury.head * 0.5, body: C.injury.body * 0.5, legs: C.injury.legs * 0.5 } },
        { fighter: opp.base, name: opp.name, stats: opp.stats, color: opp.color === C.color ? 0x8e44ad : opp.color, skin: opp.skin }
      ],
      settings: { rounds: o.rounds, len: o.len, grappling: true },
      diff: opp.diff
    };
  }

  // apply a finished Sim state. Returns the summary shown after the fight.
  function applyResult(C, S) {
    const B = C.booked; if (!B || !S || !S.result) return null;
    const o = B.offer, R = S.result, me = S.f[0], opp = S.f[1];
    const won = R.winner === 0, draw = R.winner == null;
    const method = R.method;
    const finish = /KO|TKO|Submission/i.test(method);
    const rnd = R.round || S.rounds;
    // popularity: a win at a bigger org is worth more, a quick finish is worth a lot more
    const tierMul = [1, 1.4, 1.8, 2.4][o.tier];
    let dPop = 0;
    if (won) {
      dPop = 4 * tierMul;
      if (finish) dPop += (3 + Math.max(0, o.rounds - rnd) * 2.5) * tierMul;   // round-1 finish in a 3-rounder: +8 on top
      if (method.indexOf('Split') >= 0) dPop *= 0.75;
      if (o.title) dPop += 6;
      if (C.streak >= 2) dPop += 1.5;
    } else if (draw) dPop = 0.5;
    else { dPop = -(3 + 1.5 * tierMul); if (finish && rnd === 1) dPop -= 2; if (o.title) dPop -= 3; }
    // a fight-of-the-night pace sells too
    const action = (me.ts.landed + opp.ts.landed) / Math.max(1, S.cards.length);
    if (action > 45) dPop += 1.5;
    dPop = Math.round(dPop * 10) / 10;
    if (dPop > 0) dPop = Math.max(0, Math.min(dPop, TIER_POP_CAP[o.tier] - C.pop));
    C.pop = clamp(Math.round((C.pop + dPop) * 10) / 10, 0, 100);
    const pay = o.purse + (won ? o.bonus : 0);
    C.money += pay;
    // record
    if (won) { C.record.w++; C.streak = Math.max(1, C.streak + 1); if (/Submission/i.test(method)) C.record.sub++; else if (finish) C.record.ko++; else C.record.dec++; }
    else if (draw) { C.record.d++; C.streak = 0; }
    else { C.record.l++; C.streak = Math.min(-1, C.streak - 1); }
    // injuries carry over from what you took in there
    const inj = { head: Math.round(me.dmg.head * 0.55), body: Math.round(me.dmg.body * 0.55), legs: Math.round(me.dmg.legs * 0.55) };
    if (!won && finish) inj.head += 10;
    for (const k in inj) C.injury[k] = clamp(C.injury[k] + inj[k], 0, 100);
    // titles
    let titleNote = '';
    if (o.title) {
      if (won && !C.champion) { C.champion = true; C.titleDefenses = 0; titleNote = 'NEW ' + o.orgName + ' CHAMPION'; }
      else if (won && C.champion) { C.titleDefenses++; titleNote = 'Title defended (' + C.titleDefenses + ')'; }
      else if (!draw && C.champion) { C.champion = false; titleNote = 'Belt lost'; }
    }
    const entry = { week: C.week, org: o.orgName, tier: o.tier, title: o.title, opp: o.opp.name, oppRating: o.opp.rating, won, draw, method, round: rnd, time: R.time, pay, dPop, pop: C.pop, inj };
    C.history.push(entry);
    C.lastFight = Object.assign({ titleNote, stats: { me: me.ts, opp: opp.ts }, oppName: o.opp.name }, entry);
    say(C, (won ? 'Beat ' : draw ? 'Drew with ' : 'Lost to ') + o.opp.name + ' (' + method + (finish ? ', R' + rnd : '') + ') at ' + o.orgName + '. $' + pay.toLocaleString() + ', popularity ' + (dPop >= 0 ? '+' : '') + dPop + '.' + (titleNote ? ' ' + titleNote + '.' : ''));
    C.booked = null; C.week++;
    C.offers = makeOffers(C);
    return C.lastFight;
  }

  // pulled out of a booked fight (quit mid-fight / withdrew): no purse, the promoter remembers
  function withdraw(C) {
    const B = C.booked; if (!B) return;
    C.pop = Math.max(0, Math.round((C.pop - 4) * 10) / 10);
    say(C, 'Pulled out of the ' + B.offer.opp.name + ' fight. ' + B.offer.orgName + ' is not happy. Popularity -4.');
    C.booked = null; C.week++; C.offers = makeOffers(C);
  }

  // ---------- save / load ----------
  function save(C) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(C)); return true; } catch (_) { return false; } }
  function load() {
    try {
      const C = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (!C || C.v !== SAVE_VERSION || !C.stats) return null;
      return C;
    } catch (_) { return null; }
  }
  function erase() { try { localStorage.removeItem(SAVE_KEY); } catch (_) {} }

  const fmtMoney = (n) => '$' + Math.round(n).toLocaleString();
  const weekLabel = (w) => 'Year ' + (Math.floor((w - 1) / 52) + 1) + ' · Week ' + (((w - 1) % 52) + 1);

  const API = { STATS, STAT_BY_KEY, FACILITIES, FACILITY_BY_ID, FACILITY_MAX, ORGS, TIER_NAME, TIER_POP_CAP, TITLE_POP, TOP, SKINS, COLORS,
    newCareer, startingStats, rating, tierFor, popLabel, makeOffers, offerDanger, accept, trainGain, trainWeek, fightReady, healWeek,
    upgradeCost, buyUpgrade, fightSetup, applyResult, withdraw, injuryTotal, save, load, erase, fmtMoney, weekLabel, SAVE_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.MMACareer = API;
})(typeof window !== 'undefined' ? window : globalThis);
