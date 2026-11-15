// tzhu235's garden props (EnvironmentBuilder.BuildTeamProps + GardenProps.cs), loaded asynchronously. A prop that
// fails to load is skipped with a console warning; the rest of the garden does not wait for any of them.
//  - Unity imports the .obj files, mirroring x (right- to left-handed) and merging each file into one mesh with one
//    sub-mesh per material. The .glb files here have the same coordinates as the .obj (checked: the paper lantern's
//    "Glowing paper" node sits at x = -0.30, y = 1.75, as in the .obj; the firefly nodes match their .obj objects),
//    so each model goes under a child scaled (-1, 1, 1) inside the Unity-frame node: the Unity-side mesh is the
//    x-mirrored .obj, exactly as Unity has it, and the combined transform is a plain rotation (front faces stay
//    front). Bamboo_Fountain has no .glb; it is the .obj, as in Unity.
//  - Meshes are merged per material (Unity draws one sub-mesh per material too). No textures in any of them.
//  - Materials: Unity's importer (materialImportMode 2, useSRGBMaterialColor 1) makes Standard materials whose
//    albedo is the .mtl Kd read as an sRGB colour, so each colour is decoded from sRGB here (glTF stores the same
//    Kd numbers as linear factors). Roughness and metalness are Blender's (the .glb values; for the .obj,
//    roughness = 1 - sqrt(Ns / 1000) and metallic = Ka for illum 3, Blender's MTL export). Unity's own smoothness
//    mapping for imported OBJ materials could not be checked here (approximation). Back faces are culled, as
//    Unity's Standard does. The paper and firefly glow sub-meshes get the builder's own lit materials, whose
//    emission GardenProps animates.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { eulerQ, linColor, hex, lerp, ramp } from './unity.js';

const key = (name) => (name || '').trim().replace(/\s+/g, '_');

// non-indexed copy of vertices [start, start + count) of a geometry
function sliceGeometry(src, start, count) {
  const g = src.index ? src.toNonIndexed() : src;
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const a = g.attributes[name];
    if (a) out.setAttribute(name, new THREE.BufferAttribute(a.array.slice(start * a.itemSize, (start + count) * a.itemSize), a.itemSize));
  }
  return out;
}

// { materialKey: { geos: [BufferGeometry in model space], material } }
function collect(object) {
  object.updateMatrixWorld(true);
  const byMat = new Map();
  object.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const src = o.geometry;
    const pieces = Array.isArray(o.material) && src.groups.length
      ? src.groups.map((g) => ({ mat: mats[g.materialIndex], geo: sliceGeometry(src, g.start, g.count) }))
      : [{ mat: mats[0], geo: src.clone() }];
    for (const { mat, geo } of pieces) {
      for (const n of Object.keys(geo.attributes)) if (n !== 'position' && n !== 'normal') geo.deleteAttribute(n);
      geo.morphAttributes = {};
      if (!geo.attributes.normal) geo.computeVertexNormals();
      geo.applyMatrix4(o.matrixWorld);
      const k = key(mat?.name);
      if (!byMat.has(k)) byMat.set(k, { geos: [], material: mat });
      byMat.get(k).geos.push(geo);
    }
  });
  return byMat;
}

function mergeAll(geos) {
  if (geos.length === 1) return geos[0];
  const indexed = geos.every((g) => g.index), list = indexed ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g));
  return mergeGeometries(list, false);
}

function parseMtl(text) {
  const out = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'newmtl') cur = out[key(t.slice(1).join(' '))] = { Kd: [1, 1, 1], Ka: [0, 0, 0], Ns: 0, illum: 2 };
    else if (!cur) continue;
    else if (t[0] === 'Kd' || t[0] === 'Ka') cur[t[0]] = t.slice(1, 4).map(Number);
    else if (t[0] === 'Ns') cur.Ns = Number(t[1]);
    else if (t[0] === 'illum') cur.illum = Number(t[1]);
  }
  return out;
}

