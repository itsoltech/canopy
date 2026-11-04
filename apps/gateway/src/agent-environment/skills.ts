import { clone, create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { AgentEnvironmentDesiredSchema, ui } from "@canopy/contracts";
import { validateSkillFiles } from "@canopy/domain/skill-artifact";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { audit, workers } from "./database.ts";
import { checked } from "./mutations.ts";
import { checkSkillAssignment, desiredSkills } from "./skill-assignment.ts";
import { addSkillVersion, saveSkillDefinition, skills, skillVersion } from "./skill-database.ts";
import { skillZip } from "./skill-zip.ts";
import type { AgentEnvironment } from "./service.ts";

export class EnvironmentSkills {
  constructor(readonly environment: AgentEnvironment) {}

  async save(request: ui.SaveLibrarySkillRequest) {
    if (!request.skill) throw new ConnectError("Add a skill.", Code.InvalidArgument);
    const input = request.skill;

    if (request.zip.length && request.files.length)
      throw new ConnectError("Choose a folder or ZIP, not both.", Code.InvalidArgument);
    let artifact;

    try {
      if (request.zip.length || request.files.length)
        artifact = validateSkillFiles(request.zip.length ? skillZip(request.zip) : request.files);
    } catch (error) {
      throw new ConnectError(error instanceof Error ? error.message : "Invalid skill upload.", Code.InvalidArgument);
    }

    const uploaded = artifact;
    const owner = this.environment.options.userId;
    await this.environment.db.mutate(request.expectedRevision, (sql) =>
      Effect.gen(function* () {
        const library = yield* skills(sql, owner);
        const previous = library.find((s) => s.id === input.id);

        if (input.id && !previous) return yield* Effect.fail(new ConnectError("Skill not found.", Code.NotFound));

        if (!previous && library.length >= 100)
          return yield* Effect.fail(new ConnectError("Use at most 100 skills.", Code.InvalidArgument));
        const saved = clone(ui.LibrarySkillSchema, input);
        saved.source = previous?.source
          ? create(ui.SkillSourceSchema, {
              ...previous.source,
              autoUpdate: input.source?.autoUpdate ?? false,
              pinned: input.version !== previous.version || (input.source?.pinned ?? false),
            })
          : undefined;
        saved.id ||= Bun.randomUUIDv7();
        saved.versions = previous?.versions ?? [];

        if (uploaded) {
          saved.source = undefined;
          saved.version = (saved.versions.at(-1) ?? 0n) + 1n;
          saved.versions = [...saved.versions, saved.version];
          saved.artifact = uploaded;
          yield* addSkillVersion(sql, owner, saved.id, saved.version, uploaded);
        } else {
          if (!previous)
            return yield* Effect.fail(new ConnectError("Upload a folder or ZIP with SKILL.md.", Code.InvalidArgument));
          saved.artifact = yield* skillVersion(sql, owner, saved.id, saved.version);
        }

        const machines = yield* workers(sql, owner);
        yield* checked(() => checkSkillAssignment(saved, machines));
        const updated = [...library.filter((s) => s.id !== saved.id), saved];

        for (const machine of machines) yield* desiredSkills(sql, owner, updated, machine);
        yield* saveSkillDefinition(sql, owner, saved);
        yield* audit(sql, owner, uploaded ? "environment.skill.upload" : "environment.skill.assign", saved.id);
      }),
    );

    return this.environment.changed();
  }

  async remove(request: ui.DeleteLibrarySkillRequest) {
    const owner = this.environment.options.userId;
    await this.environment.db.mutate(request.expectedRevision, (sql) =>
      Effect.gen(function* () {
        const library = yield* skills(sql, owner);

        if (!library.some((s) => s.id === request.id))
          return yield* Effect.fail(new ConnectError("Skill not found.", Code.NotFound));
        yield* sql`DELETE FROM agent_skills WHERE id = ${request.id}::uuid AND owner_user_id = ${owner}::uuid`;
        yield* audit(sql, owner, "environment.skill.delete", request.id);
      }),
    );

    return this.environment.changed();
  }

  async resolve(request: ui.ResolveSkillDriftRequest) {
    const owner = this.environment.options.userId;
    await this.environment.db.mutate(request.expectedRevision, (sql) =>
      Effect.gen(function* () {
        const machines = yield* workers(sql, owner);
        const machine = machines.find((w) => w.workerId === request.workerId);

        if (!machine) return yield* Effect.fail(new ConnectError("Worker not found.", Code.NotFound));
        const file = machine.report?.skills.find((s) => s.targetId === request.targetId);

        if (!file || !["drift", "kept"].includes(file.status) || file.observedChecksum !== request.observedChecksum)
          return yield* Effect.fail(
            new ConnectError("The skill changed. Refresh before resolving.", Code.FailedPrecondition),
          );

        if (!["keep", "overwrite", "import"].includes(request.action))
          return yield* Effect.fail(new ConnectError("Choose keep, overwrite or import.", Code.InvalidArgument));
        const library = yield* skills(sql, owner);
        const skill = library.find((s) => s.id === file.skillId);

        const effective = (yield* desiredSkills(sql, owner, library, machine)).find((s) => s.id === file.skillId);
        let expected = effective?.artifact?.checksum ?? "";

        if (request.action === "import") {
          if (!file.importable || !skill)
            return yield* Effect.fail(
              new ConnectError("Only valid, owned skill files can be imported.", Code.FailedPrecondition),
            );
          const artifact = yield* checked(() => validateSkillFiles(file.managedFiles));

          if (artifact.name !== effective?.artifact?.name)
            return yield* Effect.fail(
              new ConnectError("Keep the original skill name before importing.", Code.InvalidArgument),
            );
          const version = (skill.versions.at(-1) ?? 0n) + 1n;
          yield* addSkillVersion(sql, owner, skill.id, version, artifact);
          skill.overrides = [
            ...skill.overrides.filter((o) => o.workerId !== machine.workerId),
            create(ui.SkillMachineOverrideSchema, { workerId: machine.workerId, version }),
          ];
          yield* saveSkillDefinition(sql, owner, skill);
          expected = artifact.checksum;
        }

        if (expected !== file.desiredChecksum && request.action !== "import")
          return yield* Effect.fail(
            new ConnectError("The desired skill changed. Refresh before resolving.", Code.FailedPrecondition),
          );

        const rows = yield* sql<{
          resolutions: JsonValue;
        }>`SELECT resolutions FROM worker_environments WHERE worker_id = ${machine.workerId}::uuid`;

        const pending = fromJson(AgentEnvironmentDesiredSchema, rows[0]?.resolutions ?? {});
        pending.skillResolutions = [
          ...pending.skillResolutions.filter((r) => r.targetId !== file.targetId),
          create(AgentEnvironmentDesiredSchema, {
            skillResolutions: [
              {
                targetId: file.targetId,
                action: request.action === "keep" ? "keep" : "overwrite",
                observedChecksum: file.observedChecksum,
                desiredChecksum: expected,
              },
            ],
          }).skillResolutions[0]!,
        ];
        const json = JSON.stringify(toJson(AgentEnvironmentDesiredSchema, pending));
        yield* sql`UPDATE worker_environments SET resolutions = ${json}::jsonb WHERE worker_id = ${machine.workerId}::uuid`;
        yield* audit(sql, owner, `environment.skill.${request.action}`, file.skillId);
      }),
    );

    return this.environment.changed();
  }

  desired(library: readonly ui.LibrarySkill[], machine: ui.EnvironmentWorker) {
    const owner = this.environment.options.userId;

    return this.environment.db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* desiredSkills(sql, owner, library, machine);
      }),
    );
  }
}
