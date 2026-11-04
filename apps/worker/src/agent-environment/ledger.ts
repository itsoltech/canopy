import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Schema } from "effect";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { readInstructionFile, replaceInstructionFile } from "./files.ts";

const Entry = Schema.Struct({
  targetId: Schema.String,
  path: Schema.String,
  harness: Schema.Literals(["claude", "codex"]),
  scope: Schema.Literals(["device", "platform"]),
  checksum: Schema.String,
  keptDesired: Schema.optionalKey(Schema.String),
  keptObserved: Schema.optionalKey(Schema.String),
});

const Ledger = Schema.Struct({ files: Schema.Array(Entry) });

export type ManagedInstruction = typeof Entry.Type;

/** Ownership survives worker restarts. An unreadable ledger fails closed, rather than adopting existing files. */
export class InstructionLedger {
  readonly path: string;
  readonly entries = new Map<string, ManagedInstruction>();
  problem = "";

  constructor(dataDir: string) {
    this.path = join(dataDir, "agent-environment", "state.json");

    try {
      if (!existsSync(this.path)) return;
      const ledger = Schema.decodeUnknownSync(Ledger)(JSON.parse(readInstructionFile(this.path).text ?? "{}"));

      for (const entry of ledger.files) {
        if (!isAbsolute(entry.path) || entry.targetId !== environmentDigest(entry.path))
          throw new Error("Invalid instruction ledger.");
        this.entries.set(entry.targetId, entry);
      }
    } catch {
      this.problem =
        "The instruction ownership journal is unreadable. Restore it before syncing; existing files were preserved.";
    }
  }

  commit(id: string, entry: ManagedInstruction | undefined): void {
    if (JSON.stringify(this.entries.get(id)) === JSON.stringify(entry)) return;
    const next = new Map(this.entries);

    if (entry) next.set(id, entry);
    else next.delete(id);
    replaceInstructionFile(this.path, readInstructionFile(this.path), JSON.stringify({ files: [...next.values()] }));
    this.entries.clear();

    for (const [key, value] of next) this.entries.set(key, value);
  }
}
