# Mochitsuki

Pound steamed rice into mochi with a heavy wooden mallet (kine) in a wooden mortar (usu), alone or with a second headset kneading between your strikes. There are two worlds, picked in the start menu: the Moon garden on Chuseok night (the default) and a snowy shrine courtyard on New Year's Eve.

Built with three.js 0.186 and sound from [Satie](https://www.satie.world) (spatial, attached to the objects that make it). Runs on desktop and in WebXR on a Quest 3.

The dough is simulated: an elastoplastic MLS-MPM solver (Neo-Hookean elasticity, von Mises plasticity) ported to JavaScript from [VR-Doh](https://github.com/Simulation-Intelligence/VR-Doh) (Luo, Cui, Luo, Chu, Li, ACM TOG / SIGGRAPH 2025, Apache-2.0). It runs in a Web Worker and is drawn with marching cubes. The mallet head and the tracked hands are colliders in it. VR-Doh runs on a PC GPU in slow motion, so the grid, particle count and material constants are retuned to run in real time on a CPU; they are listed in `src/dough/mpm-core.js` (`DEFAULTS`). `node scripts/test-dough.mjs` runs the physics without a browser.

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
| Look / move | mouse, WASD, Shift to hurry | physical movement (room scale); optional thumbsticks in Settings |
| Take / return the kine | **E** within 2.4 m of the mortar | trigger (or grip) near the mortar |
| Strike | click or Space | swing the controller down into the bowl |

Wait for the kneader's hands to leave the bowl between strikes. 22 strikes turn a batch into mochi.

## Elasticity and moisture

Two bars float above the mortar while you pound:

- **Elasticity.** Fresh rice starts very stiff. Each successful action makes it a little more elastic: a Good or Average strike or knead in rhythm mode, or any clean strike or fold in free play. Only one material value changes, the dough's stiffness (Young's modulus), from 8 kPa down to 1.2 kPa over 40 successes.
- **Moisture.** It falls slowly, about 1% a second. Dipping a hand in the water bucket adds 40%. Below the yellow mark (30%), successes stop counting and the elasticity drains back toward stiff.
- **Hitting a hand.** If the mallet hits a hand in the bowl, you lose 500 points and your combo. A red light flashes at the mortar, and the controllers on both headsets vibrate hard. Bare tracked hands have no vibration.

VR defaults to **Thumbsticks + physical movement** in Settings, with stick walking, snap turning and automatic role placement. Physical walking, leaning and crouching also work. Choose **Room scale** to start beside the mortar once (host/solo at the pounding side, guest at the kneading side), using the headset's tracked floor and height, then preserve your position when picking up a mallet or switching to hand tracking. Your chosen mode is remembered. Each headset has its own play area; their real rooms are not aligned together.

## Moon garden story and rabbits

The Moon garden opens with the Chuseok story on a floating paper scroll, then a portal reveals the garden. Skip with **Space**, **Enter** or **E** on desktop, or select/hold a pinch in VR. Strikes wait until the intro finishes.

Either player can choose a floating song scroll with **E** while looking at it within 2.5 m, select with a controller within 0.5 m, or pinch with a tracked hand near the scroll. Scrolls stay visible during play, including while a song is loading or playing, and the playing song glows. Bangarang uses the Tteokme log mallet, Believer the Yokogine, and Gangnam Style the vertical Jeolgut-gongi pestle. Finishing a batch sends the mochi to Earth and restarts the story.

Multiplayer players appear as the original rigged Moon Rabbit characters: red for the host, indigo for the joining player. The rabbits' own paws are removed. Each player's hands are drawn from their tracked joints, 22% fuller to suit the rabbits (the physics uses the real size), and a held controller shows a small paw. Each arm follows its own hand/controller, the head turns separately from the torso, and the legs take alternating steps during physical walking or joystick travel. Leg motion is estimated from movement; no foot trackers are required. Headset appearance and tracking still need a Quest check.

Shared mallets use stable asset IDs (`yokogine`, `tteokme`, `pestle`). The host sends the selected ID with poses, ownership grants and periodic state, so both simulations build the same mesh, grip and collider, including for late joiners and after the tool is put down. Only the granted holder's poses move the shared mallet; a stale pose from a previous mallet type is ignored.

## Rhythm mode

Choose music in the garden using the floating song scrolls; the start menu has no Music panel. Songs in `public/music/` (mp3/wav/ogg/m4a/flac) become scrolls automatically. The page finds the song's tempo and beats, then:

- strike on every beat, or every other beat for fast songs (chosen automatically), with kneading cues between strikes
- a ring shrinks onto the mortar's rim and meets it exactly when to strike; the rim pulses on every beat
- your strikes are judged **Good** (within 60 ms, the ring turns green), **Average** (130 ms, yellow) or a miss (**Early / Late / Off-beat**, red), with score, combo and up to ×4 multiplier; striking while the kneader's hands are in the bowl is a miss
- when you are not holding the mallet, strike notes pass unjudged
- the rice loading and finished batches are rests in the song
- if hits feel consistently early or late (e.g. Bluetooth headphones), nudge the timing with **[** and **]** (the HUD shows how early or late your hits average)

Enter on desktop or in VR, then choose a scroll to start or change the music. `node scripts/test-beats.mjs` checks the beat detector on synthetic songs.

With two players (`?mp=host` and `?mp=join` on the same dev server), either player can pick up the mallet (E on desktop, grip in VR) when it is free, and whoever doesn't hold it kneads. A second person kneading is placed at the north rim, opposite the mallet. Either player can choose a scroll. Guest selections go to the host, which loads the song and shares its beat grid and playback clock; simultaneous selections are accepted one at a time. The joining player hears the same playback position, including when joining mid-song. Whoever holds the mallet gets strike rings. The other player's rings cue kneading halfway between those strikes, and their own hand contacts earn rhythm judgments. Song changes, explicit playback pauses and free play are shared. The shared music clock continues if the host headset temporarily loses visibility or suspends its audio; host audio catches up when it returns. Each player must enter once to enable audio on their device.

`node --test scripts/test-music-sync.mjs` checks music synchronization and alternating action cues without headsets.

## Sound

The Moon garden has its own locally synthesized wind and leaf rustle, trickling fountain with water drops, and occasional bamboo chimes. Press **Play** or **Enter VR** to unlock audio; the ambience fades in as the intro portal opens. Fountain and chime sounds come from the visible props and follow your head direction. Ambience fades down in the menu and pauses while the tab or headset is hidden. It works even if the station recordings fail to download.

`public/satie/scene.satie` is the Satie script, and `samples.json` maps each clip to its recording. `samples.json` is built by `node scripts/prepare-takes.mjs` from Satie's original (`satie/realized/samples.json`) and the cut list in `satie/take-edits.json`. Satie's mallet and fold recordings held several hits each, so each one is cut to its first hit (`public/satie/takes/`). The sounds include:

- the mallet thud, which drops in pitch as the dough smooths (`mochi_progress`)
- the turner's wet fold, the bucket dip, the steamer lid and the rice drop
- the stove fire, the bubbling pot and the steamer hiss
- the bonfire
- the temple bell
- footsteps on snow-dusted gravel or flagstone

In development, the "Sound by Satie" badge opens Satie's mixer (backquote also toggles it).

If `samples.json` is missing, the recorded station/shrine sounds are unavailable and the start screen says so. The Moon garden's procedural ambience remains available. `node scripts/test-garden-audio.mjs` checks synthesized sample energy, spatial bindings, fades and start/retry/resume behavior; device listening still needs a browser/headset check.
