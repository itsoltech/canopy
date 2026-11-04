import { clone, create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { AgentEnvironmentDesiredSchema, EnvironmentSkillSchema, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SKILL_TOTAL_BYTES } from "@canopy/domain/skill-artifact";
import { pluginHarnesses } from "@canopy/domain/plugin-components";
import { audit, workers } from "./database.ts";
import { checkSkillAssignment, skillApplies } from "./skill-assignment.ts";
import { checked } from "./mutations.ts";
import { addPluginVersion, marketplaces, plugins, pluginVersion, savePlugin } from "./plugin-database.ts";
import { installReference } from "./marketplace-discovery.ts";
import type { AgentEnvironment } from "./service.ts";

export function desiredPlugins(library: readonly ui.LibraryPlugin[], worker: ui.EnvironmentWorker) {
  const result = [];
  let total = 0;

  for (const plugin of library) {
    const item = plugin.assignment;

    if (!item?.artifact || !skillApplies(item, worker)) continue;
    total += item.artifact.files.reduce((sum, f) => sum + f.content.length, 0);

    if (total > SKILL_TOTAL_BYTES) throw new ConnectError("Assigned plugins exceed 25 MiB.", Code.InvalidArgument);
    result.push(
      create(EnvironmentSkillSchema, {
        id: item.id,
        version: item.version,
        artifact: item.artifact,
        harnesses: item.harnesses,
        deviceHome: item.deviceHome,
        platformHome: item.platformHome,
      }),
    );
  }

  return result;
}

export class EnvironmentPlugins {
  constructor(readonly environment: AgentEnvironment) {}

  async save(request: ui.SaveLibraryPluginRequest) {
    if (!request.assignment) throw new ConnectError("Choose a plugin assignment.", Code.InvalidArgument);
    const input = request.assignment;
    const reference = installReference(request.pluginName);
    const owner = this.environment.options.userId;
    await this.environment.db.mutate(request.expectedRevision, (sql) =>
      Effect.gen(function* () {
        const library = yield* plugins(sql, owner);
        const previous = library.find((p) => p.assignment?.id === input.id);

        if (input.id && !previous) return yield* Effect.fail(new ConnectError("Plugin not found.", Code.NotFound));

        if (!previous && library.length >= 100)
          return yield* Effect.fail(new ConnectError("Use at most 100 plugins.", Code.InvalidArgument));
        const market = (yield* marketplaces(sql, owner)).find((m) => m.id === request.marketplaceId);

        if (!market || (reference.marketplace && reference.marketplace !== market.name))
          return yield* Effect.fail(new ConnectError("Marketplace not found.", Code.NotFound));
        const candidate = market.plugins.find((p) => p.artifact?.name === reference.name);

        if ((!previous || request.useLatest) && (!candidate?.artifact || candidate.unavailableReason))
          return yield* Effect.fail(
            new ConnectError("Plugin is unavailable in this marketplace.", Code.InvalidArgument),
          );

        if (
          previous &&
          (previous.marketplaceId !== market.id || previous.assignment?.artifact?.name !== reference.name)
        )
          return yield* Effect.fail(new ConnectError("Plugin identity cannot change.", Code.InvalidArgument));

        const saved = create(ui.LibraryPluginSchema, {
          marketplaceId: market.id,
          marketplaceName: market.name,
          commit: market.source?.commit ?? "",
          assignment: clone(ui.LibrarySkillSchema, input),
        });

        const assignment = saved.assignment!;
        assignment.id = previous?.assignment?.id ?? Bun.randomUUIDv7();
        assignment.versions = previous?.assignment?.versions ?? [];
        assignment.source = undefined;

        if (!previous || request.useLatest) {
          assignment.artifact = candidate!.artifact;
          assignment.version = (assignment.versions.at(-1) ?? 0n) + 1n;
          assignment.versions = [...assignment.versions, assignment.version];
        } else {
          const version = yield* pluginVersion(sql, owner, assignment.id, input.version);
          assignment.artifact = version.assignment!.artifact;
          saved.commit = version.commit;
        }

        if (request.confirmedChecksum !== assignment.artifact?.checksum)
          return yield* Effect.fail(
            new ConnectError(
              "Review every plugin file and explicitly confirm this version's checksum before enabling it.",
              Code.FailedPrecondition,
            ),
          );

        if (
          assignment.harnesses.some((h) => !pluginHarnesses(assignment.artifact!.files).includes(h)) ||
          assignment.overrides.some((o) => o.version !== 0n)
        )
          return yield* Effect.fail(
            new ConnectError(
              "Choose compatible harnesses. Per-computer version pins are not supported for plugins.",
              Code.InvalidArgument,
            ),
          );
        const machines = yield* workers(sql, owner);
        yield* checked(() => checkSkillAssignment(assignment, machines));
        const updated = [...library.filter((p) => p.assignment?.id !== assignment.id), saved];

        for (const machine of machines) yield* checked(() => desiredPlugins(updated, machine));

        if (!previous || request.useLatest) yield* addPluginVersion(sql, owner, saved);
        yield* savePlugin(sql, owner, saved);

        // Consent and assignment commit together. Audit contains only immutable identity, digest and revision.
        const details = JSON.stringify({
          checksum: assignment.artifact!.checksum,
          commit: saved.commit,
          version: assignment.version.toString(),
        });

        yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details)
        VALUES (${Bun.randomUUIDv7()}::uuid, ${owner}::uuid, 'environment.plugin.confirm', 'agent_environment', ${assignment.id}::uuid, ${details}::jsonb)`;
      }),
    );

    return this.environment.changed();
  }

  async remove(request: ui.DeleteLibraryPluginRequest) {
    const owner = this.environment.options.userId;
    await this.environment.db.mutate(request.expectedRevision, (sql) =>
      Effect.gen(function* () {
        if (!(yield* plugins(sql, owner)).some((p) => p.assignment?.id === request.id))
          return yield* Effect.fail(new ConnectError("Plugin not found.", Code.NotFound));
        yield* sql`DELETE FROM agent_plugins WHERE id = ${request.id}::uuid AND owner_user_id = ${owner}::uuid`;
        yield* audit(sql, owner, "environment.plugin.delete", request.id);
      }),
    );

    return this.environment.changed();
  }

  async resolve(request: ui.ResolveSkillDriftRequest) {
    const owner = this.environment.options.userId;
    await this.environment.db.mutate(request.expectedRevision, (sql) =>
      Effect.gen(function* () {
        const machine = (yield* workers(sql, owner)).find((w) => w.workerId === request.workerId);

        if (!machine) return yield* Effect.fail(new ConnectError("Worker not found.", Code.NotFound));
        const file = machine.report?.plugins.find((p) => p.targetId === request.targetId);

        if (!file || !["drift", "kept"].includes(file.status) || file.observedChecksum !== request.observedChecksum)
          return yield* Effect.fail(
            new ConnectError("Plugin changed. Refresh before resolving.", Code.FailedPrecondition),
          );

        if (!["keep", "overwrite"].includes(request.action) || (request.action === "overwrite" && !file.owned))
          return yield* Effect.fail(
            new ConnectError("Choose keep or overwrite for Canopy-owned files.", Code.InvalidArgument),
          );

        const rows = yield* sql<{
          resolutions: JsonValue;
        }>`SELECT resolutions FROM worker_environments WHERE worker_id = ${machine.workerId}::uuid`;

        const pending = fromJson(AgentEnvironmentDesiredSchema, rows[0]?.resolutions ?? {});
        pending.pluginResolutions = [
          ...pending.pluginResolutions.filter((r) => r.targetId !== file.targetId),
          create(AgentEnvironmentDesiredSchema, {
            pluginResolutions: [
              {
                targetId: file.targetId,
                action: request.action,
                observedChecksum: file.observedChecksum,
                desiredChecksum: file.desiredChecksum,
              },
            ],
          }).pluginResolutions[0]!,
        ];
        const json = JSON.stringify(toJson(AgentEnvironmentDesiredSchema, pending));
        yield* sql`UPDATE worker_environments SET resolutions = ${json}::jsonb WHERE worker_id = ${machine.workerId}::uuid`;
        yield* audit(sql, owner, `environment.plugin.${request.action}`, machine.workerId);
      }),
    );

    return this.environment.changed();
  }
}
