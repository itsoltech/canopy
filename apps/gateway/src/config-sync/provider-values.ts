import { type JsonValue } from "@bufbuild/protobuf";
import { envListProblems } from "@canopy/domain";
import { Predicate, Schema } from "effect";
import { isRef, type InstanceRow, type StoredEnvVar } from "../store/instance-config.ts";
import { ACCENT, MAX_MODELS, checkArgs, checkBaseUrl } from "../store/instance-checks.ts";
import { proxyOptions, proxyRoot, type ProxyOptions, type ProxyRow } from "../store/proxy-records.ts";
import type { Fields } from "./persistence.ts";

/**
 * Shared fields of provider instances and proxies (docs/linked-computers.md, "Inwentarz"). CLI paths and homes
 * stay on each computer; per-worker choices stay with the worker's home. Secret fields hold a random token and
 * name the local secret they came from, so the record changes only when the user changes the value.
 */

export const PROVIDER_KINDS = new Set(["instance", "proxy"]);
export const HARNESSES = new Set(["claude", "codex", "grok"]);

export type Values = Record<string, JsonValue>;

/** Field name → local secrets.id of the value it holds now. */
export type SecretRefs = Map<string, string>;

const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const envSecret = Schema.is(Schema.Struct({ secret: Schema.String }));
const envPlain = Schema.is(Schema.Struct({ value: Schema.String }));

const codexOptions = Schema.decodeUnknownSync(
  Schema.Struct({
    wireApi: Schema.String,
    supportsWebsockets: Schema.Boolean,
    extraHeaders: Schema.Record(Schema.String, Schema.String),
  }),
);

export const ENV_FIELD = /^env\.([A-Za-z_][A-Za-z0-9_]{0,127})$/;

/** Fields whose value is a token for an encrypted value. */
export function secretField(kind: string, name: string, value: JsonValue | undefined): boolean {
  if (kind === "connector" || kind === "oauth_app") return name === "credentials";

  if (kind === "proxy") return name === "secret";

  if (kind !== "instance") return false;

  return name === "apiKey" || (ENV_FIELD.test(name) && envSecret(value));
}

/** An instance as a record. `proxy` is the proxy's global id; secret fields get a placeholder token. */
export function instanceValues(row: InstanceRow, proxy: string) {
  const runtime = row.runtime ?? {};
  const secrets: SecretRefs = new Map();

  const key = row.kind === "endpoint" && !row.proxy_id && isRef(row.api_key) ? row.api_key.secretRef : "";
  const keyed = key !== "";

  if (keyed) secrets.set("apiKey", key);

  const env = (row.env ?? []).flatMap((variable): [string, JsonValue][] => {
    const name = `env.${variable.name}`;

    if (!ENV_FIELD.test(name)) return [];

    if (variable.secret && isRef(variable.value)) {
      secrets.set(name, variable.value.secretRef);

      return [[name, { secret: "" }]];
    }

    return [[name, { value: Predicate.isString(variable.value) ? variable.value : "" }]];
  });

  const values = Object.fromEntries([
    ["label", row.label],
    ["kind", row.kind],
    ["baseUrl", row.proxy_id ? "" : row.base_url],
    ["proxy", proxy],
    ["accentColor", row.accent_color],
    ["launchArgs", [...(runtime.launchArgs ?? [])]],
    ["ownLogin", runtime.ownLogin === true],
    ["allWorkers", row.all_workers],
    ["favorites", [...row.favorites]],
    ["hidden", [...row.hidden_models]],
    ["shown", [...row.shown_models]],
    ["custom", [...row.custom_models]],
    ["apiKey", keyed ? "" : null],
    ...env,
  ] satisfies [string, JsonValue][]);

  return { values, secrets };
}

export function proxyValues(row: ProxyRow) {
  const secrets: SecretRefs = new Map(row.secret_id ? [["secret", row.secret_id]] : []);

  const values = Object.fromEntries([
    ["name", row.name],
    ["kind", row.kind],
    ["baseUrl", row.base_url],
    ["codex", { ...row.codex, extraHeaders: { ...row.codex.extraHeaders } }],
    ["secret", row.secret_id ? "" : null],
  ] satisfies [string, JsonValue][]);

  return { values, secrets };
}

