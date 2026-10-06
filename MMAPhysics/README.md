# MMA Physics

A 3D, physics-based MMA fighting game in the browser. Both fighters are **active ragdolls**:
eleven rigid bodies per fighter, joined by ball joints whose motors (solved inside the physics
engine, so they can be as stiff as real muscle without going unstable) drive each limb toward a
target pose. Nothing is animated directly — a punch is a real rigid body being thrown at the
opponent, so a strike only does damage if it actually arrives with speed, square to the target.

The joint motors push back on the parent segment, so a cross loads the shoulder, spine and hips
the way a real one does; strike poses were solved so the hips and shoulders rotate into the blow
first and the arm fires last (the kinetic chain), and the limbs are deliberately under-damped
while the blow is travelling so they whip through instead of easing in. The hips carry ~70% of
the body weight on a spring; the legs carry the rest, so the feet are planted and the body dips
when a leg leaves the floor. Simulation runs at 240 Hz.

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173). Click to start.

`npm run build` produces a static site in `dist/`.

## Controls

| Key | Action |
| --- | --- |
| W A S D | move / circle (you always face the opponent) |
| J / K | jab / cross |
| U / I | left hook / right hook |
| N / M | lead-leg low kick / rear-leg head kick |
| Left / right mouse | punch (alternating) / kick |
| Space | guard (tight high guard; blocked hits do ~20% damage and cost stamina) |
| Shift | dash in the movement direction (dodge) |
| R | restart |
| F3 | debug readout |

Add `?ai=2` to the URL to watch two AIs fight.

## How damage works

When a strike's weapon (a fist or a shin) is inside its *active window* and touches the
opponent, the game reads the contact normal from the physics engine and the pre-impact
velocities of both bodies at the contact point, then computes:

* `vn` — the relative speed along the contact normal (how hard it drives in),
* `clean` — `vn / |v_rel|`, how square the hit is (1 = dead on, 0 = sliding past).

Anything below 2.2 m/s along the normal, or less than 35% clean, is a **glancing** blow and does
nothing. Otherwise `damage ∝ (vn − 2.2)^1.3 × part × weapon × cleanliness × stamina`.
Head hits are worth 1.6×, body 1.0×, arms ~0.3× (so a guard absorbs punches physically, not by
a rule), and leg kicks to the thigh are full value. A solid head shot staggers; a big one stuns;
a very big one can be a flash KO. Health at zero is a KO and the fighter goes fully limp.

## Project layout

```
index.html        HUD markup and styling
src/main.js       boot, game loop, camera, hit feedback, round logic
src/physics.js    Rapier world, floor and octagon colliders, collision groups
src/fighter.js    ragdoll construction, PD pose controller, balance, strikes, hit detection
src/poses.js      stance / guard poses and every strike's keyframes  <-- tune feel here
src/ai.js         opponent AI
src/input.js      keyboard and mouse
src/arena.js      lights, mat, cage visuals
src/hud.js        bars, popups, overlay
src/audio.js      procedural hit sounds
```

### Tuning the feel

* `poses.js` — keyframes are Euler angles (degrees) in the parent limb's frame; `active` is the
  damage window in seconds; `speed` multiplies how violently the joint controllers chase the
  keyframe (faster = harder but less controlled).
* `fighter.js` — `w0` on each segment is that joint's muscle stiffness (natural frequency),
  `ZETA` its damping, `HOVER_HEIGHT` / `HOVER_FRACTION` the stance height and how much weight the
  legs carry, `ROOT_INERTIA` how hard the hips turn, `MOVE_SPEED`, `VMIN` (minimum impact speed)
  and `PART_MULT` all live at the top.
* The damage readout (`F3`) and `?ai=2` are the quickest way to see what a change did.
* `ai.js` — `aggression` and `reaction` time.

Built with [three.js](https://threejs.org) and [Rapier](https://rapier.rs).
