/**
 * The Claude Code plugin installs on a fresh machine (README §claude-code-plugin). Claude Code clones the
 * marketplace with --recurse-submodules, so a submodule reached over ssh fails the install on a machine with no
 * GitHub ssh key, and the `owner/repo` shorthand clones over ssh too. With https submodule URLs and the https
 * marketplace URL, the plugin installs and its server connects.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('plugin install on a fresh machine', () => {
  test('every submodule is fetched over https', () => {
    const urls = [...read('.gitmodules').matchAll(/^\s*url\s*=\s*(\S+)/gm)].map(m => m[1]!);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^https:\/\//);
  });

  test('the README and the guide add the marketplace by its https URL and name the prerequisites', () => {
    for (const doc of ['README.md', 'docs/USER-GUIDE.md']) {
      const text = read(doc);
      expect(text).toContain('claude plugin marketplace add https://github.com/MetabobProject/metabob-mcp.git');
      expect(text).not.toMatch(/claude plugin marketplace add MetabobProject\/metabob-mcp\b/);
      expect(text).toMatch(/needs `git` and Node 22\.13 or later/);
    }
  });
});
