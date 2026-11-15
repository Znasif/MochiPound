// Writes public/satie/scene.contract.json from src/manifest.js (the same numbers the meshes use).
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildContract } from '../src/manifest.js';

const revision = process.argv[2] ?? 'mochi-1';
mkdirSync(new URL('../public/satie/', import.meta.url), { recursive: true });
const out = new URL('../public/satie/scene.contract.json', import.meta.url);
writeFileSync(out, JSON.stringify(buildContract(revision), null, 2) + '\n');
console.log(`wrote ${out.pathname}`);
