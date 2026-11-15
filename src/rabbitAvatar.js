// Rigged Moon Rabbit players: separate headset and left/right inputs, two-bone limb IK,
// planted steps driven by world travel, and a torso that lets the neck turn independently.
import * as THREE from 'three';
import { createControllerPaw, removeAuthoredRabbitHands } from './pawVisual.js';

const STALE = 2.5, MODEL_EYE_Y = 1.16;
const FACE_CAMERA = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const GRIP_TO_PAW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const canonical = (name) => name.replace(/[_.\s]/g, '').toLowerCase();
const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
const dir = new THREE.Vector3(), bend = new THREE.Vector3(), mid = new THREE.Vector3(), axis = new THREE.Vector3();
const q = new THREE.Quaternion(), parentQ = new THREE.Quaternion(), rotation = new THREE.Quaternion();

function orientBone(bone, worldQuaternion) {
  bone.parent.getWorldQuaternion(parentQ).invert();
  bone.quaternion.copy(parentQ).multiply(worldQuaternion); bone.updateWorldMatrix(false, true);
}

async function loadRabbit(variant) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const file = variant === 'red' ? 'Mochi_Player_Rabbit_Red.glb' : 'Mochi_Player_Rabbit.glb';
  return (await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}env/characters/${file}`)).scene;
}

function aimBone(bone, end, target) {
  bone.getWorldPosition(p0); end.getWorldPosition(p1);
  dir.subVectors(p1, p0).normalize(); axis.subVectors(target, p0).normalize();
  if (axis.lengthSq() < 1e-8 || dir.lengthSq() < 1e-8) return;
  rotation.setFromUnitVectors(dir, axis);
  bone.getWorldQuaternion(q).premultiply(rotation);
  bone.parent.getWorldQuaternion(parentQ).invert();
  bone.quaternion.copy(parentQ).multiply(q); bone.updateWorldMatrix(false, true);
}

// Two-bone IK keeps the authored limb lengths; unreachable targets extend the arm without stretching it.
function solveLimb(upper, lower, end, target, pole) {
  if (!upper || !lower || !end) return;
  upper.getWorldPosition(p0); lower.getWorldPosition(p1); end.getWorldPosition(p2);
  const a = p0.distanceTo(p1), b = p1.distanceTo(p2);
  dir.subVectors(target, p0);
  const distance = dir.length();
  if (distance < 1e-6 || a < 1e-6 || b < 1e-6) return;
  dir.multiplyScalar(1 / distance);
  const d = THREE.MathUtils.clamp(distance, Math.abs(a - b) + 1e-5, a + b - 1e-5);
  const x = (a * a - b * b + d * d) / (2 * d), height = Math.sqrt(Math.max(0, a * a - x * x));
  bend.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (bend.lengthSq() < 1e-6) bend.set(0, 0, 1).addScaledVector(dir, -dir.z);
  mid.copy(p0).addScaledVector(dir, x).addScaledVector(bend.normalize(), height);
  aimBone(upper, lower, mid); aimBone(lower, end, target);
}

function fallbackRabbit(variant) {
  const group = new THREE.Group(), fur = new THREE.MeshStandardMaterial({ color: 0xefdec5, roughness: 0.8 });
  const coat = new THREE.MeshStandardMaterial({ color: variant === 'red' ? 0xb83238 : 0x286b72, roughness: 0.8 });
  const pink = new THREE.MeshStandardMaterial({ color: 0xe89e9c, roughness: 0.8 });
  const sphere = new THREE.SphereGeometry(1, 16, 12);
  const add = (mat, position, scale) => { const mesh = new THREE.Mesh(sphere, mat); mesh.position.set(...position); mesh.scale.set(...scale); group.add(mesh); return mesh; };
  add(coat, [0, 0.6, 0], [0.25, 0.4, 0.2]); add(fur, [0, 1.1, 0], [0.23, 0.24, 0.21]);
  for (const side of [-1, 1]) {
    add(fur, [side * 0.11, 1.5, 0], [0.075, 0.28, 0.065]);
    add(pink, [side * 0.11, 1.5, 0.058], [0.04, 0.21, 0.012]);
    add(fur, [side * 0.13, 0.09, 0.08], [0.1, 0.09, 0.17]);
  }
  return group;
}

export function createRabbitAvatar(scene, { variant = 'indigo', hands, load = loadRabbit } = {}) {
  const root = new THREE.Group(); root.name = 'other-player'; root.visible = false; scene.add(root);
  const visual = new THREE.Group(); visual.rotation.y = Math.PI; root.add(visual);
  const fallback = fallbackRabbit(variant); visual.add(fallback);
  let model = null, bones = [], bind = [], head = null, hips = null, scale = null, seen = -Infinity, lastYaw = 0;
  let bodyYaw = null, gaitPhase = 0, walkBlend = 0, resetFeet = true;
  const arms = [], legs = [];
  const controllerPaws = ['left', 'right'].map((side) => ({ side, mesh: createControllerPaw(side) }));
  for (const paw of controllerPaws) scene.add(paw.mesh);
  const position = new THREE.Vector3(), targetP = new THREE.Vector3(), targetQ = new THREE.Quaternion(), orientation = new THREE.Quaternion();
  const forward = new THREE.Vector3(), eyeOffset = new THREE.Vector3(), target = new THREE.Vector3(), pole = new THREE.Vector3();
  const foot = new THREE.Vector3(), kinePosition = new THREE.Vector3();
  const previous = new THREE.Vector3(), velocity = new THREE.Vector3(), travel = new THREE.Vector3();
  const moveDirection = new THREE.Vector3(0, 0, -1), pawQ = new THREE.Quaternion(), footQ = new THREE.Quaternion();
  let heldKine = null, effectors = {};

  const ready = load(variant).then((loaded) => {
    model = loaded; removeAuthoredRabbitHands(model); visual.add(model);
    model.traverse((o) => {
      if (o.isBone) bones.push(o);
      if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
    });
    bind = bones.map((bone) => ({ bone, position: bone.position.clone(), quaternion: bone.quaternion.clone() }));
    const find = (name) => bones.find((bone) => canonical(bone.name) === canonical(name));
    head = find('head'); hips = find('hips');
    if (!head || !hips) throw new Error('rabbit rig has no head/hips bones');
    root.updateMatrixWorld(true);
    for (const side of ['L', 'R']) {
      arms.push({ side, upper: find(`UpperArm.${side}`), lower: find(`Forearm.${side}`), end: find(`Hand.${side}`),
        target: new THREE.Vector3(), rotation: new THREE.Quaternion(), input: null });
      const end = find(`Foot.${side}`);
      const modelQ = model.getWorldQuaternion(new THREE.Quaternion()).invert();
      legs.push({ side, upper: find(`Thigh.${side}`), lower: find(`Shin.${side}`), end,
        rest: end ? model.worldToLocal(end.getWorldPosition(new THREE.Vector3())) : new THREE.Vector3(),
        restQ: end ? modelQ.multiply(end.getWorldQuaternion(new THREE.Quaternion())) : new THREE.Quaternion(),
        planted: new THREE.Vector3(), start: new THREE.Vector3(), goal: new THREE.Vector3(), swinging: false });
    }
    fallback.visible = false;
    console.info(`[avatar] ${variant} Moon Rabbit ready`);
    return model;
  }).catch((error) => {
    model?.removeFromParent(); model = null;
    console.warn('[avatar] rabbit asset unavailable; using the simple bunny', error.message);
    return null;
  });

  return {
    object3d: root, ready,
    get headPosition() { return root.visible ? position : null; },
    get walking() { return walkBlend > 0.1; },
    set(pose, now, kine = null, inputs = {}) {
      if (!pose || pose.length < 7 || !pose.every(Number.isFinite)) return;
      targetP.fromArray(pose); targetQ.fromArray(pose, 3).normalize(); heldKine = kine; effectors = inputs ?? {};
      if (now - seen > STALE || position.distanceTo(targetP) > 1) {
        position.copy(targetP); previous.copy(targetP); orientation.copy(targetQ); velocity.set(0, 0, 0);
        resetFeet = true; bodyYaw = null; gaitPhase = 0; walkBlend = 0;
      }
      seen = now;
    },
    update(now, dt) {
      root.visible = now - seen < STALE;
      for (const { side, mesh } of controllerPaws) {
        const input = effectors[side];
        mesh.visible = root.visible && input?.kind === 'controller' && input.pose?.length === 7 && input.pose.every(Number.isFinite);
        if (mesh.visible) { mesh.position.fromArray(input.pose); mesh.quaternion.fromArray(input.pose, 3); }
      }
      if (!root.visible) return;
      const blend = 1 - Math.exp(-dt * 20);
      previous.copy(position);
      position.lerp(targetP, blend); orientation.slerp(targetQ, blend);
      travel.subVectors(position, previous).setY(0);
      const speed = dt > 0 ? Math.min(3.5, travel.length() / dt) : 0;
      velocity.lerp(dt > 0 ? travel.multiplyScalar(1 / dt) : travel, 1 - Math.exp(-dt * 10));
      const walking = velocity.length() > 0.12;
      walkBlend += ((walking ? 1 : 0) - walkBlend) * (1 - Math.exp(-dt * 10));
      if (walking) moveDirection.copy(velocity).normalize();
      scale ??= THREE.MathUtils.clamp(position.y, 1.25, 1.9) / MODEL_EYE_Y;
      visual.scale.setScalar(scale);
      forward.set(0, 0, -1).applyQuaternion(orientation);
      if (Math.hypot(forward.x, forward.z) > 0.05) lastYaw = Math.atan2(-forward.x, -forward.z);
      bodyYaw ??= lastYaw;
      const turn = Math.atan2(Math.sin(lastYaw - bodyYaw), Math.cos(lastYaw - bodyYaw));
      // A head turn stays in the neck. The torso follows gradually when walking or beyond 60 degrees.
      const torsoTurn = walking ? turn : Math.sign(turn) * Math.max(0, Math.abs(turn) - Math.PI / 3);
      bodyYaw += torsoTurn * (1 - Math.exp(-dt * 4));
      root.rotation.y = bodyYaw;
      eyeOffset.set(0, 0, -0.2 * scale).applyQuaternion(root.quaternion);
      root.position.set(position.x - eyeOffset.x, 0, position.z - eyeOffset.z);
      if (!model) { visual.position.y = position.y - MODEL_EYE_Y * scale; return; }
      visual.position.y = 0;
      for (const b of bind) { b.bone.position.copy(b.position); b.bone.quaternion.copy(b.quaternion); }
      // Crouch at the hips and bend the knees, rather than scaling the body every frame.
      hips.position.y += THREE.MathUtils.clamp((position.y - MODEL_EYE_Y * scale) / scale, -0.32, 0.15) - 0.035;
      root.updateMatrixWorld(true);
      const stride = 0.6 * scale;
      gaitPhase = (gaitPhase + dt * (walking ? Math.max(0.65, speed / stride) : walkBlend * 1.5)) % 1;
      for (const leg of legs) {
        foot.copy(leg.rest); model.localToWorld(foot);
        const phase = (gaitPhase + (leg.side === 'R' ? 0.5 : 0)) % 1;
        const swing = phase >= 0.5 && walkBlend > 0.05;
        if (resetFeet) { leg.planted.copy(foot); leg.goal.copy(foot); leg.swinging = false; }
        if (swing) {
          if (!leg.swinging) { leg.start.copy(leg.planted); leg.goal.copy(foot).addScaledVector(moveDirection, stride * 0.25); }
          const t = (phase - 0.5) * 2, eased = t * t * (3 - 2 * t);
          foot.lerpVectors(leg.start, leg.goal, eased); foot.y += Math.sin(t * Math.PI) * 0.075 * scale * walkBlend;
        } else {
          if (leg.swinging) leg.planted.copy(leg.goal);
          if (!walking) leg.planted.lerp(foot, 1 - Math.exp(-dt * 5));
          foot.copy(leg.planted);
        }
        leg.swinging = swing;
        pole.set(0, 0, -1).applyQuaternion(root.quaternion);
        solveLimb(leg.upper, leg.lower, leg.end, foot, pole);
        if (leg.end) { model.getWorldQuaternion(footQ).multiply(leg.restQ); orientBone(leg.end, footQ); }
      }
      resetFeet = false;
      // Asset faces +Z; the headset looks -Z. Eye offset is relative to the authored head bone.
      q.copy(orientation).multiply(FACE_CAMERA);
      eyeOffset.set(0, MODEL_EYE_Y - 1, 0.2).multiplyScalar(scale).applyQuaternion(q);
      target.copy(position).sub(eyeOffset);
      head.parent.worldToLocal(target); head.position.copy(target);
      head.parent.getWorldQuaternion(parentQ).invert(); head.quaternion.copy(parentQ).multiply(q);
      head.updateWorldMatrix(false, true);
      const remoteHands = hands?.hands?.filter((h) => h.remote && h.tracked) ?? [];
      for (const arm of arms) {
        if (!arm.upper || !arm.lower || !arm.end) continue;
        const side = arm.side === 'L' ? 'left' : 'right', input = effectors[side];
        const validInput = input?.pose?.length === 7 && input.pose.every(Number.isFinite);
        const hand = remoteHands.find((h) => {
          if (validInput && input.kind === 'hand' && Number.isInteger(input.slot)) return h.i === input.slot + 2;
          if (h.handedness) return h.handedness === (arm.side === 'L' ? 'left' : 'right');
          const wrist = h.joints.get('wrist');
          if (!wrist) return false;
          target.copy(wrist.center); model.worldToLocal(target);
          return (target.x >= 0) === (arm.side === 'L');
        });
        const wrist = hand?.joints.get('wrist');
        if (validInput) target.fromArray(input.pose);
        else if (wrist) target.copy(wrist.center);
        else if (heldKine) {
          // Controller poses are already represented by the shared mallet's grip origin.
          kinePosition.fromArray(heldKine);
          eyeOffset.set(1, 0, 0).applyQuaternion(root.quaternion);
          target.copy(kinePosition).addScaledVector(eyeOffset, arm.side === 'L' ? -0.055 : 0.055);
        } else {
          target.set(arm.side === 'L' ? 0.25 : -0.25, 0.5, 0.12); model.localToWorld(target);
        }
        pole.set(arm.side === 'L' ? -0.7 : 0.7, -1, 0.15).applyQuaternion(root.quaternion);
        const source = validInput ? input.kind : wrist ? 'hand' : heldKine ? 'kine' : 'rest';
        const sourceChanged = arm.input !== source;
        if (sourceChanged) { arm.target.copy(target); arm.input = source; } else arm.target.lerp(target, blend);
        solveLimb(arm.upper, arm.lower, arm.end, arm.target, pole);
        if (validInput) {
          pawQ.fromArray(input.pose, 3).normalize().multiply(GRIP_TO_PAW);
          if (sourceChanged) arm.rotation.copy(pawQ); else arm.rotation.slerp(pawQ, blend);
          orientBone(arm.end, arm.rotation);
        }
      }
      root.updateMatrixWorld(true);
    },
  };
}
