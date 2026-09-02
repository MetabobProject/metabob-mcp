/** Beat 1, step 1: an agent records a finding, then is killed outright. */
import { callTool } from './_stdio.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const { text, pid } = await callTool('record_finding', {
  files: ['src/local-store.ts'],
  summary: `DEMO ${stamp}: recorded by a process that is about to be killed — if you can read this from another process, the work outlived its author.`,
  severity: 'LOW',
  category: 'demo',
  details: 'Written by scripts/demo/record-then-die.ts. Safe to discard with mark_complete.',
});

console.log(`\n  author pid : ${pid}   (killed on exit)`);
console.log(`  ${(text.match(/agf_[a-z0-9]+/) ?? ['<none>'])[0]}  <- remember this id\n`);
