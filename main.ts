// Cloudhaven Air Rally — hand-in entry point (Node 22, standard library only).
//
// The bounty runner executes this file and then inspects one output directory.
// We put three things there:
//   1. a copy of game/          — the playable browser game itself
//   2. a copy of screenshots/   — only if that folder exists next to this file
//   3. dossier.json             — the scorer's summary, built by the vendored
//                                 helper so it matches what the scorer expects
//
// Paths are resolved from this module's own location rather than the current
// working directory, so the script behaves the same wherever it is launched.

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// Folder that holds this file (the repository root).
const here = dirname(fileURLToPath(import.meta.url));

// Destination chosen by the runner; /output is the documented default.
const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
mkdirSync(outDir, { recursive: true });

// Copy a sibling directory into the output, replacing any stale copy's files.
function copyDir(name: string): boolean {
  const src = join(here, name);
  if (!existsSync(src) || !statSync(src).isDirectory()) return false;
  cpSync(src, join(outDir, name), { recursive: true, force: true });
  return true;
}

// The game is mandatory: without it there is nothing to hand in.
if (!copyDir('game')) {
  console.error(`main.ts: no game/ directory found beside ${here}`);
  process.exit(1);
}

// Screenshots are optional; skip quietly if they have not been produced.
const hadShots = copyDir('screenshots');

// Build the dossier from the copied tree. These caps are the bounty's limits
// and must be passed exactly as given so our dossier equals the scorer's.
const dossier = buildDossier(outDir, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
});
writeFileSync(join(outDir, 'dossier.json'), dossier);

console.log(
  `main.ts: wrote game/${hadShots ? ', screenshots/' : ''} and dossier.json (${dossier.length} bytes) to ${outDir}`,
);
