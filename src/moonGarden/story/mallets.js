// Mallets.cs, at the three.js kine's scale (Unity dimensions x 1.6).
// Every solid is a direct-child cylinder or torus so kineContact reads its exact shape.
import * as THREE from 'three';
import * as L from '../../layout.js';
import { makeKine } from '../../props.js';

export const MALLETS = [
  { id: 'tteokme', label: 'Tteokme', match: 'bangarang' },
  { id: 'yokogine', label: 'Yokogine', match: 'believer' },
  { id: 'pestle', label: 'Jeolgut-gongi', match: 'gangnam' },
];
export function makeSongMallet(id, mats) {
  if (!MALLETS.some((m) => m.id === id)) throw new Error(`Unknown mallet asset: ${id}`);
  const asset = (object3d, options = {}) => {
    object3d.userData.assetId = id;
    return { object3d, options: { ...options, assetId: id } };
  };
  if (id === 'yokogine') return asset(makeKine(L.KINE_LENGTH, mats));
  const group = new THREE.Group(); group.name = id;
  function cylinder(name, r0, r1, height, position, material = mats.wood, rotation = null) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, height, 32), material);
    mesh.name = name; mesh.position.copy(position); if (rotation) mesh.rotation.copy(rotation);
    mesh.castShadow = true; group.add(mesh); return mesh;
  }
  const wrap = mats.wrap ?? mats.band;
  if (id === 'tteokme') {
    const h = 0.26 * 1.6, r = 0.075 * 1.6;
    cylinder('kine-head', r, r, h, new THREE.Vector3(0, 0, -L.KINE_LENGTH), mats.log ?? mats.wood);
    cylinder('kine-handle', 0.0336, 0.037, L.KINE_LENGTH + 0.1, new THREE.Vector3(0, 0, -(L.KINE_LENGTH - 0.1) / 2), mats.wood, new THREE.Euler(Math.PI / 2, 0, 0));
    cylinder('grip-wrap', 0.04, 0.04, 0.2, new THREE.Vector3(0, 0, -0.04), wrap, new THREE.Euler(Math.PI / 2, 0, 0));
    for (const y of [-h / 2 + 0.064, h / 2 - 0.064]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(r + 0.003, 0.009, 8, 32), mats.band);
      hoop.rotation.x = Math.PI / 2; hoop.position.set(0, y, -L.KINE_LENGTH); group.add(hoop);
    }
    return asset(group, {
      pose(kine, lift, strikeY) {
        const t = THREE.MathUtils.clamp(lift, 0, 1), e = t * t * (3 - 2 * t);
        kine.position.set(0, THREE.MathUtils.lerp(strikeY + h / 2 - 0.16, L.KINE_PIVOT_RAISED[1], e), THREE.MathUtils.lerp(0.85, 0.78, e));
        kine.rotation.set(lift * 1.95, 0, 0);
      },
    });
  }
  const gripHeight = 0.34 * 1.6, headLength = 0.17 * 1.6;
  const bottom = -gripHeight, waistBottom = bottom + headLength, waistTop = 0.48 * 1.6 - gripHeight;
  cylinder('kine-head', 0.072, 0.072, headLength, new THREE.Vector3(0, bottom + headLength / 2, 0));
  cylinder('kine-handle', 0.044, 0.0384, waistTop - waistBottom, new THREE.Vector3(0, (waistTop + waistBottom) / 2, 0));
  cylinder('pestle-top', 0.0684, 0.060, headLength, new THREE.Vector3(0, waistTop + headLength / 2, 0));
  cylinder('grip-wrap', 0.0432, 0.0432, 0.192, new THREE.Vector3(), wrap);
  return asset(group, {
    grip: { position: new THREE.Vector3(0, -0.02, -0.04), rotation: new THREE.Euler(0, 0, 0) },
    pose(kine, lift, strikeY) {
      kine.position.set(0, strikeY - 0.16 + gripHeight + 0.65 * lift, 0);
      kine.quaternion.identity();
    },
    rest(kine) { kine.position.set(L.KINE_REST[0], gripHeight + 0.003, L.KINE_REST[2]); kine.quaternion.identity(); },
  });
}

// A small suspended model above a scroll, centered and fitted independently of the tool's grip origin.
export function malletPreview(mallet, size = 0.25) {
  const holder = new THREE.Group(), model = mallet.clone();
  model.position.set(0, 0, 0); model.quaternion.identity(); model.scale.setScalar(1);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model), extent = bounds.getSize(new THREE.Vector3());
  const scale = size / Math.max(extent.x, extent.y, extent.z);
  model.position.copy(bounds.getCenter(new THREE.Vector3())).multiplyScalar(-scale); model.scale.setScalar(scale);
  holder.add(model); holder.rotation.set(-0.25, -0.5, 0.18);
  return holder;
}
