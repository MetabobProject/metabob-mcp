// Contract (input schema, behaviour): SPEC §path_activity
/**
 * path_activity — before editing shared files, what the system has in flight on them:
 * the open gaps that name each file, and for each whether the system is landing it now
 * (a held landing lease), it is queued for the system, or it is held by an operator
 * ruling. Read-only: one full read of the gap store, cached across calls
 * (src/tools/_gap-activity.ts).
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { activeWorkspacePath } from '../local-index.js';
import { gapsForPath, holdOf, landingLeaseOf, pathMapper, readGaps, renderGap, storeNamesPrefix, type GapRow } from './_gap-activity.js';

export const PathActivityTool = {
  name: 'path_activity',
  description:
    "Before editing shared files: what the substrate has in flight on them. For each path, the open gaps that name it (as their edit site, in a directory, or in their goal), and for each gap whether the system is landing it right now (a live landing lease: an edit before it ends is lost or conflicts when the change lands), it is queued for the system (prefer letting it land, or dispatch it), or it is held by an operator ruling (with its review date). Paths are workspace-relative or in the gap store's `repos/<vessel>/…` form. Read-only.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 50,
        description: 'Files or directories, workspace-relative or as repos/<vessel>/<path>.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Most gaps to list per path besides those being landed, which are always listed (default 10).',
      },
      include_closed: {
        type: 'boolean',
        description: 'Also list closed gaps that named these paths (default false).',
      },
    },
    required: ['paths'],
  },
};

export const InputSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(50),
  limit: z.number().int().min(1).max(100).optional(),
  include_closed: z.boolean().optional(),
});

export type PathActivityInput = z.infer<typeof InputSchema>;

const NEXT = {
  landing: 'Being landed: an edit before the lease ends is lost or conflicts when the change lands. Tell your user before editing this file.',
  queued: 'Queued: prefer letting the system land it, or dispatch it as a goal.',
  held: 'Held: the ruling says what lifts it; it is not open work.',
  none: 'Nothing in flight: make the change, and record it.',
  unplaced: 'No gap names these paths, but gaps without an edit site are not ruled out: make the change, and record it.',
};

// @anchor unplaced-gaps
/** Open gaps that carry no edit site, by category: path_activity can place them on a path only where their text names it. */
function unplacedGaps(rows: GapRow[]): { count: number; byCategory: string } {
  const counts = new Map<string, number>();
  for (const g of rows) {
    const site = g.classification_metadata?.['edit_site'];
    if (typeof site === 'string' && site.trim()) continue;
    counts.set(g.category ?? 'uncategorised', (counts.get(g.category ?? 'uncategorised') ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = top.slice(0, 4).map(([c, n]) => `${c} ${n}`).join(', ');
  return { count: top.reduce((n, [, k]) => n + k, 0), byCategory: top.length > 4 ? `${shown}, …` : shown };
}

export async function handle(input: PathActivityInput, _apiClient: AnalysisAPIClient): Promise<string> {
  return pathActivityReport(input, activeWorkspacePath());
}

/** The report for `input`, with paths mapped from `workspace`. */
export async function pathActivityReport(input: PathActivityInput, workspace: string): Promise<string> {
  const mapper = pathMapper(workspace);
  const open = await readGaps('open');
  if (!open.ok) {
    // A substrate that serves no gap store has nothing in flight to check: not an error to stop on before an edit.
    if (/^no_producer\(substrateGap\)/.test(open.message)) {
      return 'path_activity: this substrate keeps no gap store (no substrateGap producer answered), so there is nothing in flight to check on these paths. Go ahead with the edit; record_finding for anything you notice, mark_complete for what you fix.';
    }
    return `path_activity: ${open.message}`;
  }
  const closed = input.include_closed ? await readGaps('closed') : null;
  if (closed && !closed.ok) return `path_activity: ${closed.message}`;

  const lines: string[] = [];
  const seen = new Set<keyof typeof NEXT>();
  const unplaced = unplacedGaps(open.rows);
  let unmatched = false;
  if (mapper.kind === 'none') {
    lines.push('This repository is not one the gap store names (neither the super-repo nor a vessel checkout); only paths given as repos/<vessel>/… are checked.', '');
  }
  // The origin-basename rule maps any repository; one the substrate does not mount has no gaps,
  // and its "no open gaps" must not read as "nothing in flight".
  const unmounted = mapper.kind === 'vessel' && mapper.prefix && !storeNamesPrefix(open.rows, mapper.prefix) ? mapper.prefix : null;
  // @anchor unmounted-repo
  // The plugin's edit check (scripts/claude-plugin/edit-check.mjs) matches this sentence to stop asking for
  // path_activity in this repository: keep "may not be a repository this substrate mounts" in it.
  if (unmounted) {
    lines.push(`${unmounted.slice('repos/'.length)} may not be a repository this substrate mounts (no open gap names ${unmounted}/), so it has no gaps to show; only paths given as repos/<vessel>/… are checked.`, '');
  }
  for (const path of input.paths) {
    const storePath = unmounted && !path.replace(/\\/g, '/').startsWith('repos/') ? null : mapper.toStorePath(path);
    if (!storePath) {
      lines.push(`${path} — no gap names this path (the gap store places gaps on repos/<vessel>/… paths)`);
      if (mapper.kind === 'super-repo') unmatched = true;
      continue;
    }
    const hits = gapsForPath(open.rows, storePath);
    if (!hits.length) {
      lines.push(`${storePath} — ${open.truncated ? 'no open gaps found (the read may be truncated)' : 'no open gaps'}`);
      seen.add('none');
      if (mapper.kind !== 'none' && !unmounted) unmatched = true;
    } else {
      const landing = hits.filter((h) => !holdOf(h.gap) && landingLeaseOf(h.gap));
      const held = hits.filter((h) => holdOf(h.gap));
      const queued = hits.filter((h) => !holdOf(h.gap) && !landingLeaseOf(h.gap));
      const count = open.truncated ? 'open gaps (the read may be truncated, so no count)' : `${hits.length} open gap${hits.length === 1 ? '' : 's'}`;
      lines.push(`${storePath} — ${count}: ${landing.length} being landed by the system now, ${held.length} held, ${queued.length} queued`);
      if (landing.length) seen.add('landing');
      if (queued.length) seen.add('queued');
      if (held.length) seen.add('held');
      // Every gap being landed is listed: those are the ones not to race. Then held and queued, strongest match first.
      const limit = input.limit ?? 10;
      const rest = [...held.slice(0, Math.ceil(limit / 3)), ...queued].slice(0, limit);
      for (const h of [...landing, ...rest]) lines.push(...renderGap(h.gap, h.match));
      const shown = landing.length + rest.length;
      if (hits.length > shown) lines.push(`  … and ${hits.length - shown} more (limit raises this; a narrower path shows fewer)`);
    }
    if (closed?.ok) {
      const done = gapsForPath(closed.rows, storePath);
      if (done.length) lines.push(`  closed: ${done.slice(0, 10).map((h) => h.gap.id).join(', ')}${done.length > 10 ? ` and ${done.length - 10} more` : ''}`);
    }
  }
  if (unmatched && unplaced.count) {
    lines.push('', `${open.truncated ? 'At least ' : ''}${unplaced.count} open gap${unplaced.count === 1 ? ' carries' : 's carry'} no edit site (${unplaced.byCategory}), so they are matched to a path only where their text names it: "no gap names this path" does not rule them out.`);
    seen.delete('none');
    seen.add('unplaced');
  }
  const next = (['landing', 'queued', 'held', 'none', 'unplaced'] as const).filter((k) => seen.has(k)).map((k) => NEXT[k]);
  if (next.length) lines.push('', ...next);
  return lines.join('\n');
}
