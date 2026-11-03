/**
 * Remove local PayProof databases. Stop the server first — PGlite holds files
 * open while running. `npm run reset` then `npm start` gives a clean ledger.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const targets = [
  fileURLToPath(new URL('../data/pgdata', import.meta.url)),
  fileURLToPath(new URL('../data/demo-pgdata', import.meta.url)),
];

for (const target of targets) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log('removed', target);
}
console.log('Done. The next start re-runs migrations and seeds the demo merchant.');
