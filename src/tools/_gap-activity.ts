// Contract (behaviour): SPEC §path_activity
/**
 * What the system has in flight on files: the open gaps that name them, read from the
 * gap store through the `substrateGap` shape, with each gap's landing lease or hold.
 * Shared by path_activity and the one-line summaries in analyze_impact and
 * assign_git_changes.
 *
 * The store has no path filter and answers the newest `limit` rows by `updated_at`, with
 * `total` counting the page. A file's gaps are mostly old rows, which a recency page drops,
 * so the read is the whole open store (about 13 MB on a busy node). It is cached per
 * attachment: fresh for READ_TTL_MS, then served stale while one background read refreshes
 * it, up to MAX_STALE_MS; concurrent callers share one read. analyze_impact and
 * assign_git_changes only use a warm cache and never start a read themselves. The store's
 * holder runs hot, and many agents checking on every edit must not each pull the store.
 */

import { existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { describeResolveFailure, getAttachment, resolveShape, substrateRefusal } from '../attachment.js';
import { normalizeRemoteUrl } from '../repo-identity.js';

/** The full-read limit: larger than any store, so the answer is the whole store. */
export const FULL_READ_LIMIT = 1_000_000;
/** How long a read is fresh. */
export const READ_TTL_MS = 5 * 60_000;
/** How long a stale read is still served while a background read refreshes it. */
export const MAX_STALE_MS = 30 * 60_000;
const READ_TIMEOUT_MS = 30_000;

export interface GapRow {
  id: string;
  category?: string;
  status?: string;
  summary?: string;
  route?: string;
  updated_at?: string;
  remedy?: { goal?: string; vessel?: string };
  classification_metadata?: Record<string, unknown>;
}

export type GapRead =
  | { ok: true; rows: GapRow[]; truncated: boolean; readAt: number }
  | { ok: false; message: string };

type CachedRead = GapRead & { ok: true };
interface Slot { read?: CachedRead; inFlight?: Promise<GapRead> }
/** Reads cached per attachment, so a read never serves a different substrate or key. */
let cache = new WeakMap<object, Map<string, Slot>>();
const DETACHED = {};

/** Forget cached reads (tests). */
export function clearGapReadCache(): void {
  cache = new WeakMap();
}

function slotFor(status: string): Slot {
  const owner = getAttachment() ?? DETACHED;
  let slots = cache.get(owner);
  if (!slots) { slots = new Map(); cache.set(owner, slots); }
  let slot = slots.get(status);
  if (!slot) { slot = {}; slots.set(status, slot); }
  return slot;
}

/** Start the store read for `slot` unless one is in flight; concurrent callers share it. */
function startRead(slot: Slot, status: 'open' | 'closed'): Promise<GapRead> {
  slot.inFlight ??= fetchGaps(status).then((r) => {
    if (r.ok) slot.read = r;
    slot.inFlight = undefined;
    return r;
  });
  return slot.inFlight;
}

/**
 * The whole store for `status`: the cached read while fresh; a stale one (up to
 * MAX_STALE_MS) at once while a background read refreshes it; otherwise a new read.
 */
export async function readGaps(status: 'open' | 'closed', now = Date.now()): Promise<GapRead> {
  const slot = slotFor(status);
  const age = slot.read ? now - slot.read.readAt : Infinity;
  if (age < READ_TTL_MS) return slot.read!;
  if (age < MAX_STALE_MS) {
    void startRead(slot, status);
    return slot.read!;
  }
  return startRead(slot, status);
}

/** The cached read for `status` if there is one not past MAX_STALE_MS; never starts a read. */
export function peekGaps(status: 'open' | 'closed', now = Date.now()): CachedRead | null {
  const read = slotFor(status).read;
  return read && now - read.readAt < MAX_STALE_MS ? read : null;
}

async function fetchGaps(status: 'open' | 'closed', now = Date.now()): Promise<GapRead> {
  let res;
  try {
    res = await resolveShape(
      { type: 'substrateGap', status, limit: FULL_READ_LIMIT, ...(status === 'open' ? { include_held: true } : {}) },
      { timeoutMs: READ_TIMEOUT_MS, read: true },
    );
  } catch (err) {
    return { ok: false, message: describeResolveFailure(err) };
  }
  if (res.status !== 200) return { ok: false, message: `substrateGap answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}` };
  // development-vessel answers `{ shape, body: { gaps } }`; a forward may wrap it as `content`
  // (an object, or a JSON string).
  let body: any = res.body;
  for (let depth = 0; depth < 3 && body && !Array.isArray(body.gaps); depth++) {
    const inner = body.body ?? body.content;
    if (typeof inner === 'string') {
      try { body = JSON.parse(inner); } catch { break; }
    } else {
      body = inner;
    }
  }
  const rows = Array.isArray(body?.gaps) ? (body.gaps as GapRow[]) : null;
  if (!rows) return { ok: false, message: 'substrateGap returned no gap list' };
  return { ok: true as const, rows, truncated: rows.length >= FULL_READ_LIMIT, readAt: now };
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}

export interface PathMapper {
  /** How the workspace maps: the super-repo, one vessel's checkout, or neither. */
  kind: 'super-repo' | 'vessel' | 'none';
  /** `repos/<vessel>` for a vessel checkout. */
  prefix?: string;
  root?: string;
  /** The store path for a local or `repos/…` path, or null when it cannot be named. */
  toStorePath(path: string): string | null;
}

/**
 * Map the workspace's paths to the gap store's form, `repos/<vessel>/<path>`: relative to
 * the root in the super-repo (a `repos/` directory at the top of the tree), prefixed with
 * `repos/<name>` in a vessel's own checkout, where `<name>` is the basename of the
 * `origin` remote's path. A path already in `repos/…` form is used as given.
 */
/**
 * `p` in its real, long form, resolved through its longest existing ancestor (the file may
 * not exist yet). On Windows git prints `C:/Users/...` while a temp path can carry 8.3
 * short names, so both sides of a relative() must be real.
 */
function real(p: string): string {
  const abs = resolve(p);
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail);
    } catch {
      const up = dirname(head);
      if (up === head) return abs;
      tail.unshift(basename(head));
      head = up;
    }
  }
}

