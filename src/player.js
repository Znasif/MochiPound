import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import * as L from './layout.js';

// The person: a rig (moved for locomotion, never the camera itself), desktop mouse-look + WASD,
// and in WebXR the headset camera with thumbstick locomotion and snap turn. Collisions are simple
// circles and boxes. Footsteps are counted from collision-resolved ground travel (one step per
// stride): a labelled distance fallback, since there are no animated feet.

const STRIDE_M = 0.72;
const RADIUS = 0.3;

export function createPlayer({ scene, camera, renderer, dom, getColliders }) {
  const rig = new THREE.Group();
  rig.name = 'player_rig';
  rig.position.set(...L.SPAWN.position);
  rig.rotation.y = L.SPAWN.yaw;
  scene.add(rig);
  rig.add(camera);
  camera.position.set(0, L.EYE_HEIGHT, 0);

  // a body host that follows the head on the ground (for anything Satie places `at player`)
  const body = new THREE.Object3D();
  body.name = 'player';
  scene.add(body);

  const keys = new Set();
  let yaw = L.SPAWN.yaw, pitch = -0.08;
  let locked = null; // { position, yaw } while holding the kine on desktop
  let enabled = false;
  let strideAcc = 0;
  const listeners = {};
  const emit = (n, d) => { for (const fn of listeners[n] ?? []) fn(d); };

  addEventListener('keydown', (e) => {
    if (!enabled) return;
    keys.add(e.code);
    if (e.code === 'KeyE' && !e.repeat) emit('use');
    if (e.code === 'Space' && !e.repeat) { emit('strike'); e.preventDefault(); }
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  dom.addEventListener('mousedown', (e) => {
    if (!enabled || renderer.xr.isPresenting) return;
    if (document.pointerLockElement !== dom) { dom.requestPointerLock?.(); return; }
    if (e.button === 0) emit('strike');
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== dom || renderer.xr.isPresenting) return;
    yaw -= e.movementX * 0.0022;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.0022, -1.35, 1.2);
  });

  // ---------- WebXR controllers ----------
  const factory = new XRControllerModelFactory();
  const controllers = [0, 1].map((i) => {
    const ray = renderer.xr.getController(i); // ask three for both, even if one is used
    const grip = renderer.xr.getControllerGrip(i);
    grip.add(factory.createControllerModel(grip));
    rig.add(ray, grip);
    const c = { ray, grip, source: null, handedness: null };
    ray.addEventListener('connected', (e) => { c.source = e.data; c.handedness = e.data.handedness; });
    ray.addEventListener('disconnected', () => { c.source = null; c.handedness = null; });
    // a tracked hand's pinch is not a controller press (kneading hands must not pick up the kine)
    ray.addEventListener('selectstart', () => { if (!c.source?.hand) emit('xrselect', c); });
    ray.addEventListener('squeezestart', () => { if (!c.source?.hand) emit('xrselect', c); });
    return c;
  });
  let snapReady = true;

  const headWorld = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const move = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  function collide(p) {
    const cols = getColliders();
    // a world may keep the player inside a rectangle (the shrine courtyard: its walls); the Moon garden
    // keeps them on the island with a ring of circles instead, so it gives none
    const rect = cols.rect;
    if (rect) {
      p.x = THREE.MathUtils.clamp(p.x, rect.minX, rect.maxX);
      p.z = THREE.MathUtils.clamp(p.z, rect.minZ, rect.maxZ);
    }
    for (const c of cols.circles) {
      const dx = p.x - c.x, dz = p.z - c.z, rr = c.r + RADIUS;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-8) { const d = Math.sqrt(d2); p.x = c.x + (dx / d) * rr; p.z = c.z + (dz / d) * rr; }
    }
    for (const b of cols.boxes) {
      const cx = THREE.MathUtils.clamp(p.x, b.minX, b.maxX), cz = THREE.MathUtils.clamp(p.z, b.minZ, b.maxZ);
      const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
      if (d2 < RADIUS * RADIUS) {
        if (d2 > 1e-8) { const d = Math.sqrt(d2); p.x = cx + (dx / d) * RADIUS; p.z = cz + (dz / d) * RADIUS; }
        else { // inside: push out the nearest face
          const opts = [[b.minX - RADIUS - p.x, 0], [b.maxX + RADIUS - p.x, 0], [0, b.minZ - RADIUS - p.z], [0, b.maxZ + RADIUS - p.z]];
          opts.sort((a, c) => Math.abs(a[0] + a[1]) - Math.abs(c[0] + c[1]));
          p.x += opts[0][0]; p.z += opts[0][1];
        }
      }
    }
  }

  function headPosition(out) {
    camera.getWorldPosition(out);
    return out;
  }

  function update(dt) {
    const xr = renderer.xr.isPresenting;
    headPosition(prev);
    if (!xr) {
      if (locked) {
        rig.position.set(locked.position[0], 0, locked.position[2]);
      } else if (enabled) {
        const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
        const speed = run ? 3.2 : 1.55;
        move.set(0, 0, 0);
        if (keys.has('KeyW') || keys.has('ArrowUp')) move.z -= 1;
        if (keys.has('KeyS') || keys.has('ArrowDown')) move.z += 1;
        if (keys.has('KeyA') || keys.has('ArrowLeft')) move.x -= 1;
        if (keys.has('KeyD') || keys.has('ArrowRight')) move.x += 1;
        if (move.lengthSq() > 0) {
          move.normalize().multiplyScalar(speed * dt).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
          rig.position.add(move);
        }
      }
      rig.rotation.y = yaw;
      camera.rotation.set(pitch, 0, 0);
      camera.position.set(0, L.EYE_HEIGHT, 0);
      if (!locked) collide(rig.position);
    } else {
      // left stick: move where the head looks; right stick: snap turn 30 degrees
      let stick = false;
      for (const c of controllers) {
        const gp = c.source?.gamepad;
        if (!gp || gp.axes.length < 4) continue;
        const ax = gp.axes[2], ay = gp.axes[3];
        if (c.handedness === 'left' && !locked && Math.hypot(ax, ay) > 0.15) {
          camera.getWorldDirection(fwd);
          fwd.y = 0;
          fwd.normalize();
          const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
          rig.position.addScaledVector(fwd, -ay * 1.5 * dt).addScaledVector(right, ax * 1.5 * dt);
          stick = true;
        }
        if (c.handedness === 'right') {
          if (snapReady && Math.abs(ax) > 0.7) {
            snapReady = false;
            // turn about the head, not the rig origin
            headPosition(headWorld);
            const ang = -Math.sign(ax) * Math.PI / 6;
            rig.position.sub(headWorld).applyAxisAngle(THREE.Object3D.DEFAULT_UP, ang).add(headWorld);
            rig.rotation.y += ang;
          } else if (Math.abs(ax) < 0.3) snapReady = true;
        }
      }
      // collide the head's ground position, then move the rig by the correction. Only for thumbstick
      // moves: the real body walking or leaning (over the mortar, to knead) is never pushed back
      if (stick) {
        headPosition(headWorld);
        const fixed = headWorld.clone();
        collide(fixed);
        rig.position.x += fixed.x - headWorld.x;
        rig.position.z += fixed.z - headWorld.z;
      }
    }
    rig.updateMatrixWorld(true);
    headPosition(headWorld);
    body.position.set(headWorld.x, 0.9, headWorld.z);
    // footsteps from resolved travel (ignore teleports and pounding in place)
    const travelled = Math.hypot(headWorld.x - prev.x, headWorld.z - prev.z);
    if (enabled && travelled < 1.0 && !locked) {
      strideAcc += travelled;
      if (strideAcc >= STRIDE_M) {
        strideAcc -= STRIDE_M;
        emit('step', { surface: L.surfaceAt(headWorld.x, headWorld.z), position: headWorld.clone().setY(0) });
      }
    }
    return headWorld;
  }

  return {
    rig, body, controllers,
    on(n, fn) { (listeners[n] ??= []).push(fn); },
    update,
    enable() { enabled = true; },
    get enabled() { return enabled; },
    get head() { return headWorld; },
    get yaw() { return yaw; },
    // desktop: stand at the pounding spot, facing the mortar, looking down at the dough
    lockAt(position, faceYaw, lookPitch) {
      locked = { position };
      yaw = faceYaw;
      pitch = lookPitch;
      strideAcc = 0;
    },
    unlock() { locked = null; },
    get locked() { return !!locked; },
    // VR: move the rig so the head stands at a ground point (and, given `lookAt` [x, y, z], turn it about
    // the head so the view faces that point)
    placeHeadAt(x, z, lookAt = null) {
      if (lookAt) {
        headPosition(headWorld);
        // the head's heading (yaw), not its gaze: looking down at your hands, the gaze is near vertical
        // and its horizontal direction is noise
        const yawNow = new THREE.Euler().setFromQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()), 'YXZ').y;
        const ang = Math.atan2(-(lookAt[0] - headWorld.x), -(lookAt[2] - headWorld.z)) - yawNow;
        rig.position.sub(headWorld).applyAxisAngle(THREE.Object3D.DEFAULT_UP, ang).add(headWorld);
        rig.rotation.y += ang;
        rig.updateMatrixWorld(true);
      }
      headPosition(headWorld);
      rig.position.x += x - headWorld.x;
      rig.position.z += z - headWorld.z;
      rig.updateMatrixWorld(true);
      strideAcc = 0;
    },
    look: {
      get: () => ({ yaw, pitch }),
      set: (y, p) => { yaw = y; pitch = p; },
    },
    teleport(x, z, faceYaw) {
      if (locked) return;
      rig.position.set(x, 0, z);
      yaw = faceYaw;
      strideAcc = 0;
    },
    haptic(c, intensity = 0.6, ms = 60) {
      try { c?.source?.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, ms); } catch { /* not supported */ }
    },
  };
}
