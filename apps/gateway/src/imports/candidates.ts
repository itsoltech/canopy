import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { ui, type ImportThreadSummary } from "@canopy/contracts";
import { isWithinWorkspace, pathStyle } from "../store/paths.ts";

/**
 * Candidates of a scan (docs/import.md, "Przepływ"): filters, directory groups with a suggested target, and what a
 * thread can become after import. Pure: the caller brings the scan, the owner's workspaces on the worker and the
 * imports it already has.
 */

export interface WorkspaceRow {
  readonly id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly root_path: string;
}

/** What Canopy already has for a source (native id), from earlier imports or its own threads. */
export interface KnownSource {
  readonly threadId: string;
  /** imported | in_canopy */
  readonly status: string;
  /** Imported and untouched in Canopy: the source size the import read up to (more = has_new_turns). */
  readonly bytesDone?: bigint;
}

export interface CandidateContext {
  readonly os: string;
  readonly workspaces: readonly WorkspaceRow[];
  /** By `${agent_cli}:${native_id}`. */
  readonly known: ReadonlyMap<string, KnownSource>;
}

/** Share of the source size Canopy stores: bookkeeping records (request caches, token counts) are skipped. */
const STORED_SHARE = new Map([
  ["claude", 0.4],
  ["codex", 0.5],
  ["grok", 0.7],
]);

export function sourceKey(summary: Pick<ImportThreadSummary, "agentCli" | "nativeId">): string {
  return `${summary.agentCli}:${summary.nativeId}`;
}

export function matches(summary: ImportThreadSummary, filter: ui.ImportCandidateFilter | undefined): boolean {
  if (!filter) return !summary.subagent;

  if (!filter.includeSubagents && summary.subagent) return false;

  if (filter.agentClis.length > 0 && !filter.agentClis.includes(summary.agentCli)) return false;

  if (filter.origins.length > 0 && !filter.origins.includes(summary.origin)) return false;
  const updated = summary.updatedAt ? timestampMs(summary.updatedAt) : 0;

  if (filter.since && updated < timestampMs(filter.since)) return false;

  if (filter.until && updated > timestampMs(filter.until)) return false;

  if (filter.directory && !within(summary.cwd, filter.directory)) return false;
  const search = filter.search.trim().toLowerCase();

  return !search || `${summary.title}\n${summary.preview}`.toLowerCase().includes(search);
}

function within(path: string, directory: string): boolean {
  const base = directory.replace(/[\\/]+$/, "");

  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

/** The workspace that contains a directory (the deepest root), if the owner has one on this worker. */
export function workspaceFor(cwd: string, context: CandidateContext): WorkspaceRow | undefined {
  if (!cwd) return undefined;
  const style = pathStyle(context.os, cwd);

  return context.workspaces
    .filter((w) => isWithinWorkspace(cwd, w.root_path, style, context.os))
    .sort((a, b) => b.root_path.length - a.root_path.length)[0];
}

export function suggestion(cwd: string, exists: boolean, context: CandidateContext): ui.ImportTarget {
  const workspace = exists ? workspaceFor(cwd, context) : undefined;

  if (workspace)
    return create(ui.ImportTargetSchema, {
      kind: "workspace",
      projectId: workspace.project_id,
      workspaceId: workspace.id,
      projectName: workspace.project_name,
      cwd,
    });

  return create(ui.ImportTargetSchema, { kind: exists ? "create_project" : "missing", cwd });
}

/** Why a thread can only be history after import; empty when it can continue where it left off. */
export function historyReason(summary: ImportThreadSummary): string {
  if (summary.format === "empty") return "Nothing to import";

  if (summary.subagent) return "Subagent thread";

  if (!summary.cwdExists) return "Directory no longer exists";

  if (summary.format === "newer") return "Written by a newer CLI version";

  if (summary.format === "unknown") return "Unknown format version";

  return "";
}

export function candidateStatus(summary: ImportThreadSummary, context: CandidateContext): string {
  const known = context.known.get(sourceKey(summary));

  if (!known) return "new";

  return known.bytesDone !== undefined && historyBytes(summary) > known.bytesDone ? "has_new_turns" : known.status;
}

/** Statuses the owner can choose: new threads and imported ones the CLI has added turns to. */
export function selectable(status: string): boolean {
  return status === "new" || status === "has_new_turns";
}

export function candidate(summary: ImportThreadSummary, context: CandidateContext): ui.ImportCandidate {
  const known = context.known.get(sourceKey(summary));
  const reason = historyReason(summary);

  return create(ui.ImportCandidateSchema, {
    sourceKey: summary.sourceKey,
    agentCli: summary.agentCli,
    nativeId: summary.nativeId,
    title: summary.title,
    preview: summary.preview,
    cwd: summary.cwd,
    cwdExists: summary.cwdExists,
    ...(summary.startedAt && { startedAt: summary.startedAt }),
    ...(summary.updatedAt && { updatedAt: summary.updatedAt }),
    bytes: summary.bytes,
    turns: summary.turns,
    origin: summary.origin,
    cliVersion: summary.cliVersion,
    status: candidateStatus(summary, context),
    continueMode: reason ? "history" : "native",
    reason,
    subagent: summary.subagent,
    flaggedSecrets: summary.flaggedSecrets,
    threadId: known?.threadId ?? "",
    gitBranch: summary.gitBranch,
    archived: summary.archived,
  });
}

export function groups(
  summaries: readonly ImportThreadSummary[],
  context: CandidateContext,
): MessageInitShape<typeof ui.ImportDirectoryGroupSchema>[] {
  const byDirectory = new Map<string, { threads: number; bytes: bigint; exists: boolean }>();

  for (const s of summaries) {
    const group = byDirectory.get(s.cwd) ?? { threads: 0, bytes: 0n, exists: s.cwdExists };
    group.threads += 1;
    group.bytes += s.bytes;
    byDirectory.set(s.cwd, group);
  }

  return [...byDirectory]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([directory, g]) => ({
      directory,
      threads: g.threads,
      bytes: g.bytes,
      exists: g.exists,
      suggestion: suggestion(directory, g.exists, context),
    }));
}

export function estimatedBytes(summaries: readonly ImportThreadSummary[]): bigint {
  let total = 0;

  for (const s of summaries) total += Number(s.bytes) * (STORED_SHARE.get(s.agentCli) ?? 1);

  return BigInt(Math.round(total));
}

/** Newest first, then by title. */
export function byActivity(a: ImportThreadSummary, b: ImportThreadSummary): number {
  const at = (s: ImportThreadSummary) => (s.updatedAt ? timestampMs(s.updatedAt) : 0);

  return at(b) - at(a) || a.title.localeCompare(b.title);
}

/**
 * Size of the file the history is read from (the scan's snapshot): what an import's bytes_done is measured in. A
 * session's total size can include other files (Grok keeps several per session).
 */
export function historyBytes(summary: ImportThreadSummary): bigint {
  return summary.snapshot?.size ?? summary.bytes;
}
