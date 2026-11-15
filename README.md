# Mochitsuki

New Year's Eve at a snowy shrine. A pounder swings a heavy wooden mallet (kine) into steamed rice in a wooden mortar (usu), and a kneeling turner folds the dough between strikes. A helper brings each batch of hot rice from the steamer, the finished mochi goes onto a table, and the temple bell tolls across the courtyard. Walk up, listen, and take a turn yourself.

Built with three.js 0.186 and sound from [Satie](https://www.satie.world) (spatial, attached to the objects that make it). Runs on desktop and in WebXR on a Quest 3.

The dough is simulated: an elastoplastic MLS-MPM solver (Neo-Hookean elasticity, von Mises plasticity) ported to JavaScript from [VR-Doh](https://github.com/Simulation-Intelligence/VR-Doh) (Luo, Cui, Luo, Chu, Li, ACM TOG / SIGGRAPH 2025, Apache-2.0). It runs in a Web Worker and is drawn with marching cubes. The mallet head and the turner's hands are colliders in it. VR-Doh runs on a PC GPU in slow motion, so the grid, particle count and material constants are retuned to run in real time on a CPU; they are listed in `src/dough/mpm-core.js` (`DEFAULTS`). `node scripts/test-dough.mjs` runs the physics without a browser.

## Run

```bash
source /juno/u/paruwel/immerse/scripts/env.sh          # Node 24 on the SC cluster
export TMPDIR=$PWD/.tmp TMP=$PWD/.tmp TEMP=$PWD/.tmp
npm install
npm run dev                                            # http://127.0.0.1:5174
```

- **Laptop:** forward port 5174 in VS Code and open http://localhost:5174.
- **Quest 3 over USB:** run `adb reverse tcp:5174 tcp:5174` on the laptop, open http://localhost:5174 in Quest Browser, and press **Enter VR**.

## Controls

| | Desktop | VR |
| --- | --- | --- |
| Look / move | mouse, WASD, Shift to hurry | head, left stick, right stick snap-turns |
| Take / return the kine | **E** within 2.4 m of the mortar | trigger (or grip) near the mortar |
| Strike | click or Space | swing the controller down into the bowl |

Wait for the turner's hands to leave the bowl between strikes; rushing makes them flinch. 22 strikes turn a batch into mochi.

## Rhythm mode

Pound to your own song. On the start screen, pick a song from `public/music/` (drop mp3/wav/ogg/m4a/flac files there) or **Choose a file…** from your computer. The page finds the song's tempo and beats itself, then:

- the mallet lands on every beat, or every other beat for fast songs (switchable), and the turner folds on the off-beat
- a ring shrinks onto the mortar's rim and meets it exactly when to strike; the rim pulses on every beat
- your strikes are judged **Perfect** (within 60 ms), **Good** (130 ms) or **Early / Late / Off-beat**, with score, combo and up to ×4 multiplier; striking while the turner's hands are in the bowl is a miss
- when you are not holding the mallet, the pounder plays the song perfectly
- the rice loading and finished batches are rests in the song
- if hits feel consistently early or late (e.g. Bluetooth headphones), nudge the timing with **[** and **]** (the HUD shows how early or late your hits average)

Start rhythm mode on the page, then press **Enter VR** to play it in the headset. `node scripts/test-beats.mjs` checks the beat detector on synthetic songs.

## Sound

`public/satie/scene.satie` is the Satie script, and `samples.json` maps each clip to its recording. `samples.json` is built by `node scripts/prepare-takes.mjs` from Satie's original (`satie/realized/samples.json`) and the cut list in `satie/take-edits.json`. Satie's mallet and fold recordings held several hits each, so each one is cut to its first hit (`public/satie/takes/`). The sounds include:

- the mallet thud, which drops in pitch as the dough smooths (`mochi_progress`)
- the turner's wet fold, the bucket dip, the steamer lid and the rice drop
- the stove fire, the bubbling pot and the steamer hiss
- the bonfire
- the temple bell
- footsteps on snow-dusted gravel or flagstone

In development, the "Sound by Satie" badge opens Satie's mixer (backquote also toggles it).

If `samples.json` is missing, the scene runs silent and the start screen says so.
