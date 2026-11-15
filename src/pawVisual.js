import * as THREE from 'three';

export const HAND_VISUAL_SCALE = 1.22;
// When controllers supply a wrist pose but no finger joints, use a small neutral glove. Actual
// hand tracking replaces it with the articulated joint mesh; neither changes physical colliders.
export function createControllerPaw(side) {
  const group = new THREE.Group(); group.name = `controller-paw-${side}`;
  const fur = new THREE.MeshStandardMaterial({ color: 0xefdec5, roughness: 0.8 });
  const sphere = new THREE.SphereGeometry(1, 12, 10);
  const oval = (x, y, z, sx, sy, sz) => {
    const mesh = new THREE.Mesh(sphere, fur); mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true; group.add(mesh);
  };
  oval(0, -0.012, -0.035, 0.036, 0.022, 0.045);
  for (let i = 0; i < 4; i++) oval((i - 1.5) * 0.017, -0.025, -0.075, 0.011, 0.022, 0.023);
  oval(side === 'left' ? 0.036 : -0.036, -0.021, -0.043, 0.016, 0.016, 0.028);
  group.scale.setScalar(HAND_VISUAL_SCALE); group.visible = false;
  return group;
}

// The authored paws share the body's skinned mesh. Keep the armature and wrist transforms for
// IK, removing only triangles weighted to the hand bones (and any finger descendants).
export function removeAuthoredRabbitHands(model) {
  let removed = 0;
  model.traverse((mesh) => {
    if (!mesh.isSkinnedMesh) return;
    const geometry = mesh.geometry, joints = geometry.attributes.skinIndex, weights = geometry.attributes.skinWeight;
    if (!joints || !weights) return;
    const isHand = (bone) => {
      for (let b = bone; b; b = b.parent) if (/^hand[lr]$/.test(b.name.replace(/[_.\s]/g, '').toLowerCase())) return true;
      return false;
    };
    const handBones = new Set(mesh.skeleton.bones.flatMap((b, i) => isHand(b) ? [i] : []));
    const paw = new Uint8Array(joints.count);
    for (let v = 0; v < joints.count; v++) {
      let weight = 0;
      for (let k = 0; k < 4; k++) if (handBones.has(joints.getComponent(v, k))) weight += weights.getComponent(v, k);
      paw[v] = weight >= 0.5 ? 1 : 0;
    }
    const count = geometry.index?.count ?? joints.count, index = (i) => geometry.index ? geometry.index.getX(i) : i;
    const kept = [], groups = [], ranges = geometry.groups.length ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    let cut = 0;
    for (const range of ranges) {
      const start = kept.length;
      for (let i = range.start; i < Math.min(count, range.start + range.count); i += 3) {
        const a = index(i), b = index(i + 1), c = index(i + 2);
        if (paw[a] || paw[b] || paw[c]) { cut++; continue; }
        kept.push(a, b, c);
      }
      groups.push({ start, count: kept.length - start, materialIndex: range.materialIndex });
    }
    if (!cut) return;
    const trimmed = geometry.clone(); trimmed.setIndex(kept); trimmed.clearGroups();
    if (geometry.groups.length) for (const g of groups) trimmed.addGroup(g.start, g.count, g.materialIndex);
    trimmed.userData.removedHandTriangles = cut; mesh.geometry = trimmed; removed += cut;
  });
  return removed;
}
