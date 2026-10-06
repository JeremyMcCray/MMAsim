# Cage Rules — 1v1 MMA in the browser

A 3D one‑on‑one mixed martial arts simulation. Play online against a friend
(peer‑to‑peer, no server to run) or practice against the CPU. Pure static
files — made for GitHub Pages.

## Host on GitHub Pages

1. Create a repository (e.g. `cage-rules`) and push every file in this folder
   to the root of the `main` branch (`index.html`, `css/`, `js/`, `lib/`).
2. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a
   branch*, Branch = `main`, folder = `/ (root)`. Save.
3. After a minute the game is live at `https://<your-user>.github.io/cage-rules/`.

Three.js and PeerJS load from cdnjs. If you prefer to self‑host them, drop
`three.min.js` (r128) and `peerjs.min.js` (1.5.x) into `lib/` — the page
falls back to those automatically if the CDN is unreachable.

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
  chosen by the modifier you hold. The simulation traces the fist, foot or
  knee along an authored path and only registers a hit when it actually
  reaches the head, torso or legs — the 3D limb follows the same path, so
  what you see is what lands. Damage scales with the **closing speed**
  between the limb and the target: step or circle into a hook or a head
  kick and it hits harder; back away from a punch and it lands soft or
  misses. A strike that makes contact before the limb extends (throwing a
  long shot from the clinch) is **smothered** and does a fraction of its
  damage. Short weapons (uppercuts, hooks, knees) are for the pocket;
  straights, teeps and kicks need room. A kick aimed at the head can
  still catch the body if that is what is in the way.
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
  (Shift) moves your head off line: head shots whiff and the attacker
  over‑commits, but body and leg strikes still land. Blocks absorb 85 %
  (45 % vs low kicks) and cost the blocker stamina. Teeps shove the
  opponent back.
* **Wrestling** — takedown success depends on both wrestling stats,
  whether the defender is sprawling (holding block), caught mid‑strike,
  rocked or tired. Failed shots leave you stumbling. A takedown lands in
  closed guard (half guard if the shooter is a strong wrestler who caught
  you swinging); a knockdown lands in half guard.
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
* **Scoring** — three judges, 10‑point must. Rounds are scored on damage,
  volume, takedowns, control time, submission attempts and knockdowns;
  dominant rounds are 10‑8. Three (or 1 / 5) rounds, 1–5 minutes each.

## Files

```
index.html        page + HUD + menus
css/style.css
js/sim.js         fight simulation (deterministic, seeded, fixed‑step)
js/ai.js          CPU opponent
js/render.js      Three.js arena, procedural fighters (two‑bone IK), camera, FX
js/net.js         PeerJS rooms (host‑authoritative)
js/audio.js       WebAudio sound effects
js/main.js        menus, lobby, input, game loop, HUD
```

Tuning lives at the top of `js/sim.js` (`ROSTER` stats, `KIND_STATS` timings and
damage, `handPath` / `legPath` limb trajectories, `DEFAULT_MOVESET`). Strike
body poses live in `STRIKE_POSES` in `js/render.js`.
