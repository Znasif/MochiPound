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

async function load(importer, name) {
  try { return await importer(); }
  catch (err) { console.warn(`[story] ${name} unavailable:`, err.message); return null; }
}

export async function createMoonStory(ctx) {
  const silent = Object.fromEntries(SOUND_API.map((k) => [k, () => {}]));
  const soundsMod = await load(() => import('./sounds.js'), 'sounds');
  let sounds = silent;
  try { if (soundsMod?.createStorySounds) sounds = { ...silent, ...soundsMod.createStorySounds(ctx) }; }
  catch (err) { console.error('[story] sounds failed; running the story silent', err); }
  const textMod = await load(() => import('./text.js'), 'text');
  await textMod?.loadStoryFonts?.();
  const flow = { introActive: false, intro: null, ending: null };
  const pctx = Object.assign(Object.create(ctx), { sounds, flow }); // preserve the live audioContext / entered getters
  const parts = [];
  let started = false;
  // Literal imports let Vite include every independently guarded part in production builds as well.
  for (const [importer, name, factory, key] of [
    [() => import('./ending.js'), 'ending', 'createEnding', 'ending'],
    [() => import('./songScrolls.js'), 'song scrolls', 'createSongScrolls', 'songScrolls'],
    [() => import('./intro.js'), 'intro', 'createIntro', 'intro'],
  ]) {
    const m = await load(importer, name);
    if (!m?.[factory]) continue;
    try { const part = await m[factory](pctx); if (part) { part.name = name; parts.push(part); flow[key] = part; } }
    catch (err) { console.error(`[story] ${name} failed to start`, err); }
  }
  flow.ending?.onReset(() => flow.intro?.restart());
  console.info(`[story] parts: ${parts.map((p) => p.name).join(', ') || 'none'}`);
  return {
    get started() { return started; },
    get blocked() { return flow.introActive; },
    get reveal() { return flow.intro?.reveal ?? 1; },
    enter(xr) { started = true; for (const p of parts) { try { p.enter?.(xr); } catch (err) { console.error(`[story] ${p.name} enter`, err); } } },
    use(c) { for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; try { if (p.use?.(c)) return true; } catch (err) { console.error(`[story] ${p.name} use`, err); } } return false; },
    update(dt, t) {
      sounds.update?.(dt, t);
      for (const p of parts) { try { p.update?.(dt, t); } catch (err) { if (!p._warned) { p._warned = true; console.error(`[story] ${p.name} update`, err); } } }
    },
  };
}
