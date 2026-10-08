import * as THREE from 'three';
import { STANCE, GUARD, LIMP, STRIKES, STRIKE_DURATION } from './poses.js';
import { groups, GROUP_FIGHTER, GROUP_WORLD } from './physics.js';

const DEG = Math.PI / 180;
const ZETA = 1.0; // damping ratio of every joint controller

// Body segments. shape: ['capsule', halfHeight, radius] | ['ball', r] | ['cuboid', hx, hy, hz]
// anchorParent / anchorSelf: joint anchor in the parent's / this segment's local frame.
// w0: natural frequency (rad/s) of the joint motor that drives this segment toward its target pose
//     (the spring constant is w0^2 times the inertia of everything hanging off that joint).
const SEGS = {
  pelvis:    { parent: null,        shape: ['cuboid', 0.16, 0.09, 0.11], mass: 11, w0: 24, part: 'pelvis' },
  chest:     { parent: 'pelvis',    shape: ['cuboid', 0.19, 0.20, 0.12], mass: 20, w0: 48, part: 'chest',
               anchorParent: [0, 0.12, 0], anchorSelf: [0, -0.22, 0] },
  head:      { parent: 'chest',     shape: ['ball', 0.12], mass: 5, w0: 44, part: 'head',
               anchorParent: [0, 0.24, 0], anchorSelf: [0, -0.15, 0] },
  lUpperArm: { parent: 'chest',     shape: ['capsule', 0.12, 0.05], mass: 2.5, w0: 52, part: 'upperArm',
               anchorParent: [-0.23, 0.17, 0], anchorSelf: [0, 0.14, 0] },
  lForearm:  { parent: 'lUpperArm', shape: ['capsule', 0.12, 0.045], mass: 2.0, w0: 60, part: 'forearm',
               anchorParent: [0, -0.14, 0], anchorSelf: [0, 0.14, 0],
               extra: { name: 'lFist', shape: ['ball', 0.062], pos: [0, -0.18, 0], mass: 0.5, part: 'fist' } },
  rUpperArm: { parent: 'chest',     shape: ['capsule', 0.12, 0.05], mass: 2.5, w0: 52, part: 'upperArm',
               anchorParent: [0.23, 0.17, 0], anchorSelf: [0, 0.14, 0] },
  rForearm:  { parent: 'rUpperArm', shape: ['capsule', 0.12, 0.045], mass: 2.0, w0: 60, part: 'forearm',
               anchorParent: [0, -0.14, 0], anchorSelf: [0, 0.14, 0],
               extra: { name: 'rFist', shape: ['ball', 0.062], pos: [0, -0.18, 0], mass: 0.5, part: 'fist' } },
  lThigh:    { parent: 'pelvis',    shape: ['capsule', 0.18, 0.075], mass: 8, w0: 42, part: 'thigh',
               anchorParent: [-0.10, -0.08, 0], anchorSelf: [0, 0.21, 0] },
  lShin:     { parent: 'lThigh',    shape: ['capsule', 0.18, 0.055], mass: 4, w0: 50, part: 'shin',
               anchorParent: [0, -0.21, 0], anchorSelf: [0, 0.21, 0],
               extra: { name: 'lFoot', shape: ['cuboid', 0.05, 0.035, 0.11], pos: [0, -0.22, 0.05], mass: 1, part: 'foot' } },
  rThigh:    { parent: 'pelvis',    shape: ['capsule', 0.18, 0.075], mass: 8, w0: 42, part: 'thigh',
               anchorParent: [0.10, -0.08, 0], anchorSelf: [0, 0.21, 0] },
  rShin:     { parent: 'rThigh',    shape: ['capsule', 0.18, 0.055], mass: 4, w0: 50, part: 'shin',
               anchorParent: [0, -0.21, 0], anchorSelf: [0, 0.21, 0],
               extra: { name: 'rFoot', shape: ['cuboid', 0.05, 0.035, 0.11], pos: [0, -0.22, 0.05], mass: 1, part: 'foot' } },
};
const SEG_ORDER = ['pelvis', 'chest', 'head', 'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm', 'lThigh', 'lShin', 'rThigh', 'rShin'];

