import { Schema } from "effect";
import {
  cutoverDigest,
  cutoverRoutesSchema,
  cutoverRunId,
  decodeTargetState,
  type CutoverRequest,
} from "../../../gateway/src/migration/cutover-protocol.ts";
import { bundleSizes, migrationSsh } from "./migration-ssh.ts";
import { joinReview, type MigrationJournal } from "./migration-state.ts";

type Payload<T> = T extends CutoverRequest ? Omit<T, "version" | "runId"> : never;

const decodeJoin = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      runId: cutoverRunId,
      phase: Schema.Literals(["absent", "reviewed", "applying", "applied", "aborted"]),
      archiveSha256: Schema.optional(cutoverDigest),
      review: Schema.optional(joinReview),
      routes: Schema.optional(cutoverRoutesSchema),
    }),
  ),
);

type Device = NonNullable<MigrationJournal["device"]>;

export function desktopMigrationTarget(journal: MigrationJournal, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const decode = journal.kind === "join" ? decodeJoin : decodeTargetState;

  const receive = async (input: Payload<CutoverRequest>, body?: Parameters<typeof migrationSsh>[4]) => {
    const request = { version: 1 as const, runId: journal.runId, ...input };
    const response = decode(await migrationSsh(journal.target, request, env, signal, body));

    if (response.runId !== journal.runId) throw new Error("The destination replied for a different migration.");

    return response;
  };

  return {
    status: () => receive({ action: journal.kind === "join" ? "join-status" : "status" }),
    abort: () => receive({ action: journal.kind === "join" ? "join-abort" : "abort" }),
    prepare: (capacity: { postgresMajor: number; databaseBytes: number }) =>
      receive({ action: "prepare", ...capacity }),
    async upload(action: "trial" | "import" | "join-prepare", key: string, path: string) {
      const sizes = await bundleSizes(path);

      return action === "join-prepare"
        ? receive({ action, ...sizes }, { bundle: path })
        : receive({ action, key, ...sizes }, { bundle: path });
    },
    activate: (archiveSha256: string, desktopDevice: Device) =>
      receive({ action: "activate", archiveSha256, desktopDevice }),
    review: (archiveSha256: string, desktopDevice: Device) =>
      receive({ action: "join-review", archiveSha256, desktopDevice }),
    async join(
      archiveSha256: string,
      desktopDevice: Device,
      approval: NonNullable<MigrationJournal["approval"]>,
      secrets: readonly { id: string; value: string }[],
    ) {
      const body = Buffer.from(JSON.stringify(secrets), "utf8");

      try {
        return await receive(
          { action: "join-import", archiveSha256, approval, desktopDevice, secretBytes: body.length },
          { secrets: body },
        );
      } finally {
        body.fill(0);
      }
    },
  };
}
