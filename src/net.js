// Multiplayer link (2026-11-15): two headsets on the same dev server, one pounding and one kneading.
// Messages go through the relay in vite.config.js over Vite's own WebSocket (the one hot reload uses), so
// there is no extra server or package; it works wherever the dev server is reachable, which for a Quest
// means http://localhost:5174 through `adb reverse` (USB or adb over Wi-Fi). Dev server only.
//
// Roles (the start screen's menu, kept in the URL as ?mp=host or ?mp=join):
//   host  runs everything as in solo play (the batch, the dough, the NPCs, the mallet) and sends it out
//   join  the guest: draws what the host sends and kneads the host's dough with its tracked hands
// What is sent is in src/sync.js.

export const ROLES = ['solo', 'host', 'join'];
export function roleFromUrl() {
  const r = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('mp') : null;
  return ROLES.includes(r) ? r : 'solo';
}

export function createNet(role) {
  const hot = import.meta.hot;
  const id = Math.random().toString(36).slice(2, 10);
  const listeners = {};
  const peers = new Map(); // id -> { role, seen (ms) }
  const on = role !== 'solo' && !!hot;
  const net = {
    role, id,
    available: !!hot,
    send(type, data) { if (on) hot.send('mp:send', { from: id, role, type, data }); },
    on(type, fn) { (listeners[type] ??= []).push(fn); },
    // a peer with that role heard from in the last 2.5 s
    has(peerRole) {
      const now = performance.now();
      for (const p of peers.values()) if (p.role === peerRole && now - p.seen < 2500) return true;
      return false;
    },
    count(peerRole) {
      const now = performance.now();
      let n = 0;
      for (const p of peers.values()) if (p.role === peerRole && now - p.seen < 2500) n++;
      return n;
    },
  };
  if (on) {
    hot.on('mp:recv', (m) => {
      if (!m || m.from === id) return;
      const was = net.has(m.role);
      peers.set(m.from, { role: m.role, seen: performance.now() });
      if (!was) console.info(`[mp] ${m.role === 'host' ? 'host' : m.role === 'join' ? 'guest' : m.role} connected`);
      for (const fn of listeners[m.type] ?? []) fn(m.data, m);
    });
    setInterval(() => net.send('hello', {}), 1000);
  }
  return net;
}

// typed arrays <-> base64, for the binary parts (hand joints, the dough grid) inside the JSON messages
export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(str) {
  const s = atob(str), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