export function pathMapper(workspace: string): PathMapper {
  const ws = real(workspace);
  const top = git(ws, ['rev-parse', '--show-toplevel']);
  const root = real(top ?? ws);
  const given = (p: string) => (p.replace(/\\/g, '/').replace(/^\.\//, '').startsWith('repos/') ? p.replace(/\\/g, '/').replace(/^\.\//, '') : null);
  const rel = (p: string) => {
    const r = relative(root, real(isAbsolute(p) ? p : resolve(ws, p))).replace(/\\/g, '/');
    return r && !r.startsWith('..') && !isAbsolute(r) ? r : null;
  };
  if (existsSync(join(root, 'repos'))) {
    return { kind: 'super-repo', root, toStorePath: (p) => given(p) ?? (rel(p)?.startsWith('repos/') ? rel(p) : null) };
  }
  const url = git(root, ['remote', 'get-url', 'origin']);
  const origin = url ? normalizeRemoteUrl(url, root) : null;
  if (origin) {
    const prefix = `repos/${basename(origin)}`;
    return { kind: 'vessel', root, prefix, toStorePath: (p) => given(p) ?? (rel(p) ? `${prefix}/${rel(p)}` : null) };
  }
  return { kind: 'none', root, toStorePath: given };
}

export type MatchKind = 'edit site' | 'in directory' | 'mentioned';

const PARKING = new Set(['needs_information', 'needs_info', 'awaiting_operator_review']);

/** A gap's hold, when it is held: why, and when it is reviewed and how it lifts if recorded. */
export function holdOf(g: GapRow): { why: string; reviewBy?: string; lift?: string } | null {
  const m = g.classification_metadata ?? {};
  const disposition = typeof m['disposition'] === 'string' ? (m['disposition'] as string) : '';
  const held = m['operator_hold'] === true || PARKING.has(disposition) || Boolean(m['pending_outcome_verification']);
  if (!held) return null;
  let reviewBy: string | undefined;
  let lift: string | undefined;
  for (const v of Object.values(m)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o['review_by'] === 'string') reviewBy ??= o['review_by'] as string;
      if (typeof o['lift'] === 'string') lift ??= o['lift'] as string;
    }
  }
  const reason = typeof m['operator_hold_reason'] === 'string' ? (m['operator_hold_reason'] as string) : '';
  const why = m['operator_hold'] === true
    ? `held by operator ruling${reason ? `: ${reason}` : ''}`
    : m['pending_outcome_verification'] ? 'held: a landing awaits its verdict' : `held: ${disposition}`;
  return { why, reviewBy, lift };
}

