import * as THREE from 'three';

// Stylised people. Each figure has a body that can lean and crouch, and two arms solved with a
// two-bone IK every frame, so hands can hold the mallet, fold the dough, clap or rest.

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3(), tmpD = new THREE.Vector3(), tmpE = new THREE.Vector3();

const limbGeom = new THREE.CylinderGeometry(1, 1, 1, 8);
limbGeom.translate(0, 0.5, 0); // origin at one end, so a limb is scaled along +Y from its root
const sphereGeom = new THREE.SphereGeometry(1, 14, 10);

function placeLimb(mesh, from, to, radius) {
  tmpA.subVectors(to, from);
  const len = tmpA.length();
  mesh.position.copy(from);
  mesh.scale.set(radius, Math.max(len, 1e-4), radius);
  mesh.quaternion.setFromUnitVectors(UP, tmpA.normalize());
}

export function createFigure(scene, {
  coat = 0x223355, trim = 0xf2efe8, pants = 0x1a1a22, skin = 0xe6c3a0, hair = 0x15110f,
  headband = false, scarf = null, scale = 1, kneel = false,
} = {}) {
  const root = new THREE.Group();
  scene.add(root);
  const body = new THREE.Group();
  root.add(body);
  const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
  const mCoat = lam(coat), mTrim = lam(trim), mPants = lam(pants), mSkin = lam(skin), mHair = lam(hair);

  const s = scale;
  const hipY = kneel ? 0.42 * s : 0.9 * s;
  // legs
  const legs = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(limbGeom, mPants);
    leg.castShadow = true;
    scene.add(leg); // world space, like the arms: update() places it from world hip and foot points
    legs.push({ mesh: leg, side });
  }
  // torso: a tapered coat with a trim band (happi coats have a contrasting collar)
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.17 * s, 0.22 * s, 0.62 * s, 12), mCoat);
  torso.position.y = hipY + 0.31 * s;
  torso.castShadow = true;
  body.add(torso);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.15 * s, 0.03 * s, 6, 16), mTrim);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = hipY + 0.6 * s;
  body.add(collar);
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.215 * s, 0.215 * s, 0.07 * s, 12), mTrim);
  belt.position.y = hipY + 0.08 * s;
  body.add(belt);
  if (scarf) {
    const sc = new THREE.Mesh(new THREE.TorusGeometry(0.11 * s, 0.05 * s, 6, 14), lam(scarf));
    sc.rotation.x = Math.PI / 2;
    sc.position.y = hipY + 0.66 * s;
    body.add(sc);
  }
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * s, 0.06 * s, 0.1 * s, 8), mSkin);
  neck.position.y = hipY + 0.67 * s;
  body.add(neck);
  const head = new THREE.Group();
  head.position.y = hipY + 0.82 * s;
  body.add(head);
  const skull = new THREE.Mesh(sphereGeom, mSkin);
  skull.scale.set(0.11 * s, 0.13 * s, 0.115 * s);
  skull.castShadow = true;
  head.add(skull);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), mHair);
  hairCap.scale.set(0.118 * s, 0.135 * s, 0.122 * s);
  hairCap.position.y = 0.01 * s;
  hairCap.rotation.x = 0.25;
  head.add(hairCap);
  if (headband) {
    const hb = new THREE.Mesh(new THREE.TorusGeometry(0.117 * s, 0.018 * s, 6, 18), mTrim);
    hb.rotation.x = Math.PI / 2 - 0.15;
    hb.position.y = 0.04 * s;
    head.add(hb);
  }
  // shoulders (children of the body, so they follow its lean)
  const shoulders = [new THREE.Object3D(), new THREE.Object3D()];
  shoulders[0].position.set(-0.21 * s, hipY + 0.55 * s, 0);
  shoulders[1].position.set(0.21 * s, hipY + 0.55 * s, 0);
  body.add(shoulders[0], shoulders[1]);
  const arms = shoulders.map(() => {
    const upper = new THREE.Mesh(limbGeom, mCoat);
    const lower = new THREE.Mesh(limbGeom, mCoat);
    const hand = new THREE.Mesh(sphereGeom, mSkin);
    hand.scale.setScalar(0.045 * s);
    upper.castShadow = lower.castShadow = true;
    scene.add(upper, lower, hand);
    return { upper, lower, hand, target: new THREE.Vector3(), elbow: new THREE.Vector3() };
  });
  const upperLen = 0.3 * s, lowerLen = 0.3 * s;

  const fig = {
    root, body, head, arms, scale: s, hipY, kneel,
    lean: 0, crouch: 0, walk: 0, walkPhase: 0,
    // world-space hand targets; set them every frame before update()
    hands: [new THREE.Vector3(), new THREE.Vector3()],
    elbowOut: 0.6,
    restHands() {
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1;
        tmpB.set(side * 0.27 * s, hipY + 0.02 * s, 0.05 * s);
        this.hands[i].copy(root.localToWorld(tmpB));
      }
    },
    handsAt(local0, local1) { // targets in the figure's own frame (x right, y up, z forward)
      this.hands[0].copy(root.localToWorld(tmpB.set(local0[0], local0[1], local0[2])));
      this.hands[1].copy(root.localToWorld(tmpB.set(local1[0], local1[1], local1[2])));
    },
    update() {
      body.rotation.x = this.lean;
      body.position.y = -this.crouch;
      root.updateMatrixWorld(true);
      // legs: from each hip to the ground (or folded under, kneeling)
      for (const l of legs) {
        const hip = root.localToWorld(tmpA.set(l.side * 0.09 * s, hipY - this.crouch, 0));
        const swing = Math.sin(this.walkPhase + (l.side > 0 ? Math.PI : 0)) * this.walk;
        const foot = kneel
          ? root.localToWorld(tmpB.set(l.side * 0.1 * s, 0.06 * s, -0.36 * s))
          : root.localToWorld(tmpB.set(l.side * 0.11 * s, Math.max(0, swing) * 0.07 * s, 0.02 * s + swing * 0.2 * s));
        placeLimb(l.mesh, foot, hip, 0.07 * s);
      }
      for (let i = 0; i < 2; i++) {
        const arm = arms[i];
        const sh = shoulders[i].getWorldPosition(tmpC);
        const target = this.hands[i];
        // two-bone IK: elbow on the circle where the bones meet, nudged outward and down
        tmpA.subVectors(target, sh);
        let d = tmpA.length();
        const maxD = upperLen + lowerLen - 1e-3;
        if (d > maxD) { tmpA.multiplyScalar(maxD / d); d = maxD; target.copy(sh).add(tmpA); }
        d = Math.max(d, 0.05);
        const x = (upperLen * upperLen - lowerLen * lowerLen + d * d) / (2 * d);
        const h = Math.sqrt(Math.max(0, upperLen * upperLen - x * x));
        const dir = tmpE.copy(tmpA).normalize();
        const side = i === 0 ? -1 : 1;
        // pole: outward from the body and downward
        tmpD.set(side * this.elbowOut, -1, -0.2).applyQuaternion(root.quaternion);
        tmpD.addScaledVector(dir, -tmpD.dot(dir)).normalize();
        arm.elbow.copy(sh).addScaledVector(dir, x).addScaledVector(tmpD, h);
        placeLimb(arm.upper, sh, arm.elbow, 0.055 * s);
        placeLimb(arm.lower, arm.elbow, target, 0.045 * s);
        arm.hand.position.copy(target);
      }
    },
    setVisible(v) {
      root.visible = v;
      for (const a of arms) a.upper.visible = a.lower.visible = a.hand.visible = v;
      for (const l of legs) l.mesh.visible = v;
    },
  };
  fig.restHands();
  return fig;
}
