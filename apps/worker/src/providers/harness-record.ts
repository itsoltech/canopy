import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ItemSchema, TurnEndSource, TurnOutcome, UsageSchema } from "@canopy/contracts";

/**
 * What a harness wrote down about one turn in its own transcript (docs/durability.md, "Rekoncyliacja z transkryptu
 * harnessu"): Codex in its rollout, Claude Code in the session JSONL. Read when a turn ended without the worker
 * seeing its end (worker restart, harness crash): the record says what really happened.
 */
export interface HarnessRecord {
  /** The turn's items in the order the harness wrote them; IN_PROGRESS = started but never finished. */
  readonly items: MessageInitShape<typeof ItemSchema>[];
  /** How the harness ended the turn; undefined when it never did (its process stopped mid-turn). */
  readonly end?: TurnEnd;
}

export interface TurnEnd {
  readonly outcome: TurnOutcome;
  readonly source: TurnEndSource;
  readonly reason: string;
  readonly errorCode?: string;
  readonly providerTurnRef?: string;
  readonly usage?: MessageInitShape<typeof UsageSchema>;
}

/** Complete lines of a JSONL file from a byte offset (a partly written last line is left out). */
export async function readJsonl(path: string, offset: number): Promise<unknown[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.slice(Math.max(0, offset)).text();
  const lines = text.split("\n");
  lines.pop(); // empty after the last newline, or a line still being written
  return lines.flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}
