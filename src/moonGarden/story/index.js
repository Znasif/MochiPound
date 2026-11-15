// The Moon garden's story layer, ported from the Unity team's `multiplayer` branch (MochiPound,
// Assets/_Project/World/Scripts and Assets/MochiRhythm/Scripts). The user asked for it on 2026-11-15:
//   sounds.js       StorySounds: synthesized story sounds (Web Audio), used by the others
//   text.js         StoryText: floating story text with rising letters (used by intro and ending)
//   intro.js        StoryIntro + IntroScroll (+ PassthroughIntro, adapted to VR): the hanji scroll story, then the portal
//   songScrolls.js  SongScrolls + SongScrollHints + Mallets + RhythmStoryBridge: pick a song by a scroll, it becomes its mallet
//   ending.js       MoonStory's ending: the mochi flies to the Earth, the Earth lights up, "Happy Chuseok, Earth!", reset
// Each part loads on its own: one that is missing or throws is logged and the others still run.
//
// ctx (from main.js, plus garden from worlds.js): { scene, renderer, camera, player, station, hands, music,
// rhythm, toast(text, s), selectSong(name) -> bool, songs() -> [names], audioContext (getter, may be null
// until the first click), entered (getter), garden (buildMoonGarden's result) } and, for the parts,
// sounds (sounds.js's API, a silent stand-in until it exists).
// Each part's factory returns { enter?(xr), update?(dt, elapsed), use?(controller) }; main.js calls enter(false)
// when the desktop player enters, enter(true) when a VR session starts, and update every frame.
// use(controller) gets every press first: the desktop E key (controller null) and a VR controller's select
// (its controller object: { grip, ... } from player.js). Return true to consume it; otherwise main.js does
// its own thing (take or hand back the kine near the mortar).

const SOUND_API = ['playIntroLine', 'playScrollUnroll', 'playScrollClose', 'playSwell', 'playFireworkFar', 'stopTextSounds',
  'playEndingText', 'playFlight', 'playArrival', 'playWishes', 'update'];

async function load(path, name) {
  try { return await import(/* @vite-ignore */ path); }
  catch (err) { console.warn(`[story] ${name} unavailable:`, err.message); return null; }
}

export async function createMoonStory(ctx) {
  const silent = Object.fromEntries(SOUND_API.map((k) => [k, () => {}]));
  const soundsMod = await load(new URL('./sounds.js', import.meta.url).href, 'sounds');
  let sounds = silent;
  try { if (soundsMod?.createStorySounds) sounds = { ...silent, ...soundsMod.createStorySounds(ctx) }; }
  catch (err) { console.error('[story] sounds failed; running the story silent', err); }
  const pctx = Object.assign(Object.create(ctx), { sounds }); // not a spread: ctx's getters (audioContext, entered) stay live
  const parts = [];
  for (const [file, name, factory] of [['./ending.js', 'ending', 'createEnding'], ['./songScrolls.js', 'song scrolls', 'createSongScrolls'], ['./intro.js', 'intro', 'createIntro']]) {
    const m = await load(new URL(file, import.meta.url).href, name);
    if (!m?.[factory]) continue;
    try { const part = await m[factory](pctx); if (part) { part.name = name; parts.push(part); } }
    catch (err) { console.error(`[story] ${name} failed to start`, err); }
  }
  console.info(`[story] parts: ${parts.map((p) => p.name).join(', ') || 'none'}`);
  return {
    enter(xr) { for (const p of parts) { try { p.enter?.(xr); } catch (err) { console.error(`[story] ${p.name} enter`, err); } } },
    use(c) { for (const p of parts) { try { if (p.use?.(c)) return true; } catch (err) { console.error(`[story] ${p.name} use`, err); } } return false; },
    update(dt, t) {
      sounds.update?.(dt, t);
      for (const p of parts) { try { p.update?.(dt, t); } catch (err) { if (!p._warned) { p._warned = true; console.error(`[story] ${p.name} update`, err); } } }
    },
  };
}