// Where a strike hurts. Legs take more from kicks, limbs absorb punches.
const PART_MULT = {
  head: 1.6, chest: 1.0, pelvis: 0.8, upperArm: 0.35, forearm: 0.3, fist: 0.25,
  thigh: 0.55, shin: 0.3, foot: 0.2,
};
const KICK_PART_MULT = { thigh: 1.0, shin: 0.5, pelvis: 1.0 };

export const HOVER_HEIGHT = 0.95;
const HOVER_FRACTION = 0.7;
// Effective inertia the hip controller works against (the whole body turns with the hips).
const ROOT_INERTIA = 3.0;
const MOVE_SPEED = 1.9;
const VMIN = 2.2; // m/s along the contact normal below which a touch is just a touch

const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpV3 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpM = new THREE.Matrix3(), tmpM2 = new THREE.Matrix3();

function eulerQuat(e, out = new THREE.Quaternion()) {
  tmpE.set(e[0] * DEG, e[1] * DEG, e[2] * DEG, 'XYZ');
  return out.setFromEuler(tmpE);
}
const smooth = (s) => s * s * (3 - 2 * s);

export class Fighter {
  constructor({ RAPIER, world, scene, index, position, yaw, color, skin, name }) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.scene = scene;
    this.index = index;
    this.name = name;
    this.color = color;
    this.spawn = { position: position.clone(), yaw };
    this.yaw = yaw;
    this.opponent = null;

    this.health = 100;
    this.stamina = 100;
    this.state = 'fight';   // fight | stunned | ko
    this.stunT = 0;
    this.staggerT = 0;
    this.gainMult = 1;
    this.strike = null;
    this.guard = false;
    this.move = new THREE.Vector2();
    this.walkPhase = 0;
    this.dashCd = 0;
    this.lastStrikeAt = -10;
    this.events = [];
    this.hitsLanded = 0;
    this.hitsTaken = 0;

    this.bodies = {};
    this.joints = {};
    this.colliders = {};  // name -> { collider, part, seg }
    this.partColliders = []; // list of hittable colliders
    this.inertia = {};
    this.preVel = {};
    this.meshes = {};
    this.group = new THREE.Group();
    scene.add(this.group);

