import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ImportSecretSlotSchema, type ImportSecretSlot } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { inspectImportUrl } from "@canopy/domain/import-url";
import { isJsonObject, isString, jsonString } from "../providers/json.ts";
import type { AgentCli } from "./source-key.ts";

/**
 * MCP servers of the CLIs (docs/import.md, "Serwery MCP"): Claude's `~/.claude.json` (`mcpServers`, also per
 * project) and Codex's `[mcp_servers.*]`. A remote server becomes a connector account draft: its URL, transport and
 * the headers that carry secrets, by name and kind only. A header value in the file (literal) leaves the worker only
 * when the owner chooses it (ReadImportSecret); one that names an environment variable is never read. A stdio server
 * runs a command on this computer: it is listed with why it stays out.
 */

export interface McpServer {
  /** Where it is in its file: the project ("" = user-wide) and its name there. */
  readonly scope: string;
  readonly name: string;
  readonly transport: "http" | "sse" | "stdio";
  readonly url: string;
  readonly slots: ImportSecretSlot[];
  readonly reason: string;
}

const STDIO = "Runs a command on this computer. Canopy calls MCP servers over the network, from the gateway only.";
const URL_SECRET = "Its URL may hold a secret (user, password or query). Add it in Connectors.";
const VARIABLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/** A header value in the file: a literal, or `${VAR}` naming an environment variable. */
function headerSlot(name: string, value: string): ImportSecretSlot {
  const variable = VARIABLE.exec(value.replace(/^Bearer\s+/i, "").trim());

  return create(ImportSecretSlotSchema, {
    name,
    kind: variable ? "env" : "literal",
    variable: variable ? (variable[1] ?? variable[2] ?? "") : "",
  });
}

function checkedUrl(url: string): string {
  const { url: parsed, credential } = inspectImportUrl(url);

  if (credential) return URL_SECRET;

  if (!parsed) return "The URL is not valid.";

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Canopy calls MCP servers over HTTP(S) only.";

  return parsed.search ? URL_SECRET : "";
}

function claudeServer(scope: string, name: string, entry: JsonObject): McpServer {
  const type = jsonString(entry["type"]);
  const url = jsonString(entry["url"]);

  if (type === "stdio" || (!type && !url))
    return { scope, name, transport: "stdio", url: "", slots: [], reason: STDIO };
  const headers = entry["headers"];

  const slots = isJsonObject(headers)
    ? Object.entries(headers).flatMap(([header, value]) => (isString(value) ? [headerSlot(header, value)] : []))
    : [];

  return { scope, name, transport: type === "sse" ? "sse" : "http", url, slots, reason: checkedUrl(url) };
}

/** `~/.claude.json`: user-wide servers and each project's. */
export function claudeServers(account: JsonObject | undefined): McpServer[] {
  const servers: McpServer[] = [];

  const add = (scope: string, map: JsonObject[string] | undefined) => {
    if (!isJsonObject(map)) return;

    for (const [name, entry] of Object.entries(map))
      if (isJsonObject(entry)) servers.push(claudeServer(scope, name, entry));
  };

  add("", account?.["mcpServers"]);
  const projects = account?.["projects"];

  if (isJsonObject(projects))
    for (const [project, settings] of Object.entries(projects))
      if (isJsonObject(settings)) add(project, settings["mcpServers"]);

  return servers;
}

/** Codex `config.toml`: `[mcp_servers.<name>]` with `command` (stdio) or `url`. */
export function codexServers(config: JsonObject | undefined): McpServer[] {
  const map = config?.["mcp_servers"];

  if (!isJsonObject(map)) return [];

  return Object.entries(map).flatMap(([name, entry]): McpServer[] => {
    if (!isJsonObject(entry)) return [];
    const url = jsonString(entry["url"]);

    if (!url) return [{ scope: "", name, transport: "stdio", url: "", slots: [], reason: STDIO }];
    const literal = entry["http_headers"];
    const fromEnv = entry["env_http_headers"];
    const bearer = jsonString(entry["bearer_token_env_var"]);

    const slots = [
      ...(isJsonObject(literal)
        ? Object.entries(literal).flatMap(([header, value]) => (isString(value) ? [headerSlot(header, value)] : []))
        : []),
      ...(isJsonObject(fromEnv)
        ? Object.entries(fromEnv).map(([header, variable]) =>
            create(ImportSecretSlotSchema, { name: header, kind: "env", variable: jsonString(variable) }),
          )
        : []),
      ...(bearer ? [create(ImportSecretSlotSchema, { name: "Authorization", kind: "env", variable: bearer })] : []),
    ];

    return [{ scope: "", name, transport: "http", url, slots, reason: checkedUrl(url) }];
  });
}

/** The literal value of one header of one server in the file, as the CLI sends it; undefined when there is none. */
export function literalHeader(
  cli: AgentCli,
  file: JsonObject | undefined,
  scope: string,
  name: string,
  header: string,
): string | undefined {
  if (cli === "claude") {
    const map = scope
      ? (() => {
          const projects = file?.["projects"];
          const settings = isJsonObject(projects) ? projects[scope] : undefined;

          return isJsonObject(settings) ? settings["mcpServers"] : undefined;
        })()
      : file?.["mcpServers"];

    const entry = isJsonObject(map) ? map[name] : undefined;
    const headers = isJsonObject(entry) ? entry["headers"] : undefined;
    const value = isJsonObject(headers) ? headers[header] : undefined;

    return isString(value) && headerSlot(header, value).kind === "literal" ? value : undefined;
  }

  const map = file?.["mcp_servers"];
  const entry = isJsonObject(map) ? map[name] : undefined;
  const headers = isJsonObject(entry) ? entry["http_headers"] : undefined;
  const value = isJsonObject(headers) ? headers[header] : undefined;

  return isString(value) && headerSlot(header, value).kind === "literal" ? value : undefined;
}

/** The fragment of a connector key: its scope and name, base64url (a project path can hold any character). */
export function serverFragment(scope: string, name: string): string {
  return Buffer.from(JSON.stringify([scope, name])).toString("base64url");
}

export function parseFragment(fragment: string): { scope: string; name: string } | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(fragment, "base64url").toString());

    return Array.isArray(value) && value.length === 2 && value.every(isString)
      ? { scope: value[0], name: value[1] }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Where a CLI keeps its MCP servers, relative to the root that holds them. */
export const MCP_FILES = new Map<AgentCli, string>([
  ["claude", ".claude.json"],
  ["codex", "config.toml"],
]);

/** What identifies a server's definition (not its secret values): a changed one is scanned again. */
export function serverDigest(server: McpServer): string {
  return createHash("sha256")
    .update(JSON.stringify([server.url, server.transport, server.slots.map((s) => [s.name, s.kind])]))
    .digest("hex");
}
