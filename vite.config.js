import { defineConfig } from 'vite';
import { satie } from 'satie-runtime/vite';
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Lists the songs dropped into public/music/ at /music/index.json, for the rhythm mode's song menu.
function musicList() {
  const dir = resolve('public/music');
  const list = () => (existsSync(dir) ? readdirSync(dir).filter((f) => /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm|opus)$/i.test(f)).sort() : []);
  return {
    name: 'music-list',
    configureServer(server) {
      server.middlewares.use('/music/index.json', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(list()));
      });
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'music/index.json', source: JSON.stringify(list()) }); },
  };
}

// Multiplayer relay (src/net.js): passes each page's messages on to every other page connected to this
// dev server (the two headsets), over Vite's own WebSocket. Dev only.
function multiplayerRelay() {
  return {
    name: 'multiplayer-relay',
    configureServer(server) {
      server.ws.on('mp:send', (data, client) => {
        for (const c of server.ws.clients) if (c !== client) c.send('mp:recv', data);
      });
    },
  };
}

// Binds to loopback by default. Reach it from a laptop with VS Code port forwarding, or from a
// Quest over USB with `adb reverse tcp:5174 tcp:5174` and http://localhost:5174 (a secure context).
export default defineConfig({
  plugins: [satie(), musicList(), multiplayerRelay()],
  server: {
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 5174),
    strictPort: true,
    // dev only: browser console errors, warnings and info lines appear in the dev-server log
    forwardConsole: { unhandledErrors: true, logLevels: ['error', 'warn', 'info'] },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
