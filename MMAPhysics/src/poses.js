// Pose and strike definitions.
//
// Conventions (fighter local frame): +Z = toward the opponent, +Y = up, +X = fighter's right.
// Every limb hangs straight down (-Y) at identity. Euler angles are degrees in the parent
// segment's frame, order XYZ:
//   rotX negative  -> limb swings forward (+Z)      rotX positive -> backward
//   rotZ positive  -> limb swings toward +X (right side), negative -> toward -X
//   rotY           -> twist about the limb's own axis
// For the torso: rotY positive brings the LEFT shoulder forward (orthodox blading).

export const JOINTS = [
  'chest', 'head',
  'lUpperArm', 'lForearm', 'rUpperArm', 'rForearm',
  'lThigh', 'lShin', 'rThigh', 'rShin',
];

// Relaxed orthodox stance (lead = left). Shoulders bladed ~30 degrees, hands at the chin.
export const STANCE = {
  pelvisYaw: 14,
  chest: [4, 16, 0],
  head: [8, -14, 0],
  lUpperArm: [-62, 8, 24],
  lForearm: [-108, 0, 8],
  rUpperArm: [-45, -12, -32],
  rForearm: [-128, 0, -6],
  lThigh: [-22, 0, -4],
  lShin: [26, 0, 0],
  rThigh: [12, 0, 8],
  rShin: [6, 0, 0],
};

// Tight guard: forearms stacked in front of the face, chin down, body coiled.
export const GUARD = {
  pelvisYaw: 16,
  chest: [12, 18, 0],
  head: [16, -16, 0],
  lUpperArm: [-78, 12, 30],
  lForearm: [-132, 0, 24],
  rUpperArm: [-70, -14, -36],
  rForearm: [-138, 0, -22],
  lThigh: [-20, 0, -4],
  lShin: [30, 0, 0],
  rThigh: [10, 0, 8],
  rShin: [10, 0, 0],
};

// Fully limp / knocked-out target (gains are near zero anyway).
export const LIMP = {
  pelvisYaw: 0, chest: [0, 0, 0], head: [0, 0, 0],
  lUpperArm: [0, 0, 20], lForearm: [-20, 0, 0], rUpperArm: [0, 0, -20], rForearm: [-20, 0, 0],
  lThigh: [0, 0, 0], lShin: [10, 0, 0], rThigh: [0, 0, 0], rShin: [10, 0, 0],
};

