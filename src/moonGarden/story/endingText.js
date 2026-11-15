// A plain stand-in for StoryText (text.js), used by the ending only when createStoryText is unavailable (still
// a stub, missing, or it throws): the line drawn once into canvas textures, letters with a faint dark outline
// and, on a second additive quad, a soft gold glow that flashes once when the line appears and then breathes
// (StoryText.Refresh with `breathe`: glow x (1 + 0.18 sin(pi t) + 1.6 flash), flash = e^(-1.6 t) min(1, t / 0.25)).
// Same interface as createStoryText's result: { object3d, setText, placeInFront, setAlpha, beginExit, update, dispose }.
import * as THREE from 'three';

const W = 2048, H = 320; // texture size; the quads are sized so a capital letter is letterHeight metres tall
const FONT = '"Baloo 2", "Baloo", "Trebuchet MS", "Verdana", system-ui, sans-serif';
const css = (c) => `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;

export function createEndingText({ letterHeight = 0.28, color = [1, 0.96, 0.88], glowColor = [1, 0.76, 0.4], glowIntensity = 0.6 } = {}) {
  const group = new THREE.Group();
  group.name = 'MR_EndingText (canvas)';
  group.visible = false;
  const mk = () => {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { canvas, g: canvas.getContext('2d'), tex };
  };
  const letters = mk(), glow = mk();
  const quad = new THREE.PlaneGeometry(1, 1);
  const letterMat = new THREE.MeshBasicMaterial({ map: letters.tex, transparent: true, depthWrite: false, fog: false, opacity: 0 });
  const glowMat = new THREE.MeshBasicMaterial({ map: glow.tex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, color: 0x000000 });
  const glowMesh = new THREE.Mesh(quad, glowMat), letterMesh = new THREE.Mesh(quad, letterMat);
  glowMesh.renderOrder = 30; letterMesh.renderOrder = 31;
  letterMesh.position.z = 0.002;
  group.add(glowMesh, letterMesh);

  let alpha = 0, since = 0;
  const head = new THREE.Vector3(), fwd = new THREE.Vector3();

  function draw(text) {
    let px = 170;
    const g = letters.g;
    g.font = `700 ${px}px ${FONT}`;
    const w = g.measureText(text).width;
    if (w > W * 0.86) px = Math.floor(px * (W * 0.86) / w);
    for (const { g: c } of [letters, glow]) {
      c.clearRect(0, 0, W, H);
      c.font = `700 ${px}px ${FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
    }
    // letters: a soft dark edge so they read over the bright sky, then the warm white fill
    g.lineJoin = 'round';
    g.lineWidth = px * 0.07;
    g.strokeStyle = 'rgba(18, 12, 28, 0.55)';
    g.strokeText(text, W / 2, H / 2);
    g.fillStyle = css(color);
    g.fillText(text, W / 2, H / 2);
    // glow: blurred gold, twice for a fuller core
    const gg = glow.g;
    gg.shadowColor = css(glowColor);
    gg.fillStyle = css(glowColor);
    gg.shadowBlur = px * 0.45;
    gg.fillText(text, W / 2, H / 2);
    gg.shadowBlur = px * 0.18;
    gg.fillText(text, W / 2, H / 2);
    letters.tex.needsUpdate = true;
    glow.tex.needsUpdate = true;
    // size: the capital height in pixels (measured when the browser reports it) is letterHeight metres
    const m = g.measureText('H');
    const cap = m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent + (m.actualBoundingBoxDescent || 0) : px * 0.7;
    const s = letterHeight / cap; // metres per pixel
    group.scale.set(W * s, H * s, 1);
  }

  function refresh() {
    letterMat.opacity = alpha;
    const flash = Math.exp(-since * 1.6) * Math.min(1, since / 0.25);
    const k = alpha * (glowIntensity / 0.6) * (1 + 0.18 * Math.sin(since * Math.PI) + 1.6 * flash);
    glowMat.color.setScalar(k);
    group.visible = alpha > 0.001;
  }

  return {
    object3d: group,
    setText(text) { draw(String(text ?? '')); since = 0; refresh(); },
    // distance ahead of the head's yaw, `above` over eye height, facing the head (StoryText.PlaceInFront)
    placeInFront(camera, distance, above = 0) {
      camera.getWorldPosition(head);
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
      fwd.normalize();
      group.position.copy(head).addScaledVector(fwd, distance);
      group.position.y += above;
      group.lookAt(head);
      group.updateMatrixWorld(true);
    },
    setAlpha(a) { alpha = Math.min(1, Math.max(0, a)); refresh(); },
    beginExit() {},
    update(dt) { since += dt; if (alpha > 0.001) refresh(); },
    dispose() {
      group.removeFromParent();
      quad.dispose(); letterMat.dispose(); glowMat.dispose(); letters.tex.dispose(); glow.tex.dispose();
    },
  };
}
