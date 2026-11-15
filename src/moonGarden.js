import * as THREE from 'three';
import { S } from './moonGarden/settings.js';
import { buildLayout, groundHeightU, islandEdge } from './moonGarden/layout.js';
import { g2l, linColor, lerpColor, mulColor, hex, lerp, ramp, smoothDamp, smoothStep, DotNetRandom } from './moonGarden/unity.js';
import { createSkyMesh, createCelestialMaterial } from './moonGarden/sky.js';
import { createHalos } from './moonGarden/halos.js';
import { loadGardenProps, PROP_FOOTPRINTS } from './moonGarden/props.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// The Moon garden from MochiPound (Unity, origin/multiplayer: Assets/_Project/World/Editor/EnvironmentBuilder.cs
// and its runtime scripts), replacing the snowy courtyard: a floating island with a silver clearing, a ring of
// bamboo open toward the Moon and the Earth, a cassia tree, two stone lanterns, stepping stones to the edge, the
// team's garden props, a panoramic starry sky, mist below the island, fog and moonlight.
//
// Frames: everything Unity built is made in Unity's own coordinates under `unity` (scale (1, 1, -1), shifted
// down so the clearing at the usu is y = 0). Unity's mortar is at the origin, as three's usu is, so Unity
// (x, y, z) is three (x, y - gh0, -z): Unity's player at (0, 0, -0.8) facing +Z is three's pounder side facing
// -Z, and the Moon, the bamboo opening and the Earth are toward -Z. three flips the front face under the
// negative scale, so Unity's clockwise winding renders as in Unity. Objects placed relative to the three.js
// station (the warm light on the dough, the 'ground' plane) are in three's frame, directly under `root`.
//
// Colours: Unity renders in linear colour space with lightsUseLinearIntensity on (ProjectSettings), so every
// gamma-space colour is linearised with Unity's own GammaToLinearSpace (g2l). Lights are three's physical
// lights: a Unity light's diffuse on a white surface is colour * intensity * N.L * atten, three's is
// colour * intensity * N.L * falloff / pi, so intensities are pi * Unity's, matched at a reference distance
// for point and spot lights (Unity Built-in: atten 1 / (1 + 25 (d / range)^2); three: decay 2, distance = range).

const BASE = `${import.meta.env.BASE_URL}env/`;
const PI = Math.PI;

const unityAtten = (d, range) => 1 / (1 + 25 * (d * d) / (range * range));
function threeFalloff(d, range) { const r = d / range, w = Math.max(0, 1 - r * r * r * r); return (w * w) / Math.max(d * d, 0.01); }
const pointIntensity = (unityIntensity, range, dRef) => PI * unityIntensity * unityAtten(dRef, range) / threeFalloff(dRef, range);

// MRAssets.Lit: Standard shader, metallic 0, with _SPECULARHIGHLIGHTS_OFF and _GLOSSYREFLECTIONS_OFF (the
// generated .mat files list both keywords), i.e. diffuse only: albedo * (1 - 0.04 dielectric reflectance) =
// 0.96 albedo, plus emission. That is Lambert; smoothness has no visible effect with both switches off.
function lit(color, emission = null, opts = {}) {
  const m = new THREE.MeshLambertMaterial(opts);
  linColor(m.color, color).multiplyScalar(0.96);
  if (emission) linColor(m.emissive, emission);
  return m;
}

