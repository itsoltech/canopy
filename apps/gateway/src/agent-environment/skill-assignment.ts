import { create } from "@bufbuild/protobuf";
import { EnvironmentSkillSchema, ui } from "@canopy/contracts";
import { SKILL_TOTAL_BYTES } from "@canopy/domain/skill-artifact";
import { Effect } from "effect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { SqlClient } from "effect/sql";
import { checkSelector, invalid, selected, uuid } from "./composition.ts";
import { skillVersions } from "./skill-database.ts";

export function checkSkillAssignment(
  skill: ui.LibrarySkill,
  machines: readonly ui.EnvironmentWorker[],
  foreign: ReadonlySet<string> = new Set(),
): void {
  if (skill.id && !uuid(skill.id)) invalid("Invalid skill ID.");

  if (!skill.name.trim() || skill.name.length > 120) invalid("Name the skill using up to 120 characters.");

  if (
    !skill.harnesses.length ||
    skill.harnesses.length > 3 ||
    skill.harnesses.some((h) => !["claude", "codex", "grok"].includes(h))
  )
    invalid("Choose Claude, Codex or Grok.");

  if (!skill.deviceHome && !skill.platformHome) invalid("Choose a platform or device destination.");

  if (!skill.selector) invalid("Choose a skill assignment.");
  checkSelector(skill.selector, new Set([...machines.map((w) => w.workerId), ...foreign]));

  if (skill.overrides.length > 200 || new Set(skill.overrides.map((o) => o.workerId)).size !== skill.overrides.length)
    invalid("Use at most one override per computer, up to 200 computers.");

  for (const override of skill.overrides) {
    checkSelector(
      create(ui.EnvironmentSelectorSchema, { workerIds: [override.workerId] }),
      new Set(machines.map((w) => w.workerId)),
    );

    if (override.version && !skill.versions.includes(override.version)) invalid("Override version not found.");
  }
}

export function skillApplies(skill: ui.LibrarySkill, worker: ui.EnvironmentWorker): boolean {
  return selected(skill.selector, worker) && !skill.overrides.find((o) => o.workerId === worker.workerId)?.disabled;
}

export function desiredSkills(
  sql: SqlClient.SqlClient,
  owner: string,
  library: readonly ui.LibrarySkill[],
  worker: ui.EnvironmentWorker,
) {
  return Effect.gen(function* () {
    const result = [];
    const destinations = new Set<string>();
    let total = 0;

    const selected = library.flatMap((skill) =>
      skillApplies(skill, worker)
        ? [
            {
              skill,
              version: skill.overrides.find((o) => o.workerId === worker.workerId)?.version || skill.version,
            },
          ]
        : [],
    );

    const historical = yield* skillVersions(
      sql,
      owner,
      selected.flatMap(({ skill, version }) =>
        version !== skill.version || !skill.artifact ? [{ id: skill.id, version }] : [],
      ),
    );

    for (const { skill, version } of selected) {
      const artifact =
        version === skill.version && skill.artifact ? skill.artifact : historical.get(`${skill.id}:${version}`);

      if (!artifact) return yield* Effect.fail(new ConnectError("Skill version not found.", Code.NotFound));

      for (const harness of skill.harnesses) {
        for (const scope of [skill.deviceHome ? "device" : "", skill.platformHome ? "platform" : ""].filter(Boolean)) {
          const key = `${harness}:${scope}:${artifact.name}`;

          if (destinations.has(key))
            return yield* Effect.fail(
              new ConnectError(
                `Two assigned skills use the same folder on ${worker.name}. Change their assignments.`,
                Code.InvalidArgument,
              ),
            );
          destinations.add(key);
        }
      }

      total += artifact.files.reduce((sum, file) => sum + file.content.length, 0);

      if (total > SKILL_TOTAL_BYTES)
        return yield* Effect.fail(
          new ConnectError(`Skills assigned to ${worker.name} exceed 25 MiB in total.`, Code.InvalidArgument),
        );
      result.push(
        create(EnvironmentSkillSchema, {
          id: skill.id,
          harnesses: skill.harnesses,
          deviceHome: skill.deviceHome,
          platformHome: skill.platformHome,
          version,
          artifact,
        }),
      );
    }

    return result;
  });
}