// a Standard material as Unity shows the imported one: { color: [r, g, b] sRGB-coded, roughness, metalness }
function standard({ color, roughness, metalness }) {
  const m = new THREE.MeshStandardMaterial({ roughness: Math.min(1, Math.max(0.04, roughness)), metalness });
  m.color.setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace);
  return m;
}

// Prop footprints for the player's collisions: circles { x, z, r } in the model's own (.obj/.glb) frame, from
// the .obj vertex bounds of each part
export const PROP_FOOTPRINTS = {
  lanternStand: [[-0.58, 0, 0.24], [-0.19, 0, 0.24], [0.19, 0, 0.24], [0.58, 0, 0.24]], // posts, hanging lanterns at head height
  chime: [[0, 0, 0.25]], // hangs down to 1.57 m: head height
  bench: [[-0.45, 0, 0.28], [0, 0, 0.28], [0.45, 0, 0.28]],
  sign: [[-0.22, 0.04, 0.22], [0.22, 0.04, 0.22]], // board at 1.04-1.53 m
  fountain: [[-0.9, 0, 1.0], [0.15, 0, 0.45], [1.1, -0.15, 0.6]], // basin, pivot stands, counterweight stones + post
  mossy: [[-0.3, 0, 0.35]],
};

const FILES = {
  lanternStand: '01_Paper_Lanterns.glb', chime: '03_Bamboo_Wind_Chime.glb', bench: '04_Bench_With_Basket.glb',
  sign: '05_Moon_Rabbit_Sign.glb', mossy: '06_Mossy_Stones_And_Leaves.glb', fireflies: 'Firefly_Swarm.glb', fountain: 'Bamboo_Fountain.obj',
};

