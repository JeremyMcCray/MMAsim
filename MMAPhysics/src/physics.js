import RAPIER from '@dimforge/rapier3d-compat';

export const PHYS_DT = 1 / 240;

// Collision group bits
export const GROUP_FIGHTER = [0b0001, 0b0010];
export const GROUP_WORLD = 0b0100;

export function groups(membership, filter) {
  return (membership << 16) | filter;
}

export async function createPhysics() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = PHYS_DT;
  try {
    world.integrationParameters.numSolverIterations = 8;
  } catch (e) { /* older API */ }
  return { RAPIER, world };
}

export function makeFloor(RAPIER, world, radius) {
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const gc = world.createCollider(
    RAPIER.ColliderDesc.cuboid(radius + 4, 0.5, radius + 4).setFriction(0.35),
    ground
  );
  gc.setCollisionGroups(groups(GROUP_WORLD, GROUP_FIGHTER[0] | GROUP_FIGHTER[1]));

  // Octagon fence: 8 wall segments
  const walls = [];
  const sides = 8;
  const apothem = radius;
  const sideLen = 2 * apothem * Math.tan(Math.PI / sides);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
    const cx = Math.cos(a) * (apothem + 0.05);
    const cz = Math.sin(a) * (apothem + 0.05);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(cx, 1.0, cz)
        .setRotation(yawQuat(-a + Math.PI / 2))
    );
    const col = world.createCollider(
      RAPIER.ColliderDesc.cuboid(sideLen / 2 + 0.1, 1.0, 0.05).setFriction(0.3).setRestitution(0.15),
      body
    );
    col.setCollisionGroups(groups(GROUP_WORLD, GROUP_FIGHTER[0] | GROUP_FIGHTER[1]));
    walls.push({ a, cx, cz, sideLen });
  }
  return { ground, walls, sideLen };
}

export function yawQuat(yaw) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}
