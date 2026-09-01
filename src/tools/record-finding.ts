/**
 * record_finding — the write half of agent-side analysis.
 *
 * The agent (not the server) does the LLM work: it notices an issue, a
 * constraint, or a risk while working, and calls this tool to ATTRIBUTE that
 * observation to concrete code. The server then:
 *
 *  1. upserts a SeedRecord per file into the LocalStore so `get_problems`
 *     surfaces it immediately in this session (ids are `agf_*` —
 *     agent finding — and flow through mark_complete like any problem), and
 *  2. best-effort mints a `code_finding` concept into concept-db so OTHER
 *     agents' sessions working on the same repo/region recall it org-wide.
 *
 * concept-db unreachable is non-fatal and reported in the output.
 */

import { z } from 'zod';
import { basename, isAbsolute, relative } from 'node:path';
import type { AnalysisAPIClient } from '../api-client.js';
import type { LocalStore } from '../local-store.js';
import { activeWorkspacePath } from '../local-index.js';
import {
  CONCEPT_REF_PREFIX,
  FINDING_SHAPE,
  attributionLines,
  postConcept,
  resolveAuthorVesselId,
  resolveConceptDbUrl,
} from './_findings.js';
import type { SeedRecord } from '../local-store.js';

export const RecordFindingTool = {
  name: 'record_finding',
  description:
    'Record something you (the agent) noticed about specific code — a bug, a security risk, a design constraint, a gotcha. The finding is attributed to the given files, surfaces immediately via get_problems in this session, and is shared (best-effort) to the org-wide concept graph so other agents working on the same region of this codebase see it. Use mark_complete on the returned agf_* id to endorse (fixed) or discard (retract) it later.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      files: {
        type: 'array',
        description: 'Files the finding is attributed to (workspace-relative or absolute)',
        items: { type: 'string' },
      },
      summary: {
        type: 'string',
        description: 'One-line description of the finding',
      },
      details: {
        type: 'string',
        description: 'Optional longer explanation, reproduction notes, or suggested fix',
      },
      severity: {
        type: 'string',
        enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'],
        description: 'Severity of the finding',
      },
      category: {
        type: 'string',
        description: 'Free-form category slug, e.g. security, correctness, design-constraint',
      },
      line_start: {
        type: 'number',
        description: 'Optional start line the finding refers to',
      },
      line_end: {
        type: 'number',
        description: 'Optional end line the finding refers to',
      },
      status: {
        type: 'string',
        description: 'Finding status (default: open)',
        default: 'open',
      },
    },
    required: ['files', 'summary', 'severity', 'category'],
  },
};

export const InputSchema = z.object({
  files: z.array(z.string().min(1)).min(1),
  summary: z.string().min(1),
  details: z.string().optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
  category: z.string().min(1),
  line_start: z.number().int().nonnegative().optional(),
  line_end: z.number().int().nonnegative().optional(),
  status: z.string().default('open'),
});

export type RecordFindingInput = z.infer<typeof InputSchema>;