export function loadGardenProps({ parent, placements, base, paperGlow, fireflyGlow, onPaperPoints }) {
  const gltf = new GLTFLoader();
  const pivots = {};
  const swaps = { Amber_paper: paperGlow, Firefly_lantern: fireflyGlow };

  for (const id of Object.keys(FILES)) {
    const pl = placements[id];
    const pivot = new THREE.Group();
    pivot.name = `MR_Prop_${pl.name}`;
    pivot.position.copy(pl.position);
    pivot.quaternion.copy(pl.quaternion);
    const mirror = new THREE.Group(); // .obj -> Unity mesh frame (Unity's importer negates x)
    mirror.scale.set(-1, 1, 1);
    pivot.add(mirror);
    parent.add(pivot);
    pivots[id] = { pivot, mirror, basePosition: pl.position.clone(), baseQuaternion: pl.quaternion.clone() };
    if (id === 'chime' || id === 'fountain') {
      const anchor = new THREE.Object3D(); anchor.name = `MR_Audio_${id}`; anchor.userData.audioReady = false;
      mirror.add(anchor); pivots[id].audioAnchor = anchor;
    }

    const file = FILES[id];
    const done = (object, mtl) => {
      const byMat = collect(object);
      for (const [k, { geos, material }] of byMat) {
        const geo = mergeAll(geos);
        if (!geo) { console.warn(`[moonGarden] ${file}: could not merge ${k}`); continue; }
        let mat = swaps[k];
        if (!mat) {
          if (mtl) {
            const d = mtl[k] ?? { Kd: [0.8, 0.8, 0.8], Ka: [0, 0, 0], Ns: 0, illum: 2 };
            mat = standard({ color: d.Kd, roughness: 1 - Math.sqrt(Math.max(0, d.Ns) / 1000), metalness: d.illum === 3 ? d.Ka[0] : 0 });
          } else {
            const c = material?.color ?? new THREE.Color(0.8, 0.8, 0.8); // glTF factor = the .mtl Kd number
            mat = standard({ color: [c.r, c.g, c.b], roughness: material?.roughness ?? 1, metalness: material?.metalness ?? 0 });
          }
          mat.name = k;
        }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = `${pivot.name}_${k}`;
        mesh.receiveShadow = true; // Unity: cast Off, receive on
        mirror.add(mesh);
        if (k === 'Amber_paper' && id === 'lanternStand') onPaperPoints?.(paperCentres(geo, pivots[id]));
      }
      const anchor = pivots[id].audioAnchor;
      if (anchor) {
        mirror.updateWorldMatrix(true, true);
        const bounds = new THREE.Box3().setFromObject(mirror);
        if (!bounds.isEmpty()) {
          anchor.position.copy(mirror.worldToLocal(bounds.getCenter(new THREE.Vector3())));
          anchor.userData.audioReady = true;
        }
      }
    };
    const fail = (err) => console.warn(`[moonGarden] ${file} failed to load; the garden goes on without it`, err);
    if (file.endsWith('.glb')) {
      gltf.load(`${base}${file}`, (g) => { try { done(g.scene, null); } catch (e) { fail(e); } }, undefined, fail);
    } else {
      const mtlUrl = `${base}${file.replace(/\.obj$/, '.mtl')}`;
      Promise.all([
        fetch(`${base}${file}`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }),
        fetch(mtlUrl).then((r) => (r.ok ? r.text() : '')).catch(() => ''),
      ]).then(([obj, mtl]) => done(new OBJLoader().parse(obj), parseMtl(mtl))).catch(fail);
    }
  }

  // GardenProps.Update: chime sway, firefly drift and glow, paper lantern glow (the halos are drawn by the caller)
  const paperColor = hex(0xffb65c), fireflyColor = hex(0xffe27a);
  const q = new THREE.Quaternion();
  return {
    pivots,
    animate(t, v, bright, lanternCount) {
      const ch = pivots.chime;
      if (ch) {
        const a = 2.5 * Math.sin(t * 0.9) + 1.2 * Math.sin(t * 2.3);
        const b = 1.8 * Math.sin(t * 0.7 + 2);
        ch.pivot.quaternion.copy(ch.baseQuaternion).multiply(eulerQ(a, 0, b, q));
      }
      const fl = pivots.fireflies;
      if (fl) {
        const i = 0;
        fl.pivot.position.set(
          fl.basePosition.x + Math.sin(t * 0.21 + i * 2) * 0.6,
          fl.basePosition.y + Math.sin(t * 0.33 + i) * 0.25,
          fl.basePosition.z + Math.cos(t * 0.17 + i * 3) * 0.6);
        eulerQ(0, t * 6 + i * 97, 0, fl.pivot.quaternion);
        const tw = 0.75 + 0.25 * Math.sin(t * 3.7 + i * 1.9);
        linColor(fireflyGlow.emissive, fireflyColor, lerp(0.4, 2.2, bright) * tw);
      }
      // paper: one emission for the stand, from a faint ember to bright as its lanterns light one by one
      let lit = 0;
      for (let i = 0; i < lanternCount; i++) lit += ramp(v, 0.12 + 0.12 * i, 0.2 + 0.12 * i);
      linColor(paperGlow.emissive, paperColor, lerp(0.05, 1.6, lanternCount > 0 ? lit / lanternCount : 0));
    },
  };
}

// GardenProps lanternPoints (EnvironmentBuilder.PaperCentres): the paper split into the halves left and right of
// the Unity mesh's x = 0 (the .obj's x mirrored), each half's centre, in the Unity-frame node's coordinates.
// Lantern 0 is Unity's x < 0 half (the .obj's x > 0: the smaller lantern).
function paperCentres(geo, { basePosition, baseQuaternion }) {
  const pos = geo.attributes.position, idx = geo.index;
  const l = [0, 0, 0], r = [0, 0, 0];
  let nl = 0, nr = 0;
  const n = idx ? idx.count : pos.count;
  for (let k = 0; k < n; k++) {
    const i = idx ? idx.getX(k) : k;
    const ux = -pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (ux < 0) { l[0] += ux; l[1] += y; l[2] += z; nl++; } else { r[0] += ux; r[1] += y; r[2] += z; nr++; }
  }
  const res = [];
  for (const [s, c] of [[l, nl], [r, nr]]) {
    if (!c) continue;
    res.push(new THREE.Vector3(s[0] / c, s[1] / c, s[2] / c).applyQuaternion(baseQuaternion).add(basePosition));
  }
  return res;
}
