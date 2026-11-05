import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { globalIds } from "../config-sync/worker-records.ts";
import type { AgentEnvironment } from "./service.ts";

/** Read only the selected worker's state, with global library keys and content hashes for pins. */
export async function workerEnvironment(environment: AgentEnvironment, workerId: string) {
  const snapshot = await environment.snapshot();
  const worker = snapshot.workers.find((w) => w.workerId === workerId);

  if (!worker) throw new ConnectError("Worker not found. Choose another worker.", Code.NotFound);
  const overrides: ui.WorkerEnvironmentOverride[] = [];
  const items: ui.WorkerEnvironmentItem[] = [];
  await environment.db.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const owner = environment.options.userId;
      const instructions = yield* globalIds(sql, owner, "instruction");

      for (const doc of snapshot.documents) {
        items.push(
          create(ui.WorkerEnvironmentItemSchema, {
            kind: "instruction",
            item: instructions.toGlobal(doc.id),
            name: doc.name,
          }),
        );
        const override = doc.overrides.find((o) => o.workerId === workerId);

        if (override)
          overrides.push(
            create(ui.WorkerEnvironmentOverrideSchema, {
              kind: "instruction",
              item: instructions.toGlobal(doc.id),
              disabled: override.disabled,
              content: override.content,
            }),
          );
      }

      for (const kind of ["skill", "plugin"] as const) {
        const ids = yield* globalIds(sql, owner, kind);

        const library =
          kind === "skill" ? snapshot.skills : snapshot.plugins.flatMap((p) => (p.assignment ? [p.assignment] : []));

        for (const item of library) {
          const versions =
            kind === "skill"
              ? yield* sql<{
                  version: bigint;
                  content_hash: string;
                }>`SELECT version,content_hash FROM agent_skill_versions WHERE owner_user_id=${owner}::uuid AND skill_id=${item.id}::uuid ORDER BY version`
              : [];

          items.push(
            create(ui.WorkerEnvironmentItemSchema, {
              kind,
              item: ids.toGlobal(item.id),
              name: item.name,
              versions: versions.map((v) => ({ version: BigInt(v.version), hash: v.content_hash })),
            }),
          );
          const override = item.overrides.find((o) => o.workerId === workerId);

          if (!override) continue;

          const version =
            kind === "skill" && override.version
              ? yield* sql<{
                  content_hash: string;
                }>`SELECT content_hash FROM agent_skill_versions WHERE owner_user_id=${owner}::uuid AND skill_id=${item.id}::uuid AND version=${override.version}`
              : [];

          overrides.push(
            create(ui.WorkerEnvironmentOverrideSchema, {
              kind,
              item: ids.toGlobal(item.id),
              disabled: override.disabled,
              versionHash: version[0]?.content_hash ?? "",
            }),
          );
        }
      }
    }),
  );

  return create(ui.WorkerEnvironmentResponseSchema, { worker, overrides, revision: snapshot.revision, items });
}

/** One worker's override, never a write to the shared library definition from a linked call. */
export async function setWorkerEnvironmentOverride(
  environment: AgentEnvironment,
  request: ui.SetWorkerEnvironmentOverrideRequest,
) {
  const change = request.override;

  if (!change || !["instruction", "skill", "plugin"].includes(change.kind))
    throw new ConnectError("Choose an instruction, skill or plugin.", Code.InvalidArgument);
  const snapshot = await environment.snapshot();

  if (!snapshot.workers.some((w) => w.workerId === request.workerId))
    throw new ConnectError("Worker not found. Choose another worker.", Code.NotFound);

  const id = await environment.db.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return (yield* globalIds(sql, environment.options.userId, change.kind)).toLocal(change.item);
    }),
  );

  if (change.kind === "instruction") {
    const document = snapshot.documents.find((d) => d.id === id);

    if (!document) throw new ConnectError("Document not found. Refresh the library.", Code.NotFound);
    document.overrides = document.overrides.filter((o) => o.workerId !== request.workerId);

    if (!request.remove)
      document.overrides.push(
        create(ui.InstructionMachineOverrideSchema, {
          workerId: request.workerId,
          disabled: change.disabled,
          content: change.content,
        }),
      );
    await environment.save(
      create(ui.SaveInstructionDocumentRequestSchema, { document, expectedRevision: request.expectedRevision }),
    );
  } else {
    const plugin = snapshot.plugins.find((p) => p.assignment?.id === id);
    const skill = change.kind === "skill" ? snapshot.skills.find((s) => s.id === id) : plugin?.assignment;

    if (!skill) throw new ConnectError("Item not found. Refresh the library.", Code.NotFound);
    let version = 0n;

    if (change.versionHash) {
      if (change.kind === "plugin")
        throw new ConnectError("Choose the library version for plugins.", Code.InvalidArgument);

      const rows = await environment.db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql<{
            version: bigint;
          }>`SELECT version FROM agent_skill_versions WHERE owner_user_id=${environment.options.userId}::uuid AND skill_id=${id}::uuid AND content_hash=${change.versionHash}`;
        }),
      );

      if (!rows[0])
        throw new ConnectError(
          "This version has not arrived. Wait for sharing to finish, then retry.",
          Code.FailedPrecondition,
        );
      version = BigInt(rows[0].version);
    }

    skill.overrides = skill.overrides.filter((o) => o.workerId !== request.workerId);

    if (!request.remove)
      skill.overrides.push(
        create(ui.SkillMachineOverrideSchema, { workerId: request.workerId, disabled: change.disabled, version }),
      );

    if (change.kind === "skill")
      await environment.skills.save(
        create(ui.SaveLibrarySkillRequestSchema, { skill, expectedRevision: request.expectedRevision }),
      );
    else if (plugin)
      await environment.plugins.save(
        create(ui.SaveLibraryPluginRequestSchema, {
          marketplaceId: plugin.marketplaceId,
          pluginName: skill.artifact?.name ?? "",
          assignment: skill,
          confirmedChecksum: skill.artifact?.checksum ?? "",
          expectedRevision: request.expectedRevision,
        }),
      );
  }

  return workerEnvironment(environment, request.workerId);
}
