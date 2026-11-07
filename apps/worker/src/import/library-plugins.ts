import type { JsonObject } from "@canopy/domain";
import { isJsonObject, jsonString } from "../providers/json.ts";
import type { AgentCli } from "./source-key.ts";
import { inspectImportUrl } from "@canopy/domain/import-url";

/**
 * Marketplaces and plugins the CLIs know (docs/import.md, "Skille i pluginy"), as metadata. A marketplace in a
 * repository is imported into the library from that repository (the gateway reads it, as when it is added by hand);
 * one on this computer only is listed with what to do. Plugins run code: each needs its own approval of the exact
 * files in Agent environment, so they are listed, never activated by an import.
 */

export interface PluginFact {
  readonly kind: "marketplace" | "plugin";
  readonly name: string;
  /** owner/repo or a repository URL; empty for a marketplace on this computer. */
  readonly source: string;
  readonly version: string;
  readonly reason: string;
}

const LOCAL = "A marketplace on this computer. Add it in Agent environment.";
const UNKNOWN = "Canopy can't read this kind of marketplace source.";
const CREDENTIAL = "Its URL holds a credential. Add the marketplace in Agent environment with a connected account.";

/** A remote source with credentials in its URL is listed (masked) but never imported. */
function withoutCredentials(found: MarketplaceSource): MarketplaceSource {
  return found.source && inspectImportUrl(found.source).credential
    ? { source: found.source, reason: CREDENTIAL }
    : found;
}

const APPROVE = "Plugins run code. Approve each one in Agent environment.";

interface MarketplaceSource {
  readonly source: string;
  readonly reason: string;
}

/** A Claude marketplace source: `{source: github, repo}`, `{source: git, url}` or a directory. */
function claudeSource(value: JsonObject[string] | undefined): MarketplaceSource {
  if (!isJsonObject(value)) return { source: "", reason: UNKNOWN };
  const kind = jsonString(value["source"]);

  if (kind === "github" && jsonString(value["repo"])) return { source: jsonString(value["repo"]), reason: "" };

  if ((kind === "git" || kind === "url") && jsonString(value["url"]).startsWith("https://"))
    return { source: jsonString(value["url"]), reason: "" };

  return { source: "", reason: kind === "directory" || kind === "file" ? LOCAL : UNKNOWN };
}

/** Claude: `plugins/known_marketplaces.json`, `plugins/installed_plugins.json` (v2) and settings' enabledPlugins. */
export function claudePlugins(
  known: JsonObject | undefined,
  installed: JsonObject | undefined,
  settings: JsonObject | undefined,
): PluginFact[] {
  const facts: PluginFact[] = [];

  for (const [name, entry] of Object.entries(known ?? {})) {
    if (!isJsonObject(entry)) continue;
    facts.push({ kind: "marketplace", name, version: "", ...withoutCredentials(claudeSource(entry["source"])) });
  }

  const plugins = installed?.["plugins"];
  const enabled = settings?.["enabledPlugins"];

  const names = new Set([
    ...Object.keys(isJsonObject(plugins) ? plugins : {}),
    ...Object.keys(isJsonObject(enabled) ? enabled : {}),
  ]);

  for (const name of names) {
    const entries = isJsonObject(plugins) ? plugins[name] : undefined;
    const first = Array.isArray(entries) ? entries.find(isJsonObject) : undefined;
    const version = jsonString(first?.["version"]) || jsonString(first?.["gitCommitSha"]).slice(0, 12);
    facts.push({ kind: "plugin", name, source: "", version, reason: APPROVE });
  }

  return facts;
}

/** Codex: `[marketplaces.<name>] source_type, source` and `[plugins."<name>@<marketplace>"]` in config.toml. */
export function codexPlugins(config: JsonObject | undefined): PluginFact[] {
  const facts: PluginFact[] = [];
  const marketplaces = config?.["marketplaces"];
  const plugins = config?.["plugins"];

  for (const [name, entry] of Object.entries(isJsonObject(marketplaces) ? marketplaces : {})) {
    if (!isJsonObject(entry)) continue;
    const type = jsonString(entry["source_type"]);
    const source = jsonString(entry["source"]);
    const remote = type === "git" && source.startsWith("https://");
    facts.push({
      kind: "marketplace",
      name,
      version: "",
      ...withoutCredentials({ source: remote ? source : "", reason: remote ? "" : type === "local" ? LOCAL : UNKNOWN }),
    });
  }

  for (const name of Object.keys(isJsonObject(plugins) ? plugins : {}))
    facts.push({ kind: "plugin", name, source: "", version: "", reason: APPROVE });

  return facts;
}

export function pluginFacts(cli: AgentCli, files: (rel: string) => JsonObject | undefined): PluginFact[] {
  if (cli === "claude")
    return claudePlugins(
      files("plugins/known_marketplaces.json"),
      files("plugins/installed_plugins.json"),
      files("settings.json"),
    );

  if (cli === "codex") return codexPlugins(files("config.toml"));

  return [];
}
