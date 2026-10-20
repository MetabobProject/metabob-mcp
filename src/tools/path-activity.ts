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
import { gapsForPath, holdOf, landingLeaseOf, pathMapper, readGaps, renderGap, storeNamesPrefix } from './_gap-activity.js';

export const PathActivityTool = {
  name: 'path_activity',
  description:
    "Before editing shared files: what the substrate has in flight on them. For each path, the open gaps that name it (as their edit site, in a directory, or in their goal), and for each gap whether the system is landing it right now (a held landing lease: wait, don't race it), it is queued for the system (prefer letting it land, or dispatch it), or it is held by an operator ruling (with its review date). Paths are workspace-relative or in the gap store's `repos/<vessel>/…` form. Read-only.",
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
  landing: 'Being landed: wait and look again; the change may land.',
  queued: 'Queued: prefer letting the system land it, or dispatch it as a goal.',
  held: 'Held: the ruling says what lifts it; it is not open work.',
  none: 'Nothing in flight: make the change, and record it.',
};

export async function handle(input: PathActivityInput, _apiClient: AnalysisAPIClient): Promise<string> {
  const mapper = pathMapper(activeWorkspacePath());
  const open = await readGaps('open');
  if (!open.ok) return `path_activity: ${open.message}`;
  const closed = input.include_closed ? await readGaps('closed') : null;
  if (closed && !closed.ok) return `path_activity: ${closed.message}`;

  const lines: string[] = [];
  const seen = new Set<keyof typeof NEXT>();
  if (mapper.kind === 'none') {
    lines.push('This repository is not one the gap store names (neither the super-repo nor a vessel checkout); only paths given as repos/<vessel>/… are checked.', '');
  }
  // The origin-basename rule maps any repository; one the substrate does not mount has no gaps,
  // and its "no open gaps" must not read as "nothing in flight".
  const unmounted = mapper.kind === 'vessel' && mapper.prefix && !storeNamesPrefix(open.rows, mapper.prefix) ? mapper.prefix : null;
  if (unmounted) {
    lines.push(`${unmounted.slice('repos/'.length)} is not a repository this substrate mounts (no open gap names ${unmounted}/), so its gaps do not apply here; only paths given as repos/<vessel>/… are checked.`, '');
  }
  for (const path of input.paths) {
    const storePath = unmounted && !path.replace(/\\/g, '/').startsWith('repos/') ? null : mapper.toStorePath(path);
    if (!storePath) {
      lines.push(`${path} — not a path the gap store names`);
      continue;
    }
    const hits = gapsForPath(open.rows, storePath);
    if (!hits.length) {
      lines.push(`${storePath} — ${open.truncated ? 'no open gaps found (the read may be truncated)' : 'no open gaps'}`);
      seen.add('none');
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
  const next = (['landing', 'queued', 'held', 'none'] as const).filter((k) => seen.has(k)).map((k) => NEXT[k]);
  if (next.length) lines.push('', ...next);
  return lines.join('\n');
}
