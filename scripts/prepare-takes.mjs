// Builds public/satie/samples.json from Satie's realized samples map (satie/realized/samples.json,
// kept exactly as satie_realize returned it) plus the region edits in satie/take-edits.json.
// Edited clips are cut with ffmpeg to public/satie/takes/<sampleId>.wav; their entries keep every
// Satie field, point at the local file, carry its sha256 (the runtime verifies it) and record
// where they came from. Clips listed under `drop` are left out. Re-run after every realize.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const path = (p) => new URL(p, root).pathname;
const recipe = JSON.parse(readFileSync(path('satie/take-edits.json'), 'utf8'));
const realized = JSON.parse(readFileSync(path(recipe.source), 'utf8'));
const cache = path('.tmp/takes-src/');
const outDir = path('public/satie/takes/');
mkdirSync(cache, { recursive: true });
mkdirSync(outDir, { recursive: true });

const out = {};
const dropped = new Set(recipe.drop?.clipPaths ?? []);
for (const [clip, entry] of Object.entries(realized)) {
  if (dropped.has(clip)) continue;
  const edit = recipe.edits[clip];
  if (!edit) { out[clip] = entry; continue; }
  const id = entry.sampleId ?? createHash('sha256').update(clip).digest('hex').slice(0, 16);
  const src = `${cache}${id}`;
  if (!existsSync(src)) {
    const res = await fetch(entry.url);
    if (!res.ok) throw new Error(`${clip}: HTTP ${res.status} for ${entry.url}`);
    writeFileSync(src, Buffer.from(await res.arrayBuffer()));
  }
  const [a, b] = edit.regionS;
  const dur = +(b - a).toFixed(3);
  const fade = edit.fadeOutS ?? 0.1;
  const file = `${id}.wav`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(a), '-t', String(dur), '-i', src,
    '-af', `afade=t=in:d=0.003,afade=t=out:st=${(dur - fade).toFixed(3)}:d=${fade}`,
    '-c:a', 'pcm_s16le', '-ar', '44100', `${outDir}${file}`], { timeout: 30000, maxBuffer: 1 << 20 });
  const sha256 = createHash('sha256').update(readFileSync(`${outDir}${file}`)).digest('hex');
  out[clip] = {
    ...entry,
    url: `takes/${file}`, // relative to samples.json
    sha256,
    edit: { from: entry.url, sourceSampleId: entry.sampleId, regionS: [a, b], fadeOutS: fade, reason: 'single impact cut from a multi-event take' },
  };
  console.log(`cut ${clip} [${a}-${b}s] -> takes/${file}`);
}
writeFileSync(path('public/satie/samples.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`wrote public/satie/samples.json: ${Object.keys(out).length} clips (${dropped.size} dropped, ${Object.keys(recipe.edits).length} edited)`);
