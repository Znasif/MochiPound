// The title screen's behaviour (index.html #overlay): side panels, option cards, keyboard navigation and
// full screen. It only drives the page's own controls: main.js still owns every control it reads (#start,
// #mp-role, #dough-quality, #song, #density, ...) and reacts to their usual events, so this file never
// needs to know what they do. The option cards mirror a hidden <select>: choosing one sets the select and
// fires its 'change' event, exactly as picking it from the select would.

import { createMenuScene } from './menuScene.js';
import { WORLDS, DEFAULT_WORLD, worldFromUrl, worldById } from './worlds.js';

const $ = (id) => document.getElementById(id);

// ---------- worlds (src/worlds.js) ----------
// This menu owns #world: it lists every world (one that isn't ready yet is shown, greyed, as coming soon)
// and picking one reloads the page with ?world=<id>, since main.js builds the world at load. Nothing here
// waits for main.js or for any world to load.
const worldSel = $('world');
for (const w of WORLDS) { const o = new Option(w.name, w.id); o.disabled = !w.ready; worldSel.add(o); }
worldSel.value = worldFromUrl().id;
worldSel.addEventListener('change', () => {
  const url = new URL(location.href);
  if (worldSel.value !== DEFAULT_WORLD) url.searchParams.set('world', worldSel.value); else url.searchParams.delete('world');
  location.replace(url.href);
});
const scene = createMenuScene(); // the pounding mortar (src/menuScene.js)
const overlay = $('overlay');
const menu = $('menu');
const panels = [...document.querySelectorAll('.panel')];
const items = () => [...menu.querySelectorAll('.mochi, #vr-slot button, #vr-slot a')].filter((el) => el.offsetParent !== null);

// ---------- panels ----------
let open = null;
const stage = document.querySelector('.stage');
function show(name) {
  for (const p of panels) p.classList.toggle('hidden', p.id !== `panel-${name}` || open === name);
  stage?.classList.toggle('panel-open', open !== name);
  for (const b of menu.querySelectorAll('[data-panel]')) b.classList.toggle('open', b.dataset.panel === name && open !== name);
  open = open === name ? null : name;
  if (open) { renderCards(); $(`panel-${open}`).querySelector('.card, select, button:not(.close)')?.focus({ preventScroll: true }); }
}
function closePanel() {
  if (!open) return false;
  const was = open;
  show(open); // toggles it shut
  menu.querySelector(`[data-panel="${was}"]`)?.focus({ preventScroll: true });
  return true;
}
menu.addEventListener('click', (e) => { const b = e.target.closest('[data-panel]'); if (b) show(b.dataset.panel); });
for (const c of document.querySelectorAll('[data-close]')) c.addEventListener('click', closePanel);
// once the mochi have dropped in, hovering makes them jiggle (index.html: .menu.settled)
setTimeout(() => menu.classList.add('settled'), 1300);

// ---------- option cards (mirroring hidden selects) ----------
const DETAIL = {
  'mp-role': {
    solo: ['Play alone', 'One headset (or a desktop browser).'],
    host: ['Host', 'This headset runs the dough and the music clock; the other headset joins. Either of you can pound or knead.'],
    join: ['Join', 'Join the host in the same room. Pick up the mallet when it’s free, or knead with your own hands.'],
    watch: ['Film camera', 'On a laptop: see the host’s world with both players and fly a free camera for videos. Changes nothing in the game.'],
  },
  world: Object.fromEntries(WORLDS.map((w) => [w.id, [w.name, w.ready ? w.blurb : `${w.blurb} Coming soon.`]])),
};
function cardText(selectId, opt) {
  const d = DETAIL[selectId]?.[opt.value];
  if (d) return d;
  // dough quality: "Dough: full (~2,900 particles, 2.5 cm grid)" -> "Full" + the rest
  const m = opt.textContent.match(/^Dough:\s*([^(]+)(\((.*)\))?/);
  if (m) {
    const name = m[1].trim();
    return [name.charAt(0).toUpperCase() + name.slice(1), m[3] ?? ''];
  }
  return [opt.textContent, ''];
}
function renderCards() {
  for (const box of document.querySelectorAll('[data-cards-for]')) {
    const sel = $(box.dataset.cardsFor);
    if (!sel) continue;
    box.replaceChildren();
    for (const opt of sel.options) {
      const [title, sub] = cardText(sel.id, opt);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'card' + (opt.value === sel.value ? ' on' : '');
      b.disabled = sel.disabled || opt.disabled;
      const t = document.createElement('b'); t.textContent = title; b.append(t);
      if (sub) { const s = document.createElement('span'); s.textContent = sub; b.append(s); }
      b.addEventListener('click', () => {
        if (sel.value === opt.value) return;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        renderCards();
        updateValues();
      });
      box.append(b);
    }
  }
}

// ---------- the small values beside the menu items ----------
// (written only when they change: this runs from a MutationObserver on the overlay, and every write is a
// mutation, so unconditional writes would call it forever)
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
function updateValues() {
  setText($('v-worlds'), worldById(worldSel.value)?.name.replace(/ (courtyard|garden)$/i, '') ?? '');
  const mp = $('mp-role');
  setText($('v-players'), { solo: 'Alone', host: 'Host', join: 'Join', watch: 'Camera' }[mp?.value] ?? '');
  const q = $('dough-quality');
  setText($('v-settings'), q?.value ? `dough ${q.value}` : 'dough auto');
}
for (const id of ['mp-role', 'dough-quality', 'world']) $(id)?.addEventListener('change', updateValues);
// main.js fills the quality tiers after load
new MutationObserver(updateValues).observe(overlay, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
updateValues();

// three's VR button: dimmed when this browser can't enter VR
const vr = $('vr-slot');
new MutationObserver(() => vr.classList.toggle('unsupported', /not|needed/i.test(vr.textContent))).observe(vr, { subtree: true, childList: true, characterData: true });

// ---------- full screen ----------
const fsBtn = $('fullscreen');
function wantFullscreen() {
  if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else wantFullscreen();
}
fsBtn.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  fsBtn.innerHTML = document.fullscreenElement ? '&#x2715;' : '&#x26F6;';
  fsBtn.title = document.fullscreenElement ? 'Leave full screen (F)' : 'Full screen (F)';
});
if (!document.documentElement.requestFullscreen) fsBtn.classList.add('hidden');
// pressing Play: one big strike as the menu fades into the garden, and full screen (inside the same click,
// before main.js locks the pointer)
$('start').addEventListener('click', () => { closePanel(); scene?.bigStrike(); wantFullscreen(); }, true);

// ---------- keyboard ----------
addEventListener('keydown', (e) => {
  if (overlay.classList.contains('hidden')) return;
  if (e.key === 'Escape') { if (closePanel()) e.preventDefault(); return; }
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const list = open ? [...$(`panel-${open}`).querySelectorAll('.card, select, .filebtn, button.close')] : items();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const next = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
    (next.classList.contains('filebtn') ? next.querySelector('input') ?? next : next).focus({ preventScroll: true });
    e.preventDefault();
  } else if (e.key === 'ArrowLeft' && open) { closePanel(); e.preventDefault(); }
});
// Play takes the keyboard focus once it's ready (it's disabled while the sound loads), so Enter plays
const start = $('start');
new MutationObserver(() => {
  if (!start.disabled && (document.activeElement === document.body || !document.activeElement)) start.focus({ preventScroll: true });
}).observe(start, { attributes: true, attributeFilter: ['disabled'] });