export function buildMoonGarden(scene, renderer, options = {}) {
  const L = buildLayout();
  const gh0 = L.gh0;
  const root = new THREE.Group();
  root.name = 'moonGarden';
  scene.add(root);
  const unity = new THREE.Group();
  unity.name = 'moonGarden-unity';
  unity.scale.set(1, 1, -1);
  unity.position.y = -gh0;
  root.add(unity);
  const toThree = (x, y, z, out = new THREE.Vector3()) => out.set(x, y - gh0, -z);
  // hooks the parts below fill in (declared first: they are assigned before the progress code)
  let applyGarden = () => {};
  let animate = () => {};

  // Unity Built-in with no post-processing (no PostProcessing package; URP is installed but not the active
  // pipeline): no tone mapping, exposure 1. options.keepToneMapping leaves the renderer alone.
  if (renderer && !options.keepToneMapping) {
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
  }

  const loader = new THREE.TextureLoader();
  const haloTex = loader.load(`${BASE}MR_Halo.png`, undefined, undefined, () => console.warn('[moonGarden] MR_Halo.png failed to load'));
  haloTex.colorSpace = THREE.SRGBColorSpace;

  // ---------------- materials (EnvironmentBuilder.Mats)
  const M = {
    clearing: lit(lerpColor(S.moonlight, S.navySky, 0.32)),
    ground: lit(S.darkGround),
    stone: lit(S.stone),
    earth: lit(mulColor(S.darkGround, 0.85)),
    islandEarth: lit(mulColor(S.darkGround, 0.85)), // own copy: MoonStory brightens the island, not the mounds
    islandRock: lit(S.islandRock),
    litter: lit(mulColor(lerpColor(S.lightWood, S.bambooDark, 0.5), 0.75)),
    trunk: lit(S.trunk),
    canopy: lit(lerpColor(S.cassiaGold, S.bambooLight, 0.4), mulColor(lerpColor(S.cassiaGold, S.bambooLight, 0.4), 0.22)),
    canopyGold: lit(S.cassiaGold, mulColor(S.cassiaGold, 0.45)),
  };
  const meshes = [];
  // a static mesh in the Unity frame
  function addMesh(geometry, material, { name, cast = false, receive = true, parent = unity } = {}) {
    if (!geometry) return null;
    const m = new THREE.Mesh(geometry, material);
    if (name) m.name = name;
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    parent.add(m);
    meshes.push(m);
    return m;
  }

  // ---------------- ground and island
  const [clearingGeo, groundGeo] = L.ground.geometries();
  addMesh(clearingGeo, M.clearing, { name: 'MR_Ground_clearing' });
  addMesh(groundGeo, M.ground, { name: 'MR_Ground' });
  const [bandGeo, rockGeo] = L.underside.geometries();
  addMesh(bandGeo, M.islandEarth, { name: 'MR_IslandUnderside_earth', receive: false });
  addMesh(rockGeo, M.islandRock, { name: 'MR_IslandUnderside', receive: false });
  addMesh(L.floatingRocks.geometries()[0], M.islandRock, { name: 'MR_FloatingRocks', receive: false });
  // the flat ground plane kineContact reads (its world y): the clearing at the usu
  const groundMarker = new THREE.Object3D();
  groundMarker.name = 'ground';
  root.add(groundMarker);

  // ---------------- sky
  scene.background = new THREE.Color();
  const sky = createSkyMesh(null);
  sky.visible = false;
  root.add(sky);
  loader.load(`${BASE}MR_SkyPanorama.png`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    sky.material.uniforms.map.value = tex;
    sky.visible = true;
  }, undefined, () => console.warn('[moonGarden] MR_SkyPanorama.png failed to load; the sky stays the fog colour'));

  // ---------------- Moon and Earth (MoonRabbit/Celestial + MoonRabbit/Glow halo quads)
  const uDir = (d, out = new THREE.Vector3()) => out.set(d[0], d[1], -d[2]).normalize(); // Unity direction -> three
  const moonMat = createCelestialMaterial({ ambient: 0.12, emission: 0.1, rimColor: linColor(new THREE.Color(), S.moonlight), lightDir: uDir([-L.moon.dir[0], -L.moon.dir[1] + 0.1, -L.moon.dir[2]]) });
  const moon = new THREE.Mesh(L.moonGeometry, moonMat);
  moon.name = 'MR_Moon';
  moon.position.copy(L.moon.position);
  moon.quaternion.copy(L.moon.quaternion);
  moon.scale.setScalar(L.moon.scale);
  unity.add(moon);
  const glowMat = (color, intensity) => {
    const m = new THREE.MeshBasicMaterial({ map: haloTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
    linColor(m.color, color).multiplyScalar(intensity);
    return m;
  };
  const quad = new THREE.PlaneGeometry(1, 1);
  const moonGlowBase = linColor(new THREE.Color(), S.moonlight);
  const moonGlow = new THREE.Mesh(quad, glowMat(S.moonlight, 0.8));
  moonGlow.name = 'Glow';
  moonGlow.position.set(0, 0, -1.1);
  moonGlow.scale.setScalar(4.2);
  moon.add(moonGlow);

  const earthMat = createCelestialMaterial({ ambient: 0.18, emission: 0.45, rimColor: new THREE.Color(0.55, 0.75, 1).convertSRGBToLinear(), lightDir: uDir(L.earth.lightDir) });
  const earth = new THREE.Mesh(L.earthGeometry, earthMat);
  earth.name = 'MR_Earth';
  earth.position.copy(L.earth.position);
  earth.quaternion.copy(L.earth.quaternion);
  earth.scale.setScalar(L.earth.scale);
  unity.add(earth);
  const earthGlow = new THREE.Mesh(quad, glowMat([0.45, 0.65, 1], 0.5));
  earthGlow.name = 'Glow';
  earthGlow.quaternion.copy(L.earth.glowQuaternion);
  earthGlow.position.set(0, 0, -1.1).applyQuaternion(L.earth.glowQuaternion);
  earthGlow.scale.setScalar(3.2);
  earth.add(earthGlow);

  // the Earth's light (MoonStory.Apply's Earth part, with its EarthBrightness / EarthPulse hooks): bright 0 = its
  // dark night side faces the garden (the light swung behind it, a thin bright rim), 1 = the built look; pulse =
  // the ending's extra glow; city 0..1 = its city lights coming on one after another (MoonStory.DrawEarthLights,
  // drawn with the glows below). setEarthLight sets them; the defaults are the built look.
  const earthGlowColor = linColor(new THREE.Color(), [0.45, 0.65, 1]);
  const earthBack = L.earth.position.clone().normalize(); // from MR_Story (the environment's origin), Unity frame
  const earthLitDir = new THREE.Vector3(...L.earth.lightDir).normalize();
  const earthFx = { bright: 1, pulse: 0, city: 0 };
  const earthTmp = new THREE.Vector3();
  function applyEarth() {
    const b = earthFx.bright, p = earthFx.pulse;
    slerpDir(slerpDir(earthBack, earthLitDir, 0.25, earthTmp), earthLitDir, smoothStep(0, 1, b), earthTmp);
    earthMat.uniforms.uLightDir.value.set(earthTmp.x, earthTmp.y, -earthTmp.z); // -> three
    earthMat.uniforms.uEmission.value = 0.45 * lerp(0.25, 1, b) + p * 0.25;
    earthMat.uniforms.uAmbient.value = 0.18 * lerp(0.3, 1, b) + p * 0.08;
    earthGlow.material.color.copy(earthGlowColor).multiplyScalar(0.5 * lerp(0.35, 1, b) + p * 3);
    earthGlow.scale.setScalar(3.2 + p * 6);
  }
  // v: 0 = dark night side, 1 = the built look, above 1 = lit with its city lights (v - 1 of them on, and the
  // ending's settled glow). pulse and city, if given, set those two directly (the ending's sequence).
  function setEarthLight(v, pulse, city) {
    v = Number(v) || 0;
    const b = Math.min(1, Math.max(0, v));
    const c = Math.min(1, Math.max(0, city ?? v - 1));
    const p = Math.max(0, pulse ?? 0.45 * c);
    if (b === earthFx.bright && p === earthFx.pulse && c === earthFx.city) return;
    earthFx.bright = b; earthFx.pulse = p; earthFx.city = c;
    applyEarth();
  }
  // city lights: spread over the Earth's disc seen from the viewer, a little toward the night (left) side
  const CITY_N = 36, cityColor = linColor(new THREE.Color(), [1, 0.8, 0.45]), cityDir = new Float32Array(CITY_N * 2);
  {
    const rng = new DotNetRandom(77);
    for (let i = 0; i < CITY_N; i++) {
      const a = Math.fround(rng.nextDouble()) * PI * 2, r = Math.sqrt(Math.fround(rng.nextDouble())) * 0.85;
      cityDir[i * 2] = Math.cos(a) * r - 0.15;
      cityDir[i * 2 + 1] = Math.sin(a) * r;
    }
  }
  const viewer = new THREE.Vector3(0.9, 1.62, 3.1); // three world: the last known head (update's head / setViewer)
  const vU = new THREE.Vector3(), cToCam = new THREE.Vector3(), cRight = new THREE.Vector3(), cUp = new THREE.Vector3();
  const UP_U = new THREE.Vector3(0, 1, 0);
  let drawCityLights = () => {};

  // ---------------- lights
  // moonlight: from the Moon's side at 35 degrees, the only shadow caster (Soft, strength 0.7), with a tight box
  // around the clearing
  const moonFrom = [0, Math.sin(S.moonlightPitch * PI / 180), Math.cos(S.moonlightPitch * PI / 180)];
  const moonLight = new THREE.DirectionalLight(linColor(new THREE.Color(), S.moonlightColor), PI * S.moonlightIntensity);
  moonLight.name = 'MR_Moonlight';
  const shadowCentre = [0.4, 0, 0.6];
  moonLight.position.set(shadowCentre[0] + moonFrom[0] * 22, shadowCentre[1] + moonFrom[1] * 22, shadowCentre[2] + moonFrom[2] * 22);
  moonLight.target.position.set(...shadowCentre);
  moonLight.castShadow = true;
  Object.assign(moonLight.shadow.camera, { left: -6.5, right: 6.5, top: 6.5, bottom: -6.5, near: 4, far: 44 });
  moonLight.shadow.camera.updateProjectionMatrix();
  moonLight.shadow.mapSize.set(1024, 1024);
  moonLight.shadow.bias = -0.0004;
  moonLight.shadow.normalBias = 0.03;
  moonLight.shadow.intensity = 0.7;
  unity.add(moonLight, moonLight.target);

  // ambient: Unity's trilight (sky / equator / ground) as a light probe whose irradiance for a normal n is pi
  // times the gradient colour at n.y (so a Lambert surface gets albedo * gradient, as Unity's ShadeSH9 gives)
  const probe = new THREE.LightProbe();
  probe.name = 'MR_Ambient';
  root.add(probe);
  const shBasis = trilightBasis();

  // warm light on the dough (BuildMochiLight): a 30-degree spot 0.73 m from the dough, up and to the left front
  // (the left stone lantern's side), re-aimed at the three.js dough (top at y 0.8, the usu at the origin)
  const doughTarget = new THREE.Vector3(0, 0.8, 0);
  const off = S.mochiLightOffset;
  const mochiLight = new THREE.SpotLight(linColor(new THREE.Color(), S.mochiLightColor), 1, S.mochiLightRange, (S.mochiLightSpotAngle / 2) * PI / 180, 0.6, 2);
  mochiLight.name = 'MR_MochiWarmLight';
  mochiLight.position.set(doughTarget.x + off[0], doughTarget.y + off[1], doughTarget.z - off[2]);
  mochiLight.target.position.copy(doughTarget);
  mochiLight.intensity = pointIntensity(S.mochiLightIntensity, S.mochiLightRange, mochiLight.position.distanceTo(doughTarget));
  root.add(mochiLight, mochiLight.target);

  // fog: exponential squared; the island build used 0.7 x density and a colour between the horizon and the sky
  const fogBase = lerpColor(S.horizonFog, S.navySky, 0.65);
  const fogDensityBase = S.fogDensity * 0.7;
  scene.fog = new THREE.FogExp2(linColor(new THREE.Color(), fogBase), fogDensityBase);
  scene.background.copy(scene.fog.color);

  // ---------------- colliders (player.js format, three frame)
  const colliders = { circles: [], boxes: [] };
  {
    // ring of circles just past the walkable edge (1 m inside the island's lip) keeps the player on the island
    const N = 144, rc = 1.5, body = 0.3;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * PI * 2, sx = Math.sin(a), cz = Math.cos(a);
      const R = islandEdge(sx, cz) - 1.0 + body + rc;
      colliders.circles.push({ x: sx * R, z: -cz * R, r: rc });
    }
  }

  // ---------------- bamboo (BambooGrove: GPU instancing, near/far materials, casts no shadow, receives)
  // One InstancedMesh per variant and sub-mesh (stalk, leaves). Near and far differ only in colour (Lambert:
  // smoothness has no effect), so that is carried per instance: 8 draws instead of Unity's 16.
  const bambooColors = {
    stalk: [S.bambooLight, S.bambooDark],
    leaf: [lerpColor(S.bambooLight, S.bambooDark, 0.45), mulColor(S.bambooDark, 0.85)],
  };
  const bambooSilverColor = [0.72, 0.8, 0.86], BAMBOO_KINDS = ['stalk', 'leaf'];
  const stalkMat = new THREE.MeshLambertMaterial(), leafMat = new THREE.MeshLambertMaterial(); // white; colour per instance
  const bamboo = [];
  L.bambooVariants.forEach((variant, vi) => {
    const list = L.stalks.filter((s) => s.variant === vi);
    if (!list.length) return;
    const [stalkGeo, leafGeo] = variant.mb.geometries();
    for (const [geo, mat, kind] of [[stalkGeo, stalkMat, 'stalk'], [leafGeo, leafMat, 'leaf']]) {
      if (!geo) continue;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      im.name = `MR_Bamboo_${vi}_${kind}`;
      list.forEach((s, i) => im.setMatrixAt(i, s.matrix));
      im.setColorAt(0, new THREE.Color(1, 1, 1));
      im.receiveShadow = true;
      im.matrixAutoUpdate = false;
      im.updateMatrix();
      im.computeBoundingSphere();
      unity.add(im);
      bamboo.push({ mesh: im, kind, near: list.map((s) => s.near) });
    }
  });
  let bambooSilver = -1;
  const silverCols = { stalk: [new THREE.Color(), new THREE.Color()], leaf: [new THREE.Color(), new THREE.Color()] }, sc3 = [0, 0, 0];
  function setBambooSilver(silver) {
    if (Math.abs(silver - bambooSilver) < 1e-5) return;
    bambooSilver = silver;
    for (const kind of BAMBOO_KINDS) {
      for (let k = 0; k < 2; k++) {
        const c = bambooColors[kind][k];
        for (let j = 0; j < 3; j++) sc3[j] = c[j] + (bambooSilverColor[j] - c[j]) * silver;
        linColor(silverCols[kind][k], sc3).multiplyScalar(0.96);
      }
    }
    for (const b of bamboo) {
      const cn = silverCols[b.kind][0], cf = silverCols[b.kind][1];
      for (let i = 0; i < b.near.length; i++) b.mesh.setColorAt(i, b.near[i] ? cn : cf);
      b.mesh.instanceColor.needsUpdate = true;
    }
  }
  setBambooSilver(0);
  for (const s of L.stalks) colliders.circles.push({ x: s.x, z: -s.z, r: Math.max(0.05, s.radius) });

  // ---------------- bamboo bases (earth mounds, leaf litter, pebbles) and stepping stones; stone shares one draw
  const [moundGeo, litterGeo, pebbleGeo] = L.bambooBases.geometries();
  addMesh(moundGeo, M.earth, { name: 'MR_BambooBases_earth' });
  addMesh(litterGeo, M.litter, { name: 'MR_BambooBases_litter' });
  addMesh(mergeGeometries([L.stones.geometries()[0], pebbleGeo].filter(Boolean)), M.stone, { name: 'MR_SteppingStones' });

  // ---------------- cassia tree (casts and receives)
  const tree = new THREE.Group();
  tree.name = 'MR_CassiaTree';
  tree.position.copy(L.tree.position);
  tree.quaternion.copy(L.tree.quaternion);
  unity.add(tree);
  tree.updateMatrix();
  const treeGeos = L.tree.mb.geometries();
  [M.trunk, M.canopy, M.canopyGold].forEach((mat, i) => addMesh(treeGeos[i], mat, { cast: true, parent: tree }));
  const treeBox = new THREE.Box3();
  for (const g of treeGeos) if (g) { g.computeBoundingBox(); treeBox.union(g.boundingBox.clone().applyMatrix4(tree.matrix)); }
  const treeCentre = treeBox.getCenter(new THREE.Vector3()), treeExt = treeBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  colliders.circles.push({ x: L.tree.position.x, z: -L.tree.position.z, r: 0.25 });

  // ---------------- stone lanterns: stone bodies in one draw (cast), each glowing box its own material
  // (MoonStory lights them one by one), a point light each (range 4, intensity 1, no shadows)
  const [lanternStoneGeo, lanternGlowGeo] = L.lanternMesh.geometries();
  const lanternMatrix = (l) => new THREE.Matrix4().compose(l.position, l.quaternion, new THREE.Vector3(1, 1, 1));
  addMesh(mergeGeometries(L.lanterns.map((l) => lanternStoneGeo.clone().applyMatrix4(lanternMatrix(l)))), M.stone, { name: 'MR_StoneLanterns', cast: true });
  const lanternGlowEmission = mulColor(S.lantern, 2.2);
  // Unity's lantern lights are Auto lights; with Quest's one pixel light they were vertex lights there
  // (1 / (1 + 25 d^2 / range^2), no cut-off); matched at 1.5 m, where they light the ground around the lantern
  const lanternLightBase = pointIntensity(S.lanternLightIntensity, S.lanternLightRange, 1.5);
  const lanterns = L.lanterns.map((l, i) => {
    const mat = lit(S.lantern, lanternGlowEmission);
    const glow = addMesh(lanternGlowGeo.clone().applyMatrix4(lanternMatrix(l)), mat, { name: `MR_StoneLantern_${i}_glow`, cast: true });
    const light = new THREE.PointLight(linColor(new THREE.Color(), S.lantern), lanternLightBase, S.lanternLightRange, 2);
    light.name = `MR_StoneLantern_${i}_light`;
    light.position.copy(l.light);
    unity.add(light);
    colliders.circles.push({ x: l.position.x, z: -l.position.z, r: 0.27 });
    return { glow, mat, light, on: 0, pool: new THREE.Vector3(l.position.x, groundHeightU(l.position.x, l.position.z) + 0.02, l.position.z) };
  });

  // ---------------- glows (MoonRabbit/Glow) and their progress
  const halos = createHalos(haloTex, 112, 32); // 64 for the garden, 36 for the Earth's city lights
  unity.add(halos.billboards, halos.flats);
  const glowColors = {
    lantern: linColor(new THREE.Color(), S.lantern),
    blossom: linColor(new THREE.Color(), lerpColor(S.cassiaGold, S.lantern, 0.4)),
    stone: linColor(new THREE.Color(), S.moonlight),
    mist: linColor(new THREE.Color(), S.skyMistColor),
    paper: linColor(new THREE.Color(), hex(0xffb65c)),
  };
  const garden = { v: 0, bright: 0, bloom: 0, glowK: 0 };
  const blossomEmission = mulColor(S.cassiaGold, 0.45), canopyEmission = mulColor(lerpColor(S.cassiaGold, S.bambooLight, 0.4), 0.22);
  applyGarden = (v, bright) => {
    garden.v = v; garden.bright = bright;
    const sv = ramp(v, 0, 1);
    // stone lanterns one by one from 25 %: an ember until lit, then the glow box, the light and the pool
    for (let i = 0; i < lanterns.length; i++) {
      const l = lanterns[i];
      l.on = ramp(v, 0.25 + 0.12 * i, 0.25 + 0.12 * i + 0.08);
      linColor(l.mat.emissive, lanternGlowEmission, lerp(0.1, 1, l.on));
      l.light.intensity = lanternLightBase * l.on; // never hidden: a light count change recompiles every shader
    }
    // cassia: blossoms swell and glow from 50 %, the canopy glows a little more, the trunk lightens
    garden.bloom = ramp(v, 0.5, 1);
    garden.glowK = ramp(v, 0.2, 1);
    linColor(M.canopyGold.emissive, blossomEmission, lerp(0.45, 2.2, garden.bloom));
    linColor(M.canopy.emissive, canopyEmission, lerp(0.55, 1.9, sv));
    linColor(M.trunk.color, S.trunk, lerp(0.85, 1.25, sv)).multiplyScalar(0.96);
    // the bamboo turns silvery at the very end
    setBambooSilver(0.45 * ramp(v, 0.9, 1));
  };
  drawCityLights = (t) => {
    const c = L.earth.position, R = L.earth.scale, k = R * 1.04;
    vU.set(viewer.x, viewer.y + gh0, -viewer.z); // the viewer in Unity's frame
    cToCam.subVectors(vU, c).normalize();
    cRight.crossVectors(UP_U, cToCam).normalize(); // Unity's Vector3.Cross, same numbers in its frame
    cUp.crossVectors(cToCam, cRight);
    for (let i = 0; i < CITY_N; i++) {
      const on = Math.min(1, Math.max(0, earthFx.city * CITY_N * 1.3 - i)); // one after another
      if (on <= 0.01) continue;
      const dx = cityDir[i * 2], dy = cityDir[i * 2 + 1], dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
      const tw = 0.8 + 0.2 * Math.sin(t * 3.1 + i * 2.3), s = R * 0.6 * on * tw;
      halos.billboard(c.x + (-cRight.x * dx + cUp.x * dy + cToCam.x * dz) * k, c.y + (-cRight.y * dx + cUp.y * dy + cToCam.y * dz) * k,
        c.z + (-cRight.z * dx + cUp.z * dy + cToCam.z * dz) * k, s, s, cityColor, 1.7);
    }
  };
  const blossoms = L.tree.blossoms, stones = L.stonePoints, mist = L.mist;
  let paperPoints = []; // the paper lanterns' centres, once their model has loaded
  animate = (dt, t) => {
    const { v, bright, bloom, glowK } = garden;
    halos.begin();
    for (const l of lanterns) if (l.on > 0.01) halos.flat(l.pool.x, l.pool.y, l.pool.z, S.lanternPoolRadius * 2, glowColors.lantern, S.lanternPoolIntensity * l.on);
    // gold light pooling under the tree and a faint aura around the canopy
    if (glowK > 0) {
      halos.flat(L.tree.position.x, L.tree.position.y + 0.04, L.tree.position.z, treeExt.x * 3.2, glowColors.blossom, 0.4 * glowK);
      const s = treeExt.x * 3.4;
      halos.billboard(treeCentre.x, treeCentre.y + treeExt.y * 0.3, treeCentre.z, s, s, glowColors.blossom, 0.16 * glowK);
    }
    const nb = blossoms.length, bi = lerp(0.25, 0.9, bloom);
    for (let i = 0; i < nb; i++) {
      const a0 = 0.5 + 0.5 * 0.75 * i / Math.max(1, nb);
      const s = ramp(v, a0, a0 + 0.15);
      if (s <= 0.01) continue;
      const size = 0.34 * s * (1 + 0.08 * Math.sin(t * 1.7 + i * 2.1));
      halos.billboard(blossoms[i].x, blossoms[i].y, blossoms[i].z, size, size, glowColors.blossom, bi);
    }
    // stepping stones glow one by one toward the sky from 75 %
    const ns = stones.length;
    for (let i = 0; i < ns; i++) {
      const a0 = 0.75 + (0.97 - 0.75) * i / Math.max(1, ns);
      const s = ramp(v, a0, a0 + 0.06);
      if (s <= 0.01) continue;
      halos.flat(stones[i].x, stones[i].y + 0.06, stones[i].z, 0.95 * s * (1 + 0.06 * Math.sin(t * 1.3 - i * 0.6)), glowColors.stone, 0.55);
    }
    // paper lantern halos (GardenProps): one after another from 12 %, flickering
    for (let i = 0; i < paperPoints.length; i++) {
      const on = ramp(v, 0.12 + 0.12 * i, 0.12 + 0.12 * i + 0.08);
      if (on <= 0.01) continue;
      const fl = 1 + 0.05 * Math.sin(t * 7.3 + i * 2.1) + 0.03 * Math.sin(t * 13.1 + i);
      const p = paperPoints[i], s = 0.75 * on * fl;
      halos.billboard(p.x, p.y, p.z, s, s, glowColors.paper, 0.55);
    }
    if (earthFx.city > 0.001) drawCityLights(t);
    // star mist drifting around and below the island (SkyMist), brighter as the night comes alive
    const mi = lerp(0.16, 0.62, bright);
    for (let i = 0; i < mist.length; i++) {
      const q = mist[i];
      const a = (q.angle + t * 0.6 * (i % 2 === 0 ? 1 : 0.7)) * PI / 180;
      const br = 1 + 0.08 * Math.sin(t * 0.2 + q.phase);
      halos.billboard(Math.sin(a) * q.radius, q.height + Math.sin(t * 0.13 + q.phase) * 0.6, Math.cos(a) * q.radius, q.size * 1.6 * br, q.size * br, glowColors.mist, mi);
    }
    halos.end();
    animateProps(dt, t);
  };
  let animateProps = () => {};

  // ---------------- team props (tzhu235), asynchronous; GardenProps lights the paper and the fireflies
  const paperGlow = lit(hex(0xfdce8b), [0.01, 0.006, 0.002]);
  paperGlow.name = 'MR_PropPaperGlow';
  const fireflyGlow = lit(hex(0xf8e169), [0.01, 0.01, 0.004]);
  fireflyGlow.name = 'MR_PropFireflyGlow';
  const props = loadGardenProps({
    parent: unity, placements: L.props, base: BASE, paperGlow, fireflyGlow,
    onPaperPoints: (pts) => { paperPoints = pts; },
  });
  animateProps = (dt, t) => props.animate(t, garden.v, garden.bright, paperPoints.length);
  {
    // their footprints are known up front (from the .obj bounds), so the colliders exist before the models load
    const v = new THREE.Vector3();
    for (const [id, circles] of Object.entries(PROP_FOOTPRINTS)) {
      const pl = L.props[id];
      for (const [x, z, r] of circles) {
        v.set(-x, 0, z).applyQuaternion(pl.quaternion).add(pl.position);
        colliders.circles.push({ x: v.x, z: -v.z, r });
      }
    }
  }

  // ---------------- progress (MoonStory.Apply: the night comes alive with the batch)
  const state = { target: 0, shown: -1, vel: { v: 0 }, pulse: 0, last: 0, applied: -1, appliedPulse: -1 };
  const tmpV = new THREE.Vector3();
  const moonD = L.moon.dir;
  const moonRight = (() => { const r = [moonD[2], 0, -moonD[0]]; const l = Math.hypot(r[0], r[2]) || 1; return [r[0] / l, 0, r[2] / l]; })(); // Cross(up, d)
  const fogTint = [0.78, 0.78, 1];
  const skyTintDark = [0.42, 0.44, 0.5], skyTintBright = [0.55, 0.53, 0.64];
  const COLOR_SPACE_DOUBLE = 4.59479380; // unity_ColorSpaceDouble in linear space
  const scratch = [0, 0, 0], fcap = [0.45, 0.45, 0.6], islandEarthColor = mulColor(S.darkGround, 0.85);

  function applyProgress(v) {
    const mv = v;
    const msv = ramp(mv, 0, 1);
    const p = state.pulse * state.pulse * 0.35 * lerp(0.6, 1.6, v); // later strikes light the Moon more
    const bright = Math.min(1, Math.max(0, 0.6 * mv + 0.4 * ramp(mv, 0.72, 1)));
    // Moon phase: lit from the right (waxing), a crescent at 0, full at 1
    const th = 132 * Math.pow(1 - Math.min(1, Math.max(0, mv)), 0.55) * PI / 180;
    const s = Math.sin(th), c = Math.cos(th);
    tmpV.set(-moonD[0] * c + moonRight[0] * s, -moonD[1] * c + 0.1 * (1 - s), -(-moonD[2] * c + moonRight[2] * s)).normalize(); // -> three
    moonMat.uniforms.uLightDir.value.copy(tmpV);
    moonMat.uniforms.uEmission.value = lerp(0.03, 0.35, msv) + p;
    moonMat.uniforms.uAmbient.value = lerp(0.02, 0.12, msv);
    moonGlow.material.color.copy(moonGlowBase).multiplyScalar(lerp(0.2, 1.6, msv) + p * 1.2);
    moonGlow.scale.setScalar(lerp(3.0, 7.5, msv) + p * 0.6);
    // moonlight, ambient, fog, sky
    moonLight.intensity = PI * S.moonlightIntensity * lerp(0.45, 1.6, bright);
    const a = lerp(0.5, 1.7, bright);
    setAmbient(probe, shBasis, S.ambientSky, S.ambientEquator, S.ambientGround, a);
    scene.fog.density = fogDensityBase * lerp(1.6, 0.4, bright);
    // fog colour: toward a moonlit silver-violet and brighter, never a glaring haze (gamma-space maths, as Unity)
    const fb = lerp(0.7, 1.8, bright);
    for (let j = 0; j < 3; j++) scratch[j] = Math.min(fcap[j], (fogBase[j] + (fogBase[j] * fogTint[j] - fogBase[j]) * bright) * fb);
    linColor(scene.fog.color, scratch);
    scene.background.copy(scene.fog.color);
    const exposure = lerp(0.7, 1.45, bright);
    for (let j = 0; j < 3; j++) scratch[j] = g2l(skyTintDark[j] + (skyTintBright[j] - skyTintDark[j]) * bright) * COLOR_SPACE_DOUBLE * exposure;
    sky.material.uniforms.uMul.value.set(scratch[0], scratch[1], scratch[2]);
    const k = lerp(0.8, 1.7, bright); // the island underside and floating rocks catch the moonlight too
    linColor(M.islandEarth.color, islandEarthColor, k).multiplyScalar(0.96);
    linColor(M.islandRock.color, S.islandRock, k).multiplyScalar(0.96);
    state.bright = bright;
    applyGarden(v, bright, msv);
  }

  function setProgress(p) {
    p = Math.min(1, Math.max(0, Number(p) || 0));
    if (p > state.target + 1e-4) state.pulse = 1; // each strike that raises the progress gives the Moon a pulse
    state.target = p;
  }

  function update(dt, elapsed, head) {
    if (head) viewer.copy(head);
    if (state.shown < 0) state.shown = state.target;
    state.shown = smoothDamp(state.shown, state.target, state.vel, 0.35, dt);
    if (Math.abs(state.shown - state.target) < 1e-4) state.shown = state.target;
    state.pulse = Math.max(0, state.pulse - dt * 2);
    if (state.shown !== state.applied || state.pulse !== state.appliedPulse) {
      applyProgress(state.shown);
      state.applied = state.shown;
      state.appliedPulse = state.pulse;
    }
    animate(dt, elapsed);
  }

  applyProgress(0);
  state.shown = 0;
  state.applied = 0;
  state.appliedPulse = 0;

  root.updateMatrixWorld(true);
  return {
    root,
    colliders,
    update,
    setProgress,
    groundHeight: (x, z) => groundHeightU(x, -z) - gh0,
    spawn: { position: [0.9, 0, 3.1], yaw: Math.atan2(0.9, 3.1) },
    lights: { moonLight, mochiLight, probe },
    audioAnchors: { chime: props.pivots.chime.audioAnchor, fountain: props.pivots.fountain.audioAnchor },
    // for the story layer (src/moonGarden/story/): the Earth's light (see setEarthLight above; earthLight is its
    // live state { bright, pulse, city }, read only), the viewer the city lights face (update's head does the same),
    // the Moon and the Earth (three world positions, and Unity-frame ones under `unity`), the Unity-frame node and
    // conversions to and from it, and the glow mask
    setEarthLight,
    earthLight: earthFx,
    setViewer(p) { viewer.copy(p); },
    earth: { mesh: earth, glow: earthGlow, position: earth.getWorldPosition(new THREE.Vector3()), positionU: L.earth.position.clone(), radius: L.earth.scale },
    moon: { mesh: moon, glow: moonGlow, position: moon.getWorldPosition(new THREE.Vector3()), positionU: L.moon.position.clone(), radius: L.moon.scale },
    unity,
    toUnity: (v, out = new THREE.Vector3()) => out.set(v.x, v.y + gh0, -v.z),
    fromUnity: (v, out = new THREE.Vector3()) => out.set(v.x, v.y - gh0, -v.z),
    haloTexture: haloTex,
  };
}

