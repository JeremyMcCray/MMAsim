import * as THREE from 'three';
import { createPhysics, makeFloor, PHYS_DT } from './physics.js';
import { Fighter } from './fighter.js';
import { AI } from './ai.js';
import { Input } from './input.js';
import { buildArena } from './arena.js';
import { HUD } from './hud.js';
import { Sfx } from './audio.js';

const params = new URLSearchParams(location.search);
const AI_VS_AI = params.get('ai') === '2';
const HEADLESS = params.get('headless') === '1';
const ROUND_SECONDS = 180;
const CAGE_RADIUS = 4.2;

async function boot() {
  const { RAPIER, world } = await createPhysics();
  const { walls, sideLen } = makeFloor(RAPIER, world, CAGE_RADIUS);

  // renderer
  const renderer = new THREE.WebGLRenderer({ antialias: !HEADLESS, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = !HEADLESS;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  document.getElementById('app').appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  buildArena(scene, CAGE_RADIUS, walls, sideLen);

  // fighters
  const spawnL = new THREE.Vector3(0, 1.02, -1.1), spawnR = new THREE.Vector3(0, 1.02, 1.1);
  const player = new Fighter({ RAPIER, world, scene, index: 0, position: spawnL, yaw: 0, color: 0xd93a3f, skin: 0xc8956a, name: AI_VS_AI ? 'Red' : 'You' });
  const enemy = new Fighter({ RAPIER, world, scene, index: 1, position: spawnR, yaw: Math.PI, color: 0x3b7cf0, skin: 0x8a5a3c, name: 'Opponent' });
  player.setOpponent(enemy);
  enemy.setOpponent(player);

  const input = new Input(renderer.domElement);
  const ais = [new AI(enemy, { aggression: 0.55, reaction: 0.16 })];
  if (AI_VS_AI) ais.push(new AI(player, { aggression: 0.6, reaction: 0.14 }));
  const hud = new HUD();
  hud.setNames(player.name, enemy.name);
  const sfx = new Sfx();

  // game state
  let running = false, timeLeft = ROUND_SECONDS, over = false, timeScale = 1, slowmoT = 0;
  let shake = 0;
  const stats = { hits: [], steps: 0 };
  window.__mma = { player, enemy, stats, world }; window.THREE = THREE;

  const overlay = document.getElementById('overlay');
  const start = () => { if (!running) { running = true; hud.showOverlay(false); sfx.ensure(); sfx.bell(); } };
  overlay.addEventListener('click', start);
  window.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  if (AI_VS_AI || HEADLESS) start();

  function resetFight() {
    player.reset(spawnL, 0);
    enemy.reset(spawnR, Math.PI);
    timeLeft = ROUND_SECONDS; over = false; timeScale = 1; slowmoT = 0;
    stats.hits.length = 0;
    hud.setOverlayText('MMA PHYSICS', 'Fighters are active ragdolls. Strikes only hurt when they land clean, fast and square.', 'Glancing blows do nothing. Guarded hits do little. Head shots stagger. Enough of them end it.');
    running = true; hud.showOverlay(false); sfx.bell();
  }

  function endFight(text, sub) {
    over = true;
    hud.center(text, 'ko');
    setTimeout(() => {
      hud.setOverlayText(text, sub, 'Press R or click to fight again.');
      hud.showOverlay(true);
      running = false;
    }, 2600);
  }

  function onHit(ev) {
    const pos = ev.point.clone(); pos.y += 0.15;
    stats.hits.push({ s: ev.striker.name, strike: ev.strike, part: ev.part, vn: +ev.vn.toFixed(2), speed: +ev.speed.toFixed(2), clean: +ev.clean.toFixed(2), dmg: +ev.dmg.toFixed(1), kind: ev.kind });
    if (ev.kind === 'glance') { hud.popup(pos, 'glancing', 'glance', camera); return; }
    const label = ev.kind === 'block' ? `blocked ${ev.dmg.toFixed(0)}`
      : ev.kind === 'head' ? (ev.dmg > 22 ? `CLEAN! ${ev.dmg.toFixed(0)}` : `head ${ev.dmg.toFixed(0)}`)
      : ev.kind === 'leg' ? `leg ${ev.dmg.toFixed(0)}` : `body ${ev.dmg.toFixed(0)}`;
    hud.popup(pos, label, ev.kind, camera);
    sfx.hit(ev.dmg, ev.kind);
    shake = Math.min(0.5, shake + ev.dmg * 0.012);
    if (ev.kind === 'head' && ev.dmg > 14) hud.flash(Math.min(0.35, ev.dmg / 90));
    if (ev.dmg > 24) { slowmoT = 0.35; timeScale = 0.35; }
    if (ev.ko) {
      slowmoT = 2.2; timeScale = 0.22;
      hud.flash(0.6);
      const winner = ev.striker.name, loser = ev.target.name;
      endFight('KO!', `${winner} knocks out ${loser} with a ${ev.strike} to the ${ev.part}.`);
    }
  }

  // camera
  const camPos = new THREE.Vector3(0, 2.2, -4.5), camLook = new THREE.Vector3(0, 1.1, 0);
  function updateCamera(dt) {
    const a = player.position(), b = enemy.position();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a); dir.y = 0;
    const dist = Math.max(0.5, dir.length());
    dir.normalize();
    const side = new THREE.Vector3(dir.z, 0, -dir.x);
    // behind-and-over the player's right shoulder, pulling back as the fighters separate
    const want = a.clone().sub(dir.clone().multiplyScalar(2.6 + dist * 0.35)).add(side.multiplyScalar(0.9)).add(new THREE.Vector3(0, 1.75 + dist * 0.1, 0));
    // clamp to at most 1.5 m outside the cage
    const r = Math.hypot(want.x, want.z);
    if (r > CAGE_RADIUS + 1.5) { want.x *= (CAGE_RADIUS + 1.5) / r; want.z *= (CAGE_RADIUS + 1.5) / r; }
    const look = mid.clone(); look.y = 1.15;
    const k = 1 - Math.exp(-dt * 5);
    camPos.lerp(want, k);
    camLook.lerp(look, k * 1.4);
    camera.position.copy(camPos);
    if (shake > 0) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.25;
      camera.position.y += (Math.random() - 0.5) * shake * 0.25;
      shake = Math.max(0, shake - dt * 2.2);
    }
    camera.lookAt(camLook);
  }

  function physicsStep() {
    for (const ai of ais) ai.update(PHYS_DT);
    if (!over) timeLeft -= PHYS_DT;
    player.update(PHYS_DT);
    enemy.update(PHYS_DT);
    player.recordVelocities();
    enemy.recordVelocities();
    world.step();
    stats.steps++;
    const h1 = player.checkHits();
    const h2 = enemy.checkHits();
    if (h1) onHit(h1);
    if (h2) onHit(h2);
  }
  // synchronous simulation for automated testing
  window.__mma.step = physicsStep;
  window.__mma.simulate = (seconds) => {
    const n = Math.round(seconds / PHYS_DT);
    for (let i = 0; i < n && !over; i++) physicsStep();
    player.syncMeshes(); enemy.syncMeshes();
  };

  // main loop
  let acc = 0, last = performance.now();
  let fps = 0, fpsAcc = 0, fpsN = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

    const act = input.apply(player);
    if (act.restart) resetFight();
    if (act.debug) hud.toggleDebug();

    if (running) {
      if (slowmoT > 0) { slowmoT -= dt; if (slowmoT <= 0) timeScale = 1; }
      acc += dt * timeScale;
      let steps = 0;
      while (acc >= PHYS_DT && steps < 12) {
        physicsStep();
        acc -= PHYS_DT; steps++;
      }
      if (!over && timeLeft <= 0) {
        const w = player.health === enemy.health ? 'DRAW' : player.health > enemy.health ? `${player.name.toUpperCase()} WINS` : `${enemy.name.toUpperCase()} WINS`;
        endFight(w, 'Time. Decision goes to the fighter with more health left.');
        sfx.bell();
      }
    }

    player.syncMeshes();
    enemy.syncMeshes();
    updateCamera(dt);
    hud.update(player, enemy, timeLeft, null);
    hud.debug(`fps ${fps.toFixed(0)}  steps ${stats.steps}\nP: ${player.state} hp ${player.health.toFixed(0)} st ${player.stamina.toFixed(0)} strike ${player.strike?.name || '-'}\nE: ${enemy.state} hp ${enemy.health.toFixed(0)} st ${enemy.stamina.toFixed(0)} strike ${enemy.strike?.name || '-'}\nhits ${stats.hits.length} last ${JSON.stringify(stats.hits[stats.hits.length - 1] || {})}`);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('overlay').innerHTML = `<h1>Failed to start</h1><p>${e.message}</p>`;
});
