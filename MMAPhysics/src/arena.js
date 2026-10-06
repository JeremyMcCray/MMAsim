import * as THREE from 'three';

export function buildArena(scene, radius, walls, sideLen) {
  // lights
  scene.background = new THREE.Color(0x07080b);
  scene.fog = new THREE.Fog(0x07080b, 14, 40);
  const hemi = new THREE.HemisphereLight(0xcfd8ff, 0x20150c, 0.55);
  scene.add(hemi);
  const key = new THREE.SpotLight(0xffffff, 1400, 40, Math.PI / 3.2, 0.5, 2);
  key.position.set(4, 11, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0005;
  scene.add(key);
  const fill = new THREE.PointLight(0x7fa8ff, 300, 30, 2);
  fill.position.set(-6, 6, -5);
  scene.add(fill);
  const rim = new THREE.PointLight(0xffb070, 200, 30, 2);
  rim.position.set(2, 4, -8);
  scene.add(rim);

  // mat (octagon)
  const matShape = new THREE.Shape();
  const sides = 8;
  const R = radius / Math.cos(Math.PI / sides);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const x = Math.cos(a) * R, y = Math.sin(a) * R;
    if (i === 0) matShape.moveTo(x, y); else matShape.lineTo(x, y);
  }
  matShape.closePath();
  const matGeo = new THREE.ShapeGeometry(matShape);
  matGeo.rotateX(-Math.PI / 2);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c9c3b4'; ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(0,0,0,.08)'; ctx.lineWidth = 2;
  for (let i = 0; i < 512; i += 32) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke(); }
  ctx.fillStyle = '#b8352f'; ctx.beginPath(); ctx.arc(256, 256, 120, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#c9c3b4'; ctx.beginPath(); ctx.arc(256, 256, 95, 0, Math.PI * 2); ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(1 / (2 * R), 1 / (2 * R)); tex.offset.set(0.5, 0.5);
  const mat = new THREE.Mesh(matGeo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  mat.receiveShadow = true;
  mat.position.y = 0.001;
  scene.add(mat);

  // surrounding floor
  const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 48), new THREE.MeshStandardMaterial({ color: 0x0d0f14, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.02; floor.receiveShadow = true;
  scene.add(floor);

  // cage
  const postMat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.5, metalness: 0.6 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.8 });
  const fenceMat = new THREE.MeshBasicMaterial({ color: 0x9aa4b5, transparent: true, opacity: 0.32, wireframe: true });
  const h = 1.95;
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, h + 0.1, 10), postMat);
    post.position.set(Math.cos(a) * R, (h + 0.1) / 2, Math.sin(a) * R);
    post.castShadow = true;
    scene.add(post);
  }
  for (const w of walls) {
    const fence = new THREE.Mesh(new THREE.PlaneGeometry(sideLen, h, Math.round(sideLen * 7), 14), fenceMat);
    fence.position.set(w.cx, h / 2, w.cz);
    fence.rotation.y = -w.a + Math.PI / 2;
    scene.add(fence);
    const topPad = new THREE.Mesh(new THREE.BoxGeometry(sideLen, 0.1, 0.12), padMat);
    topPad.position.set(w.cx, h, w.cz);
    topPad.rotation.y = -w.a + Math.PI / 2;
    scene.add(topPad);
    const base = new THREE.Mesh(new THREE.BoxGeometry(sideLen, 0.22, 0.26), padMat);
    base.position.set(w.cx * 1.02, 0.11, w.cz * 1.02);
    base.rotation.y = -w.a + Math.PI / 2;
    scene.add(base);
  }
}
