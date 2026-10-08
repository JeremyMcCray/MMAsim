# Cage Rules — 1v1 MMA in the browser

A 3D one‑on‑one mixed martial arts simulation. Play online against a friend
(peer‑to‑peer) or practice against the CPU. It runs as static files on
GitHub Pages.

The standing game is **physics based**: both fighters are active ragdolls
(eleven rigid bodies each, joint motors chasing stance / guard / strike
poses, simulated with [Rapier](https://rapier.rs) at 240 Hz), so every strike
and block is decided by real contact (see [Fight model](#fight-model)).

## Host on GitHub Pages

1. Create a repository (e.g. `cage-rules`) and push every file in this folder
   to the root of the `main` branch (`index.html`, `css/`, `js/`, `lib/`).
   `lib/rapier3d-compat.js` (the physics engine, ~4 MB, WebAssembly inlined)
   is required; it is loaded in the background and the first fight waits for it.
2. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a
   branch*, Branch = `main`, folder = `/ (root)`. Save.
3. After a minute the game is live at `https://<your-user>.github.io/cage-rules/`.

Three.js and PeerJS load from cdnjs; copies of `three.min.js` (r128) and
`peerjs.min.js` (1.5.x) are vendored in `lib/` and the page falls back to
them automatically if the CDN is unreachable.

## Online play
* One player creates a room and shares its 5‑letter code; the other joins with it.
* Both pick a fighter and hit **Ready**. The host's browser runs the fight;
  the guest sends inputs and receives state ~20 times a second.

Matchmaking uses the free public PeerJS signaling server (`0.peerjs.com`).
Once connected, traffic is direct WebRTC between the two browsers.

## Controls (keyboard)

Every key can be rebound and every strike remapped from **OPTIONS** (main menu,
lobby, or **Esc** during a fight). Settings are saved in the
browser. Defaults:

| Key | Standing | On top (ground) | On bottom (ground) |
|---|---|---|---|
| **W / S** | close distance / back off (works mid‑strike at half speed) | — | mash to escape |
| **A / D** | circle left / right | — | mash to escape |
| **U** | left hand | left hand punch | — |
| **I** | right hand | right hand punch | — |
| **J** | left leg | left knee to the body | — |
| **K** | right leg | right knee to the body | — |
| **Q** (hold) | hands → hooks, legs → body kicks | hands → elbows | — |
| **E** (hold) | hands → straights, legs → head kicks | hands → hammer fists | — |
| **R** (hold) | hands → overhands, legs → low kicks | hands → body shots | — |
| *(no modifier)* | hands → uppercuts, lead leg → teep, rear leg → knee | | |
| **L** (hold) | high guard / sprawl vs takedowns; **L + R** drops into a Philly shell — lead arm across the body, rear glove at the cheek — that covers the body (kicks, knees, teeps) and the rear-hand side, but is open to lead hooks; double‑tap to shove a crowding opponent off you | posture up (kills escape progress) | cover up vs strikes |
| **Space** | takedown / dive on a knocked‑down opponent | submission attempt | sweep / reversal |
| **Shift** | slip (dodge) / get up when knocked down (any direction works too) | stand up and let them up | — |
| **Esc** / **H** / **M** | options / hide controls / mute | | |

Movement is relative to your opponent (W always moves toward them), so it
works from any camera angle.

## Fight model

* **Damage by region** — head, body and legs. Head damage is your main
  health bar; heavy shots can **rock** you (slow, vulnerable, for a second
  or two), and a solid head shot while you are rocked is a **knockdown** —
  the bar for that drops as your head damage climbs. Body damage drains stamina regen
  and can finish you (TKO body); leg damage slows you, can buckle your
  leg and can also end the fight.
* **Stamina** governs strike speed, power, movement and grappling. Cardio
  stat sets regen. Blocking regenerates slowly, moving less. Every strike
  is paid for up front: a clean landing gives a third of it back, a whiff
  costs 30 % extra, a blocked one is simply spent.
* **Max stamina** — the translucent part of the stamina bar is the ceiling
  you can regenerate to. Head damage shrinks it a little, body damage a
  lot, and throwing strikes you can't afford wears it down too. In the corner you get 20 %
  of it back and start the next round with a full tank.
* **Striking is physical.** Each strike is a limb (U/I/J/K) plus a kind
  chosen by the modifier you hold. The strike is a keyframed pose that the
  ragdoll's joint motors chase — hips and shoulders turn into the blow
  first, the limb fires last — and the fist / shin / instep is a real rigid
  body. When it touches the opponent the game reads the contact normal and
  the pre‑impact velocities and computes `vn` (closing speed along the
  normal) and how **clean** the hit is. Below 2.2 m/s or less than 35 %
  square it is a **glancing** blow and does nothing; otherwise damage grows
  with `(vn − 2.2)^1.3`, so stepping into a shot or catching someone walking
  in hurts a lot more, and punches from the clinch stay weak. Whatever is in
  the way takes the hit: a head kick
  into a raised arm is a block, a low kick into a braced shin is **checked**,
  a jab that lands on the gloves is picked off. Short weapons (uppercuts,
  hooks, knees) are for the pocket; straights, teeps and kicks need room.
  Hard shots stagger the ragdoll (gains drop, the body gets shoved).
* **Combos flow.** As soon as a strike has landed (or whiffed) you can throw
  the next one straight out of the recovery, and a press made while a strike
  is still in the air is buffered and fires the instant it can. Chained
  strikes come out a little quicker (up to three in a rhythm) when you
  switch limbs. A strike that gets slipped has to be ridden out. Hits on an
  already‑stunned opponent stun for less, so stun‑locks wear off.
* Landing on an opponent mid‑windup is a **counter** (+35 %). A hard punch
  that catches someone mid‑kick cancels the kick, hits harder still
  (+30 %), stuns them longer and charges them for the wasted kick. Slipping
  (Shift) physically moves your head off the centre line: straight shots
  whiff and the attacker over‑commits, but body and leg strikes still land.
  Holding block raises a tight guard: hits on the forearms do 15 % (45 %
  for a checked low kick) and a clean block gives the blocker a sliver of
  stamina back (8 % of what the strike cost the attacker); a stray arm in
  the way soaks about half, with no stamina refund. Teeps shove the
  opponent back.
* **Wrestling** — takedown success depends on both wrestling stats,
  whether the defender is sprawling (holding block), caught mid‑strike,
  rocked or tired. Failed shots leave you stumbling. A takedown lands in
  closed guard (half guard if the shooter is a strong wrestler who caught
  you swinging).
* **Knockdowns** are physical: the hurt fighter drops where he stands and
  is safe from strikes while down. Once he has landed it is his call — press a
  direction (or the slip key) to **get up now**, coming up still rocked, or
  **stay down** to clear his head (rocked wears off 2.5× faster on the mat;
  the referee waves him up after four seconds). While he is down the other
  fighter can press the takedown key to **dive on him** — side control if he
  is lying flat, half guard if he was already getting up — or back off and
  keep it standing.
* **The referee** is in the cage with you (drawn by the renderer from the fight
  state, so online guests see him too). He keeps a T to the fighters on the far
  side from the camera, circling with them and walking round, never between them.
  In a striking-only match he jumps in over a knockdown — holding the other
  fighter off, then bending over the downed man and waving him up if he stays
  down the full count; with grappling on he stays out of it, since the fight may
  go to the mat. He waves off a stoppage. When the fight is over he stands in the centre with a fighter on each
  side and raises the winner's hand (both on a draw) before the result screen.
* **Ground positions** — closed guard → half guard → side control → mount,
  plus back control. The top fighter advances with **takedown key + W**
  (pass / take mount); the bottom fighter works with **takedown key + a
  direction**: S recovers guard or shrimps out, W stands up (a wall‑walk
  from guard, a riskier turn‑and‑stand from side control), A/D sweeps or
  bridges for a reversal. Every attempt is a timed move the other fighter
  can see coming and deny by holding block (basing / framing), which costs
  them stamina; a failed attempt leaves you exposed, and some failures are
  punished with a worse position (a failed stand‑up from side control gives
  up your back). Attempts have a short cooldown. Strikes hit
  hardest from mount; the bottom fighter can only strike from guard.
* **Submissions** — available from the right positions for both fighters
  (bottom: triangle, armbar, guillotine from guard, kimura from half guard;
  top: guillotine, kimura, americana, armbar, arm triangle, rear‑naked
  choke). Press the takedown key with no direction to attack — it costs
  stamina and is a roll (BJJ vs BJJ, much better odds against someone who
  is exposed after a failed move, rocked or gassed); a stuffed attempt
  leaves you open and on a cooldown. Once it's locked, **hold it to
  squeeze**: the hold tightens while you burn stamina. The defender holds
  block to fight the hands (slows it, costs stamina) and taps the takedown
  key to attempt an escape — timing it when the attacker lets go to breathe
  gives the best odds. Escapes improve the defender's position; running out
  of gas on a hold loses it. The referee stands up a stalled fight.
* **Striking only** — the lobby's *Grappling* setting (host decides) turns
  takedowns and the ground game off (and following a knocked‑down opponent
  to the mat); the fight can only end by KO, TKO or decision.
* **Scoring** — three judges, 10‑point must. Rounds are scored on damage,
  volume, takedowns, control time, submission attempts and knockdowns;
  dominant rounds are 10‑8. Three (or 1 / 5) rounds, 1–5 minutes each.


## Career mode (single player campaign)

**CAREER** on the main menu. Create a fighter (a base style only shapes the
starting spread — every stat starts well below the roster fighters) and work
your way from regional shows to the UFC and a title shot. Progress is saved in
the browser (`localStorage`) after every action.

* **Offers** — two or three promoters at a time offer you a fight: an opponent
  (style, record, rating and how he compares to you), a date (4–10 weeks out),
  a purse and a win bonus. Short-notice fights pay a little more; long camps
  give you more training weeks. Only orgs your popularity has reached make
  offers: regional shows from the start, national ones at 24, majors at 50,
  the UFC at 74, and the champion agrees to fight you at 92. Promoters two
  levels below you stop calling. A week with no fight booked still lets you
  train but costs a sliver of popularity.
* **Popularity** — wins at bigger shows are worth more, finishes are worth
  more, and the faster the finish the better (a round‑one KO in a 3‑rounder is
  worth roughly three times a decision). Losses cost you, more so at the top.
  Each level of the sport can only make you so famous (42 / 66 / 88), so you
  have to move up to keep climbing. Bigger orgs also pay more the more popular
  you are inside their band.
* **Camp** — every week of a camp you choose one thing to train: **Stamina**,
  **Health**, **Strike speed**, **Strike power**, **BJJ** or **Wrestling**
  (the game's `car / chin / spd / pow / bjj / wre` stats), or **rest**. Gains
  are bigger on low stats and grind past ~85.
* **The gym is a place.** The career hub is a 3D room you walk around
  (`js/gym.js`): **WASD** walks (relative to the camera), the strike keys and
  modifiers work exactly as in a fight, **L** raises your guard, **Enter** (or
  **F**) uses whatever you are standing at. A **heavy bag** hangs in the middle
  of the room — step up to it and throw anything: it swings on its chain, and
  the readout in the corner tells you what you threw, how fast the hand or foot
  was travelling and how hard it hit (light / solid / heavy / monster), with a
  combo counter and your hardest shot of the session. Bag work is practice;
  stats move through the weekly training choice. Around the room:
  * **The computer** (office corner) — your fight offers; once a fight is
    booked it shows the fight card and, on fight week, the **FIGHT** button.
  * **The whiteboard** (back wall) — pick this week's training; it shows the
    date, the camp plan so far and how banged up you are.
  * **The front desk** (by the door) — buy upgrades (below).
  * **The wall of fame** (right wall) — record, history and news; a framed
    photo goes up for every fight (green for wins, red for losses, gold frames
    for title fights).
* **Upgrades** — winnings buy one facility per stat (each level makes a
  week of that training worth 30 % more), a recovery suite (injuries heal
  faster) and a head coach (+12 % to all training per level), five levels each.
  Every upgrade is visible on the floor: bikes, a treadmill and a rower for the
  cardio room; a squat rack, plates, a sled, a bench and dumbbells for strength
  & conditioning; a speed bag, a double‑end bag and eventually a full ring for
  the boxing ring; extra heavy bags, pads and a glove wall for the heavy bag
  room; a mat area that grows, a grappling dummy and wall pads for the mat
  room; cage‑wall panels and standing dummies for wrestling; an ice bath,
  massage table, light‑therapy panel and sauna for recovery; and the head coach
  himself, standing by the ring. The room itself changes with the total number
  of upgrades: a cinder‑block **garage** with one hanging bulb and a taped‑up
  bag (0–2), a **neighbourhood gym** with rubber floors and tube lights (3–9),
  a **fight gym** with your name on a banner (10–23) and an **elite facility**
  with a lit logo, accent lighting and a trophy case (24+).
* **Injuries** — about half the damage you take in a fight comes into the next
  camp with you. It heals every week (faster when resting or with a better
  recovery suite), makes training less effective while it lasts, and if you
  fight before it is gone you start the fight with that damage on your meters.
* **Opponents** are generated per org: the scripted CPU drives them at a level
  that rises with the org, each with their own generated stat sheet.
  The fight itself is a normal 3‑round (5 for titles) fight with full rules.
  Quitting a career fight mid‑way counts as pulling out: no purse, and your
  popularity takes a hit.

`js/career.js` is the whole model (no DOM; it also loads in Node, so balance
can be simulated headless); the room is `js/gym.js` and the station panels live
in `js/main.js`. `node tools/gym-test.js` walks the gym in headless Chromium
(bag hits with every strike, every station, every upgrade tier, a full fight)
and screenshots it.

## Files

```
index.html        page + HUD + menus (+ loads the physics engine in the background)
css/style.css
js/physics.js     MMAPhys: Rapier world, active ragdolls, stance / guard / strike poses,
                  contact → damage. Headless; runs in Node too.
js/sim.js         fight simulation (seeded, fixed‑step). Standing = ragdolls, ground = ruleset
js/ai.js          scripted CPU opponent
js/career.js      career mode model: offers, orgs, popularity, camps, gym, injuries, save
js/gym.js         the career gym as a walkable 3D room: heavy bag, stations, furniture per upgrade
js/render.js      Three.js arena, procedurally skinned fighters (one continuous body mesh lofted
                  from cross-sections and weighted to the ragdoll segments; follows the ragdoll
                  when standing, a two‑bone IK rig posed from POSES on the ground), camera, FX
js/net.js         PeerJS rooms (host‑authoritative; bone poses ride in the state snapshot)
js/audio.js       WebAudio sound effects
js/main.js        menus, lobby, input, game loop, HUD
lib/              rapier3d-compat.js (physics), three.min.js, peerjs.min.js
tools/            node scripts: headless.js (CPU vs CPU fights + stats),
                  probe.js (throw every strike at a dummy over a range of distances),
                  posecheck.js (does a stance / guard pose clip the arms through the chest?),
                  browser-test.js (run the page in headless Chromium), gym-test.js (the career gym)
```

### Tuning the physics

Everything you will want first sits at the top of `js/physics.js`:

* `DMG_SCALE` — overall damage from a clean impact (fights should go rounds).
  `DMG_CAP` caps a single shot. `VMIN` / `MIN_CLEAN` decide what counts as a
  glancing blow. `PART_MULT` / `BLOCK_MULT` / `ARM_MULT` / `CHECK_MULT` say
  where a strike hurts and how much a guard soaks.
* `STRIKES` — every strike's keyframes (Euler degrees in the parent limb's
  frame), `active` damage window, `cost`, `speed` (how violently the motors
  chase the pose), `lunge` (how much the body drives forward) and, for kicks,
  `lift` (hips rise) and `pelvisTilt`. Lead‑side versions are mirrored from the
  rear‑side ones. `RANGE` is what the AI believes each strike reaches.
* `STANCE` / `GUARD` / `SLIP` / `SHOOT` / `SPRAWL` / `STUMBLE` poses, segment
  sizes and masses in `SEGS`, muscle stiffness `w0`, `HOVER_HEIGHT`,
  `MOVE_SPEED`.

`node tools/probe.js` prints, for each strike, what it connects with at every
distance (and how hard) against a dummy in stance (`node tools/probe.js guard`
for a dummy holding block). `node tools/headless.js 6` plays six CPU fights
and prints landed / blocked / whiffed counts, damage per hit, finishes and
simulation cost. In the browser, `?auto=1` lets the CPU drive your fighter in
practice mode, and `window.CageRules` exposes the live sim, state and renderer.

All standing strikes go through the physics engine. `KIND_STATS` supplies strike
names and ground-strike data; the `handPath` / `legPath` tip paths serve the gym
bag and the renderer.
