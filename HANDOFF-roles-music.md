# Handoff: either headset takes either role, and both hear the music (2026-11-15)

The user asked for two changes to multiplayer (`?mp=host` / `?mp=join`):
1. **Either role on either headset.** The host and the joining headset should each be able to take either role: the mallet (kine) or kneading.
2. **Music on both headsets.** Rhythm-mode music is heard only on the host. It should play on both.

I stopped partway through. Read `CLAUDE.md` first: the multiplayer section and "Environment". Then read `src/sync.js` (its header lists every network message) and `src/net.js`.

## Rules that still apply
- **Ask the user before running anything:** test scripts, a dev server, `npm install`. `node --check` is fine without asking.
- **The dev server** (user-approved) runs on juno2 at 127.0.0.1:5174 and logs to `.tmp/dev.log`. Browser console lines are forwarded there too.
- **Temp files** go only in `mochi-pounding/.tmp/`.
- **Another session is editing in parallel.** That's immerse-71, the Moon-garden story layer. It owns `src/moonGarden*`, `src/station.js` and the moon entry in `src/worlds.js`. It added story hooks to `src/main.js` (`story.use/enter/update`, `world.attach(ctx)`, `ctx.selectSong`). Make targeted edits to main.js only, and never overwrite it from an old copy. I told immerse-71 I would edit main.js's music section, `ctx.selectSong`, the 'use' handler's guest branch, `sync.onKine`, the hands-appear placement, and the mp-note/prompt text.
- Nothing here has been tested with two headsets. Report headset checks as pending.

## Done
- **`src/rhythm/music.js`** (passes `node --check`):
  - `start(at = 0)` starts from song time `at`.
  - New `playFrom(pos)` plays so that the song time heard right now is `pos`. It sets `startAt = heardContextTime() - pos` and starts the source 0.1 s later at the matching offset.
  - New `position()` returns the heard song time without the player's calibration, or `null` when not playing.
  - Internal helpers `stopSource()` and `play(T, zero)`. `stop()` calls `stopSource()`. Existing callers are unchanged.

Nothing else has been changed yet.

## Findings (why it behaves this way now)
- **Music:**
  - In `src/main.js`, `startMusic()` begins with `if (guest) return;`.
  - The guest hides `#rhythm-box`, and src/menu.js then hides the Music menu item.
  - The sync.js header says "Music in rhythm mode plays on the host's headset only".
  - So the guest never loads or plays a song. This was a deliberate earlier choice, which the user now wants reversed.
- **Roles:** kneading already works on both sides.
  - hands.js remote slots 2 and 3 count in `hands.spheres`, `hands.tools` and `hands.hands`. So the host's dough, `handsIn` and dip/turn detection all feel the guest's hands, and the guest's own dough copy is eased toward the host's snapshots.
  - Mallet:
    - **Host:** takes it directly (VR grip or desktop E) unless `station.mode === 'remote'`.
    - **Guest in VR:** asks with `kine-take`. The host answers `kine-grant {ok}`, and grants only while its `station.mode === 'idle'`. On a grant the guest holds it in local 'vr' mode, and its pose carries the kine to the host.
    - **Guest on desktop:** blocked. The 'use' handler shows the toast "On the joining side, take the kine in VR".
  - The menu's Players cards and select text present fixed roles: "Host: holds the mallet", "Join: knead".
  - In the Moon garden, `story.use(c)` runs first in `xrselect`/`use` and may consume a grip press near the mortar. Check this with immerse-71 if a guest grab "does nothing".

## Plan (remaining)
### 1. Roles (main.js, index.html, menu.js)
- **Desktop guest takes the mallet** in main.js `player.on('use')`:
  - Remove the guest toast.
  - If `station.mode === 'remote'`: toast "The other headset is holding the kine".
  - If `station.mode === 'desktop'`: put it down (`setMode('idle')`, `player.unlock()`, teleport aside). If guest, also set `guestHolds = false` and call `sync.dropKine()`.
  - Else if `nearMortar()`:
    - guest: set `wantKine = { desktop: true }; wantSince = elapsed; sync.takeKine()`;
    - host: `station.setMode('desktop'); player.lockAt([L.POUNDER_SPOT[0], 0, L.POUNDER_SPOT[2] + 0.02], 0, -0.62)`.
- **`sync.onKine(ok)`:**
  - On a grant with `wantKine.desktop`: do the desktop take above and set `guestHolds = true`.
  - On a refusal (`!ok`) while the guest holds the kine on desktop: `player.unlock()` and set mode idle.
