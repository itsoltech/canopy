import { clone, create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect, Predicate } from "effect";
import type { SqlClient } from "effect/sql";
import { checkDocument, uuid } from "../agent-environment/composition.ts";
import { saveDocument } from "../agent-environment/database.ts";
import { checkSkillAssignment } from "../agent-environment/skill-assignment.ts";
import { saveSkillDefinition } from "../agent-environment/skill-database.ts";
import { equalValue, type ConfigRow } from "./persistence.ts";
import { alive } from "./provider-records.ts";
import { valuesOf } from "./provider-values.ts";
import { sourceOf } from "./environment-values.ts";
import type { Blobs } from "./environment-blobs.ts";
import { applyMarketplace, applyPlugin } from "./environment-apply-plugins.ts";
import {
  attempt,
  bumpEnvironment,
  localWorkers,
  named,
  refuse,
  selectorOf,
  storeVersions,
  strings,
  WAITING,
  type LocalVersion,
} from "./environment-support.ts";

const options = { ignoreUnknownFields: true };

/** Applies a library record with this computer's validation. True: the library here changed. */
export function applyEnvironment(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, blobs: Blobs = new Map()) {
  return Effect.gen(function* () {
    if (!uuid(row.local_id)) return refuse(row);

    if (row.kind === "instruction") return yield* applyInstruction(sql, owner, row);

    if (row.kind === "skill") return yield* applySkill(sql, owner, row, blobs);

    if (row.kind === "marketplace") return yield* applyMarketplace(sql, owner, row, blobs);

    return yield* applyPlugin(sql, owner, row, blobs);
  });
}

function applyInstruction(sql: SqlClient.SqlClient, owner: string, row: ConfigRow) {
  return Effect.gen(function* () {
    const stored = (yield* sql<{ document: JsonValue; owner_user_id: string }>`SELECT document,owner_user_id::text
      FROM instruction_documents WHERE id=${row.local_id}::uuid`)[0];

    if (stored && stored.owner_user_id !== owner) return refuse(row);
    const current = stored && fromJson(ui.InstructionDocumentSchema, stored.document, options);

    if (!alive(row)) {
      if (!current) return false;
      const next = yield* bumpEnvironment(sql, owner);
      yield* sql`INSERT INTO instruction_document_versions (document_id, owner_user_id, revision, document, deleted)
        VALUES (${row.local_id}::uuid, ${owner}::uuid, ${next}, ${JSON.stringify(stored.document)}::jsonb, true)`;
      yield* sql`DELETE FROM instruction_documents WHERE id=${row.local_id}::uuid AND owner_user_id=${owner}::uuid`;

      return true;
    }

    const v = valuesOf(row.fields);
    const fragments = Array.isArray(v["fragments"]) ? v["fragments"] : [];
    const workers = yield* localWorkers(sql, owner);

    const parsed = yield* attempt(() => {
      const doc = create(ui.InstructionDocumentSchema, {
        id: row.local_id,
        name: Predicate.isString(v["name"]) ? v["name"] : "",
        harness: Predicate.isString(v["harness"]) ? v["harness"] : "",
        selector: selectorOf(v["selector"]),
        fragments: fragments.map((f) => fromJson(ui.InstructionFragmentSchema, f, options)),
        overrides: current?.overrides ?? [],
        deviceHome: v["deviceHome"] === true,
        platformHome: v["platformHome"] === true,
        revision: current?.revision ?? 0n,
      });

      checkDocument(doc, workers, named(doc.selector, ...doc.fragments.map((f) => f.selector)));

      return doc;
    });

    if (!parsed) return refuse(row);
    const doc = parsed.value;

    if (current && equalValue(toJson(ui.InstructionDocumentSchema, current), toJson(ui.InstructionDocumentSchema, doc)))
      return false;
    doc.revision = yield* bumpEnvironment(sql, owner);
    yield* saveDocument(sql, owner, doc);

    return true;
  });
}

function applySkill(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, blobs: Blobs) {
  return Effect.gen(function* () {
    const stored = (yield* sql<{ definition: JsonValue; owner_user_id: string }>`SELECT definition,owner_user_id::text
      FROM agent_skills WHERE id=${row.local_id}::uuid`)[0];

    if (stored && stored.owner_user_id !== owner) return refuse(row);
    const current = stored && fromJson(ui.LibrarySkillSchema, stored.definition, options);

    if (!alive(row)) {
      if (!current) return false;
      yield* bumpEnvironment(sql, owner);
      yield* sql`DELETE FROM agent_skills WHERE id=${row.local_id}::uuid AND owner_user_id=${owner}::uuid`;

      return true;
    }

    const v = valuesOf(row.fields);

    const local = [
      ...(yield* sql<LocalVersion>`SELECT version::text,content_hash,source_commit AS commit FROM agent_skill_versions
      WHERE skill_id=${row.local_id}::uuid AND owner_user_id=${owner}::uuid`),
    ];

    const insert = (json: string, number: bigint, commit: string) =>
      sql`INSERT INTO agent_skill_versions(skill_id, owner_user_id, version, artifact, source_commit)
        VALUES (${row.local_id}::uuid, ${owner}::uuid, ${number}, ${json}::jsonb, ${commit})`;

    if (!(yield* storeVersions(sql, owner, v, local, blobs, insert, false))) return refuse(row);
    const selected = local.find((l) => l.content_hash === v["selected"]);

    if (!selected) return refuse(row, WAITING);
    const versions = local.map((l) => BigInt(l.version)).sort((a, b) => (a < b ? -1 : 1));
    const source = sourceOf(v["source"]);

    const workers = yield* localWorkers(sql, owner);

    const parsed = yield* attempt(() => {
      const skill = create(ui.LibrarySkillSchema, {
        id: row.local_id,
        name: Predicate.isString(v["name"]) ? v["name"] : "",
        version: BigInt(selected.version),
        harnesses: strings(v["harnesses"]) ?? [],
        selector: selectorOf(v["selector"]),
        overrides: (current?.overrides ?? []).filter((o) => !o.version || versions.includes(o.version)),
        deviceHome: v["deviceHome"] === true,
        platformHome: v["platformHome"] === true,
        versions,
        ...(source && {
          // Upstream checks are this computer's own; a connected account is this computer's until stage 5.
          source: Object.assign(
            current?.source ? clone(ui.SkillSourceSchema, current.source) : create(ui.SkillSourceSchema),
            source,
            { commit: selected.commit, autoUpdate: v["autoUpdate"] === true },
          ),
        }),
      });

      if (skill.source) skill.source.pinned = v["pinned"] === true;
      checkSkillAssignment(skill, workers, named(skill.selector));

      return skill;
    });

    if (!parsed) return refuse(row);
    const skill = parsed.value;

    const definition = (s: ui.LibrarySkill) =>
      toJson(ui.LibrarySkillSchema, create(ui.LibrarySkillSchema, { ...s, artifact: undefined, versions: [] }));

    if (current && equalValue(definition(current), definition(skill))) return false;
    yield* bumpEnvironment(sql, owner);
    yield* saveSkillDefinition(sql, owner, skill);

    return true;
  });
}
