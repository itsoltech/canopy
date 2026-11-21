import { join } from "node:path";
import { Schema } from "effect";
import { CutoverError, readCutoverFile, requirePrivateDirectory, writeCutoverFile } from "./cutover-files.ts";
import { cutoverDigest, cutoverRunId } from "./cutover-protocol.ts";

const identifier = Schema.String.check(Schema.isUUID());
const counts = Schema.Record(Schema.String, Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

const reviewContext = {
  operationId: cutoverRunId,
  sourceNodeId: cutoverDigest,
  sourceOwnerUserId: identifier,
  targetOwnerUserId: identifier,
  archiveSha256: cutoverDigest,
  reviewDigest: cutoverDigest,
  counts,
};

export const consolidationReviewSchema = Schema.Struct({
  ...reviewContext,
  conflicts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      table: Schema.String,
      sourceKey: Schema.String,
      targetKey: Schema.String,
    }),
  ),
  secrets: Schema.Array(Schema.Struct({ id: Schema.String, table: Schema.String, sourceKey: Schema.String })),
  blockers: Schema.Array(Schema.Struct({ table: Schema.String, key: Schema.String, reason: Schema.String })),
});

const receipt = Schema.Struct({ ...reviewContext, alreadyApplied: Schema.Boolean });

const candidate = Schema.Struct({
  directoryId: cutoverRunId,
});

const stateSchema = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("reviewed"), review: consolidationReviewSchema, candidate }),
  Schema.Struct({ phase: Schema.Literal("applying"), review: consolidationReviewSchema, candidate }),
  Schema.Struct({ phase: Schema.Literal("applied"), receipt }),
  Schema.Struct({ phase: Schema.Literal("aborted") }),
]);

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(stateSchema), { onExcessProperty: "error" });

export type JoinState = typeof stateSchema.Type;

export type JoinCandidate = typeof candidate.Type;

export async function joinStateDirectory(root: string, runId: string) {
  const directory = join(root, "join-" + runId);
  await requirePrivateDirectory(directory, true);

  return directory;
}

export function joinArchive(directory: string, source: JoinCandidate) {
  return join(directory, "bundle-" + source.directoryId);
}

export function readJoinState(directory: string) {
  return readCutoverFile(join(directory, "join.json"), decodeState);
}

export async function writeJoinState(directory: string, state: JoinState) {
  const text = JSON.stringify(state);

  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new CutoverError("This consolidation review is too large to continue.");

  await writeCutoverFile(join(directory, "join.json"), text + "\n");
}

export function summarizeJoin(runId: string, state: JoinState | undefined) {
  switch (state?.phase) {
    case "reviewed":
    case "applying":
      return { version: 1, runId, phase: state.phase, review: state.review, archiveSha256: state.review.archiveSha256 };
    case "applied":
      return {
        version: 1,
        runId,
        phase: state.phase,
        receipt: state.receipt,
        archiveSha256: state.receipt.archiveSha256,
      };
    case "aborted":
      return { version: 1, runId, phase: "aborted" };
    default:
      return { version: 1, runId, phase: "absent" };
  }
}
