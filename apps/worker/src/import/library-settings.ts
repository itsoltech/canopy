import type { JsonObject, JsonValue } from "@canopy/domain";
import { isJsonObject, isString, jsonString } from "../providers/json.ts";
import type { AgentCli } from "./source-key.ts";

/**
 * Settings of the CLIs as Canopy defaults (docs/import.md, "Ustawienia"): the model of new threads and their
 * permissions. Values are names and modes, never secrets. Full access is never set by an import: a CLI that skips
 * every prompt maps to nothing, with the reason.
 */

export interface SettingFact {
  readonly name: "model" | "permissions" | "effort";
  /** In Canopy terms; "" when Canopy has nothing that matches. */
  readonly value: string;
  /** What the CLI has. */
  readonly detail: string;
  readonly reason: string;
}

const FULL_ACCESS = "An import never sets Full access. Choose it in Settings → Threads.";
const NO_EFFORT = "Canopy has no default effort. Choose it in the composer.";

const CLAUDE_MODES = new Map<string, string>([
  ["default", "ask"],
  ["acceptEdits", "accept_edits"],
  ["plan", "read_only"],
]);

/** Claude `settings.json`: `model`, `permissions.defaultMode`, `effortLevel`. */
export function claudeSettings(settings: JsonObject): SettingFact[] {
  const facts: SettingFact[] = [];
  const model = jsonString(settings["model"]);

  if (model) facts.push({ name: "model", value: model, detail: model, reason: "" });
  const permissions = settings["permissions"];
  const mode = isJsonObject(permissions) ? jsonString(permissions["defaultMode"]) : "";

  if (mode) facts.push(permissionFact(mode, CLAUDE_MODES.get(mode) ?? "", mode === "bypassPermissions"));
  const effort = jsonString(settings["effortLevel"]);

  if (effort) facts.push({ name: "effort", value: "", detail: effort, reason: NO_EFFORT });

  return facts;
}

/** Codex `config.toml`: top-level keys, overridden by the active `profile`. */
export function codexSettings(config: JsonObject): SettingFact[] {
  const profiles = config["profiles"];
  const name = jsonString(config["profile"]);
  const profile = name && isJsonObject(profiles) ? profiles[name] : undefined;
  const raw = (key: string) => (isJsonObject(profile) ? (profile[key] ?? config[key]) : config[key]);
  const value = (key: string) => jsonString(raw(key));
  const facts: SettingFact[] = [];
  const model = value("model");

  if (model) facts.push({ name: "model", value: model, detail: model, reason: "" });
  const sandbox = value("sandbox_mode");
  const approval = value("approval_policy");

  if (raw("sandbox_mode") !== undefined || raw("approval_policy") !== undefined) {
    const unsupported = [raw("sandbox_mode"), raw("approval_policy")].some((v) => v !== undefined && !isString(v));

    const detail = unsupported
      ? "Unsupported permission policy"
      : [approval && `approval ${approval}`, sandbox && `sandbox ${sandbox}`].filter(Boolean).join(", ");

    const full = sandbox === "danger-full-access" || (approval === "never" && !sandbox);
    facts.push(permissionFact(detail, full || unsupported ? "" : codexMode(sandbox, approval), full));
  }

  const effort = value("model_reasoning_effort");

  if (effort) facts.push({ name: "effort", value: "", detail: effort, reason: NO_EFFORT });

  return facts;
}

/**
 * Codex sandbox and approval policy together as the Canopy mode that is never broader (permissions.ts maps the
 * modes back: read_only = read-only + never, ask = read-only + on-request, accept_edits = workspace-write +
 * on-request, full_auto = workspace-write + never). A combination with no equal mode takes the nearest stricter
 * one; an unknown value imports nothing ("").
 */
const CODEX_MODES = new Map([
  ["read-only/never", "read_only"],
  ["read-only/on-request", "ask"],
  ["read-only/on-failure", "ask"],
  ["read-only/", "ask"],
  ["workspace-write/never", "full_auto"],
  ["workspace-write/on-request", "accept_edits"],
  ["workspace-write/on-failure", "accept_edits"],
  ["workspace-write/", "accept_edits"],
  ["/on-request", "ask"],
  ["/on-failure", "ask"],
]);

function codexMode(sandbox: string, approval: string): string {
  return CODEX_MODES.get(`${sandbox}/${approval}`) ?? "";
}

/** Grok `config.toml`: the default model (`model` or `[model] default`). */
export function grokSettings(config: JsonObject): SettingFact[] {
  const table = config["model"];
  const model = isString(table) ? table : isJsonObject(table) ? jsonString(table["default"]) : "";

  return model ? [{ name: "model", value: model, detail: model, reason: "" }] : [];
}

function permissionFact(detail: string, value: string, full: boolean): SettingFact {
  const reason = full ? FULL_ACCESS : value ? "" : "Canopy has no matching permission mode.";

  return { name: "permissions", value, detail, reason };
}

export const SETTINGS: Readonly<Record<AgentCli, (config: JsonObject) => SettingFact[]>> = {
  claude: claudeSettings,
  codex: codexSettings,
  grok: grokSettings,
};

/** Where a CLI keeps model providers with their own endpoint. */
const PROVIDER_TABLES = new Map<AgentCli, string>([
  ["codex", "model_providers"],
  ["grok", "model"],
]);

/** Parts of a settings file that stay out of Canopy, each with its reason (shown, never imported). */
export function leftOut(cli: AgentCli, config: JsonObject): { name: string; reason: string }[] {
  const present = (key: string) => config[key] !== undefined && !emptyValue(config[key]);
  const out: { name: string; reason: string }[] = [];
  const hooks = "Hooks run commands. Canopy threads leave them out.";

  if (present("hooks")) out.push({ name: "Hooks", reason: hooks });

  if (cli === "claude") {
    if (present("statusLine")) out.push({ name: "Status line", reason: "Canopy shows its own thread status." });

    if (present("env")) out.push({ name: "Environment", reason: "Often holds secrets. Set it per provider instance." });
    const permissions = config["permissions"];

    if (isJsonObject(permissions) && ["allow", "deny", "ask"].some((k) => !emptyValue(permissions[k])))
      out.push({ name: "Permission rules", reason: "Canopy asks for approvals with its own rules." });
  }

  if (cli === "codex" && present("notify")) out.push({ name: "Notify", reason: hooks });
  // Model providers with their own endpoint: Canopy keeps them as proxies, with a key entered there.
  const providers = config[PROVIDER_TABLES.get(cli) ?? ""];

  for (const [name, entry] of Object.entries(isJsonObject(providers) ? providers : {}))
    if (isJsonObject(entry) && jsonString(entry["base_url"]))
      out.push({ name: `Model provider ${name}`, reason: "Add it in Proxies, with its key." });

  return out;
}

function emptyValue(value: JsonValue | undefined): boolean {
  if (Array.isArray(value)) return value.length === 0;

  return isJsonObject(value) && Object.keys(value).length === 0;
}
