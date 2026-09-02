/**
 * Beat 1 step 3 / beat 2: a DIFFERENT process reads the ledger.
 *
 * Pass an agf_ id to prove that specific finding survived its author:
 *   bun run scripts/demo/get-problems.ts agf_xxxx
 */
import { callTool } from './_stdio.js';

const wanted = process.argv[2];
const { text, pid } = await callTool('get_problems', { limit: 100 });

console.log(`\n  reader pid : ${pid}   (a new process — never restarted from the author)\n`);

if (wanted) {
  const line = text.split('\n').find(l => l.includes(wanted));
  const summary = text.split('\n').find((l, i, a) =>
    a[i + 2]?.includes(wanted) || a[i + 3]?.includes(wanted));
  console.log(line
    ? `  FOUND ${wanted} in the ledger:\n    ${(summary ?? '').trim().slice(0, 120)}\n`
    : `  NOT FOUND: ${wanted}\n`);
  process.exit(line ? 0 : 1);
}

const open = (text.match(/^\s*\d+\.\s+\[/gm) ?? []).length;
const closed = (text.match(/\[FIXED\]|\[RETRACTED\]/g) ?? []).length;
console.log(`  open work offered : ${open}`);
console.log(`  closed, not offered: ${closed}   <- these are NOT handed to an agent again\n`);
console.log(text.split('\n').slice(0, 12).join('\n'));
