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

| Key | Standing | On top (ground) | On bottom (ground) |
|---|---|---|---|
| **W / S** | close distance / back off | — | mash to escape |
| **A / D** | circle left / right | — | mash to escape |
| **J** | jab | ground punch | — |
| **K** | cross | hammer fist | — |
| **U** | hook | elbow | — |
| **I** | head kick | body shot | — |
| **O** | body kick (knee when close) | body shot | — |
| **P** | low kick | body shot | — |
| **L** (hold) | block / sprawl vs takedowns | posture up (kills escape progress) | cover up vs strikes |
| **Space** | takedown | submission attempt | sweep / reversal |
| **Shift** | slip (dodge) | stand up and let them up | — |
| **H** / **M** | hide controls / mute | | |

Movement is relative to your opponent (W always moves toward them), so it
works from any camera angle.

## Fight model

* **Damage by region** — head, body and legs. Head damage is your main
  health bar; heavy shots can **rock** you (slow, vulnerable), and getting
  hit while rocked is a **knockdown**. Body damage drains stamina regen
  and can finish you (TKO body); leg damage slows you, can buckle your
  leg and can also end the fight.
* **Stamina** governs strike speed, power, movement and grappling. Cardio
  stat sets regen. Blocking regenerates slowly, moving less.
* **Striking** — windup / active / recovery frames. Landing on an opponent
  mid‑windup is a **counter** (+35 %). Slipping (Shift) avoids a strike and
  makes the attacker over‑commit. Blocks absorb 85 % (45 % vs low kicks)
  and cost the blocker stamina.
* **Wrestling** — takedown success depends on both wrestling stats,
  whether the defender is sprawling (holding block), caught mid‑strike,
  rocked or tired. Failed shots leave you stumbling.
* **Ground** — the top fighter strikes, postures or hunts submissions; the
  bottom fighter mashes directions to build escape, covers up, or times a
  sweep when the top player swings. The ref stands up a stalled position.
* **Submissions** — a progress meter driven by the attacker's BJJ, and the
  defender's stamina, head damage and mash rate. Fail and you burn stamina
  and give up escape progress.
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

Tuning lives at the top of `js/sim.js` (`ROSTER` stats, `STRIKES` table).