/** The merge key of an instance: same harness, same endpoint (or proxy address). Keys are compared separately. */
export function instanceIdentity(harness: string, fields: Values, endpoint: string, builtIn: boolean) {
  if (builtIn) return "";

  if (fields["kind"] === "endpoint") return endpoint ? `endpoint:${harness}:${endpoint}` : "";

  return fields["ownLogin"] === true && Predicate.isString(fields["label"]) && fields["label"].trim()
    ? `native:${harness}:${fields["label"].trim().toLowerCase()}`
    : "";
}

export const proxyIdentity = (fields: Values) =>
  Predicate.isString(fields["kind"]) && Predicate.isString(fields["baseUrl"])
    ? `proxy:${fields["kind"]}:${fields["baseUrl"]}`
    : "";

export const valuesOf = (fields: Fields): Values =>
  Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value]));

/** The domain columns of a received instance, validated like a local save. Undefined: not applicable here. */
export function instanceColumns(values: Values, current: InstanceRow | undefined) {
  try {
    const label = values["label"] === undefined ? (current?.label ?? "") : String(values["label"]);
    const kind = values["kind"] ?? current?.kind ?? "native";
    const accent = values["accentColor"] === undefined ? (current?.accent_color ?? "") : String(values["accentColor"]);
    const baseUrl = values["baseUrl"] === undefined ? (current?.base_url ?? "") : String(values["baseUrl"]);

    const launchArgs =
      values["launchArgs"] === undefined ? (current?.runtime.launchArgs ?? []) : strings(values["launchArgs"]);

    const models = ["favorites", "hidden", "shown", "custom"].map((name) =>
      values[name] === undefined ? undefined : [...strings(values[name])],
    );

    if (
      (kind !== "native" && kind !== "endpoint") ||
      label.length > 80 ||
      (!label.trim() && !current?.built_in) ||
      (accent && !ACCENT.test(accent)) ||
      checkArgs(launchArgs) ||
      (kind === "endpoint" && !values["proxy"] && checkBaseUrl(baseUrl)) ||
      models.some(
        (list) => list && (list.length > MAX_MODELS || list.some((m) => !m || m.length > 200 || /\s/.test(m))),
      )
    )
      return undefined;

    type EnvValue = { name: string; secret: true; token: string } | { name: string; secret: false; value: string };

    const env = Object.entries(values).flatMap(([name, value]): EnvValue[] => {
      const match = ENV_FIELD.exec(name);

      if (!match || value === null) return [];

      if (envSecret(value)) return [{ name: match[1]!, secret: true as const, token: value.secret }];

      if (envPlain(value)) return [{ name: match[1]!, secret: false as const, value: value.value }];

      throw new Error("unsupported variable");
    });

    if (
      envListProblems(
        kind,
        env.map((v) => ({ name: v.name, value: v.secret ? "" : v.value })),
      )[0]
    )
      return undefined;

    return {
      label: label.trim(),
      kind,
      accent,
      baseUrl: kind === "endpoint" ? baseUrl.trim() : "",
      launchArgs: [...launchArgs],
      ownLogin: values["ownLogin"] === undefined ? current?.runtime.ownLogin === true : values["ownLogin"] === true,
      allWorkers: values["allWorkers"] === undefined ? (current?.all_workers ?? true) : values["allWorkers"] === true,
      models,
      env,
    };
  } catch {
    return undefined;
  }
}

/** Variables in the order this computer shows them; new names follow, sorted. */
export function orderedEnv<T extends { name: string }>(next: readonly T[], current: readonly StoredEnvVar[]) {
  const position = new Map(current.map((v, i) => [v.name, i]));

  return [...next].sort(
    (a, b) =>
      (position.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.name) ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name),
  );
}

export function proxyColumns(values: Values, current: ProxyRow | undefined) {
  try {
    const name = String(values["name"] ?? current?.name ?? "").trim();
    const kind = String(values["kind"] ?? current?.kind ?? "");
    const baseUrl = proxyRoot(String(values["baseUrl"] ?? current?.base_url ?? ""));

    const codex: ProxyOptions = proxyOptions(
      values["codex"] === undefined ? current?.codex : codexOptions(values["codex"]),
    );

    if (!name || name.length > 80 || !["cliproxyapi", "anthropic", "openai"].includes(kind)) return undefined;

    return { name, kind, baseUrl, codex };
  } catch {
    return undefined;
  }
}
