// Contract (input schema, behaviour): SPEC §record_finding
/**
 * record_finding — the write half of agent-side analysis.
 *
 * The agent (not the server) does the LLM work: it notices an issue, a
 * constraint, or a risk while working, and calls this tool to ATTRIBUTE that
 * observation to concrete code, or, for work that edits nothing (investigate,
 * test, review, operate), to a subject. The server then:
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
import { isAbsolute, relative } from 'node:path';
import type { AnalysisAPIClient } from '../api-client.js';
import { workspaceIdHash, type LocalStore } from '../local-store.js';
import { activeWorkspacePath } from '../local-index.js';
import { openGapsOnFilesLines } from './_gap-activity.js';
import {
  CONCEPT_REF_PREFIX,
  SUBJECT_REF_PREFIX,
  FINDING_SHAPE,
  attributionLines,
  postConcept,
  resolveAuthorVesselId,
  conceptDbReachable,
  conceptDbUnavailable,
  fetchAgentFindings,
  findOpenDuplicate,
  repoLines,
  workspaceRepo,
} from './_findings.js';
import type { SeedRecord } from '../local-store.js';

export const RecordFindingTool = {
  name: 'record_finding',
  description:
    'Record something you (the agent) noticed about specific code — a bug, a security risk, a design constraint, a gotcha — or a task for another agent. The finding is attributed to the given files, or, for work that changes no file (investigate, test, review, operate), to a subject; either way it belongs to this repository, surfaces immediately via get_problems in this session, and is shared (best-effort) to the org-wide concept graph so other agents working on this codebase see it. Use mark_complete on the returned agf_* id to endorse (fixed, or done) or discard (retract) it later.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      files: {
        type: 'array',
        description: 'Files the finding is attributed to (workspace-relative or absolute). Leave out for work that changes no file, and name a subject instead',
        items: { type: 'string' },
      },
      subject: {
        type: 'string',
        description: 'What the finding or task is about when it is not a file, or besides its files: an issue URL or number, a document, a service or endpoint, a message id, a topic',
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
        description: 'Optional start line the finding refers to, in the first of `files` (the others get no line range)',
      },
      line_end: {
        type: 'number',
        description: 'Optional end line, in the first of `files`',
      },
      status: {
        type: 'string',
        description: 'Finding status (default: open)',
        default: 'open',
      },
      force: {
        type: 'boolean',
        description: 'Record even when an open finding with a near-identical summary is already recorded on one of these files (default: false — the existing finding id is returned instead)',
        default: false,
      },
    },
    required: ['summary', 'severity', 'category'],
  },
};

export const InputSchema = z.object({
  files: z.array(z.string().min(1)).default([]),
  subject: z.string().trim().min(1).optional(),
  summary: z.string().min(1),
  details: z.string().optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
  category: z.string().min(1),
  line_start: z.number().int().nonnegative().optional(),
  line_end: z.number().int().nonnegative().optional(),
  status: z.string().default('open'),
  force: z.boolean().default(false),
}).refine(v => v.files.length > 0 || v.subject !== undefined, {
  message: 'name what it is about: files, or a subject (an issue, document, service or topic) for work that changes no file',
  path: ['files'],
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
  // Its hash either way: the workspace's path never leaves the machine.
  const workspaceId = localStore ? localStore.workspaceScope().id : workspaceIdHash(workspacePath);
  // The ledger key (SPEC §repository-identity): the normalized origin URL, else
  // the basename. The summary line shows the basename, for readers.
  const repo = workspaceRepo();
  const repoName = repo?.name || 'unknown';

  const relFiles = input.files.map(f => toWorkspaceRelative(f, workspacePath));
  // A finding that names no file is one seed with no path: the work it records changes nothing in the tree.
  const seedFiles = relFiles.length ? relFiles : [''];
  const lineStart = input.line_start ?? 0;
  const lineEnd = input.line_end ?? lineStart;

  // ── 0. Already recorded? ────────────────────────────────────────────────────
  // An agent that skipped orientation re-records what is already open. Check
  // this machine's store and the shared recall for an open finding on one of
  // these files with the same summary (_findings.ts@duplicate-finding), and hand
  // back its id instead of a second finding. SPEC §record_finding
  if (input.status === 'open' && !input.force) {
    const recall = await fetchAgentFindings(apiClient, { repo });
    const dup = findOpenDuplicate(relFiles, input.summary, localStore, recall, input.subject);
    if (dup) {
      const lines = [
        `Already recorded (open): ${dup.id} — use mark_complete or add details there.`,
        `  existing: ${dup.summary}`,
        `  ${dup.files.length ? `files:    ${dup.files.join(', ')}` : `subject:  ${dup.subject ?? '(none)'}`}`,
        `  where:    ${dup.where}${dup.conceptId && dup.conceptId !== dup.id ? ` (concept ${dup.conceptId})` : ''}`,
        '',
        'Nothing new was recorded. Pass force: true to record it as a separate finding.',
      ];
      return lines.join('\n');
    }
  }

  // ── 1. Local seeds — immediate in-session surfacing via get_problems ───────
  const ids: Array<{ file: string; id: string }> = [];
  const seedPayloads: Array<Omit<SeedRecord, 'read_at'>> = [];
  const now = Date.now();
  let localStatus = 'local cache unavailable — finding not cached in-session';
  if (localStore) {
    for (const [i, file] of seedFiles.entries()) {
      const id = generateFindingId();
      // The line range anchors the first file only: the others of a multi-file finding get none, not a wrong one.
      const anchored = i === 0;
      const seed: Omit<SeedRecord, 'read_at'> = {
        id,
        workspace_id: workspaceId,
        file_path: file,
        line_start: anchored ? lineStart : 0,
        line_end: anchored ? lineEnd : 0,
        category: input.category,
        severity: input.severity,
        brief: input.summary,
        confidence: 1,
        refs_json: input.subject ? JSON.stringify([`${SUBJECT_REF_PREFIX}${input.subject}`]) : '[]',
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
  if (!(await conceptDbReachable())) {
    conceptStatus = `${await conceptDbUnavailable()} — finding recorded locally only`;
  } else {
    const contentLines = [
      ...repoLines(repo),
      `workspace: ${workspaceId}`,
      ...(relFiles.length ? [`files: ${relFiles.join(', ')}`] : []),
      ...(input.subject ? [`subject: ${input.subject.replace(/\s+/g, ' ')}`] : []),
    ];
    if (input.line_start !== undefined && relFiles.length) {
      contentLines.push(`lines: ${lineStart}–${lineEnd}${relFiles.length > 1 ? ` (in ${relFiles[0]})` : ''}`);
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

    const result = await postConcept({
      content: contentLines.join('\n'),
      summary: `[${input.severity}][${input.category}] ${repoName}: ${input.summary}`,
      shape: FINDING_SHAPE,
      source_type: 'metabob_annotation',
      pointer: { type: FINDING_SHAPE },
    });
    conceptStatus = result.ok
      ? `shared org-wide via concept-db (concept ${result.id ?? '?'})`
      : /^key_read_only/.test(result.error ?? '') ? `not shared (${result.error}) — finding recorded locally only; other agents will not see it` : `concept-db unreachable (${result.error}) — finding recorded locally only`;

    // Stash the minted concept id on each seed so a later mark_complete can
    // attribute a usage/relevance signal to it (see _findings.conceptIdFromRefs).
    if (result.ok && result.id && localStore && seedPayloads.length > 0) {
      const refs = JSON.stringify([`${CONCEPT_REF_PREFIX}${result.id}`, ...(input.subject ? [`${SUBJECT_REF_PREFIX}${input.subject}`] : [])]);
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
      text += file
        ? `  ${file}${input.line_start !== undefined && file === relFiles[0] ? `:${lineStart}–${lineEnd}` : ''}  →  ${id}\n`
        : `  subject: ${input.subject}  →  ${id}\n`;
    }
    text += '\n';
  } else {
    text += relFiles.length ? `  files: ${relFiles.join(', ')}\n\n` : `  subject: ${input.subject}\n\n`;
  }
  text += `  local:      ${localStatus}\n`;
  text += `  concept-db: ${conceptStatus}\n`;
  // The system's own gaps on these files: get_problems shows findings, not gaps, so a finding can duplicate one.
  const gaps = relFiles.length ? await openGapsOnFilesLines(relFiles, activeWorkspacePath()) : [];
  if (gaps.length) text += `${gaps.join('\n')}\n  If one is the same issue, mark_complete discard this finding.\n`;
  text += '\n';
  text += `Use mark_complete { problem_id: "<agf id>", action: "endorse"|"discard" } when resolved or retracted.\n`;
  text += `Recorded in ${duration}ms`;
  return text;
}
