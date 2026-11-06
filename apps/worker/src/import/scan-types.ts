import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ImportThreadSummarySchema } from "@canopy/contracts";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { isNumber, isString } from "../providers/json.ts";
import { maskedRecord, type Masker } from "./masking.ts";
import { signSourceKey, type ImportRootPath } from "./source-key.ts";
import type { Snapshot } from "./read.ts";

export type SummaryInit = MessageInitShape<typeof ImportThreadSummarySchema>;

/** What every scanner gets: the root, signing, masking and the limits of this scan. */
export interface ScanContext {
  readonly key: Buffer;
  readonly masker: Masker;
  /** Stop when this returns true (thread limit or time budget); the scan is then truncated. */
  readonly full: () => boolean;
  readonly exists: (path: string) => boolean;
  skipped: number;
}

/** Files up to this size are read whole during a scan (exact turn count and title). */
export const SMALL_FILE = 8 * 1024 ** 2;
export const HEAD_BYTES = 64 * 1024;
export const TAIL_BYTES = 256 * 1024;
export const PREVIEW_CHARS = 120;

/** Newest major.minor the importers were tested with; a newer file imports as history first (docs/import.md). */
const TESTED: Readonly<Record<ImportRootPath["agentCli"], readonly [number, number]>> = {
  claude: [2, 1],
  codex: [0, 166],
  grok: [1, 0],
};

export function formatOf(agentCli: ImportRootPath["agentCli"], version: string): "supported" | "newer" | "unknown" {
  const match = /(\d+)\.(\d+)/.exec(version);

  if (!match) return "unknown";
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [testedMajor, testedMinor] = TESTED[agentCli];

  return major > testedMajor || (major === testedMajor && minor > testedMinor) ? "newer" : "supported";
}

/** A timestamp as milliseconds: ISO strings, seconds or milliseconds since the epoch. */
export function timeMs(value: JsonValue | undefined): number | undefined {
  if (isString(value)) {
    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? undefined : parsed;
  }

  if (isNumber(value)) return value < 1e11 ? value * 1000 : value;

  return undefined;
}

export function timestamp(ms: number | undefined) {
  return ms === undefined ? undefined : timestampFromMs(ms);
}

export interface Preview {
  readonly text: string;
  /** Secrets masked in the record it came from. */
  readonly found: number;
}

/**
 * Text taken from a source record (a prompt, a title) only after the whole record is masked, then put on one line
 * and cut to the preview length: nothing is trimmed, joined or cut before masking.
 */
export function previewOf(
  masker: Masker,
  record: JsonObject | undefined,
  take: (record: JsonObject) => string | undefined,
): Preview {
  let found = 0;
  const masked = maskedRecord(record, masker, () => (found += 1));
  const line = (masked ? (take(masked) ?? "") : "").replace(/\s+/g, " ").trim();

  return { text: line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : line, found };
}

export interface SummaryFacts {
  readonly nativeId: string;
  readonly path: string;
  readonly snapshot: Snapshot;
  readonly bytes: number;
  readonly cwd: string;
  readonly title: string;
  readonly preview: string;
  readonly startedMs?: number | undefined;
  readonly updatedMs?: number;
  readonly turns: number;
  readonly origin: string;
  readonly cliVersion: string;
  readonly empty: boolean;
  readonly parentNativeId?: string;
  readonly subagent?: boolean;
  readonly flagged: number;
  readonly gitBranch?: string;
  readonly archived?: boolean;
  /** Overrides the version check (Grok records a history format, not the CLI version). */
  readonly format?: "supported" | "newer" | "unknown";
}

export function summary(root: ImportRootPath, context: ScanContext, facts: SummaryFacts): SummaryInit {
  return {
    sourceKey: signSourceKey(context.key, root, facts.path),
    agentCli: root.agentCli,
    nativeId: facts.nativeId,
    rootId: root.id,
    cwd: facts.cwd,
    cwdExists: facts.cwd !== "" && context.exists(facts.cwd),
    title: facts.title,
    preview: facts.title ? "" : facts.preview,
    startedAt: timestamp(facts.startedMs),
    updatedAt: timestamp(facts.updatedMs),
    bytes: BigInt(facts.bytes),
    turns: facts.turns,
    origin: facts.origin,
    cliVersion: facts.cliVersion,
    format: facts.empty ? "empty" : (facts.format ?? formatOf(root.agentCli, facts.cliVersion)),
    parentNativeId: facts.parentNativeId ?? "",
    subagent: facts.subagent ?? false,
    flaggedSecrets: facts.flagged,
    gitBranch: facts.gitBranch ?? "",
    snapshot: facts.snapshot,
    archived: facts.archived ?? false,
  };
}