export interface LandingLease { holder: string; attempt?: string; until?: string }

/** A gap's landing lease, exactly as stored, live or lapsed; the holder is the caller's own claim. */
export function storedLandingLease(g: GapRow): LandingLease | null {
  const l = g.classification_metadata?.['landing_lease'] as Record<string, unknown> | undefined;
  return l && typeof l['holder'] === 'string'
    ? { holder: l['holder'] as string, attempt: l['attempt'] as string | undefined, until: l['until'] as string | undefined }
    : null;
}

/** Clock skew allowed in favour of a live lease: a slightly fast local clock never frees a landing early. */
export const LEASE_SKEW_MS = 2 * 60_000;

/** A stored lease's state: live, lapsed (its `until` passed, with the skew allowance), or with no expiry recorded. */
export function leaseState(l: LandingLease, now = Date.now()): 'live' | 'lapsed' | 'no_expiry' {
  const t = l.until ? Date.parse(l.until) : NaN;
  if (!Number.isFinite(t)) return 'no_expiry';
  return t + LEASE_SKEW_MS <= now ? 'lapsed' : 'live';
}

/** Whether a stored lease has passed its `until`: the store keeps lapsed leases until the next write. */
export function leaseLapsed(l: LandingLease, now = Date.now()): boolean {
  return leaseState(l, now) === 'lapsed';
}

/** A gap's LIVE landing lease, or null when it has none, it has lapsed, or it records no expiry. */
export function landingLeaseOf(g: GapRow, now = Date.now()): LandingLease | null {
  const l = storedLandingLease(g);
  return l && leaseState(l, now) === 'live' ? l : null;
}

/** An instant as `2026-10-20 12:05Z (11 h ago)`: the date, and how long ago or ahead. */
function when(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return iso ?? '?';
  const d = new Date(t).toISOString();
  const mins = Math.round((t - now) / 60_000);
  const span = Math.abs(mins) >= 120 ? `${Math.round(Math.abs(mins) / 60)} h` : `${Math.abs(mins)} min`;
  return `${d.slice(0, 10)} ${d.slice(11, 16)}Z (${mins < 0 ? `${span} ago` : `in ${span}`})`;
}

/** The gaps naming `storePath`, strongest match first, then most recently updated. */
export function gapsForPath(rows: GapRow[], storePath: string): Array<{ gap: GapRow; match: MatchKind }> {
  const dir = storePath.replace(/\/+$/, '');
  const order: Record<MatchKind, number> = { 'edit site': 0, 'in directory': 1, mentioned: 2 };
  const out: Array<{ gap: GapRow; match: MatchKind }> = [];
  for (const g of rows) {
    const site = typeof g.classification_metadata?.['edit_site'] === 'string' ? (g.classification_metadata['edit_site'] as string).trim() : '';
    let match: MatchKind | null = null;
    if (site && site === dir) match = 'edit site';
    else if (site && site.startsWith(`${dir}/`)) match = 'in directory';
    else if ((g.remedy?.goal ?? '').includes(dir) || (g.summary ?? '').includes(dir)) match = 'mentioned';
    if (match) out.push({ gap: g, match });
  }
  return out.sort((a, b) => order[a.match] - order[b.match] || (b.gap.updated_at ?? '').localeCompare(a.gap.updated_at ?? ''));
}


/** One gap as path_activity prints it. */
export function renderGap(g: GapRow, match: MatchKind): string[] {
  const head = `  ${g.id}  ${g.category ?? '?'}${g.route ? `  route ${g.route}` : ''}  ${match}`;
  const hold = holdOf(g);
  const lease = landingLeaseOf(g);
  const stale = lease ? null : storedLandingLease(g);
  if (hold) {
    return [`${head}`, `    ${hold.why}${hold.reviewBy ? `; review by ${when(hold.reviewBy)}` : '; no review date recorded'}${hold.lift ? `; lift: ${hold.lift}` : ''}`];
  }
  if (lease) {
    return [`${head}`, `    landing lease: held by ${lease.holder} (the holder's own claim)${lease.attempt ? `, attempt ${lease.attempt}` : ''}, until ${when(lease.until)}: the system is landing a change to this file now, and its landing replaces the file, so an edit made before then is lost or conflicts. Don't edit it yet: tell your user, or wait and check again with path_activity`];
  }
  if (stale && leaseState(stale) === 'no_expiry') {
    return [`${head}`, `    landing lease held by ${stale.holder}, no expiry recorded (may be stale): not counted as being landed; check before editing`];
  }
  if (stale) {
    return [`${head}`, `    landing lease lapsed at ${when(stale.until)} (held by ${stale.holder}): not being landed now; queued for the system`];
  }
  return [`${head}   no landing lease: queued for the system`];
}

