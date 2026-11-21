import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import {
  cutoverDigest,
  cutoverRoutesSchema,
  desktopDeviceSchema,
} from "../../../gateway/src/migration/cutover-protocol.ts";
import { syncDirectory, writePrivateFile } from "./private-file.ts";

const digest = cutoverDigest;
const positiveNumber = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const migrationKind = Schema.Literals(["move", "join"]);

export const targetHost = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:]+\])$/),
);

export const joinReview = Schema.Struct({
  operationId: Schema.String,
  sourceNodeId: Schema.String,
  sourceOwnerUserId: Schema.String,
  targetOwnerUserId: Schema.String,
  archiveSha256: digest,
  reviewDigest: digest,
  counts: Schema.Record(Schema.String, positiveNumber),
  conflicts: Schema.Array(
    Schema.Struct({ id: Schema.String, table: Schema.String, sourceKey: Schema.String, targetKey: Schema.String }),
  ),
  secrets: Schema.Array(Schema.Struct({ id: Schema.String, table: Schema.String, sourceKey: Schema.String })),
  blockers: Schema.Array(Schema.Struct({ table: Schema.String, key: Schema.String, reason: Schema.String })),
});

export const joinApproval = Schema.Struct({
  reviewDigest: digest,
  conflictChoices: Schema.Record(Schema.String, Schema.Literals(["source", "target"])),
  approvedSecretIds: Schema.Array(Schema.String),
});

const journalSchema = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String.check(Schema.isUUID()),
  kind: migrationKind,
  target: targetHost,
  phase: Schema.Literals([
    "preparing",
    "prepared",
    "draining",
    "fenced",
    "committed",
    "reviewing",
    "switching",
    "completed",
  ]),
  preparation: Schema.optionalKey(
    Schema.Struct({
      durationMs: positiveNumber,
      databaseBytes: Schema.optionalKey(positiveNumber),
      timings: Schema.optionalKey(
        Schema.Struct({
          exportMs: positiveNumber,
          transferMs: Schema.optionalKey(positiveNumber),
          restoreMs: Schema.optionalKey(positiveNumber),
          verifyMs: Schema.optionalKey(positiveNumber),
        }),
      ),
      routes: Schema.optionalKey(Schema.Array(Schema.String)),
      peers: Schema.optionalKey(
        Schema.Array(Schema.Struct({ nodeId: Schema.String, name: Schema.String, online: Schema.Boolean })),
      ),
      selectedPeerIds: Schema.optionalKey(Schema.Array(digest)),
      review: Schema.optionalKey(joinReview),
    }),
  ),
  archiveSha256: Schema.optionalKey(digest),
  approval: Schema.optionalKey(joinApproval),
  device: Schema.optionalKey(desktopDeviceSchema),
  routes: Schema.optionalKey(cutoverRoutesSchema),
  profile: Schema.optionalKey(Schema.String),
  workerId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
});

export type MigrationJournal = typeof journalSchema.Type;

export class MigrationJournalFile {
  private readonly path: string;
  constructor(private readonly directory: string) {
    this.path = join(directory, "gateway-migration.json");
  }
  read(): MigrationJournal | undefined {
    const file = lstatSync(this.path, { throwIfNoEntry: false });

    if (!file) return undefined;

    try {
      if (!file.isFile()) throw new Error();

      return Schema.decodeUnknownSync(Schema.fromJsonString(journalSchema))(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error(
        "Could not read the gateway migration record. Keep the source offline until you recover the record.",
      );
    }
  }
  save(journal: MigrationJournal): MigrationJournal {
    writePrivateFile(this.path, JSON.stringify(journal) + "\n");

    return journal;
  }
  clear() {
    rmSync(this.path, { force: true });
    syncDirectory(this.directory);
  }
}

export function sourceFenced(journal: MigrationJournal | undefined) {
  return journal !== undefined && journal.phase !== "preparing" && journal.phase !== "prepared";
}