// Vector3.Slerp for unit vectors (out may be a)
function slerpDir(a, b, t, out) {
  t = Math.min(1, Math.max(0, t));
  const d = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  const th = Math.acos(d), s = Math.sin(th);
  let wa = 1 - t, wb = t;
  if (s > 1e-5) { wa = Math.sin((1 - t) * th) / s; wb = Math.sin(t * th) / s; }
  out.set(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb);
  return out.lengthSq() > 1e-10 ? out.normalize() : out.copy(b);
}

// SH (three's convention, radiance coefficients) for unit sky / equator / ground colours of Unity's trilight
// gradient, fitted so the probe's irradiance for normal n is pi * gradient(n.y): sky above, the equator at the
// horizon, ground below, linear in n.y in between.
function trilightBasis() {
  const basis = new Array(9).fill(0);
  const out = { sky: new Float64Array(9), eq: new Float64Array(9), ground: new Float64Array(9) };
  const A = [PI, 2 * PI / 3, 2 * PI / 3, 2 * PI / 3, PI / 4, PI / 4, PI / 4, PI / 4, PI / 4];
  const NY = 96, NP = 48, w = (2 / NY) * (2 * PI / NP), n = new THREE.Vector3();
  for (let iy = 0; iy < NY; iy++) {
    const y = -1 + (iy + 0.5) * (2 / NY), r = Math.sqrt(1 - y * y);
    const ws = y > 0 ? y : 0, wg = y < 0 ? -y : 0, we = 1 - Math.abs(y);
    for (let ip = 0; ip < NP; ip++) {
      const ph = (ip + 0.5) * (2 * PI / NP);
      n.set(r * Math.cos(ph), y, r * Math.sin(ph));
      THREE.SphericalHarmonics3.getBasisAt(n, basis);
      for (let k = 0; k < 9; k++) {
        const b = basis[k] * w * PI / A[k];
        out.sky[k] += ws * b; out.eq[k] += we * b; out.ground[k] += wg * b;
      }
    }
  }
  return out;
}
const AMB_S = [0, 0, 0], AMB_E = [0, 0, 0], AMB_G = [0, 0, 0];
function setAmbient(probe, B, sky, eq, ground, k) {
  const s = AMB_S, e = AMB_E, g = AMB_G;
  for (let j = 0; j < 3; j++) { s[j] = g2l(sky[j] * k); e[j] = g2l(eq[j] * k); g[j] = g2l(ground[j] * k); }
  const c = probe.sh.coefficients;
  for (let i = 0; i < 9; i++) {
    c[i].set(B.sky[i] * s[0] + B.eq[i] * e[0] + B.ground[i] * g[0], B.sky[i] * s[1] + B.eq[i] * e[1] + B.ground[i] * g[1], B.sky[i] * s[2] + B.eq[i] * e[2] + B.ground[i] * g[2]);
  }
}

