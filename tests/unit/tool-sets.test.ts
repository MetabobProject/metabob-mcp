/**
 * The tool sets (SPEC §tool-sets): with METABOB_TOOLS unset the server lists the default set, the shared task ledger
 * and memory; `all` lists every tool; a list, exactly those. What an agent is told names only what it is given: the
 * instructions for each set name only listed tools, and the default instructions and the `metabob` skill, which is
 * written for the default set, name only its tools and never the substrate.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_TOOL_SET, TOOL_REGISTRY } from '../../src/tools/index';
import { parseToolAllowlist, toolSetKind, unknownToolNames } from '../../src/vessel-server';
import { DEFAULT_INSTRUCTIONS, serverInstructions } from '../../src/server-instructions';

const ROOT = resolve(import.meta.dir, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const registered = new Set(Object.keys(TOOL_REGISTRY));
/** Tool names a text writes in backticks. */
const toolsIn = (text: string) => [...new Set([...text.matchAll(/`([a-z][a-z0-9_]*)/g)].map((m) => m[1]!).filter((n) => registered.has(n)))];

describe('the tool sets', () => {
  test('the default set is registered tools only, with the ledger, memory and the workspace call', () => {
    expect(DEFAULT_TOOL_SET.filter((t) => !registered.has(t))).toEqual([]);
    expect(new Set(DEFAULT_TOOL_SET).size).toBe(DEFAULT_TOOL_SET.length);
    for (const t of ['get_problems', 'record_finding', 'mark_complete', 'claim_finding', 'concept_search', 'concept_create', 'init_workspace']) expect(DEFAULT_TOOL_SET).toContain(t);
  });

  test('unset gives the default set; `all` every tool; a list exactly those', () => {
    expect([...parseToolAllowlist(undefined)!].sort()).toEqual([...DEFAULT_TOOL_SET].sort());
    expect(parseToolAllowlist('all')).toBeNull();
    expect([...parseToolAllowlist('get_problems,run_goal_async')!].sort()).toEqual(['get_problems', 'run_goal_async']);
    expect([toolSetKind(undefined), toolSetKind('all'), toolSetKind('get_problems')]).toEqual(['default', 'all', 'list']);
  });

  test('the instructions for each set name only the tools it lists', () => {
    for (const value of [undefined, 'all', 'get_problems,record_finding,run_goal_async,goal_status']) {
      const listed = parseToolAllowlist(value);
      const named = toolsIn(serverInstructions(value));
      expect({ value, refused: named.filter((t) => listed !== null && !listed.has(t)) }).toEqual({ value, refused: [] });
      expect(named.length).toBeGreaterThan(0);
    }
  });

  test('a list without cockpit tools gets the default text, less the lines naming unlisted tools', () => {
    expect(serverInstructions(DEFAULT_TOOL_SET.join(','))).toBe(DEFAULT_INSTRUCTIONS);
    const subset = serverInstructions('get_problems,record_finding,mark_complete,concept_search');
    expect(subset).toContain('load the `metabob` skill');
    expect(subset.toLowerCase()).not.toContain('substrate');
    expect(subset).toContain('`record_finding`');
    expect(subset).not.toContain('`claim_finding`');
    expect(subset).not.toContain('`concept_create`');
    // A cockpit tool in the list makes the full text the base.
    expect(serverInstructions('get_problems,path_activity')).toContain('load the `metabob-substrate` skill');
  });

  test('a list name that is no tool is reported, `all` mixed into a list included', () => {
    expect(unknownToolNames('all,get_problems')).toEqual(['all']);
    expect(unknownToolNames('get_problems,get_problem')).toEqual(['get_problem']);
    expect([unknownToolNames(undefined), unknownToolNames('all'), unknownToolNames('get_problems')]).toEqual([[], [], []]);
  });

  test('the default instructions point at the metabob skill and never mention the substrate', () => {
    expect(serverInstructions(undefined)).toBe(DEFAULT_INSTRUCTIONS);
    expect(DEFAULT_INSTRUCTIONS).toContain('load the `metabob` skill before your first metabob call');
    expect(DEFAULT_INSTRUCTIONS.toLowerCase()).not.toContain('substrate');
    expect(serverInstructions('all')).toContain('load the `metabob-substrate` skill');
  });

  test('the metabob skill names only default tools, and its tool table is the default set', () => {
    const skill = read('skills/metabob/SKILL.md');
    expect(toolsIn(skill).filter((t) => !DEFAULT_TOOL_SET.includes(t))).toEqual([]);
    expect(skill.toLowerCase()).not.toContain('substrate');
    const table = [...skill.split('## The tools')[1]!.split('\n## ')[0]!.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
    expect(table.sort()).toEqual([...DEFAULT_TOOL_SET].sort());
  });

  test('the shared-memory guide lists the default set', () => {
    const guide = read('docs/SHARED-MEMORY.md');
    const table = [...guide.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!).filter((t) => registered.has(t));
    expect([...new Set(table)].sort()).toEqual([...DEFAULT_TOOL_SET].sort());
  });
});
