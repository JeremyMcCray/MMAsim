// Strike tracking probe: throws one strike with no opponent in range and prints, every 2 sim ticks, where the
// weapon actually is (pelvis-relative, facing frame: x left, y up, z forward) next to where the keyframe
// pose being chased would put it (forward kinematics). Shows lag, overshoot and whether a pose is reachable.
//   node tools/track.js [strike=rh_overhand] [tf=1]
const RAPIER = require('./rapier.js');
const P = require('../js/physics.js');
const key = process.argv[2] || 'rh_overhand', tf = parseFloat(process.argv[3] || '1');
(async () => {
  await P.init(RAPIER);
  const d = P.STRIKES[key]; if (!d) { console.log('unknown strike', key, Object.keys(P.STRIKES).join(' ')); return; }
  const w = new P.World({ rand: () => 0.5, positions: [[0, 0], [0, 3.0]] });
  const a = w.fighters[0];
  for (let i = 0; i < 60; i++) w.step();
  a.startStrike(d, tf);
  const wname = d.weapon, segName = wname.replace('Fist', 'Forearm').replace('Foot', 'Shin').replace('Knee', 'Shin');
  const ex = P.SEGS[segName].extra;
  const rel = (p, pel, yaw) => { const dx = p.x - pel.x, dz = p.z - pel.z, c = Math.cos(yaw), s = Math.sin(yaw); return [dx * c - dz * s, p.y - pel.y, dx * s + dz * c]; };
  const f3 = (v) => v.map(x => (x >= 0 ? ' ' : '') + x.toFixed(2)).join(' ');
  console.log(key, 'dur', d.dur, 'active', d.active, 'frames at', d.frames.map(f => f.t).join(','));
  console.log('   t    actual weapon (x y z)   | intended (x y z)   | err   speed');
  let prev = null, maxV = 0, maxErr = 0;
  for (let i = 0; i < 70 && a.strike; i++) {
    const hits = w.step();
    const tt = a.strike ? a.strike.t / tf : d.dur;
    const pel = a.bodies.pelvis.translation(), yaw = a.yaw;
    const b = a.bodies[segName], bp = b.translation(), bq = b.rotation();
    const wp = P.math.vAdd(bp, P.math.qRot({ x: bq.x, y: bq.y, z: bq.z, w: bq.w }, { x: ex.pos[0], y: ex.pos[1], z: ex.pos[2] }));
    const act = rel(wp, pel, -yaw);
    // intended: interpolate the keyframes the way the controller does and run FK
    const fr = d.frames; let k = 0; while (k < fr.length - 2 && tt >= fr[k + 1].t) k++;
    const s = Math.max(0, Math.min(1, (tt - fr[k].t) / (fr[k + 1].t - fr[k].t)));
    const pose = P.resolveFrame ? null : null;
    const p0 = P.resolveFrameExport(d, fr[k], P.POSES.STANCE), p1 = P.resolveFrameExport(d, fr[k + 1], P.POSES.STANCE);
    const mix = { pelvisYaw: p0.pelvisYaw + (p1.pelvisYaw - p0.pelvisYaw) * s, lift: 0 };
    for (const j of P.JOINTS) mix[j] = p0[j].map((v, q) => v + (p1[j][q] - v) * s);
    const fkp = P.fk(mix, 0); const intended = fkp.w[wname]; const want = [intended.x, intended.y - P.HOVER_HEIGHT, intended.z];
    const err = Math.hypot(act[0] - want[0], act[1] - want[1], act[2] - want[2]); maxErr = Math.max(maxErr, err);
    let v = 0; if (prev) { v = Math.hypot(act[0] - prev[0], act[1] - prev[1], act[2] - prev[2]) * 60; maxV = Math.max(maxV, v); }
    prev = act;
    if (i % 2 === 0) console.log(tt.toFixed(2).padStart(5), ' ', f3(act), '  | ', f3(want), '  |', err.toFixed(2), ' ', v.toFixed(1), tt >= d.active[0] && tt <= d.active[1] ? ' <active>' : '');
  }
  console.log('max weapon speed', maxV.toFixed(1), 'm/s; max tracking error', maxErr.toFixed(2), 'm');
  w.free();
})();