/**
 * Whether the store names any gap under `prefix` (`repos/<vessel>`): a vessel the substrate
 * mounts has gaps; a repository it does not mount has none, and "no open gaps" there would
 * falsely read as "nothing in flight".
 */
export function storeNamesPrefix(rows: GapRow[], prefix: string): boolean {
  const p = `${prefix}/`;
  return rows.some((g) => {
    const site = g.classification_metadata?.['edit_site'];
    return (typeof site === 'string' && site.startsWith(p)) || (g.remedy?.goal ?? '').includes(p) || (g.summary ?? '').includes(p);
  });
}

/**
 * The one-line summary for analyze_impact and assign_git_changes: per file, its open gaps
 * and any held landing lease, from a warm cache only — these tools never start the store
 * read. Without one, a single line points at path_activity. Empty when there is no
 * attachment, the attachment refuses, or the workspace does not map.
 */
export async function gapSummaryLines(files: string[], workspace: string): Promise<string[]> {
  if (!getAttachment() || (await substrateRefusal())) return [];
  const mapper = pathMapper(workspace);
  if (mapper.kind === 'none') return [];
  const read = peekGaps('open');
  if (!read) return ['', "Open gaps on these files aren't loaded yet; path_activity shows them."];
  if (mapper.kind === 'vessel' && mapper.prefix && !storeNamesPrefix(read.rows, mapper.prefix)) return [];
  const lines: string[] = [];
  for (const f of files) {
    const p = mapper.toStorePath(f);
    if (!p) continue;
    const hits = gapsForPath(read.rows, p);
    if (!hits.length) continue;
    const leased = hits.filter((h) => !holdOf(h.gap) && landingLeaseOf(h.gap));
    const held = hits.filter((h) => holdOf(h.gap));
    lines.push(`  ${f}: ${read.truncated ? 'open gaps (the read may be truncated)' : `${hits.length} open gap(s)`}${leased.length ? `, ${leased.length} being landed by the system now` : ''}${held.length ? `, ${held.length} held` : ''}`);
  }
  return lines.length ? ['', 'In flight on the substrate (path_activity for detail):', ...lines] : [];
}

/**
 * The open gaps whose edit site is one of `files`, from a warm cache only (never a read): for record_finding to
 * say a gap may already describe what it records, since get_problems shows findings and not gaps. Empty when
 * there is no attachment, no cache, or the workspace does not map. Not a refusal: a busy file has hundreds of
 * gaps, and one on the same file need not be the same issue.
 */
export async function openGapsOnFilesLines(files: string[], workspace: string, perFile = 3): Promise<string[]> {
  if (!getAttachment() || (await substrateRefusal())) return [];
  // Any workspace: a path given in the store's repos/<vessel>/… form maps as given.
  const mapper = pathMapper(workspace);
  const read = peekGaps('open');
  if (!read) return [];
  const lines: string[] = [];
  for (const f of files) {
    const p = mapper.toStorePath(f);
    if (!p) continue;
    const hits = gapsForPath(read.rows, p).filter((h) => h.match === 'edit site');
    if (!hits.length) continue;
    lines.push(`  ${f}: ${hits.length} open gap(s) have this file as their edit site; one may already describe this:`);
    for (const h of hits.slice(0, perFile)) lines.push(`    ${h.gap.id}: ${(h.gap.summary ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
    if (hits.length > perFile) lines.push(`    … and ${hits.length - perFile} more (path_activity lists them)`);
  }
  return lines.length ? ['', 'Already on the substrate (the system\'s own gaps, which get_problems does not show):', ...lines] : [];
}
