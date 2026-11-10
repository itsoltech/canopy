import { createHash } from "node:crypto";
import { clone, create, fromJson, fromJsonString, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { GatewayCore } from "../core/core.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { marketplaces } from "../agent-environment/plugin-database.ts";
import { skills } from "../agent-environment/skill-database.ts";
import { libraryReceipt, type LibraryRow } from "./library-store.ts";

/**
 * Skills (and commands as skills) and marketplaces into the library (docs/import.md, "Skille i pluginy"), through
 * the library's own save paths: the same validation, limits and audit as an upload or an added marketplace. A skill
 * is assigned to the source worker only, for Canopy's own homes; Replace adds a version to the library skill of that
 * name (its assignment stays). Undo removes or rolls back only what is still as the import left it.
 */

const READ_TIMEOUT_MS = 60_000;
const HARNESSES: ReadonlySet<string> = new Set(["claude", "codex", "grok"]);

const SkillTarget = Schema.Struct({
  skillId: Schema.String,
  version: Schema.String,
  /** The whole definition as the import left it (skillFingerprint): any later edit keeps the skill. */
  fingerprint: Schema.String,
  previousVersion: Schema.optional(Schema.String),
  previous: Schema.optional(Schema.MutableJson),
});

const MarketplaceTarget = Schema.Struct({ marketplaceId: Schema.String });

export interface Applied {
  readonly target: { readonly [key: string]: JsonValue };
  readonly detail: string;
}

/**
 * A library skill's whole definition: version, harnesses, assignment (selector and per-machine overrides), homes and
 * source. Undo removes or rolls back the skill only while this is what the import left.
 */
export function skillFingerprint(skill: ui.LibrarySkill): string {
  const definition = {
    name: skill.name,
    version: String(skill.version),
    harnesses: [...skill.harnesses].sort(),
    selector: skill.selector ? toJson(ui.EnvironmentSelectorSchema, skill.selector) : null,
    overrides: skill.overrides.map((o) => toJson(ui.SkillMachineOverrideSchema, o)),
    deviceHome: skill.deviceHome,
    platformHome: skill.platformHome,
    source: skill.source ? toJson(ui.SkillSourceSchema, skill.source) : null,
  };

  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

/** The receipt of a skill change: the skill as saved, found in the transaction that saved it. */
const skillReceipt =
  (row: LibraryRow, find: (skill: ui.LibrarySkill) => boolean, applied: (skill: ui.LibrarySkill) => Applied) =>
  (sql: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      const saved = (yield* skills(sql, row.owner_user_id)).find(find);

      if (!saved) return yield* Effect.die(new Error("The skill was not saved."));
      yield* libraryReceipt(row, "done", applied(saved))(sql);
    }).pipe(Effect.orDie);

export async function applySkill(core: GatewayCore, row: LibraryRow): Promise<void> {
  const result = await coreWorkerQuery(
    core,
    row.worker_id,
    { case: "readImportLibraryItem", value: { sourceKey: row.source_key, digest: row.digest } },
    READ_TIMEOUT_MS,
  );

  const files = result.importLibraryContent?.files ?? [];

  if (files.length === 0) throw new Error("The worker did not return the skill.");
  const environment = core.environment;
  const snapshot = await environment.snapshot();
  const existing = snapshot.skills.find((s) => s.name === row.name);

  if (existing && row.action === "replace") {
    const skill = clone(ui.LibrarySkillSchema, existing);

    await environment.skills.save(
      create(ui.SaveLibrarySkillRequestSchema, { skill, files, expectedRevision: snapshot.revision }),
      skillReceipt(
        row,
        (s) => s.id === existing.id,
        (saved) => ({
          target: {
            skillId: saved.id,
            version: String(saved.version),
            fingerprint: skillFingerprint(saved),
            previousVersion: String(existing.version),
            previous: toJson(
              ui.LibrarySkillSchema,
              create(ui.LibrarySkillSchema, { ...existing, artifact: undefined, versions: [] }),
            ),
          },
          detail: `New version ${saved.version} in Agent environment`,
        }),
      ),
    );

    return;
  }

  if (existing) throw new Error(`A skill named ${row.name} is in Agent environment. Scan again.`);
  const harnesses = row.value.split(",").filter((h) => HARNESSES.has(h));

  const skill = create(ui.LibrarySkillSchema, {
    name: row.name,
    harnesses,
    selector:
      row.target["selector"] === undefined
        ? { workerIds: [row.worker_id] }
        : fromJsonString(ui.EnvironmentSelectorSchema, JSON.stringify(row.target["selector"])),
    // Canopy's own homes of the source worker: the device's CLI folders stay the user's.
    platformHome: true,
    deviceHome: false,
  });

  await environment.skills.save(
    create(ui.SaveLibrarySkillRequestSchema, { skill, files, expectedRevision: snapshot.revision }),
    skillReceipt(
      row,
      (s) => s.name === row.name,
      (saved) => ({
        target: { skillId: saved.id, version: String(saved.version), fingerprint: skillFingerprint(saved) },
        detail: "Added to Agent environment",
      }),
    ),
  );
}

export async function undoSkill(core: GatewayCore, row: LibraryRow): Promise<void> {
  const mark = (status: "undone" | "kept") => core.imports.sql((sql) => libraryReceipt(row, status)(sql));
  const target = Option.getOrUndefined(Schema.decodeUnknownOption(SkillTarget)(row.target));

  if (!target) return mark("undone");
  const environment = core.environment;
  const snapshot = await environment.snapshot();
  const skill = snapshot.skills.find((s) => s.id === target.skillId);

  if (!skill) return mark("undone");

  // Changed since (another version, its assignment, harnesses or homes): the owner's skill stays.
  if (skillFingerprint(skill) !== target.fingerprint) return mark("kept");

  if (target.previousVersion) {
    const previous =
      target.previous === undefined
        ? clone(ui.LibrarySkillSchema, skill)
        : fromJson(ui.LibrarySkillSchema, target.previous);

    previous.version = BigInt(target.previousVersion);
    await environment.skills.restore(previous, snapshot.revision, libraryReceipt(row, "undone"));
  } else
    await environment.skills.remove(
      create(ui.DeleteLibrarySkillRequestSchema, { id: skill.id, expectedRevision: snapshot.revision }),
      libraryReceipt(row, "undone"),
    );
}

/** A marketplace from its repository, as Add marketplace reads it (the source is the CLI's; no credentials). */
export async function applyMarketplace(core: GatewayCore, row: LibraryRow): Promise<void> {
  const environment = core.environment;

  const preview = await environment.marketplaces.preview(
    create(ui.PreviewMarketplaceRequestSchema, { command: row.value }),
  );

  const snapshot = await environment.snapshot();
  const known = new Set(snapshot.marketplaces.map((m) => m.id));

  await environment.marketplaces.save(
    create(ui.SaveMarketplaceRequestSchema, { previewId: preview.id, expectedRevision: snapshot.revision }),
    (sql) =>
      Effect.gen(function* () {
        const created = (yield* marketplaces(sql, row.owner_user_id)).find((m) => !known.has(m.id));

        if (!created) return yield* Effect.die(new Error("The marketplace was not saved."));
        yield* libraryReceipt(row, "done", {
          target: { marketplaceId: created.id },
          detail: `Added to Agent environment as ${created.name}`,
        })(sql);
      }).pipe(Effect.orDie),
  );
}

export async function undoMarketplace(core: GatewayCore, row: LibraryRow): Promise<void> {
  const mark = (status: "undone" | "kept") => core.imports.sql((sql) => libraryReceipt(row, status)(sql));
  const target = Option.getOrUndefined(Schema.decodeUnknownOption(MarketplaceTarget)(row.target));

  if (!target) return mark("undone");
  const environment = core.environment;
  const snapshot = await environment.snapshot();

  if (!snapshot.marketplaces.some((m) => m.id === target.marketplaceId)) return mark("undone");

  // Plugins approved from it since: the marketplace stays with them.
  if (snapshot.plugins.some((p) => p.marketplaceId === target.marketplaceId)) return mark("kept");
  await environment.marketplaces.remove(
    create(ui.DeleteMarketplaceRequestSchema, { id: target.marketplaceId, expectedRevision: snapshot.revision }),
    libraryReceipt(row, "undone"),
  );
}