    this.#build(skin);
  }

  setOpponent(f) { this.opponent = f; }

  get totalMass() { return this._totalMass; }

  // ---------------------------------------------------------------- build
  #build(skin) {
    const { RAPIER, world } = this;
    const member = GROUP_FIGHTER[this.index];
    const filter = GROUP_FIGHTER[1 - this.index] | GROUP_WORLD;
    const cg = groups(member, filter);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const pos = {};
    pos.pelvis = this.spawn.position.clone();
    this._totalMass = 0;
    this._massLower = 0;

    const matTeam = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.6 });
    const matSkin = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.75 });
    const matGlove = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.4, metalness: 0.05 });
    const matDark = new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.9 });

    for (const name of SEG_ORDER) {
      const seg = SEGS[name];
      if (seg.parent) {
        const ap = new THREE.Vector3(...seg.anchorParent).applyQuaternion(q);
        const as = new THREE.Vector3(...seg.anchorSelf).applyQuaternion(q);
        pos[name] = pos[seg.parent].clone().add(ap).sub(as);
      }
      const p = pos[name];
      const rbDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0.2)
        .setAngularDamping(0.5)
        .setCcdEnabled(true);
      const body = world.createRigidBody(rbDesc);
      this.bodies[name] = body;

      const mkDesc = (shape, mass, offset, friction) => {
        let d;
        if (shape[0] === 'capsule') d = RAPIER.ColliderDesc.capsule(shape[1], shape[2]);
        else if (shape[0] === 'ball') d = RAPIER.ColliderDesc.ball(shape[1]);
        else d = RAPIER.ColliderDesc.cuboid(shape[1], shape[2], shape[3]);
        d.setMass(mass).setFriction(friction).setRestitution(0.05);
        if (offset) d.setTranslation(offset[0], offset[1], offset[2]);
        return d;
      };
      const friction = seg.part === 'shin' ? 0.3 : 0.5;
      const col = world.createCollider(mkDesc(seg.shape, seg.mass, null, friction), body);
      col.setCollisionGroups(cg);
      this.colliders[name] = { collider: col, part: seg.part, seg: name, owner: this };
      this.partColliders.push(this.colliders[name]);
      this._totalMass += seg.mass;
      if (['pelvis', 'thigh', 'shin', 'foot'].includes(seg.part)) this._massLower += seg.mass + (seg.extra ? seg.extra.mass : 0);
      if (seg.extra) {
        const ex = seg.extra;
        const ecol = world.createCollider(mkDesc(ex.shape, ex.mass, ex.pos, ex.part === 'foot' ? 0.15 : 0.5), body);
        ecol.setCollisionGroups(cg);
        this.colliders[ex.name] = { collider: ecol, part: ex.part, seg: name, owner: this };
        this.partColliders.push(this.colliders[ex.name]);
        this._totalMass += ex.mass;
      }

      // joint to parent
      if (seg.parent) {
        const jd = RAPIER.JointData.spherical(
          { x: seg.anchorParent[0], y: seg.anchorParent[1], z: seg.anchorParent[2] },
          { x: seg.anchorSelf[0], y: seg.anchorSelf[1], z: seg.anchorSelf[2] }
        );
        const joint = world.createImpulseJoint(jd, this.bodies[seg.parent], body, true);
        this.joints[name] = joint;
        // Joint motors (solved implicitly by the constraint solver => stable at any stiffness).
        for (const ax of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
          RAPIER.SphericalImpulseJoint.prototype.configureMotorModel.call(joint, ax, RAPIER.MotorModel.ForceBased);
        }
      }

      // principal inertia (body frame ~ principal frame for these symmetric shapes)
      const pi = body.principalInertia();
      this.inertia[name] = new THREE.Vector3(pi.x, pi.y, pi.z);
      this.preVel[name] = { lin: new THREE.Vector3(), ang: new THREE.Vector3(), pos: new THREE.Vector3() };

      // --- visuals
      const g = new THREE.Group();
      const addMesh = (geo, mat, offset) => {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true; m.receiveShadow = true;
        if (offset) m.position.set(...offset);
        g.add(m);
        return m;
      };
      const sh = seg.shape;
      if (name === 'pelvis') {
        addMesh(new THREE.BoxGeometry(sh[1] * 2, sh[2] * 2, sh[3] * 2, 1, 1, 1), matTeam);
      } else if (name === 'chest') {
        addMesh(new THREE.BoxGeometry(sh[1] * 2, sh[2] * 2, sh[3] * 2), matSkin);
        addMesh(new THREE.BoxGeometry(sh[1] * 2 + 0.02, 0.1, sh[3] * 2 + 0.02), matTeam, [0, -0.17, 0]);
      } else if (name === 'head') {
        addMesh(new THREE.SphereGeometry(sh[1], 20, 16), matSkin);
        addMesh(new THREE.SphereGeometry(sh[1] * 0.98, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), matDark);
        // eyes so you can read which way the head faces
        addMesh(new THREE.SphereGeometry(0.018, 8, 8), matDark, [-0.045, 0.02, 0.105]);
        addMesh(new THREE.SphereGeometry(0.018, 8, 8), matDark, [0.045, 0.02, 0.105]);
      } else if (sh[0] === 'capsule') {
        const isThigh = seg.part === 'thigh';
        addMesh(new THREE.CapsuleGeometry(sh[2], sh[1] * 2, 4, 12), isThigh ? matTeam : matSkin);
      }
      if (seg.extra) {
        const ex = seg.extra;
        if (ex.shape[0] === 'ball') addMesh(new THREE.SphereGeometry(ex.shape[1], 14, 12), matGlove, ex.pos);
        else addMesh(new THREE.BoxGeometry(ex.shape[1] * 2, ex.shape[2] * 2, ex.shape[3] * 2), matDark, ex.pos);
      }
      this.group.add(g);
      this.meshes[name] = g;
    }
    // Subtree inertia about each joint (rest pose): the motor spring constant is scaled by it so
    // every joint behaves like the same "muscle" regardless of how much it has to carry.
    this.jointInertia = {};
    const descendants = (n) => SEG_ORDER.filter((c) => { let x = c; while (x) { if (x === n) return true; x = SEGS[x].parent; } return false; });
    for (const name of SEG_ORDER) {
      if (!SEGS[name].parent) continue;
      const seg = SEGS[name];
      const jw = pos[seg.parent].clone().add(new THREE.Vector3(...seg.anchorParent).applyQuaternion(q));
      let I = 0;
      for (const d of descendants(name)) {
        const sd = SEGS[d];
        const m = sd.mass + (sd.extra ? sd.extra.mass : 0);
        const own = this.inertia[d];
        I += m * pos[d].distanceToSquared(jw) + (own.x + own.y + own.z) / 3;
      }
      this.jointInertia[name] = I;
    }
    this.syncMeshes();
  }

  // ---------------------------------------------------------------- control API
  canAct() { return this.state === 'fight' && this.staggerT <= 0; }

  setMove(x, z) { this.move.set(x, z); }
  setGuard(on) { this.guard = !!on; }

  startStrike(name) {
    if (!this.canAct()) return false;
    const def = STRIKES[name];
    if (!def) return false;
    if (this.strike && this.strike.t < STRIKE_DURATION[this.strike.name] * 0.62) return false;
    if (this.stamina < 4) return false;
    this.strike = { name, def, t: 0, hit: false, glanced: false, speedMult: this.#staminaSpeed() };
    this.stamina = Math.max(0, this.stamina - def.cost);
    this.lastStrikeAt = 0;
    return true;
  }

  dash(dirX, dirZ) {
    if (!this.canAct() || this.dashCd > 0 || this.stamina < 15) return false;
    let d = new THREE.Vector3(dirX, 0, dirZ);
    if (d.lengthSq() < 0.01) d.set(0, 0, -1);
    d.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).multiplyScalar(3.4);
    for (const n of SEG_ORDER) {
      const b = this.bodies[n];
      const v = b.linvel();
      b.setLinvel({ x: v.x + d.x, y: v.y + d.y, z: v.z + d.z }, true);
    }
    this.stamina -= 15;
    this.dashCd = 0.65;
    return true;
  }

  #staminaSpeed() {
    const s = this.stamina / 100;
    return 0.72 + 0.28 * Math.min(1, s / 0.35);
  }

  // ---------------------------------------------------------------- per-step update (before world.step)
  update(dt) {
    // timers
    if (this.state === 'stunned') {
      this.stunT -= dt;
      if (this.stunT <= 0) this.state = 'fight';
    }
    this.staggerT = Math.max(0, this.staggerT - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.lastStrikeAt += dt;
    if (this.strike) {
      this.strike.t += dt;
      if (this.strike.t >= STRIKE_DURATION[this.strike.name]) this.strike = null;
    }
    // stamina
    const regen = this.strike ? 2 : this.guard ? 5 : 11;
    this.stamina = Math.min(100, this.stamina + regen * dt);

    // target gain
    let gTarget = 1;
    if (this.state === 'ko') gTarget = 0.0;
    else if (this.state === 'stunned') gTarget = 0.45;
    else if (this.staggerT > 0) gTarget = 0.65;
    this.gainMult += (gTarget - this.gainMult) * Math.min(1, dt * (gTarget < this.gainMult ? 40 : 8));

    // facing
    if (this.opponent && this.state === 'fight') {
      const a = this.bodies.pelvis.translation();
      const b = this.opponent.bodies.pelvis.translation();
      const want = Math.atan2(b.x - a.x, b.z - a.z);
      let d = want - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const maxTurn = 7 * dt;
      this.yaw += THREE.MathUtils.clamp(d, -maxTurn, maxTurn);
    }

    const pose = this.#computePose(dt);
    this.#applyControl(pose, dt);
  }

  #computePose(dt) {
    const base = this.state === 'ko' ? LIMP : (this.guard && !this.strike ? GUARD : STANCE);
    const st = this.strike;
    const out = { pelvisYaw: base.pelvisYaw, q: {}, speed: {}, zeta: {} };
    const inStrike = new Set(st ? st.def.keys : []);

    // walk cycle
    const moving = this.state === 'fight' && this.move.lengthSq() > 0.05;
    const spd = this.move.length();
    if (moving) this.walkPhase += dt * (5 + 5 * spd);
    const amp = moving ? Math.min(1, spd) * 26 : 0;
    const walk = {
      lThigh: [Math.sin(this.walkPhase) * amp, 0, 0],
      rThigh: [-Math.sin(this.walkPhase) * amp, 0, 0],
      lShin: [Math.max(0, Math.sin(this.walkPhase + 1.3)) * amp * 1.3, 0, 0],
      rShin: [Math.max(0, -Math.sin(this.walkPhase + 1.3)) * amp * 1.3, 0, 0],
    };

    for (const j of ['chest', 'head', 'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm', 'lThigh', 'lShin', 'rThigh', 'rShin']) {
      if (inStrike.has(j)) continue;
      const e = base[j];
      const w = walk[j];
      const ee = w ? [e[0] + w[0], e[1] + w[1], e[2] + w[2]] : e;
      out.q[j] = eulerQuat(ee);
      out.speed[j] = 1;
    }
    if (st) {
      const fr = st.def.frames;
      let i = 0;
      while (i < fr.length - 2 && st.t >= fr[i + 1].t) i++;
      const f0 = fr[i], f1 = fr[i + 1];
      const s = smooth(THREE.MathUtils.clamp((st.t - f0.t) / (f1.t - f0.t), 0, 1));
      for (const j of st.def.keys) {
        const v0 = f0[j] === 'stance' ? base[j] : f0[j];
        const v1 = f1[j] === 'stance' ? base[j] : f1[j];
        if (j === 'pelvisYaw') {
          out.pelvisYaw = v0 + (v1 - v0) * s;
          out.speed.pelvis = st.def.speed * st.speedMult;
        } else {
          const qa = eulerQuat(v0, new THREE.Quaternion());
          const qb = eulerQuat(v1, tmpQ2);
          out.q[j] = qa.slerp(qb, s);
          out.speed[j] = st.def.speed * st.speedMult;
          // under-damped while the blow is travelling so the limb whips through instead of easing in
          out.zeta[j] = st.t < st.def.active[1] ? 0.5 : 1.0;
        }
      }
    }
    return out;
  }

  #applyControl(pose, dt) {
    const RAPIER = this.RAPIER;
    const yaw = this.yaw + pose.pelvisYaw * DEG;
    const qRoot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const g = this.gainMult;

    for (const name of SEG_ORDER) {
      const body = this.bodies[name];
      body.resetForces(true);
      body.resetTorques(true);
    }

    // --- joint motors: every segment is driven toward its target rotation relative to its parent.
    // Force-based: stiffness = I*w0^2*g, damping = 2*zeta*I*w0 (I = jointInertia, g = gainMult).
    // The motor pushes back on the parent, so a punch loads the shoulder, spine and hips.
    for (const name of SEG_ORDER) {
      if (name === 'pelvis') continue;
      const seg = SEGS[name];
      const joint = this.joints[name];
      const q = pose.q[name];
      // quaternion -> rotation vector
      let qw = q.w, qx = q.x, qy = q.y, qz = q.z;
      if (qw < 0) { qw = -qw; qx = -qx; qy = -qy; qz = -qz; }
      const half = Math.acos(THREE.MathUtils.clamp(qw, -1, 1));
      const sh = Math.sin(half);
      const k = sh > 1e-6 ? (2 * half) / sh : 2;
      const rv = [qx * k, qy * k, qz * k];
      const w0 = seg.w0 * (pose.speed[name] || 1);
      const I = this.jointInertia[name];
      const stiff = I * w0 * w0 * g;
      const damp = 2 * ZETA * (pose.zeta[name] || 1) * I * w0 * (0.25 + 0.75 * g);
      const axes = [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ];
      for (let i = 0; i < 3; i++) {
        RAPIER.SphericalImpulseJoint.prototype.configureMotorPosition.call(joint, axes[i], rv[i], stiff, damp);
      }
    }

    // --- root: explicit PD holds the pelvis to the facing yaw and upright (the only world-frame controller)
    if (g > 0.01) {
      const body = this.bodies.pelvis;
      const r = body.rotation();
      const qCur = tmpQ.set(r.x, r.y, r.z, r.w);
      const qErr = tmpQ2.copy(qRoot).multiply(qCur.clone().invert());
      if (qErr.w < 0) { qErr.x = -qErr.x; qErr.y = -qErr.y; qErr.z = -qErr.z; qErr.w = -qErr.w; }
      const half = Math.acos(THREE.MathUtils.clamp(qErr.w, -1, 1));
      const sh = Math.sin(half);
      const axisErr = tmpV.set(qErr.x, qErr.y, qErr.z);
      if (sh > 1e-5) axisErr.multiplyScalar((2 * half) / sh); else axisErr.set(0, 0, 0);
      const w = body.angvel();
      const wAbs = tmpV2.set(w.x, w.y, w.z);
      const w0 = SEGS.pelvis.w0 * (pose.speed.pelvis || 1);
      const alpha = axisErr.multiplyScalar(w0 * w0).sub(wAbs.multiplyScalar(2 * ZETA * w0));
      // modest effective inertia: the joint motors drag the rest of the chain along
      const Ieff = ROOT_INERTIA;
      const torque = alpha.multiplyScalar(Ieff * g);
      const maxT = Ieff * w0 * w0 * 2.5;
      const tl = torque.length();
      if (tl > maxT) torque.multiplyScalar(maxT / tl);
      body.addTorque({ x: torque.x, y: torque.y, z: torque.z }, true);
    }

    // ------------------------------------------------ balance / locomotion (pelvis)
    if (this.state !== 'ko') {
      const pelvis = this.bodies.pelvis;
      const p = pelvis.translation();
      const v = pelvis.linvel();
      const M = this._totalMass;
      const hTarget = HOVER_HEIGHT - (this.guard ? 0.03 : 0) - (this.state === 'stunned' ? 0.12 : 0);
      const kH = 110, cH = 19;
      // The hover carries most of the weight; the legs (stiff struts on the ground) carry the rest,
      // so the feet are planted and the body dips when a leg leaves the floor.
      let fy = M * (9.81 * HOVER_FRACTION + kH * (hTarget - p.y) - cH * v.y) * Math.max(0.35, g);
      fy = THREE.MathUtils.clamp(fy, -M * 6, M * 40);

      let vdes = new THREE.Vector3();
      if (this.state === 'fight' && this.staggerT <= 0) {
        const ms = this.strike ? MOVE_SPEED * 0.7 : this.guard ? MOVE_SPEED * 0.6 : MOVE_SPEED;
        const m = this.move.clone();
        if (m.length() > 1) m.normalize();
        vdes.set(m.x * ms, 0, m.y * ms * (m.y < 0 ? 0.8 : 1));
        vdes.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
      }
      const kv = 9 * Math.max(0.25, g);
      let fx = M * kv * (vdes.x - v.x);
      let fz = M * kv * (vdes.z - v.z);
      const fh = Math.hypot(fx, fz);
      const maxH = M * 22;
      if (fh > maxH) { fx *= maxH / fh; fz *= maxH / fh; }
      pelvis.addForce({ x: fx, y: fy, z: fz }, true);
      // a little of the same damping on the chest keeps the torso from whipping
      const cv = this.bodies.chest.linvel();
      this.bodies.chest.addForce({ x: M * 1.5 * (vdes.x - cv.x), y: 0, z: M * 1.5 * (vdes.z - cv.z) }, true);
    }
  }

  // ---------------------------------------------------------------- hits
  recordVelocities() {
    for (const name of SEG_ORDER) {
      const b = this.bodies[name];
      const l = b.linvel(), a = b.angvel(), p = b.translation();
      const pv = this.preVel[name];
      pv.lin.set(l.x, l.y, l.z); pv.ang.set(a.x, a.y, a.z); pv.pos.set(p.x, p.y, p.z);
    }
  }

  #velAt(name, point) {
    const pv = this.preVel[name];
    return tmpV3.copy(point).sub(pv.pos).cross(pv.ang).negate().add(pv.lin).clone();
  }

  // called after world.step()
  checkHits() {
    const st = this.strike;
    if (!st || st.hit || !this.opponent) return null;
    if (st.t < st.def.active[0] || st.t > st.def.active[1]) return null;
    const weapon = this.colliders[st.def.weapon];
    const opp = this.opponent;
    let result = null;
    for (const pc of opp.partColliders) {
      if (result) break;
      this.world.contactPair(weapon.collider, pc.collider, (manifold, flipped) => {
        if (result || manifold.numContacts() === 0) return;
        const n0 = manifold.normal();
        const n = new THREE.Vector3(n0.x, n0.y, n0.z);
        if (flipped) n.negate();
        // sanity: normal should point from weapon toward the opponent part
        const wp = weapon.collider.translation(), tp = pc.collider.translation();
        const dir = new THREE.Vector3(tp.x - wp.x, tp.y - wp.y, tp.z - wp.z);
        if (dir.dot(n) < 0) n.negate();
        let point;
        if (manifold.numSolverContacts() > 0) {
          const sp = manifold.solverContactPoint(0);
          point = new THREE.Vector3(sp.x, sp.y, sp.z);
        } else {
          point = new THREE.Vector3(wp.x, wp.y, wp.z);
        }
        const vW = this.#velAt(weapon.seg, point);
        const vT = opp.#velAt(pc.seg, point);
        const vRel = vW.sub(vT);
        const vn = vRel.dot(n);
        const speed = vRel.length();
        if (vn < 1.0) return; // touching or pulling away, not a blow
        result = { part: pc, n, point, vn, speed, clean: speed > 0.01 ? vn / speed : 0 };
      });
    }
    if (!result) return null;

    const isKick = st.def.weapon.endsWith('Shin');
    const { part, n, point, vn, speed, clean } = result;
    const ev = { striker: this, target: opp, part: part.part, point, n, vn, speed, clean, strike: st.name, dmg: 0, kind: 'glance', ko: false };
    if (vn < VMIN || clean < 0.35) {
      // glancing: the strike is not spent (the limb may still drive through), report it once
      if (st.glanced) return null;
      st.glanced = true;
      ev.kind = 'glance';
      return ev;
    }
    st.hit = true;
    let mult = PART_MULT[part.part];
    if (isKick && KICK_PART_MULT[part.part]) mult = KICK_PART_MULT[part.part];
    const blocked = opp.guard && (part.part === 'forearm' || part.part === 'upperArm' || part.part === 'fist');
    if (blocked) mult = 0.18;
    const staminaMult = 0.6 + 0.4 * Math.min(1, this.stamina / 30);
    let dmg = 0.8 * Math.pow(vn - VMIN, 1.3) * mult * st.def.weaponMult * (0.65 + 0.35 * clean) * staminaMult;
    dmg = Math.min(dmg, 45);
    ev.dmg = dmg;
    ev.kind = blocked ? 'block' : (part.part === 'head' ? 'head' : (part.part === 'thigh' || part.part === 'shin' || part.part === 'foot') ? 'leg' : 'body');
    opp.takeHit(ev, part.seg);
    this.hitsLanded++;
    return ev;
  }

  takeHit(ev, seg) {
    if (this.state === 'ko') return;
    const { dmg, n, point } = ev;
    this.health = Math.max(0, this.health - dmg);
    this.hitsTaken++;
    if (ev.kind === 'block') this.stamina = Math.max(0, this.stamina - dmg * 0.6 - 3);
    // physical exaggeration: shove the part and the core
    const imp = 3 + dmg * 0.55;
    this.bodies[seg].applyImpulseAtPoint({ x: n.x * imp, y: n.y * imp * 0.4, z: n.z * imp }, point, true);
    const core = dmg * 0.9;
    this.bodies.pelvis.applyImpulse({ x: n.x * core, y: 0, z: n.z * core }, true);
    this.bodies.chest.applyImpulse({ x: n.x * core * 0.6, y: 0, z: n.z * core * 0.6 }, true);

    if (ev.kind !== 'block') {
      this.staggerT = Math.max(this.staggerT, Math.min(0.75, 0.08 + dmg * 0.022));
      this.strike = this.strike && dmg > 9 ? null : this.strike; // a solid hit interrupts
      if (ev.kind === 'head' && dmg >= 14) {
        this.state = 'stunned';
        this.stunT = Math.max(this.stunT, 0.7 + dmg * 0.035);
      }
    }
    const flashKo = ev.kind === 'head' && dmg >= 30 && Math.random() < (dmg - 30) / 25 + (1 - this.health / 100) * 0.5;
    if (this.health <= 0 || flashKo) {
      this.health = 0;
      this.state = 'ko';
      this.strike = null;
      ev.ko = true;
    }
  }

  // ---------------------------------------------------------------- misc
  syncMeshes() {
    for (const name of SEG_ORDER) {
      const b = this.bodies[name];
      const p = b.translation(), r = b.rotation();
      const m = this.meshes[name];
      m.position.set(p.x, p.y, p.z);
      m.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  headPosition() {
    const p = this.bodies.head.translation();
    return new THREE.Vector3(p.x, p.y, p.z);
  }
  position() {
    const p = this.bodies.pelvis.translation();
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  reset(position, yaw) {
    this.spawn = { position: position.clone(), yaw };
    this.yaw = yaw;
    this.health = 100; this.stamina = 100; this.state = 'fight';
    this.stunT = 0; this.staggerT = 0; this.gainMult = 1; this.strike = null; this.guard = false;
    this.move.set(0, 0); this.hitsLanded = 0; this.hitsTaken = 0;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const pos = { pelvis: position.clone() };
    for (const name of SEG_ORDER) {
      const seg = SEGS[name];
      if (seg.parent) {
        const ap = new THREE.Vector3(...seg.anchorParent).applyQuaternion(q);
        const as = new THREE.Vector3(...seg.anchorSelf).applyQuaternion(q);
        pos[name] = pos[seg.parent].clone().add(ap).sub(as);
      }
      const b = this.bodies[name];
      const p = pos[name];
      b.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.resetForces(true); b.resetTorques(true);
    }
    this.syncMeshes();
  }
}
