# Cage Rules — 1v1 MMA in the browser

A 3D one‑on‑one mixed martial arts simulation. Play online against a friend
(peer‑to‑peer, no server to run) or practice against the CPU. Pure static
files — made for GitHub Pages.

The standing game is **physics based**: both fighters are active ragdolls
(eleven rigid bodies each, joint motors chasing stance / guard / strike
poses, simulated with [Rapier](https://rapier.rs) at 240 Hz). A punch is a
real fist being thrown at the opponent — it only does damage if it actually
arrives, with speed, square to the target — and a guard works because the
forearms are physically in the way. Everything else (ground game, takedowns,
submissions, stamina, judging, netcode) is the regular Cage Rules ruleset.

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

* One player clicks **Create room** and shares the 5‑letter code.
* The other clicks **Join room**, enters the code, and connects.
* Both pick a fighter and hit **Ready**. The host's browser runs the fight;
  the guest sends inputs and receives state ~20 times a second.

Matchmaking uses the free public PeerJS signaling server (`0.peerjs.com`).
Once connected, traffic is direct WebRTC between the two browsers. If a
strict NAT blocks the direct link the connection may fail — try again or
have the other player host. To use your own PeerJS server, set
`window.PEER_SERVER = { host: '...', port: 443, secure: true }` before
`js/net.js` loads.

## Controls (keyboard)

Every key can be rebound and every strike remapped from **OPTIONS** (main menu,
lobby, or **Esc** during a fight — practice pauses). Settings are saved in the
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
| **L** (hold) | block / sprawl vs takedowns | posture up (kills escape progress) | cover up vs strikes |
| **Space** | takedown | submission attempt | sweep / reversal |
| **Shift** | slip (dodge) | stand up and let them up | — |
| **Esc** / **H** / **M** | options / hide controls / mute | | |

Movement is relative to your opponent (W always moves toward them), so it
works from any camera angle.

## Fight model

* **Damage by region** — head, body and legs. Head damage is your main
  health bar; heavy shots can **rock** you (slow, vulnerable), and getting
  hit while rocked is a **knockdown**. Body damage drains stamina regen
  and can finish you (TKO body); leg damage slows you, can buckle your
  leg and can also end the fight.
* **Stamina** governs strike speed, power, movement and grappling. Cardio
  stat sets regen. Blocking regenerates slowly, moving less. Every strike
  is paid for up front: a clean landing (not blocked) gives a third of it
  back, a whiff costs 30 % extra, a blocked one is simply spent.
* **Max stamina** — the translucent part of the stamina bar is the ceiling
  you can regenerate to. Head damage shrinks it a little, body damage a
  lot, and swinging on an empty tank (pressing a strike with nothing
  left, or overdrawing one) wears it down too. In the corner you get 20 %
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
  in hurts a lot more, and a punch thrown from the clinch has no room to
  build speed. Whatever is physically in the way takes the hit: a head kick
  into a raised arm is a block, a low kick into a braced shin is **checked**,
  a jab that lands on the gloves is picked off. Short weapons (uppercuts,
  hooks, knees) are for the pocket; straights, teeps and kicks need room.
  Hard shots physically stagger the ragdoll (gains drop, the body gets
  shoved); a KO drops the fighter where he stands.
* **Combos flow.** As soon as a strike has landed (or whiffed) you can throw
  the next one straight out of the recovery, and a press made while a strike
  is still in the air is buffered and fires the instant it can. Chained
  strikes come out a little quicker (up to three in a rhythm); doubling up
  on the same limb doesn't get the bonus. A strike that gets slipped has to
  be ridden out. Hits landed on an already‑stunned opponent stun for less,
  so a combination can't lock someone up forever.
* Landing on an opponent mid‑windup is a **counter** (+35 %). A hard punch
  that catches someone mid‑kick cancels the kick, hits harder still
  (+30 %), stuns them longer and charges them for the wasted kick. Slipping
  (Shift) physically moves your head off the centre line: straight shots
  whiff and the attacker over‑commits, but body and leg strikes still land.
  Holding block raises a tight guard: hits on the forearms do 15 % (45 %
  for a checked low kick) and cost the blocker stamina; a stray arm that
  happens to be in the way (not blocking) still soaks about half. Teeps
  shove the opponent back.
* **Wrestling** — takedown success depends on both wrestling stats,
  whether the defender is sprawling (holding block), caught mid‑strike,
  rocked or tired. Failed shots leave you stumbling. A takedown lands in
  closed guard (half guard if the shooter is a strong wrestler who caught
  you swinging); a **knockdown** is physical: the hurt fighter drops where he
  stands and spends about two seconds getting back up (he can't be hit while
  he is down and comes up rocked). While he is on the mat the attacker can
  press the takedown key to **follow him down** into half guard, or let him
  up and keep it standing.
* **Ground positions** — closed guard → half guard → side control → mount,
  plus back control. The top fighter advances with **takedown key + W**
  (pass / take mount); the bottom fighter works with **takedown key + a
  direction**: S recovers guard or shrimps out, W stands up (a wall‑walk
  from guard, a riskier turn‑and‑stand from side control), A/D sweeps or
  bridges for a reversal. Every attempt is a timed move the other fighter
  can see coming and deny by holding block (basing / framing), which costs
  them stamina; a failed attempt leaves you exposed, and some failures are
  punished with a worse position (a failed stand‑up from side control gives
  up your back). Attempts have a short cooldown — no mashing. Strikes hit
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

## Files

```
index.html        page + HUD + menus (+ loads the physics engine in the background)
css/style.css
js/physics.js     MMAPhys: Rapier world, active ragdolls, stance / guard / strike poses,
                  contact → damage. No Three.js, runs in Node too.
js/sim.js         fight simulation (seeded, fixed‑step). Standing = ragdolls, ground = ruleset
js/ai.js          CPU opponent
js/render.js      Three.js arena, segment fighters (follow the ragdoll bones when standing,
                  a two‑bone IK rig posed from POSES on the ground), camera, FX
js/net.js         PeerJS rooms (host‑authoritative; bone poses ride in the state snapshot)
js/audio.js       WebAudio sound effects
js/main.js        menus, lobby, input, game loop, HUD
lib/              rapier3d-compat.js (physics), three.min.js, peerjs.min.js
tools/            node scripts: headless.js (CPU vs CPU fights + stats),
                  probe.js (throw every strike at a dummy over a range of distances),
                  browser-test.js (run the page in headless Chromium)
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

The old swept‑tip striking model is still in `js/sim.js` and is used
automatically if the physics engine fails to load. Its tuning (`KIND_STATS`,
`handPath` / `legPath`) only matters in that fallback.
