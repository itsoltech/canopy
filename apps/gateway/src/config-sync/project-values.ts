import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Schema } from "effect";
import { flatten, type SettingsJson } from "./settings.ts";
import { normalizeGitOrigin } from "@canopy/domain/projects";
import type { Fields } from "./persistence.ts";

export const PROJECT_KINDS = new Set(["project", "project_settings", "worktree_policy"]);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const knownProjectOrigin = (value: string) => !!value && normalizeGitOrigin(`https://${value}`) === value;

/** Each computer clears only its own observation; another computer's duplicate clones remain known. */
export const ambiguousProjectOrigin = (fields: Fields, origin: string, except = "") =>
  Object.entries(fields).some(
    ([name, field]) => name !== except && name.startsWith("originAmbiguous.") && field.value === origin,
  );

export const DEFAULT_FIELDS = new Set(
  ui.ThreadDefaultsSchema.fields
    .filter((f) => f.localName !== "workspaceId")
    .map((f) => `threadDefaults.${f.localName}`),
);

export const POLICY_FIELDS = new Set(
  ui.WorktreeSettingsSchema.fields.filter((f) => f.localName !== "location").map((f) => f.localName),
);

const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson));
const isObject = Schema.is(Schema.Record(Schema.String, Schema.MutableJson));

/** Optional overrides stay optional. Clearing an override is a versioned null, never a default value. */
export function projectSettingsValues(stored: SettingsJson): SettingsJson {
  const defaults = {
    ...object(
      toJson(
        ui.ThreadDefaultsSchema,
        fromJson(ui.ThreadDefaultsSchema, stored["threadDefaults"] ?? {}, { ignoreUnknownFields: true }),
      ),
    ),
  };

  delete defaults["workspaceId"];

  return flatten({ threadDefaults: defaults });
}

export function policyValues(stored: JsonValue): SettingsJson {
  const values = {
    ...object(
      toJson(ui.WorktreeSettingsSchema, fromJson(ui.WorktreeSettingsSchema, stored, { ignoreUnknownFields: true })),
    ),
  };

  delete values["location"];

  return values;
}

/** Patch supported leaves, retaining machine paths and fields from a newer version. */
export function patchLeaves(stored: SettingsJson, values: SettingsJson, supported: ReadonlySet<string>) {
  const next = structuredClone(stored);

  for (const [path, value] of Object.entries(values)) {
    if (!supported.has(path)) continue;
    const parts = path.split(".");
    let target = next;

    for (const key of parts.slice(0, -1)) {
      if (!isObject(target[key])) target[key] = {};
      const child = target[key];

      if (isObject(child)) target = child;
    }

    const key = parts.at(-1)!;

    if (value === null) delete target[key];
    else target[key] = value;
  }

  return next;
}
