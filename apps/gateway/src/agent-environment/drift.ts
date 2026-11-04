import { clone, create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { AgentEnvironmentDesiredSchema, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { checkDocument, compose } from "./composition.ts";
import { audit, documents, saveDocument, workers } from "./database.ts";
import { checked } from "./mutations.ts";

/** Import is a machine-only replacement. The source block never becomes an all-workers instruction. */
export function resolveDrift(
  sql: SqlClient.SqlClient,
  owner: string,
  next: bigint,
  request: ui.ResolveEnvironmentDriftRequest,
) {
  return Effect.gen(function* () {
    const machines = yield* workers(sql, owner);
    const machine = machines.find((w) => w.workerId === request.workerId);

    if (!machine) return yield* Effect.fail(new ConnectError("Worker not found.", Code.NotFound));
    const file = machine.report?.files.find((f) => f.targetId === request.targetId);

    if (!file || !["drift", "kept"].includes(file.status) || file.observedChecksum !== request.observedChecksum)
      return yield* Effect.fail(
        new ConnectError("The file changed. Refresh its diff before choosing a version.", Code.FailedPrecondition),
      );

    if (!["keep", "overwrite", "import"].includes(request.action))
      return yield* Effect.fail(new ConnectError("Choose keep, overwrite or import.", Code.InvalidArgument));
    let library = yield* documents(sql, owner);

    if (request.action === "import") {
      if (!file.importable)
        return yield* Effect.fail(
          new ConnectError("Only a complete managed block can be imported.", Code.FailedPrecondition),
        );

      if (library.length >= 100)
        return yield* Effect.fail(
          new ConnectError("The library is full. Remove a document before importing.", Code.FailedPrecondition),
        );
      const updated: ui.InstructionDocument[] = [];

      for (const existing of library) {
        const doc = clone(ui.InstructionDocumentSchema, existing);

        if (doc.harness === file.harness) {
          doc.overrides = doc.overrides.filter((o) => o.workerId !== machine.workerId);
          doc.overrides.push(
            create(ui.InstructionMachineOverrideSchema, { workerId: machine.workerId, disabled: true }),
          );
          doc.revision = next;
          yield* saveDocument(sql, owner, doc);
        }

        updated.push(doc);
      }

      const imported = create(ui.InstructionDocumentSchema, {
        id: Bun.randomUUIDv7(),
        name: `Imported from ${machine.name}`.slice(0, 120),
        harness: file.harness,
        revision: next,
        selector: { workerIds: [machine.workerId] },
        deviceHome: true,
        platformHome: true,
        fragments: [{ id: Bun.randomUUIDv7(), name: "Local instructions", content: file.managedContent }],
      });

      yield* checked(() => checkDocument(imported, machines));
      yield* saveDocument(sql, owner, imported);
      library = [...updated, imported];
    }

    const instruction = yield* checked(() =>
      compose(library, machine).find(
        (i) => i.harness === file.harness && (file.scope === "device" ? i.deviceHome : i.platformHome),
      ),
    );

    const rows = yield* sql<{
      resolutions: JsonValue;
    }>`SELECT resolutions FROM worker_environments WHERE worker_id = ${machine.workerId}::uuid`;

    const pending = fromJson(AgentEnvironmentDesiredSchema, rows[0]?.resolutions ?? {});
    pending.resolutions = pending.resolutions.filter((r) => r.targetId !== file.targetId);
    pending.resolutions.push(
      create(AgentEnvironmentDesiredSchema, {
        resolutions: [
          {
            targetId: file.targetId,
            action: request.action === "keep" ? "keep" : "overwrite",
            observedChecksum: file.observedChecksum,
            desiredChecksum: instruction?.checksum ?? environmentDigest(""),
          },
        ],
      }).resolutions[0]!,
    );
    const json = JSON.stringify(toJson(AgentEnvironmentDesiredSchema, pending));
    yield* sql`UPDATE worker_environments SET resolutions = ${json}::jsonb WHERE worker_id = ${machine.workerId}::uuid`;
    yield* audit(sql, owner, `environment.drift.${request.action}`, machine.workerId);
  });
}