function generateFindingId(): string {
  return `agf_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Normalize a file path to workspace-relative when possible. */
function toWorkspaceRelative(filePath: string, workspacePath: string | null): string {
  if (workspacePath && isAbsolute(filePath)) {
    const rel = relative(workspacePath, filePath);
    if (rel && !rel.startsWith('..')) return rel;
  }
  return filePath;
}

export async function handle(
  input: RecordFindingInput,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<string> {
  const startTime = Date.now();
  // Attribution must not depend on whether init_workspace ran in THIS process —
  // see activeWorkspacePath. Reading the index directly here is what produced
  // `repo: unknown` on every finding recorded without a prior in-process index.
  const workspacePath = activeWorkspacePath();
  // Attribution (repo name, relative paths) comes from the index; the PARTITION
  // must come from the store that will have to read the row back. The two are
  // usually the same root, and when they were not — a store bound to one
  // workspace, an index pointed at another — the seed was written under a
  // workspace_id this store never queries, so record_finding reported success
  // and get_problems returned nothing.
  const workspaceId = localStore ? localStore.workspaceScope().id : workspacePath;
  const repoName = basename(workspacePath) || 'unknown';

  const relFiles = input.files.map(f => toWorkspaceRelative(f, workspacePath));
  const lineStart = input.line_start ?? 0;
  const lineEnd = input.line_end ?? lineStart;

  // ── 1. Local seeds — immediate in-session surfacing via get_problems ───────
  const ids: Array<{ file: string; id: string }> = [];
  const seedPayloads: Array<Omit<SeedRecord, 'read_at'>> = [];
  const now = Date.now();
  let localStatus = 'local cache unavailable — finding not cached in-session';
  if (localStore) {
    for (const file of relFiles) {
      const id = generateFindingId();
      const seed: Omit<SeedRecord, 'read_at'> = {
        id,
        workspace_id: workspaceId,
        file_path: file,
        line_start: lineStart,
        line_end: lineEnd,
        category: input.category,
        severity: input.severity,
        brief: input.summary,
        confidence: 1,
        refs_json: '[]',
        produced_at: now,
        stale: input.status !== 'open',
      };
      localStore.upsertSeed(seed);
      seedPayloads.push(seed);
      ids.push({ file, id });
    }
    localStatus = `cached locally — visible to get_problems in this session`;
  }

  // ── 2. Best-effort org-wide share via concept-db ────────────────────────────
  let conceptStatus: string;
  const conceptDbUrl = await resolveConceptDbUrl(apiClient);
  if (!conceptDbUrl) {
    conceptStatus = 'concept-db not configured — finding recorded locally only';
  } else {
    const contentLines = [
      `repo: ${repoName}`,
      `workspace: ${workspaceId}`,
      `files: ${relFiles.join(', ')}`,
    ];
    if (input.line_start !== undefined) {
      contentLines.push(`lines: ${lineStart}–${lineEnd}`);
    }
    contentLines.push(
      `severity: ${input.severity}`,
      `category: ${input.category}`,
      `status: ${input.status}`,
      `finding_ids: ${ids.map(x => x.id).join(', ') || '(not cached locally)'}`,
    );
    // Author + session. A finding with no resolvable vessel identity carries NO
    // recorded_by line at all — readers render that as "unattributed" rather
    // than inheriting a guess. These must stay in the key:value header block:
    // `details` below is free text after a blank line and is not parsed.
    contentLines.push(...attributionLines('recorded_by', await resolveAuthorVesselId(), sessionId));
    if (input.details) contentLines.push('', input.details);

    const result = await postConcept(conceptDbUrl, {
      content: contentLines.join('\n'),
      summary: `[${input.severity}][${input.category}] ${repoName}: ${input.summary}`,
      shape: FINDING_SHAPE,
      source_type: 'metabob_annotation',
      pointer: { type: FINDING_SHAPE },
    });
    conceptStatus = result.ok
      ? `shared org-wide via concept-db (concept ${result.id ?? '?'})`
      : `concept-db unreachable (${result.error}) — finding recorded locally only`;

    // Stash the minted concept id on each seed so a later mark_complete can
    // attribute a usage/relevance signal to it (see _findings.conceptIdFromRefs).
    if (result.ok && result.id && localStore && seedPayloads.length > 0) {
      const refs = JSON.stringify([`${CONCEPT_REF_PREFIX}${result.id}`]);
      for (const seed of seedPayloads) {
        localStore.upsertSeed({ ...seed, refs_json: refs });
      }
    }
  }

  // ── Output ──────────────────────────────────────────────────────────────────
  const duration = Date.now() - startTime;
  let text = `Finding recorded: [${input.severity}][${input.category}] ${input.summary}\n\n`;
  if (ids.length > 0) {
    for (const { file, id } of ids) {
      text += `  ${file}${input.line_start !== undefined ? `:${lineStart}–${lineEnd}` : ''}  →  ${id}\n`;
    }
    text += '\n';
  } else {
    text += `  files: ${relFiles.join(', ')}\n\n`;
  }
  text += `  local:      ${localStatus}\n`;
  text += `  concept-db: ${conceptStatus}\n\n`;
  text += `Use mark_complete { problem_id: "<agf id>", action: "endorse"|"discard" } when resolved or retracted.\n`;
  text += `Recorded in ${duration}ms`;
  return text;
}
