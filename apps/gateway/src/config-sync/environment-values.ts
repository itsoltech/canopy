import { type JsonValue } from "@bufbuild/protobuf";
import { normalizeGitOrigin } from "@canopy/domain/projects";
import { Predicate, Schema } from "effect";
import type { Values } from "./provider-values.ts";

/**
 * The agent environment library as shared records (docs/linked-computers.md, "Środowisko agentów"). Machine
 * overrides, drift decisions, reports and the results of upstream checks stay on each computer.
 */
export const ENVIRONMENT_KINDS = new Set(["instruction", "skill", "marketplace", "plugin"]);

/** One field per immutable version, named by the SHA-256 of its content; concurrent uploads never collide. */
export const VERSION_FIELD = /^version\.([0-9a-f]{64})$/;
export const HASH = /^[0-9a-f]{64}$/;

const ASSIGNMENT = ["harnesses", "selector", "deviceHome", "platformHome"];

const FIELDS = new Map<string, ReadonlySet<string>>(
  Object.entries({
    instruction: new Set(["name", "harness", "selector", "fragments", "deviceHome", "platformHome"]),
    skill: new Set(["name", ...ASSIGNMENT, "source", "autoUpdate", "pinned", "selected"]),
    marketplace: new Set(["name", "source", "catalog"]),
    plugin: new Set(["name", "marketplace", ...ASSIGNMENT, "selected"]),
  }),
);

/** Fields a local write may clear. Version fields only accumulate. */
export const environmentManaged = (kind: string, name: string) => FIELDS.get(kind)?.has(name) ?? false;

export const Version = Schema.Struct({ commit: Schema.String, checksum: Schema.String });
export const isVersion = Schema.is(Version);
export const Catalog = Schema.Struct({ hash: Schema.String, commit: Schema.String });
export const isCatalog = Schema.is(Catalog);

export const Source = Schema.Struct({
  url: Schema.String,
  ref: Schema.String,
  path: Schema.String,
  credentialAccountId: Schema.String,
});

export const isSource = Schema.is(Source);

/** A received source as plain fields; undefined when the value is not a source. */
export const sourceOf = (value: JsonValue | undefined) =>
  isSource(value)
    ? { url: value.url, ref: value.ref, path: value.path, credentialAccountId: value.credentialAccountId }
    : undefined;

export const versionHashes = (values: Values) =>
  Object.keys(values).flatMap((name) => {
    const hash = VERSION_FIELD.exec(name)?.[1];

    return hash ? [hash] : [];
  });

const text = (value: JsonValue | undefined) => (Predicate.isString(value) ? value.trim().toLowerCase() : "");

/**
 * The merge key of an element made apart on two computers (docs/linked-computers.md, "Bootstrap i scalanie
 * tożsamości"). A plugin names its marketplace by global id, after this computer's aliases.
 */
export function environmentIdentity(kind: string, values: Values, marketplace = "") {
  if (kind === "instruction")
    return text(values["harness"]) && text(values["name"])
      ? `instruction:${text(values["harness"])}:${text(values["name"])}`
      : "";

  if (kind === "skill") {
    const source = values["source"];

    if (isSource(source) && source.url) return `source:${source.url}#${source.ref}:${source.path}`;

    return text(values["name"]) ? `name:${text(values["name"])}` : "";
  }

  if (kind === "marketplace") {
    const source = values["source"];

    if (!isSource(source) || !source.url) return "";

    return `repo:${normalizeGitOrigin(source.url) || source.url}#${source.ref}:${source.path}`;
  }

  return marketplace && text(values["name"]) ? `plugin:${marketplace}:${text(values["name"])}` : "";
}
