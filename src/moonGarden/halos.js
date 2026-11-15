// MoonRabbit/Glow ported: additive, fog-free quads masked by MR_Halo.png (colour * mask * intensity). Every
// glow Unity draws with Graphics.RenderMeshInstanced (paper lantern halos, cassia blossoms and aura, sky mist)
// goes into one instanced draw of camera-facing quads, and the ones lying on the ground (lantern pools, stepping
// stone glows, the gold light under the tree) into one instanced draw of flat quads. Per-instance colour carries
// colour * intensity. Positions are in the parent's frame (the Unity-frame node). Nothing is allocated per frame.
import * as THREE from 'three';

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const _q = new THREE.Quaternion(), FLAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));

export function createHalos(texture, maxBillboards = 96, maxFlat = 48) {
  const quad = new THREE.PlaneGeometry(1, 1);
  const billboardMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: texture } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        vUv = uv;
        vCol = instanceColor;
        vec2 s = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
        vec4 mv = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
        mv.xy += position.xy * s;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        gl_FragColor = vec4(vCol * texture2D(map, vUv).r, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
  });
  const flatMat = new THREE.MeshBasicMaterial({
    map: texture, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
  });
  const make = (mat, n, name) => {
    const m = new THREE.InstancedMesh(quad, mat, n);
    m.name = name;
    m.frustumCulled = false;
    m.count = 0;
    m.setColorAt(0, _c.setRGB(0, 0, 0));
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.renderOrder = 10;
    return m;
  };
  const billboards = make(billboardMat, maxBillboards, 'MR_GlowBillboards');
  const flats = make(flatMat, maxFlat, 'MR_GlowFlat');
  let nb = 0, nf = 0;
  return {
    billboards, flats,
    begin() { nb = 0; nf = 0; },
    // colour: a linear THREE.Color, times intensity
    billboard(x, y, z, sx, sy, color, intensity) {
      if (nb >= maxBillboards || intensity <= 0 || sx <= 0) return;
      billboards.setMatrixAt(nb, _m.compose(_p.set(x, y, z), _q.identity(), _s.set(sx, sy, 1)));
      billboards.setColorAt(nb++, _c.copy(color).multiplyScalar(intensity));
    },
    flat(x, y, z, size, color, intensity) {
      if (nf >= maxFlat || intensity <= 0 || size <= 0) return;
      flats.setMatrixAt(nf, _m.compose(_p.set(x, y, z), FLAT, _s.set(size, size, 1)));
      flats.setColorAt(nf++, _c.copy(color).multiplyScalar(intensity));
    },
    end() {
      billboards.count = nb; flats.count = nf;
      billboards.instanceMatrix.needsUpdate = true; billboards.instanceColor.needsUpdate = true;
      flats.instanceMatrix.needsUpdate = true; flats.instanceColor.needsUpdate = true;
    },
  };
}