// Strikes. Impact poses put the weapon on the opponent's centre line (~0.75 m in front of
// the hips for punches, ~0.9 m for kicks) with the hips and shoulders rotating into the blow.
// keys: joints it animates. Every keyframe must specify each of those joints (or 'stance').
// weapon: which collider deals damage. active: [t0, t1] window in which that weapon can score.
// speed: multiplier on the joint controllers' natural frequency while the strike plays.
const S = 'stance';
export const STRIKES = {
  jab: {
    keys: ['chest', 'head', 'lUpperArm', 'lForearm', 'pelvisYaw'],
    weapon: 'lFist', weaponMult: 1.0, active: [0.07, 0.23], cost: 6, speed: 1.1,
    frames: [
      { t: 0.00, pelvisYaw: S, chest: S, head: S, lUpperArm: S, lForearm: S },
      { t: 0.05, pelvisYaw: 18, chest: [6, 22, 0], head: [10, -20, 0], lUpperArm: [-74, 4, 10], lForearm: [-96, 0, 4] },
      { t: 0.12, pelvisYaw: 20, chest: [6, 25, 0], head: [10, -22, 0], lUpperArm: [-106, 0, -30], lForearm: [-8, 0, 0] },
      { t: 0.19, pelvisYaw: 20, chest: [6, 25, 0], head: [10, -22, 0], lUpperArm: [-106, 0, -30], lForearm: [-8, 0, 0] },
      { t: 0.34, pelvisYaw: S, chest: S, head: S, lUpperArm: S, lForearm: S },
    ],
  },
  cross: {
    keys: ['chest', 'head', 'rUpperArm', 'rForearm', 'lUpperArm', 'pelvisYaw'],
    weapon: 'rFist', weaponMult: 1.25, active: [0.10, 0.28], cost: 9, speed: 1.3,
    frames: [
      { t: 0.00, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S, lUpperArm: S },
      // hips and shoulders turn first, the arm stays chambered...
      { t: 0.08, pelvisYaw: -12, chest: [8, -22, 0], head: [12, 6, 0], rUpperArm: [-62, -12, -14], rForearm: [-118, 0, -6], lUpperArm: [-72, 10, 30] },
      // ...then the arm fires out along the line the shoulder is already travelling
      { t: 0.16, pelvisYaw: -18, chest: [8, -30, 0], head: [12, 10, 0], rUpperArm: [-106, 0, 29], rForearm: [-8, 0, 0], lUpperArm: [-72, 10, 30] },
      { t: 0.23, pelvisYaw: -18, chest: [8, -30, 0], head: [12, 10, 0], rUpperArm: [-106, 0, 29], rForearm: [-8, 0, 0], lUpperArm: [-72, 10, 30] },
      { t: 0.46, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S, lUpperArm: S },
    ],
  },
  // Hooks: the torso rotates INTO the punch (left hook turns the hips right and the fist sweeps
  // across the centre line from the outside), elbow stays bent.
  lhook: {
    keys: ['chest', 'head', 'lUpperArm', 'lForearm', 'pelvisYaw'],
    weapon: 'lFist', weaponMult: 1.35, active: [0.12, 0.31], cost: 10, speed: 1.25,
    frames: [
      { t: 0.00, pelvisYaw: S, chest: S, head: S, lUpperArm: S, lForearm: S },
      { t: 0.09, pelvisYaw: 6, chest: [6, 8, 0], head: [10, -6, 0], lUpperArm: [-70, 0, -50], lForearm: [-30, 0, 20] },
      { t: 0.22, pelvisYaw: 34, chest: [6, 42, 0], head: [10, -34, 0], lUpperArm: [-94, 0, -66], lForearm: [-20, 0, 40] },
      { t: 0.29, pelvisYaw: 34, chest: [6, 42, 0], head: [10, -34, 0], lUpperArm: [-94, 0, -66], lForearm: [-20, 0, 40] },
      { t: 0.52, pelvisYaw: S, chest: S, head: S, lUpperArm: S, lForearm: S },
    ],
  },
  rhook: {
    keys: ['chest', 'head', 'rUpperArm', 'rForearm', 'pelvisYaw'],
    weapon: 'rFist', weaponMult: 1.45, active: [0.13, 0.33], cost: 11, speed: 1.25,
    frames: [
      { t: 0.00, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S },
      { t: 0.10, pelvisYaw: 22, chest: [6, 30, 0], head: [10, -24, 0], rUpperArm: [-60, 0, 45], rForearm: [-40, 0, -20] },
      { t: 0.24, pelvisYaw: -30, chest: [6, -40, 0], head: [10, 16, 0], rUpperArm: [-95, 0, 58], rForearm: [-20, 0, -40] },
      { t: 0.31, pelvisYaw: -30, chest: [6, -40, 0], head: [10, 16, 0], rUpperArm: [-95, 0, 58], rForearm: [-20, 0, -40] },
      { t: 0.55, pelvisYaw: S, chest: S, head: S, rUpperArm: S, rForearm: S },
    ],
  },
  // Lead-leg low kick: hips turn hard to the right and the shin whips into the opponent's lead thigh.
  lkick: {
    keys: ['chest', 'lThigh', 'lShin', 'rThigh', 'rShin', 'pelvisYaw', 'lUpperArm', 'rUpperArm'],
    weapon: 'lShin', weaponMult: 1.5, active: [0.15, 0.38], cost: 15, speed: 1.8,
    frames: [
      { t: 0.00, pelvisYaw: S, chest: S, lThigh: S, lShin: S, rThigh: S, rShin: S, lUpperArm: S, rUpperArm: S },
      { t: 0.13, pelvisYaw: 40, chest: [-4, 20, 8], lThigh: [-60, 0, -60], lShin: [100, 0, 0], rThigh: [4, 0, 6], rShin: [10, 0, 0], lUpperArm: [-30, 0, 50], rUpperArm: [-70, -10, -20] },
      { t: 0.28, pelvisYaw: 62, chest: [-6, 22, 10], lThigh: [-66, 0, -53], lShin: [15, 0, 0], rThigh: [4, 0, 6], rShin: [10, 0, 0], lUpperArm: [-30, 0, 50], rUpperArm: [-70, -10, -20] },
      { t: 0.36, pelvisYaw: 62, chest: [-6, 22, 10], lThigh: [-66, 0, -53], lShin: [15, 0, 0], rThigh: [4, 0, 6], rShin: [10, 0, 0], lUpperArm: [-30, 0, 50], rUpperArm: [-70, -10, -20] },
      { t: 0.72, pelvisYaw: S, chest: S, lThigh: S, lShin: S, rThigh: S, rShin: S, lUpperArm: S, rUpperArm: S },
    ],
  },
  // Rear-leg roundhouse to the head: chamber out to the right, hips turn through, knee snaps out.
  rkick: {
    keys: ['chest', 'head', 'rThigh', 'rShin', 'lThigh', 'lShin', 'pelvisYaw', 'lUpperArm', 'rUpperArm'],
    weapon: 'rShin', weaponMult: 1.5, active: [0.17, 0.42], cost: 20, speed: 1.7,
    frames: [
      { t: 0.00, pelvisYaw: S, chest: S, head: S, rThigh: S, rShin: S, lThigh: S, lShin: S, lUpperArm: S, rUpperArm: S },
      { t: 0.14, pelvisYaw: -40, chest: [-8, -26, -14], head: [0, 26, 0], rThigh: [16, 0, 69], rShin: [110, 0, 0], lThigh: [-4, 0, -6], lShin: [10, 0, 0], lUpperArm: [-80, 10, 20], rUpperArm: [-20, 0, -70] },
      { t: 0.30, pelvisYaw: -72, chest: [-12, -28, -22], head: [0, 30, 0], rThigh: [26, 0, 131], rShin: [8, 0, 0], lThigh: [-4, 0, -6], lShin: [10, 0, 0], lUpperArm: [-80, 10, 20], rUpperArm: [-20, 0, -70] },
      { t: 0.40, pelvisYaw: -72, chest: [-12, -28, -22], head: [0, 30, 0], rThigh: [26, 0, 131], rShin: [8, 0, 0], lThigh: [-4, 0, -6], lShin: [10, 0, 0], lUpperArm: [-80, 10, 20], rUpperArm: [-20, 0, -70] },
      { t: 0.84, pelvisYaw: S, chest: S, head: S, rThigh: S, rShin: S, lThigh: S, lShin: S, lUpperArm: S, rUpperArm: S },
    ],
  },
};

export const STRIKE_DURATION = Object.fromEntries(
  Object.entries(STRIKES).map(([k, s]) => [k, s.frames[s.frames.length - 1].t])
);
