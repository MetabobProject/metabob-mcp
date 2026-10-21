import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A workspace that is not a git checkout, for tests of mark_complete that are not about where a fix is: an endorse
 * there closes the finding with `fix: unknown`, whatever workspace an earlier test left active (SPEC §mark_complete).
 */
export const NO_GIT = mkdtempSync(join(tmpdir(), 'mc-nogit-'));
