import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A workspace that is not a git checkout, for tests of mark_complete that are not about where a fix is: an endorse
 * there closes the finding with `fix: unknown`, whatever workspace an earlier test left active (SPEC §mark_complete).
 */
export const NO_GIT = mkdtempSync(join(tmpdir(), 'mc-nogit-'));

// A temp directory inside a repository would make every endorse here "absent" instead: say so, not fail obscurely.
if (spawnSync('git', ['-C', NO_GIT, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' }).status === 0) {
  throw new Error(`tests/helpers/no-git.ts: ${NO_GIT} is inside a git checkout; point TMPDIR outside any repository`);
}
