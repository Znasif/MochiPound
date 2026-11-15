import * as THREE from 'three';

// The film camera (?mp=watch, 2026-11-15, the user's request): a laptop page that renders the host's world
// and flies freely, smoothed for steady video. It never sends anything that changes the game.
//
//   click            capture the mouse (Esc frees it)       mouse / arrows   look (arrows: steady pans)
//   W A S D          fly, level with the ground              E / Q            up / down
//   Shift            4x faster                               wheel            base speed
//   Z / X            zoom in / out                           G                cinematic smoothing on/off
//   1-5              glide to a preset shot (Shift: cut)     O                orbit: mortar, host, guest, off
//   T                slow turntable while orbiting           H                hide/show this help
//   R                record a take / stop                    Enter            render the take to a video
//   Backspace        discard the take                        Esc              cancel a render
//   P                print the current shot to the console
// A take (src/film/) records the world as it was captured on each headset, and this camera's path; its render
// is made offline at an exact 60 fps, so it has no network lag, easing or dropped frames (takes: main.js).

// preset shots around the station at the origin (the pounder stands at +Z, the kneader at -X)
const SHOTS = [
  { name: 'wide', pos: [2.4, 1.8, 2.6], look: [0, 0.75, 0] },
  { name: 'over the pounder', pos: [0.45, 1.75, 2.1], look: [0, 0.75, 0] },
  { name: 'kneader side', pos: [-1.6, 1.25, -0.7], look: [0, 0.75, 0] },
  { name: 'top down', pos: [0.05, 2.3, 0.35], look: [0, 0.72, 0] },
  { name: 'sky', pos: [0.8, 1.0, 2.8], look: null }, // the Earth if the world has one, else up toward -Z
];
const SMOOTH = { normal: { look: 0.05, move: 0.12, glide: 1.4 }, cinematic: { look: 0.35, move: 0.6, glide: 3 } };
const MOUSE = 0.0018, ARROW = 0.5; // rad per pixel, rad/s

