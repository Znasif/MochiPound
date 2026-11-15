// Sky, Moon and Earth shaders.
//  - Sky: Unity's Skybox/Panoramic (latitude-longitude, _Mapping 1, no rotation) on MR_SkyPanorama.png, drawn at
//    infinity (z = w) so it ignores the camera's far plane. c = tex * tint * unity_ColorSpaceDouble * exposure,
//    folded into one linear multiplier (uMul). Directions are converted to Unity's frame (z flipped) before the
//    lookup, so the stars sit where Unity put them.
//  - MoonRabbit/Celestial: unlit, fog-free, vertex colours, a lit side from a light direction, rim light.
import * as THREE from 'three';

export function createSkyMesh(texture) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: texture }, uMul: { value: new THREE.Vector3(1, 1, 1) } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4((viewMatrix * vec4(position, 0.0)).xyz, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec3 uMul;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vec3(vDir.x, vDir.y, -vDir.z)); // three -> Unity frame
        float lat = acos(clamp(d.y, -1.0, 1.0));
        float lon = atan(d.z, d.x);
        vec2 uv = vec2(0.5, 1.0) - vec2(lon * 0.15915494, lat * 0.31830989);
        gl_FragColor = vec4(texture2D(map, uv).rgb * uMul, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  mesh.name = 'MR_Sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

// uLightDir is in three world space (the caller converts from Unity's frame)
export function createCelestialMaterial({ ambient, emission, rimColor, lightDir }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uLightDir: { value: lightDir.clone() },
      uAmbient: { value: ambient },
      uEmission: { value: emission },
      uTerminator: { value: 0.25 },
      uRimColor: { value: rimColor.clone() },
      uRimPower: { value: 3 },
    },
    vertexColors: true,
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vW;
      varying vec3 vC;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vC = color;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor, uLightDir, uRimColor;
      uniform float uAmbient, uEmission, uTerminator, uRimPower;
      varying vec3 vN;
      varying vec3 vW;
      varying vec3 vC;
      void main() {
        vec3 n = normalize(vN);
        vec3 l = normalize(uLightDir);
        vec3 v = normalize(cameraPosition - vW);
        float lit = smoothstep(-uTerminator, uTerminator, dot(n, l));
        vec3 albedo = vC * uColor;
        vec3 col = albedo * mix(uAmbient, 1.0, lit) + albedo * uEmission * lit;
        float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), uRimPower);
        col += uRimColor * rim * (0.25 + 0.75 * lit);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    fog: false,
  });
}
