// The title screen's pounding scene (index.html #scene): a mortar with a lump of mochi, the kine (mallet)
// and the kneader's hand, animated with the Web Animations API.
//   - On its own, the kine strikes every few seconds and the hand pats the dough in between, as the two
//     players do in the game.
//   - Tap the mochi (or focus it and press Enter / Space) to strike it yourself, with a small synthesized
//     "pon". Each strike makes the lump smoother and glossier; after six it's done ("できた!"), floats up
//     and a fresh, grainy lump drops in, which is the whole game in five seconds.
//   - Play gets one big strike as the menu fades into the garden (bigStrike).
// Each strike: the kine swings down (ease-in) about its grip, the mochi squashes and wobbles back, the
// mortar jolts, steam puffs and rice grains fly, and "ぺったん!" (pettan, the pounding call) pops up.

const NS = 'http://www.w3.org/2000/svg';
const RAISED = 'rotate(30deg)'; // the kine at rest, lifted (index.html #kine, pivot at the grip)

export function createMenuScene() {
  const svg = document.getElementById('scene');
  if (!svg || !svg.animate) return null;
  const q = (s) => svg.querySelector(s);
  const kine = q('#kine'), mochi = q('#mochi'), usu = q('#usu'), hand = q('#hand');
  const grains = q('#grains'), gloss = q('#mochi-gloss'), fx = q('#fx'), pettan = q('#pettan'), doneMsg = q('#done-msg');
  const hint = document.getElementById('hint'), overlay = document.getElementById('overlay');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let busy = false, smooth = 0, side = 1, ctx = null, userUntil = 0;

  function setSmooth(v) {
    smooth = v;
    grains.style.opacity = String(Math.max(0, 1 - v * 1.15));
    gloss.setAttribute('opacity', String(0.25 + 0.65 * v));
  }

  // a soft thump for a strike you made (a pitched-down sine and a short, muffled noise burst)
  function pon(strength) {
    try {
      ctx ??= new AudioContext();
      if (ctx.state === 'suspended') ctx.resume();
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(200, t);
      o.frequency.exponentialRampToValueAtTime(58, t + 0.15);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.45 * strength, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.26);
      const len = Math.floor(ctx.sampleRate * 0.07), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      const n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), ng = ctx.createGain();
      n.buffer = buf; f.type = 'lowpass'; f.frequency.value = 850; ng.gain.value = 0.3 * strength;
      n.connect(f).connect(ng).connect(ctx.destination);
      n.start(t);
    } catch { /* no audio: fine */ }
  }

  function puffs(k) {
    for (let i = 0; i < 4; i++) {
      const x = 176 + i * 22 + (Math.random() - 0.5) * 8, c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', 204); c.setAttribute('r', 9); c.setAttribute('fill', 'rgba(255,255,255,0.8)');
      c.style.transformOrigin = `${x}px 204px`;
      fx.append(c);
      const a = c.animate([
        { transform: 'translate(0, 0) scale(0.6)', opacity: 0.85 },
        { transform: `translate(${(x - 210) * 0.9}px, ${-24 - Math.random() * 16}px) scale(${2.1 * k})`, opacity: 0 },
      ], { duration: 720, easing: 'cubic-bezier(.2,.7,.3,1)' });
      a.onfinish = () => c.remove();
    }
  }
  function flyingGrains(k) {
    const n = Math.round(7 * k);
    for (let i = 0; i < n; i++) {
      const x0 = 182 + Math.random() * 56, e = document.createElementNS(NS, 'ellipse');
      e.setAttribute('cx', x0); e.setAttribute('cy', 206); e.setAttribute('rx', 3.2); e.setAttribute('ry', 1.7); e.setAttribute('fill', '#fffaf0');
      e.style.transformOrigin = `${x0}px 206px`;
      fx.append(e);
      const vx = (x0 - 210) * 2.6 + (Math.random() - 0.5) * 60, vy = -(55 + Math.random() * 70) * k, spin = (Math.random() - 0.5) * 720;
      const frames = [];
      for (let s = 0; s <= 8; s++) { const t = s / 8; frames.push({ transform: `translate(${vx * t}px, ${vy * t + 280 * t * t}px) rotate(${spin * t}deg)`, opacity: t < 0.75 ? 1 : 0 }); }
      const a = e.animate(frames, { duration: 760 });
      a.onfinish = () => e.remove();
    }
  }
  function pop(big) {
    side = -side;
    const x = 210 + side * 78;
    pettan.setAttribute('x', String(x));
    pettan.textContent = big ? 'ぺったん!!' : 'ぺったん!';
    pettan.style.transformOrigin = `${x}px 88px`;
    pettan.animate([
      { opacity: 0, transform: 'scale(0.5) rotate(0deg)' },
      { opacity: 1, transform: `scale(${big ? 1.35 : 1.15}) rotate(${side * 7}deg)`, offset: 0.22 },
      { opacity: 1, transform: `scale(1) rotate(${side * 4}deg)`, offset: 0.6 },
      { opacity: 0, transform: `translateY(-12px) scale(1) rotate(${side * 4}deg)` },
    ], { duration: 850, easing: 'ease-out' });
  }
  function sparkles() {
    for (let i = 0; i < 9; i++) {
      const a0 = (i / 9) * Math.PI * 2, x = 210 + Math.cos(a0) * 40, y = 205 + Math.sin(a0) * 18, s = document.createElementNS(NS, 'path');
      s.setAttribute('d', `M${x} ${y - 6} L${x + 1.6} ${y - 1.6} L${x + 6} ${y} L${x + 1.6} ${y + 1.6} L${x} ${y + 6} L${x - 1.6} ${y + 1.6} L${x - 6} ${y} L${x - 1.6} ${y - 1.6} Z`);
      s.setAttribute('fill', '#ffe7a3');
      s.style.transformOrigin = `${x}px ${y}px`;
      fx.append(s);
      const a = s.animate([
        { transform: 'translate(0,0) scale(0)', opacity: 1 },
        { transform: `translate(${Math.cos(a0) * 50}px, ${Math.sin(a0) * 34 - 30}px) scale(1.3) rotate(90deg)`, opacity: 1, offset: 0.6 },
        { transform: `translate(${Math.cos(a0) * 64}px, ${Math.sin(a0) * 44 - 40}px) scale(0.4) rotate(180deg)`, opacity: 0 },
      ], { duration: 1100, easing: 'ease-out' });
      a.onfinish = () => s.remove();
    }
  }

  function impact(big, user) {
    const k = big ? 1.4 : 1;
    mochi.animate([
      { transform: 'scale(1, 1)' },
      { transform: `scale(${1 + 0.24 * k}, ${1 - 0.3 * k})`, offset: 0.12 },
      { transform: 'scale(0.92, 1.12)', offset: 0.38 },
      { transform: 'scale(1.04, 0.96)', offset: 0.62 },
      { transform: 'scale(1, 1)' },
    ], { duration: 680, easing: 'ease-out' });
    usu.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${2.4 * k}px) scale(1.01, 0.99)`, offset: 0.2 }, { transform: 'translateY(0)' }], { duration: 240 });
    puffs(k); flyingGrains(k); pop(big);
    if (user) pon(big ? 1 : 0.8);
    if (big) return;
    setSmooth(Math.min(1, smooth + 1 / 6));
    if (smooth >= 1) setTimeout(finishBatch, 650);
  }

  // a strike: down onto the mochi, a moment pressed in, then lifted again
  function strike({ big = false, user = false } = {}) {
    if (busy) return false;
    busy = true;
    const down = big ? 170 : reduce ? 120 : 250, hold = 130, lift = big ? 420 : 680, total = down + hold + lift;
    kine.animate([
      { transform: RAISED, easing: 'cubic-bezier(.6,0,1,.55)' },
      { transform: 'rotate(0deg)', offset: down / total },
      { transform: 'rotate(0deg)', offset: (down + hold) / total, easing: 'cubic-bezier(.25,.7,.3,1)' },
      { transform: RAISED },
    ], { duration: total });
    setTimeout(() => impact(big, user), down);
    setTimeout(() => { busy = false; }, total);
    return true;
  }
  // between strikes the kneader's hand (wet, from the left) presses and turns the dough
  function pat() {
    if (busy || reduce) return;
    busy = true;
    hand.animate([
      { transform: 'translate(-150px, 6px)' },
      { transform: 'translate(4px, 0px)', offset: 0.35, easing: 'ease-in' },
      { transform: 'translate(12px, 7px)', offset: 0.5 },
      { transform: 'translate(4px, 0px)', offset: 0.62 },
      { transform: 'translate(-150px, 6px)' },
    ], { duration: 900, easing: 'ease-out' });
    setTimeout(() => mochi.animate([{ transform: 'scale(1, 1)' }, { transform: 'scale(0.94, 1.06)', offset: 0.4 }, { transform: 'scale(1, 1)' }], { duration: 320 }), 420);
    setTimeout(() => { busy = false; }, 900);
  }
  // six strikes: done. It floats up and a fresh, grainy lump drops in
  function finishBatch() {
    busy = true;
    doneMsg.style.transformOrigin = '210px 150px';
    doneMsg.animate([
      { opacity: 0, transform: 'translateY(10px) scale(0.7)' },
      { opacity: 1, transform: 'translateY(0) scale(1.12)', offset: 0.28 },
      { opacity: 1, transform: 'translateY(-4px) scale(1)', offset: 0.75 },
      { opacity: 0, transform: 'translateY(-16px) scale(1)' },
    ], { duration: 1500, easing: 'ease-out' });
    sparkles();
    const up = mochi.animate([
      { transform: 'translateY(0) scale(1)', opacity: 1 },
      { transform: 'translateY(-26px) scale(1.06)', opacity: 1, offset: 0.4 },
      { transform: 'translateY(-70px) scale(0.55)', opacity: 0 },
    ], { duration: 800, easing: 'ease-in', fill: 'forwards' });
    up.onfinish = () => {
      setSmooth(0);
      up.cancel();
      mochi.animate([
        { transform: 'translateY(-170px) scale(0.9, 1.1)' },
        { transform: 'translateY(0) scale(1.18, 0.82)', offset: 0.65, easing: 'ease-out' },
        { transform: 'translateY(0) scale(0.96, 1.04)', offset: 0.85 },
        { transform: 'translateY(0) scale(1, 1)' },
      ], { duration: 650, easing: 'cubic-bezier(.55,0,.9,.6)' });
      setTimeout(() => { busy = false; }, 700);
    };
  }

  // tap the mochi to pound it yourself
  function userStrike() {
    userUntil = performance.now() + 4000; // the scene stops striking on its own for a while
    if (strike({ user: true }) && hint) hint.style.opacity = '0';
  }
  svg.addEventListener('pointerdown', (e) => { e.preventDefault(); userStrike(); });
  svg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); userStrike(); } });

  // on its own: strike, the hand pats, strike again; idle while the game is on
  let next = performance.now() + 900, patAt = Infinity;
  function tick(now) {
    requestAnimationFrame(tick);
    if (reduce || overlay.classList.contains('hidden') || now < userUntil) return;
    if (now >= next && strike()) { next = now + 2700; patAt = now + 1350; }
    else if (now >= patAt) { pat(); patAt = Infinity; }
  }
  requestAnimationFrame(tick);
  setSmooth(0);

  return {
    strike: userStrike,
    // Play: one big strike, whatever the scene was doing
    bigStrike() { if (!strike({ big: true, user: true })) impact(true, true); },
  };
}
