import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Schema } from "effect";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { readInstructionFile, replaceInstructionFile } from "./files.ts";

const ManifestFile = Schema.Struct({ path: Schema.String, checksum: Schema.String, executable: Schema.Boolean });

const Entry = Schema.Struct({
  targetId: Schema.String,
  skillId: Schema.String,
  path: Schema.String,
  harness: Schema.String,
  scope: Schema.String,
  owned: Schema.Boolean,
  checksum: Schema.String,
  files: Schema.Array(ManifestFile),
  keptDesired: Schema.optionalKey(Schema.String),
  keptObserved: Schema.optionalKey(Schema.String),
});

const Ledger = Schema.Struct({ entries: Schema.Array(Entry) });
const LEDGER_BYTES = 128 * 1024 * 1024;

export type ManagedSkill = typeof Entry.Type;

/** Content stays out of the ownership manifest; only exact installed paths may be removed. */
export class SkillLedger {
  readonly entries = new Map<string, ManagedSkill>();
  readonly path: string;
  problem = "";
  constructor(dataDir: string, filename = "skills.json") {
    this.path = join(dataDir, "agent-environment", filename);

    try {
      if (!existsSync(this.path)) return;

      const saved = Schema.decodeUnknownSync(Ledger)(
        JSON.parse(readInstructionFile(this.path, LEDGER_BYTES).text ?? "{}"),
      );

      for (const entry of saved.entries) {
        if (!isAbsolute(entry.path) || entry.targetId !== environmentDigest(`skill:${entry.path}`))
          throw new Error("Invalid skill manifest.");
        this.entries.set(entry.targetId, entry);
      }
    } catch {
      this.problem =
        "The skill ownership manifest is unreadable. Restore it before syncing; local skills were preserved.";
    }
  }
  commit(id: string, entry: ManagedSkill | undefined): void {
    if (JSON.stringify(this.entries.get(id)) === JSON.stringify(entry)) return;
    const next = new Map(this.entries);

    if (entry) next.set(id, entry);
    else next.delete(id);
    replaceInstructionFile(
      this.path,
      readInstructionFile(this.path, LEDGER_BYTES),
      JSON.stringify({ entries: [...next.values()] }),
      LEDGER_BYTES,
    );
    this.entries.clear();

    for (const [key, value] of next) this.entries.set(key, value);
  }
}