- **The 1.5 s no-answer timeout:** add a toast for desktop. `player.haptic` is already safe with `{desktop:true}`.
- **A second kneader goes elsewhere.** Hands-appear placement in the frame loop:
  - If the other headset's head is within ~0.45 m of `L.KNEAD_SPOT`, place this person at the far rim `[0, 0, -0.6]` (north, across from the pounder), facing the mortar.
  - To get that head position, expose `get otherHead()` from `createPoseLink` in sync.js (the avatar group's position when visible, else null) and pass it through the host and guest sync objects.
- **HUD prompt:** when near the mortar and `station.mode === 'remote'`, show "The other player is holding the kine".
- **Menu text:**
  - index.html `#panel-players` `.lead`: either person can pick up the mallet or knead; whoever holds the mallet pounds. One headset hosts (runs the dough and the music clock), the other joins.
  - `#mp-role` option text: "Two headsets: host" / "Two headsets: join".
  - menu.js `DETAIL['mp-role']`: same idea.
  - Header comments in net.js and sync.js.

### 2. Music on both (new `src/musicSync.js`, wired in main.js)
The host is the music authority and clock.
- **Host, `createMusicLead({ net, music, state, song, onPick })`:**
  - Sends `'music'` `{ name, src: 'list'|'file', density, state: 'playing'|'paused'|'stopped', pos: music.position() }` whenever the state signature changes, checked each frame, and once a second while a guest is present.
    - State: playing = `music.playing && music.ctx.state === 'running'`; paused = playing with the context suspended; otherwise stopped.
  - Answers `'music-ping' {id, t0}` with `'music-pong' {id, t0, pos, playing}`.
  - On `'music-get' {name}`, streams the bytes of a file-picked song as `'music-chunk' {name, i, n, data(b64)}`, about 192 KB raw per chunk, ~20 ms apart, so pose messages aren't starved.
    - `decodeAudioData` detaches the ArrayBuffer, so `loadSong` must keep `bytes.slice(0)` for file songs.
  - On `'music-pick' {name}`, selects that song from the guest: set `ui.song.value` and dispatch 'change'.
- **Guest, `createMusicFollow({ net, music, canPlay, load, start, stop })`:**
  - On a host state with a new name:
    - list songs: `loadSong(() => fetch('/music/'+name)…, name)`;
    - file songs: send `music-get`, assemble the chunks, then `loadSong(() => buf, name)`.
    - Remember a failed name, so it doesn't retry in a loop.
  - Make `loadSong` return true/false.
  - **Reconcile:**
    - host playing, the song loaded (`music.analysis && music.name === name`) and `canPlay()` (the guest has entered, i.e. clicked Enter or VR, which unlocks audio): call `music.playFrom(hostPos())`, then `start(density)`, which in main.js runs `rhythm.start(density)` and shows `#rhud`;
    - host paused: `music.pause()`; host playing again: `music.resume()`, then ping;
    - host stopped or no name: `stopMusic()`.
  - **Clock:**
    - Ping every ~1.5 s while the host plays. Over the last ~8 pongs, keep samples with rtt ≤ 1.5 × minRtt + 10 ms.
    - Host position now = `pos + rtt/2` at receipt, plus the time elapsed since. If no pong for 5 s, use the state message's `pos` plus the last one-way estimate (default 30 ms).
    - If `|music.position() - hostPos| > 0.045 s`, call `music.playFrom(hostPos)`.
- **main.js:**
  - The guest's `startMusic()` does `entered = true; music.unlock(); follow.kick()` instead of returning.
  - The guest's `ctx.selectSong(name)` sends `'music-pick'` to the host instead of loading.
  - The mp-note on the guest shows "connected to the host · ♪ <song>".
  - Keep `#rhythm-box` hidden on the guest (the host picks), or show it read-only.
- **Judging:** rhythm judges strikes on each headset separately, so judging stays local and consistent. Scores may differ slightly.
- Update the sync.js header ("Music in rhythm mode plays on the host's headset only" is no longer true) and CLAUDE.md's multiplayer section.

### 3. Verify
- `node --check` on every changed file.
- Ask the user before any other run.
- Two browser tabs on desktop (`?mp=host`, `?mp=join`) can check the protocol. `.tmp/dev.log` shows the `[mp]` lines. Headset checks are pending until the user tries them.

## Note from the Moon-garden session (immerse-71, also stopped)
- `ctx.selectSong(fileName)` will be called by the song scrolls, which are still to come. When it forwards to the host on the guest, keep it returning true or false for whether the song is listed.
- That session's full state, the story layer included, is in `/juno/u/paruwel/immerse/HANDOFF-2026-11-15.md`.
