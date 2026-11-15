// Rigged Moon Rabbit players: separate headset and left/right inputs, two-bone limb IK, procedural steps
// (planted feet that step when the body moves or turns away from them), and a torso that lets the neck turn
// independently.
import * as THREE from 'three';
import { removeAuthoredRabbitHands } from './pawVisual.js';
import { createControllerHand, handleFrame, CONTROLLER_WRIST } from './hands.js';

const STALE = 2.5, MODEL_EYE_Y = 1.16;
const FACE_CAMERA = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
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

// Turn a bone (at most maxAngle) so that its child `end` points toward a world target. Own scratch quaternions:
// the caller's q is in use.
const bq = new THREE.Quaternion(), bq2 = new THREE.Quaternion(), IDENTITY = new THREE.Quaternion();
function bendToward(bone, end, target, maxAngle) {
  bone.getWorldPosition(p0); end.getWorldPosition(p1);
  dir.subVectors(p1, p0); axis.subVectors(target, p0);
  if (dir.lengthSq() < 1e-8 || axis.lengthSq() < 1e-8) return;
  bq.setFromUnitVectors(dir.normalize(), axis.normalize());
  const angle = 2 * Math.acos(Math.min(1, Math.abs(bq.w)));
  if (angle > maxAngle) bq.slerp(IDENTITY, 1 - maxAngle / angle);
  bone.getWorldQuaternion(bq2).premultiply(bq);
  bone.parent.getWorldQuaternion(parentQ).invert();
  bone.quaternion.copy(parentQ).multiply(bq2); bone.updateWorldMatrix(false, true);
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

// slotBase: the first of this person's two remote hand slots in `hands` (2; 4 for the film camera's second player).
// kine: () => the station's mallet, so a controller hand of this person's that holds it wraps its handle
export function createRabbitAvatar(scene, { variant = 'indigo', hands, slotBase = 2, kine = null, load = loadRabbit } = {}) {
  const root = new THREE.Group(); root.name = 'other-player'; root.visible = false; scene.add(root);
  const visual = new THREE.Group(); visual.rotation.y = Math.PI; root.add(visual);
  const fallback = fallbackRabbit(variant); visual.add(fallback);
  let model = null, bones = [], bind = [], head = null, hips = null, torso = null, scale = null, seen = -Infinity, lastYaw = 0;
  let bodyYaw = null, walkBlend = 0, walking = false, stillFor = 0, lastStep = null, resetFeet = true;
  const arms = [], legs = [];
  // the other person's controllers: the same hand as their tracked hands (src/hands.js), at each grip
  const controllerPaws = ['left', 'right'].map((side) => ({ side, hand: createControllerHand(), held: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), radius: 0 } }));
  const gripM = new THREE.Matrix4(), ONE = new THREE.Vector3(1, 1, 1), contactShift = new THREE.Vector3();
  for (const paw of controllerPaws) scene.add(paw.hand.object3d);
  const position = new THREE.Vector3(), targetP = new THREE.Vector3(), targetQ = new THREE.Quaternion(), orientation = new THREE.Quaternion();
  const forward = new THREE.Vector3(), eyeOffset = new THREE.Vector3(), target = new THREE.Vector3(), pole = new THREE.Vector3();
  const foot = new THREE.Vector3(), kinePosition = new THREE.Vector3();
  const previous = new THREE.Vector3(), velocity = new THREE.Vector3(), travel = new THREE.Vector3();
  const bodyPrev = new THREE.Vector3(), lead = new THREE.Vector3(), support = new THREE.Vector3(), modelQ = new THREE.Quaternion();
  const moveDirection = new THREE.Vector3(0, 0, -1), pawQ = new THREE.Quaternion(), footQ = new THREE.Quaternion();
  let heldKine = null, effectors = {}, exact = false;

  const ready = load(variant).then((loaded) => {
    model = loaded; removeAuthoredRabbitHands(model); visual.add(model);
    model.traverse((o) => {
      if (o.isBone) bones.push(o);
      if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
    });
    bind = bones.map((bone) => ({ bone, position: bone.position.clone(), quaternion: bone.quaternion.clone() }));
    const find = (name) => bones.find((bone) => canonical(bone.name) === canonical(name));
    head = find('head'); hips = find('hips'); torso = find('torso');
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
        planted: new THREE.Vector3(), start: new THREE.Vector3(), goal: new THREE.Vector3(), neutral: new THREE.Vector3(), yaw: 0, swing: null });
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
    get exact() { return exact; },
    set exact(v) { exact = !!v; },
    get walking() { return walkBlend > 0.1; },
    set(pose, now, kine = null, inputs = {}) {
      if (!pose || pose.length < 7 || !pose.every(Number.isFinite)) return;
      targetP.fromArray(pose); targetQ.fromArray(pose, 3).normalize(); heldKine = kine; effectors = inputs ?? {};
      if (now - seen > STALE || position.distanceTo(targetP) > 1) {
        position.copy(targetP); previous.copy(targetP); orientation.copy(targetQ); velocity.set(0, 0, 0);
        resetFeet = true; bodyYaw = null; walkBlend = 0; walking = false; stillFor = 0;
      }
      seen = now;
    },
    update(now, dt) {
      root.visible = now - seen < STALE;
      for (const { side, hand, held } of controllerPaws) {
        const input = effectors[side], mesh = hand.object3d;
        mesh.visible = root.visible && input?.kind === 'controller' && input.pose?.length === 7 && input.pose.every(Number.isFinite);
        if (mesh.visible) {
          mesh.position.fromArray(input.pose); mesh.quaternion.fromArray(input.pose, 3).normalize();
          // holding the mallet (it's posed from this person's pose here): the hand within 15 cm of its handle wraps it
          let frame = null;
          const tool = heldKine ? kine?.() : null;
          if (tool) {
            frame = handleFrame(tool, gripM.compose(mesh.position, mesh.quaternion, ONE).invert(), held);
            if (frame && frame.position.length() > 0.15) frame = null;
          }
          hand.update(dt, Array.isArray(input.curl) ? input.curl : [0, 0, 1], side, frame);
          // out of anything solid, as their own headset draws it (src/handContact.js)
          if (hands?.contact && hands.contact.resolve(hand.worldPoints(), hand.radii(), contactShift) > 0) hand.nudge(contactShift);
        }
      }
      if (!root.visible) return;
      const blend = exact ? 1 : 1 - Math.exp(-dt * 20); // exact: a film playback, already smooth and on time
      previous.copy(position);
      position.lerp(targetP, blend); orientation.slerp(targetQ, blend);
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
      // Where the feet belong (the support point): under the head, 20 cm behind the eyes. Leaning in over the
      // mortar (the head dipping and looking down) bends the body forward over the feet instead of moving them,
      // so that part of the head's forward travel is discounted. Squatting (dipping while looking ahead) keeps
      // the feet and sits the hips back. The torso bends toward the head either way (below).
      const dip = THREE.MathUtils.clamp(MODEL_EYE_Y * scale - position.y, 0, 0.5);
      const lookDown = THREE.MathUtils.clamp((-Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)) - 0.35) / 0.5, 0, 1);
      // (tuned on the real rig, .tmp/gait/compare.mjs: leaning keeps the feet planted and the neck within ~9 cm)
      const hipsBack = 0.15 * dip * (1 - 0.7 * lookDown);
      eyeOffset.set(0, 0, -(0.2 * scale + 0.2 * dip * lookDown)).applyQuaternion(root.quaternion);
      support.set(position.x - eyeOffset.x, 0, position.z - eyeOffset.z);
      eyeOffset.set(0, 0, -hipsBack).applyQuaternion(root.quaternion);
      root.position.copy(support).sub(eyeOffset);
      // Walking is the support point's travel on the ground, not the head's (looking around, swaying and
      // leaning in aren't), with some hysteresis so it doesn't flicker at the threshold.
      if (resetFeet) bodyPrev.copy(support);
      travel.subVectors(support, bodyPrev); bodyPrev.copy(support);
      if (dt > 0) velocity.lerp(travel.multiplyScalar(1 / dt), 1 - Math.exp(-dt * 8));
      if (resetFeet) velocity.set(0, 0, 0);
      if (velocity.length() > 3.5) velocity.setLength(3.5);
      const speed = velocity.length();
      walking = speed > (walking ? 0.12 : 0.22);
      walkBlend += ((walking ? 1 : 0) - walkBlend) * (1 - Math.exp(-dt * 10));
      if (speed > 0.05) moveDirection.copy(velocity).normalize();
      stillFor = speed < 0.05 ? stillFor + dt : 0;
      if (!model) { visual.position.y = position.y - MODEL_EYE_Y * scale; return; }
      visual.position.y = 0;
      for (const b of bind) { b.bone.position.copy(b.position); b.bone.quaternion.copy(b.quaternion); }
      // Crouch at the hips and bend the knees, rather than scaling the body every frame; leaning in drops the hips
      // less (the torso bends instead).
      hips.position.y += THREE.MathUtils.clamp((position.y - MODEL_EYE_Y * scale) * (1 - 0.7 * lookDown) / scale, -0.32, 0.15) - 0.035;
      root.updateMatrixWorld(true);
      model.getWorldQuaternion(modelQ);
      // Procedural stepping. Each foot stays planted on the ground until the body has moved or turned too far from
      // it, then steps to where it will rest under the body when it lands: half a step ahead of its rest spot
      // along the body's travel, so it passes under the hip mid-stance. One foot at a time, so walking
      // alternates by itself and its rhythm follows the speed. Standing still, a foot left off-centre settles.
      // each foot's rest spot: its authored stance around the support point (the hips may sit back of it)
      lead.set(0, 0, -hipsBack).applyQuaternion(root.quaternion);
      for (const leg of legs) { leg.neutral.copy(leg.rest); model.localToWorld(leg.neutral).add(lead); }
      if (resetFeet) for (const leg of legs) { leg.planted.copy(leg.neutral); leg.yaw = bodyYaw; leg.swing = null; }
      const reach = 0.45 * scale;
      if (!legs.some((leg) => leg.swing)) {
        let pick = null, worst = 0;
        for (const leg of legs) {
          const err = Math.hypot(leg.planted.x - leg.neutral.x, leg.planted.z - leg.neutral.z) / scale;
          const yawErr = Math.abs(Math.atan2(Math.sin(bodyYaw - leg.yaw), Math.cos(bodyYaw - leg.yaw)));
          const lean = 0.6 * dip * lookDown / scale; // leaning in reaches further before a step
          const need = err > 0.16 + lean || yawErr > 0.6 || (stillFor > 0.5 && (err > 0.05 + lean || yawErr > 0.25));
          const score = err + 0.2 * yawErr - (leg === lastStep ? 0.02 : 0); // alternate when it's a near thing
          if (need && score > worst) { worst = score; pick = leg; }
        }
        if (pick) {
          const far = Math.hypot(pick.planted.x - pick.neutral.x, pick.planted.z - pick.neutral.z) > reach;
          pick.start.copy(pick.planted);
          pick.swing = { t: 0, fromYaw: pick.yaw, duration: far ? 0.14 : THREE.MathUtils.clamp(0.3 - 0.06 * speed, 0.18, 0.3) };
        }
      }
      for (const leg of legs) {
        let yaw = leg.yaw;
        if (leg.swing) {
          const sw = leg.swing;
          sw.t = Math.min(1, sw.t + dt / sw.duration);
          // aimed where its rest spot will be at landing, plus half a step: re-aimed every frame, so turns and
          // speed changes during the step are followed
          lead.copy(velocity).multiplyScalar(sw.duration * (1 - sw.t) + sw.duration * 0.5);
          if (lead.length() > reach) lead.setLength(reach);
          leg.goal.copy(leg.neutral).add(lead); leg.goal.y = leg.neutral.y;
          const e = sw.t * sw.t * (3 - 2 * sw.t);
          foot.lerpVectors(leg.start, leg.goal, e);
          foot.y += Math.sin(sw.t * Math.PI) * (0.05 + 0.03 * Math.min(1, speed)) * scale;
          yaw = sw.fromYaw + Math.atan2(Math.sin(bodyYaw - sw.fromYaw), Math.cos(bodyYaw - sw.fromYaw)) * e;
          if (sw.t >= 1) { leg.planted.copy(leg.goal); leg.yaw = bodyYaw; leg.swing = null; lastStep = leg; }
        } else foot.copy(leg.planted);
        // the knee points the way its foot does; a planted foot keeps its own direction on the ground
        pole.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        solveLimb(leg.upper, leg.lower, leg.end, foot, pole);
        if (leg.end) { footQ.setFromAxisAngle(Y_AXIS, yaw - bodyYaw).multiply(modelQ).multiply(leg.restQ); orientBone(leg.end, footQ); }
      }
      resetFeet = false;
      // Asset faces +Z; the headset looks -Z. Eye offset is relative to the authored head bone.
      q.copy(orientation).multiply(FACE_CAMERA);
      eyeOffset.set(0, MODEL_EYE_Y - 1, 0.2).multiplyScalar(scale).applyQuaternion(q);
      target.copy(position).sub(eyeOffset);
      // the torso bends toward where the head is (leaning in, squatting; at most 60 degrees), so the neck doesn't stretch
      if (torso) bendToward(torso, head, target, 1.05);
      head.parent.worldToLocal(target); head.position.copy(target);
      head.parent.getWorldQuaternion(parentQ).invert(); head.quaternion.copy(parentQ).multiply(q);
      head.updateWorldMatrix(false, true);
      const mine = (h) => !Number.isInteger(h.i) || (h.i >= slotBase && h.i < slotBase + 2); // this person's slots
      const remoteHands = hands?.hands?.filter((h) => h.remote && h.tracked && mine(h)) ?? [];
      for (const arm of arms) {
        if (!arm.upper || !arm.lower || !arm.end) continue;
        const side = arm.side === 'L' ? 'left' : 'right', input = effectors[side];
        const validInput = input?.pose?.length === 7 && input.pose.every(Number.isFinite);
        const hand = remoteHands.find((h) => {
          if (validInput && input.kind === 'hand' && Number.isInteger(input.slot)) return h.i === input.slot + slotBase;
          if (h.handedness) return h.handedness === (arm.side === 'L' ? 'left' : 'right');
          const wrist = h.joints.get('wrist');
          if (!wrist) return false;
          target.copy(wrist.center); model.worldToLocal(target);
          return (target.x >= 0) === (arm.side === 'L');
        });
        const wrist = hand?.joints.get('wrist');
        if (validInput) {
          target.fromArray(input.pose);
          // a controller's pose is its grip (the middle of the fist): the forearm ends at the drawn hand's wrist
          if (input.kind === 'controller') target.add(bend.set(CONTROLLER_WRIST[0] * (side === 'left' ? -1 : 1), CONTROLLER_WRIST[1], CONTROLLER_WRIST[2]).applyQuaternion(rotation.fromArray(input.pose, 3).normalize()));
        }
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