export function createSpectatorCam({ camera, dom, scene, targets = {}, takes = null }) {
  scene.add(camera); // off the player's rig: this camera is its own
  camera.rotation.order = 'YXZ';
  const pos = new THREE.Vector3(...SHOTS[0].pos), vel = new THREE.Vector3(), wish = new THREE.Vector3();
  const orbitCentre = new THREE.Vector3(), tmp = new THREE.Vector3(), mortar = new THREE.Vector3(0, 0.75, 0);
  let yaw = 0, pitch = 0, yawS = 0, pitchS = 0, fov = 60, fovS = 60, speed = 1.2;
  let smooth = 'normal', glide = null, orbit = null, turntable = false, active = false;
  const keys = new Set();
  aim(pos, new THREE.Vector3(...SHOTS[0].look));
  yawS = yaw; pitchS = pitch;

  function aim(from, to) {
    tmp.subVectors(to, from);
    yaw = Math.atan2(-tmp.x, -tmp.z);
    pitch = Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z));
  }
  // yaw targets taken the short way round from the smoothed yaw
  const unwrap = (a) => yawS + Math.atan2(Math.sin(a - yawS), Math.cos(a - yawS));
  function shotLook(shot) {
    if (shot.look) return new THREE.Vector3(...shot.look);
    const earth = scene.getObjectByName('MR_Earth');
    return earth ? earth.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 6, -30);
  }
  function takeShot(i, cut) {
    const shot = SHOTS[i];
    if (!shot) return;
    orbit = null;
    const to = new THREE.Vector3(...shot.pos), look = shotLook(shot);
    tmp.subVectors(look, to);
    const toYaw = unwrap(Math.atan2(-tmp.x, -tmp.z)), toPitch = Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z));
    if (cut) { pos.copy(to); vel.set(0, 0, 0); yaw = yawS = toYaw; pitch = pitchS = toPitch; glide = null; }
    else glide = { t: 0, from: pos.clone(), to, fromYaw: yaw, toYaw, fromPitch: pitch, toPitch };
    status(`shot ${i + 1}: ${shot.name}`);
  }
  // orbit targets in turn: the mortar, then whichever players are present
  function orbitTarget(name) { return name === 'mortar' ? mortar : targets[name]?.() ?? null; }
  function nextOrbit() {
    const order = ['mortar', 'host', 'join', null];
    let k = order.indexOf(orbit?.target ?? null);
    for (let n = 0; n < order.length; n++) {
      k = (k + 1) % order.length;
      const name = order[k];
      if (name === null) { orbit = null; status('free flight'); return; }
      const c = orbitTarget(name);
      if (!c) continue;
      orbitCentre.copy(c);
      tmp.subVectors(pos, c);
      orbit = { target: name, radius: Math.max(0.6, tmp.length()), azimuth: Math.atan2(tmp.x, tmp.z), elevation: Math.asin(THREE.MathUtils.clamp(tmp.y / Math.max(1e-6, tmp.length()), -0.95, 0.95)) };
      glide = null;
      status(`orbiting ${name === 'join' ? 'the guest' : name === 'host' ? 'the host' : 'the mortar'}`);
      return;
    }
  }

  // ---------- help and status (page UI: never in the recording) ----------
  const help = document.createElement('div');
  help.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:20;max-width:min(420px,calc(100vw - 24px));padding:10px 12px;border-radius:10px;background:rgba(10,14,22,0.72);color:#f3ead8;font:12px/1.5 system-ui,sans-serif;pointer-events:none;white-space:pre-wrap';
  const rec = document.createElement('div');
  rec.textContent = '●';
  rec.style.cssText = 'position:fixed;top:12px;right:14px;z-index:20;display:none;color:#ff4d4d;font:700 14px system-ui,sans-serif;text-shadow:0 0 4px #000;pointer-events:none';
  document.body.append(help, rec);
  help.style.display = 'none';
  let note = '', noteFor = 0, helpOn = true, helpAt = 0;
  const status = (text) => { note = text; noteFor = 3; drawHelp(); };
  function drawHelp() {
    const take = takes?.status ?? '';
    help.textContent = `FILM CAMERA · ${orbit ? `orbit ${orbit.target === 'join' ? 'guest' : orbit.target}${turntable ? ' · turntable' : ''}` : 'free'} · speed ${speed.toFixed(1)} m/s · ${Math.round(fovS)}° · ${smooth}\n`
      + 'click: mouse look · WASD fly · E/Q up/down · Shift fast · wheel speed · Z/X zoom\n'
      + '1-5 shots (Shift: cut) · O orbit · T turntable · G smoothing · R record a take · H hide'
      + (take ? `\n${take}` : '') + (note && noteFor > 0 ? `\n${note}` : '');
    // the corner mark: recording or rendering, also with the help hidden
    const busy = takes?.busy;
    rec.style.display = busy ? 'block' : 'none';
    if (busy) rec.textContent = take.startsWith('●') ? `● REC ${take.match(/([\d.]+) s/)?.[1] ?? ''} s` : take.split(' · ')[0];
  }

  addEventListener('keydown', (e) => {
    if (!active) return;
    keys.add(e.code);
    if (e.repeat) return;
    const digit = /^Digit([1-5])$/.exec(e.code);
    if (digit) takeShot(Number(digit[1]) - 1, e.shiftKey);
    else if (e.code === 'KeyO') nextOrbit();
    else if (e.code === 'KeyT') { turntable = !turntable; status(turntable ? 'turntable on (in orbit)' : 'turntable off'); }
    else if (e.code === 'KeyG') { smooth = smooth === 'normal' ? 'cinematic' : 'normal'; status(`${smooth} smoothing`); }
    else if (e.code === 'KeyH') { helpOn = !helpOn; help.style.display = helpOn ? 'block' : 'none'; }
    else if (e.code === 'KeyR') { takes?.toggle(); drawHelp(); }
    else if (e.code === 'Enter' && takes) { takes.render(); drawHelp(); }
    else if (e.code === 'Backspace' && takes) { takes.discard(); drawHelp(); e.preventDefault(); }
    else if (e.code === 'Escape' && takes?.busy) takes.cancel();
    else if (e.code === 'KeyP') {
      const look = tmp.set(0, 0, -1).applyQuaternion(camera.quaternion).add(pos);
      console.info(`[film] shot { pos: [${pos.toArray().map((v) => v.toFixed(2))}], look: [${look.toArray().map((v) => v.toFixed(2))}] }, fov ${Math.round(fovS)}`);
      status('shot printed to the console');
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  document.addEventListener('mousemove', (e) => {
    if (!active || document.pointerLockElement !== dom) return;
    if (orbit) {
      orbit.azimuth -= e.movementX * MOUSE * 1.5;
      orbit.elevation = THREE.MathUtils.clamp(orbit.elevation + e.movementY * MOUSE * 1.5, -0.6, 1.45);
    } else {
      glide = null;
      yaw -= e.movementX * MOUSE;
      pitch = THREE.MathUtils.clamp(pitch - e.movementY * MOUSE, -1.5, 1.5);
    }
  });
  dom.addEventListener('mousedown', () => { if (active && document.pointerLockElement !== dom) dom.requestPointerLock?.()?.catch?.(() => {}); });
  dom.addEventListener('wheel', (e) => {
    if (!active) return;
    speed = THREE.MathUtils.clamp(speed * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 0.1, 12);
    status(`speed ${speed.toFixed(1)} m/s`);
    e.preventDefault();
  }, { passive: false });

  const ease = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-3, tau));
  return {
    get head() { return pos; },
    // redraw the help and status (a render runs with this page's loop stopped)
    refresh() { drawHelp(); },
    enable() {
      active = true;
      help.style.display = helpOn ? 'block' : 'none';
      drawHelp();
    },
    update(dt) {
      if (!active) return;
      const s = SMOOTH[smooth];
      const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
      const axis = (a, b) => (keys.has(a) ? 1 : 0) - (keys.has(b) ? 1 : 0);
      const fwd = axis('KeyW', 'KeyS'), side = axis('KeyD', 'KeyA'), lift = axis('KeyE', 'KeyQ');
      // arrows: constant-rate pans and tilts (steadier on video than a hand on the mouse)
      const panX = axis('ArrowLeft', 'ArrowRight'), panY = axis('ArrowUp', 'ArrowDown');
      const zoom = axis('KeyX', 'KeyZ');
      if (zoom) fov = THREE.MathUtils.clamp(fov * Math.exp(zoom * dt * 0.9), 15, 95);
      fovS += (fov - fovS) * ease(dt, s.look * 2);
      if (Math.abs(camera.fov - fovS) > 1e-3) { camera.fov = fovS; camera.updateProjectionMatrix(); }

      if (orbit) {
        const c = orbitTarget(orbit.target);
        if (!c) { orbit = null; status('orbit target left: free flight'); }
        else {
          orbitCentre.lerp(c, ease(dt, s.move)); // a walking player is followed smoothly
          orbit.radius = THREE.MathUtils.clamp(orbit.radius * Math.exp(-fwd * dt * fast * 0.8), 0.4, 40);
          orbit.elevation = THREE.MathUtils.clamp(orbit.elevation + (lift + panY) * dt * 0.6, -0.6, 1.45);
          orbit.azimuth += (side * fast * 0.6 - panX * 0.6 + (turntable ? 0.15 : 0)) * dt;
          const ce = Math.cos(orbit.elevation);
          tmp.set(Math.sin(orbit.azimuth) * ce, Math.sin(orbit.elevation), Math.cos(orbit.azimuth) * ce).multiplyScalar(orbit.radius).add(orbitCentre);
          pos.lerp(tmp, ease(dt, s.move));
          vel.set(0, 0, 0);
          tmp.subVectors(orbitCentre, pos);
          yaw = unwrap(Math.atan2(-tmp.x, -tmp.z)); pitch = Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z));
        }
      }
      if (!orbit) {
        if (glide && (fwd || side || lift)) glide = null; // flying takes over from a glide
        if (glide) {
          glide.t = Math.min(1, glide.t + dt / s.glide);
          const k = glide.t * glide.t * (3 - 2 * glide.t);
          pos.lerpVectors(glide.from, glide.to, k);
          yaw = THREE.MathUtils.lerp(glide.fromYaw, glide.toYaw, k); pitch = THREE.MathUtils.lerp(glide.fromPitch, glide.toPitch, k);
          if (glide.t >= 1) glide = null;
          vel.set(0, 0, 0);
        } else {
          yaw += panX * ARROW * dt;
          pitch = THREE.MathUtils.clamp(pitch + panY * ARROW * dt, -1.5, 1.5);
          wish.set(side, 0, -fwd).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
          if (wish.lengthSq() > 1) wish.normalize();
          wish.y = lift;
          wish.multiplyScalar(speed * fast);
          vel.lerp(wish, ease(dt, s.move));
          pos.addScaledVector(vel, dt);
        }
      }
      yawS += (yaw - yawS) * ease(dt, glide ? 0.02 : s.look);
      pitchS += (pitch - pitchS) * ease(dt, glide ? 0.02 : s.look);
      camera.position.copy(pos);
      camera.rotation.set(pitchS, yawS, 0);
      noteFor -= dt;
      if (helpOn && (helpAt -= dt) <= 0) { helpAt = 0.25; drawHelp(); } // speed / zoom readout
    },
  };
}
